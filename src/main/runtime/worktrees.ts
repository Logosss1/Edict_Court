// Per-edict git worktrees. A court edict submitted on a git repository (with at least one commit) gets
// branch edict/<id> in its own worktree under <dataDir>/worktrees/<repo hash>/<id> when it leaves triage,
// so edicts on one repository run side by side instead of queueing. At 结案 the emperor merges, keeps or
// discards it on a choice card (raised again after a restart while the worktree is still active).
// Also: manual worktrees for the Source Control view (list / create / open / remove).
import fs from 'node:fs';
import path from 'node:path';
import type { ApprovalChoice, EdictWorktree, Task, WorktreeAction, WorktreeFinishResult, WorktreeInfo, WorktreeStatus } from '../../shared/types';
import { STATE_LABEL, TERMINAL } from '../../shared/court';
import type { Runtime } from './runtime';
import { now, sha256, truncate } from './util';
import * as git from '../services/worktree';

const ACTIONS: WorktreeAction[] = ['merge', 'keep', 'discard'];
const ACTION_LABEL: Record<WorktreeAction, string> = { merge: '合并', keep: '保留分支', discard: '丢弃' };
const STATUS_LABEL: Record<WorktreeStatus, string> = { active: '使用中', merged: '已合并', kept: '已保留分支', discarded: '已丢弃' };

export const worktreesDir = (rt: Runtime) => path.join(rt.opts.dataDir, 'worktrees');
export const repoHash = (root: string) => sha256(root).slice(0, 12);
/** The folder an edict works in: its worktree, or the opened sub-folder inside it. */
export const edictDir = (w: EdictWorktree) => (w.sub ? path.join(w.path, w.sub) : w.path);
export const hasOwnTree = (t: Task) => t.worktree?.status === 'active';

const inside = (base: string, p: string) =>
  [[path.resolve(base), path.resolve(p)], [git.realPath(base), git.realPath(p)]].some(([b, x]) => {
    const r = path.relative(b, x);
    return !!r && !r.startsWith('..') && !path.isAbsolute(r);
  });
const samePath = (a: string, b: string) => path.resolve(a) === path.resolve(b) || git.realPath(a) === git.realPath(b);
const isManaged = (rt: Runtime, p: string) => inside(worktreesDir(rt), p);
const isLink = (p: string) => {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
};

// per runtime: git work on one repository runs one at a time; tasks already looked at; open 结案 cards
// (quiet: cards Edict closed itself because the matter was settled elsewhere)
const state = new WeakMap<Runtime, { locks: Map<string, Promise<unknown>>; checked: Set<string>; cards: Map<string, { apId: string; done: Promise<WorktreeFinishResult | null> }>; quiet: Set<string> }>();
const st = (rt: Runtime) => {
  let s = state.get(rt);
  if (!s) state.set(rt, (s = { locks: new Map(), checked: new Set(), cards: new Map(), quiet: new Set() }));
  return s;
};

function serial<T>(rt: Runtime, key: string, fn: () => Promise<T>): Promise<T> {
  const locks = st(rt).locks;
  const run = (locks.get(key) ?? Promise.resolve()).then(fn, fn);
  const tail = run.catch(() => undefined);
  locks.set(key, tail);
  void tail.then(() => locks.get(key) === tail && locks.delete(key));
  return run;
}

const missingReason = (w: EdictWorktree) => `独立工作树已丢失：${w.path} 不存在（可能被手动删除或移动）。可用 git worktree 恢复该目录后「解除阻塞」，或取消本旨意并在结案对话中丢弃它`;

// ───────────────────────── creation (when the edict leaves triage) ─────────────────────────
function wantsWorktree(rt: Runtime, t: Task): boolean {
  if (!t.workspace || t.tier === 'solo' || t.worktree) return false;
  // a scheduled edict: 「在旨意工作树里改」 always gets one; a read-only one never needs one
  const cap = t.schedule?.permission;
  if (cap === 'readonly' || (cap !== 'worktree' && rt.settings.worktreePerEdict === false)) return false;
  // only before anything read or wrote files for this edict (an edict toggled on mid-flight stays where it is)
  if (t.state !== 'Pending' && t.state !== 'Taizi') return false;
  if (t.designSpec && t.design && !t.design.native && t.designSpec.roles.every((r) => r.toolAccess === 'none')) return false;
  const seen = st(rt).checked;
  if (seen.has(t.id)) return false;
  seen.add(t.id);
  return true;
}

