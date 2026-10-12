// Minimal MCP client (Model Context Protocol, JSON-RPC 2.0), written from the public spec:
//   · stdio            — newline-delimited JSON on the child's stdin/stdout, stderr = logs
//   · Streamable HTTP  — POST per message; response is JSON or an SSE stream; Mcp-Session-Id header
//   · HTTP+SSE (legacy)— GET event stream announces an `endpoint`; POST messages there; replies arrive on the stream
// Features: initialize, tools (list/call), resources (list/templates/read), prompts (list/get), list_changed
// notifications; answers ping and roots/list. HTTP transports take an optional bearer provider (OAuth, see oauth.ts).
import { spawn, type ChildProcess } from 'node:child_process';
import type { FetchLike } from '../llm/types';

export const MCP_PROTOCOL_VERSION = '2025-06-18';

type Json = Record<string, unknown>;
export interface JsonRpcMessage { jsonrpc: '2.0'; id?: number | string | null; method?: string; params?: Json; result?: Json; error?: { code: number; message: string; data?: unknown } }

export interface Transport {
  start(onMessage: (m: JsonRpcMessage) => void, onClose: (why: string) => void): Promise<void>;
  send(m: JsonRpcMessage): Promise<void>;
  close(): void;
  /** Streamable HTTP needs to know the negotiated version for its header. */
  setProtocolVersion?(v: string): void;
}

export type Logger = (level: 'info' | 'error' | 'stderr', text: string) => void;

/** Bearer provider for the HTTP transports (MCP authorization; implemented by McpOAuth). */
export interface HttpAuth {
  /** `Bearer …` for the next request, or null when not logged in. May refresh a token that is about to expire. */
  header(): Promise<string | null>;
  /** HTTP 401 seen. Resolves true when the request should be retried once with a new token (never when `retried`). */
  unauthorized(wwwAuthenticate: string | null, sent: string | null, retried: boolean): Promise<boolean>;
}

/** fetch with the bearer attached (replacing any static Authorization header); one retry after a 401 when a fresh token is available. */
async function authedFetch(fetch: FetchLike, url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }, auth?: HttpAuth): Promise<Response> {
  for (let retried = false; ; retried = true) {
    const headers = { ...init.headers };
    const sent = auth ? await auth.header() : null;
    if (sent) {
      for (const k of Object.keys(headers)) if (k.toLowerCase() === 'authorization') delete headers[k];
      headers.authorization = sent;
    }
    const res = await fetch(url, { ...init, headers });
    if (res.status !== 401 || !auth) return res;
    if (!(await auth.unauthorized(res.headers.get('www-authenticate'), sent, retried)) || retried) return res;
    await res.text().catch(() => undefined);
  }
}

// ───────────────────────── stdio ─────────────────────────
export class StdioTransport implements Transport {
  private child: ChildProcess | null = null;
  private buf = '';
  constructor(private o: { command: string; args: string[]; env: NodeJS.ProcessEnv; cwd: string; shell?: string; log: Logger }) {}

  async start(onMessage: (m: JsonRpcMessage) => void, onClose: (why: string) => void) {
    const { command, args, env, cwd, shell, log } = this.o;
    // Launch through the login shell so a GUI-launched app still finds npx / uvx / node on the user's PATH.
    const child = shell && !command.includes('/') ? spawn(shell, ['-lc', 'exec "$0" "$@"', command, ...args], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] }) : spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (d: string) => {
      this.buf += d;
      let i: number;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i).trim();
        this.buf = this.buf.slice(i + 1);
        if (!line) continue;
        try {
          onMessage(JSON.parse(line));
        } catch {
          log('stderr', `[stdout 非 JSON] ${line.slice(0, 300)}`);
        }
      }
    });
    child.stderr!.setEncoding('utf8');
    child.stderr!.on('data', (d: string) => d.split('\n').filter(Boolean).forEach((l) => log('stderr', l.slice(0, 500))));
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', () => resolve());
      child.once('error', (e) => reject(new Error(`无法启动 ${command}：${e.message}`)));
    });
    child.once('exit', (code, sig) => onClose(`进程退出（code=${code ?? '-'}${sig ? ` signal=${sig}` : ''}）`));
    child.stdin!.on('error', () => undefined);
  }

  async send(m: JsonRpcMessage) {
    if (!this.child?.stdin?.writable) throw new Error('MCP 进程未运行');
    this.child.stdin.write(JSON.stringify(m) + '\n');
  }

  close() {
    const c = this.child;
    this.child = null;
    if (!c || c.exitCode !== null) return;
    try {
      c.stdin?.end();
      c.kill('SIGTERM');
      setTimeout(() => c.exitCode === null && c.kill('SIGKILL'), 2000).unref?.();
    } catch {
      /* already gone */
    }
  }
}

