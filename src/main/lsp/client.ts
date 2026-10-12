// Minimal LSP client (Language Server Protocol 3.17), written from the public spec:
// JSON-RPC 2.0 over the child's stdin/stdout with `Content-Length` framing, stderr = logs.
// Only what agents and the editor need: lifecycle, full-text document sync, navigation queries,
// push + pull diagnostics; answers the server→client requests servers commonly block on.
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

type Json = Record<string, unknown>;
export interface LspMessage { jsonrpc: '2.0'; id?: number | string | null; method?: string; params?: unknown; result?: unknown; error?: { code: number; message: string; data?: unknown } }
export interface LspLogEntry { at: number; level: 'error' | 'warn' | 'info' | 'log' | 'stderr'; text: string }

export interface LspRange { start: { line: number; character: number }; end: { line: number; character: number } }
export interface LspRawDiagnostic { range: LspRange; severity?: number; code?: string | number | { value: string | number }; source?: string; message: string; tags?: number[] }

export class LspResponseError extends Error {
  constructor(public code: number, message: string, public method: string) {
    super(`LSP 错误 ${code}（${method}）：${message}`);
    this.name = 'LspResponseError';
  }
}

export const LSP_ERR = { MethodNotFound: -32601, RequestCancelled: -32800, ContentModified: -32801 } as const;

// ───────────────────────── framing ─────────────────────────
export function encodeMessage(m: LspMessage): Buffer {
  const body = Buffer.from(JSON.stringify(m), 'utf8');
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]);
}

/** Incremental decoder: feed raw stdout chunks, get whole messages. Content-Length counts UTF-8 bytes. */
export class MessageReader {
  private buf: Buffer = Buffer.alloc(0);
  constructor(private onMessage: (m: LspMessage) => void, private onJunk: (text: string) => void = () => undefined) {}

  push(chunk: Buffer | string) {
    const b = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    this.buf = this.buf.length ? Buffer.concat([this.buf, b]) : b;
    while (this.buf.length) {
      const sep = this.buf.indexOf('\r\n\r\n');
      if (sep < 0) {
        // no header yet; drop runaway garbage (servers that print banners to stdout)
        if (this.buf.length > 64 * 1024 && this.buf.indexOf('Content-Length') < 0) {
          this.onJunk(this.buf.subarray(0, 300).toString('utf8'));
          this.buf = Buffer.alloc(0);
        }
        return;
      }
      let head = this.buf.subarray(0, sep).toString('ascii');
      const at = head.search(/content-length\s*:/i);
      if (at < 0) {
        this.onJunk(head.slice(0, 300));
        this.buf = this.buf.subarray(sep + 4);
        continue;
      }
      if (at > 0) {
        this.onJunk(head.slice(0, at).trim().slice(0, 300));
        head = head.slice(at);
      }
      const len = Number(/content-length\s*:\s*(\d+)/i.exec(head)?.[1]);
      const start = sep + 4;
      if (!Number.isFinite(len)) {
        this.buf = this.buf.subarray(start);
        continue;
      }
      if (this.buf.length < start + len) return;
      const body = this.buf.subarray(start, start + len).toString('utf8');
      this.buf = this.buf.subarray(start + len);
      try {
        this.onMessage(JSON.parse(body));
      } catch {
        this.onJunk(`[非 JSON 消息] ${body.slice(0, 300)}`);
      }
    }
  }
}

// ───────────────────────── client ─────────────────────────
const SYMBOL_KINDS = Array.from({ length: 26 }, (_, i) => i + 1);

