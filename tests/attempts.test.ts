// 排班 (2.1): one write subtask done by 2–3 lanes side by side, each in its own worktree; 门下省 scores them,
// one is picked and only its changes go into the edict worktree. MOCK LLM + a FAKE ACP agent, real git (mock/integration).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { startMockLlm, defaultBrain } from './mockLlm';
import { makeRuntime, tmpDir, waitFor } from './helpers';
import { submit, decideGate, keepEmperorChoices, validatePlan } from '../src/main/runtime/orchestrator';
import { saveGuest } from '../src/main/guests';
import { chooseAttempt, attemptDiff, estimateLanes, lanesWanted } from '../src/main/runtime/attemptRun';
import type { RunNode, Task } from '../src/shared/types';
import * as wt from '../src/main/services/worktree';

type Rt = ReturnType<typeof makeRuntime>;
const FAKE = path.resolve('tests/fixtures/fake-acp-agent.mjs');
const gitc = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
function makeRepo() {
  const dir = tmpDir('edict-att-repo-');
  fs.writeFileSync(path.join(dir, 'README.md'), '# demo readme\n');
  fs.writeFileSync(path.join(dir, 'app.js'), '// app\n');
  gitc(dir, 'init', '-q', '-b', 'main');
  gitc(dir, 'config', 'user.name', 'Test');
  gitc(dir, 'config', 'user.email', 'test@example.com');
  gitc(dir, 'config', 'commit.gpgsign', 'false');
  gitc(dir, 'add', '-A');
  gitc(dir, 'commit', '-q', '-m', 'init');
  return dir;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pending = (rt: Rt, kind?: string, taskId?: string) => [...rt.approvals.values()].find((a) => a.status === 'pending' && (!kind || a.kind === kind) && (!taskId || a.taskId === taskId));
async function finish(rt: Rt, mock: { close: () => Promise<void> }) {
  for (const t of rt.tasks.values()) rt.cancel(t.id, 'test over');
  for (const a of rt.approvals.values()) if (a.status === 'pending') rt.decideApproval(a.id, false, 'system');
  await sleep(300);
  for (const a of rt.approvals.values()) if (a.status === 'pending') rt.decideApproval(a.id, false, 'system');
  rt.dispose();
  await mock.close();
}
const branches = (repo: string) => gitc(repo, 'branch', '--format=%(refname:short)').split('\n').filter(Boolean);
const node = (t: Task, id: string) => t.nodes.find((n) => n.id === id) as RunNode;
/** Approve the write-task and action cards along the way (auto-edit asks before commands). */
const approveWork = (rt: Rt, t: Task) => {
  for (const a of rt.approvals.values()) {
    if (a.status !== 'pending' || a.taskId !== t.id) continue;
    if (a.kind === 'write_task') rt.decideApproval(a.id, true, 'emperor', 'write');
    else if (a.kind === 'action') rt.decideApproval(a.id, true, 'emperor', 'once');
  }
};

/** Submit, stop at the plan card, set S1's (or `sub`'s) lanes, approve. */
async function withLanes(rt: Rt, lanes: { executor: string }[], sub = 0): Promise<Task> {
  const r = (await submit(rt, { text: '写一个 greet 函数并测试', tier: 'lite', multiAgent: true })) as { taskId: string };
  const t = rt.tasks.get(r.taskId)!;
  await waitFor(() => t.gate?.kind === 'plan', 30000, 'plan gate');
  const plan = JSON.parse(JSON.stringify(t.plan));
  plan.subtasks[sub].lanes = lanes;
  plan.subtasks[sub].effect = 'write';
  decideGate(rt, t.id, { approve: true, plan });
  assert.equal(t.plan!.subtasks[sub].lanes?.length, lanes.length, 'the plan keeps the lanes');
  return t;
}

test('the emperor picks a lane on the 比试 page: only its changes go in; the other is kept as a branch', async () => {
  const mock = await startMockLlm();
  const rt = makeRuntime(mock.url);
  rt.updateSettings({ permissionMode: 'auto-edit', planGate: { lite: true, full: true } });
  const repo = makeRepo();
  rt.setWorkspace(repo);
  const fake = saveGuest(rt, { name: 'Fake', commandLine: `node ${FAKE} --mode normal` });
  const t = await withLanes(rt, [{ executor: 'self' }, { executor: fake.id }]);
  const card = await waitFor(() => {
    approveWork(rt, t);
    return pending(rt, 'attempt', t.id);
  }, 60000, '比试 card');
  assert.match(card.summary, /2 路都办完了/);
  assert.equal(card.choices?.length, 3, 'one per lane + 都不用');
  const rec = t.attempts![0];
  assert.equal(rec.status, 'choosing');
  const [a, b] = rec.lanes;
  assert.equal(a.label, '甲');
  assert.equal(b.label, '乙');
  // each lane in its own worktree on its own branch and ports, from the same base
  const w = t.worktree!;
  assert.ok(a.worktree!.path !== b.worktree!.path && a.worktree!.path !== w.path);
  assert.ok(fs.existsSync(path.join(a.worktree!.path, 'greet.js')) && fs.existsSync(path.join(b.worktree!.path, 'greet.js')));
  assert.ok(fs.existsSync(path.join(b.worktree!.path, 'notes.md')), 'the guest lane wrote notes.md with its own tool');
  assert.ok(!fs.existsSync(path.join(w.path, 'greet.js')), 'nothing in the edict worktree yet');
  const ports = [w.ports!.from, a.worktree!.ports!.from, b.worktree!.ports!.from];
  assert.equal(new Set(ports).size, 3, `three port blocks: ${ports}`);
  assert.equal(node(t, a.nodeId).kind, 'lane');
  assert.equal(node(t, b.nodeId).guest?.name, 'Fake');
  // lane changes stay with the lane
  assert.ok(!t.changes.some((c) => c.path === 'greet.js'));
  assert.ok(a.changes?.some((c) => c.path === 'greet.js'));
  assert.ok(b.changes?.some((c) => c.path === 'notes.md' && c.via === 'guest'));
  // 门下省 scored both and recommends 乙 (the mock's default)
  assert.equal(rec.recommended, b.id);
  assert.equal(b.score, 90);
  assert.ok(a.score! < 90);
  assert.equal(node(t, rec.judgeNodeId!).status, 'done');
  assert.ok(mock.calls.some((c) => c.lastUser.includes('【比试】')));
  assert.match(attemptDiff(rt, t.id, b.id), /notes\.md/);
  assert.deepEqual(b.diff && { files: b.diff.files }, { files: 2 });
  // the emperor picks 甲 against the advice and keeps the other branch
  chooseAttempt(rt, t.id, a.id, { keepOthers: true });
  await waitFor(() => {
    approveWork(rt, t);
    return t.gate?.kind === 'final' || t.state === 'Blocked';
  }, 60000, 'final gate');
  assert.equal(t.state, 'PendingConfirm', t.blockedReason);
  assert.equal(rec.status, 'applied');
  assert.equal(rec.pick, a.id);
  assert.equal(rec.pickedBy, 'emperor');
  assert.equal(rec.keptOthers, true);
  assert.ok(fs.existsSync(path.join(w.path, 'greet.js')));
  assert.ok(!fs.existsSync(path.join(w.path, 'notes.md')), '乙路 was not picked');
  const main = node(t, rec.nodeId);
  assert.ok(t.changes.some((c) => c.path === 'greet.js' && c.nodeId === main.id), 'recorded on the subtask node');
  assert.match(JSON.parse(main.output!).systemCheck[0], /排班 2 路，采用甲路/);
  // lane worktrees gone; 甲's branch deleted, 乙's kept with its work committed
  assert.ok(!fs.existsSync(a.worktree!.path) && !fs.existsSync(b.worktree!.path));
  assert.equal(a.worktree!.status, 'discarded');
  assert.equal(b.worktree!.status, 'kept');
  const br = branches(repo);
  assert.ok(!br.includes(a.worktree!.branch) && br.includes(b.worktree!.branch), br.join(' '));
  assert.match(gitc(repo, 'show', '--stat', '--format=%s', b.worktree!.branch), /notes\.md/);
  // S2 (刑部) ran after S1 and found greet.js
  assert.ok(fs.existsSync(path.join(w.path, 'greet.test.js')));
  assert.ok(rt.audit.list({ taskId: t.id, limit: 400 }).some((e) => e.action === 'attempt_picked'));
  await finish(rt, mock);
});

test('full-auto: 门下省 picks; lanes start from the edict worktree as it is (uncommitted work of an earlier subtask)', async () => {
  const mock = await startMockLlm();
  const rt = makeRuntime(mock.url);
  rt.updateSettings({ planGate: { lite: true, full: true } });
  const repo = makeRepo();
  rt.setWorkspace(repo);
  // S2 (刑部: writes greet.test.js and runs it) gets two lanes; S1's greet.js is in the worktree, not committed
  const t = await withLanes(rt, [{ executor: 'self' }, { executor: 'self' }], 1);
  await waitFor(() => t.gate?.kind === 'final' || t.state === 'Blocked', 60000, 'final gate');
  assert.equal(t.state, 'PendingConfirm', t.blockedReason);
  const rec = t.attempts![0];
  assert.equal(rec.subtaskId, 'S2');
  assert.equal(rec.pickedBy, 'menxia');
  assert.equal(rec.pick, rec.lanes[1].id, 'the recommended lane');
  for (const l of rec.lanes) {
    const out = JSON.parse(node(t, l.nodeId).output!);
    assert.match(out.verification, /ok/, `${l.label}: node greet.test.js passed in its worktree (greet.js came along)`);
  }
  assert.ok(fs.existsSync(path.join(t.worktree!.path, 'greet.test.js')));
  assert.equal(pending(rt, 'attempt', t.id), undefined, 'no card in full-auto');
  assert.ok(rec.lanes.every((l) => l.worktree?.status === 'discarded'));
  assert.ok(!branches(repo).some((b) => b.includes('-S2-')), 'lane branches deleted');
  assert.ok(rt.activities(t.id).some((a) => a.content.includes('全自动模式：按门下省推荐采用乙路')));
  await finish(rt, mock);
});

test('one lane fails: the other is used without a 比试; none picked fails the node and a retry runs new lanes', async () => {
  const mock = await startMockLlm({
    brain: (c) => {
      // 甲路 reports failure
      if (c.system.includes('兵部尚书') && c.messages.some((m) => m.content.includes('你是甲路')) && !(c.tools.length && c.toolResults === 0)) return { text: '```json\n{"status":"failed","summary":"甲路没写出来","artifacts":[],"verification":"未验证","issues":["写不出"]}\n```' };
      return defaultBrain({})(c);
    },
  });
  const rt = makeRuntime(mock.url);
  rt.updateSettings({ permissionMode: 'auto-edit', planGate: { lite: true, full: true } });
  rt.setWorkspace(makeRepo());
  const t = await withLanes(rt, [{ executor: 'self' }, { executor: 'self' }]);
  await waitFor(() => {
    approveWork(rt, t);
    return t.gate?.kind === 'final' || t.state === 'Blocked';
  }, 60000, 'final gate');
  const rec = t.attempts![0];
  assert.equal(node(t, rec.lanes[0].nodeId).status, 'failed');
  assert.equal(rec.pick, rec.lanes[1].id);
  assert.equal(rec.judgeNodeId, undefined, 'no 门下 评比 for a single finisher');
  assert.ok(rt.activities(t.id).some((a) => a.content.includes('只有乙路办成')));
  await finish(rt, mock);

  // 都不用 → S1 fails (blocked); retry → a second 排班 with new lane nodes
  const mock2 = await startMockLlm();
  const rt2 = makeRuntime(mock2.url);
  rt2.updateSettings({ permissionMode: 'auto-edit', planGate: { lite: true, full: true } });
  rt2.setWorkspace(makeRepo());
  const t2 = await withLanes(rt2, [{ executor: 'self' }, { executor: 'self' }]);
  const card = await waitFor(() => {
    approveWork(rt2, t2);
    return pending(rt2, 'attempt', t2.id);
  }, 60000, '比试 card');
  rt2.decideApproval(card.id, false, 'emperor', 'none', '都不好');
  await waitFor(() => t2.state === 'Blocked', 20000, 'blocked');
  const first = t2.attempts![0];
  assert.equal(first.status, 'failed');
  assert.match(first.error!, /皇上没有采用任何一路：都不好/);
  assert.ok(first.lanes.every((l) => !fs.existsSync(l.worktree!.path)));
  const { retryNode } = await import('../src/main/runtime/orchestrator');
  retryNode(rt2, t2.id, first.nodeId);
  await waitFor(() => pending(rt2, 'attempt', t2.id), 60000, 'second 比试 card');
  assert.equal(t2.attempts!.length, 2);
  assert.notDeepEqual(t2.attempts![1].lanes.map((l) => l.nodeId), first.lanes.map((l) => l.nodeId), 'new lane nodes');
  await finish(rt2, mock2);
});

test('cancelling while lanes work removes their worktrees and branches', async () => {
  const mock = await startMockLlm();
  const rt = makeRuntime(mock.url);
  rt.updateSettings({ planGate: { lite: true, full: true } });
  const repo = makeRepo();
  rt.setWorkspace(repo);
  const log = path.join(tmpDir('edict-fake-log-'), 'log.jsonl');
  const hang = saveGuest(rt, { name: 'Hang', commandLine: `node ${FAKE} --mode hang --log ${log}` });
  const t = await withLanes(rt, [{ executor: hang.id }, { executor: hang.id }]);
  await waitFor(() => fs.existsSync(log) && fs.readFileSync(log, 'utf8').split('\n').filter((l) => l.includes('"prompt"')).length === 2, 30000, 'both lanes working');
  const rec = t.attempts![0];
  const dirs = rec.lanes.map((l) => l.worktree!.path);
  assert.ok(dirs.every((d) => fs.existsSync(d)));
  rt.cancel(t.id, '不办了');
  await waitFor(() => rec.lanes.every((l) => l.worktree?.status === 'discarded'), 15000, 'lanes cleaned');
  assert.ok(dirs.every((d) => !fs.existsSync(d)));
  assert.ok(!branches(repo).some((b) => b.includes('-S1-')));
  assert.equal(rec.status, 'failed');
  await finish(rt, mock);
});

test('排班 rules: write subtasks in a worktree only; 中书省 cannot set lanes or guests; cost estimate', async () => {
  const t = { tier: 'lite', worktree: { status: 'active' } } as unknown as Task;
  const sub = { id: 'S1', dept: 'bingbu', title: 'x', detail: '', acceptance: '', dependsOn: [], lanes: [{ executor: 'self' }, { executor: 'self' }] } as never;
  const n = (o: Partial<RunNode>) => ({ id: 'exec-S1-r1', kind: 'exec', effect: 'write', ...o }) as RunNode;
  assert.equal(lanesWanted(t, n({}), sub).lanes?.length, 2);
  assert.match(lanesWanted(t, n({ effect: 'read' }), sub).why!, /写入类/);
  assert.match(lanesWanted(t, n({ grant: 'readonly' }), sub).why!, /只读/);
  assert.match(lanesWanted({ ...t, worktree: undefined } as Task, n({}), sub).why!, /工作树/);
  assert.equal(lanesWanted(t, n({ id: 'exec-S1-r2' }), sub).lanes, undefined, 'rework: one lane');
  assert.equal(lanesWanted(t, n({ laneId: 'x' }), sub).lanes, undefined);
  // 中书省's JSON never sets who does it; the emperor's choice survives its revision
  const v = validatePlan({ summary: 's', subtasks: [{ id: 'S1', title: 'a', dept: 'bingbu', effect: 'write', executor: 'codex', lanes: [{ executor: 'self' }, { executor: 'codex' }], suggestAttempts: '算法难' }], risks: [] });
  const kept = keepEmperorChoices(JSON.parse(JSON.stringify(v.plan)));
  assert.equal(kept.subtasks[0].executor, undefined);
  assert.equal(kept.subtasks[0].lanes, undefined);
  assert.equal(kept.subtasks[0].suggestAttempts, '算法难', 'the suggestion stays');
  const again = keepEmperorChoices(JSON.parse(JSON.stringify(v.plan)), v.plan);
  assert.equal(again.subtasks[0].lanes?.length, 2);
  const mock = await startMockLlm();
  const rt = makeRuntime(mock.url);
  const est = estimateLanes(rt, 'bingbu', [{ executor: 'self' }, { executor: 'claude' }]);
  assert.ok(est.lanes[0].costUsd! > 0);
  assert.equal(est.lanes[1].costUsd, null, 'a guest bills its own account');
  assert.match(est.lanes[1].who, /客卿 Claude Code/);
  assert.ok(est.totalUsd >= est.lanes[0].costUsd!);
  await finish(rt, mock);
});

test('lane plumbing: a snapshot holds untracked work but not ignored files or links; changes; 3-way merge', async () => {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, '.gitignore'), 'dist/\n');
  gitc(repo, 'add', '-A');
  gitc(repo, 'commit', '-q', '-m', 'ignore');
  const head = gitc(repo, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(repo, 'app.js'), '// app\nchanged\n');
  fs.writeFileSync(path.join(repo, 'new.txt'), 'new\n');
  fs.mkdirSync(path.join(repo, 'dist'));
  fs.writeFileSync(path.join(repo, 'dist', 'out.js'), 'built\n');
  fs.mkdirSync(path.join(repo, 'node_modules'));
  fs.writeFileSync(path.join(repo, 'node_modules', 'x.js'), 'dep\n');
  fs.rmSync(path.join(repo, 'README.md'));
  const status = gitc(repo, 'status', '--porcelain');
  const base = await wt.snapshotCommit(repo, 'snap', ['node_modules']);
  assert.equal(gitc(repo, 'rev-parse', 'HEAD'), head, 'HEAD not moved');
  assert.equal(gitc(repo, 'status', '--porcelain'), status, 'index and files untouched');
  assert.equal(gitc(repo, 'rev-parse', `${base}^`), head);
  const ch = await wt.treeChanges(repo, head, base);
  assert.deepEqual(ch.map((c) => `${c.status} ${c.path}`).sort(), ['A new.txt', 'D README.md', 'M app.js']);
  const d = await wt.treeDiffText(repo, head, base);
  assert.equal(d.files, 3);
  assert.match(d.text, /\+changed/);
  assert.equal((await wt.blobAt(repo, base, 'new.txt'))?.toString(), 'new\n');
  assert.equal(await wt.blobAt(repo, base, 'README.md'), null);
  const m = await wt.mergeThree(Buffer.from('a\nb\nc\nd\n'), Buffer.from('a\nb\nc\n'), Buffer.from('A\nb\nc\n'));
  assert.equal(m.ok, true);
  assert.equal(m.out.toString(), 'A\nb\nc\nd\n');
  assert.equal((await wt.mergeThree(Buffer.from('x\n'), Buffer.from('a\n'), Buffer.from('y\n'))).ok, false);
});