// ───────────────────────── SSE parsing ─────────────────────────
export async function* sseEvents(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<{ event: string; data: string }> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  try {
    while (true) {
      if (signal?.aborted) return;
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true }).replace(/\r\n/g, '\n');
      let i: number;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        let event = 'message';
        const data: string[] = [];
        for (const line of block.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
        }
        if (data.length) yield { event, data: data.join('\n') };
      }
    }
  } finally {
    reader.releaseLock?.();
  }
}

// ───────────────────────── Streamable HTTP ─────────────────────────
export class StreamableHttpTransport implements Transport {
  private session: string | null = null;
  private version: string | null = null;
  private onMessage: (m: JsonRpcMessage) => void = () => undefined;
  private ctrl = new AbortController();
  constructor(private o: { url: string; headers: Record<string, string>; fetch: FetchLike; log: Logger; auth?: HttpAuth }) {}

  async start(onMessage: (m: JsonRpcMessage) => void) {
    this.onMessage = onMessage;
  }
  setProtocolVersion(v: string) {
    this.version = v;
  }

  async send(m: JsonRpcMessage) {
    const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...this.o.headers };
    if (this.session) headers['mcp-session-id'] = this.session;
    if (this.version) headers['mcp-protocol-version'] = this.version;
    const res = await authedFetch(this.o.fetch, this.o.url, { method: 'POST', headers, body: JSON.stringify(m), signal: this.ctrl.signal }, this.o.auth);
    const sid = res.headers.get('mcp-session-id');
    if (sid) this.session = sid;
    if (res.status === 202 || res.status === 204) return;
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new McpHttpError(res.status, t.slice(0, 500), res.headers.get('www-authenticate'));
    }
    const ct = res.headers.get('content-type') ?? '';
    if (ct.includes('text/event-stream') && res.body) {
      // read the stream in the background; responses to this request arrive on it
      void (async () => {
        try {
          for await (const ev of sseEvents(res.body!, this.ctrl.signal)) {
            try {
              this.onMessage(JSON.parse(ev.data));
            } catch {
              this.o.log('error', `SSE 数据不是 JSON：${ev.data.slice(0, 200)}`);
            }
          }
        } catch (e) {
          if (!this.ctrl.signal.aborted) this.o.log('error', `SSE 流中断：${(e as Error).message}`);
        }
      })();
      return;
    }
    const text = await res.text();
    if (!text.trim()) return;
    const j = JSON.parse(text);
    for (const msg of Array.isArray(j) ? j : [j]) this.onMessage(msg);
  }

  close() {
    this.ctrl.abort();
    if (this.session) {
      const headers: Record<string, string> = { 'mcp-session-id': this.session, ...this.o.headers };
      void (async () => {
        const auth = await this.o.auth?.header().catch(() => null);
        if (auth) {
          for (const k of Object.keys(headers)) if (k.toLowerCase() === 'authorization') delete headers[k];
          headers.authorization = auth;
        }
        await this.o.fetch(this.o.url, { method: 'DELETE', headers });
      })().catch(() => undefined);
    }
  }
}

export class McpHttpError extends Error {
  readonly wwwAuthenticate?: string;
  constructor(public status: number, body: string, wwwAuthenticate?: string | null) {
    super(`HTTP ${status}${body ? `：${body}` : ''}`);
    if (wwwAuthenticate) this.wwwAuthenticate = wwwAuthenticate;
  }
}

// ───────────────────────── legacy HTTP+SSE ─────────────────────────
export class SseTransport implements Transport {
  private endpoint: string | null = null;
  private ctrl = new AbortController();
  constructor(private o: { url: string; headers: Record<string, string>; fetch: FetchLike; log: Logger; auth?: HttpAuth }) {}

  async start(onMessage: (m: JsonRpcMessage) => void, onClose: (why: string) => void) {
    const res = await authedFetch(this.o.fetch, this.o.url, { method: 'GET', headers: { accept: 'text/event-stream', ...this.o.headers }, signal: this.ctrl.signal }, this.o.auth);
    if (!res.ok || !res.body) throw new McpHttpError(res.status, await res.text().catch(() => ''), res.headers.get('www-authenticate'));
    let gotEndpoint: () => void = () => undefined;
    const ready = new Promise<void>((r) => (gotEndpoint = r));
    void (async () => {
      try {
        for await (const ev of sseEvents(res.body!, this.ctrl.signal)) {
          if (ev.event === 'endpoint') {
            this.endpoint = new URL(ev.data.trim(), this.o.url).toString();
            gotEndpoint();
          } else {
            try {
              onMessage(JSON.parse(ev.data));
            } catch {
              this.o.log('error', `SSE 数据不是 JSON：${ev.data.slice(0, 200)}`);
            }
          }
        }
        onClose('SSE 连接已关闭');
      } catch (e) {
        if (!this.ctrl.signal.aborted) onClose(`SSE 连接中断：${(e as Error).message}`);
      }
    })();
    await Promise.race([ready, new Promise((_, rej) => setTimeout(() => rej(new Error('SSE 服务未返回 endpoint 事件')), 10000))]);
  }