export function clientCapabilities(): Json {
  return {
    general: { positionEncodings: ['utf-16'] },
    textDocument: {
      synchronization: { dynamicRegistration: false, didSave: true, willSave: false, willSaveWaitUntil: false },
      definition: { dynamicRegistration: false, linkSupport: true },
      typeDefinition: { dynamicRegistration: false, linkSupport: true },
      implementation: { dynamicRegistration: false, linkSupport: true },
      references: { dynamicRegistration: false },
      hover: { dynamicRegistration: false, contentFormat: ['markdown', 'plaintext'] },
      documentSymbol: { dynamicRegistration: false, hierarchicalDocumentSymbolSupport: true, symbolKind: { valueSet: SYMBOL_KINDS } },
      publishDiagnostics: { relatedInformation: false, versionSupport: true, tagSupport: { valueSet: [1, 2] }, codeDescriptionSupport: true },
      diagnostic: { dynamicRegistration: false, relatedDocumentSupport: false },
    },
    workspace: {
      workspaceFolders: true,
      configuration: true,
      didChangeConfiguration: { dynamicRegistration: false },
      symbol: { dynamicRegistration: false, symbolKind: { valueSet: SYMBOL_KINDS } },
      diagnostics: { refreshSupport: true },
    },
    window: { workDoneProgress: true, showMessage: {}, showDocument: { support: false } },
  };
}

export interface LspClientOptions {
  command: string;
  args: string[];
  /** Workspace folder (also the process cwd). */
  rootPath: string;
  env: NodeJS.ProcessEnv;
  initializationOptions?: unknown;
  /** Answers for workspace/configuration (dotted section → value). */
  settings?: Record<string, unknown>;
  requestTimeoutMs?: number;
  clientVersion?: string;
  maxLogs?: number;
}

