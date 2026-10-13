// LSP 管理：按需启动本机已安装的语言服务器（每个 项目根 × 服务器 一个进程），文档内容一律从磁盘同步，
// 空闲回收、崩溃退避重启；所有路径经 Workspace 边界校验，结果映射回工作区相对路径（工作区外的结果单独标注）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { safeEnv } from '../services/exec';
import type { Workspace } from '../services/workspace';
import { sleep } from '../runtime/util';
import { LSP_ERR, LspClient, LspResponseError, type LspLogEntry, type LspRange, type LspRawDiagnostic } from './client';
import { detectServer, installHint, type DetectedServer, type DetectOptions } from './detect';
import { LANGUAGE_ID_BY_EXT, LANGUAGE_ID_BY_FILENAME, LSP_SERVERS, type LspServerDef } from './registry';

type Json = Record<string, unknown>;

// ───────────────────────── config ─────────────────────────
export interface LspServerToggle {
  enabled?: boolean;
  /** Custom executable (absolute path or command name) instead of auto-detection. */
  path?: string;
  args?: string[];
}

export interface LspConfig {
  enabled: boolean;
  servers: Record<string, LspServerToggle>;
  /** Stop a server after this long without use (documents pinned by the editor keep it alive). */
  idleMs: number;
  /** didClose a document after this long without use. */
  docIdleMs: number;
  requestTimeoutMs: number;
  startTimeoutMs: number;
  /** Crashes tolerated within restartWindowMs; one more and the server is marked failed until restart(). */
  maxRestarts: number;
  restartWindowMs: number;
  /** Delay before restart #n is restartBackoffMs·2^(n-1), capped at 10 s. */
  restartBackoffMs: number;
  /** After a fresh publishDiagnostics, wait this long for follow-up publishes (syntax → semantic passes). */
  diagnosticSettleMs: number;
  maxOpenDocs: number;
  /** Run `--version` probes in status(). */
  probeVersion: boolean;
}

export const DEFAULT_LSP_CONFIG: LspConfig = {
  enabled: true,
  servers: {},
  idleMs: 10 * 60_000,
  docIdleMs: 3 * 60_000,
  requestTimeoutMs: 15_000,
  startTimeoutMs: 30_000,
  maxRestarts: 3,
  restartWindowMs: 5 * 60_000,
  restartBackoffMs: 500,
  diagnosticSettleMs: 300,
  maxOpenDocs: 64,
  probeVersion: true,
};

function mergeConfig(a: LspConfig, b: Partial<LspConfig> = {}): LspConfig {
  const servers = { ...a.servers };
  for (const [id, t] of Object.entries(b.servers ?? {})) servers[id] = { ...servers[id], ...t };
  return { ...a, ...b, servers };
}

export function loadLspConfig(file: string): Partial<LspConfig> {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return j && typeof j === 'object' ? (j as Partial<LspConfig>) : {};
  } catch {
    return {};
  }
}

export function saveLspConfig(file: string, cfg: LspConfig) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ enabled: cfg.enabled, servers: cfg.servers, idleMs: cfg.idleMs }, null, 2));
}

// ───────────────────────── results ─────────────────────────
/** 1-based. `path` is workspace-relative, or absolute / a raw URI when `external`. */
export interface LspLocation { path: string; line: number; column: number; endLine: number; endColumn: number; external: boolean }
export type LspSeverity = 'error' | 'warning' | 'info' | 'hint';
/** 1-based, end exclusive — maps 1:1 onto Monaco markers. */
export interface LspDiagnostic { line: number; column: number; endLine: number; endColumn: number; severity: LspSeverity; message: string; source?: string; code?: string; unnecessary?: boolean; deprecated?: boolean }
export interface LspDiagnosticsResult { path: string; server: string; serverName: string; diagnostics: LspDiagnostic[]; fresh: boolean; mode: 'push' | 'pull' }
export interface LspLocationsResult { server: string; serverName: string; locations: LspLocation[] }
export interface LspHoverResult { server: string; serverName: string; text: string }
export interface LspSymbol { name: string; kind: number; kindName: string; detail?: string; container?: string; depth: number; location: LspLocation; server?: string }
export interface LspSymbolsResult { server: string; serverName: string; path: string; symbols: LspSymbol[]; truncated: boolean }
export interface LspWorkspaceSymbolsResult { servers: { id: string; name: string }[]; symbols: LspSymbol[]; truncated: boolean; errors: string[] }
export interface LspDiagnosticsEvent { path: string; server: string; diagnostics: LspDiagnostic[] }

export type LspInstanceState = 'starting' | 'running' | 'stopped' | 'crashed' | 'failed';
export interface LspInstanceStatus { root: string; state: LspInstanceState; pid?: number; openDocs: number; startedAt?: number; serverInfo?: { name: string; version?: string }; lastError?: string; crashes: number; busy: boolean }
export interface LspServerStatus {
  id: string; name: string; languages: string[]; extensions: string[];
  enabled: boolean; installed: boolean; path?: string; args?: string[]; version?: string; note?: string;
  running: boolean; instances: LspInstanceStatus[]; lastError?: string; installHint: string; homepage: string;
  /** The emperor's own executable (+ args) instead of auto-detection, when set. */
  custom?: { path: string; args?: string[] };
}
export interface LspStatus { enabled: boolean; servers: LspServerStatus[] }

export type LspUnavailableReason = 'disabled' | 'unsupported' | 'missing' | 'failed';
export interface LspCandidate { id: string; name: string; hint: string; homepage: string; note?: string }

/** No usable server for a file/language. `candidates` carry install hints for the UI and the agent tool. */
export class LspUnavailableError extends Error {
  constructor(readonly reason: LspUnavailableReason, readonly language: string, readonly candidates: LspCandidate[], message: string, readonly detail?: string) {
    super(message);
    this.name = 'LspUnavailableError';
  }
}

