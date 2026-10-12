// SQLite persistence (<dataDir>/edict.db) — replaces 1.x's whole-file state.json / settings.json rewrites.
//
// Layout: one row per task / debate / session / memorial / annotation / news item (its JSON plus a few
// indexed columns) and a kv table for totals / seqByDay / agentStats / settings / providers. WAL journal,
// synchronous=NORMAL, foreign keys on, busy timeout; the schema is versioned by PRAGMA user_version (plus a
// schema_migrations log) and evolves only through the ordered, additive MIGRATIONS list below.
//
// Writes are incremental. The runtime marks what changed (markDirty / markStateDirty / markSettingsDirty)
// and a write-behind flush (250 ms, the same cadence as JsonFile.saveDebounced) writes, in one transaction,
// only the rows whose JSON actually changed. Uses the built-in node:sqlite (Node ≥ 22.13 / Electron ≥ 35):
// no native module. NOTE: local storage is NOT a security sandbox — see docs/SECURITY.md.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import type { AgentId, AgentRuntime, Annotation, Debate, Memorial, NewsItem, ProviderConfig, Session, Settings, Task, Usage } from '../../shared/types';
import { emptyUsage } from '../../shared/types';
import { sha256 } from './util';

// ───────────────────────── shapes ─────────────────────────

/** Same shape as 1.x state.json (and Runtime's PersistedState). */
export interface PersistedStateLike {
  tasks: Task[];
  debates: Debate[];
  sessions: Session[];
  memorials: Memorial[];
  annotations: Annotation[];
  news: NewsItem[];
  agentStats: Partial<Record<AgentId, Pick<AgentRuntime, 'usage' | 'completed' | 'sessions' | 'errors'>>>;
  totals: Usage;
  seqByDay: Record<string, number>;
}

/** Same shape as 1.x settings.json. */
export interface PersistedSettingsLike {
  settings: Settings;
  providers: ProviderConfig[];
}

export type DocKind = 'tasks' | 'debates' | 'sessions' | 'memorials' | 'annotations' | 'news';
export const DOC_KINDS: readonly DocKind[] = ['tasks', 'debates', 'sessions', 'memorials', 'annotations', 'news'];
export interface DocMap {
  tasks: Task;
  debates: Debate;
  sessions: Session;
  memorials: Memorial;
  annotations: Annotation;
  news: NewsItem;
}

export type StateKvKey = 'totals' | 'seqByDay' | 'agentStats';
export type SettingsKvKey = 'settings' | 'providers';
export type KvKey = StateKvKey | SettingsKvKey;
const STATE_KV: readonly StateKvKey[] = ['totals', 'seqByDay', 'agentStats'];
const SETTINGS_KV: readonly SettingsKvKey[] = ['settings', 'providers'];
const isStateKey = (k: KvKey): k is StateKvKey => (STATE_KV as readonly string[]).includes(k);

/**
 * How a collection-level sync (markDirty(kind) / markStateDirty()) decides which rows to write:
 * - 'content': serialize every item and write those whose JSON changed (bounded lists, in-place mutation).
 * - 'ref': write only items that are new or were replaced by a different object; in-place edits must be
 *   signalled with markDirty(kind, id). Deletions are detected either way.
 * flush({ full: true }) always compares content.
 */
export type SyncStrategy = 'ref' | 'content';

/** What the runtime would persist right now. Live references are fine: they are serialized at flush time. */
export interface StoreSource {
  /** Arrays already bounded the way they should be stored (e.g. sessions.slice(-300)); items absent here are deleted. */
  state(): PersistedStateLike;
  settings?(): PersistedSettingsLike;
}

export type StoreLogger = (level: 'info' | 'warn' | 'error', line: string) => void;
const defaultLog: StoreLogger = (level, line) => (level === 'info' ? console.log(line) : level === 'warn' ? console.warn(line) : console.error(line));

export interface SqliteStoreOptions {
  /** Write-behind delay after the first mark (default 250 ms, like JsonFile.saveDebounced). */
  debounceMs?: number;
  /** How long a writer waits for another connection's lock (default 5000 ms). */
  busyTimeoutMs?: number;
  /** Override the per-kind collection sync strategy (defaults: tasks/memorials 'ref', the rest 'content'). */
  strategies?: Partial<Record<DocKind, SyncStrategy>>;
  log?: StoreLogger;
}

export interface FlushResult {
  written: number;
  deleted: number;
  skipped: number;
  ms: number;
}

export interface StoreStats {
  flushes: number;
  failedFlushes: number;
  rowsWritten: number;
  rowsDeleted: number;
  /** rows looked at but left alone because their JSON was unchanged */
  rowsSkipped: number;
  /** items that could not be stored (no id / not serializable) */
  invalid: number;
  /** marks received after close() (e.g. late async work after Runtime.dispose) — ignored */
  droppedAfterClose: number;
  lastFlushMs: number;
}

export interface ImportCounts {
  tasks: number;
  debates: number;
  sessions: number;
  memorials: number;
  annotations: number;
  news: number;
  providers: number;
  settings: boolean;
  /** items without an id (dropped) */
  skipped: number;
}

export class StoreCorruptError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'StoreCorruptError';
  }
}

// ───────────────────────── node:sqlite loader ─────────────────────────

type SqliteModule = typeof import('node:sqlite');
let sqliteModule: SqliteModule | null = null;

function isSqliteExperimentalWarning(warning: unknown, typeOrOpts: unknown): boolean {
  const type = typeof typeOrOpts === 'string' ? typeOrOpts : (typeOrOpts as { type?: unknown } | null | undefined)?.type ?? (warning instanceof Error ? warning.name : undefined);
  const msg = warning instanceof Error ? warning.message : String(warning);
  return type === 'ExperimentalWarning' && /sqlite/i.test(msg);
}

/**
 * node:sqlite, loaded on first use. Only the "SQLite is an experimental feature" ExperimentalWarning that
 * Node emits on that first load is swallowed; every other warning goes through untouched. Loaded through
 * process.getBuiltinModule (not a static import) so the filter is in place before the module evaluates,
 * and so the bundler never has to resolve it.
 */
