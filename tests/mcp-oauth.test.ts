// MCP OAuth (integration: in-process fake OAuth 2.1 authorization server + protected Streamable HTTP MCP server
// on real loopback sockets; the "browser" is simulated by fetching the authorize URL and following its redirect).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { makeRuntime, waitFor } from './helpers';
import type { Runtime } from '../src/main/runtime/runtime';
import { extractSecrets, oauthSecretId, parseMcpConfig } from '../src/main/mcp/manager';
import { authServerMetadataUrls, canonicalResource, parseBearerChallenge, protectedResourceMetadataUrls, resourceCovers, startCallbackServer } from '../src/main/mcp/oauth';
import { executeTool } from '../src/main/runtime/tools';

const NO_LLM = 'http://127.0.0.1:9/v1'; // provider is never called here

async function listen(handler: (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void) {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => handler(req, res, body));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }) };
}
const json = (res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => res.writeHead(status, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(body));

type Grant = { clientId: string; resource: string; scope: string };

/** Fake authorization server: metadata, DCR, authorize (302 → redirect_uri), token (code + PKCE, refresh rotation), revoke. */
async function fakeAuthServer(o: { issuerPath?: string; oidcOnly?: boolean; dcr?: boolean; staticClients?: Record<string, string | null> } = {}) {
  const p = o.issuerPath ?? '';
  const clients = new Map<string, { redirectUris: string[]; secret: string | null }>(Object.entries(o.staticClients ?? {}).map(([id, secret]) => [id, { redirectUris: [], secret }]));
  const codes = new Map<string, Grant & { redirectUri: string; challenge: string }>();
  const access = new Map<string, Grant>();
  const refresh = new Map<string, Grant>();
  const log: { method: string; path: string; params: Record<string, string>; auth?: string }[] = [];
  let n = 0;
  const issue = (g: Grant) => {
    const a = `at-${crypto.randomBytes(12).toString('hex')}`;
    const r = `rt-${crypto.randomBytes(12).toString('hex')}`;
    access.set(a, g);
    refresh.set(r, g);
    return { access_token: a, token_type: 'Bearer', expires_in: 3600, refresh_token: r, scope: g.scope };
  };
  const srv = await listen((req, res, body) => {
    const url = new URL(req.url!, 'http://x');
    const form = String(req.headers['content-type']).includes('x-www-form-urlencoded');
    const params = form ? Object.fromEntries(new URLSearchParams(body)) : Object.fromEntries(url.searchParams);
    log.push({ method: req.method!, path: url.pathname, params, auth: req.headers.authorization });
    const issuer = `${srv.base}${p}`;
    const metaPath = o.oidcOnly ? `${p}/.well-known/openid-configuration` : `/.well-known/oauth-authorization-server${p}`;
    if (req.method === 'GET' && url.pathname === metaPath) {
      return json(res, 200, {
        issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, revocation_endpoint: `${issuer}/revoke`,
        ...(o.dcr === false ? {} : { registration_endpoint: `${issuer}/register` }),
        response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none', 'client_secret_basic'],
      });
    }
    if (req.method === 'POST' && url.pathname === `${p}/register` && o.dcr !== false) {
      const j = JSON.parse(body);
      const id = `dyn-${++n}`;
      clients.set(id, { redirectUris: j.redirect_uris, secret: null });
      return json(res, 201, { client_id: id, client_id_issued_at: Math.floor(Date.now() / 1000), redirect_uris: j.redirect_uris, token_endpoint_auth_method: 'none', grant_types: j.grant_types });
    }
    if (req.method === 'GET' && url.pathname === `${p}/authorize`) {
      const q = params;
      const c = clients.get(q.client_id);
      if (!c) return json(res, 400, { error: 'invalid_client' });
      // dynamic clients: exact redirect match; pre-registered: any loopback port (RFC 8252 §7.3)
      const okRedirect = c.redirectUris.length ? c.redirectUris.includes(q.redirect_uri) : /^http:\/\/127\.0\.0\.1:\d+\/callback$/.test(q.redirect_uri);
      if (!okRedirect || q.response_type !== 'code' || q.code_challenge_method !== 'S256' || !q.code_challenge || !q.state || !q.resource) return json(res, 400, { error: 'invalid_request' });
      const code = `code-${crypto.randomBytes(8).toString('hex')}`;
      codes.set(code, { clientId: q.client_id, redirectUri: q.redirect_uri, challenge: q.code_challenge, resource: q.resource, scope: q.scope ?? '' });
      return res.writeHead(302, { location: `${q.redirect_uri}?code=${code}&state=${encodeURIComponent(q.state)}` }).end();
    }
    if (req.method === 'POST' && url.pathname === `${p}/token`) {
      let clientId = params.client_id;
      let secret: string | undefined;
      const basic = req.headers.authorization?.match(/^Basic (.+)$/);
      if (basic) [clientId, secret] = Buffer.from(basic[1], 'base64').toString().split(':').map(decodeURIComponent);
      const c = clients.get(clientId);
      if (!c || (c.secret && c.secret !== secret)) return json(res, 401, { error: 'invalid_client' });
      if (params.grant_type === 'authorization_code') {
        const g = codes.get(params.code);
        codes.delete(params.code);
        const s256 = crypto.createHash('sha256').update(params.code_verifier ?? '').digest('base64url');
        if (!g || g.clientId !== clientId || g.redirectUri !== params.redirect_uri || g.challenge !== s256 || g.resource !== params.resource) return json(res, 400, { error: 'invalid_grant' });
        return json(res, 200, issue(g));
      }
      if (params.grant_type === 'refresh_token') {
        const g = refresh.get(params.refresh_token);
        if (!g || g.clientId !== clientId || g.resource !== params.resource) return json(res, 400, { error: 'invalid_grant', error_description: 'refresh token revoked' });
        refresh.delete(params.refresh_token); // rotation
        return json(res, 200, issue(g));
      }
      return json(res, 400, { error: 'unsupported_grant_type' });
    }
    if (req.method === 'POST' && url.pathname === `${p}/revoke`) {
      refresh.delete(params.token);
      access.delete(params.token);
      return res.writeHead(200).end();
    }
    json(res, 404, { error: 'not_found' });
  });
  const calls = (suffix: string) => log.filter((l) => l.path === `${p}${suffix}`);
  return { ...srv, issuer: `${srv.base}${p}`, log, access, calls, refreshGrants: () => calls('/token').filter((c) => c.params.grant_type === 'refresh_token').length, expireAccessTokens: () => access.clear(), revokeAll: () => (access.clear(), refresh.clear()) };
}
type FakeAs = Awaited<ReturnType<typeof fakeAuthServer>>;

/** Streamable HTTP MCP server that only accepts bearer tokens the fake AS issued for its own URL. */
async function protectedMcp(as: FakeAs, o: { prm: 'header' | 'root' }) {
  const seen: { method?: string; auth?: string; status: number }[] = [];
  const gets: string[] = [];
  const srv = await listen((req, res, body) => {
    const url = new URL(req.url!, 'http://x');
    const self = `${srv.base}/mcp`;
    const prm = { resource: self, authorization_servers: [as.issuer], scopes_supported: ['mcp:tools', 'mcp:read'], bearer_methods_supported: ['header'] };
    if (req.method === 'GET') {
      gets.push(url.pathname);
      if (url.pathname === '/.well-known/oauth-protected-resource/mcp' && o.prm === 'header') return json(res, 200, prm);
      if (url.pathname === '/.well-known/oauth-protected-resource' && o.prm === 'root') return json(res, 200, prm);
      return json(res, 404, {});
    }
    if (url.pathname !== '/mcp') return json(res, 404, {});
    if (req.method === 'DELETE') return res.writeHead(200).end();
    const m = body ? JSON.parse(body) : {};
    const token = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
    const grant = token ? as.access.get(token) : undefined;
    if (!grant || grant.resource !== self) {
      seen.push({ method: m.method, auth: req.headers.authorization, status: 401 });
      const www = o.prm === 'header' ? `Bearer error="invalid_token", resource_metadata="${srv.base}/.well-known/oauth-protected-resource/mcp", scope="mcp:tools mcp:read"` : 'Bearer realm="mcp"';
      return json(res, 401, { error: 'invalid_token' }, { 'www-authenticate': www });
    }
    seen.push({ method: m.method, auth: req.headers.authorization, status: 200 });
    if (m.id === undefined) return res.writeHead(202).end();
    const result =
      m.method === 'initialize' ? { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'protected', version: '1' } }
      : m.method === 'tools/list' ? { tools: [{ name: 'whoami', description: 'who am I', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } }] }
      : m.method === 'tools/call' ? { content: [{ type: 'text', text: `client ${grant.clientId} scope ${grant.scope}` }] }
      : {};
    json(res, 200, { jsonrpc: '2.0', id: m.id, result }, m.method === 'initialize' ? { 'mcp-session-id': 's-1' } : {});
  });
  return { ...srv, url: `${srv.base}/mcp`, seen, gets, count401: () => seen.filter((s) => s.status === 401).length };
}

