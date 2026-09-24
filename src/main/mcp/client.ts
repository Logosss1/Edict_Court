// Minimal MCP client (Model Context Protocol, JSON-RPC 2.0), written from the public spec:
//   · stdio            — newline-delimited JSON on the child's stdin/stdout, stderr = logs
//   · Streamable HTTP  — POST per message; response is JSON or an SSE stream; Mcp-Session-Id header
//   · HTTP+SSE (legacy)— GET event stream announces an `endpoint`; POST messages there; replies arrive on the stream
// Only what agents need: initialize, tools/list (paginated), tools/call; answers ping and roots/list.
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
  constructor(private o: { url: string; headers: Record<string, string>; fetch: FetchLike; log: Logger }) {}

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
    const res = await this.o.fetch(this.o.url, { method: 'POST', headers, body: JSON.stringify(m), signal: this.ctrl.signal });
    const sid = res.headers.get('mcp-session-id');
    if (sid) this.session = sid;
    if (res.status === 202 || res.status === 204) return;
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new McpHttpError(res.status, t.slice(0, 500));
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
      void this.o.fetch(this.o.url, { method: 'DELETE', headers }).catch(() => undefined);
    }
  }
}

export class McpHttpError extends Error {
  constructor(public status: number, body: string) {
    super(`HTTP ${status}${body ? `：${body}` : ''}`);
  }
}

// ───────────────────────── legacy HTTP+SSE ─────────────────────────
export class SseTransport implements Transport {
  private endpoint: string | null = null;
  private ctrl = new AbortController();
  constructor(private o: { url: string; headers: Record<string, string>; fetch: FetchLike; log: Logger }) {}

  async start(onMessage: (m: JsonRpcMessage) => void, onClose: (why: string) => void) {
    const res = await this.o.fetch(this.o.url, { method: 'GET', headers: { accept: 'text/event-stream', ...this.o.headers }, signal: this.ctrl.signal });
    if (!res.ok || !res.body) throw new McpHttpError(res.status, await res.text().catch(() => ''));
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
    const res = await this.o.fetch(this.endpoint, { method: 'POST', headers: { 'content-type': 'application/json', ...this.o.headers }, body: JSON.stringify(m), signal: this.ctrl.signal });
    if (!res.ok && res.status !== 202) throw new McpHttpError(res.status, await res.text().catch(() => ''));
  }

  close() {
    this.ctrl.abort();
  }
}

// ───────────────────────── client ─────────────────────────
export interface McpTool { name: string; title?: string; description?: string; inputSchema?: Json; annotations?: Json }
export interface CallResult { content: Array<{ type: string; text?: string; data?: string; mimeType?: string; resource?: { uri?: string; text?: string; mimeType?: string }; uri?: string; name?: string }>; isError?: boolean; structuredContent?: unknown }

export class McpClient {
  private nextId = 1;
  private pending = new Map<number | string, { resolve: (r: Json) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  closed = false;
  serverInfo?: { name: string; version?: string };
  protocolVersion?: string;
  instructions?: string;
  capabilities: Json = {};
  onToolsChanged?: () => void;
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

  async listTools(): Promise<McpTool[]> {
    const out: McpTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const r = await this.request('tools/list', cursor ? { cursor } : {});
      out.push(...((r.tools as McpTool[]) ?? []));
      cursor = r.nextCursor as string | undefined;
      if (!cursor) break;
    }
    return out;
  }

  async callTool(name: string, args: Json, timeoutMs = 120000, signal?: AbortSignal): Promise<CallResult> {
    return (await this.request('tools/call', { name, arguments: args }, timeoutMs, signal)) as unknown as CallResult;
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
