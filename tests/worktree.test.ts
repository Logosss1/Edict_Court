// Per-edict git worktrees (mock/integration: MOCK LLM server, real git in temp repositories).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { startMockLlm } from './mockLlm';
import { makeRuntime, tmpDir, waitFor, stateOf } from './helpers';
import { submit, decideGate } from '../src/main/runtime/orchestrator';
import { executeTool } from '../src/main/runtime/tools';
import { worktreeCreate, worktreeDiffStat, worktreeFinish, worktreeList, worktreeOnDelete, worktreeOpen, worktreeRemove, repoHash } from '../src/main/runtime/worktrees';
import { mergeBranch } from '../src/main/services/worktree';
import { isAllowedPreviewUrl, servePreview } from '../src/main/services/preview';
import type { ApprovalRequest, Task } from '../src/shared/types';

type Rt = ReturnType<typeof makeRuntime>;

const gitc = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const gitOk = (cwd: string, ...args: string[]) => {
  try {
    gitc(cwd, ...args);
    return true;
  } catch {
    return false;
  }
};

/** A repository with one commit; node_modules / .env exist but are ignored (like a real project). */
function makeRepo(files: Record<string, string> = {}) {
  const dir = tmpDir('edict-repo-');
  gitc(dir, 'init', '-q', '-b', 'main');
  gitc(dir, 'config', 'user.name', 'Test');
  gitc(dir, 'config', 'user.email', 'test@example.com');
  gitc(dir, 'config', 'commit.gpgsign', 'false');
  const all = { 'README.md': '# demo\n', '.gitignore': 'node_modules/\n.env\n', ...files };
  for (const [p, c] of Object.entries(all)) {
    fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
    fs.writeFileSync(path.join(dir, p), c);
  }
  gitc(dir, 'add', '-A');
  gitc(dir, 'commit', '-q', '-m', 'init');
  fs.mkdirSync(path.join(dir, 'node_modules/dep'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'node_modules/dep/index.js'), 'module.exports = 1;\n');
  fs.writeFileSync(path.join(dir, '.env'), 'API_KEY=secret\n');
  return dir;
}

const pending = (rt: Rt, kind?: string, taskId?: string) => [...rt.approvals.values()].find((a) => a.status === 'pending' && (!kind || a.kind === kind) && (!taskId || a.taskId === taskId));

async function startEdict(rt: Rt, text = '写一个 greet 函数并测试'): Promise<string> {
  const r = (await submit(rt, { text, tier: 'lite', multiAgent: true })) as { taskId: string };
  return r.taskId;
}

async function toFinal(rt: Rt, id: string): Promise<Task> {
  await waitFor(() => rt.tasks.get(id)!.gate?.kind === 'final' || stateOf(rt, id) === 'Blocked', 30000, `final gate ${id}`);
  const t = rt.tasks.get(id)!;
  assert.equal(t.state, 'PendingConfirm', t.blockedReason);
  return t;
}

/** 准奏结案 → the worktree card. */
async function close(rt: Rt, t: Task): Promise<ApprovalRequest> {
  decideGate(rt, t.id, { approve: true });
  assert.equal(t.state, 'Done');
  return waitFor(() => pending(rt, 'worktree', t.id), 5000, 'worktree card');
}

const settled = (rt: Rt, t: Task, status: string) => waitFor(() => t.worktree?.status === status && !rt.tasks.get(t.id)?.worktree?.error, 10000, `worktree ${status}`);
const actions = (rt: Rt, id: string) => rt.audit.list({ taskId: id, limit: 500 }).map((e) => e.action);