/** Before each step of an edict: make its worktree when due. Returns a block reason when its worktree is gone. */
export async function prepareWorkspace(rt: Runtime, t: Task): Promise<string | null> {
  const w = t.worktree;
  if (w?.status === 'active') return fs.existsSync(edictDir(w)) ? null : missingReason(w);
  if (wantsWorktree(rt, t)) await ensureWorktree(rt, t);
  return null;
}

async function ensureWorktree(rt: Runtime, t: Task): Promise<void> {
  const dir = t.workspace!;
  const repo = await git.repoOf(dir);
  if (!repo) return; // not a git repository: works in the open folder, queued like before
  if (!repo.head) {
    rt.activity('log', '工作区是 git 仓库但还没有任何提交，无法建立独立工作树：本旨意在主工作区执行（同一工作区的旨意依次执行）', { taskId: t.id });
    return;
  }
  const head = repo.head;
  await serial(rt, `repo:${repo.root}`, async () => {
    if (t.worktree || TERMINAL.includes(t.state)) return;
    const base = path.join(worktreesDir(rt), repoHash(repo.root));
    let target = path.join(base, t.id);
    for (let i = 2; fs.existsSync(target); i++) target = path.join(base, `${t.id}-${i}`);
    let sub = path.relative(repo.root, git.realPath(dir)).split(path.sep).join('/');
    if (sub.startsWith('..') || path.isAbsolute(sub)) sub = '';
    let branch = `edict/${t.id}`;
    try {
      // a branch kept from an earlier data folder may carry the same id
      for (let i = 2; await git.branchExists(repo.root, branch); i++) branch = `edict/${t.id}-${i}`;
      await git.addWorktree(repo.root, target, branch, head);
    } catch (e) {
      rt.audit.record('system', 'worktree_failed', { error: truncate((e as Error).message, 300), repoRoot: repo.root }, t.id);
      rt.activity('error', `独立工作树创建失败（${(e as Error).message}），本旨意改在主工作区执行`, { taskId: t.id });
      return;
    }
    const dirty = await git.dirtyFiles(repo.root);
    const links = git.linkDeps(repo.root, target);
    if (sub) links.push(...git.linkDeps(dir, path.join(target, sub)).map((n) => `${sub}/${n}`));
    t.worktree = { path: target, branch, base: head, baseBranch: repo.branch ?? undefined, repoRoot: repo.root, sub: sub || undefined, status: 'active', createdAt: now(), links: links.length ? links : undefined, dirtyBase: dirty.length || undefined };
    t.repoRoot = t.workspace;
    rt.audit.record('system', 'worktree_created', { path: target, branch, base: head, baseBranch: repo.branch, repoRoot: repo.root, sub: sub || null, links, dirtyBase: dirty.length }, t.id);
    rt.activity('log', `本旨意在独立工作树中执行：分支 ${branch}（基于 ${repo.branch ?? 'HEAD'} @ ${head.slice(0, 7)}），目录 ${target}。与同一仓库的其他旨意互不干扰，结案时再定合并、保留或丢弃${links.length ? `；已链接依赖目录 ${links.join('、')}` : ''}`, { taskId: t.id, data: { worktree: target, branch } });
    if (dirty.length) rt.activity('log', `⚠ 主工作区有 ${dirty.length} 处未提交的改动（${dirty.slice(0, 5).join('、')}${dirty.length > 5 ? ' 等' : ''}）：本旨意基于最后一次提交 ${head.slice(0, 7)} 工作，这些未提交的改动不包含在内`, { taskId: t.id });
    rt.touch(t);
    // cancelled while git was busy: onTerminal saw no worktree, so ask here
    if (TERMINAL.includes(t.state)) raiseWorktreeCard(rt, t);
  });
}

// ───────────────────────── 结案: merge / keep / discard ─────────────────────────
/** Commit message for the worktree's changes: the emperor's own first line (结案 dialog) or the title, then the edict. */
const commitMessage = (t: Task, subject?: string) => `${subject?.trim().split('\n')[0].slice(0, 200) || `${t.title}（旨意 ${t.id}）`}\n\n由 Edict 旨意 ${t.id} 在独立工作树 ${t.worktree?.branch ?? ''} 中完成。\n\n${truncate(t.edict, 1500, '…')}`;
const mergeMessage = (t: Task) => `合并旨意 ${t.id}：${t.title}`;

