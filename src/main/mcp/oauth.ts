// MCP authorization for HTTP transports (spec 2025-06-18 · basic/authorization), OAuth 2.1 client:
//   401 + WWW-Authenticate → Protected Resource Metadata (RFC 9728, well-known fallback)
//   → Authorization Server Metadata (RFC 8414, then OpenID configuration)
//   → Dynamic Client Registration (RFC 7591) unless a client id is configured
//   → authorization code + PKCE S256 + state + resource (RFC 8707) in the system browser,
//     redirected to a one-shot http://127.0.0.1:<port>/callback (RFC 8252) → token / refresh.
// Tokens live only in the SecretStore record handed in by the caller; nothing here logs a token value.
import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { McpAuthState } from '../../shared/types';
import type { FetchLike } from '../llm/types';
import { MCP_PROTOCOL_VERSION, type HttpAuth, type Logger } from './client';

export const OAUTH_LOGIN_TIMEOUT_MS = 5 * 60_000;
const REFRESH_MARGIN_MS = 60_000; // refresh this long before expiry
const HTTP_TIMEOUT_MS = 30_000;

type Json = Record<string, unknown>;
export type TokenAuthMethod = 'none' | 'client_secret_basic' | 'client_secret_post';

export class OAuthError extends Error {
  constructor(message: string, public code?: string) {
    super(message);
    this.name = 'OAuthError';
  }
}

// ───────────────────────── helpers ─────────────────────────
const b64url = (b: Buffer) => b.toString('base64url');
const trimSlash = (s: string) => s.replace(/\/+$/, '');

export function isLoopbackHost(host: string) {
  return host === 'localhost' || host === '[::1]' || host === '::1' || /^127\.\d+\.\d+\.\d+$/.test(host);
}

/** OAuth endpoints and the protected server must use https; plain http only on loopback (local servers, tests). */
export function requireSecureUrl(raw: string, what: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new OAuthError(`${what}不是合法 URL：${String(raw).slice(0, 200)}`);
  }
  if (u.protocol === 'https:' || (u.protocol === 'http:' && isLoopbackHost(u.hostname))) return u;
  throw new OAuthError(`${what}必须使用 https（本机回环地址除外）：${u.origin}`);
}

/** Canonical resource identifier of an MCP server URL (RFC 8707 §2): lowercase scheme/host, no fragment, no trailing slash. */
export function canonicalResource(serverUrl: string): string {
  const u = new URL(serverUrl);
  return `${u.origin}${trimSlash(u.pathname)}${u.search}`;
}

/** RFC 9728 §3.3: the advertised resource must cover the URL we talk to (same origin, path prefix). */
export function resourceCovers(resource: string, serverUrl: string): boolean {
  try {
    const r = new URL(resource);
    const s = new URL(serverUrl);
    if (r.origin !== s.origin) return false;
    const rp = trimSlash(r.pathname);
    const sp = trimSlash(s.pathname);
    return !rp || sp === rp || sp.startsWith(`${rp}/`);
  } catch {
    return false;
  }
}

