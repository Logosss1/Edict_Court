// ACP over a Unix domain socket (`<dataDir>/acp.sock`, mode 0600). Editors reach it through the
// stdio bridge (src/acp-bridge/bridge.ts). Every new client must be approved by the user
// (confirmClient → native dialog); approval is remembered per clientInfo.name until the server stops.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { JsonRpcConnection } from './connection';
import { AcpAgent, type AcpClientInfo, type AcpHost } from './agent';

export interface AcpServerOptions {
  socketPath: string;
  host: AcpHost;
  /** Ask the user whether this editor may drive Edict. Resolve true to allow. */
  confirmClient: (info: AcpClientInfo) => Promise<boolean>;
  log?: (msg: string) => void;
  /** A connection must send `initialize` within this time (default 15 s). */
  initTimeoutMs?: number;
  maxConnections?: number; // default 8
}

/** macOS sun_path is 104 bytes including the terminator. */
export const MAX_SOCKET_PATH_BYTES = 103;

function canConnect(p: string): Promise<boolean> {
  return new Promise((resolve) => {
    const c = net.createConnection(p);
    c.once('connect', () => {
      c.destroy();
      resolve(true);
    });
    c.once('error', () => resolve(false));
  });
}

export class AcpServer {
  private server: net.Server | null = null;
  private sockets = new Set<net.Socket>();
  private approved = new Set<string>();
  private asking = new Map<string, Promise<boolean>>();
  private chain: Promise<void> = Promise.resolve();
  private readonly log: (msg: string) => void;

  constructor(readonly opts: AcpServerOptions) {
    this.log = opts.log ?? (() => {});
  }

  get socketPath() {
    return this.opts.socketPath;
  }

  get listening() {
    return !!this.server?.listening;
  }

  /** Number of open editor connections. */
  get connections() {
    return this.sockets.size;
  }

  /** Client names approved during this run (cleared when the server stops). */
  approvedClients(): string[] {
    return [...this.approved];
  }

  /** Start/stop following the opt-in setting. Calls are serialized; a failed start rejects. */
  setEnabled(on: boolean): Promise<void> {
    const p = this.chain.then(() => (on ? this.start() : this.stop()));
    this.chain = p.catch(() => {});
    return p;
  }

  async start(): Promise<void> {
    if (this.server) return;
    const p = this.opts.socketPath;
    const len = Buffer.byteLength(p);
    if (len > MAX_SOCKET_PATH_BYTES) throw new Error(`ACP 套接字路径过长（${len} 字节，上限 ${MAX_SOCKET_PATH_BYTES}）：${p}`);
    fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
    await this.removeStale(p);
    const server = net.createServer((sock) => this.accept(sock));
    server.maxConnections = this.opts.maxConnections ?? 8;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      // bind happens synchronously inside listen(): the umask makes the socket 0600 from birth
      const old = process.umask(0o177);
      try {
        server.listen(p, () => {
          server.off('error', reject);
          resolve();
        });
      } finally {
        process.umask(old);
      }
    });
    fs.chmodSync(p, 0o600);
    server.on('error', (e) => this.log(`[acp] server error: ${e.message}`));
    this.server = server;
    this.log(`[acp] listening on ${p}`);
  }

  async stop(): Promise<void> {
    const s = this.server;
    if (!s) return;
    this.server = null;
    for (const sock of this.sockets) sock.destroy();
    this.sockets.clear();
    this.approved.clear();
    await new Promise<void>((r) => s.close(() => r()));
    try {
      if (fs.lstatSync(this.opts.socketPath).isSocket()) fs.unlinkSync(this.opts.socketPath);
    } catch {
      /* already gone */
    }
    this.log('[acp] stopped');
  }

  private async removeStale(p: string) {
    let st: fs.Stats;
    try {
      st = fs.lstatSync(p);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw e;
    }
    if (!st.isSocket()) throw new Error(`${p} 已存在且不是套接字，拒绝覆盖`);
    if (await canConnect(p)) throw new Error(`ACP 套接字 ${p} 正被另一个进程使用（是否已有另一个 Edict 在运行？）`);
    fs.unlinkSync(p);
  }

  private accept(sock: net.Socket) {
    this.sockets.add(sock);
    sock.on('close', () => this.sockets.delete(sock));
    sock.on('error', (e) => this.log(`[acp] socket error: ${e.message}`));
    const conn = new JsonRpcConnection(sock, { log: this.log });
    let greeted = false;
    const timer = setTimeout(() => {
      if (greeted) return;
      this.log('[acp] client did not send initialize in time; closing');
      sock.destroy();
    }, this.opts.initTimeoutMs ?? 15_000);
    timer.unref?.();
    conn.onClose(() => {
      clearTimeout(timer);
      // give a final response (e.g. the refusal) time to flush, then make sure the socket is gone
      setTimeout(() => sock.destroy(), 1000).unref?.();
    });
    new AcpAgent(conn, {
      host: this.opts.host,
      log: this.log,
      authorize: async (info) => {
        greeted = true;
        clearTimeout(timer);
        const ok = await this.consent(info);
        this.log(`[acp] client ${info.name}${info.version ? ` ${info.version}` : ''} ${ok ? 'approved' : 'refused'}`);
        return ok && !sock.destroyed;
      },
    });
  }

  private async consent(info: AcpClientInfo): Promise<boolean> {
    const key = info.name;
    if (this.approved.has(key)) return true;
    let p = this.asking.get(key);
    if (!p) {
      // concurrent connections from the same editor share one dialog
      p = Promise.resolve()
        .then(() => this.opts.confirmClient(info))
        .then((v) => v === true, () => false)
        .finally(() => this.asking.delete(key));
      this.asking.set(key, p);
    }
    const ok = await p;
    if (ok && this.server) this.approved.add(key);
    return ok && !!this.server;
  }
}