export const SYMBOL_KIND_NAMES: Record<number, string> = {
  1: '文件', 2: '模块', 3: '命名空间', 4: '包', 5: '类', 6: '方法', 7: '属性', 8: '字段', 9: '构造函数', 10: '枚举', 11: '接口', 12: '函数', 13: '变量',
  14: '常量', 15: '字符串', 16: '数字', 17: '布尔', 18: '数组', 19: '对象', 20: '键', 21: '空值', 22: '枚举成员', 23: '结构体', 24: '事件', 25: '运算符', 26: '类型参数',
};

// ───────────────────────── internals ─────────────────────────
interface Doc { abs: string; uri: string; languageId: string; version: number; text: string; mtimeMs: number; size: number; lastUsed: number; changedSeq: number }
interface DiagEntry { version?: number; items: LspRawDiagnostic[]; seq: number; n: number }

class Instance {
  client: LspClient | null = null;
  /** Last client (kept after exit for logs). */
  logClient: LspClient | null = null;
  starting: Promise<LspClient> | null = null;
  docs = new Map<string, Doc>();
  diags = new Map<string, DiagEntry>();
  pullIds = new Map<string, string>();
  /** Documents the editor keeps open (survive idle close and restarts). */
  pins = new Set<string>();
  changeSeq = 0;
  publishSeq = 0;
  lastUsed = Date.now();
  crashes: number[] = [];
  lastError?: string;
  failed = false;
  startedAt?: number;
  private lock: Promise<unknown> = Promise.resolve();
  constructor(readonly key: string, readonly def: LspServerDef, readonly root: string, readonly wsRoot: string) {}

  /** Serialize document sync so concurrent ops never double-open or reorder versions. */
  serial<T>(fn: () => Promise<T> | T): Promise<T> {
    const run = this.lock.then(fn, fn);
    this.lock = run.catch(() => undefined);
    return run;
  }
}

export interface LspManagerOptions {
  /** The current workspace (a getter follows workspace switches; servers of other roots are stopped). */
  workspace: Workspace | null | (() => Workspace | null);
  config?: Partial<LspConfig>;
  /** Server table (tests inject a fake server). */
  registry?: LspServerDef[];
  detect?: Pick<DetectOptions, 'env' | 'home' | 'platform' | 'versionTimeoutMs'>;
  clientVersion?: string;
  /** Every publish / pull for a file inside the workspace (editor markers). */
  onDiagnostics?: (e: LspDiagnosticsEvent) => void;
  /** Server started / stopped / crashed / config changed. */
  onStatusChange?: () => void;
}

const isInside = (rel: string) => rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);

export class LspManager {
  config: LspConfig;
  private registry: LspServerDef[];
  private instances = new Map<string, Instance>();
  private timer: NodeJS.Timeout | null = null;
  private realRoots = new Map<string, string>();
  private disposed = false;

  constructor(private o: LspManagerOptions) {
    this.config = mergeConfig(DEFAULT_LSP_CONFIG, o.config);
    this.registry = o.registry ?? LSP_SERVERS;
  }

  // ── public operations (1-based line/column; column counts UTF-16 units, i.e. JS string index + 1)

  async diagnostics(file: string, waitMs = 3000): Promise<LspDiagnosticsResult> {
    return this.withFile(file, async ({ inst, client, doc, ws }) => {
      const base = { path: ws.rel(doc.abs), server: inst.def.id, serverName: inst.def.name };
      const dp = client.capabilities.diagnosticProvider as Json | undefined;
      if (dp) {
        const prev = inst.pullIds.get(doc.abs);
        const r = await client.request<Json | null>('textDocument/diagnostic', { textDocument: { uri: doc.uri }, ...(dp.identifier ? { identifier: dp.identifier } : {}), ...(prev ? { previousResultId: prev } : {}) }, Math.max(this.config.requestTimeoutMs, waitMs));
        const items = r?.kind === 'unchanged' ? inst.diags.get(doc.abs)?.items ?? [] : Array.isArray(r?.items) ? (r!.items as LspRawDiagnostic[]) : [];
        if (typeof r?.resultId === 'string') inst.pullIds.set(doc.abs, r.resultId);
        inst.diags.set(doc.abs, { version: doc.version, items, seq: inst.changeSeq, n: ++inst.publishSeq });
        this.emitDiagnostics(inst, doc.abs, items);
        return { ...base, diagnostics: items.map(normDiag), fresh: true, mode: 'pull' as const };
      }
      const fresh = waitMs > 0 ? await this.waitPush(inst, doc, waitMs) : this.softFresh(inst, doc);
      return { ...base, diagnostics: (inst.diags.get(doc.abs)?.items ?? []).map(normDiag), fresh, mode: 'push' as const };
    });
  }

  definition(file: string, line: number, column: number): Promise<LspLocationsResult> {
    return this.locate('textDocument/definition', 'definitionProvider', '跳转定义', file, line, column);
  }

  references(file: string, line: number, column: number): Promise<LspLocationsResult> {
    return this.locate('textDocument/references', 'referencesProvider', '查找引用', file, line, column, { context: { includeDeclaration: true } });
  }

  hover(file: string, line: number, column: number): Promise<LspHoverResult> {
    return this.withFile(file, async ({ inst, client, doc }) => {
      requireCap(inst, client, 'hoverProvider', '悬停信息');
      const r = await client.request<Json | null>('textDocument/hover', { textDocument: { uri: doc.uri }, position: toPosition(doc.text, line, column) });
      return { server: inst.def.id, serverName: inst.def.name, text: hoverText(r?.contents).trim() };
    });
  }

