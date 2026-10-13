// Git worktree plumbing for per-edict worktrees and the Source Control view. No runtime state here:
// every function runs git in the given directory and reports in Chinese. The main checkout is only ever
// changed by mergeBranch (and only after a conflict-free dry run when git can do one).
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runGit } from './git';
import { safeEnv } from './exec';

/** Untracked dependency folders symlinked from the main checkout so builds / tests work in a fresh worktree. */
export const DEP_LINKS = ['node_modules', '.venv', 'venv'];

type GitResult = Awaited<ReturnType<typeof runGit>>;

export class GitError extends Error {}

const errText = (r: GitResult) => (r.err || r.out).trim().split('\n').filter(Boolean).slice(0, 8).join('\n') || `退出码 ${r.code}`;
const nulList = (s: string) => s.split('\0').filter(Boolean);

async function must(cwd: string, args: string[], what: string): Promise<string> {
  const r = await runGit(cwd, args);
  if (r.code !== 0) throw new GitError(`${what}失败：${errText(r)}`);
  return r.out;
}

/** Real path when it exists (git reports real paths: /private/var vs /var on macOS). */
export function realPath(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

/** Repository holding `dir`: its toplevel, HEAD commit (null = no commits yet) and checked-out branch. null = not a git repo. */
export async function repoOf(dir: string): Promise<{ root: string; head: string | null; branch: string | null } | null> {
  if (!fs.existsSync(dir)) return null;
  const top = await runGit(dir, ['rev-parse', '--show-toplevel']);
  if (top.code !== 0 || !top.out.trim()) return null;
  const head = await runGit(dir, ['rev-parse', '--verify', '-q', 'HEAD^{commit}']);
  const br = await runGit(dir, ['symbolic-ref', '--short', '-q', 'HEAD']);
  return { root: top.out.trim(), head: head.code === 0 ? head.out.trim() : null, branch: br.code === 0 ? br.out.trim() || null : null };
}

/** Uncommitted entries of a checkout (tracked changes and untracked files), minus the given relative paths. */
export async function dirtyFiles(dir: string, ignore: string[] = []): Promise<string[]> {
  const r = await runGit(dir, ['status', '--porcelain=v1', '-z']);
  if (r.code !== 0) return [];
  const parts = r.out.split('\0');
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p.length < 4) continue;
    if (p[0] === 'R' || p[0] === 'C') i++; // skip the original path
    const f = p.slice(3);
    if (!ignore.includes(f.replace(/\/$/, ''))) out.push(f);
  }
  return out;
}

export async function branchExists(repo: string, branch: string): Promise<boolean> {
  return (await runGit(repo, ['show-ref', '--verify', '-q', `refs/heads/${branch}`])).code === 0;
}

export async function validBranchName(repo: string, branch: string): Promise<boolean> {
  return !!branch && !branch.startsWith('-') && (await runGit(repo, ['check-ref-format', '--branch', branch])).code === 0;
}

export async function resolveCommit(repo: string, rev: string): Promise<string | null> {
  if (!rev || rev.startsWith('-')) return null;
  const r = await runGit(repo, ['rev-parse', '--verify', '-q', `${rev}^{commit}`]);
  return r.code === 0 ? r.out.trim() : null;
}

/** `git worktree add` on a new branch from `base`, or on an existing branch when `base` is null. */
export async function addWorktree(repo: string, dir: string, branch: string, base: string | null): Promise<void> {
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  await must(repo, base ? ['worktree', 'add', '-b', branch, dir, base] : ['worktree', 'add', dir, branch], '创建工作树');
}

const lexists = (p: string) => {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
};

/** Symlink dependency folders present in `from` but absent in `to`. Returns the linked names. */
export function linkDeps(from: string, to: string): string[] {
  const linked: string[] = [];
  for (const n of DEP_LINKS) {
    const src = path.join(from, n);
    const dst = path.join(to, n);
    try {
      if (!fs.statSync(src).isDirectory() || lexists(dst)) continue;
      fs.symlinkSync(src, dst, 'dir');
      linked.push(n);
    } catch {
      /* missing or not linkable: builds just won't find it */
    }
  }
  return linked;
}

/** Remove our dependency symlinks (never what they point to). */
export function unlinkDeps(dir: string, links: string[] = []) {
  for (const l of links) {
    const p = path.join(dir, l);
    try {
      if (fs.lstatSync(p).isSymbolicLink()) fs.unlinkSync(p);
    } catch {
      /* gone */
    }
  }
}

/** Commit identity fallback for machines without user.name / user.email (git refuses to commit otherwise). */
async function identity(dir: string): Promise<string[]> {
  const name = (await runGit(dir, ['config', 'user.name'])).out.trim();
  const email = (await runGit(dir, ['config', 'user.email'])).out.trim();
  return [...(name ? [] : ['-c', 'user.name=Edict']), ...(email ? [] : ['-c', 'user.email=edict@localhost'])];
}