test('an edict on a git repo works in its own worktree; the main checkout stays untouched until 合并', async () => {
  const mock = await startMockLlm();
  const rt = makeRuntime(mock.url);
  assert.equal(rt.settings.worktreePerEdict, true, 'on by default');
  const repo = makeRepo();
  rt.setWorkspace(repo);
  const root = rt.workspace!.root;
  const id = await startEdict(rt);
  const t = await toFinal(rt, id);
  const w = t.worktree!;
  assert.ok(w, 'worktree recorded on the task');
  assert.equal(w.status, 'active');
  assert.equal(w.branch, `edict/${id}`);
  assert.equal(w.path, path.join(rt.opts.dataDir, 'worktrees', repoHash(gitc(repo, 'rev-parse', '--show-toplevel')), id));
  assert.equal(w.base, gitc(repo, 'rev-parse', 'HEAD'));
  assert.equal(w.baseBranch, 'main');
  assert.equal(t.repoRoot, root);
  assert.ok(t.flow.every((f) => f.state !== 'Next'), 'no queueing');
  // writes landed in the worktree, the main checkout is clean
  assert.ok(fs.existsSync(path.join(w.path, 'greet.js')) && fs.existsSync(path.join(w.path, 'greet.test.js')));
  assert.ok(!fs.existsSync(path.join(repo, 'greet.js')));
  assert.equal(gitc(repo, 'status', '--porcelain'), '');
  // dependency folders are linked, secrets are not
  assert.ok(fs.lstatSync(path.join(w.path, 'node_modules')).isSymbolicLink());
  assert.deepEqual(w.links, ['node_modules']);
  assert.ok(!fs.existsSync(path.join(w.path, '.env')));
  // the verify subtask ran its test inside the worktree
  const s2 = t.nodes.find((n) => n.subtaskId === 'S2')!;
  assert.match(s2.output ?? '', /"status":"done"/);
  // tools of this edict see the worktree; chat tools see the open workspace
  assert.equal((await executeTool({ rt, agentId: 'bingbu', task: t }, 'read_file', { path: 'greet.js' })).ok, true);
  assert.equal((await executeTool({ rt, agentId: 'bingbu' }, 'read_file', { path: 'greet.js' })).ok, false);
  assert.equal(rt.workspaceFor(t)!.root, w.path);
  assert.notEqual(rt.lspFor(rt.workspaceFor(t)!), rt.lsp, 'language servers run against the worktree');
  assert.equal(rt.lspFor(rt.workspace!), rt.lsp);
  // preview: the edict's worktree is its own origin, served read-only like the workspace
  let seen = '';
  rt.opts.previewPage = async (url, o) => ((seen = url), { url, ok: true, title: 'x', text: '', console: [], failed: [], blocked: [], width: o.width, height: o.height, loadMs: 1 });
  await executeTool({ rt, agentId: 'bingbu', task: t }, 'preview_page', { path: 'greet.js' });
  assert.equal(seen, `preview://wt-${id.toLowerCase()}/greet.js`);
  assert.ok(isAllowedPreviewUrl(seen));
  assert.equal(rt.previewRoot(new URL(seen).host), w.path);
  assert.match(servePreview(rt.previewRoot(new URL(seen).host), seen).body.toString(), /Hello/);
  assert.equal(rt.previewRoot('wt-nope'), null);
  // permissions stay keyed by the main checkout
  assert.equal(rt.permRoot(t), root);
  rt.addAllowRules('workspace', t, ['cmd:echo'], '「echo」');
  assert.ok(rt.settings.workspacePerms[root].rules.some((r) => r.key === 'cmd:echo'));
  assert.ok(rt.rulesFor(t).some((r) => r.key === 'cmd:echo'));
  // the Source Control list flags it; it cannot be removed while the edict uses it
  const list = await worktreeList(rt);
  const entry = list.worktrees.find((x) => x.kind === 'edict')!;
  assert.equal(entry.taskId, id);
  assert.equal(entry.status, 'active');
  assert.ok(list.worktrees[0].main && list.worktrees[0].current);
  await assert.rejects(worktreeRemove(rt, w.path, { force: true }), /正在使用/);
  // 结案 → card with 合并 / 保留分支 / 丢弃
  const card = await close(rt, t);
  assert.deepEqual(card.choices!.map((c) => c.id), ['merge', 'keep', 'discard']);
  assert.match(card.summary, /结案/);
  assert.match(card.detail, new RegExp(`edict/${id}`));
  assert.ok(rt.memorials.get(id)!.artifacts.some((a) => a.path === 'greet.js' && a.sha256.length === 64), 'artifacts hashed from the worktree');
  await assert.rejects(worktreeRemove(rt, w.path, { force: true }), /结案对话/);
  rt.decideApproval(card.id, true, 'emperor', 'merge');
  await settled(rt, t, 'merged');
  assert.equal(fs.readFileSync(path.join(repo, 'greet.js'), 'utf8'), "exports.greet = (n) => `Hello, ${n}`;\n");
  assert.ok(fs.existsSync(path.join(repo, 'greet.test.js')));
  assert.equal(gitc(repo, 'log', '-1', '--format=%s'), `合并旨意 ${id}：${t.title}`);
  assert.equal(gitc(repo, 'rev-list', '--parents', '-n', '1', 'HEAD').split(' ').length, 3, '--no-ff merge commit');
  assert.ok(!gitc(repo, 'ls-tree', '-r', '--name-only', 'HEAD').split('\n').some((p) => p.startsWith('node_modules')), 'the link was never committed');
  assert.equal(gitc(repo, 'status', '--porcelain'), '');
  assert.ok(!fs.existsSync(w.path), 'worktree directory removed');
  assert.equal(gitc(repo, 'branch', '--list', 'edict/*'), '', 'merged branch deleted');
  assert.equal((await worktreeList(rt)).worktrees.length, 1);
  assert.ok(w.mergeCommit && w.commit);
  for (const a of ['worktree_created', 'worktree_finish', 'worktree_commit', 'worktree_merged', 'worktree_removed', 'worktree_branch_deleted']) assert.ok(actions(rt, id).includes(a), a);
  // idempotent; a merged worktree cannot be discarded
  const again = await worktreeFinish(rt, id, 'merge');
  assert.equal(again.ok, true);
  assert.equal(again.status, 'merged');
  await assert.rejects(worktreeFinish(rt, id, 'discard'), /已合并/);
  assert.ok(rt.audit.verify().ok);
  rt.dispose();
  await mock.close();
});