  documentSymbols(file: string): Promise<LspSymbolsResult> {
    return this.withFile(file, async ({ inst, client, doc, ws }) => {
      requireCap(inst, client, 'documentSymbolProvider', '文件符号');
      const r = await client.request<unknown[] | null>('textDocument/documentSymbol', { textDocument: { uri: doc.uri } });
      const { symbols, truncated } = this.flattenSymbols(Array.isArray(r) ? r : [], ws, doc.uri, 2000);
      return { server: inst.def.id, serverName: inst.def.name, path: ws.rel(doc.abs), symbols, truncated };
    });
  }

  /** Query running servers of this workspace (or the one for `languageHint`: id / languageId / name / extension). */
  async workspaceSymbols(query: string, languageHint?: string): Promise<LspWorkspaceSymbolsResult> {
    const ws = this.ws();
    let targets: Instance[];
    if (languageHint) {
      const h = languageHint.trim().toLowerCase();
      const ext = h.startsWith('.') ? h : `.${h}`;
      const defs = this.registry.filter((d) => d.id === h || d.languageIds.includes(h) || d.languages.some((l) => l.toLowerCase() === h) || d.extensions.includes(ext));
      const { def } = await this.pickFrom(defs, languageHint);
      const rep = this.findFile(ws, (abs) => this.defsFor(abs).includes(def));
      if (!rep) throw new LspUnavailableError('unsupported', languageHint, [], `工作区中没有 ${def.languages.join(' / ')} 源文件`);
      targets = [await this.prepare(ws, rep, def)];
    } else {
      targets = [...this.instances.values()].filter((i) => i.wsRoot === ws.root && i.client?.running);
      if (!targets.length) {
        const rep = await this.dominantFile(ws);
        if (!rep) throw new LspUnavailableError('missing', '工作区', [], '工作区内没有已安装语言服务器的源文件，请用 language 参数指定语言');
        targets = [await this.prepare(ws, rep)];
      }
    }
    const errors: string[] = [];
    const symbols: LspSymbol[] = [];
    let truncated = false;
    await Promise.all(
      targets.map((inst) =>
        this.withInstance(inst, async (client) => {
          if (!client.capabilities.workspaceSymbolProvider) return void errors.push(`${inst.def.name} 不支持全局符号搜索`);
          const r = await client.request<unknown[] | null>('workspace/symbol', { query });
          const f = this.flattenSymbols(Array.isArray(r) ? r : [], ws, '', 500);
          truncated ||= f.truncated;
          for (const s of f.symbols) symbols.push({ ...s, depth: 0, server: inst.def.id });
        }).catch((e) => errors.push(`${inst.def.name}：${(e as Error).message}`)),
      ),
    );
    return { servers: targets.map((t) => ({ id: t.def.id, name: t.def.name })), symbols, truncated, errors };
  }

  // ── editor hooks

  /** Whether some known server handles this file type (cheap, no detection). */
  handles(file: string): boolean {
    return this.defsFor(file).length > 0;
  }

  /** Keep `file` open so pushed diagnostics keep flowing to onDiagnostics (editor tab). */
  async watchFile(file: string, waitMs = 0): Promise<LspDiagnosticsResult> {
    const ws = this.ws();
    const abs = ws.resolve(file);
    const r = await this.diagnostics(file, waitMs);
    for (const inst of this.instances.values()) if (inst.docs.has(abs)) inst.pins.add(abs);
    return r;
  }

  unwatchFile(file: string) {
    const ws = this.currentWs();
    if (!ws) return;
    let abs: string;
    try {
      abs = ws.resolve(file);
    } catch {
      return;
    }
    for (const inst of this.instances.values()) {
      inst.pins.delete(abs);
      const d = inst.docs.get(abs);
      if (d) d.lastUsed = Date.now();
    }
  }

  /** Files changed on disk (agent writes, the fs watcher): resync open docs, tell servers about the rest. */
  async notifyFilesChanged(paths: string[]): Promise<void> {
    const ws = this.currentWs();
    if (!ws || !paths.length) return;
    const abs = paths
      .map((p) => {
        try {
          return ws.resolve(p);
        } catch {
          return null;
        }
      })
      .filter((p): p is string => !!p);
    await Promise.all(
      [...this.instances.values()]
        .filter((i) => i.wsRoot === ws.root && i.client?.running)
        .map((inst) =>
          inst.serial(() => {
            const client = inst.client;
            if (!client?.running) return;
            const changes: { uri: string; type: number }[] = [];
            for (const a of abs) {
              if (inst.docs.has(a)) {
                try {
                  this.syncOne(inst, client, ws, a, true);
                } catch {
                  /* unreadable now: leave as is */
                }
              } else if (relevant(inst.def, a)) changes.push({ uri: pathToFileURL(a).href, type: fs.existsSync(a) ? 2 : 3 });
            }
            if (changes.length) client.notify('workspace/didChangeWatchedFiles', { changes });
          }),
        ),
    );
  }

  // ── status / control

  async status(opts: { refresh?: boolean } = {}): Promise<LspStatus> {
    const det = await Promise.all(this.registry.map((d) => detectServer(d, { ...this.detectOpts(), refresh: opts.refresh, probeVersion: this.config.probeVersion })));
    const wsRoot = this.currentWs()?.root;
    return {
      enabled: this.config.enabled,
      servers: this.registry.map((def, i) => {
        const d = det[i];
        const insts = [...this.instances.values()].filter((x) => x.def.id === def.id);
        const instances = insts.map((x): LspInstanceStatus => ({
          root: wsRoot ? path.relative(wsRoot, x.root).split(path.sep).join('/') || '.' : x.root,
          state: instanceState(x),
          pid: x.client?.pid,
          openDocs: x.docs.size,
          startedAt: x.client?.running ? x.startedAt : undefined,
          serverInfo: x.logClient?.serverInfo,
          lastError: x.lastError,
          crashes: x.crashes.length,
          busy: !!x.client?.busy,
        }));
        return {
          id: def.id, name: def.name, languages: def.languages, extensions: def.extensions,
          enabled: this.serverEnabled(def.id), installed: d.found, path: d.path, args: d.args, version: d.version, note: d.note,
          running: instances.some((x) => x.state === 'running'), instances, lastError: insts.map((x) => x.lastError).find(Boolean),
          installHint: d.installHint, homepage: d.homepage,
          custom: this.config.servers[def.id]?.path ? { path: this.config.servers[def.id].path!, args: this.config.servers[def.id].args } : undefined,
        };
      }),
    };
  }

