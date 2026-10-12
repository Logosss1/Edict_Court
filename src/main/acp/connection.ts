// Newline-delimited JSON-RPC 2.0 over any byte stream (stdio, Unix socket, in-memory pair).
// Symmetric: both ends can send requests/notifications and answer the other side's requests.
// One JSON message per line; messages never contain raw newlines (JSON.stringify guarantees it).
import type { Duplex, Readable, Writable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { ErrorCode, type RequestId, type RpcErrorObject } from './protocol';

export class RpcError extends Error {
  constructor(
    public code: number,
    message: string,
    public data?: unknown,
  ) {
    super(message);
    this.name = 'RpcError';
  }
  static invalidParams(message: string) {
    return new RpcError(ErrorCode.InvalidParams, message);
  }
  static methodNotFound(method: string) {
    return new RpcError(ErrorCode.MethodNotFound, `Method not found: ${method}`);
  }
  static invalidRequest(message: string) {
    return new RpcError(ErrorCode.InvalidRequest, message);
  }
  static notFound(message: string) {
    return new RpcError(ErrorCode.ResourceNotFound, message);
  }
  static internal(message: string) {
    return new RpcError(ErrorCode.InternalError, message);
  }
  toJSON(): RpcErrorObject {
    return this.data === undefined ? { code: this.code, message: this.message } : { code: this.code, message: this.message, data: this.data };
  }
}

export interface RequestContext {
  id: RequestId;
  method: string;
  /** Run `fn` right after this request's response has been written (e.g. follow-up notifications). */
  after(fn: () => void): void;
}

export type RequestHandler = (method: string, params: unknown, ctx: RequestContext) => unknown;
export type NotificationHandler = (method: string, params: unknown) => void;

export interface ConnectionOptions {
  /** Max bytes of one buffered line before the peer is considered hostile (default 64 MiB). */
  maxMessageBytes?: number;
  log?: (msg: string) => void;
}

type Io = Duplex | { readable: Readable; writable: Writable };

const isId = (v: unknown): v is RequestId => v === null || typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v));

export class JsonRpcConnection {
  readonly input: Readable;
  readonly output: Writable;
  private decoder = new StringDecoder('utf8');
  private buf = '';
  private nextId = 1;
  private pending = new Map<string | number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private requestHandler: RequestHandler | null = null;
  private notificationHandler: NotificationHandler | null = null;
  private closeListeners: (() => void)[] = [];
  private _closed = false;
  private readonly maxBytes: number;
  private readonly log: (msg: string) => void;

  constructor(io: Io, opts: ConnectionOptions = {}) {
    if ('readable' in io && 'writable' in io && typeof (io as { readable: unknown }).readable === 'object') {
      this.input = (io as { readable: Readable }).readable;
      this.output = (io as { writable: Writable }).writable;
    } else {
      this.input = io as Duplex;
      this.output = io as Duplex;
    }
    this.maxBytes = opts.maxMessageBytes ?? 64 * 1024 * 1024;
    this.log = opts.log ?? (() => {});
    this.input.on('data', (chunk: Buffer | string) => this.onData(chunk));
    this.input.on('end', () => this.close());
    this.input.on('close', () => this.close());
    this.input.on('error', (e) => {
      this.log(`[acp] input error: ${(e as Error).message}`);
      this.close();
    });
    if ((this.output as unknown) !== this.input) {
      this.output.on('error', (e) => {
        this.log(`[acp] output error: ${(e as Error).message}`);
        this.close();
      });
    }
  }

  get closed() {
    return this._closed;
  }

  onRequest(h: RequestHandler) {
    this.requestHandler = h;
  }

  onNotification(h: NotificationHandler) {
    this.notificationHandler = h;
  }

  onClose(fn: () => void) {
    if (this._closed) queueMicrotask(fn);
    else this.closeListeners.push(fn);
  }