test('two edicts on one repo run side by side; a non-git workspace still queues', async () => {
  const slow = { delayFor: (c: { system: string }) => (/兵部尚书|刑部尚书/.test(c.system) ? 20 : undefined) };
  // git: distinct worktrees, both in 六部执行 at once
  const mock = await startMockLlm(slow);
  const rt = makeRuntime(mock.url);
  const repo = makeRepo();
  rt.setWorkspace(repo);
  let maxDoing = 0;
  rt.on((e) => {
    if (e.type === 'task') maxDoing = Math.max(maxDoing, [...rt.tasks.values()].filter((x) => x.state === 'Doing').length);
  });
  const a = await startEdict(rt);
  const b = await startEdict(rt);
  const [ta, tb] = [await toFinal(rt, a), await toFinal(rt, b)];
  assert.ok(maxDoing >= 2, `ran concurrently (max Doing ${maxDoing})`);
  assert.ok([ta, tb].every((t) => t.flow.every((f) => f.state !== 'Next')), 'nobody queued');
  assert.notEqual(ta.worktree!.path, tb.worktree!.path);
  assert.notEqual(ta.worktree!.branch, tb.worktree!.branch);
  assert.ok(fs.existsSync(path.join(ta.worktree!.path, 'greet.js')) && fs.existsSync(path.join(tb.worktree!.path, 'greet.js')));
  assert.equal(gitc(repo, 'status', '--porcelain'), '');
  rt.dispose();
  await mock.close();

  // non-git folder: the old one-at-a-time queue
  const mock2 = await startMockLlm(slow);
  const rt2 = makeRuntime(mock2.url);
  rt2.setWorkspace(tmpDir('edict-ws-'));
  const c = await startEdict(rt2);
  const d = await startEdict(rt2);
  const [tc, td] = [await toFinal(rt2, c), await toFinal(rt2, d)];
  assert.ok(!tc.worktree && !td.worktree);
  assert.ok([tc, td].some((t) => t.flow.some((f) => f.state === 'Next')), 'second edict waited (排队候旨)');
  rt2.dispose();
  await mock2.close();
});