/** Merge (commit + git merge --no-ff into the main checkout), keep the branch, or discard it. Idempotent. */
export async function finishWorktree(rt: Runtime, taskId: string, action: WorktreeAction, actor = 'emperor', o: { message?: string } = {}): Promise<WorktreeFinishResult> {
  if (!ACTIONS.includes(action)) throw new Error(`未知的处理方式：${action}`);
  const t = rt.getTask(taskId);
  const w = t.worktree;
  if (!w) throw new Error('此旨意没有独立工作树');
  return serial(rt, `repo:${w.repoRoot}`, () => finishLocked(rt, t, w, action, actor, o.message));
}

async function finishLocked(rt: Runtime, t: Task, w: EdictWorktree, action: WorktreeAction, actor: string, message?: string): Promise<WorktreeFinishResult> {
  const res = (ok: boolean, message: string): WorktreeFinishResult => ({ ok, action, status: w.status, message, branch: w.branch, path: w.path, commit: w.commit, mergeCommit: w.mergeCommit, conflicts: w.conflicts?.length ? w.conflicts : undefined });
  // asking again for what already happened just reports it
  if (w.status === 'merged' && action === 'merge') return res(true, `分支 ${w.branch} 已合并${w.mergeCommit ? `（合并提交 ${w.mergeCommit.slice(0, 7)}）` : ''}`);
  if (w.status === 'discarded' && action === 'discard') return res(true, `工作树已丢弃，分支 ${w.branch} 已删除`);
  if (w.status === 'kept' && action === 'keep') return res(true, `分支 ${w.branch} 已保留`);
  if (w.status === 'merged' || w.status === 'discarded') throw new Error(`工作树${STATUS_LABEL[w.status]}，不能再${ACTION_LABEL[action]}`);
  if (w.status === 'active' && !TERMINAL.includes(t.state)) throw new Error(`旨意尚在「${STATE_LABEL[t.state]}」：结案或取消后才能处理它的工作树`);
  if (action === 'merge' && w.status === 'active' && t.state !== 'Done') throw new Error('旨意已取消：只能保留分支或丢弃（保留后仍可再合并该分支）');
  // every action removes the directory: not while it is open as the workspace (opened from Source Control)
  if (w.status === 'active' && rt.workspace && (samePath(rt.workspace.root, w.path) || inside(w.path, rt.workspace.root))) return res(false, `工作树 ${w.path} 是当前打开的工作区：请先切换到其他文件夹再${ACTION_LABEL[action]}`);
  rt.audit.record(actor, 'worktree_finish', { action, from: w.status, branch: w.branch, path: w.path }, t.id);
  try {
    if (w.status === 'active' && action !== 'discard' && fs.existsSync(w.path)) {
      const c = await git.commitAll(w.path, commitMessage(t, message), w.links);
      if (c.commit) {
        w.commit = c.commit;
        rt.audit.record('system', 'worktree_commit', { branch: w.branch, commit: c.commit, files: c.files.length }, t.id);
        rt.activity('log', `已在分支 ${w.branch} 提交工作树中的 ${c.files.length} 个文件（${c.commit.slice(0, 7)}）`, { taskId: t.id });
      }
    }
    if (action === 'merge') {
      const m = await git.mergeBranch(w.repoRoot, w.branch, mergeMessage(t));
      if (!m.ok) {
        w.conflicts = m.files;
        w.error = m.message;
        rt.audit.record('system', 'worktree_merge_failed', { branch: w.branch, reason: m.reason, files: m.files }, t.id);
        rt.activity('error', `合并未完成：${m.message}。主工作区未改动，分支 ${w.branch} 仍保留`, { taskId: t.id });
        rt.touch(t);
        return res(false, `${m.message}。主工作区未改动，分支 ${w.branch} 已保留`);
      }
      w.mergeCommit = m.mergeCommit ?? w.mergeCommit; // a retry after a failed cleanup finds nothing left to merge
      w.conflicts = undefined;
      rt.audit.record('system', 'worktree_merged', { branch: w.branch, into: w.baseBranch ?? null, mergeCommit: m.mergeCommit, files: m.files }, t.id);
      if (m.files.length) mainChanged(rt, w, m.files);
    }
    if (w.status === 'active') await dropTree(rt, t, w);
    if (action !== 'keep') {
      const b = await git.deleteBranch(w.repoRoot, w.branch, action === 'discard');
      rt.audit.record('system', 'worktree_branch_deleted', { branch: w.branch, ok: b.ok, message: b.message }, t.id);
      if (!b.ok) rt.activity('error', b.message, { taskId: t.id });
    }
    w.status = action === 'merge' ? 'merged' : action === 'keep' ? 'kept' : 'discarded';
    w.finishedAt = now();
    w.error = undefined;
    rt.touch(t);
    const msg =
      action === 'merge' ? (w.mergeCommit ? `已把分支 ${w.branch} 合并进主工作区${w.baseBranch ? `（${w.baseBranch}）` : ''}，合并提交 ${w.mergeCommit.slice(0, 7)}` : `分支 ${w.branch} 没有新的改动，无需合并`)
      : action === 'keep' ? `已保留分支 ${w.branch}${w.commit ? `（最新提交 ${w.commit.slice(0, 7)}）` : ''}，工作树目录已移除`
      : `已丢弃工作树并删除分支 ${w.branch}`;
    rt.activity('human', `结案处理工作树：${msg}`, { taskId: t.id });
    return res(true, msg);
  } catch (e) {
    w.error = (e as Error).message;
    rt.audit.record('system', 'worktree_finish_failed', { action, error: truncate(w.error, 300) }, t.id);
    rt.activity('error', `工作树处理失败（${ACTION_LABEL[action]}）：${w.error}`, { taskId: t.id });
    rt.touch(t);
    return res(false, w.error);
  }
}