  /** Send a request to the peer and wait for its result (rejects with RpcError on an error response). */
  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (this._closed) return Promise.reject(new RpcError(ErrorCode.InternalError, 'connection closed'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method: string, params?: unknown) {
    this.write({ jsonrpc: '2.0', method, params });
  }

  close() {
    if (this._closed) return;
    this._closed = true;
    for (const p of this.pending.values()) p.reject(new RpcError(ErrorCode.InternalError, 'connection closed'));
    this.pending.clear();
    try {
      if (!this.output.writableEnded) this.output.end();
    } catch {
      /* already gone */
    }
    const ls = this.closeListeners;
    this.closeListeners = [];
    for (const fn of ls) {
      try {
        fn();
      } catch (e) {
        this.log(`[acp] close listener error: ${(e as Error).message}`);
      }
    }
  }

  private write(msg: object): boolean {
    if (this._closed || this.output.destroyed || this.output.writableEnded) return false;
    try {
      return this.output.write(JSON.stringify(msg) + '\n');
    } catch (e) {
      this.log(`[acp] write failed: ${(e as Error).message}`);
      return false;
    }
  }

  private sendError(id: RequestId, err: RpcError) {
    this.write({ jsonrpc: '2.0', id, error: err.toJSON() });
  }

  private onData(chunk: Buffer | string) {
    if (this._closed) return;
    this.buf += typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
    let nl: number;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).replace(/\r$/, '');
      this.buf = this.buf.slice(nl + 1);
      if (line.trim()) this.handleLine(line);
      if (this._closed) return;
    }
    if (Buffer.byteLength(this.buf) > this.maxBytes) {
      this.buf = '';
      this.sendError(null, new RpcError(ErrorCode.ParseError, 'Message too large'));
      this.close();
    }
  }

  private handleLine(line: string) {
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      this.sendError(null, new RpcError(ErrorCode.ParseError, 'Parse error'));
      return;
    }
    if (Array.isArray(msg)) return this.sendError(null, RpcError.invalidRequest('Batch requests are not supported'));
    const m = msg as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown; result?: unknown; error?: unknown } | null;
    if (!m || typeof m !== 'object' || m.jsonrpc !== '2.0') {
      return this.sendError(m && typeof m === 'object' && isId(m.id) ? m.id : null, RpcError.invalidRequest('Invalid Request'));
    }
    const hasId = Object.prototype.hasOwnProperty.call(m, 'id');
    if (typeof m.method === 'string') {
      if (m.params !== undefined && (m.params === null || typeof m.params !== 'object')) {
        if (hasId) this.sendError(isId(m.id) ? m.id : null, RpcError.invalidRequest('params must be an object or array'));
        return;
      }
      if (!hasId) return this.dispatchNotification(m.method, m.params);
      if (!isId(m.id)) return this.sendError(null, RpcError.invalidRequest('Invalid id'));
      return this.dispatchRequest(m.id, m.method, m.params);
    }
    if (hasId && ('result' in m || 'error' in m)) {
      const p = typeof m.id === 'string' || typeof m.id === 'number' ? this.pending.get(m.id) : undefined;
      if (!p) return this.log(`[acp] response for unknown id ${String(m.id)}`);
      this.pending.delete(m.id as string | number);
      if (m.error) {
        const e = m.error as Partial<RpcErrorObject>;
        p.reject(new RpcError(typeof e.code === 'number' ? e.code : ErrorCode.InternalError, typeof e.message === 'string' ? e.message : 'error', e.data));
      } else p.resolve(m.result);
      return;
    }
    this.sendError(hasId && isId(m.id) ? m.id : null, RpcError.invalidRequest('Invalid Request'));
  }

  private dispatchNotification(method: string, params: unknown) {
    const h = this.notificationHandler;
    if (!h) return;
    try {
      h(method, params);
    } catch (e) {
      this.log(`[acp] notification ${method} failed: ${(e as Error).message}`);
    }
  }

  private dispatchRequest(id: RequestId, method: string, params: unknown) {
    const afters: (() => void)[] = [];
    const ctx: RequestContext = { id, method, after: (fn) => afters.push(fn) };
    const runAfters = () => {
      for (const fn of afters) {
        try {
          fn();
        } catch (e) {
          this.log(`[acp] after-response hook failed: ${(e as Error).message}`);
        }
      }
    };
    const h = this.requestHandler;
    Promise.resolve()
      .then(() => {
        if (!h) throw RpcError.methodNotFound(method);
        return h(method, params, ctx);
      })
      .then(
        (result) => {
          this.write({ jsonrpc: '2.0', id, result: result === undefined ? null : result });
          runAfters();
        },
        (err: unknown) => {
          const e = err instanceof RpcError ? err : RpcError.internal((err as Error)?.message || String(err));
          if (!(err instanceof RpcError)) this.log(`[acp] ${method} failed: ${(err as Error)?.stack ?? String(err)}`);
          this.sendError(id, e);
          runAfters();
        },
      );
  }
}
