// Shadow git snapshots (R7): what a shell command changed on disk. One independent git repo per workspace root
// lives in <dataDir>/snapshots/<sha256(root)[:16]> and is run with GIT_DIR=<shadow> GIT_WORK_TREE=<root>, so it
// works whether or not the workspace is itself a git repo and never touches the workspace's own .git.
// A snapshot is `git add -A` + `git write-tree`; two snapshots diffed give the files a command touched.
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { safeEnv } from './exec';
import { IGNORE_DIRS } from './workspace';

/** content above the size cap (or past the per-command budget): the file is listed, its bytes are not kept */
export const OVERSIZE = 'oversize' as const;
export type SnapContent = Buffer | null | typeof OVERSIZE;

export interface ShadowChange {
  path: string; // workspace-relative, '/' separated
  before: SnapContent; // null = did not exist
  after: SnapContent; // null = gone now
}

export interface ShadowSnap {
  root: string;
  dir: string;
  tree: string;
  pin: string; // ref that keeps the tree alive through gc until release()
}

export interface SnapshotLimits {
  maxFileBytes: number; // larger files get a stub (size + mtime) instead of their content
  maxFiles: number; // more files than this → snapshots off for that root
  maxRepoBytes: number; // shadow repo size cap; gc at 80%, off when still over after gc
  maxChanges: number; // per command, recorded change entries
  maxContentBytes: number; // per command, bytes of before + after content kept
}

export const DEFAULT_LIMITS: SnapshotLimits = { maxFileBytes: 2 * 1024 * 1024, maxFiles: 20_000, maxRepoBytes: 512 * 1024 * 1024, maxChanges: 500, maxContentBytes: 64 * 1024 * 1024 };

export interface AroundResult<T> {
  result: T;
  /** both snapshots taken and diffed */
  tracked: boolean;
  changes: ShadowChange[];
  /** changed files found (may exceed changes.length when truncated) */
  total: number;
  truncated: boolean;
  /** why nothing was tracked (disabled for this root, git missing, snapshot error) */
  note?: string;
}

// dependency / cache / build dirs (the explorer's IGNORE_DIRS plus a few more) and key files never enter the shadow repo
const HEAVY_DIRS = [...new Set([...IGNORE_DIRS, '.hg', '.svn', 'bower_components', 'jspm_packages', '.tox', '.mypy_cache', '.pytest_cache', '.ruff_cache', '.svelte-kit', '.parcel-cache', '.gradle', '.build', '.terraform', '.dart_tool', '.angular', '.expo'])];
const SENSITIVE = ['.env*', '*.pem', '*.key', '*.p12', '*.keystore', 'id_rsa', 'credentials'];
const STUB_MAGIC = 'edict-shadow:oversize\n';
const ZERO = '0000000000000000000000000000000000000000';
const CONFIG_MARK = '# edict-shadow v1';
const CONFIG_BLOCK = `\n${CONFIG_MARK}\n[core]\n\tautocrlf = false\n\tsafecrlf = false\n\tfsmonitor = false\n\tuntrackedCache = false\n\tquotepath = false\n\tlongpaths = true\n[gc]\n\tauto = 0\n\tpackRefs = false\n[advice]\n\taddEmbeddedRepo = false\n\taddIgnoredFile = false\n`;
const REGULAR = new Set(['100644', '100755']);

class GitError extends Error {
  constructor(msg: string, readonly code: number | null, readonly missing = false) {
    super(msg);
  }
}

export class ShadowSnapshots {
  readonly limits: SnapshotLimits;
  private readonly baseDir: string;
  private readonly audit: (action: string, detail: Record<string, unknown>) => void;
  private queues = new Map<string, Promise<unknown>>();
  private ready = new Set<string>();
  /** shadow dir → reason snapshots are off for that root (this process) */
  private off = new Map<string, string>();
  private gitMissing = false;

  constructor(baseDir: string, o: { audit?: (action: string, detail: Record<string, unknown>) => void; limits?: Partial<SnapshotLimits> } = {}) {
    this.baseDir = baseDir;
    this.audit = o.audit ?? (() => {});
    this.limits = { ...DEFAULT_LIMITS, ...o.limits };
  }