/** The merge changed files in the main checkout: refresh the editor and language servers when it is open. */
function mainChanged(rt: Runtime, w: EdictWorktree, files: string[]) {
  if (!rt.workspace || !samePath(rt.workspace.root, w.sub ? path.join(w.repoRoot, w.sub) : w.repoRoot)) return;
  const rel = w.sub ? files.filter((f) => f.startsWith(`${w.sub}/`)).map((f) => f.slice(w.sub!.length + 1)) : files;
  rt.emit({ type: 'fs_changed', paths: rel });
  void rt.lsp.notifyFilesChanged(rel).catch(() => {});
}

async function dropTree(rt: Runtime, t: Task, w: EdictWorktree) {
  git.unlinkDeps(w.path, w.links);
  rt.forgetWorkspace(edictDir(w));
  if (w.sub) rt.forgetWorkspace(w.path);
  await git.removeWorktree(w.repoRoot, w.path, { force: true, managed: isManaged(rt, w.path) });
  await git.prune(w.repoRoot);
  rt.audit.record('system', 'worktree_removed', { path: w.path }, t.id);
}

// ───────────────────────── the 结案 card ─────────────────────────
const pendingCard = (rt: Runtime, taskId: string) => {
  const c = st(rt).cards.get(taskId);
  return c && rt.approvals.get(c.apId)?.status === 'pending' ? c : undefined;
};