/** Auth-params of the `Bearer` challenge in a WWW-Authenticate header (RFC 9110 §11.6.1), keys lowercased; null if none. */
export function parseBearerChallenge(header: string | null | undefined): Record<string, string> | null {
  if (!header) return null;
  const re = /([!#$%&'*+.^_`|~\w-]+)(?:\s*=\s*("(?:[^"\\]|\\.)*"|[^\s,]*))?/g;
  let found = false;
  const params: Record<string, string> = {};
  for (const m of header.matchAll(re)) {
    const [, name, raw] = m;
    if (raw === undefined) {
      if (found) break; // next challenge
      found = name.toLowerCase() === 'bearer';
      continue;
    }
    if (found) params[name.toLowerCase()] = raw.startsWith('"') ? raw.slice(1, -1).replace(/\\(.)/g, '$1') : raw;
  }
  return found ? params : null;
}

/** RFC 9728 §3.1: suffix inserted between host and path; then the root document. */
export function protectedResourceMetadataUrls(serverUrl: string): string[] {
  const u = new URL(serverUrl);
  const p = trimSlash(u.pathname);
  const base = `${u.origin}/.well-known/oauth-protected-resource`;
  return p ? [`${base}${p}`, base] : [base];
}

/** RFC 8414 §3.1 path insertion, then OpenID Connect Discovery (path insertion, then path appending). */
export function authServerMetadataUrls(issuer: string): string[] {
  const u = new URL(issuer);
  const p = trimSlash(u.pathname);
  if (!p) return [`${u.origin}/.well-known/oauth-authorization-server`, `${u.origin}/.well-known/openid-configuration`];
  return [`${u.origin}/.well-known/oauth-authorization-server${p}`, `${u.origin}/.well-known/openid-configuration${p}`, `${u.origin}${p}/.well-known/openid-configuration`];
}

async function readJson(res: Response): Promise<Json> {
  const t = await res.text().catch(() => '');
  try {
    const j = JSON.parse(t);
    return j && typeof j === 'object' && !Array.isArray(j) ? (j as Json) : {};
  } catch {
    return {};
  }
}

/** GET a metadata document: object on 200, null on 4xx / non-JSON (try the next candidate), throws on 5xx. */
async function getMetadata(url: string, fetch: FetchLike): Promise<Json | null> {
  const res = await fetch(url, { method: 'GET', headers: { accept: 'application/json', 'mcp-protocol-version': MCP_PROTOCOL_VERSION }, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
  if (res.status >= 500) {
    await res.text().catch(() => undefined);
    throw new OAuthError(`${url} 返回 HTTP ${res.status}`);
  }
  if (!res.ok) {
    await res.text().catch(() => undefined);
    return null;
  }
  const j = await readJson(res);
  return Object.keys(j).length ? j : null;
}

const errText = (status: number, j: Json) => `HTTP ${status}${typeof j.error === 'string' ? ` ${j.error}` : ''}${typeof j.error_description === 'string' ? `：${j.error_description.slice(0, 200)}` : ''}`;
const strList = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined);

// ───────────────────────── discovery ─────────────────────────
export interface ProtectedResourceMetadata { resource?: string; authorization_servers: string[]; scopes_supported?: string[]; resource_name?: string }

export async function discoverProtectedResource(serverUrl: string, challenge: Record<string, string> | null, fetch: FetchLike): Promise<{ url: string; meta: ProtectedResourceMetadata } | null> {
  const fromHeader = challenge?.resource_metadata && /^https?:\/\//i.test(challenge.resource_metadata) ? [challenge.resource_metadata] : [];
  const candidates = [...new Set([...fromHeader, ...protectedResourceMetadataUrls(serverUrl)])];
  for (const url of candidates) {
    const j = await getMetadata(url, fetch);
    if (!j) continue;
    const servers = strList(j.authorization_servers) ?? [];
    if (!servers.length) throw new OAuthError('受保护资源元数据缺少 authorization_servers');
    if (typeof j.resource === 'string' && !resourceCovers(j.resource, serverUrl)) throw new OAuthError(`受保护资源元数据的 resource（${j.resource}）与服务地址不符，已拒绝`);
    return { url, meta: { resource: typeof j.resource === 'string' ? j.resource : undefined, authorization_servers: servers, scopes_supported: strList(j.scopes_supported), resource_name: typeof j.resource_name === 'string' ? j.resource_name : undefined } };
  }
  return null;
}

export interface AuthServerMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  revocation_endpoint?: string;
  scopes_supported?: string[];
  code_challenge_methods_supported?: string[];
  token_endpoint_auth_methods_supported?: string[];
}

export async function discoverAuthServer(issuer: string, fetch: FetchLike): Promise<AuthServerMetadata> {
  requireSecureUrl(issuer, '授权服务器地址');
  for (const url of authServerMetadataUrls(issuer)) {
    const j = await getMetadata(url, fetch);
    if (!j) continue;
    if (typeof j.authorization_endpoint !== 'string' || typeof j.token_endpoint !== 'string') throw new OAuthError(`授权服务器元数据缺少 authorization_endpoint / token_endpoint：${url}`);
    if (typeof j.issuer === 'string' && trimSlash(j.issuer) !== trimSlash(issuer)) throw new OAuthError(`授权服务器元数据的 issuer（${j.issuer}）与 ${issuer} 不一致，已拒绝`);
    const meta: AuthServerMetadata = {
      issuer: typeof j.issuer === 'string' ? j.issuer : issuer,
      authorization_endpoint: requireSecureUrl(j.authorization_endpoint, '授权端点').toString(),
      token_endpoint: requireSecureUrl(j.token_endpoint, '令牌端点').toString(),
      scopes_supported: strList(j.scopes_supported),
      code_challenge_methods_supported: strList(j.code_challenge_methods_supported),
      token_endpoint_auth_methods_supported: strList(j.token_endpoint_auth_methods_supported),
    };
    if (typeof j.registration_endpoint === 'string') meta.registration_endpoint = requireSecureUrl(j.registration_endpoint, '注册端点').toString();
    if (typeof j.revocation_endpoint === 'string') meta.revocation_endpoint = requireSecureUrl(j.revocation_endpoint, '吊销端点').toString();
    if (meta.code_challenge_methods_supported && !meta.code_challenge_methods_supported.includes('S256')) throw new OAuthError('授权服务器不支持 PKCE S256，已拒绝登录');
    return meta;
  }
  throw new OAuthError(`未找到授权服务器元数据（RFC 8414 / OpenID）：${issuer}`);
}

// ───────────────────────── client registration ─────────────────────────
export interface ClientRegistration {
  clientId: string;
  clientSecret?: string;
  authMethod: TokenAuthMethod;
  redirectUris: string[];
  issuer: string;
  dynamic: boolean;
  secretExpiresAt?: number;
}

function authMethodOf(m: unknown, hasSecret: boolean): TokenAuthMethod {
  if (!hasSecret) return 'none';
  return m === 'client_secret_post' || m === 'client_secret_basic' ? m : 'client_secret_basic';
}

export async function registerClient(meta: AuthServerMetadata, o: { redirectUri: string; scopes: string[]; version: string; fetch: FetchLike }): Promise<ClientRegistration> {
  if (!meta.registration_endpoint) throw new OAuthError('授权服务器不支持动态客户端注册：请在 mcp.json 的 auth.clientId（及 auth.clientSecret）中填写预先注册的客户端');
  const body = {
    client_name: 'Edict · 三省六部',
    redirect_uris: [o.redirectUri],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    software_id: 'edict-for-mac',
    software_version: o.version,
    ...(o.scopes.length ? { scope: o.scopes.join(' ') } : {}),
  };
  const res = await o.fetch(meta.registration_endpoint, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
  const j = await readJson(res);
  if (!res.ok || typeof j.client_id !== 'string' || !j.client_id) throw new OAuthError(`动态客户端注册失败：${errText(res.status, j)}`);
  const secret = typeof j.client_secret === 'string' && j.client_secret ? j.client_secret : undefined;
  const exp = Number(j.client_secret_expires_at);
  return {
    clientId: j.client_id,
    clientSecret: secret,
    authMethod: authMethodOf(j.token_endpoint_auth_method, !!secret),
    redirectUris: strList(j.redirect_uris)?.length ? strList(j.redirect_uris)! : [o.redirectUri],
    issuer: meta.issuer,
    dynamic: true,
    secretExpiresAt: secret && exp > 0 ? exp * 1000 : undefined,
  };
}

// ───────────────────────── PKCE / tokens ─────────────────────────
export function createPkce() {
  const verifier = b64url(crypto.randomBytes(32));
  return { verifier, challenge: b64url(crypto.createHash('sha256').update(verifier).digest()) };
}

export interface TokenSet { accessToken: string; tokenType: string; refreshToken?: string; expiresAt?: number; scope?: string; obtainedAt: number }

type ClientAuth = { clientId: string; clientSecret?: string; authMethod: TokenAuthMethod };

/** Form body + headers for a token-endpoint style request with client authentication (RFC 6749 §2.3.1). */
function clientRequest(client: ClientAuth, params: Record<string, string>) {
  const body = new URLSearchParams(params);
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
  if (client.authMethod === 'client_secret_basic' && client.clientSecret) {
    headers.authorization = `Basic ${Buffer.from(`${encodeURIComponent(client.clientId)}:${encodeURIComponent(client.clientSecret)}`).toString('base64')}`;
  } else {
    body.set('client_id', client.clientId);
    if (client.authMethod === 'client_secret_post' && client.clientSecret) body.set('client_secret', client.clientSecret);
  }
  return { method: 'POST', headers, body: body.toString() };
}

async function tokenRequest(endpoint: string, client: ClientAuth, params: Record<string, string>, fetch: FetchLike, now: number): Promise<TokenSet> {
  const res = await fetch(endpoint, { ...clientRequest(client, params), signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
  const j = await readJson(res);
  if (!res.ok) throw new OAuthError(`令牌请求失败：${errText(res.status, j)}`, typeof j.error === 'string' ? j.error : undefined);
  if (typeof j.access_token !== 'string' || !j.access_token) throw new OAuthError('令牌响应缺少 access_token');
  const type = typeof j.token_type === 'string' ? j.token_type : 'Bearer';
  if (type.toLowerCase() !== 'bearer') throw new OAuthError(`不支持的令牌类型：${type}`);
  const exp = Number(j.expires_in);
  return {
    accessToken: j.access_token,
    tokenType: 'Bearer',
    refreshToken: typeof j.refresh_token === 'string' && j.refresh_token ? j.refresh_token : undefined,
    expiresAt: Number.isFinite(exp) && exp > 0 ? now + exp * 1000 : undefined,
    scope: typeof j.scope === 'string' ? j.scope : undefined,
    obtainedAt: now,
  };
}

// ───────────────────────── loopback callback ─────────────────────────
const HTML_ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escHtml = (s: string) => s.replace(/[&<>"']/g, (c) => HTML_ESC[c]);

export function callbackPage(ok: boolean, message: string): string {
  const title = ok ? '授权成功' : '授权失败';
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Edict · ${title}</title><style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f5efe3;color:#3a2e1f;font:16px/1.7 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif}main{max-width:30em;padding:2em 2.4em;background:#fffaf0;border:1px solid #d9c9a8;border-radius:10px;text-align:center}h1{margin:0 0 .4em;font-size:1.4em;color:${ok ? '#2e6b3a' : '#9b2c2c'}}p{margin:.4em 0}.muted{color:#7a6a52;font-size:.9em}</style></head><body><main><h1>${ok ? '✓' : '✗'} ${title}</h1><p>${escHtml(message)}</p><p class="muted">${ok ? '可以关闭此页面，回到 Edict。' : '可以关闭此页面，回到 Edict 重试登录。'}</p></main></body></html>`;
}

export interface CallbackServer {
  redirectUri: string;
  port: number;
  address: AddressInfo;
  /** Resolves with the code once a callback with the expected state arrives; rejects on mismatch, error, timeout or cancel. */
  result: Promise<{ code: string }>;
  /** Answer the held browser request (after the token exchange) and shut the server down. */
  finish(ok: boolean, message: string): void;
  cancel(message: string): void;
}

/** One-shot callback server on 127.0.0.1 only; closes after the callback or `timeoutMs`. */
export async function startCallbackServer(o: { state: string; preferredPort?: number; timeoutMs?: number; signal?: AbortSignal }): Promise<CallbackServer> {
  const timeoutMs = o.timeoutMs ?? OAUTH_LOGIN_TIMEOUT_MS;
  let settled = false;
  let held: http.ServerResponse | null = null;
  let resolve!: (v: { code: string }) => void;
  let reject!: (e: Error) => void;
  const result = new Promise<{ code: string }>((res, rej) => ((resolve = res), (reject = rej)));
  result.catch(() => undefined);
  const send = (res: http.ServerResponse, status: number, ok: boolean, message: string) => {
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'", 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff', connection: 'close' });
    res.end(callbackPage(ok, message));
  };
  let server!: http.Server;
  let timer: NodeJS.Timeout | undefined;
  let closed = false;
  const shutdown = () => {
    if (closed) return;
    closed = true;
    if (timer) clearTimeout(timer);
    o.signal?.removeEventListener('abort', onAbort);
    server.close();
    server.closeIdleConnections();
    setTimeout(() => server.closeAllConnections(), 1000).unref();
  };
  const fail = (message: string, res?: http.ServerResponse, status = 400) => {
    if (settled) return;
    settled = true;
    if (res) res.once('finish', shutdown);
    if (res) send(res, status, false, message);
    else shutdown();
    reject(new OAuthError(message));
  };
  const onAbort = () => fail('登录已取消');
  const handler: http.RequestListener = (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method !== 'GET' || url.pathname !== '/callback') return void res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', connection: 'close' }).end('not found');
    if (settled) return send(res, 410, false, '此登录请求已结束，请回到 Edict 重新登录。');
    const q = url.searchParams;
    if (q.get('state') !== o.state) return fail('授权回调的 state 不匹配，已拒绝（可能是过期页面或伪造的请求）。请回到 Edict 重新登录。', res);
    const error = q.get('error');
    if (error) return fail(`授权服务器拒绝了请求：${(q.get('error_description') ?? error).slice(0, 300)}`, res);
    const code = q.get('code');
    if (!code) return fail('授权回调缺少 code 参数', res);
    settled = true;
    held = res;
    resolve({ code });
  };
  const listen = (port: number) =>
    new Promise<http.Server>((res, rej) => {
      const s = http.createServer(handler);
      s.once('error', rej);
      s.listen(port, '127.0.0.1', () => {
        s.off('error', rej);
        res(s);
      });
    });
  try {
    server = await listen(o.preferredPort ?? 0);
  } catch (e) {
    if (!o.preferredPort) throw e;
    server = await listen(0); // previous port taken: any free one
  }
  const address = server.address() as AddressInfo;
  timer = setTimeout(() => fail(`登录超时：${Math.round(timeoutMs / 60000) || 1} 分钟内未在浏览器中完成授权`), timeoutMs);
  timer.unref();
  if (o.signal?.aborted) onAbort();
  else o.signal?.addEventListener('abort', onAbort, { once: true });
  const finish = (ok: boolean, message: string) => {
    const res = held;
    held = null;
    if (!res) return shutdown();
    res.once('finish', shutdown);
    send(res, ok ? 200 : 400, ok, message);
  };
  return {
    redirectUri: `http://127.0.0.1:${address.port}/callback`,
    port: address.port,
    address,
    result,
    finish,
    cancel: (message) => (held ? finish(false, message) : fail(message)),
  };
}

// ───────────────────────── per-server session ─────────────────────────
export interface OAuthStore { get(): string | null; set(v: string): void; delete(): void }

/** What `mcp-oauth:<server>` holds (JSON) in the SecretStore. */
export interface OAuthRecord {
  v: 1;
  server: string; // canonical URL of the MCP server these tokens are for
  resource: string; // RFC 8707 value sent to the authorization server
  issuer: string;
  tokenEndpoint: string;
  revocationEndpoint?: string;
  clientId: string;
  authMethod: TokenAuthMethod;
  client?: ClientRegistration; // dynamic registration, reused by later logins
  tokens?: TokenSet;
  scopes?: string[];
  redirectPort?: number;
}

export interface McpOAuthOptions {
  serverUrl: string;
  clientId?: string;
  clientSecret?: string;
  scopes?: string[];
  fetch: FetchLike;
  store: OAuthStore;
  openExternal?: (url: string) => unknown;
  log: Logger;
  version: string;
  now?: () => number;
}

export class McpOAuth implements HttpAuth {
  /** Last WWW-Authenticate challenge from the server (kept across reconnects for discovery). */
  challenge: string | null = null;
  /** The server rejected us and no token refresh helped: interactive login needed. */
  onAuthRequired?: () => void;
  readonly server: string;
  private refreshing: Promise<boolean> | null = null;

  constructor(private o: McpOAuthOptions) {
    this.server = canonicalResource(o.serverUrl);
  }

  private now() {
    return this.o.now?.() ?? Date.now();
  }

  private raw(): OAuthRecord | null {
    try {
      const s = this.o.store.get();
      const r = s ? (JSON.parse(s) as OAuthRecord) : null;
      return r && r.v === 1 ? r : null;
    } catch {
      return null;
    }
  }

  /** The stored record, only if it was issued for this server URL (and configured client). */
  record(): OAuthRecord | null {
    const r = this.raw();
    if (!r || r.server !== this.server) return null;
    if (this.o.clientId && r.clientId !== this.o.clientId) return null;
    return r;
  }

  private save(r: OAuthRecord) {
    this.o.store.set(JSON.stringify(r));
  }

  status(): McpAuthState {
    const r = this.record();
    const t = r?.tokens;
    return { type: 'oauth', loggedIn: !!t, expiresAt: t?.expiresAt, scopes: t?.scope ? t.scope.split(/\s+/).filter(Boolean) : r?.scopes, issuer: r?.issuer, dynamicClient: r ? !!r.client : undefined };
  }

  /** Values that must never appear in logs (for redaction by the caller). */
  secrets(): string[] {
    const r = this.raw();
    return [r?.tokens?.accessToken, r?.tokens?.refreshToken, r?.client?.clientSecret, this.o.clientSecret].filter((x): x is string => !!x && x.length >= 6);
  }

  async header(): Promise<string | null> {
    let t = this.record()?.tokens;
    if (!t) return null;
    if (t.expiresAt && t.expiresAt - this.now() < REFRESH_MARGIN_MS && t.refreshToken) {
      await this.refresh();
      t = this.record()?.tokens;
      if (!t) return null;
    }
    return `Bearer ${t.accessToken}`;
  }

  async unauthorized(wwwAuthenticate: string | null, sent: string | null, retried: boolean): Promise<boolean> {
    if (wwwAuthenticate) this.challenge = wwwAuthenticate;
    if (!retried) {
      const t = this.record()?.tokens;
      if (t && `Bearer ${t.accessToken}` !== sent) return true; // refreshed meanwhile
      if (t?.refreshToken && (await this.refresh())) return true;
    }
    this.onAuthRequired?.();
    return false;
  }

  /** Refresh-token grant, deduplicated. true when a new access token was stored. */
  refresh(): Promise<boolean> {
    if (!this.refreshing) this.refreshing = this.doRefresh().finally(() => (this.refreshing = null));
    return this.refreshing;
  }

  private async doRefresh(): Promise<boolean> {
    const rec = this.record();
    const refreshToken = rec?.tokens?.refreshToken;
    if (!rec || !refreshToken) return false;
    try {
      const params: Record<string, string> = { grant_type: 'refresh_token', refresh_token: refreshToken, resource: rec.resource };
      const t = await tokenRequest(rec.tokenEndpoint, this.clientOf(rec), params, this.o.fetch, this.now());
      this.save({ ...(this.record() ?? rec), tokens: { ...t, refreshToken: t.refreshToken ?? refreshToken, scope: t.scope ?? rec.tokens?.scope } });
      this.o.log('info', 'OAuth 访问令牌已刷新');
      return true;
    } catch (e) {
      const code = (e as OAuthError).code;
      if (code === 'invalid_grant' || code === 'invalid_client' || code === 'unauthorized_client') {
        const cur = this.record();
        if (cur) this.save({ ...cur, tokens: undefined });
        this.o.log('error', `刷新令牌已失效（${code}），需要重新登录`);
      } else this.o.log('error', `刷新访问令牌失败：${(e as Error).message}`);
      return false;
    }
  }

  private clientOf(r: OAuthRecord) {
    return { clientId: r.clientId, clientSecret: r.client ? r.client.clientSecret : this.o.clientSecret, authMethod: r.authMethod };
  }

  /** Interactive login: discovery → (DCR) → browser → loopback callback → token exchange. Only on the user's request. */
  async login(o: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<{ issuer: string; scopes: string[]; dynamicClient: boolean }> {
    requireSecureUrl(this.o.serverUrl, 'OAuth 登录的 MCP 服务地址');
    const open = this.o.openExternal;
    if (!open) throw new OAuthError('当前环境无法打开浏览器，不能完成 OAuth 登录');
    const challenge = parseBearerChallenge(this.challenge);
    const prm = await discoverProtectedResource(this.o.serverUrl, challenge, this.o.fetch);
    if (!prm) this.o.log('info', '未找到受保护资源元数据（RFC 9728），按旧版约定以服务所在域作为授权服务器');
    const resource = prm?.meta.resource ? canonicalResource(prm.meta.resource) : this.server;
    const meta = await discoverAuthServer(prm?.meta.authorization_servers[0] ?? new URL(this.o.serverUrl).origin, this.o.fetch);
    const scopes = this.o.scopes?.length ? this.o.scopes : challenge?.scope ? challenge.scope.split(/\s+/).filter(Boolean) : (prm?.meta.scopes_supported ?? []);
    const prev = this.raw();
    const state = b64url(crypto.randomBytes(24));
    const pkce = createPkce();
    const cb = await startCallbackServer({ state, preferredPort: prev?.redirectPort, timeoutMs: o.timeoutMs, signal: o.signal });
    try {
      const base = { v: 1 as const, server: this.server, resource, issuer: meta.issuer, tokenEndpoint: meta.token_endpoint, revocationEndpoint: meta.revocation_endpoint, scopes, redirectPort: cb.port };
      let client: ClientRegistration;
      const reusable = prev?.client && prev.client.issuer === meta.issuer && prev.client.redirectUris.includes(cb.redirectUri) && (!prev.client.secretExpiresAt || prev.client.secretExpiresAt > this.now() + 60_000);
      if (this.o.clientId) {
        const methods = meta.token_endpoint_auth_methods_supported;
        const authMethod: TokenAuthMethod = !this.o.clientSecret ? 'none' : !methods || methods.includes('client_secret_basic') || !methods.includes('client_secret_post') ? 'client_secret_basic' : 'client_secret_post';
        client = { clientId: this.o.clientId, clientSecret: this.o.clientSecret, authMethod, redirectUris: [cb.redirectUri], issuer: meta.issuer, dynamic: false };
      } else if (reusable) client = prev!.client!;
      else {
        client = await registerClient(meta, { redirectUri: cb.redirectUri, scopes, version: this.o.version, fetch: this.o.fetch });
        const keep = prev && prev.server === this.server && prev.issuer === meta.issuer ? prev.tokens : undefined;
        this.save({ ...base, clientId: client.clientId, authMethod: client.authMethod, client, tokens: keep });
        this.o.log('info', `已向授权服务器动态注册客户端（${new URL(meta.issuer).host}）`);
      }
      const url = new URL(meta.authorization_endpoint);
      const q = url.searchParams;
      q.set('response_type', 'code');
      q.set('client_id', client.clientId);
      q.set('redirect_uri', cb.redirectUri);
      q.set('code_challenge', pkce.challenge);
      q.set('code_challenge_method', 'S256');
      q.set('state', state);
      q.set('resource', resource);
      if (scopes.length) q.set('scope', scopes.join(' '));
      this.o.log('info', `已在浏览器中打开授权页（${url.host}），等待回调 127.0.0.1:${cb.port}`);
      // not awaited: the browser's request to the callback is answered only after the token exchange below
      void Promise.resolve()
        .then(() => open(url.toString()))
        .catch((e) => cb.cancel(`无法打开浏览器：${(e as Error).message}`));
      const { code } = await cb.result;
      const tokens = await tokenRequest(meta.token_endpoint, client, { grant_type: 'authorization_code', code, redirect_uri: cb.redirectUri, code_verifier: pkce.verifier, resource }, this.o.fetch, this.now());
      this.save({ ...base, clientId: client.clientId, authMethod: client.authMethod, client: client.dynamic ? client : undefined, tokens });
      cb.finish(true, 'Edict 已获得该 MCP 服务的访问授权。');
      return { issuer: meta.issuer, scopes: tokens.scope ? tokens.scope.split(/\s+/).filter(Boolean) : scopes, dynamicClient: client.dynamic };
    } catch (e) {
      cb.cancel((e as Error).message);
      throw e;
    }
  }

  /** Forget tokens and client registration; best-effort revocation (RFC 7009) afterwards. */
  async logout(): Promise<{ revoked: boolean }> {
    const r = this.raw();
    this.o.store.delete();
    const token = r?.tokens?.refreshToken ?? r?.tokens?.accessToken;
    if (!r?.revocationEndpoint || !token) return { revoked: false };
    try {
      const req = clientRequest(this.clientOf(r), { token, token_type_hint: r.tokens?.refreshToken ? 'refresh_token' : 'access_token' });
      const res = await this.o.fetch(r.revocationEndpoint, { ...req, signal: AbortSignal.timeout(5000) });
      await res.text().catch(() => undefined);
      return { revoked: res.ok };
    } catch {
      return { revoked: false };
    }
  }
}