test('保留分支 and 丢弃; a kept branch can be merged later; Cancelled edicts get keep / discard only', async () => {
  const mock = await startMockLlm();
  const rt = makeRuntime(mock.url);
  const repo = makeRepo();
  rt.setWorkspace(repo);
  const ids = [await startEdict(rt), await startEdict(rt), await startEdict(rt), await startEdict(rt)];
  const [keep, discard, cancelKeep, cancelDiscard] = await Promise.all(ids.map((id) => toFinal(rt, id)));
  // keep: committed on the branch, directory removed, main untouched
  rt.decideApproval((await close(rt, keep)).id, true, 'emperor', 'keep');
  await settled(rt, keep, 'kept');
  const kb = keep.worktree!.branch;
  assert.ok(!fs.existsSync(keep.worktree!.path));
  assert.match(gitc(repo, 'show', `${kb}:greet.js`), /Hello/);
  assert.match(gitc(repo, 'log', '-1', '--format=%B', kb), new RegExp(`旨意 ${keep.id}`));
  assert.ok(!fs.existsSync(path.join(repo, 'greet.js')));
  assert.equal((await worktreeFinish(rt, keep.id, 'keep')).status, 'kept', 'idempotent');
  // discard: directory and branch gone
  rt.decideApproval((await close(rt, discard)).id, true, 'emperor', 'discard');
  await settled(rt, discard, 'discarded');
  assert.ok(!fs.existsSync(discard.worktree!.path));
  assert.ok(!gitOk(repo, 'rev-parse', '--verify', '-q', discard.worktree!.branch));
  assert.equal((await worktreeFinish(rt, discard.id, 'discard')).ok, true, 'idempotent');
  await assert.rejects(worktreeFinish(rt, discard.id, 'merge'), /已丢弃/);
  // the kept branch merged later from the edict detail
  const m = await worktreeFinish(rt, keep.id, 'merge');
  assert.equal(m.ok, true, m.message);
  assert.equal(m.status, 'merged');
  assert.ok(fs.existsSync(path.join(repo, 'greet.js')));
  assert.ok(!gitOk(repo, 'rev-parse', '--verify', '-q', kb));
  // cancelled: no merge on the card; the API goes through the open card
  rt.cancel(cancelDiscard.id);
  const cc = await waitFor(() => pending(rt, 'worktree', cancelDiscard.id), 5000, 'cancel card');
  assert.deepEqual(cc.choices!.map((c) => c.id), ['keep', 'discard']);
  assert.match(cc.summary, /已取消/);
  await assert.rejects(worktreeFinish(rt, cancelDiscard.id, 'merge'), /已取消/);
  const r = await worktreeFinish(rt, cancelDiscard.id, 'discard');
  assert.equal(r.ok, true, r.message);
  assert.equal(r.status, 'discarded');
  assert.equal(rt.approvals.get(cc.id)!.choice, 'discard', 'the card was answered, not left open');
  rt.cancel(cancelKeep.id);
  const ck = await waitFor(() => pending(rt, 'worktree', cancelKeep.id), 5000, 'cancel card 2');
  rt.decideApproval(ck.id, true, 'emperor', 'keep');
  await settled(rt, cancelKeep, 'kept');
  assert.match(gitc(repo, 'show', `${cancelKeep.worktree!.branch}:greet.js`), /Hello/, 'unfinished work kept on the branch');
  assert.equal((await worktreeList(rt)).worktrees.length, 1);
  rt.dispose();
  await mock.close();
});