/** Ask the emperor what to do with a finished edict's worktree (Done: 合并 / 保留分支 / 丢弃; Cancelled: no merge). */
export function raiseWorktreeCard(rt: Runtime, t: Task, note?: string) {
  const w = t.worktree;
  if (!w || w.status !== 'active' || !TERMINAL.includes(t.state) || !rt.tasks.has(t.id) || pendingCard(rt, t.id)) return;
  const done = t.state === 'Done';
  const exists = fs.existsSync(w.path);
  const files = [...new Set(t.changes.filter((c) => !c.reverted).map((c) => c.path))];
  const choices: ApprovalChoice[] = [
    ...(done && exists ? [{ id: 'merge', label: `合并到 ${w.baseBranch ?? '主工作区'}`, hint: `先提交到 ${w.branch}，再 git merge --no-ff 进${w.baseBranch ? ` ${w.baseBranch}` : '主工作区'}。有冲突会自动中止、保留分支，并列出冲突的文件`, approve: true, tone: 'primary' as const }] : []),
    { id: 'keep', label: '保留分支', hint: `提交到 ${w.branch}，删掉工作树目录；以后可在「源代码管理 → 工作树」里合并或打开`, approve: true, tone: done && exists ? ('default' as const) : ('primary' as const) },
    { id: 'discard', label: '丢弃', hint: `删除工作树和分支 ${w.branch}，这些改动不会保留`, approve: true, tone: 'danger' as const },
  ];
  const detail = [
    `分支：${w.branch}（基于 ${w.baseBranch ?? 'HEAD'} @ ${w.base.slice(0, 7)}）`,
    `工作树：${w.path}${exists ? '' : '（目录已不存在）'}`,
    `系统记录的改动：${files.length ? `${files.length} 个文件 — ${files.slice(0, 12).join('、')}${files.length > 12 ? ' 等' : ''}` : '无'}`,
    w.dirtyBase ? `注意：建立工作树时主工作区有 ${w.dirtyBase} 处未提交的改动，未包含在本旨意中` : '',
    note ? `上次处理未完成：${note}` : '',
  ].filter(Boolean).join('\n');
  let settle!: (r: WorktreeFinishResult | null) => void;
  const settled = new Promise<WorktreeFinishResult | null>((r) => (settle = r));
  const decision = rt.requestDecision({
    kind: 'worktree', taskId: t.id, agentId: 'shangshu', tool: 'worktree',
    summary: done ? `旨意结案：「${t.title}」的改动如何处理？` : `旨意已取消：「${t.title}」的工作树如何处理？`,
    detail, risk: 'normal',
    reason: done ? '本旨意在独立 git 工作树中完成，改动还没有进入主工作区。' : '旨意已取消，工作树里可能留有未完成的改动。',
    choices,
  });
  const ap = [...rt.approvals.values()].reverse().find((a) => a.kind === 'worktree' && a.taskId === t.id && a.status === 'pending');
  if (!ap) return;
  st(rt).cards.set(t.id, { apId: ap.id, done: settled });
  void decision.then(async (d) => {
    let r: WorktreeFinishResult | null = null;
    if (ACTIONS.includes(d.choice as WorktreeAction)) {
      const action = d.choice as WorktreeAction;
      r = await finishWorktree(rt, t.id, action, 'emperor', { message: d.comment }).catch((e: Error) => ({ ok: false, action, status: w.status, message: e.message, branch: w.branch, path: w.path }));
    } else if (!st(rt).quiet.delete(ap.id) && w.status === 'active' && rt.tasks.has(t.id)) {
      // answered without one of the three choices (plain 准许 / 驳回): nothing is merged or deleted
      rt.audit.record('emperor', 'worktree_deferred', { branch: w.branch, path: w.path, choice: d.choice }, t.id);
      rt.activity('log', `未选择工作树的处理方式：改动仍在 ${w.path}（分支 ${w.branch}），可稍后在旨意详情中合并、保留分支或丢弃（重启 Edict 后会再次询问）`, { taskId: t.id });
    }
    const ag = rt.agents.get('shangshu');
    if (ag?.status === 'waiting' && ag.activity === `等待批准：${ap.summary}`) rt.setAgent('shangshu', { status: 'idle', activity: '' });
    if (st(rt).cards.get(t.id)?.apId === ap.id) st(rt).cards.delete(t.id);
    settle(r);
    if (r && !r.ok) {
      rt.toast('warn', r.message);
      raiseWorktreeCard(rt, t, r.message); // ask again (e.g. keep the branch after a conflict)
    }
  });
}

/** API: what the edict detail calls later. Goes through the open card when there is one (so it closes). */
export async function worktreeFinish(rt: Runtime, taskId: string, action: WorktreeAction, message?: string): Promise<WorktreeFinishResult> {
  const t = rt.getTask(taskId);
  const c = pendingCard(rt, t.id);
  if (c && rt.approvals.get(c.apId)?.choices?.some((x) => x.id === action)) {
    rt.decideApproval(c.apId, true, 'emperor', action, message);
    const r = await c.done;
    if (r) return r;
  }
  const r = await finishWorktree(rt, taskId, action, 'emperor', { message });
  const open = r.ok ? pendingCard(rt, t.id) : undefined;
  if (open) closeCard(rt, open.apId);
  return r;
}

function closeCard(rt: Runtime, apId: string) {
  st(rt).quiet.add(apId);
  rt.decideApproval(apId, false, 'system');
}