  dirFor(root: string): string {
    return path.join(this.baseDir, createHash('sha256').update(path.resolve(root)).digest('hex').slice(0, 16));
  }

  /** Why snapshots are off for `root` in this session, or null. */
  disabled(root: string): string | null {
    if (this.gitMissing) return '本机未找到 git';
    return this.off.get(this.dirFor(root)) ?? null;
  }

  /**
   * Snapshot before and after `run`, then diff. Snapshot trouble never fails `run`: it still runs and the
   * result says why nothing was tracked. Anything that changed files in the window is attributed to `run`
   * (a human edit, or another edict's command on the same root, made meanwhile included).
   */
  async around<T>(root: string, run: () => Promise<T>): Promise<AroundResult<T>> {
    const none = (result: T, note?: string): AroundResult<T> => ({ result, tracked: false, changes: [], total: 0, truncated: false, note });
    let before: ShadowSnap | null = null;
    let note: string | undefined;
    try {
      before = await this.take(root);
      if (!before) note = this.disabled(root) ?? '快照已停用';
    } catch (e) {
      note = `快照失败：${errText(e)}`;
    }
    if (!before) return none(await run(), note);
    let after: ShadowSnap | null = null;
    try {
      const result = await run();
      try {
        after = await this.take(root);
        if (!after) return none(result, this.disabled(root) ?? '快照已停用');
        const d = await this.diff(before, after);
        return { result, tracked: true, ...d };
      } catch (e) {
        return none(result, `快照失败：${errText(e)}`);
      }
    } finally {
      await this.release(before, after).catch(() => {});
    }
  }

  /** Snapshot of the workspace now (pinned until release), or null when snapshots are off for this root. */
  async take(root: string): Promise<ShadowSnap | null> {
    const dir = this.dirFor(root);
    if (this.disabled(root)) return null;
    return this.lock(dir, async () => {
      if (this.disabled(root)) return null;
      await this.init(dir, root);
      const L = this.limits;
      // H/S/M… = in the shadow index, ? = new (not ignored), C = changed since the last snapshot (also listed as H)
      const listed = split0(await this.git(dir, root, ['ls-files', '-z', '-t', '--cached', '--others', '--modified', '--exclude-standard']));
      let files = 0;
      const cand = new Set<string>();
      for (const e of listed) {
        const tag = e[0];
        const p = e.slice(2);
        if (tag !== 'C') files++;
        if (tag === '?' || tag === 'C') cand.add(p);
      }
      if (files > L.maxFiles) return this.disable(dir, root, `工作区文件过多（${files} 个，上限 ${L.maxFiles}），命令改动不做快照`, { files });
      const large: { p: string; size: number; mtime: number }[] = [];
      let incoming = 0;
      for (const p of cand) {
        try {
          const st = fs.lstatSync(path.join(root, p));
          if (!st.isFile()) continue;
          if (st.size > L.maxFileBytes) large.push({ p, size: st.size, mtime: Math.round(st.mtimeMs) });
          else incoming += st.size;
        } catch {
          /* deleted since */
        }
      }
      if (incoming > L.maxRepoBytes) return this.disable(dir, root, `待快照内容过大（${mb(incoming)}，上限 ${mb(L.maxRepoBytes)}），命令改动不做快照`, { bytes: incoming });
      // files the workspace's .gitignore now ignores leave the snapshot (tracked entries would otherwise stick)
      const ignored = split0(await this.git(dir, root, ['ls-files', '-z', '--cached', '--ignored', '--exclude-standard']));
      if (ignored.length) await this.git(dir, root, ['--literal-pathspecs', 'rm', '--cached', '-q', '--ignore-unmatch', '--pathspec-from-file=-', '--pathspec-file-nul'], { input: ignored.join('\0') + '\0' });
      // --ignore-errors: unreadable files and embedded repos without a commit are skipped (exit 1), not fatal
      const spec = ['.', ...large.map((f) => `:(exclude,literal)${f.p}`)];
      await this.git(dir, root, ['add', '-A', '--ignore-errors', '--pathspec-from-file=-', '--pathspec-file-nul'], { input: spec.join('\0') + '\0', ok: [0, 1] });
      if (large.length) {
        // big files are represented by a stub (size + mtime): a change still shows up, the bytes are never copied
        const stubDir = path.join(dir, 'edict-stubs');
        fs.rmSync(stubDir, { recursive: true, force: true });
        fs.mkdirSync(stubDir, { recursive: true });
        const stubs = large.map((f, i) => {
          const sp = path.join(stubDir, String(i));
          fs.writeFileSync(sp, `${STUB_MAGIC}size=${f.size}\nmtime=${f.mtime}\n`);
          return sp;
        });
        const shas = (await this.git(dir, root, ['hash-object', '-w', '--no-filters', '--stdin-paths'], { input: stubs.join('\n') + '\n' })).toString().trim().split('\n');
        await this.git(dir, root, ['update-index', '-z', '--index-info'], { input: large.map((f, i) => `100644 ${shas[i]}\t${f.p}\0`).join('') });
        fs.rmSync(stubDir, { recursive: true, force: true });
      }
      const tree = (await this.git(dir, root, ['write-tree'])).toString().trim();
      const pin = `refs/edict/${Date.now().toString(36)}${randomBytes(4).toString('hex')}`;
      await this.git(dir, root, ['update-ref', pin, tree]);
      return { root, dir, tree, pin };
    });
  }