export function loadSqlite(): SqliteModule {
  if (sqliteModule) return sqliteModule;
  const original = process.emitWarning;
  process.emitWarning = function (this: unknown, warning: string | Error, ...rest: unknown[]) {
    if (isSqliteExperimentalWarning(warning, rest[0])) return;
    return (original as (...a: unknown[]) => void).call(process, warning, ...rest);
  } as typeof process.emitWarning;
  try {
    sqliteModule = process.getBuiltinModule('node:sqlite') ?? null;
  } finally {
    process.emitWarning = original;
  }
  if (!sqliteModule) throw new Error('node:sqlite is not available in this runtime (needs Node ≥ 22.13)');
  return sqliteModule;
}

/** SQLITE_CORRUPT (11) / SQLITE_NOTADB (26), including extended codes, or our own integrity failure. */
export function isCorruptError(e: unknown): boolean {
  if (e instanceof StoreCorruptError) return true;
  const code = (e as { errcode?: unknown } | null)?.errcode;
  if (typeof code === 'number') return [11, 26].includes(code & 0xff);
  return /database disk image is malformed|file is not a database/i.test(String((e as Error | null)?.message ?? ''));
}

/** SQLITE_BUSY (5) / SQLITE_LOCKED (6), including extended codes. */
export function isBusyError(e: unknown): boolean {
  const code = (e as { errcode?: unknown } | null)?.errcode;
  return typeof code === 'number' && [5, 6].includes(code & 0xff);
}

const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function retryBusy<T>(fn: () => T, timeoutMs: number): T {
  const deadline = Date.now() + timeoutMs;
  for (let delay = 5; ; delay = Math.min(delay * 2, 100)) {
    try {
      return fn();
    } catch (e) {
      if (!isBusyError(e) || Date.now() + delay > deadline) throw e;
      sleepSync(delay);
    }
  }
}

// ───────────────────────── schema ─────────────────────────

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

/** Ordered, append-only. Never edit a shipped migration; add a new one (additive changes only, so an older build can still open a newer db). */
export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'initial schema',
    sql: `
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
      CREATE TABLE tasks (id TEXT PRIMARY KEY, state TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, json TEXT NOT NULL) STRICT;
      CREATE INDEX tasks_state ON tasks (state);
      CREATE INDEX tasks_updated ON tasks (updated_at);
      CREATE TABLE debates (id TEXT PRIMARY KEY, updated_at INTEGER NOT NULL, json TEXT NOT NULL) STRICT;
      CREATE TABLE sessions (id TEXT PRIMARY KEY, updated_at INTEGER NOT NULL, json TEXT NOT NULL) STRICT;
      CREATE TABLE memorials (id TEXT PRIMARY KEY, at INTEGER NOT NULL, json TEXT NOT NULL) STRICT;
      CREATE TABLE annotations (id TEXT PRIMARY KEY, at INTEGER NOT NULL, json TEXT NOT NULL) STRICT;
      CREATE TABLE news (id TEXT PRIMARY KEY, at INTEGER NOT NULL, json TEXT NOT NULL) STRICT;
      CREATE INDEX news_at ON news (at);
      CREATE TABLE kv (key TEXT PRIMARY KEY, json TEXT NOT NULL, updated_at INTEGER NOT NULL) STRICT;
    `,
  },
];
export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;

const int = (v: unknown): number => {
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) ? n : 0;
};

interface KindSpec {
  cols: readonly string[];
  id(x: unknown): unknown;
  values(x: unknown): (string | number)[];
  /** load order — rowid keeps first-insertion order, like the Maps/arrays the runtime keeps */
  order: string;
  strategy: SyncStrategy;
}

const SPECS: Record<DocKind, KindSpec> = {
  tasks: {
    cols: ['state', 'created_at', 'updated_at'],
    id: (x) => (x as Task).id,
    values: (x) => [String((x as Task).state ?? ''), int((x as Task).createdAt), int((x as Task).updatedAt)],
    order: 'rowid',
    strategy: 'ref', // every in-place task edit goes through Runtime.touch() → markDirty('tasks', id)
  },
  debates: { cols: ['updated_at'], id: (x) => (x as Debate).id, values: (x) => [int((x as Debate).updatedAt)], order: 'rowid', strategy: 'content' },
  sessions: { cols: ['updated_at'], id: (x) => (x as Session).id, values: (x) => [int((x as Session).updatedAt)], order: 'rowid', strategy: 'content' },
  // a memorial is rebuilt as a new object on every archive, so reference changes catch every update
  memorials: { cols: ['at'], id: (x) => (x as Memorial).taskId, values: (x) => [int((x as Memorial).archivedAt)], order: 'rowid', strategy: 'ref' },
  annotations: { cols: ['at'], id: (x) => (x as Annotation).id, values: (x) => [int((x as Annotation).at)], order: 'rowid', strategy: 'content' },
  news: { cols: ['at'], id: (x) => (x as NewsItem).id, values: (x) => [int((x as NewsItem).at)], order: 'at DESC, rowid ASC', strategy: 'content' },
};

function upsertSql(kind: DocKind): string {
  const { cols } = SPECS[kind];
  const all = [...cols, 'json'];
  return (
    `INSERT INTO ${kind} (id, ${all.join(', ')}) VALUES (?, ${all.map(() => '?').join(', ')}) ` +
    `ON CONFLICT (id) DO UPDATE SET ${all.map((c) => `${c} = excluded.${c}`).join(', ')} ` +
    `WHERE ${all.map((c) => `${kind}.${c} IS NOT excluded.${c}`).join(' OR ')}`
  );
}

const hashOf = (json: string) => createHash('sha1').update(json).digest('base64');
const asArray = <T>(x: unknown): T[] => (Array.isArray(x) ? (x as T[]) : []);
const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);

interface RowMeta {
  ref: unknown;
  hash: string;
}
type MetaOp = { t: 'row'; kind: DocKind; id: string; meta: RowMeta | null } | { t: 'clear'; kind: DocKind } | { t: 'kv'; key: string; hash: string | null };
interface Frame {
  ops: MetaOp[];
  written: number;
  deleted: number;
  skipped: number;
  invalid: number;
}
const newFrame = (): Frame => ({ ops: [], written: 0, deleted: 0, skipped: 0, invalid: 0 });