/** Stage everything in a worktree except our links and commit. commit = null when there was nothing to commit. */
export async function commitAll(dir: string, message: string, links: string[] = []): Promise<{ commit: string | null; files: string[] }> {
  await must(dir, ['add', '-A', '--', '.', ...links.map((l) => `:(exclude)${l}`)], '暂存改动');
  const files = nulList((await runGit(dir, ['diff', '--cached', '--name-only', '-z'])).out);
  if (!files.length) return { commit: null, files };
  await must(dir, [...(await identity(dir)), 'commit', '-q', '-m', message], '提交改动');
  return { commit: (await must(dir, ['rev-parse', 'HEAD'], '读取提交')).trim(), files };
}

/** A merge / rebase / cherry-pick the user left unfinished in this checkout. */
async function operationInProgress(repo: string): Promise<string | null> {
  for (const [ref, what] of [['MERGE_HEAD', '合并'], ['CHERRY_PICK_HEAD', '拣选（cherry-pick）'], ['REVERT_HEAD', '还原（revert）']] as const) {
    if ((await runGit(repo, ['rev-parse', '-q', '--verify', ref])).code === 0) return what;
  }
  for (const d of ['rebase-merge', 'rebase-apply']) {
    const p = (await runGit(repo, ['rev-parse', '--git-path', d])).out.trim();
    if (p && fs.existsSync(path.resolve(repo, p))) return '变基（rebase）';
  }
  return null;
}

/** Files git names under "would be overwritten by merge" (tab-indented lines). */
function blockedFiles(text: string): string[] {
  return [...new Set(text.split('\n').filter((l) => l.startsWith('\t')).map((l) => l.trim()).filter(Boolean))];
}

export type MergeOutcome =
  | { ok: true; mergeCommit: string | null; files: string[] }
  | { ok: false; reason: 'conflict' | 'dirty' | 'busy' | 'error'; files: string[]; message: string };

/**
 * `git merge --no-ff <branch>` in the main checkout. Conflicts are found with a dry run (git ≥ 2.38, nothing
 * touched); otherwise a conflicted merge is aborted at once. A merge git refuses (local changes or untracked
 * files in the way) changes nothing. The user's own unfinished merge / rebase is never touched.
 */