  /** Files that differ between two snapshots: before content from the shadow repo, after content from disk. */
  async diff(a: ShadowSnap, b: ShadowSnap): Promise<{ changes: ShadowChange[]; total: number; truncated: boolean }> {
    if (a.tree === b.tree) return { changes: [], total: 0, truncated: false };
    const L = this.limits;
    return this.lock(a.dir, async () => {
      const tok = split0(await this.git(a.dir, a.root, ['diff-tree', '-r', '--no-renames', '--raw', '-z', a.tree, b.tree]));
      let entries: { path: string; oldSha: string }[] = [];
      for (let i = 0; i + 1 < tok.length; i += 2) {
        const [om, nm, os, ns] = tok[i].slice(1).split(' ');
        // regular files only (symlinks and embedded repos are not tracked); mode-only changes carry no content change
        if ((om !== '000000' && !REGULAR.has(om)) || (nm !== '000000' && !REGULAR.has(nm)) || os === ns) continue;
        if (tok[i + 1].includes('�')) continue; // name is not valid UTF-8: cannot be addressed on disk reliably
        entries.push({ path: tok[i + 1], oldSha: os });
      }
      const total = entries.length;
      const truncated = total > L.maxChanges;
      if (truncated) entries = entries.slice(0, L.maxChanges);
      let budget = L.maxContentBytes;
      const wanted = [...new Set(entries.filter((e) => e.oldSha !== ZERO).map((e) => e.oldSha))];
      const sizes = new Map<string, number>();
      if (wanted.length) {
        for (const line of (await this.git(a.dir, a.root, ['cat-file', '--batch-check'], { input: wanted.join('\n') + '\n' })).toString().split('\n')) {
          const [sha, type, size] = line.split(' ');
          if (type === 'blob') sizes.set(sha, +size);
        }
      }
      const fetch: string[] = [];
      for (const sha of wanted) {
        const n = sizes.get(sha);
        if (n === undefined || n > L.maxFileBytes || n > budget) continue;
        budget -= n;
        fetch.push(sha);
      }
      const blobs = fetch.length ? parseBatch(await this.git(a.dir, a.root, ['cat-file', '--batch'], { input: fetch.join('\n') + '\n' })) : new Map<string, Buffer>();
      const realRoot = fs.realpathSync(a.root);
      const changes: ShadowChange[] = [];
      for (const e of entries) {
        let before: SnapContent = null;
        if (e.oldSha !== ZERO) {
          const buf = blobs.get(e.oldSha);
          before = !buf || isStub(buf) ? OVERSIZE : buf;
        }
        const disk = readDisk(realRoot, a.root, e.path, L.maxFileBytes, budget);
        if (disk === undefined) continue; // no longer a regular file inside the workspace
        if (Buffer.isBuffer(disk)) budget -= disk.length;
        const after = disk;
        if (before === null && after === null) continue;
        if (Buffer.isBuffer(before) && Buffer.isBuffer(after) && before.equals(after)) continue;
        changes.push({ path: e.path, before, after });
      }
      return { changes, total, truncated };
    });
  }