test('a conflicting merge leaves the main checkout as it was, keeps the branch and asks again', async () => {
  const mock = await startMockLlm();
  const rt = makeRuntime(mock.url);
  const repo = makeRepo();
  rt.setWorkspace(repo);
  const id = await startEdict(rt);
  await waitFor(() => rt.tasks.get(id)?.worktree, 20000, 'worktree');
  // meanwhile the emperor commits his own greet.js in the main checkout
  fs.writeFileSync(path.join(repo, 'greet.js'), 'exports.greet = () => "main";\n');
  gitc(repo, 'add', 'greet.js');
  gitc(repo, 'commit', '-q', '-m', 'main greet');
  const head = gitc(repo, 'rev-parse', 'HEAD');
  const t = await toFinal(rt, id);
  const card = await close(rt, t);
  rt.decideApproval(card.id, true, 'emperor', 'merge');
  const again = await waitFor(() => {
    const a = pending(rt, 'worktree', id);
    return a && a.id !== card.id ? a : undefined;
  }, 10000, 'card raised again');
  const w = t.worktree!;
  assert.equal(w.status, 'active');
  assert.ok(w.conflicts?.includes('greet.js'), JSON.stringify(w.conflicts));
  assert.match(again.detail, /上次处理未完成/);
  assert.match(again.detail, /greet\.js/);
  assert.equal(gitc(repo, 'rev-parse', 'HEAD'), head, 'main HEAD unchanged');
  assert.equal(gitc(repo, 'status', '--porcelain'), '', 'main checkout clean');
  assert.ok(!gitOk(repo, 'rev-parse', '-q', '--verify', 'MERGE_HEAD'), 'no merge in progress');
  assert.equal(fs.readFileSync(path.join(repo, 'greet.js'), 'utf8'), 'exports.greet = () => "main";\n');
  assert.ok(gitOk(repo, 'rev-parse', '--verify', '-q', w.branch), 'branch kept');
  assert.ok(fs.existsSync(w.path));
  assert.ok(actions(rt, id).includes('worktree_merge_failed'));
  rt.decideApproval(again.id, true, 'emperor', 'keep');
  await settled(rt, t, 'kept');
  assert.match(gitc(repo, 'show', `${w.branch}:greet.js`), /Hello/);
  rt.dispose();
  await mock.close();
});

test('a plain 准许 without a choice changes nothing; a worktree open as the workspace is not removed', async () => {
  const mock = await startMockLlm();
  const rt = makeRuntime(mock.url);
  const repo = makeRepo();
  rt.setWorkspace(repo);
  const root = rt.workspace!.root;
  const id = await startEdict(rt);
  const t = await toFinal(rt, id);
  const card = await close(rt, t);
  rt.decideApproval(card.id, true); // an approval dock without the choice buttons
  await waitFor(() => actions(rt, id).includes('worktree_deferred'), 5000, 'deferred');
  assert.equal(t.worktree!.status, 'active');
  assert.ok(fs.existsSync(t.worktree!.path));
  assert.ok(!fs.existsSync(path.join(repo, 'greet.js')), 'nothing merged');
  assert.ok(rt.activities(id, 200).some((a) => /未选择工作树的处理方式/.test(a.content)));
  // opened from Source Control: finishing would delete the open folder
  await worktreeOpen(rt, t.worktree!.path);
  const r = await worktreeFinish(rt, id, 'discard');
  assert.equal(r.ok, false);
  assert.match(r.message, /当前打开的工作区/);
  assert.ok(fs.existsSync(t.worktree!.path));
  await worktreeOpen(rt, root);
  const m = await worktreeFinish(rt, id, 'merge');
  assert.equal(m.ok, true, m.message);
  assert.ok(fs.existsSync(path.join(repo, 'greet.js')));
  assert.equal(pending(rt, 'worktree', id), undefined);
  rt.dispose();
  await mock.close();
});