export async function mergeBranch(repo: string, branch: string, message: string, o: { dryRun?: boolean } = {}): Promise<MergeOutcome> {
  const busy = await operationInProgress(repo);
  if (busy) return { ok: false, reason: 'busy', files: [], message: `主工作区有尚未完成的${busy}，请先完成或中止它再合并` };
  if ((await runGit(repo, ['symbolic-ref', '-q', 'HEAD'])).code !== 0) return { ok: false, reason: 'busy', files: [], message: '主工作区处于游离 HEAD（detached HEAD）状态：请先切换到要并入的分支再合并' };
  const ahead = await runGit(repo, ['rev-list', '--count', `HEAD..${branch}`]);
  if (ahead.code !== 0) return { ok: false, reason: 'error', files: [], message: `无法读取分支 ${branch}：${errText(ahead)}` };
  if (+ahead.out.trim() === 0) return { ok: true, mergeCommit: null, files: [] };
  const files = nulList((await runGit(repo, ['diff', '--name-only', '-z', `HEAD...${branch}`])).out);
  const dry = o.dryRun === false ? null : await runGit(repo, ['merge-tree', '--write-tree', '--name-only', '--no-messages', 'HEAD', branch]);
  if (dry?.code === 1) {
    const c = [...new Set(dry.out.split('\n').slice(1).map((l) => l.trim()).filter(Boolean))];
    return { ok: false, reason: 'conflict', files: c, message: `合并会产生冲突：${c.join('、') || '（git 未列出文件）'}` };
  }
  const r = await runGit(repo, [...(await identity(repo)), 'merge', '--no-ff', '--no-edit', '-m', message, branch]);
  if (r.code === 0) return { ok: true, mergeCommit: (await must(repo, ['rev-parse', 'HEAD'], '读取合并提交')).trim(), files };
  if ((await runGit(repo, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'])).code === 0) {
    const c = nulList((await runGit(repo, ['diff', '--name-only', '--diff-filter=U', '-z'])).out);
    const ab = await runGit(repo, ['merge', '--abort']);
    return { ok: false, reason: 'conflict', files: c, message: `合并冲突：${c.join('、') || '（git 未列出文件）'}，已中止合并${ab.code ? `（中止失败，请手动处理：${errText(ab)}）` : ''}` };
  }
  const blocked = blockedFiles(`${r.err}\n${r.out}`);
  return blocked.length
    ? { ok: false, reason: 'dirty', files: blocked, message: `主工作区未提交的改动或未跟踪文件会被合并覆盖：${blocked.join('、')}` }
    : { ok: false, reason: 'error', files: [], message: `合并失败：${errText(r)}` };
}

/** Remove a worktree (and its directory). A directory git no longer knows is deleted only when `managed`. */
export async function removeWorktree(repo: string, dir: string, o: { force?: boolean; managed?: boolean } = {}): Promise<void> {
  const r = await runGit(repo, ['worktree', 'remove', ...(o.force ? ['--force', '--force'] : []), dir]);
  if (r.code === 0) return;
  if (fs.existsSync(dir) && o.managed) {
    // our own directory that git no longer lists (e.g. its .git file was damaged): delete it
    const known = (await listWorktrees(repo).catch(() => [])).some((w) => realPath(w.path) === realPath(dir));
    if (!known) fs.rmSync(dir, { recursive: true, force: true });
  }
  if (fs.existsSync(dir)) throw new GitError(`移除工作树失败：${errText(r)}`);
  await prune(repo);
}

export async function deleteBranch(repo: string, branch: string, force: boolean): Promise<{ ok: boolean; message: string }> {
  if (!(await branchExists(repo, branch))) return { ok: true, message: `分支 ${branch} 已不存在` };
  const r = await runGit(repo, ['branch', force ? '-D' : '-d', branch]);
  return r.code === 0 ? { ok: true, message: `已删除分支 ${branch}` } : { ok: false, message: `删除分支 ${branch} 失败：${errText(r)}` };
}

export async function prune(repo: string): Promise<void> {
  await runGit(repo, ['worktree', 'prune']);
}

export interface PorcelainWorktree {
  path: string;
  head: string;
  branch: string | null;
  bare: boolean;
  locked: boolean;
  prunable: boolean;
}

/** `git worktree list --porcelain`; the first entry is the main working tree. */
export async function listWorktrees(repo: string): Promise<PorcelainWorktree[]> {
  const out = await must(repo, ['worktree', 'list', '--porcelain'], '读取工作树列表');
  const list: PorcelainWorktree[] = [];
  let cur: PorcelainWorktree | null = null;
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) {
      cur = { path: line.slice(9), head: '', branch: null, bare: false, locked: false, prunable: false };
      list.push(cur);
    } else if (!cur) continue;
    else if (line.startsWith('HEAD ')) cur.head = line.slice(5);
    else if (line.startsWith('branch ')) cur.branch = line.slice(7).replace(/^refs\/heads\//, '');
    else if (line === 'bare') cur.bare = true;
    else if (line === 'locked' || line.startsWith('locked ')) cur.locked = true;
    else if (line === 'prunable' || line.startsWith('prunable ')) cur.prunable = true;
  }
  return list;
}

export interface DiffStatFile {
  path: string;
  added: number;
  removed: number;
  binary?: boolean;
  /** untracked in the worktree (new file not yet committed) */
  untracked?: boolean;
}

/**
 * Lines added / removed per file for the 结案 dialog. With `dir` (the worktree still exists): everything in it
 * against `base`, committed or not, untracked files counted line by line (links excluded). Without `dir`
 * (a kept branch): `base...branch` in the repository.
 */
export async function diffStat(o: { repo: string; base: string; branch: string; dir?: string; links?: string[] }): Promise<DiffStatFile[]> {
  const out = new Map<string, DiffStatFile>();
  const parse = (txt: string) => {
    for (const line of txt.split('\n')) {
      const m = line.match(/^(-|\d+)\t(-|\d+)\t(.+)$/);
      if (!m) continue;
      const bin = m[1] === '-';
      out.set(m[3], { path: m[3], added: bin ? 0 : Number(m[1]), removed: bin ? 0 : Number(m[2]), ...(bin ? { binary: true } : {}) });
    }
  };
  if (o.dir && fs.existsSync(o.dir)) {
    parse((await runGit(o.dir, ['diff', '--numstat', o.base, '--'])).out);
    const links = new Set(o.links ?? []);
    const untracked = nulList((await runGit(o.dir, ['ls-files', '--others', '--exclude-standard', '-z'])).out).filter((f) => ![...links].some((l) => f === l || f.startsWith(`${l}/`)));
    for (const f of untracked.slice(0, 500)) {
      let added = 0;
      let binary = false;
      try {
        const st = fs.statSync(path.join(o.dir, f));
        if (st.size > 2_000_000) binary = true;
        else {
          const buf = fs.readFileSync(path.join(o.dir, f));
          if (buf.includes(0)) binary = true;
          else added = buf.length ? buf.toString('utf8').split('\n').length - (buf[buf.length - 1] === 10 ? 1 : 0) : 0;
        }
      } catch {
        continue;
      }
      out.set(f, { path: f, added, removed: 0, untracked: true, ...(binary ? { binary } : {}) });
    }
  } else {
    parse((await runGit(o.repo, ['diff', '--numstat', `${o.base}...${o.branch}`, '--'])).out);
  }
  return [...out.values()].sort((a, b) => a.path.localeCompare(b.path));
}

// ───────────────────────── 排班 (2.1): snapshots and lane diffs ─────────────────────────
const excludes = (links: string[]) => links.map((l) => `:(exclude)${l}`);

/**
 * Tree of everything in a worktree as it is now (tracked and untracked, ignored files and our links left out),
 * written through a throwaway index: the worktree's own index, branch and files are not touched.
 */
export async function snapshotTree(dir: string, links: string[] = []): Promise<string> {
  const idx = path.join(os.tmpdir(), `edict-index-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
  const env = { GIT_INDEX_FILE: idx };
  const step = async (args: string[], what: string) => {
    const r = await runGit(dir, args, undefined, env);
    if (r.code !== 0) throw new GitError(`${what}失败：${errText(r)}`);
    return r.out;
  };
  try {
    const head = await runGit(dir, ['rev-parse', '--verify', '-q', 'HEAD^{commit}']);
    if (head.code === 0) await step(['read-tree', 'HEAD'], '读取提交');
    await step(['add', '-A', '--', '.', ...excludes(links)], '记录工作树快照');
    return (await step(['write-tree'], '记录工作树快照')).trim();
  } finally {
    fs.rmSync(idx, { force: true });
  }
}

/** A commit (on no branch) of the worktree as it is now, its parent the worktree's HEAD. */
export async function snapshotCommit(dir: string, message: string, links: string[] = []): Promise<string> {
  const tree = await snapshotTree(dir, links);
  const head = (await must(dir, ['rev-parse', 'HEAD'], '读取提交')).trim();
  return (await must(dir, [...(await identity(dir)), 'commit-tree', tree, '-p', head, '-m', message], '生成快照提交')).trim();
}

export interface TreeChange {
  status: 'A' | 'M' | 'D';
  path: string;
}

/** Files that differ between two trees or commits (renames reported as delete + add). */
export async function treeChanges(dir: string, from: string, to: string): Promise<TreeChange[]> {
  const parts = nulList(await must(dir, ['diff', '--no-renames', '--name-status', '-z', from, to, '--'], '比较改动'));
  const out: TreeChange[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const s = parts[i][0];
    out.push({ status: s === 'A' ? 'A' : s === 'D' ? 'D' : 'M', path: parts[i + 1] });
  }
  return out;
}

/** Unified diff text between two trees (binary files named only), at most `max` characters. */
export async function treeDiffText(dir: string, from: string, to: string, max = 400_000): Promise<{ text: string; files: number; added: number; removed: number }> {
  const stat = await must(dir, ['diff', '--no-renames', '--numstat', from, to, '--'], '比较改动');
  let files = 0;
  let added = 0;
  let removed = 0;
  for (const line of stat.split('\n')) {
    const m = line.match(/^(-|\d+)\t(-|\d+)\t/);
    if (!m) continue;
    files++;
    if (m[1] !== '-') added += Number(m[1]);
    if (m[2] !== '-') removed += Number(m[2]);
  }
  const r = await runGit(dir, ['diff', '--no-renames', '--no-color', from, to, '--'], 64 * 1024 * 1024);
  const text = r.out.length > max ? `${r.out.slice(0, max)}\n…（差异过长，只保留前 ${Math.round(max / 1000)}K 字符）` : r.out;
  return { text, files, added, removed };
}

/** Raw bytes of a file in a commit or tree, or null when it is not there. */
export function blobAt(dir: string, rev: string, file: string): Promise<Buffer | null> {
  return new Promise((resolve) => {
    execFile('git', ['cat-file', 'blob', `${rev}:${file}`], { cwd: dir, encoding: 'buffer', maxBuffer: 256 * 1024 * 1024, env: safeEnv({ GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' }) }, (e, out) => resolve(e ? null : out));
  });
}

/** git merge-file of three versions: the merged bytes, or ok = false when the changes overlap. */
export async function mergeThree(ours: Buffer, base: Buffer, theirs: Buffer): Promise<{ ok: boolean; out: Buffer }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'edict-merge-'));
  try {
    const f = (n: string, b: Buffer) => {
      const p = path.join(dir, n);
      fs.writeFileSync(p, b);
      return p;
    };
    const args = ['merge-file', '-p', f('ours', ours), f('base', base), f('theirs', theirs)];
    return await new Promise((resolve) => {
      execFile('git', args, { cwd: dir, encoding: 'buffer', maxBuffer: 256 * 1024 * 1024, env: safeEnv({ GIT_TERMINAL_PROMPT: '0' }) }, (e, out) => {
        const code = e ? (e as { code?: number | string }).code : 0;
        resolve({ ok: code === 0, out });
      });
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