/** Deleting a finished edict: discard / keep only when asked; otherwise leave the worktree and say where it is. */
export async function worktreeOnDelete(rt: Runtime, t: Task, choice?: 'discard' | 'keep'): Promise<{ message?: string; worktree?: { path: string; branch: string; status: WorktreeStatus } }> {
  const w = t.worktree;
  if (!w || w.status !== 'active') return {};
  const c = pendingCard(rt, t.id);
  if (c) closeCard(rt, c.apId);
  if (choice) {
    const r = await finishWorktree(rt, t.id, choice);
    if (!r.ok) throw new Error(`工作树${ACTION_LABEL[choice]}失败，旨意未删除：${r.message}`);
    return { message: r.message, worktree: { path: w.path, branch: w.branch, status: w.status } };
  }
  rt.forgetWorkspace(edictDir(w)); // stop its language servers; the folder itself stays
  rt.audit.record('emperor', 'worktree_left', { path: w.path, branch: w.branch }, t.id);
  const message = `旨意已删除；它的工作树仍保留在 ${w.path}（分支 ${w.branch}），可在源代码管理的工作树列表中打开或移除`;
  rt.toast('info', message);
  return { message, worktree: { path: w.path, branch: w.branch, status: 'active' } };
}

// ───────────────────────── restart ─────────────────────────
/** After a restart: block live edicts whose worktree vanished, re-raise 结案 cards that were never answered. */
export function recoverWorktrees(rt: Runtime) {
  const prunes = new Set<string>();
  for (const t of rt.tasks.values()) {
    const w = t.worktree;
    if (!w || w.status !== 'active') continue;
    if (!fs.existsSync(edictDir(w))) {
      prunes.add(w.repoRoot);
      if (!TERMINAL.includes(t.state)) {
        const reason = missingReason(w);
        if (t.state !== 'Blocked') {
          const from = t.state;
          t.resumeState = from;
          t.state = 'Blocked';
          t.flow.push({ at: now(), from: STATE_LABEL[from], to: STATE_LABEL.Blocked, remark: reason, state: 'Blocked' });
          rt.audit.record('system', 'transition', { from, to: 'Blocked', remark: reason }, t.id);
        }
        t.blockedReason = reason;
        t.gate = undefined; // nothing can be decided on files that are gone
        rt.activity('error', reason, { taskId: t.id });
        rt.store.markDirty('tasks', t.id);
      }
    }
    if (TERMINAL.includes(t.state)) raiseWorktreeCard(rt, t);
  }
  for (const r of prunes) void git.prune(r).catch(() => {});
}

// ───────────────────────── manual worktrees (Source Control) ─────────────────────────
async function openRepo(rt: Runtime) {
  const ws = rt.requireWorkspace();
  const repo = await git.repoOf(ws.root);
  if (!repo) throw new Error('当前工作区不是 git 仓库');
  return repo;
}

/** `git worktree list` of the open repository, with Edict's own worktrees flagged (and their edict). */
export async function worktreeList(rt: Runtime): Promise<{ repoRoot: string | null; worktrees: WorktreeInfo[] }> {
  const repo = rt.workspace ? await git.repoOf(rt.workspace.root) : null;
  if (!repo) return { repoRoot: null, worktrees: [] };
  const list = await git.listWorktrees(repo.root);
  const tasks = [...rt.tasks.values()].filter((t) => t.worktree);
  return {
    repoRoot: repo.root,
    worktrees: list.map((e, i): WorktreeInfo => {
      const managed = isManaged(rt, e.path);
      const task = tasks.find((t) => samePath(t.worktree!.path, e.path));
      const exists = fs.existsSync(e.path);
      const kind = i === 0 ? 'main' : task || (managed && !path.basename(e.path).startsWith('manual-')) ? 'edict' : managed ? 'manual' : 'external';
      return {
        path: e.path, head: e.head, branch: e.branch, main: i === 0, current: samePath(e.path, repo.root), managed, kind,
        taskId: task?.id ?? (kind === 'edict' ? path.basename(e.path) : undefined), taskTitle: task?.title, taskState: task?.state, status: task?.worktree?.status,
        locked: e.locked || undefined, prunable: e.prunable || !exists || undefined, exists,
      };
    }),
  };
}