  async send(m: JsonRpcMessage) {
    if (!this.endpoint) throw new Error('SSE endpoint 未就绪');
    const res = await authedFetch(this.o.fetch, this.endpoint, { method: 'POST', headers: { 'content-type': 'application/json', ...this.o.headers }, body: JSON.stringify(m), signal: this.ctrl.signal }, this.o.auth);
    if (!res.ok && res.status !== 202) throw new McpHttpError(res.status, await res.text().catch(() => ''), res.headers.get('www-authenticate'));
  }

  close() {
    this.ctrl.abort();
  }
}

// ───────────────────────── client ─────────────────────────
export interface McpTool { name: string; title?: string; description?: string; inputSchema?: Json; annotations?: Json }
export interface McpContentBlock { type: string; text?: string; data?: string; mimeType?: string; resource?: { uri?: string; text?: string; blob?: string; mimeType?: string }; uri?: string; name?: string }
export interface CallResult { content: McpContentBlock[]; isError?: boolean; structuredContent?: unknown }
export interface McpResource { uri: string; name: string; title?: string; description?: string; mimeType?: string; size?: number; annotations?: Json }
export interface McpResourceTemplate { uriTemplate: string; name: string; title?: string; description?: string; mimeType?: string }
export interface McpResourceContents { uri: string; mimeType?: string; text?: string; blob?: string }
export interface McpPrompt { name: string; title?: string; description?: string; arguments?: { name: string; title?: string; description?: string; required?: boolean }[] }
export interface GetPromptResult { description?: string; messages: { role: string; content: McpContentBlock | McpContentBlock[] }[] }