test('mergeBranch: a real conflicted merge is aborted; local changes in the way refuse the merge without touching anything', async () => {
  const repo = makeRepo({ 'f.txt': 'a\n', 'g.txt': 'g\n' });
  gitc(repo, 'checkout', '-q', '-b', 'b');
  fs.writeFileSync(path.join(repo, 'f.txt'), 'b\n');
  gitc(repo, 'commit', '-q', '-am', 'b');
  gitc(repo, 'checkout', '-q', 'main');
  fs.writeFileSync(path.join(repo, 'f.txt'), 'c\n');
  gitc(repo, 'commit', '-q', '-am', 'c');
  const head = gitc(repo, 'rev-parse', 'HEAD');
  for (const dryRun of [false, true]) {
    const r = await mergeBranch(repo, 'b', 'm', { dryRun });
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.reason, 'conflict');
    assert.deepEqual(!r.ok && r.files, ['f.txt']);
    assert.equal(gitc(repo, 'rev-parse', 'HEAD'), head);
    assert.ok(!gitOk(repo, 'rev-parse', '-q', '--verify', 'MERGE_HEAD'), `aborted (dryRun=${dryRun})`);
    assert.equal(gitc(repo, 'status', '--porcelain'), '');
    assert.equal(fs.readFileSync(path.join(repo, 'f.txt'), 'utf8'), 'c\n');
  }
  // branch d touches g.txt, which has uncommitted edits in the main checkout
  gitc(repo, 'checkout', '-q', '-b', 'd');
  fs.writeFileSync(path.join(repo, 'g.txt'), 'from d\n');
  gitc(repo, 'commit', '-q', '-am', 'd');
  gitc(repo, 'checkout', '-q', 'main');
  fs.writeFileSync(path.join(repo, 'g.txt'), 'my unsaved work\n');
  const r = await mergeBranch(repo, 'd', 'm');
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.reason, 'dirty');
  assert.deepEqual(!r.ok && r.files, ['g.txt']);
  assert.equal(fs.readFileSync(path.join(repo, 'g.txt'), 'utf8'), 'my unsaved work\n');
  assert.equal(gitc(repo, 'rev-parse', 'HEAD'), head);
  // a detached main checkout is never merged into
  fs.writeFileSync(path.join(repo, 'g.txt'), 'g\n');
  gitc(repo, 'checkout', '-q', '--detach');
  const det = await mergeBranch(repo, 'd', 'm');
  assert.ok(!det.ok && /游离 HEAD/.test(det.message));
  gitc(repo, 'checkout', '-q', 'main');
  assert.equal(gitc(repo, 'rev-parse', 'HEAD'), head);
  // nothing new on a branch: nothing to merge
  gitc(repo, 'branch', 'same');
  const same = await mergeBranch(repo, 'same', 'm');
  assert.ok(same.ok && same.mergeCommit === null);
});