/** New worktree at <dataDir>/worktrees/<repo hash>/manual-<branch> on a new branch (from `base`, default HEAD) or an existing one. */
export async function worktreeCreate(rt: Runtime, o: { branch: string; base?: string }): Promise<WorktreeInfo> {
  const repo = await openRepo(rt);
  const branch = String(o?.branch ?? '').trim();
  if (!(await git.validBranchName(repo.root, branch))) throw new Error(`分支名无效：${branch || '（空）'}`);
  const existing = await git.branchExists(repo.root, branch);
  let base: string | null = null;
  if (!existing) {
    base = await git.resolveCommit(repo.root, o.base?.trim() || 'HEAD');
    if (!base) throw new Error(o.base?.trim() ? `找不到基准提交：${o.base}` : '仓库还没有任何提交，无法建立工作树');
  }
  const name = `manual-${branch.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 60) || 'branch'}`;
  const dir = path.join(worktreesDir(rt), repoHash(repo.root), name);
  if (fs.existsSync(dir)) throw new Error(`工作树目录已存在：${dir}`);
  await serial(rt, `repo:${repo.root}`, () => git.addWorktree(repo.root, dir, branch, base));
  rt.audit.record('emperor', 'worktree_create', { path: dir, branch, base, newBranch: !existing, repoRoot: repo.root });
  const info = (await worktreeList(rt)).worktrees.find((w) => samePath(w.path, dir));
  if (!info) throw new Error(`工作树已创建但未出现在列表中：${dir}`);
  return info;
}

/** Open one of the repository's worktrees as the workspace. */
export async function worktreeOpen(rt: Runtime, p: string): Promise<string> {
  const e = (await worktreeList(rt)).worktrees.find((w) => samePath(w.path, String(p ?? '')));
  if (!e) throw new Error(`不是当前仓库的工作树：${p}`);
  if (!e.exists) throw new Error(`工作树目录不存在：${e.path}`);
  rt.setWorkspace(e.path);
  rt.audit.record('emperor', 'worktree_open', { path: e.path, branch: e.branch });
  return e.path;
}

/** Remove a worktree of the open repository (never the main one, the open one, or one an edict still owns). */
export async function worktreeRemove(rt: Runtime, p: string, o: { deleteBranch?: boolean; force?: boolean } = {}): Promise<{ removed: boolean; path: string; branch: string | null; branchDeleted: boolean; message: string }> {
  const { repoRoot, worktrees } = await worktreeList(rt);
  const e = worktrees.find((w) => samePath(w.path, String(p ?? '')));
  if (!e || !repoRoot) throw new Error(`不是当前仓库的工作树：${p}`);
  if (e.main) throw new Error('不能移除仓库的主工作区');
  if (e.current) throw new Error('这是当前打开的工作区：请先切换到其他文件夹再移除');
  const owner = [...rt.tasks.values()].find((t) => t.worktree?.status === 'active' && samePath(t.worktree.path, e.path));
  if (owner) throw new Error(TERMINAL.includes(owner.state) ? `旨意 ${owner.id}「${owner.title}」已结案：请在它的结案对话中选择合并、保留分支或丢弃` : `旨意 ${owner.id}「${owner.title}」正在使用这个工作树，结案后再处理`);
  const links = e.exists && e.managed ? git.DEP_LINKS.filter((n) => isLink(path.join(e.path, n))) : [];
  if (e.exists) {
    const dirty = await git.dirtyFiles(e.path, links);
    if (dirty.length && !o.force) throw new Error(`工作树有 ${dirty.length} 处未提交的改动（${dirty.slice(0, 5).join('、')}${dirty.length > 5 ? ' 等' : ''}）：确定丢弃请强制移除`);
  }
  await serial(rt, `repo:${repoRoot}`, async () => {
    git.unlinkDeps(e.path, links);
    rt.forgetWorkspace(e.path);
    await git.removeWorktree(repoRoot, e.path, { force: !!o.force, managed: e.managed });
  });
  let branchDeleted = false;
  let note = '';
  if (o.deleteBranch && e.branch) {
    const b = await git.deleteBranch(repoRoot, e.branch, !!o.force);
    branchDeleted = b.ok;
    note = b.ok ? `；${b.message}` : `；${b.message}（分支未合并时可强制删除）`;
  }
  rt.audit.record('emperor', 'worktree_remove', { path: e.path, branch: e.branch, deleteBranch: !!o.deleteBranch, branchDeleted, force: !!o.force });
  return { removed: true, path: e.path, branch: e.branch, branchDeleted, message: `已移除工作树 ${e.path}${note}` };
}

/** 结案 dialog: lines added / removed per file of an edict's worktree (or kept branch) against its base. */
export async function worktreeDiffStat(rt: Runtime, taskId: string): Promise<git.DiffStatFile[]> {
  const w = rt.getTask(taskId).worktree;
  if (!w || w.status === 'merged' || w.status === 'discarded') return [];
  return git.diffStat({ repo: w.repoRoot, base: w.base, branch: w.branch, dir: w.status === 'active' ? w.path : undefined, links: w.links });
}
