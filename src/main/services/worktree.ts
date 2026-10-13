// Git worktree plumbing for per-edict worktrees and the Source Control view. No runtime state here:
// every function runs git in the given directory and reports in Chinese. The main checkout is only ever
// changed by mergeBranch (and only after a conflict-free dry run when git can do one).
import fs from 'node:fs';
import path from 'node:path';
import { runGit } from './git';

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
