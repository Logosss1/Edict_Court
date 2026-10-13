// 客卿 (2.1): one outside agent process spoken to over ACP on its stdio, with Edict as the client.
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { JsonRpcConnection, RpcError, type NotificationHandler, type RequestHandler } from '../acp/connection';
import { AGENT_METHODS, ErrorCode, PROTOCOL_VERSION, type ContentBlock, type InitializeResponse, type NewSessionResponse, type PromptResponse } from '../acp/protocol';
import { safeEnv } from '../services/exec';

/** The guest could not be started or would not open a session (Edict falls back to the ministry's own official). */
export class GuestStartError extends Error {
  constructor(message: string, readonly needsLogin = false) {
    super(message);
    this.name = 'GuestStartError';
  }
}

const LOGIN_RE = /auth|login|log in|sign in|api[ _-]?key|credential|unauthori[sz]ed|not logged/i;
export const looksLikeLogin = (e: unknown) => (e instanceof RpcError && e.code === ErrorCode.AuthRequired) || LOGIN_RE.test((e as Error)?.message ?? '');

export interface GuestProcessOptions {
  exe: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  onRequest?: RequestHandler;
  onNotification?: NotificationHandler;
  log?: (msg: string) => void;
}

export class GuestProcess {
  readonly child: ChildProcess;
  readonly conn: JsonRpcConnection;
  readonly exited: Promise<{ code: number | null; signal: string | null }>;
  exit: { code: number | null; signal: string | null } | null = null;
  private err = '';

  constructor(o: GuestProcessOptions) {
    // node-based agents start with `#!/usr/bin/env node`: their own folder (where npm put node too) goes first
    const env = safeEnv(o.env ?? {});
    env.PATH = [path.dirname(o.exe), ...(env.PATH ?? '').split(path.delimiter)].filter(Boolean).join(path.delimiter);
    this.child = spawn(o.exe, o.args, { cwd: o.cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    this.exited = new Promise((resolve) => {
      this.child.on('exit', (code, signal) => {
        this.exit = { code, signal };
        resolve(this.exit);
      });
      this.child.on('error', (e) => {
        this.err += `\n${e.message}`;
        this.exit = { code: null, signal: null };
        resolve(this.exit);
      });
    });
    this.child.stderr!.on('data', (d: Buffer) => {
      this.err = (this.err + d.toString()).slice(-8000);
    });
    this.conn = new JsonRpcConnection({ readable: this.child.stdout!, writable: this.child.stdin! }, { log: o.log });
    if (o.onRequest) this.conn.onRequest(o.onRequest);
    if (o.onNotification) this.conn.onNotification(o.onNotification);
    this.child.stdin!.on('error', () => {});
  }

  /** The last lines the agent wrote to stderr (for error messages). */
  stderrTail(lines = 6): string {
    return this.err.trim().split('\n').filter(Boolean).slice(-lines).join('\n');
  }

  /** `p`, unless the process exits or `ms` passes first. */
  private race<T>(p: Promise<T>, what: string, ms: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new GuestStartError(`${what}超时（${Math.round(ms / 1000)} 秒没有回应）${this.tail()}`)), ms);
      void this.exited.then((x) => {
        clearTimeout(timer);
        reject(new GuestStartError(`进程已退出（${x.signal ?? `退出码 ${x.code}`}）${this.tail()}`));
      });
      p.then(
        (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        (e) => {
          clearTimeout(timer);
          if (!this.conn.closed) return reject(e);
          // a closed pipe usually means the process died: wait a moment and say how, with its stderr
          void Promise.race([this.exited, new Promise((r) => setTimeout(r, 500))]).then(() => reject(this.exit ? new GuestStartError(`进程已退出（${this.exit.signal ?? `退出码 ${this.exit.code}`}）${this.tail()}`) : e));
        },
      );
    });
  }

  private tail() {
    const t = this.stderrTail(4);
    return t ? `：${t.slice(0, 600)}` : '';
  }

  async initialize(version: string, timeoutMs = 20_000): Promise<InitializeResponse> {
    const r = await this.race(
      this.conn.request<InitializeResponse>(AGENT_METHODS.initialize, {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
        clientInfo: { name: 'edict', title: 'Edict', version },
      }),
      '握手',
      timeoutMs,
    );
    if (!r || typeof r !== 'object' || typeof r.protocolVersion !== 'number') throw new GuestStartError('握手回应不是 ACP 格式');
    if (r.protocolVersion !== PROTOCOL_VERSION) throw new GuestStartError(`ACP 协议版本不符（对方 ${r.protocolVersion}，Edict ${PROTOCOL_VERSION}）`);
    return r;
  }

  async newSession(cwd: string, timeoutMs = 60_000): Promise<NewSessionResponse> {
    try {
      const r = await this.race(this.conn.request<NewSessionResponse>(AGENT_METHODS.sessionNew, { cwd, mcpServers: [] }), '开会话', timeoutMs);
      if (!r?.sessionId) throw new GuestStartError('开会话的回应缺少 sessionId');
      return r;
    } catch (e) {
      if (e instanceof GuestStartError) throw e;
      throw new GuestStartError((e as Error).message || '开会话失败', looksLikeLogin(e));
    }
  }

  prompt(sessionId: string, prompt: ContentBlock[]): Promise<PromptResponse> {
    return this.conn.request<PromptResponse>(AGENT_METHODS.sessionPrompt, { sessionId, prompt });
  }

  cancel(sessionId: string) {
    this.conn.notify(AGENT_METHODS.sessionCancel, { sessionId });
  }

  /** Close stdin, then stop the whole process group if it lingers. */
  async close(graceMs = 1500): Promise<void> {
    this.conn.close();
    if (this.exit) return;
    const killed = await Promise.race([this.exited.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), graceMs))]);
    if (killed) return;
    this.kill('SIGTERM');
    const gone = await Promise.race([this.exited.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 2000))]);
    if (!gone) this.kill('SIGKILL');
  }

  kill(sig: NodeJS.Signals) {
    try {
      if (this.child.pid && process.platform !== 'win32') process.kill(-this.child.pid, sig);
      else this.child.kill(sig);
    } catch {
      try {
        this.child.kill(sig);
      } catch {
        /* gone */
      }
    }
  }
}

/** Start a guest and do the ACP handshake, trying older argument spellings when the process quits at once. */
export async function startGuest(o: GuestProcessOptions & { alt?: string[][]; version: string }): Promise<{ proc: GuestProcess; init: InitializeResponse }> {
  const tries = [o.args, ...(o.alt ?? [])];
  let last: unknown;
  for (const args of tries) {
    const proc = new GuestProcess({ ...o, args });
    try {
      const init = await proc.initialize(o.version);
      return { proc, init };
    } catch (e) {
      last = e;
      await proc.close(200);
      // only a process that died during the handshake might want other arguments
      if (!proc.exit) break;
    }
  }
  throw last instanceof GuestStartError ? last : new GuestStartError((last as Error)?.message ?? '启动失败');
}