  /** Drop the pins; gc the shadow repo once it passes 80% of its cap (pinned in-flight trees survive). */
  async release(...snaps: (ShadowSnap | null)[]): Promise<void> {
    const list = snaps.filter((s): s is ShadowSnap => !!s);
    if (!list.length) return;
    const { dir, root } = list[0];
    await this.lock(dir, async () => {
      if (!fs.existsSync(dir)) return;
      await this.git(dir, root, ['update-ref', '--stdin'], { input: list.map((s) => `delete ${s.pin}\n`).join('') });
      const size = await this.repoBytes(dir, root);
      if (size <= this.limits.maxRepoBytes * 0.8) return;
      await this.git(dir, root, ['gc', '--prune=now', '--quiet'], { timeoutMs: 600_000 });
      const after = await this.repoBytes(dir, root);
      this.audit('snapshot_gc', { root, beforeBytes: size, afterBytes: after });
      if (after > this.limits.maxRepoBytes) this.disable(dir, root, `快照仓库超过大小上限（${mb(after)} / ${mb(this.limits.maxRepoBytes)}），命令改动不做快照`, { bytes: after });
    });
  }

  /** Bytes the shadow repo uses (loose + packed objects). */
  async repoBytes(dir: string, root: string): Promise<number> {
    const out = (await this.git(dir, root, ['count-objects', '-v'])).toString();
    const kib = (k: string) => +(out.match(new RegExp(`^${k}: (\\d+)`, 'm'))?.[1] ?? 0);
    return (kib('size') + kib('size-pack') + kib('size-garbage')) * 1024;
  }

  // ───────────────────────── internals ─────────────────────────
  private disable(dir: string, root: string, reason: string, detail: Record<string, unknown> = {}): null {
    if (!this.off.has(dir)) this.audit('snapshot_disabled', { root, reason, ...detail });
    this.off.set(dir, reason);
    this.ready.delete(dir);
    fs.rmSync(dir, { recursive: true, force: true });
    return null;
  }