export class McpClient {
  private nextId = 1;
  private pending = new Map<number | string, { resolve: (r: Json) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  closed = false;
  serverInfo?: { name: string; version?: string };
  protocolVersion?: string;
  instructions?: string;
  capabilities: Json = {};
  onToolsChanged?: () => void;
  onResourcesChanged?: () => void;
  onPromptsChanged?: () => void;
  onClose?: (why: string) => void;

  constructor(private t: Transport, private o: { roots: () => { uri: string; name: string }[]; version: string; log: Logger }) {}

  async connect(timeoutMs = 20000) {
    await this.t.start((m) => this.handle(m), (why) => this.fail(why));
    const r = await this.request('initialize', { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: { roots: { listChanged: true } }, clientInfo: { name: 'edict-for-mac', title: 'Edict · 三省六部', version: this.o.version } }, timeoutMs);
    this.protocolVersion = String(r.protocolVersion ?? MCP_PROTOCOL_VERSION);
    this.serverInfo = r.serverInfo as { name: string; version?: string } | undefined;
    this.capabilities = (r.capabilities as Json) ?? {};
    this.instructions = typeof r.instructions === 'string' ? r.instructions.slice(0, 4000) : undefined;
    this.t.setProtocolVersion?.(this.protocolVersion);
    await this.notify('notifications/initialized');
  }

  /** Follows `nextCursor` (≤ 20 pages, stops on a repeated cursor). */
  private async paginate<T>(method: string, key: string): Promise<T[]> {
    const out: T[] = [];
    let cursor: string | undefined;
    const seen = new Set<string>();
    for (let page = 0; page < 20; page++) {
      const r = await this.request(method, cursor ? { cursor } : {});
      if (Array.isArray(r[key])) out.push(...(r[key] as T[]));
      cursor = typeof r.nextCursor === 'string' && r.nextCursor ? r.nextCursor : undefined;
      if (!cursor || seen.has(cursor)) break;
      seen.add(cursor);
    }
    return out;
  }

  get hasResources() {
    return !!this.capabilities.resources;
  }
  get hasPrompts() {
    return !!this.capabilities.prompts;
  }

  listTools(): Promise<McpTool[]> {
    return this.paginate<McpTool>('tools/list', 'tools');
  }

  async callTool(name: string, args: Json, timeoutMs = 120000, signal?: AbortSignal): Promise<CallResult> {
    return (await this.request('tools/call', { name, arguments: args }, timeoutMs, signal)) as unknown as CallResult;
  }

  // Resources and prompts are only requested when the server declared the capability.
  async listResources(): Promise<McpResource[]> {
    if (!this.hasResources) return [];
    return (await this.paginate<McpResource>('resources/list', 'resources')).filter((r) => r && typeof r.uri === 'string');
  }

  async listResourceTemplates(): Promise<McpResourceTemplate[]> {
    if (!this.hasResources) return [];
    return (await this.paginate<McpResourceTemplate>('resources/templates/list', 'resourceTemplates')).filter((r) => r && typeof r.uriTemplate === 'string');
  }

  async readResource(uri: string, timeoutMs = 60000, signal?: AbortSignal): Promise<{ contents: McpResourceContents[] }> {
    if (!this.hasResources) throw new Error('该 MCP 服务未提供资源（resources）');
    const r = await this.request('resources/read', { uri }, timeoutMs, signal);
    return { contents: Array.isArray(r.contents) ? (r.contents as McpResourceContents[]) : [] };
  }

  async listPrompts(): Promise<McpPrompt[]> {
    if (!this.hasPrompts) return [];
    return (await this.paginate<McpPrompt>('prompts/list', 'prompts')).filter((p) => p && typeof p.name === 'string');
  }

  async getPrompt(name: string, args: Record<string, string>, timeoutMs = 30000): Promise<GetPromptResult> {
    if (!this.hasPrompts) throw new Error('该 MCP 服务未提供提示词（prompts）');
    const r = await this.request('prompts/get', { name, arguments: args }, timeoutMs);
    return { description: typeof r.description === 'string' ? r.description : undefined, messages: Array.isArray(r.messages) ? (r.messages as GetPromptResult['messages']) : [] };
  }

  request(method: string, params: Json = {}, timeoutMs = 30000, signal?: AbortSignal): Promise<Json> {
    if (this.closed) return Promise.reject(new Error('MCP 连接已关闭'));
    const id = this.nextId++;
    return new Promise<Json>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        void this.notify('notifications/cancelled', { requestId: id, reason: 'timeout' }).catch(() => undefined);
        reject(new Error(`MCP 请求超时：${method}（${Math.round(timeoutMs / 1000)}s）`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      signal?.addEventListener('abort', () => {
        if (!this.pending.has(id)) return;
        clearTimeout(timer);
        this.pending.delete(id);
        void this.notify('notifications/cancelled', { requestId: id, reason: 'aborted' }).catch(() => undefined);
        reject(Object.assign(new Error('已取消'), { name: 'AbortError' }));
      });
      this.t.send({ jsonrpc: '2.0', id, method, params }).catch((e) => {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      });
    });
  }

  notify(method: string, params?: Json) {
    return this.t.send({ jsonrpc: '2.0', method, ...(params ? { params } : {}) });
  }

  private handle(m: JsonRpcMessage) {
    if (m.id !== undefined && m.id !== null && !m.method) {
      const p = this.pending.get(m.id);
      if (!p) return;
      clearTimeout(p.timer);
      this.pending.delete(m.id);
      if (m.error) p.reject(new Error(`MCP 错误 ${m.error.code}：${m.error.message}`));
      else p.resolve(m.result ?? {});
      return;
    }
    if (m.method && m.id !== undefined && m.id !== null) {
      // server → client request
      const reply = (result?: Json, error?: { code: number; message: string }) => this.t.send({ jsonrpc: '2.0', id: m.id, ...(error ? { error } : { result: result ?? {} }) }).catch(() => undefined);
      if (m.method === 'ping') return void reply({});
      if (m.method === 'roots/list') return void reply({ roots: this.o.roots() });
      return void reply(undefined, { code: -32601, message: `Edict 不支持 ${m.method}` });
    }
    if (m.method === 'notifications/tools/list_changed') this.onToolsChanged?.();
    else if (m.method === 'notifications/resources/list_changed') this.onResourcesChanged?.();
    else if (m.method === 'notifications/prompts/list_changed') this.onPromptsChanged?.();
    else if (m.method === 'notifications/message') {
      const p = m.params ?? {};
      this.o.log(p.level === 'error' ? 'error' : 'info', `[${String(p.logger ?? 'server')}] ${typeof p.data === 'string' ? p.data : JSON.stringify(p.data)}`.slice(0, 500));
    }
  }

  private fail(why: string) {
    if (this.closed) return;
    this.closed = true;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(`MCP 连接断开：${why}`));
    }
    this.pending.clear();
    this.onClose?.(why);
  }

  close() {
    this.closed = true;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error('MCP 连接已关闭'));
    }
    this.pending.clear();
    this.t.close();
  }
}