type Pending = { resolve: (r: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout; method: string };

export class LspClient {
  private child: ChildProcess | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private progress = new Set<string | number>();
  private exited: Promise<void> = Promise.resolve();
  readonly logs: LspLogEntry[] = [];
  state: 'idle' | 'starting' | 'running' | 'stopping' | 'exited' = 'idle';
  exitReason?: string;
  capabilities: Json = {};
  serverInfo?: { name: string; version?: string };
  onDiagnostics?: (p: { uri: string; version?: number; diagnostics: LspRawDiagnostic[] }) => void;
  onDiagnosticRefresh?: () => void;
  /** `expected` = we asked it to stop. */
  onExit?: (why: string, expected: boolean) => void;

  constructor(private o: LspClientOptions) {}

  get pid() {
    return this.child?.pid;
  }
  get running() {
    return this.state === 'running';
  }
  private get alive() {
    return this.state !== 'exited';
  }
  /** Server reported work-done progress that has not ended (indexing etc.). */
  get busy() {
    return this.progress.size > 0;
  }

  log(level: LspLogEntry['level'], text: string) {
    this.logs.push({ at: Date.now(), level, text: text.slice(0, 1000) });
    const max = this.o.maxLogs ?? 200;
    if (this.logs.length > max) this.logs.splice(0, this.logs.length - max);
  }

  async start(timeoutMs = 30000): Promise<Json> {
    const { command, args, rootPath, env } = this.o;
    this.state = 'starting';
    const child = spawn(command, args, { cwd: rootPath, env, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true });
    this.child = child;
    const reader = new MessageReader(
      (m) => this.handle(m),
      (t) => t && this.log('stderr', `[stdout 非协议输出] ${t}`),
    );
    child.stdout!.on('data', (d: Buffer) => reader.push(d));
    child.stderr!.setEncoding('utf8');
    child.stderr!.on('data', (d: string) => d.split('\n').filter((l) => l.trim()).forEach((l) => this.log('stderr', l.slice(0, 500))));
    child.stdin!.on('error', () => undefined);
    child.on('error', (e) => this.log('error', `进程错误：${e.message}`));
    this.exited = new Promise<void>((resolve) => {
      child.once('exit', (code, sig) => {
        const expected = this.state === 'stopping';
        this.state = 'exited';
        const why = (this.exitReason = `进程退出（code=${code ?? '-'}${sig ? ` signal=${sig}` : ''}）`);
        // let stdout/stderr drain (crash output) before reporting; don't wait on pipes held by orphaned helpers
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          this.fail(why);
          this.onExit?.(why, expected);
          resolve();
        };
        child.once('close', finish);
        setTimeout(finish, 200).unref?.();
      });
    });
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', () => resolve());
      child.once('error', (e) => {
        this.state = 'exited';
        this.exitReason = `无法启动 ${path.basename(command)}：${e.message}`;
        reject(new Error(this.exitReason));
      });
    });
    const rootUri = pathToFileURL(rootPath).href;
    const r = (await this.request(
      'initialize',
      {
        processId: process.pid,
        clientInfo: { name: 'edict', version: this.o.clientVersion ?? '0' },
        locale: 'zh-cn',
        rootPath,
        rootUri,
        workspaceFolders: [{ uri: rootUri, name: path.basename(rootPath) }],
        capabilities: clientCapabilities(),
        initializationOptions: this.o.initializationOptions,
        trace: 'off',
      },
      timeoutMs,
    )) as Json;
    if ((this.state as LspClient['state']) !== 'starting') throw new Error(`语言服务器在初始化期间退出：${this.exitReason ?? '已停止'}`);
    this.capabilities = (r?.capabilities as Json) ?? {};
    this.serverInfo = r?.serverInfo as { name: string; version?: string } | undefined;
    this.state = 'running';
    this.notify('initialized', {});
    if (this.o.settings) this.notify('workspace/didChangeConfiguration', { settings: this.o.settings });
    return r ?? {};
  }

  request<T = unknown>(method: string, params?: unknown, timeoutMs = this.o.requestTimeoutMs ?? 15000, signal?: AbortSignal): Promise<T> {
    if (!this.child || this.state === 'exited' || this.state === 'idle') return Promise.reject(new Error(`语言服务器未运行（${method}）`));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.notify('$/cancelRequest', { id });
        reject(new Error(`LSP 请求超时：${method}（${Math.round(timeoutMs / 1000)}s）`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (r: unknown) => void, reject, timer, method });
      signal?.addEventListener('abort', () => {
        if (!this.pending.has(id)) return;
        clearTimeout(timer);
        this.pending.delete(id);
        this.notify('$/cancelRequest', { id });
        reject(Object.assign(new Error('已取消'), { name: 'AbortError' }));
      });
      if (!this.write({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error(`语言服务器未运行（${method}）`));
      }
    });
  }

  notify(method: string, params?: unknown): boolean {
    return this.write({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) });
  }

  private write(m: LspMessage): boolean {
    const stdin = this.child?.stdin;
    if (!stdin?.writable || this.state === 'exited') return false;
    stdin.write(encodeMessage(m));
    return true;
  }

  private handle(m: LspMessage) {
    if (m.id !== undefined && m.id !== null && !m.method) {
      const p = typeof m.id === 'number' ? this.pending.get(m.id) : undefined;
      if (!p) return;
      clearTimeout(p.timer);
      this.pending.delete(m.id as number);
      if (m.error) p.reject(new LspResponseError(m.error.code, m.error.message, p.method));
      else p.resolve(m.result ?? null);
      return;
    }
    if (m.method && m.id !== undefined && m.id !== null) return this.answer(m);
    const params = (m.params ?? {}) as Json;
    switch (m.method) {
      case 'textDocument/publishDiagnostics':
        this.onDiagnostics?.({ uri: String(params.uri), version: typeof params.version === 'number' ? params.version : undefined, diagnostics: Array.isArray(params.diagnostics) ? (params.diagnostics as LspRawDiagnostic[]) : [] });
        return;
      case 'window/logMessage':
      case 'window/showMessage': {
        const t = Number(params.type);
        this.log(t === 1 ? 'error' : t === 2 ? 'warn' : t === 3 ? 'info' : 'log', String(params.message ?? ''));
        return;
      }
      case '$/progress': {
        const kind = (params.value as Json | undefined)?.kind;
        const token = params.token as string | number;
        if (kind === 'begin') this.progress.add(token);
        else if (kind === 'end') this.progress.delete(token);
        return;
      }
      default:
        return; // telemetry/event, $/logTrace, custom notifications
    }
  }

  /** Server → client requests. Unknown ones get MethodNotFound so the server never blocks on us. */
  private answer(m: LspMessage) {
    const reply = (result: unknown) => this.write({ jsonrpc: '2.0', id: m.id, result });
    const params = (m.params ?? {}) as Json;
    switch (m.method) {
      case 'workspace/configuration': {
        const items = Array.isArray(params.items) ? (params.items as { section?: string }[]) : [];
        return void reply(items.map((it) => lookup(this.o.settings, it.section)));
      }
      case 'workspace/workspaceFolders':
        return void reply([{ uri: pathToFileURL(this.o.rootPath).href, name: path.basename(this.o.rootPath) }]);
      case 'client/registerCapability':
      case 'client/unregisterCapability':
      case 'window/workDoneProgress/create':
      case 'window/showMessageRequest':
      case 'workspace/semanticTokens/refresh':
      case 'workspace/inlayHint/refresh':
      case 'workspace/inlineValue/refresh':
      case 'workspace/codeLens/refresh':
        return void reply(null);
      case 'workspace/diagnostic/refresh':
        reply(null);
        return void this.onDiagnosticRefresh?.();
      case 'window/showDocument':
        return void reply({ success: false });
      case 'workspace/applyEdit':
        return void reply({ applied: false, failureReason: 'Edict 的语言服务客户端只读，不接受服务器发起的编辑' });
      default:
        this.write({ jsonrpc: '2.0', id: m.id, error: { code: LSP_ERR.MethodNotFound, message: `Edict 不支持 ${m.method}` } });
    }
  }

  private fail(why: string) {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(`语言服务器连接断开：${why}`));
    }
    this.pending.clear();
    this.progress.clear();
  }

  /** Graceful stop: shutdown → exit → wait, then kill. */
  async shutdown(timeoutMs = 3000) {
    if (!this.child || this.state === 'exited') return;
    if (this.state === 'stopping') return this.waitExit(timeoutMs);
    const wasRunning = this.state === 'running';
    this.state = 'stopping';
    if (wasRunning) {
      try {
        await this.request('shutdown', undefined, timeoutMs);
      } catch {
        /* unresponsive: kill below */
      }
      this.notify('exit');
    }
    await this.waitExit(Math.min(1500, timeoutMs));
    if (this.alive) this.kill();
  }

  private waitExit(ms: number) {
    return Promise.race([this.exited, new Promise<void>((r) => setTimeout(r, ms).unref?.())]);
  }

  /** Kill the whole process group (servers like typescript-language-server spawn helpers). */
  kill() {
    const c = this.child;
    if (!c || c.exitCode !== null || c.signalCode !== null) return;
    if (this.state !== 'exited') this.state = 'stopping';
    const sig = (s: NodeJS.Signals) => {
      try {
        if (c.pid && process.platform !== 'win32') process.kill(-c.pid, s);
        else c.kill(s);
      } catch {
        try {
          c.kill(s);
        } catch {
          /* gone */
        }
      }
    };
    c.stdin?.end();
    sig('SIGTERM');
    setTimeout(() => c.exitCode === null && c.signalCode === null && sig('SIGKILL'), 2000).unref?.();
  }
}

function lookup(settings: Record<string, unknown> | undefined, section?: string): unknown {
  if (!settings) return null;
  if (!section) return settings;
  let cur: unknown = settings;
  for (const k of section.split('.')) {
    if (!cur || typeof cur !== 'object' || !(k in (cur as Json))) return null;
    cur = (cur as Json)[k];
  }
  return cur ?? null;
}