function runMigrations(db: DatabaseSync, log: StoreLogger, file: string): void {
  const userVersion = () => Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
  let v = userVersion();
  if (v > SCHEMA_VERSION) {
    log('warn', `[store] ${path.basename(file)} has schema v${v}, newer than this build (v${SCHEMA_VERSION}); opening it anyway (migrations are additive)`);
    return;
  }
  for (const m of MIGRATIONS) {
    if (m.version <= v) continue;
    db.exec('BEGIN IMMEDIATE');
    try {
      const cur = userVersion(); // re-read under the write lock: another connection may have migrated meanwhile
      if (cur < m.version) {
        db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL) STRICT');
        db.exec(m.sql);
        db.prepare('INSERT OR REPLACE INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(m.version, m.name, Date.now());
        db.exec(`PRAGMA user_version = ${m.version}`);
      }
      db.exec('COMMIT');
      v = Math.max(cur, m.version);
    } catch (e) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* already rolled back */
      }
      throw e;
    }
  }
}

// ───────────────────────── store ─────────────────────────

export class SqliteStore {
  /** Set by openStateStore(): what happened while opening (migration, recovery, warnings). */
  openReport: OpenReport | null = null;

  private stmts = new Map<string, StatementSync>();
  private rows: Record<DocKind, Map<string, RowMeta>> = {
    tasks: new Map(), debates: new Map(), sessions: new Map(), memorials: new Map(), annotations: new Map(), news: new Map(),
  };
  private kvMeta = new Map<string, string>();
  private frames: Frame[] = [];
  private source: StoreSource | null = null;
  private rowDirty = new Map<DocKind, Set<string>>();
  private kindDirty = new Set<DocKind>();
  private kvDirty = new Set<KvKey>();
  private timer: NodeJS.Timeout | null = null;
  private retries = 0;
  private isClosed = false;
  private readonly strategies: Record<DocKind, SyncStrategy>;
  private readonly debounceMs: number;
  private readonly log: StoreLogger;
  private readonly counters: StoreStats = { flushes: 0, failedFlushes: 0, rowsWritten: 0, rowsDeleted: 0, rowsSkipped: 0, invalid: 0, droppedAfterClose: 0, lastFlushMs: 0 };

  private constructor(
    private db: DatabaseSync,
    readonly file: string,
    readonly journalMode: string,
    opts: SqliteStoreOptions,
  ) {
    this.debounceMs = opts.debounceMs ?? 250;
    this.log = opts.log ?? defaultLog;
    this.strategies = Object.fromEntries(DOC_KINDS.map((k) => [k, opts.strategies?.[k] ?? SPECS[k].strategy])) as Record<DocKind, SyncStrategy>;
  }

  /** Open (creating if needed) and migrate. Throws on corruption (see isCorruptError); openStateStore() handles recovery. */
  static open(file: string, opts: SqliteStoreOptions = {}): SqliteStore {
    const { DatabaseSync } = loadSqlite();
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    const db = new DatabaseSync(file, { enableForeignKeyConstraints: true });
    const busyMs = Math.max(0, Math.trunc(opts.busyTimeoutMs ?? 5000));
    try {
      db.exec(`PRAGMA busy_timeout = ${busyMs}`);
      // Two processes switching a brand-new file to WAL at once can get SQLITE_BUSY without the busy handler
      // being consulted (deadlock avoidance), so the setup is retried; every step in it is idempotent.
      const jm = retryBusy(() => {
        const mode = String((db.prepare('PRAGMA journal_mode = WAL').get() as { journal_mode?: string } | undefined)?.journal_mode ?? '');
        db.exec('PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA journal_size_limit = 33554432;');
        runMigrations(db, opts.log ?? defaultLog, file);
        return mode;
      }, busyMs);
      if (jm !== 'wal' && file !== ':memory:') (opts.log ?? defaultLog)('warn', `[store] WAL unavailable for ${file} (journal_mode=${jm})`);
      return new SqliteStore(db, file, jm, opts);
    } catch (e) {
      try {
        db.close();
      } catch {
        /* ignore */
      }
      throw e;
    }
  }

  get closed(): boolean {
    return this.isClosed;
  }

  /** Escape hatch for diagnostics and tests. Prefer the typed API. */
  get raw(): DatabaseSync {
    return this.db;
  }