test('manual worktrees: create / list / open / remove and their guards', async () => {
  const mock = await startMockLlm();
  const rt = makeRuntime(mock.url);
  const repo = makeRepo();
  rt.setWorkspace(repo);
  const root = rt.workspace!.root;
  await assert.rejects(worktreeCreate(rt, { branch: 'bad..name' }), /分支名无效/);
  await assert.rejects(worktreeCreate(rt, { branch: 'x', base: 'no-such-rev' }), /找不到基准/);
  const a = await worktreeCreate(rt, { branch: 'feature/x' });
  assert.equal(a.kind, 'manual');
  assert.equal(a.branch, 'feature/x');
  assert.ok(a.managed && a.exists && !a.current);
  assert.equal(path.basename(a.path), 'manual-feature-x');
  assert.equal(path.dirname(a.path), path.join(rt.opts.dataDir, 'worktrees', repoHash(gitc(repo, 'rev-parse', '--show-toplevel'))));
  // an existing branch is checked out as is
  gitc(repo, 'branch', 'topic');
  const b = await worktreeCreate(rt, { branch: 'topic' });
  assert.equal(b.head, gitc(repo, 'rev-parse', 'topic'));
  await assert.rejects(worktreeCreate(rt, { branch: 'topic' }), /已存在/);
  const list = await worktreeList(rt);
  assert.equal(list.worktrees.length, 3);
  assert.equal(list.worktrees[0].kind, 'main');
  // guards
  await assert.rejects(worktreeRemove(rt, root), /主工作区/);
  await assert.rejects(worktreeRemove(rt, '/nowhere'), /不是当前仓库的工作树/);
  fs.writeFileSync(path.join(a.path, 'wip.txt'), 'unsaved\n');
  await assert.rejects(worktreeRemove(rt, a.path), /未提交的改动/);
  const removed = await worktreeRemove(rt, a.path, { force: true, deleteBranch: true });
  assert.ok(removed.removed && removed.branchDeleted, removed.message);
  assert.ok(!fs.existsSync(a.path));
  assert.ok(!gitOk(repo, 'rev-parse', '--verify', '-q', 'feature/x'));
  // open one as the workspace; the open one cannot be removed
  assert.equal(await worktreeOpen(rt, b.path), b.path);
  assert.equal(rt.workspace!.root, b.path);
  assert.ok((await worktreeList(rt)).worktrees.find((x) => x.path === b.path)!.current);
  await assert.rejects(worktreeRemove(rt, b.path), /当前打开的工作区/);
  await worktreeOpen(rt, root);
  const r2 = await worktreeRemove(rt, b.path);
  assert.ok(r2.removed && !r2.branchDeleted);
  assert.ok(gitOk(repo, 'rev-parse', '--verify', '-q', 'topic'), 'branch kept unless asked');
  assert.ok(rt.audit.list({ limit: 50 }).some((e) => e.action === 'worktree_remove'));
  // not a repository
  rt.setWorkspace(tmpDir('edict-ws-'));
  assert.deepEqual(await worktreeList(rt), { repoRoot: null, worktrees: [] });
  await assert.rejects(worktreeCreate(rt, { branch: 'y' }), /不是 git 仓库/);
  rt.dispose();
  await mock.close();
});