/** Plays the system browser: GET the authorize URL, follow its redirect to the loopback callback. */
function fakeBrowser(rt: Runtime, o: { tamper?: (u: URL) => void } = {}) {
  const opened: string[] = [];
  const pages: { url: string; status: number; html: string }[] = [];
  rt.opts.openExternal = async (url: string) => {
    opened.push(url);
    const r = await fetch(url, { redirect: 'manual' });
    const loc = r.headers.get('location');
    if (!loc) return void pages.push({ url, status: r.status, html: await r.text() });
    const cb = new URL(loc);
    o.tamper?.(cb);
    const page = await fetch(cb);
    pages.push({ url: cb.toString(), status: page.status, html: await page.text() });
  };
  return { opened, pages };
}

const portClosed = (port: number) =>
  new Promise<boolean>((r) => {
    const s = net.connect(port, '127.0.0.1');
    s.once('connect', () => (s.destroy(), r(false)));
    s.once('error', () => r(true));
  });

function filesContaining(dir: string, needles: string[]): string[] {
  const hits: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) hits.push(...filesContaining(f, needles));
    else if (e.isFile() && needles.some((n) => fs.readFileSync(f, 'utf8').includes(n))) hits.push(f);
  }
  return hits;
}

const readAudit = (rt: Runtime) => fs.readFileSync(path.join(rt.opts.dataDir, 'audit.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const record = (rt: Runtime) => JSON.parse(rt.opts.secrets.get(oauthSecretId('remote')) ?? 'null');

test('OAuth helpers: WWW-Authenticate parsing, well-known URLs, canonical resource, auth config validation + clientSecret extraction', () => {
  assert.deepEqual(parseBearerChallenge('Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource", scope="files:read files:write", error="invalid_token"'), { resource_metadata: 'https://mcp.example.com/.well-known/oauth-protected-resource', scope: 'files:read files:write', error: 'invalid_token' });
  assert.deepEqual(parseBearerChallenge('Basic realm="x", Bearer realm="m", error_description="say \\"hi\\", ok", resource_metadata=https://a.example/x'), { realm: 'm', error_description: 'say "hi", ok', resource_metadata: 'https://a.example/x' });
  assert.equal(parseBearerChallenge('Basic realm="x"'), null);
  assert.deepEqual(parseBearerChallenge('Bearer'), {});
  assert.deepEqual(protectedResourceMetadataUrls('https://mcp.example.com/server/mcp/'), ['https://mcp.example.com/.well-known/oauth-protected-resource/server/mcp', 'https://mcp.example.com/.well-known/oauth-protected-resource']);
  assert.deepEqual(protectedResourceMetadataUrls('https://mcp.example.com'), ['https://mcp.example.com/.well-known/oauth-protected-resource']);
  assert.deepEqual(authServerMetadataUrls('https://auth.example.com/'), ['https://auth.example.com/.well-known/oauth-authorization-server', 'https://auth.example.com/.well-known/openid-configuration']);
  assert.deepEqual(authServerMetadataUrls('https://auth.example.com/tenant1'), ['https://auth.example.com/.well-known/oauth-authorization-server/tenant1', 'https://auth.example.com/.well-known/openid-configuration/tenant1', 'https://auth.example.com/tenant1/.well-known/openid-configuration']);
  assert.equal(canonicalResource('HTTPS://MCP.Example.com:443/mcp/#frag'), 'https://mcp.example.com/mcp');
  assert.equal(canonicalResource('https://mcp.example.com/'), 'https://mcp.example.com');
  assert.ok(resourceCovers('https://mcp.example.com', 'https://mcp.example.com/mcp'));
  assert.ok(resourceCovers('https://mcp.example.com/mcp', 'https://mcp.example.com/mcp/'));
  assert.ok(!resourceCovers('https://mcp.example.com/other', 'https://mcp.example.com/mcp'));
  assert.ok(!resourceCovers('https://evil.example.com/mcp', 'https://mcp.example.com/mcp'));

  const cfg = parseMcpConfig(JSON.stringify({ mcpServers: { a: { url: 'https://x/mcp', auth: { type: 'oauth', clientId: 'cid', clientSecret: 'plain-secret', scopes: ['read', 'read', 'write'] } }, b: { url: 'https://y/mcp', auth: { type: 'none' } } } }));
  assert.deepEqual(cfg.mcpServers.a.auth, { type: 'oauth', clientId: 'cid', clientSecret: 'plain-secret', scopes: ['read', 'write'] });
  assert.deepEqual(cfg.mcpServers.b.auth, { type: 'none' });
  const store = new Map<string, string>();
  assert.deepEqual(extractSecrets(cfg, (id, v) => store.set(id, v)), ['a.auth.clientSecret']);
  assert.equal((cfg.mcpServers.a.auth as { clientSecret?: string }).clientSecret, '${secret:a/auth/clientSecret}');
  assert.equal(store.get('a/auth/clientSecret'), 'plain-secret');
  assert.throws(() => parseMcpConfig('{"mcpServers":{"a":{"url":"https://x","auth":{"type":"basic"}}}}'), /auth\.type/);
  assert.throws(() => parseMcpConfig('{"mcpServers":{"a":{"command":"x","auth":{"type":"oauth"}}}}'), /仅适用于远程/);
  assert.throws(() => parseMcpConfig('{"mcpServers":{"a":{"url":"https://x","auth":{"type":"oauth","scopes":["a b"]}}}}'), /scopes/);
  assert.throws(() => parseMcpConfig('{"mcpServers":{"a":{"url":"https://x","auth":{"type":"oauth","clientSecret":"s"}}}}'), /clientId/);
  assert.throws(() => parseMcpConfig('{"mcpServers":{"a":{"url":"https://x","auth":"oauth"}}}'), /auth 必须是对象/);
});

test('OAuth loopback callback server: bound to 127.0.0.1 only, ignores other paths, answers after the exchange, times out and closes', async () => {
  const cb = await startCallbackServer({ state: 'st-1', timeoutMs: 300 });
  assert.equal(cb.address.address, '127.0.0.1');
  assert.equal(cb.address.family, 'IPv4');
  assert.equal(cb.redirectUri, `http://127.0.0.1:${cb.port}/callback`);
  assert.equal((await fetch(`http://127.0.0.1:${cb.port}/favicon.ico`)).status, 404);
  await assert.rejects(cb.result, /登录超时/);
  assert.ok(await portClosed(cb.port), 'closed after the timeout');

  const cb2 = await startCallbackServer({ state: 'st-2', timeoutMs: 5000 });
  const page = fetch(`${cb2.redirectUri}?code=abc&state=st-2`).then(async (r) => ({ status: r.status, html: await r.text(), csp: r.headers.get('content-security-policy') }));
  assert.deepEqual(await cb2.result, { code: 'abc' });
  cb2.finish(true, '好了');
  const p = await page;
  assert.equal(p.status, 200);
  assert.match(p.html, /<html lang="zh-CN">[\s\S]*授权成功[\s\S]*好了/);
  assert.match(p.csp ?? '', /default-src 'none'/);
  assert.ok(await portClosed(cb2.port), 'closed after the callback');

  const cb3 = await startCallbackServer({ state: 's3' });
  const r3 = await fetch(`${cb3.redirectUri}?error=access_denied&error_description=${encodeURIComponent('<b>拒绝</b>')}&state=s3`);
  assert.equal(r3.status, 400);
  assert.match(await r3.text(), /授权失败[\s\S]*&lt;b&gt;拒绝&lt;\/b&gt;/, 'error shown, escaped');
  await assert.rejects(cb3.result, /拒绝/);
  assert.ok(await portClosed(cb3.port));

  const ac = new AbortController();
  const cb4 = await startCallbackServer({ state: 's4', signal: ac.signal });
  ac.abort();
  await assert.rejects(cb4.result, /已取消/);
  assert.ok(await portClosed(cb4.port));
});

test('OAuth: 401 → resource metadata → AS metadata → DCR → browser → loopback callback → token; bearer on every request; refresh near expiry and on 401; needs_auth; logout', async () => {
  const as = await fakeAuthServer();
  const mcp = await protectedMcp(as, { prm: 'header' });
  const rt = makeRuntime(NO_LLM);
  rt.mcp.loginTimeoutMs = 10000;
  const browser = fakeBrowser(rt);
  rt.mcp.load(false);
  rt.mcp.saveConfig(JSON.stringify({ mcpServers: { remote: { url: mcp.url } } }));
  await waitFor(() => ['needs_auth', 'ok', 'error'].includes(rt.mcp.states.get('remote')?.status ?? ''), 10000, 'first connect');
  const st = rt.mcp.states.get('remote')!;
  assert.equal(st.status, 'needs_auth', st.error);
  assert.match(st.error!, /登录/);
  assert.equal(st.auth?.loggedIn, false);
  assert.equal(browser.opened.length, 0, 'never opens the browser on its own');

  await rt.mcp.login('remote');
  assert.equal(st.status, 'ok', st.error);
  assert.equal(st.error, undefined);
  assert.equal(st.auth?.loggedIn, true);
  assert.equal(st.auth?.dynamicClient, true);
  assert.equal(st.auth?.issuer, as.issuer);
  assert.ok(st.auth?.expiresAt && st.auth.expiresAt > Date.now() + 3000_000);
  // the authorization request
  assert.equal(browser.opened.length, 1);
  const au = new URL(browser.opened[0]);
  assert.equal(`${au.origin}${au.pathname}`, `${as.issuer}/authorize`);
  const q = Object.fromEntries(au.searchParams);
  assert.equal(q.response_type, 'code');
  assert.equal(q.client_id, 'dyn-1');
  assert.equal(q.code_challenge_method, 'S256');
  assert.match(q.code_challenge, /^[\w-]{43}$/);
  assert.ok(q.state.length >= 20);
  assert.equal(q.resource, mcp.url, 'RFC 8707 resource');
  assert.equal(q.scope, 'mcp:tools mcp:read', 'scope from the WWW-Authenticate challenge');
  const redirect = new URL(q.redirect_uri);
  assert.equal(redirect.hostname, '127.0.0.1');
  assert.equal(redirect.pathname, '/callback');
  // DCR then the code exchange (PKCE verified by the fake AS)
  assert.equal(as.calls('/register').length, 1);
  const tokenReq = as.calls('/token')[0].params;
  assert.equal(tokenReq.grant_type, 'authorization_code');
  assert.equal(tokenReq.resource, mcp.url);
  assert.equal(tokenReq.client_id, 'dyn-1');
  assert.equal(tokenReq.redirect_uri, q.redirect_uri);
  // the browser got the Chinese success page; the callback server is gone
  await waitFor(() => browser.pages.length === 1, 5000, 'callback page');
  assert.equal(browser.pages[0].status, 200);
  assert.match(browser.pages[0].html, /授权成功/);
  assert.ok(await portClosed(Number(redirect.port)), 'callback server closed');

  // bearer on every request after login
  assert.equal((await executeTool({ rt, agentId: 'solo' }, 'mcp__remote__whoami', {})).output, 'client dyn-1 scope mcp:tools mcp:read');
  const rec1 = record(rt);
  assert.ok(mcp.seen.filter((s) => s.status === 200).length >= 4);
  assert.ok(mcp.seen.filter((s) => s.status === 200).every((s) => s.auth === `Bearer ${rec1.tokens.accessToken}`));

  // proactive refresh shortly before expiry: no 401 needed
  const before401 = mcp.count401();
  rt.opts.secrets.set(oauthSecretId('remote'), JSON.stringify({ ...rec1, tokens: { ...rec1.tokens, expiresAt: Date.now() + 5000 } }));
  assert.equal((await executeTool({ rt, agentId: 'solo' }, 'mcp__remote__whoami', {})).ok, true);
  assert.equal(as.refreshGrants(), 1);
  assert.equal(mcp.count401(), before401, 'refreshed before sending');
  const rec2 = record(rt);
  assert.notEqual(rec2.tokens.accessToken, rec1.tokens.accessToken);
  assert.notEqual(rec2.tokens.refreshToken, rec1.tokens.refreshToken, 'rotated refresh token kept');
  assert.equal(as.calls('/token').at(-1)!.params.resource, mcp.url, 'resource on refresh too');

  // server-side expiry: one 401 → one refresh → one retry
  as.expireAccessTokens();
  assert.equal((await executeTool({ rt, agentId: 'solo' }, 'mcp__remote__whoami', {})).ok, true);
  assert.equal(mcp.count401(), before401 + 1);
  assert.equal(as.refreshGrants(), 2);
  const rec3 = record(rt);

  // tokens and the client registration stay in the SecretStore only
  const secrets = [rec1, rec2, rec3].flatMap((r) => [r.tokens.accessToken, r.tokens.refreshToken]);
  assert.deepEqual(filesContaining(rt.opts.dataDir, secrets), [], 'no token in mcp.json, audit or any data file');
  const stateJson = JSON.stringify(rt.mcp.list());
  assert.ok(!secrets.some((s) => stateJson.includes(s)), 'no token in server state or logs');
  assert.ok(readAudit(rt).some((a) => a.action === 'mcp_oauth_login' && a.detail.ok === true && a.detail.dynamicClient === true && a.detail.issuer === as.issuer));

  // refresh token revoked as well → needs_auth; still no browser without the user
  as.revokeAll();
  const failed = await executeTool({ rt, agentId: 'solo' }, 'mcp__remote__whoami', {});
  assert.equal(failed.ok, false);
  assert.match(failed.output, /登录/);
  await waitFor(() => st.status === 'needs_auth', 5000, 'needs_auth after revocation');
  assert.equal(st.auth?.loggedIn, false);
  assert.equal(record(rt).tokens, undefined, 'dead tokens dropped');
  assert.equal(browser.opened.length, 1);

  // the user logs in again: the dynamic client (and its loopback port) is reused
  await rt.mcp.login('remote');
  assert.equal(st.status, 'ok', st.error);
  assert.equal(as.calls('/register').length, 1, 'DCR client reused');
  assert.equal(new URL(new URL(browser.opened[1]).searchParams.get('redirect_uri')!).port, redirect.port);

  // logout: SecretStore entry gone, token revoked at the AS, server back to needs_auth
  await rt.mcp.logout('remote');
  assert.equal(rt.opts.secrets.get(oauthSecretId('remote')), null);
  assert.equal(as.calls('/revoke').length, 1);
  assert.equal(st.status, 'needs_auth');
  assert.equal(st.auth?.loggedIn, false);
  const audit = readAudit(rt);
  assert.ok(audit.some((a) => a.action === 'mcp_oauth_logout' && a.detail.server === 'remote' && a.detail.revoked === true));
  assert.ok(!JSON.stringify(audit).match(/at-[0-9a-f]{24}|rt-[0-9a-f]{24}/), 'audit never carries token values');
  assert.deepEqual(filesContaining(rt.opts.dataDir, secrets), []);
  rt.dispose();
  await mcp.close();
  await as.close();
});

test('OAuth: pre-registered client (secret moved to the SecretStore, Basic auth), discovery fallbacks (root resource metadata, OIDC with issuer path); auth "none" keeps 401 an error', async () => {
  const as = await fakeAuthServer({ issuerPath: '/tenant', oidcOnly: true, dcr: false, staticClients: { 'edict-static': 'cs-literal-secret-123' } });
  const mcp = await protectedMcp(as, { prm: 'root' });
  const rt = makeRuntime(NO_LLM);
  rt.mcp.loginTimeoutMs = 10000;
  const browser = fakeBrowser(rt);
  rt.mcp.load(false);
  const saved = rt.mcp.saveConfig(JSON.stringify({ mcpServers: { remote: { url: mcp.url, auth: { type: 'oauth', clientId: 'edict-static', clientSecret: 'cs-literal-secret-123', scopes: ['mcp:tools'] } } } }));
  assert.deepEqual(saved.moved, ['remote.auth.clientSecret']);
  const onDisk = fs.readFileSync(rt.mcp.configPath, 'utf8');
  assert.ok(!onDisk.includes('cs-literal-secret-123') && onDisk.includes('${secret:remote/auth/clientSecret}'));
  await waitFor(() => rt.mcp.states.get('remote')?.status === 'needs_auth', 10000, 'needs_auth');
  await rt.mcp.login('remote');
  const st = rt.mcp.states.get('remote')!;
  assert.equal(st.status, 'ok', st.error);
  assert.equal(st.auth?.dynamicClient, false);
  // resource metadata: path-aware document missing → root document
  assert.deepEqual(mcp.gets, ['/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-protected-resource']);
  // issuer with a path: RFC 8414 and OIDC path insertion miss, OIDC path appending hits
  assert.deepEqual(as.log.filter((l) => l.method === 'GET' && l.path.includes('.well-known')).map((l) => l.path), ['/.well-known/oauth-authorization-server/tenant', '/.well-known/openid-configuration/tenant', '/tenant/.well-known/openid-configuration']);
  assert.equal(as.log.filter((l) => l.path.endsWith('/register')).length, 0, 'no DCR with a configured client id');
  const q = new URL(browser.opened[0]).searchParams;
  assert.equal(q.get('client_id'), 'edict-static');
  assert.equal(q.get('scope'), 'mcp:tools', 'configured scopes win');
  const tok = as.calls('/token')[0];
  assert.equal(tok.auth, `Basic ${Buffer.from('edict-static:cs-literal-secret-123').toString('base64')}`);
  assert.equal(tok.params.client_secret, undefined);
  assert.equal((await executeTool({ rt, agentId: 'solo' }, 'mcp__remote__whoami', {})).output, 'client edict-static scope mcp:tools');
  const rec = record(rt);
  assert.equal(rec.client, undefined, 'a configured client is not copied into the record');
  assert.deepEqual(filesContaining(rt.opts.dataDir, ['cs-literal-secret-123', rec.tokens.accessToken, rec.tokens.refreshToken]), []);
  assert.ok(!JSON.stringify(rt.mcp.list()).includes('cs-literal-secret-123'));

  // auth "none": a 401 is just an error, and login is refused
  rt.mcp.saveConfig(JSON.stringify({ mcpServers: { remote: { url: mcp.url, auth: { type: 'none' } } } }));
  await waitFor(() => rt.mcp.states.get('remote')?.status === 'error', 10000, 'error with auth none');
  assert.match(rt.mcp.states.get('remote')!.error!, /401/);
  assert.equal(rt.mcp.states.get('remote')!.auth, undefined);
  await assert.rejects(rt.mcp.login('remote'), /未启用 OAuth/);
  // removing the server drops its OAuth record
  rt.mcp.saveConfig(JSON.stringify({ mcpServers: {} }));
  assert.equal(rt.opts.secrets.get(oauthSecretId('remote')), null);
  rt.dispose();
  await mcp.close();
  await as.close();
});

test('OAuth: a callback with the wrong state is rejected — no code exchange, no tokens stored, callback server closed', async () => {
  const as = await fakeAuthServer();
  const mcp = await protectedMcp(as, { prm: 'header' });
  const rt = makeRuntime(NO_LLM);
  rt.mcp.loginTimeoutMs = 10000;
  const browser = fakeBrowser(rt, { tamper: (u) => u.searchParams.set('state', 'forged-state') });
  rt.mcp.load(false);
  rt.mcp.saveConfig(JSON.stringify({ mcpServers: { remote: { url: mcp.url } } }));
  await waitFor(() => rt.mcp.states.get('remote')?.status === 'needs_auth', 10000, 'needs_auth');
  await assert.rejects(rt.mcp.login('remote'), /state 不匹配/);
  await waitFor(() => browser.pages.length === 1, 5000, 'callback page');
  assert.equal(browser.pages[0].status, 400);
  assert.match(browser.pages[0].html, /授权失败[\s\S]*state 不匹配/);
  assert.equal(as.calls('/token').length, 0, 'code never exchanged');
  assert.equal(record(rt)?.tokens, undefined, 'no tokens stored');
  assert.ok(await portClosed(Number(new URL(browser.pages[0].url).port)), 'callback server closed');
  const st = rt.mcp.states.get('remote')!;
  assert.equal(st.status, 'needs_auth');
  assert.equal(st.auth?.loggingIn, undefined);
  assert.ok(readAudit(rt).some((a) => a.action === 'mcp_oauth_login' && a.detail.ok === false && /state/.test(a.detail.error)));
  // without a browser hook the login is refused up front
  rt.opts.openExternal = undefined;
  await assert.rejects(rt.mcp.login('remote'), /无法打开浏览器/);
  rt.dispose();
  await mcp.close();
  await as.close();
});