  get schemaVersion(): number {
    return Number((this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
  }

  private stmt(sql: string): StatementSync {
    let s = this.stmts.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.stmts.set(sql, s);
    }
    return s;
  }

  private assertOpen() {
    if (this.isClosed) throw new Error('SqliteStore is closed');
  }

  // ───────────── transactions ─────────────

  /**
   * Run fn atomically (BEGIN IMMEDIATE … COMMIT; nested calls use savepoints). fn must be synchronous;
   * any throw rolls everything in it back, including the store's in-memory bookkeeping.
   */
  transaction<T>(fn: () => T): T {
    return this.runTx(fn).result;
  }

  private runTx<T>(fn: () => T): { result: T; frame: Frame } {
    this.assertOpen();
    const nested = this.frames.length > 0;
    const sp = `sp_${this.frames.length}`;
    this.db.exec(nested ? `SAVEPOINT ${sp}` : 'BEGIN IMMEDIATE');
    const frame = newFrame();
    this.frames.push(frame);
    try {
      const result = fn();
      if (result && typeof (result as { then?: unknown }).then === 'function') throw new TypeError('SqliteStore.transaction(fn): fn must be synchronous');
      this.db.exec(nested ? `RELEASE ${sp}` : 'COMMIT');
      this.frames.pop();
      if (nested) {
        const parent = this.frames[this.frames.length - 1];
        parent.ops.push(...frame.ops);
        parent.written += frame.written;
        parent.deleted += frame.deleted;
        parent.skipped += frame.skipped;
        parent.invalid += frame.invalid;
      } else this.applyFrame(frame);
      return { result, frame };
    } catch (e) {
      this.frames.pop();
      try {
        this.db.exec(nested ? `ROLLBACK TO ${sp}; RELEASE ${sp}` : 'ROLLBACK');
      } catch {
        /* the failed statement may already have ended the transaction */
      }
      throw e;
    }
  }

  private applyFrame(f: Frame) {
    for (const op of f.ops) {
      if (op.t === 'kv') {
        if (op.hash === null) this.kvMeta.delete(op.key);
        else this.kvMeta.set(op.key, op.hash);
      } else if (op.t === 'clear') this.rows[op.kind].clear();
      else if (op.meta) this.rows[op.kind].set(op.id, op.meta);
      else this.rows[op.kind].delete(op.id);
    }
    this.counters.rowsWritten += f.written;
    this.counters.rowsDeleted += f.deleted;
    this.counters.rowsSkipped += f.skipped;
    this.counters.invalid += f.invalid;
  }

  private get frame(): Frame {
    const f = this.frames[this.frames.length - 1];
    if (!f) throw new Error('internal: write outside a transaction');
    return f;
  }

  // ───────────── row primitives (inside a transaction) ─────────────

  private writeRow(kind: DocKind, item: unknown, force = false): void {
    const f = this.frame;
    const spec = SPECS[kind];
    const id = isObj(item) ? spec.id(item) : undefined;
    if (typeof id !== 'string' || !id) {
      f.invalid++;
      return;
    }
    let json: string;
    try {
      json = JSON.stringify(item);
    } catch (e) {
      f.invalid++;
      this.log('error', `[store] cannot serialize ${kind}/${id}: ${(e as Error).message}`);
      return;
    }
    const hash = hashOf(json);
    if (!force && this.rows[kind].get(id)?.hash === hash) {
      f.skipped++;
      f.ops.push({ t: 'row', kind, id, meta: { ref: item, hash } });
      return;
    }
    const r = this.stmt(upsertSql(kind)).run(id, ...spec.values(item), json);
    if (Number(r.changes) > 0) f.written++;
    else f.skipped++;
    f.ops.push({ t: 'row', kind, id, meta: { ref: item, hash } });
  }

  private deleteRow(kind: DocKind, id: string): void {
    const f = this.frame;
    const r = this.stmt(`DELETE FROM ${kind} WHERE id = ?`).run(id);
    f.deleted += Number(r.changes);
    f.ops.push({ t: 'row', kind, id, meta: null });
  }

  /** Make the stored rows of `kind` match `list`; rows this store never saw (another connection's) are left alone. */
  private syncKind(kind: DocKind, list: readonly unknown[], strategy: SyncStrategy, forceIds?: Set<string>): void {
    const spec = SPECS[kind];
    const known = this.rows[kind];
    const seen = new Set<string>();
    for (const item of list) {
      const id = isObj(item) ? spec.id(item) : undefined;
      if (typeof id !== 'string' || !id) {
        this.frame.invalid++;
        continue;
      }
      seen.add(id);
      if (strategy === 'ref' && known.get(id)?.ref === item && !forceIds?.has(id)) continue;
      this.writeRow(kind, item);
    }
    for (const id of [...known.keys()]) if (!seen.has(id)) this.deleteRow(kind, id);
    if (forceIds) for (const id of forceIds) if (!seen.has(id) && !known.has(id)) this.deleteRow(kind, id);
  }

  /** Write just these ids: present in the list → upsert, absent → delete. */
  private writeIds(kind: DocKind, list: readonly unknown[], ids: Set<string>): void {
    const spec = SPECS[kind];
    const byId = new Map<string, unknown>();
    for (const item of list) {
      const id = isObj(item) ? spec.id(item) : undefined;
      if (typeof id === 'string' && ids.has(id)) byId.set(id, item);
    }
    for (const id of ids) {
      const item = byId.get(id);
      if (item === undefined) this.deleteRow(kind, id);
      else this.writeRow(kind, item);
    }
  }

  private writeKvRow(key: string, value: unknown): void {
    const f = this.frame;
    if (value === undefined) {
      const r = this.stmt('DELETE FROM kv WHERE key = ?').run(key);
      f.deleted += Number(r.changes);
      f.ops.push({ t: 'kv', key, hash: null });
      return;
    }
    const json = JSON.stringify(value);
    const hash = hashOf(json);
    if (this.kvMeta.get(key) === hash) {
      f.skipped++;
      return;
    }
    const r = this.stmt('INSERT INTO kv (key, json, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at WHERE kv.json IS NOT excluded.json').run(key, json, Date.now());
    if (Number(r.changes) > 0) f.written++;
    else f.skipped++;
    f.ops.push({ t: 'kv', key, hash });
  }

  // ───────────── reads ─────────────

  /** Everything, in the order the runtime keeps it (also primes the change tracking used by flush). */
  loadState(): PersistedStateLike {
    this.assertOpen();
    const read = <K extends DocKind>(kind: K): DocMap[K][] => {
      const known = this.rows[kind];
      known.clear();
      const out: DocMap[K][] = [];
      for (const r of this.stmt(`SELECT id, json FROM ${kind} ORDER BY ${SPECS[kind].order}`).all() as { id: string; json: string }[]) {
        try {
          const item = JSON.parse(r.json) as DocMap[K];
          out.push(item);
          known.set(r.id, { ref: item, hash: hashOf(r.json) });
        } catch (e) {
          this.log('error', `[store] skipping unreadable row ${kind}/${r.id}: ${(e as Error).message}`);
        }
      }
      return out;
    };
    const totals = this.getKv<Usage>('totals');
    const seqByDay = this.getKv<Record<string, number>>('seqByDay');
    const agentStats = this.getKv<PersistedStateLike['agentStats']>('agentStats');
    return {
      tasks: read('tasks'),
      debates: read('debates'),
      sessions: read('sessions'),
      memorials: read('memorials'),
      annotations: read('annotations'),
      news: read('news'),
      agentStats: isObj(agentStats) ? agentStats : {},
      totals: isObj(totals) ? { ...emptyUsage(), ...totals } : emptyUsage(),
      seqByDay: isObj(seqByDay) ? seqByDay : {},
    };
  }

  /** Stored settings + providers, or null when none were ever saved (caller applies defaults). */
  loadSettings(): PersistedSettingsLike | null {
    this.assertOpen();
    const settings = this.getKv<Settings>('settings');
    const providers = this.getKv<ProviderConfig[]>('providers');
    if (settings === undefined && providers === undefined) return null;
    return { settings: (isObj(settings) ? settings : {}) as Settings, providers: Array.isArray(providers) ? providers : [] };
  }

  getKv<T = unknown>(key: string): T | undefined {
    this.assertOpen();
    const r = this.stmt('SELECT json FROM kv WHERE key = ?').get(key) as { json: string } | undefined;
    if (!r) return undefined;
    try {
      const v = JSON.parse(r.json) as T;
      this.kvMeta.set(key, hashOf(r.json));
      return v;
    } catch (e) {
      this.log('error', `[store] unreadable kv ${key}: ${(e as Error).message}`);
      return undefined;
    }
  }

  getMeta(key: string): string | undefined {
    this.assertOpen();
    return (this.stmt('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined)?.value;
  }

  setMeta(key: string, value: string): void {
    this.assertOpen();
    this.stmt('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  /** Row counts per table. */
  counts(): Record<DocKind | 'kv', number> {
    this.assertOpen();
    const out = {} as Record<DocKind | 'kv', number>;
    for (const t of [...DOC_KINDS, 'kv'] as const) out[t] = Number((this.stmt(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n);
    return out;
  }

  /** No document rows and no kv rows. */
  isEmpty(): boolean {
    this.assertOpen();
    const sql = `SELECT ${[...DOC_KINDS, 'kv'].map((t) => `EXISTS (SELECT 1 FROM ${t})`).join(' OR ')} AS any_rows`;
    return !Number((this.stmt(sql).get() as { any_rows: number }).any_rows);
  }

  // ───────────── direct writes (immediate, transactional) ─────────────

  upsertTasks(tasks: readonly Task[]): number {
    return this.upsertMany('tasks', tasks);
  }

  deleteTask(id: string): boolean {
    return this.deleteMany('tasks', [id]) > 0;
  }

  /** Insert or update; returns the number of rows that actually changed. */
  upsertMany<K extends DocKind>(kind: K, items: readonly DocMap[K][]): number {
    return this.runTx(() => {
      for (const it of items) this.writeRow(kind, it);
    }).frame.written;
  }

  deleteMany(kind: DocKind, ids: readonly string[]): number {
    return this.runTx(() => {
      for (const id of ids) this.deleteRow(kind, id);
    }).frame.deleted;
  }

  /** Replace the whole stored list with exactly `items`, in this order (bounded lists such as news / annotations). */
  replaceAll<K extends DocKind>(kind: K, items: readonly DocMap[K][]): number {
    return this.runTx(() => {
      const f = this.frame;
      f.deleted += Number(this.stmt(`DELETE FROM ${kind}`).run().changes);
      f.ops.push({ t: 'clear', kind }); // bookkeeping changes only on commit
      for (const it of items) this.writeRow(kind, it, true);
    }).frame.written;
  }

  /** Returns true when the stored value changed. `undefined` deletes the key. */
  setKv(key: string, value: unknown): boolean {
    const f = this.runTx(() => this.writeKvRow(key, value)).frame;
    return f.written + f.deleted > 0;
  }

  deleteKv(key: string): boolean {
    return this.setKv(key, undefined);
  }

  /**
   * Import a 1.x state.json / settings.json payload (arrays in their original order). Runs inside the
   * caller's transaction when there is one. Items without an id are dropped and counted.
   */
  importLegacy(state: unknown, settings: unknown): ImportCounts {
    const counts: ImportCounts = { tasks: 0, debates: 0, sessions: 0, memorials: 0, annotations: 0, news: 0, providers: 0, settings: false, skipped: 0 };
    this.runTx(() => {
      const st = isObj(state) ? state : {};
      for (const kind of DOC_KINDS) {
        const before = this.frame.invalid;
        const seen = new Set<string>();
        for (const it of asArray<unknown>(st[kind])) {
          this.writeRow(kind, it, true);
          const id = isObj(it) ? SPECS[kind].id(it) : undefined;
          if (typeof id === 'string' && id) seen.add(id);
        }
        counts[kind] = seen.size;
        counts.skipped += this.frame.invalid - before;
      }
      if (isObj(st.totals)) this.writeKvRow('totals', { ...emptyUsage(), ...st.totals });
      if (isObj(st.seqByDay)) this.writeKvRow('seqByDay', st.seqByDay);
      if (isObj(st.agentStats)) this.writeKvRow('agentStats', st.agentStats);
      const se = isObj(settings) ? settings : {};
      if (isObj(se.settings)) {
        this.writeKvRow('settings', se.settings);
        counts.settings = true;
      }
      if (Array.isArray(se.providers)) {
        this.writeKvRow('providers', se.providers);
        counts.providers = se.providers.length;
      }
    });
    return counts;
  }

  // ───────────── write-behind ─────────────

  /** Where flush() reads the current values from. Call once after loadState(). */
  bind(source: StoreSource): void {
    this.source = source;
    if (this.pending) this.schedule();
  }

  /** `id` given: write that row (deleted if the source no longer has it). No id: sync the whole collection (see SyncStrategy). */
  markDirty(kind: DocKind, id?: string): void {
    if (this.dropIfClosed()) return;
    if (id === undefined) this.kindDirty.add(kind);
    else {
      let s = this.rowDirty.get(kind);
      if (!s) this.rowDirty.set(kind, (s = new Set()));
      s.add(id);
    }
    this.schedule();
  }

  markKvDirty(...keys: KvKey[]): void {
    if (this.dropIfClosed()) return;
    for (const k of keys) this.kvDirty.add(k);
    this.schedule();
  }

  /** What Runtime.persist() means: every collection (cheap per-kind sync) plus totals / seqByDay / agentStats. */
  markStateDirty(): void {
    if (this.dropIfClosed()) return;
    for (const k of DOC_KINDS) this.kindDirty.add(k);
    for (const k of STATE_KV) this.kvDirty.add(k);
    this.schedule();
  }

  /** What Runtime.saveSettings() means: settings + providers. */
  markSettingsDirty(): void {
    this.markKvDirty(...SETTINGS_KV);
  }

  get pending(): boolean {
    return this.kindDirty.size > 0 || this.kvDirty.size > 0 || [...this.rowDirty.values()].some((s) => s.size > 0);
  }

  private dropIfClosed(): boolean {
    if (!this.isClosed) return false;
    this.counters.droppedAfterClose++;
    return true;
  }

  private schedule(delay = this.debounceMs): void {
    if (this.timer || !this.source || this.isClosed) return; // marks made before bind() are kept and scheduled by bind()
    this.timer = setTimeout(() => {
      this.timer = null;
      try {
        this.flush();
        this.retries = 0;
      } catch (e) {
        this.retries++;
        this.log('error', `[store] flush failed (attempt ${this.retries}): ${(e as Error).message}`);
        if (this.pending && !this.isClosed) this.schedule(Math.min(30_000, 1000 * 2 ** Math.min(this.retries, 5)));
      }
    }, delay);
  }

  /**
   * Write everything marked dirty, in one transaction. `full`: compare every item and kv key against the
   * source regardless of marks (shutdown / safety net). Throws on failure, after restoring the marks.
   */
  flush(opts: { full?: boolean } = {}): FlushResult {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const res: FlushResult = { written: 0, deleted: 0, skipped: 0, ms: 0 };
    if (this.isClosed) return res;
    const full = !!opts.full;
    if (!full && !this.pending) return res;
    if (this.frames.length) throw new Error('SqliteStore.flush() cannot run inside transaction()');
    const src = this.source;
    if (!src) throw new Error('SqliteStore: bind(source) before flush()');
    const rowDirty = this.rowDirty;
    const kindDirty = this.kindDirty;
    const kvDirty = this.kvDirty;
    this.rowDirty = new Map();
    this.kindDirty = new Set();
    this.kvDirty = new Set();
    const t0 = performance.now();
    try {
      const { frame } = this.runTx(() => {
        const keys: KvKey[] = full ? [...STATE_KV, ...(src.settings ? SETTINGS_KV : [])] : [...kvDirty];
        const needState = full || kindDirty.size > 0 || rowDirty.size > 0 || keys.some(isStateKey);
        const st = needState ? src.state() : null;
        for (const kind of DOC_KINDS) {
          const ids = rowDirty.get(kind);
          const whole = full || kindDirty.has(kind);
          if (!whole && !ids?.size) continue;
          const list = asArray<unknown>(st?.[kind]);
          if (whole) this.syncKind(kind, list, full ? 'content' : this.strategies[kind], ids);
          else this.writeIds(kind, list, ids!);
        }
        const se = keys.some((k) => !isStateKey(k)) ? src.settings?.() : undefined;
        for (const key of keys) {
          const value = isStateKey(key) ? st?.[key] : se?.[key];
          if (value !== undefined) this.writeKvRow(key, value);
        }
      });
      res.written = frame.written;
      res.deleted = frame.deleted;
      res.skipped = frame.skipped;
      res.ms = +(performance.now() - t0).toFixed(2);
      this.counters.flushes++;
      this.counters.lastFlushMs = res.ms;
      return res;
    } catch (e) {
      this.counters.failedFlushes++;
      for (const [k, s] of rowDirty) {
        let cur = this.rowDirty.get(k);
        if (!cur) this.rowDirty.set(k, (cur = new Set()));
        for (const id of s) cur.add(id);
      }
      for (const k of kindDirty) this.kindDirty.add(k);
      for (const k of kvDirty) this.kvDirty.add(k);
      throw e;
    }
  }

  stats(): StoreStats {
    return { ...this.counters };
  }

  /** total_changes() of this connection (rows inserted/updated/deleted since open). */
  totalChanges(): number {
    this.assertOpen();
    return Number((this.db.prepare('SELECT total_changes() AS n').get() as { n: number }).n);
  }

  // ───────────── maintenance ─────────────

  /** Copy the WAL back into the main file (TRUNCATE also shrinks the -wal file to zero). */
  checkpoint(mode: 'PASSIVE' | 'FULL' | 'RESTART' | 'TRUNCATE' = 'TRUNCATE'): { busy: number; log: number; checkpointed: number } {
    this.assertOpen();
    const r = this.db.prepare(`PRAGMA wal_checkpoint(${mode})`).get() as { busy: number; log: number; checkpointed: number } | undefined;
    return { busy: Number(r?.busy ?? 0), log: Number(r?.log ?? 0), checkpointed: Number(r?.checkpointed ?? 0) };
  }

  /** PRAGMA quick_check (default) or the slower integrity_check + foreign_key_check (full). */
  integrityCheck(full = false): { ok: boolean; errors: string[] } {
    this.assertOpen();
    try {
      const rows = this.db.prepare(full ? 'PRAGMA integrity_check' : 'PRAGMA quick_check').all() as Record<string, unknown>[];
      const errors = rows.map((r) => String(Object.values(r)[0])).filter((m) => m !== 'ok');
      if (full) for (const r of this.db.prepare('PRAGMA foreign_key_check').all() as Record<string, unknown>[]) errors.push(`foreign key: ${JSON.stringify(r)}`);
      return { ok: errors.length === 0, errors };
    } catch (e) {
      if (isCorruptError(e)) return { ok: false, errors: [(e as Error).message] };
      throw e;
    }
  }

  /** Flush pending marks (best effort), then close. Later marks are ignored. Idempotent. */
  close(): void {
    if (this.isClosed) return;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.pending && this.source) {
      try {
        this.flush();
      } catch (e) {
        this.log('error', `[store] final flush failed: ${(e as Error).message}`);
      }
    }
    this.isClosed = true;
    this.stmts.clear();
    try {
      this.db.close();
    } catch {
      /* ignore */
    }
  }
}

// ───────────────────────── openStateStore: 1.x migration + recovery ─────────────────────────

export const DB_FILE = 'edict.db';
export const LEGACY_FILES = ['state.json', 'settings.json'] as const;
export const BACKUP_PREFIX = 'backup-1.x-';

export interface OpenStateStoreOptions extends SqliteStoreOptions {
  /** Integrity check on open (default 'quick': PRAGMA quick_check, ~15 ms for 40 MB). */
  check?: 'quick' | 'none';
  /** Clock for backup folder names (tests). */
  now?: () => Date;
}

export interface OpenReport {
  dbPath: string;
  /** edict.db did not exist (or was empty) before this open */
  created: boolean;
  /** meta.origin after open: fresh | import:1.x | import:backup | unknown */
  origin: string;
  /** a corrupt edict.db was moved here and a new one created */
  recoveredCorrupt?: string;
  imported?: { from: string; counts: ImportCounts; corrupt: string[] };
  backupDir?: string;
  /** originals renamed to *.migrated (this open) */
  renamed: string[];
  warnings: string[];
  ms: number;
}

interface LegacyFile {
  name: (typeof LEGACY_FILES)[number];
  file: string;
  status: 'missing' | 'ok' | 'corrupt';
  data?: unknown;
  sha256?: string;
  bytes?: number;
  corruptCopy?: string;
}

/** Read a 1.x JSON file the way JsonFile.load() does: a corrupt file is kept as `<file>.corrupt-<ts>` and treated as empty. */
function readLegacy(dir: string, name: LegacyFile['name'], keepCorruptCopy: boolean, fileName: string = name): LegacyFile {
  const file = path.join(dir, fileName);
  let buf: Buffer;
  try {
    buf = fs.readFileSync(file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { name, file, status: 'missing' };
    throw e;
  }
  const out: LegacyFile = { name, file, status: 'ok', sha256: sha256(buf), bytes: buf.length };
  try {
    const data = JSON.parse(buf.toString('utf8'));
    if (!isObj(data)) throw new Error('not a JSON object');
    out.data = data;
  } catch {
    out.status = 'corrupt';
    if (keepCorruptCopy) {
      const copy = `${file}.corrupt-${Date.now()}`;
      try {
        fs.copyFileSync(file, copy);
        out.corruptCopy = copy;
      } catch {
        /* ignore */
      }
    }
  }
  return out;
}

const pad = (n: number) => String(n).padStart(2, '0');
const stamp = (d: Date) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;

function readme(dataDir: string, when: Date, files: LegacyFile[]): string {
  const list = files
    .filter((f) => f.status !== 'missing')
    .map((f) => `  ${f.name.padEnd(14)}${f.name === 'state.json' ? '任务、议政、会话、奏折阁、朱批、新闻与用量统计' : '设置与模型服务配置（不含 API Key，Key 保存在系统钥匙串中）'}${f.status === 'corrupt' ? '（该文件已损坏、无法解析，未导入任何内容）' : ''}\n  ${''.padEnd(14)}${f.bytes} 字节，SHA-256 ${f.sha256}`)
    .join('\n');
  const when2 = `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())} ${pad(when.getHours())}:${pad(when.getMinutes())}:${pad(when.getSeconds())}`;
  return `Edict 1.x 数据备份
==================

本文件夹由 Edict 于 ${when2} 自动创建。

新版 Edict 改用 SQLite 数据库（数据目录中的 edict.db）保存任务、议政、会话、奏折、朱批、新闻、用量统计与设置。
首次启动新版时，旧版（1.x）的 JSON 数据已在一次事务中全部导入 edict.db，原始文件原样复制到了这里：

${list}

同时，数据目录中的原文件已改名为 *.json.migrated，这样旧版程序不会读到过期数据、悄悄与新版数据分叉。
审计日志（audit.jsonl）、活动记录（activity/）、文件快照（blobs/）、协同设计（designs/）与 MCP 配置未做任何改动，新旧版本共用。

数据目录：${dataDir}

如何回滚到 1.x
--------------
1. 完全退出 Edict。
2. 在数据目录中，把 edict.db 以及 edict.db-wal、edict.db-shm（如果存在）移到别处保存。请不要直接删除，以便日后再次升级。
3. 把本文件夹中的 state.json 和 settings.json 复制回数据目录（可同时删除数据目录中的 *.json.migrated）。
4. 启动 Edict 1.x。

注意：
- 回滚后，升级之后在新版中新建或修改的数据不会出现在 1.x 中，它们只保存在 edict.db 里。
- 之后再升级时，如果数据目录里没有 edict.db，新版会重新导入数据目录中的 state.json / settings.json，并再创建一份新的备份。
- 确认新版运行正常后，可以删除本文件夹。
`;
}

/** Copy the originals into a fresh backup-1.x-<stamp>/ (claimed atomically by mkdir) with a README.txt. */
function writeBackup(dataDir: string, files: LegacyFile[], when: Date): string {
  const base = `${BACKUP_PREFIX}${stamp(when)}`;
  for (let n = 1; ; n++) {
    const dir = path.join(dataDir, n === 1 ? base : `${base}-${n}`);
    try {
      fs.mkdirSync(dir);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST' && n < 1000) continue;
      throw e;
    }
    for (const f of files) if (f.status !== 'missing') fs.copyFileSync(f.file, path.join(dir, f.name), fs.constants.COPYFILE_EXCL);
    fs.writeFileSync(path.join(dir, 'README.txt'), readme(dataDir, when, files));
    return dir;
  }
}

/** Newest backup folder (names sort by timestamp), else the *.migrated files left in the data dir. */
function newestLegacySource(dataDir: string): { from: string; files: LegacyFile[] } | null {
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(dataDir);
  } catch {
    return null;
  }
  const isDir = (e: string) => {
    try {
      return fs.statSync(path.join(dataDir, e)).isDirectory();
    } catch {
      return false;
    }
  };
  const dirs = entries.filter((e) => e.startsWith(BACKUP_PREFIX) && isDir(e)).sort((a, b) => b.localeCompare(a, 'en', { numeric: true }));
  for (const d of dirs) {
    const files = LEGACY_FILES.map((n) => readLegacy(path.join(dataDir, d), n, false));
    if (files.some((f) => f.status === 'ok')) return { from: d, files };
  }
  const migrated = LEGACY_FILES.map((n) => readLegacy(dataDir, n, false, `${n}.migrated`));
  if (migrated.some((f) => f.status === 'ok')) return { from: '*.json.migrated', files: migrated };
  return null;
}

function hashFile(file: string): string | null {
  try {
    return sha256(fs.readFileSync(file));
  } catch {
    return null; // gone (renamed by a concurrent open) or unreadable
  }
}

function renameAside(file: string, suffix: string): string | null {
  try {
    fs.renameSync(file, `${file}${suffix}`);
    return `${file}${suffix}`;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; // someone else (another process) already did it
    throw e;
  }
}

/** Move a corrupt db (and its -wal / -shm, which must never be replayed into the new file) aside. */
function moveCorruptAside(dbPath: string): string {
  const aside = `${dbPath}.corrupt-${Date.now()}`;
  fs.renameSync(dbPath, aside);
  for (const ext of ['-wal', '-shm']) {
    try {
      fs.renameSync(dbPath + ext, aside + ext);
    } catch {
      /* not there */
    }
  }
  return aside;
}

const sizeOf = (f: string) => {
  try {
    return fs.statSync(f).size;
  } catch {
    return 0;
  }
};

function describe(c: ImportCounts): string {
  const parts = [`${c.tasks} tasks`, `${c.debates} debates`, `${c.sessions} sessions`, `${c.memorials} memorials`, `${c.annotations} annotations`, `${c.news} news`, `${c.providers} providers`, c.settings ? 'settings' : 'no settings'];
  if (c.skipped) parts.push(`${c.skipped} items without id dropped`);
  return parts.join(', ');
}

/**
 * Open <dataDir>/edict.db for the runtime.
 * - First open over a 1.x data dir (db absent or empty, state.json / settings.json present): import both in one
 *   transaction, copy the originals to backup-1.x-<yyyymmdd-HHMMSS>/ (+ README.txt), rename them to *.migrated.
 * - Corrupt JSON: kept as <file>.corrupt-<ts> (like JsonFile), imported as empty.
 * - Corrupt db: moved aside as edict.db.corrupt-<ts>, recreated, then refilled from the newest 1.x backup if any.
 * - Idempotent: once the db holds data nothing is imported again; an interrupted rename is completed.
 */
export function openStateStore(dataDir: string, opts: OpenStateStoreOptions = {}): SqliteStore {
  const t0 = performance.now();
  const log = opts.log ?? defaultLog;
  const clock = opts.now ?? (() => new Date());
  fs.mkdirSync(dataDir, { recursive: true });
  const dbPath = path.join(dataDir, DB_FILE);
  const report: OpenReport = { dbPath, created: sizeOf(dbPath) === 0, origin: '', renamed: [], warnings: [], ms: 0 };
  const warn = (line: string) => {
    report.warnings.push(line);
    log('warn', line);
  };

  let store: SqliteStore;
  try {
    store = SqliteStore.open(dbPath, opts);
    if ((opts.check ?? 'quick') !== 'none') {
      const ic = store.integrityCheck(false);
      if (!ic.ok) {
        store.close();
        throw new StoreCorruptError(`integrity check failed: ${ic.errors.slice(0, 3).join(' | ').slice(0, 300)}`);
      }
    }
  } catch (e) {
    if (!isCorruptError(e)) throw e;
    const aside = moveCorruptAside(dbPath);
    report.recoveredCorrupt = aside;
    log('error', `[store] ${DB_FILE} is corrupt (${(e as Error).message}); moved aside to ${path.basename(aside)} and recreated`);
    store = SqliteStore.open(dbPath, opts);
  }

  let toRename: LegacyFile[] = [];
  // BEGIN IMMEDIATE: when two processes race, one imports and the other waits, then sees meta.origin.
  store.transaction(() => {
    const origin = store.getMeta('origin');
    const empty = store.isEmpty();
    if ((origin === undefined || origin === 'fresh') && empty) {
      const live = LEGACY_FILES.map((n) => readLegacy(dataDir, n, true));
      if (live.some((f) => f.status !== 'missing')) {
        const when = clock();
        let backupDir: string | undefined;
        try {
          backupDir = writeBackup(dataDir, live, when);
        } catch (e) {
          warn(`[store] could not write the 1.x backup (${(e as Error).message}); originals are left in place`);
        }
        const counts = store.importLegacy(live.find((f) => f.name === 'state.json')?.data, live.find((f) => f.name === 'settings.json')?.data);
        store.setMeta('origin', 'import:1.x');
        store.setMeta('imported_at', String(when.getTime()));
        store.setMeta('import_counts', JSON.stringify(counts));
        if (backupDir) store.setMeta('import_backup', path.basename(backupDir));
        for (const f of live) if (f.sha256) store.setMeta(`import_sha256:${f.name}`, f.sha256);
        const corrupt = live.filter((f) => f.status === 'corrupt').map((f) => f.name);
        report.imported = { from: '1.x JSON', counts, corrupt };
        report.backupDir = backupDir;
        if (backupDir) toRename = live.filter((f) => f.status !== 'missing');
        return;
      }
      if (report.recoveredCorrupt) {
        const src = newestLegacySource(dataDir);
        if (src) {
          const counts = store.importLegacy(src.files.find((f) => f.name === 'state.json')?.data, src.files.find((f) => f.name === 'settings.json')?.data);
          store.setMeta('origin', 'import:backup');
          store.setMeta('imported_at', String(clock().getTime()));
          store.setMeta('import_backup', src.from);
          store.setMeta('import_counts', JSON.stringify(counts));
          report.imported = { from: src.from, counts, corrupt: src.files.filter((f) => f.status === 'corrupt').map((f) => f.name) };
          return;
        }
        warn(`[store] no 1.x backup to recover from; starting with an empty ${DB_FILE} (the corrupt file is kept for diagnosis)`);
      }
      if (origin === undefined) store.setMeta('origin', 'fresh');
      return;
    }
    if (origin === undefined) store.setMeta('origin', 'unknown'); // has data but predates origin bookkeeping
  });

  // after commit: retire the originals so a 1.x build cannot silently diverge
  for (const f of toRename) if (renameAside(f.file, '.migrated')) report.renamed.push(f.name);

  // already migrated: finish an interrupted rename, or explain a stray state.json
  const origin = store.getMeta('origin') ?? '';
  if (!report.imported) {
    for (const name of LEGACY_FILES) {
      const file = path.join(dataDir, name);
      const h = hashFile(file);
      if (h === null) continue;
      if (origin === 'import:1.x' && h === store.getMeta(`import_sha256:${name}`)) {
        const b = store.getMeta('import_backup');
        if (!b || !fs.existsSync(path.join(dataDir, b, name))) {
          const dir = writeBackup(dataDir, [readLegacy(dataDir, name, false)], clock());
          store.setMeta('import_backup', path.basename(dir));
        }
        if (renameAside(file, '.migrated')) report.renamed.push(name);
      } else {
        warn(`[store] ignoring ${name}: ${DB_FILE} already holds the data (origin ${origin}); this file was probably written by a 1.x build after the upgrade — see backup-1.x-*/README.txt`);
      }
    }
  }

  report.origin = origin;
  report.ms = +(performance.now() - t0).toFixed(1);
  store.openReport = report;
  if (report.imported) {
    const corrupt = report.imported.corrupt.length ? `; corrupt (imported as empty, copy kept): ${report.imported.corrupt.join(', ')}` : '';
    const where = report.backupDir ? `; backup: ${path.basename(report.backupDir)}` : '';
    const renamed = report.renamed.length ? `; originals renamed to *.migrated` : '';
    log('info', `[store] migrated ${report.imported.from} → ${DB_FILE} in ${report.ms} ms: ${describe(report.imported.counts)}${corrupt}${where}${renamed}`);
  } else if (report.renamed.length) {
    log('info', `[store] finished an interrupted 1.x migration: renamed ${report.renamed.join(', ')} to *.migrated`);
  }
  return store;
}