  /** Recent logs (window/logMessage + stderr) of a server's instances, oldest first. */
  logs(serverId: string): LspLogEntry[] {
    return [...this.instances.values()]
      .filter((i) => i.def.id === serverId)
      .flatMap((i) => i.logClient?.logs ?? [])
      .sort((a, b) => a.at - b.at);
  }

  setConfig(patch: Partial<LspConfig>) {
    const prev = this.config;
    this.config = mergeConfig(prev, patch);
    for (const inst of this.instances.values()) {
      const id = inst.def.id;
      const changed = JSON.stringify({ ...prev.servers[id], enabled: undefined }) !== JSON.stringify({ ...this.config.servers[id], enabled: undefined });
      if (!this.config.enabled || !this.serverEnabled(id) || changed) {
        void this.stopInstance(inst);
        inst.failed = false;
        inst.crashes = [];
      }
    }
    if (prev.idleMs !== this.config.idleMs || prev.docIdleMs !== this.config.docIdleMs) this.resetTimer();
    this.changed();
  }

  setServerEnabled(id: string, enabled: boolean) {
    this.setConfig({ servers: { [id]: { enabled } } });
  }

  /** Stop instances (all, or of one server) and clear crash history; they restart on next use. */
  async restart(serverId?: string) {
    await Promise.all(
      [...this.instances.values()]
        .filter((i) => !serverId || i.def.id === serverId)
        .map((i) => {
          i.failed = false;
          i.crashes = [];
          i.lastError = undefined;
          return this.stopInstance(i);
        }),
    );
  }

  async dispose() {
    this.disposed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await Promise.all([...this.instances.values()].map((i) => this.stopInstance(i, true)));
  }

  // ───────────────────────── internals ─────────────────────────

  private currentWs(): Workspace | null {
    return typeof this.o.workspace === 'function' ? this.o.workspace() : this.o.workspace;
  }

  private ws(): Workspace {
    const w = this.currentWs();
    if (!w) throw new Error('尚未打开工作区：请先选择项目文件夹');
    for (const inst of this.instances.values()) if (inst.wsRoot !== w.root) void this.stopInstance(inst, true);
    return w;
  }

  private changed() {
    this.o.onStatusChange?.();
  }

  private serverEnabled(id: string) {
    return this.config.servers[id]?.enabled !== false;
  }

  private detectOpts(): DetectOptions {
    return { ...this.o.detect, overrides: this.config.servers };
  }

  private defsFor(file: string): LspServerDef[] {
    const base = path.basename(file);
    const ext = path.extname(base).toLowerCase();
    return this.registry.filter((d) => (ext && d.extensions.includes(ext)) || d.filenames?.includes(base));
  }

  private async pickFrom(defs: LspServerDef[], label: string): Promise<{ def: LspServerDef; exe: DetectedServer }> {
    const cands = (ds: LspServerDef[]) => ds.map((d) => ({ id: d.id, name: d.name, hint: installHint(d, this.o.detect?.platform), homepage: d.homepage }));
    if (!defs.length) throw new LspUnavailableError('unsupported', label, [], `暂无可处理 ${label} 的语言服务器`);
    if (!this.config.enabled) throw new LspUnavailableError('disabled', label, cands(defs), 'LSP 语言服务已在设置中关闭');
    const enabled = defs.filter((d) => this.serverEnabled(d.id));
    if (!enabled.length) throw new LspUnavailableError('disabled', label, cands(defs), `${label} 的语言服务器均已在设置中停用`);
    const notes = new Map<string, string>();
    for (const def of enabled) {
      const exe = await detectServer(def, this.detectOpts());
      if (exe.found) return { def, exe };
      if (exe.note) notes.set(def.id, exe.note);
    }
    throw new LspUnavailableError('missing', label, cands(enabled).map((c) => ({ ...c, note: notes.get(c.id) })), `未检测到 ${label} 的语言服务器`);
  }

  /** Server instance for a file (lazy; nothing is spawned here). `forced` skips server selection. */
  private async instanceFor(ws: Workspace, abs: string, forced?: LspServerDef): Promise<Instance> {
    const defs = this.defsFor(abs);
    const label = defs[0]?.languages.join(' / ') ?? (path.extname(abs) || path.basename(abs));
    const def = forced ?? (await this.pickFrom(defs, label)).def;
    const root = projectRoot(def, abs, ws.root);
    const key = `${def.id}\0${root}`;
    let inst = this.instances.get(key);
    if (!inst) {
      inst = new Instance(key, def, root, ws.root);
      this.instances.set(key, inst);
    }
    return inst;
  }

  /** Start the server for `abs` and open it (workspace/symbol on tsserver needs a loaded project). */
  private async prepare(ws: Workspace, abs: string, forced?: LspServerDef): Promise<Instance> {
    const inst = await this.instanceFor(ws, abs, forced);
    await this.withInstance(inst, (client) => this.sync(inst, client, ws, abs));
    return inst;
  }