  private async init(dir: string, root: string) {
    if (this.ready.has(dir)) return;
    fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(path.join(dir, 'HEAD'))) await this.git(dir, root, ['init', '--quiet'], { noWorkTree: true });
    const cfg = path.join(dir, 'config');
    if (!fs.readFileSync(cfg, 'utf8').includes(CONFIG_MARK)) fs.appendFileSync(cfg, CONFIG_BLOCK);
    fs.mkdirSync(path.join(dir, 'info'), { recursive: true });
    const exclude = [...HEAVY_DIRS.map((d) => `${d}/`), ...SENSITIVE, '.DS_Store'];
    // the app's own data dir must never be snapshotted into itself
    const data = path.relative(path.resolve(root), path.dirname(path.resolve(this.baseDir)));
    if (data && !data.startsWith('..') && !path.isAbsolute(data)) exclude.push(`/${data.split(path.sep).join('/')}/`);
    fs.writeFileSync(path.join(dir, 'info', 'exclude'), `# written by Edict\n${exclude.join('\n')}\n`);
    // raw bytes: no EOL conversion, clean/smudge (LFS) or ident filters from the workspace's .gitattributes
    fs.writeFileSync(path.join(dir, 'info', 'attributes'), '* -text -filter -ident -eol -working-tree-encoding\n');
    fs.writeFileSync(path.join(dir, 'edict-root'), path.resolve(root) + '\n');
    // nothing is in flight when a process first opens the repo: clear crash leftovers
    fs.rmSync(path.join(dir, 'index.lock'), { force: true });
    fs.rmSync(path.join(dir, 'refs', 'edict'), { recursive: true, force: true });
    this.ready.add(dir);
  }

  /** In-process mutex per shadow repo: parallel calls never race on index.lock. */
  private lock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.queues.get(key) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.catch(() => {});
    this.queues.set(key, tail);
    void tail.then(() => {
      if (this.queues.get(key) === tail) this.queues.delete(key);
    });
    return run;
  }

  private git(dir: string, root: string, args: string[], o: { input?: string; ok?: number[]; timeoutMs?: number; noWorkTree?: boolean } = {}): Promise<Buffer> {
    const env = safeEnv();
    for (const k of Object.keys(env)) if (k.startsWith('GIT_')) delete env[k];
    Object.assign(env, { GIT_DIR: dir, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', LC_ALL: 'C' }, o.noWorkTree ? {} : { GIT_WORK_TREE: root });
    return new Promise((resolve, reject) => {
      const child = spawn('git', args, { cwd: o.noWorkTree ? dir : root, env, stdio: ['pipe', 'pipe', 'pipe'] });
      const out: Buffer[] = [];
      let err = '';
      let done = false;
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        finish(new GitError(`git ${args[0]} 超时`, null));
      }, o.timeoutMs ?? 120_000);
      const finish = (e: Error | null) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (e) reject(e);
        else resolve(Buffer.concat(out));
      };
      child.stdout.on('data', (d: Buffer) => out.push(d));
      child.stderr.on('data', (d: Buffer) => {
        if (err.length < 4000) err += d.toString();
      });
      child.on('error', (e: NodeJS.ErrnoException) => {
        if (e.code === 'ENOENT') {
          if (!this.gitMissing) this.audit('snapshot_disabled', { reason: '本机未找到 git，命令改动不做快照' });
          this.gitMissing = true;
        }
        finish(new GitError(e.code === 'ENOENT' ? '本机未找到 git' : e.message, null, e.code === 'ENOENT'));
      });
      child.on('close', (code) => finish((o.ok ?? [0]).includes(code ?? -1) ? null : new GitError(`git ${args.find((x) => !x.startsWith('-')) ?? ''} 失败（${code}）：${err.trim().slice(0, 300)}`, code)));
      child.stdin.on('error', () => {}); // git may exit before reading all input
      child.stdin.end(o.input ?? '');
    });
  }
}

const split0 = (b: Buffer) => b.toString('utf8').split('\0').filter(Boolean);
const mb = (n: number) => `${(n / 1024 / 1024).toFixed(n >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
const errText = (e: unknown) => ((e as Error)?.message ?? String(e)).slice(0, 300);
const isStub = (b: Buffer) => b.length < 200 && b.subarray(0, STUB_MAGIC.length).toString() === STUB_MAGIC;

/** `git cat-file --batch` output → sha → content */
function parseBatch(buf: Buffer): Map<string, Buffer> {
  const m = new Map<string, Buffer>();
  let i = 0;
  while (i < buf.length) {
    const nl = buf.indexOf(0x0a, i);
    if (nl < 0) break;
    const [sha, type, size] = buf.subarray(i, nl).toString().split(' ');
    i = nl + 1;
    if (type === 'missing' || size === undefined) continue;
    const n = +size;
    m.set(sha, buf.subarray(i, i + n));
    i += n + 1;
  }
  return m;
}

/**
 * Current content of `rel`: null when gone, OVERSIZE past the caps, undefined when it is not a regular file
 * or resolves outside the workspace (a command may have swapped a directory for a symlink).
 */
function readDisk(realRoot: string, root: string, rel: string, maxBytes: number, budget: number): SnapContent | undefined {
  const abs = path.join(root, rel);
  let st: fs.Stats;
  try {
    st = fs.lstatSync(abs);
  } catch {
    return null;
  }
  if (!st.isFile()) return undefined;
  try {
    const dirReal = fs.realpathSync(path.dirname(abs));
    const r = path.relative(realRoot, dirReal);
    if (r.startsWith('..') || path.isAbsolute(r)) return undefined;
  } catch {
    return undefined;
  }
  if (st.size > maxBytes || st.size > budget) return OVERSIZE;
  try {
    return fs.readFileSync(abs);
  } catch {
    return null;
  }
}