test('restart: an unanswered 结案 card comes back; a live edict whose worktree vanished is blocked; delete leaves the worktree findable', async () => {
  const mock = await startMockLlm();
  const dataDir = tmpDir('edict-data-');
  const rt = makeRuntime(mock.url, 'openai-chat', dataDir);
  const repo = makeRepo();
  rt.setWorkspace(repo);
  const [a, b, c] = [await startEdict(rt), await startEdict(rt), await startEdict(rt)];
  const [ta, tb, tc] = await Promise.all([a, b, c].map((id) => toFinal(rt, id)));
  await close(rt, ta); // card open, never answered
  await close(rt, tc);
  const lost = tb.worktree!.path;
  rt.dispose();
  fs.rmSync(lost, { recursive: true, force: true });

  const rt2 = makeRuntime(mock.url, 'openai-chat', dataDir);
  const card = pending(rt2, 'worktree', a);
  assert.ok(card, 'card re-raised after restart');
  assert.deepEqual(card!.choices!.map((x) => x.id), ['merge', 'keep', 'discard']);
  const t2b = rt2.tasks.get(b)!;
  assert.equal(t2b.state, 'Blocked');
  assert.match(t2b.blockedReason!, /独立工作树已丢失/);
  rt2.decideApproval(card!.id, true, 'emperor', 'merge');
  await settled(rt2, rt2.tasks.get(a)!, 'merged');
  assert.ok(fs.existsSync(path.join(repo, 'greet.js')));
  // the lost one: cancel → keep / discard (nothing to merge)
  rt2.cancel(b);
  const lc = await waitFor(() => pending(rt2, 'worktree', b), 5000, 'card for the lost worktree');
  assert.deepEqual(lc.choices!.map((x) => x.id), ['keep', 'discard']);
  assert.match(lc.detail, /目录已不存在/);
  rt2.decideApproval(lc.id, true, 'emperor', 'discard');
  await settled(rt2, t2b, 'discarded');
  assert.ok(!gitOk(repo, 'rev-parse', '--verify', '-q', `edict/${b}`));
  // deleting a finished edict without a choice leaves its worktree where it is and says so
  const t2c = rt2.tasks.get(c)!;
  const cardC = pending(rt2, 'worktree', c)!;
  const del = await worktreeOnDelete(rt2, t2c);
  assert.match(del.message!, new RegExp(t2c.worktree!.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(rt2.approvals.get(cardC.id)!.status, 'denied', 'card closed');
  assert.ok(fs.existsSync(t2c.worktree!.path));
  rt2.tasks.delete(c);
  const orphan = (await worktreeList(rt2)).worktrees.find((x) => x.taskId === c)!;
  assert.equal(orphan.kind, 'edict');
  assert.equal(orphan.status, undefined);
  await assert.rejects(worktreeRemove(rt2, orphan.path), /未提交的改动/);
  assert.ok((await worktreeRemove(rt2, orphan.path, { force: true, deleteBranch: true })).branchDeleted);
  assert.equal((await worktreeList(rt2)).worktrees.length, 1);
  rt2.dispose();
  await mock.close();
});

test('worktreePerEdict off: edicts on a git repo work in the open workspace and queue as before', async () => {
  const mock = await startMockLlm({ delayFor: (c) => (/兵部尚书|刑部尚书/.test(c.system) ? 20 : undefined) });
  const rt = makeRuntime(mock.url);
  rt.updateSettings({ worktreePerEdict: false });
  const repo = makeRepo();
  rt.setWorkspace(repo);
  const a = await startEdict(rt);
  const b = await startEdict(rt);
  const [ta, tb] = [await toFinal(rt, a), await toFinal(rt, b)];
  assert.ok(!ta.worktree && !tb.worktree && !ta.repoRoot);
  assert.ok([ta, tb].some((t) => t.flow.some((f) => f.state === 'Next')), 'queued');
  assert.ok(fs.existsSync(path.join(repo, 'greet.js')), 'written in the main checkout');
  assert.ok(!fs.existsSync(path.join(rt.opts.dataDir, 'worktrees')));
  decideGate(rt, a, { approve: true });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(pending(rt, 'worktree'), undefined, 'no 结案 card without a worktree');
  rt.dispose();
  await mock.close();
});

test('结案 dialog: per-file line counts of the worktree, and the emperor\'s commit subject', async () => {
  const mock = await startMockLlm();
  const rt = makeRuntime(mock.url);
  const repo = makeRepo({ 'src/a.txt': 'one\ntwo\nthree\n' });
  rt.setWorkspace(repo);
  const id = await startEdict(rt);
  const t = await toFinal(rt, id);
  const w = t.worktree!;
  // an edit to a tracked file on top of the agent's new files (untracked until the 结案 commit)
  fs.writeFileSync(path.join(w.path, 'src/a.txt'), 'one\n2\nthree\nfour\n');
  const stat = await worktreeDiffStat(rt, id);
  const by = Object.fromEntries(stat.map((f) => [f.path, f]));
  assert.deepEqual([by['src/a.txt'].added, by['src/a.txt'].removed], [2, 1]);
  assert.equal(by['greet.js'].added, 1);
  assert.equal(by['greet.js'].untracked, true);
  assert.ok(!stat.some((f) => f.path.startsWith('node_modules')), 'dependency links are not changes');
  const card = await close(rt, t);
  rt.decideApproval(card.id, true, 'emperor', 'keep', '实现 greet（皇上改的提交说明）');
  await settled(rt, t, 'kept');
  assert.equal(gitc(repo, 'log', '-1', '--format=%s', w.branch), '实现 greet（皇上改的提交说明）');
  // a kept branch: counted from base...branch in the repository
  const kept = await worktreeDiffStat(rt, id);
  assert.ok(kept.some((f) => f.path === 'src/a.txt' && f.added === 2 && f.removed === 1) && kept.some((f) => f.path === 'greet.js'));
  await worktreeFinish(rt, id, 'merge', '不会用到');
  assert.equal(t.worktree!.status, 'merged');
  assert.deepEqual(await worktreeDiffStat(rt, id), []);
  rt.dispose();
  await mock.close();
});