  private async withFile<T>(file: string, fn: (c: { inst: Instance; client: LspClient; doc: Doc; ws: Workspace }) => Promise<T>): Promise<T> {
    const ws = this.ws();
    const abs = ws.resolve(file);
    let st: fs.Stats;
    try {
      st = fs.statSync(abs);
    } catch {
      throw new Error(`文件不存在：${file}`);
    }
    if (st.isDirectory()) throw new Error(`${file} 是目录`);
    if (ws.isBinaryPath(abs)) throw new Error(`${file} 是二进制文件`);
    const inst = await this.instanceFor(ws, abs);
    return this.withInstance(inst, async (client) => fn({ inst, client, doc: await this.sync(inst, client, ws, abs), ws }));
  }

  /** Run against a live client; if the server crashed mid-request (or answered ContentModified), restart/retry once. */
  private async withInstance<T>(inst: Instance, fn: (client: LspClient) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      inst.lastUsed = Date.now();
      const client = await this.ensureClient(inst);
      try {
        return await fn(client);
      } catch (e) {
        const crashed = !client.running;
        const modified = e instanceof LspResponseError && e.code === LSP_ERR.ContentModified;
        if (attempt >= 1 || !(crashed || modified) || this.disposed) throw e;
      } finally {
        inst.lastUsed = Date.now();
      }
    }
  }

  private ensureClient(inst: Instance): Promise<LspClient> {
    if (inst.client?.running) return Promise.resolve(inst.client);
    if (inst.starting) return inst.starting;
    if (this.disposed) return Promise.reject(new Error('LSP 管理器已关闭'));
    if (!this.config.enabled || !this.serverEnabled(inst.def.id)) return Promise.reject(new LspUnavailableError('disabled', inst.def.languages.join(' / '), [], `${inst.def.name} 已在设置中停用`));
    if (inst.failed) return Promise.reject(this.failedError(inst));
    const p = (async () => {
      const wait = this.backoff(inst);
      if (wait > 0) await sleep(wait);
      return this.spawn(inst);
    })();
    inst.starting = p;
    p.finally(() => inst.starting === p && (inst.starting = null)).catch(() => undefined);
    return p;
  }

  private failedError(inst: Instance) {
    return new LspUnavailableError('failed', inst.def.languages.join(' / '), [], `${inst.def.name} 在 ${Math.round(this.config.restartWindowMs / 60000)} 分钟内崩溃 ${inst.crashes.length} 次，已停止自动重启`, inst.lastError);
  }

  private backoff(inst: Instance) {
    const now = Date.now();
    const recent = inst.crashes.filter((t) => now - t < this.config.restartWindowMs);
    if (!recent.length) return 0;
    const delay = Math.min(10_000, this.config.restartBackoffMs * 2 ** (recent.length - 1));
    return Math.max(0, delay - (now - recent[recent.length - 1]));
  }

  private async spawn(inst: Instance): Promise<LspClient> {
    // re-detect each start: a reinstall / upgrade / removed binary is noticed
    const exe = await detectServer(inst.def, this.detectOpts());
    if (!exe.found || !exe.path) {
      inst.lastError = `未找到 ${inst.def.name} 可执行文件`;
      throw new LspUnavailableError('missing', inst.def.languages.join(' / '), [{ id: inst.def.id, name: inst.def.name, hint: exe.installHint, homepage: exe.homepage }], `未检测到 ${inst.def.name}`);
    }
    const client = new LspClient({
      command: exe.path, args: exe.args ?? [], rootPath: inst.root, env: safeEnv(), initializationOptions: initOptions(inst.def, inst.root, inst.wsRoot),
      settings: inst.def.settings, requestTimeoutMs: this.config.requestTimeoutMs, clientVersion: this.o.clientVersion,
    });
    let ready = false;
    client.onDiagnostics = (p) => this.onPublish(inst, client, p);
    client.onDiagnosticRefresh = () => inst.pullIds.clear();
    client.onExit = (why, expected) => this.onExit(inst, client, why, !expected && ready);
    inst.client = client;
    inst.logClient = client;
    inst.docs.clear();
    inst.diags.clear();
    inst.pullIds.clear();
    this.changed();
    try {
      await client.start(this.config.startTimeoutMs);
    } catch (e) {
      if (inst.client === client) inst.client = null;
      client.kill();
      this.recordCrash(inst, `启动失败：${(e as Error).message}${stderrTail(client)}`);
      this.changed();
      throw new Error(`${inst.def.name} 启动失败：${(e as Error).message}`);
    }
    if (inst.client !== client || this.disposed) {
      void client.shutdown();
      throw new Error(`${inst.def.name} 已停止`);
    }
    ready = true;
    inst.startedAt = Date.now();
    const ws = this.currentWs();
    if (ws && ws.root === inst.wsRoot)
      await inst.serial(() => {
        for (const abs of inst.pins) {
          try {
            this.syncOne(inst, client, ws, abs, true);
          } catch {
            inst.pins.delete(abs);
          }
        }
      });
    this.ensureTimer();
    this.changed();
    return client;
  }

  private onExit(inst: Instance, client: LspClient, why: string, crashed: boolean) {
    if (inst.client === client) {
      inst.client = null;
      inst.docs.clear();
      inst.diags.clear();
      inst.pullIds.clear();
    }
    if (crashed) this.recordCrash(inst, `${why}${stderrTail(client)}`);
    this.changed();
  }

  private recordCrash(inst: Instance, msg: string) {
    const now = Date.now();
    inst.crashes = inst.crashes.filter((t) => now - t < this.config.restartWindowMs);
    inst.crashes.push(now);
    inst.lastError = msg;
    if (inst.crashes.length > this.config.maxRestarts) inst.failed = true;
  }

  private async stopInstance(inst: Instance, remove = false) {
    const c = inst.client;
    inst.client = null;
    inst.docs.clear();
    inst.diags.clear();
    inst.pullIds.clear();
    if (remove) this.instances.delete(inst.key);
    if (c) await c.shutdown(2000).catch(() => c.kill());
    this.changed();
  }

  private sync(inst: Instance, client: LspClient, ws: Workspace, abs: string): Promise<Doc> {
    return inst.serial(() => {
      for (const other of [...inst.docs.keys()]) {
        if (other === abs) continue;
        try {
          this.syncOne(inst, client, ws, other, false);
        } catch {
          /* vanished or unreadable: syncOne closed it */
        }
      }
      const doc = this.syncOne(inst, client, ws, abs, true);
      if (!doc) throw new Error(`文件不存在：${ws.rel(abs)}`);
      return doc;
    });
  }

  /** Bring one document in line with disk: didOpen / didChange (+didSave) / didClose when gone. */
  private syncOne(inst: Instance, client: LspClient, ws: Workspace, abs: string, force: boolean): Doc | null {
    if (!client.running) throw new Error('语言服务器未运行');
    let st: fs.Stats | null = null;
    try {
      st = fs.statSync(abs);
    } catch {
      /* deleted */
    }
    let doc = inst.docs.get(abs);
    if (!st || !st.isFile()) {
      if (doc) this.closeDoc(inst, client, doc);
      return null;
    }
    const now = Date.now();
    if (doc && !force && doc.mtimeMs === st.mtimeMs && doc.size === st.size) return doc;
    let text: string;
    try {
      text = ws.read(ws.rel(abs)); // boundary + size checks
    } catch (e) {
      if (doc) this.closeDoc(inst, client, doc);
      throw e;
    }
    if (!doc) {
      doc = { abs, uri: pathToFileURL(abs).href, languageId: languageIdFor(abs, inst.def), version: 1, text, mtimeMs: st.mtimeMs, size: st.size, lastUsed: now, changedSeq: ++inst.changeSeq };
      inst.docs.set(abs, doc);
      client.notify('textDocument/didOpen', { textDocument: { uri: doc.uri, languageId: doc.languageId, version: doc.version, text } });
      this.evictDocs(inst, client);
    } else if (text !== doc.text) {
      doc.version++;
      doc.text = text;
      doc.changedSeq = ++inst.changeSeq;
      client.notify('textDocument/didChange', { textDocument: { uri: doc.uri, version: doc.version }, contentChanges: [{ text }] });
      const save = saveOptions(client.capabilities);
      if (save) client.notify('textDocument/didSave', { textDocument: { uri: doc.uri }, ...(save.includeText ? { text } : {}) });
    }
    doc.mtimeMs = st.mtimeMs;
    doc.size = st.size;
    doc.lastUsed = now;
    return doc;
  }

  private closeDoc(inst: Instance, client: LspClient, doc: Doc) {
    inst.docs.delete(doc.abs);
    inst.pullIds.delete(doc.abs);
    if (client.running) client.notify('textDocument/didClose', { textDocument: { uri: doc.uri } });
  }

  private evictDocs(inst: Instance, client: LspClient) {
    if (inst.docs.size <= this.config.maxOpenDocs) return;
    const lru = [...inst.docs.values()].filter((d) => !inst.pins.has(d.abs)).sort((a, b) => a.lastUsed - b.lastUsed);
    for (const d of lru.slice(0, inst.docs.size - this.config.maxOpenDocs)) this.closeDoc(inst, client, d);
  }

  private onPublish(inst: Instance, client: LspClient, p: { uri: string; version?: number; diagnostics: LspRawDiagnostic[] }) {
    if (inst.client !== client) return;
    const abs = this.uriToPath(p.uri, inst.wsRoot);
    if (!abs) return;
    inst.diags.set(abs, { version: p.version, items: p.diagnostics, seq: inst.changeSeq, n: ++inst.publishSeq });
    this.emitDiagnostics(inst, abs, p.diagnostics);
  }

  private emitDiagnostics(inst: Instance, abs: string, items: LspRawDiagnostic[]) {
    if (!this.o.onDiagnostics) return;
    const rel = path.relative(inst.wsRoot, abs);
    if (!isInside(rel)) return;
    try {
      this.o.onDiagnostics({ path: rel.split(path.sep).join('/'), server: inst.def.id, diagnostics: items.map(normDiag) });
    } catch {
      /* listener errors never break the client */
    }
  }

  /** Publish received after every change sent to the server (no edits anywhere since). */
  private hardFresh(inst: Instance, doc: Doc) {
    const d = inst.diags.get(doc.abs);
    return !!d && d.seq >= inst.changeSeq && (d.version === undefined || d.version >= doc.version);
  }

  /** Publish received after this document's own last change. */
  private softFresh(inst: Instance, doc: Doc) {
    const d = inst.diags.get(doc.abs);
    return !!d && d.seq >= doc.changedSeq && (d.version === undefined || d.version >= doc.version);
  }

  private async waitPush(inst: Instance, doc: Doc, waitMs: number): Promise<boolean> {
    if (this.hardFresh(inst, doc)) return true;
    const start = Date.now();
    const deadline = start + waitMs;
    const settle = this.config.diagnosticSettleMs;
    const grace = Math.min(waitMs, Math.max(settle * 3, 800));
    let lastN = -1;
    let freshAt = 0;
    while (Date.now() < deadline) {
      const client = inst.client;
      if (!client?.running) throw new Error(`${inst.def.name} 在等待诊断时退出`);
      if (this.hardFresh(inst, doc)) {
        const n = inst.diags.get(doc.abs)!.n;
        if (n !== lastN) {
          lastN = n; // a follow-up publish restarts the settle window
          freshAt = Date.now();
        }
        if (Date.now() - freshAt >= settle) return true;
      } else if (this.softFresh(inst, doc) && !client.busy && Date.now() - start >= grace) return true;
      await sleep(20);
    }
    return this.softFresh(inst, doc);
  }

  private locate(method: string, cap: string, label: string, file: string, line: number, column: number, extra: Json = {}): Promise<LspLocationsResult> {
    return this.withFile(file, async ({ inst, client, doc, ws }) => {
      requireCap(inst, client, cap, label);
      const r = await client.request<unknown>(method, { textDocument: { uri: doc.uri }, position: toPosition(doc.text, line, column), ...extra });
      const arr = r == null ? [] : Array.isArray(r) ? r : [r];
      const seen = new Set<string>();
      const locations: LspLocation[] = [];
      for (const x of arr as Json[]) {
        const uri = (x.targetUri ?? x.uri) as string | undefined;
        if (!uri) continue;
        const loc = this.toLocation(uri, (x.targetSelectionRange ?? x.targetRange ?? x.range) as LspRange | undefined, ws);
        const k = `${loc.path}:${loc.line}:${loc.column}`;
        if (seen.has(k)) continue;
        seen.add(k);
        locations.push(loc);
      }
      return { server: inst.def.id, serverName: inst.def.name, locations };
    });
  }

  /** DocumentSymbol (hierarchical) or SymbolInformation / WorkspaceSymbol (flat) → depth-annotated list. */
  private flattenSymbols(items: unknown[], ws: Workspace, docUri: string, max: number) {
    const symbols: LspSymbol[] = [];
    const depthOf = new Map<string, number>();
    const push = (s: LspSymbol) => {
      if (symbols.length < max) symbols.push(s);
    };
    const walk = (s: Json, depth: number, container?: string) => {
      const kind = Number(s.kind);
      push({ name: String(s.name), kind, kindName: SYMBOL_KIND_NAMES[kind] ?? '符号', detail: s.detail ? String(s.detail) : undefined, container, depth, location: this.toLocation(docUri, (s.selectionRange ?? s.range) as LspRange, ws) });
      for (const c of (Array.isArray(s.children) ? s.children : []) as Json[]) walk(c, depth + 1, String(s.name));
    };
    for (const it of items as Json[]) {
      if (!it || typeof it !== 'object') continue;
      const loc = it.location as { uri?: string; range?: LspRange } | undefined;
      if (loc) {
        const kind = Number(it.kind);
        const container = it.containerName ? String(it.containerName) : undefined;
        const depth = container && depthOf.has(container) ? depthOf.get(container)! + 1 : 0;
        depthOf.set(String(it.name), depth);
        push({ name: String(it.name), kind, kindName: SYMBOL_KIND_NAMES[kind] ?? '符号', container, depth, location: this.toLocation(String(loc.uri ?? docUri), loc.range, ws) });
      } else walk(it, 0);
    }
    const total = countSymbols(items);
    return { symbols, truncated: total > symbols.length };
  }

  private toLocation(uri: string, range: LspRange | undefined, ws: Workspace): LspLocation {
    const r = range?.start ? range : { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };
    const pos = { line: r.start.line + 1, column: r.start.character + 1, endLine: r.end.line + 1, endColumn: r.end.character + 1 };
    const abs = this.uriToPath(uri, ws.root);
    if (!abs) return { path: uri, external: true, ...pos };
    const rel = path.relative(ws.root, abs);
    return isInside(rel) ? { path: rel.split(path.sep).join('/'), external: false, ...pos } : { path: abs, external: true, ...pos };
  }

  /** file:// URI → absolute path, with the workspace's realpath mapped back to its configured root (/private/var vs /var). */
  private uriToPath(uri: string, wsRoot: string): string | null {
    if (!uri.startsWith('file:')) return null;
    let abs: string;
    try {
      abs = path.normalize(fileURLToPath(uri));
    } catch {
      return null;
    }
    let real = this.realRoots.get(wsRoot);
    if (real === undefined) {
      try {
        real = fs.realpathSync(wsRoot);
      } catch {
        real = wsRoot;
      }
      this.realRoots.set(wsRoot, real);
    }
    if (real !== wsRoot) {
      const rel = path.relative(real, abs);
      if (rel === '' || isInside(rel)) return path.join(wsRoot, rel);
    }
    return abs;
  }

  private findFile(ws: Workspace, match: (abs: string) => boolean): string | null {
    for (const rel of ws.walk(5000)) {
      const abs = path.join(ws.root, rel);
      if (match(abs)) return abs;
    }
    return null;
  }

  /** A file of the most common workspace language that has an installed server. */
  private async dominantFile(ws: Workspace): Promise<string | null> {
    const byExt = new Map<string, { n: number; first: string }>();
    for (const rel of ws.walk(4000)) {
      const abs = path.join(ws.root, rel);
      if (!this.defsFor(abs).length) continue;
      const k = path.extname(rel).toLowerCase() || path.basename(rel);
      const e = byExt.get(k);
      if (e) e.n++;
      else byExt.set(k, { n: 1, first: abs });
    }
    for (const { first } of [...byExt.values()].sort((a, b) => b.n - a.n)) {
      try {
        await this.pickFrom(this.defsFor(first), first);
        return first;
      } catch {
        /* no installed server for this one: try the next language */
      }
    }
    return null;
  }

  private ensureTimer() {
    if (this.timer || this.disposed) return;
    const every = Math.max(50, Math.min(30_000, Math.min(this.config.idleMs, this.config.docIdleMs) / 4));
    this.timer = setInterval(() => this.sweep(), every);
    this.timer.unref?.();
  }

  private resetTimer() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if ([...this.instances.values()].some((i) => i.client)) this.ensureTimer();
  }

  /** Idle housekeeping: close untouched documents, stop unused servers, drop servers of a closed workspace. */
  private sweep() {
    const now = Date.now();
    const wsRoot = this.currentWs()?.root;
    let live = 0;
    for (const inst of [...this.instances.values()]) {
      if (inst.wsRoot !== wsRoot) {
        void this.stopInstance(inst, true);
        continue;
      }
      const c = inst.client;
      if (!c?.running) {
        if (inst.starting) live++;
        continue;
      }
      if (!inst.pins.size && now - inst.lastUsed > this.config.idleMs) {
        void this.stopInstance(inst);
        continue;
      }
      live++;
      void inst.serial(() => {
        for (const d of [...inst.docs.values()]) if (!inst.pins.has(d.abs) && now - d.lastUsed > this.config.docIdleMs) this.closeDoc(inst, c, d);
      });
    }
    if (!live && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

// ───────────────────────── helpers ─────────────────────────
function instanceState(x: Instance): LspInstanceState {
  if (x.failed) return 'failed';
  if (x.client?.running) return 'running';
  if (x.starting || x.client?.state === 'starting') return 'starting';
  return x.crashes.length && x.lastError ? 'crashed' : 'stopped';
}

function requireCap(inst: Instance, client: LspClient, cap: string, label: string) {
  if (!client.capabilities[cap]) throw new Error(`${inst.def.name} 不支持${label}`);
}

function saveOptions(caps: Json): { includeText?: boolean } | null {
  const sync = caps.textDocumentSync;
  if (!sync || typeof sync !== 'object') return null;
  const save = (sync as Json).save;
  if (!save) return null;
  return typeof save === 'object' ? (save as { includeText?: boolean }) : {};
}

function languageIdFor(abs: string, def: LspServerDef): string {
  const base = path.basename(abs);
  return LANGUAGE_ID_BY_FILENAME[base] ?? LANGUAGE_ID_BY_EXT[path.extname(base).toLowerCase()] ?? def.languageIds[0] ?? 'plaintext';
}

function relevant(def: LspServerDef, abs: string) {
  const base = path.basename(abs);
  return def.extensions.includes(path.extname(base).toLowerCase()) || !!def.filenames?.includes(base) || def.rootMarkers.includes(base);
}

function hasMarker(dir: string, markers: string[]): boolean {
  let names: string[] | null = null;
  for (const m of markers) {
    if (m.startsWith('*')) {
      try {
        names ??= fs.readdirSync(dir);
      } catch {
        names = [];
      }
      if (names.some((n) => n.endsWith(m.slice(1)))) return true;
    } else if (fs.existsSync(path.join(dir, m))) return true;
  }
  return false;
}

/** Workspace root when it is itself a project root for this server (or nothing marks one); else the nearest marked ancestor. */
function projectRoot(def: LspServerDef, abs: string, wsRoot: string): string {
  if (!def.rootMarkers.length || hasMarker(wsRoot, def.rootMarkers)) return wsRoot;
  for (let dir = path.dirname(abs); isInside(path.relative(wsRoot, dir)); dir = path.dirname(dir)) if (hasMarker(dir, def.rootMarkers)) return dir;
  return wsRoot;
}

function initOptions(def: LspServerDef, root: string, wsRoot: string): unknown {
  let io: Json | undefined = def.initializationOptions ? structuredClone(def.initializationOptions) : undefined;
  if (def.tsdk) {
    const lib = [root, wsRoot].map((r) => path.join(r, 'node_modules', 'typescript', 'lib')).find((p) => fs.existsSync(p));
    if (lib) io = { ...io, typescript: { ...((io?.typescript as Json) ?? {}), tsdk: lib } };
  }
  return io;
}

function stderrTail(c: LspClient): string {
  const tail = c.logs.filter((l) => l.level === 'stderr' || l.level === 'error').slice(-3).map((l) => l.text);
  return tail.length ? `；最近输出：${tail.join(' | ').slice(0, 600)}` : '';
}

export function toPosition(text: string, line: number, column: number) {
  const lines = text.split('\n');
  if (!Number.isInteger(line) || line < 1 || line > lines.length) throw new Error(`行号 ${line} 超出范围（文件共 ${lines.length} 行）`);
  const lt = lines[line - 1].replace(/\r$/, '');
  const col = Number.isInteger(column) && column >= 1 ? column : 1;
  return { line: line - 1, character: Math.min(col - 1, lt.length) };
}

export function normDiag(d: LspRawDiagnostic): LspDiagnostic {
  const r = d.range?.start ? d.range : { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };
  const severity: LspSeverity = d.severity === 2 ? 'warning' : d.severity === 3 ? 'info' : d.severity === 4 ? 'hint' : 'error';
  const code = d.code == null ? undefined : typeof d.code === 'object' ? String(d.code.value) : String(d.code);
  return {
    line: r.start.line + 1, column: r.start.character + 1, endLine: r.end.line + 1, endColumn: r.end.character + 1,
    severity, message: String(d.message ?? ''), source: d.source || undefined, code,
    ...(d.tags?.includes(1) ? { unnecessary: true } : {}), ...(d.tags?.includes(2) ? { deprecated: true } : {}),
  };
}

function hoverText(c: unknown): string {
  if (c == null) return '';
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map(hoverText).filter(Boolean).join('\n\n');
  const o = c as { kind?: string; language?: string; value?: string };
  if (o.language) return '```' + o.language + '\n' + (o.value ?? '') + '\n```';
  return String(o.value ?? '');
}

function countSymbols(items: unknown[]): number {
  let n = 0;
  for (const it of items as Json[]) {
    if (!it || typeof it !== 'object') continue;
    n++;
    if (Array.isArray(it.children)) n += countSymbols(it.children);
  }
  return n;
}
