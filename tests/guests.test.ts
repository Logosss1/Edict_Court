// 客卿 (2.1): outside agents driven over ACP do a ministry's subtask in the edict's worktree. Runs a FAKE ACP agent
// (tests/fixtures/fake-acp-agent.mjs) and the MOCK LLM server, with real git and a real shell (mock/integration).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { startMockLlm } from './mockLlm';
import { makeRuntime, tmpDir, waitFor, stateOf } from './helpers';
import { submit, decideGate } from '../src/main/runtime/orchestrator';
import { guestStatuses, saveGuest, setGuestDefaults, testGuest } from '../src/main/guests';
import { splitCommandLine, executorOf, removeGuest, guestLaunch } from '../src/main/guests/registry';
import { terminalCommand } from '../src/main/guests/run';
import type { ApprovalRequest, MinistryId, Task } from '../src/shared/types';

type Rt = ReturnType<typeof makeRuntime>;
const FAKE = path.resolve('tests/fixtures/fake-acp-agent.mjs');

const gitc = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
function makeRepo(git = true) {
  const dir = tmpDir('edict-guest-repo-');
  fs.writeFileSync(path.join(dir, 'README.md'), '# demo readme\n');
  fs.writeFileSync(path.join(dir, 'app.js'), '// app\n');
  if (!git) return dir;
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
  await sleep(200);
  for (const a of rt.approvals.values()) if (a.status === 'pending') rt.decideApproval(a.id, false, 'system');
  rt.dispose();
  await mock.close();
}

/** A custom guest that runs the fake agent in `mode`; its log of what it saw goes to the returned file. */
function addFake(rt: Rt, mode: string, name = `Fake ${mode}`) {
  const log = path.join(tmpDir('edict-fake-log-'), 'log.jsonl');
  const st = saveGuest(rt, { name, commandLine: `node ${FAKE} --mode ${mode} --log ${log}` });
  const read = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  return { id: st.id, log: read };
}

async function edict(rt: Rt, tier: 'lite' | 'full' = 'lite'): Promise<Task> {
  const r = (await submit(rt, { text: '写一个 greet 函数并测试', tier, multiAgent: true })) as { taskId: string };
  return rt.tasks.get(r.taskId)!;
}
const atFinal = (rt: Rt, t: Task) => waitFor(() => t.gate?.kind === 'final' || stateOf(rt, t.id) === 'Blocked' || stateOf(rt, t.id) === 'Cancelled', 40000, 'final gate');
const s1 = (t: Task) => t.nodes.find((n) => n.kind === 'exec' && n.subtaskId === 'S1')!;

test('command lines, terminal commands and the guest list', async () => {
  assert.deepEqual(splitCommandLine(`node "/a b/c.mjs" --mode 'x y' plain\\ word`), ['node', '/a b/c.mjs', '--mode', 'x y', 'plain word']);
  assert.throws(() => splitCommandLine('node "x'), /引号/);
  assert.equal(terminalCommand({ sessionId: 's', command: 'npm test' }, '/w'), 'npm test');
  assert.equal(terminalCommand({ sessionId: 's', command: '/bin/bash', args: ['-c', 'ls -la | wc -l'] }, '/w'), 'ls -la | wc -l');
  assert.equal(terminalCommand({ sessionId: 's', command: 'node', args: ['-e', "console.log('a b')"], env: [{ name: 'X', value: '1 2' }], cwd: '/w/sub' }, '/w'), `cd /w/sub && export X='1 2'; node -e 'console.log('\\''a b'\\'')'`);
  const mock = await startMockLlm();
  const rt = makeRuntime(mock.url);
  const list = guestStatuses(rt);
  assert.deepEqual(list.map((g) => g.id), ['claude', 'codex', 'gemini', 'opencode'], 'the four built-ins');
  for (const g of list) assert.ok(g.installHint && g.loginHint, `${g.id} has install / login hints`);
  const fake = addFake(rt, 'normal');
  const st = guestStatuses(rt).find((g) => g.id === fake.id)!;
  assert.equal(st.kind, 'custom');
  assert.equal(st.found, true, 'node found on this machine');
  assert.deepEqual(st.args?.slice(0, 1), [FAKE]);
  assert.throws(() => saveGuest(rt, { name: '', commandLine: 'x' }), /名字/);
  assert.throws(() => saveGuest(rt, { name: 'Nope', commandLine: '' }), /启动命令/);
  // dept defaults and per-subtask choice
  setGuestDefaults(rt, { deptDefault: { bingbu: fake.id } });
  assert.equal(executorOf(rt, { dept: 'bingbu' }), fake.id);
  assert.equal(executorOf(rt, { dept: 'bingbu', executor: 'self' }), null);
  assert.equal(executorOf(rt, { dept: 'xingbu' }), null);
  assert.equal(executorOf(rt, { dept: 'xingbu', executor: 'gemini' }), 'gemini');
  saveGuest(rt, { id: fake.id, enabled: false });
  assert.match((guestLaunch(rt, fake.id) as { error: string }).error, /停用/);
  removeGuest(rt, fake.id);
  assert.equal(executorOf(rt, { dept: 'bingbu' }), null, 'removing a custom guest clears its defaults');
  assert.match((guestLaunch(rt, 'codex') as { error?: string }).error ?? 'found', /没有找到|found/);
  await finish(rt, mock);
});

test('connection test: ok, needs login, cannot start', async () => {
  const mock = await startMockLlm();
  const rt = makeRuntime(mock.url);
  const ok = await testGuest(rt, addFake(rt, 'normal').id);
  assert.equal(ok.ok, true, ok.message);
  assert.equal(ok.agentName, 'Fake Agent');
  assert.equal(ok.agentVersion, '1.0.0');
  const auth = await testGuest(rt, addFake(rt, 'auth').id);
  assert.equal(auth.ok, false);
  assert.equal(auth.needsLogin, true);
  assert.match(auth.message, /还没登录/);
  const crash = await testGuest(rt, addFake(rt, 'crash').id);
  assert.equal(crash.ok, false);
  assert.match(crash.message, /cannot start/);
  assert.ok(rt.audit.list({ limit: 50 }).filter((e) => e.action === 'guest_test').length === 3);
  await finish(rt, mock);
});

test('a guest does the ministry subtask in the worktree: files and commands through Edict, its own writes recorded', async () => {
  const mock = await startMockLlm();
  const rt = makeRuntime(mock.url);
  const repo = makeRepo();
  rt.setWorkspace(repo);
  // also overwrites app.js through the client without reading it there first (it reads with its own tools)
  const fake = addFake(rt, 'overwrite', 'Fake normal');
  setGuestDefaults(rt, { deptDefault: { bingbu: fake.id } });
  const t = await edict(rt);
  await atFinal(rt, t);
  assert.equal(t.state, 'PendingConfirm', t.blockedReason);
  const w = t.worktree!;
  const n = s1(t);
  assert.deepEqual(n.guest, { id: fake.id, name: 'Fake normal' });
  // the ministry's own model was not called for S1 (the 刑部 verify subtask still was)
  assert.equal(mock.calls.filter((c) => c.system.includes('兵部尚书')).length, 0);
  assert.ok(mock.calls.some((c) => c.system.includes('刑部尚书')));
  const seen = fake.log();
  assert.equal(seen.find((x) => x.sessionCwd)?.sessionCwd, w.path, 'session opened in the worktree');
  assert.equal(seen.find((x) => x.sessionCwd)?.port, String(w.ports!.from), 'the worktree port reaches the guest');
  assert.deepEqual(seen.find((x) => x.clientCapabilities)?.clientCapabilities, { fs: { readTextFile: true, writeTextFile: true }, terminal: true });
  assert.equal(seen.find((x) => x.read)?.read, '# demo readme\n');
  assert.deepEqual(seen.find((x) => x.permission)?.permission, { outcome: 'selected', optionId: 'ok' }, 'full-auto: allowed by Edict rules, once');
  assert.match(seen.find((x) => x.output)?.output ?? '', new RegExp(`Hello, A port=${w.ports!.from}`));
  const brief = seen.find((x) => x.prompt)!.prompt as string;
  assert.match(brief, /客卿 Fake normal，替兵部办/);
  assert.match(brief, /实现 greet\.js/);
  assert.match(brief, /```json|"status"/);
  // writes landed in the worktree and are recorded: greet.js by fs (tool), notes.md by its own tool (guest)
  assert.ok(fs.existsSync(path.join(w.path, 'greet.js')) && !fs.existsSync(path.join(repo, 'greet.js')));
  const ch = t.changes.filter((c) => c.nodeId === n.id);
  assert.deepEqual(ch.map((c) => [c.path, c.via]).sort(), [['app.js', 'tool'], ['greet.js', 'tool'], ['notes.md', 'guest']]);
  assert.equal(fs.readFileSync(path.join(w.path, 'app.js'), 'utf8'), "require('./greet');\n");
  assert.equal(ch.find((c) => c.path === 'notes.md')!.command, 'Fake normal');
  // conclusion checked like any ministry's, noting who did it
  const out = JSON.parse(n.output!);
  assert.equal(out.status, 'done', JSON.stringify(out));
  assert.ok(out.systemCheck.some((x: string) => x.includes('由客卿 Fake normal 办理')));
  assert.ok(out.systemCheck.some((x: string) => x.includes('执行命令 1 次')));
  const acts = rt.activities(t.id).filter((a) => a.nodeId === n.id);
  assert.ok(acts.some((a) => a.kind === 'text' && a.content.includes('已写好 greet.js')), 'guest text streamed');
  assert.ok(acts.some((a) => a.kind === 'thinking'), 'guest thoughts streamed');
  assert.ok(acts.some((a) => a.kind === 'log' && a.content.includes('的计划')));
  assert.ok(rt.audit.list({ taskId: t.id, limit: 300 }).some((e) => e.action === 'guest_start'));
  await finish(rt, mock);
});

test('ask mode: one card for the write (not twice), one for the command; a refused permission reaches the guest', async () => {
  const mock = await startMockLlm();
  const rt = makeRuntime(mock.url);
  rt.updateSettings({ permissionMode: 'ask' });
  const repo = makeRepo();
  rt.setWorkspace(repo);
  const fake = addFake(rt, 'normal');
  setGuestDefaults(rt, { deptDefault: { bingbu: fake.id } });
  const t = await edict(rt);
  const wt = await waitFor(() => pending(rt, 'write_task', t.id), 30000, 'write task card');
  assert.match(wt.summary, /请客卿 Fake normal 代办/);
  rt.decideApproval(wt.id, true, 'emperor', 'write');
  const write = await waitFor(() => pending(rt, 'action', t.id), 20000, 'guest write card');
  assert.match(write.summary, /写入文件：greet\.js/);
  rt.decideApproval(write.id, true, 'emperor', 'once');
  const cmd = await waitFor(() => pending(rt, 'action', t.id), 20000, 'command card');
  assert.match(cmd.summary, /执行命令：export FAKE=1; node -e/);
  rt.decideApproval(cmd.id, true, 'emperor', 'once');
  // later cards belong to the 刑部 subtask (mock official): approve whatever comes until the final gate
  const asked: ApprovalRequest[] = [write, cmd];
  await waitFor(() => {
    const a = pending(rt, undefined, t.id);
    if (a) {
      if (a.nodeId === s1(t).id) asked.push(a);
      rt.decideApproval(a.id, true, 'emperor', a.kind === 'write_task' ? 'write' : 'once');
    }
    return t.gate?.kind === 'final' || t.state === 'Blocked';
  }, 40000, 'final gate');
  assert.equal(asked.filter((a) => a.nodeId === s1(t).id && a.kind === 'action').length, 2, 'the fs write after the permission card was not asked again');
  assert.ok(fs.existsSync(path.join(t.worktree!.path, 'greet.js')));
  await finish(rt, mock);

  // a refused permission: the guest is told no and reports it
  const mock2 = await startMockLlm();
  const rt2 = makeRuntime(mock2.url);
  rt2.updateSettings({ permissionMode: 'ask' });
  rt2.setWorkspace(makeRepo());
  const f2 = addFake(rt2, 'normal');
  setGuestDefaults(rt2, { deptDefault: { bingbu: f2.id } });
  const t2 = await edict(rt2);
  rt2.decideApproval((await waitFor(() => pending(rt2, 'write_task', t2.id), 30000, 'write task')).id, true, 'emperor', 'write');
  rt2.decideApproval((await waitFor(() => pending(rt2, 'action', t2.id), 20000, 'write card')).id, false, 'emperor', 'deny', '先别写');
  await waitFor(() => f2.log().some((x) => x.permission), 10000, 'guest got the answer');
  assert.equal(f2.log().find((x) => x.permission).permission.optionId, 'no');
  await waitFor(() => t2.state === 'Blocked' || s1(t2).status === 'failed', 20000, 'S1 fails (guest reports failed)');
  assert.ok(!fs.existsSync(path.join(t2.worktree!.path, 'greet.js')));
  await finish(rt2, mock2);
});

test('falls back to the ministry: guest cannot start, needs login, or there is no worktree', async () => {
  for (const mode of ['crash', 'auth']) {
    const mock = await startMockLlm();
    const rt = makeRuntime(mock.url);
    rt.setWorkspace(makeRepo());
    const fake = addFake(rt, mode);
    setGuestDefaults(rt, { deptDefault: { bingbu: fake.id } });
    const t = await edict(rt);
    await atFinal(rt, t);
    assert.equal(t.state, 'PendingConfirm', `${mode}: ${t.blockedReason}`);
    assert.equal(s1(t).guest, undefined, `${mode}: done by the ministry`);
    assert.ok(mock.calls.some((c) => c.system.includes('兵部尚书')), `${mode}: the ministry's model did S1`);
    const err = rt.activities(t.id).find((a) => a.kind === 'error' && a.content.includes('没能接手'))!;
    assert.ok(err, `${mode}: told why`);
    assert.match(err.content, /退回兵部自己办/);
    if (mode === 'auth') assert.match(err.content, /还没登录/);
    if (mode === 'crash') assert.match(err.content, /cannot start/);
    assert.ok(rt.audit.list({ taskId: t.id, limit: 300 }).some((e) => e.action === 'guest_fallback'));
    await finish(rt, mock);
  }
  // no git repository → no worktree → the ministry does it, and says why
  const mock = await startMockLlm();
  const rt = makeRuntime(mock.url);
  rt.setWorkspace(makeRepo(false));
  const fake = addFake(rt, 'normal');
  setGuestDefaults(rt, { deptDefault: { bingbu: fake.id } });
  const t = await edict(rt);
  await atFinal(rt, t);
  assert.equal(s1(t).guest, undefined);
  assert.ok(rt.activities(t.id).some((a) => a.content.includes('只在旨意自己的工作树里办差') && a.content.includes('不是有提交记录的 git 仓库')));
  assert.equal(fake.log().length, 0, 'never started');
  await finish(rt, mock);
});

test('chosen per subtask on the plan card; a read-only subtask whose guest changed files asks to keep or revert', async () => {
  const mock = await startMockLlm();
  const rt = makeRuntime(mock.url);
  rt.updateSettings({ permissionMode: 'auto-edit', planGate: { lite: true, full: true } });
  const repo = makeRepo();
  rt.setWorkspace(repo);
  const sneaky = addFake(rt, 'readonly-sneaky', 'Sneaky');
  const t = await edict(rt);
  await waitFor(() => t.gate?.kind === 'plan', 30000, 'plan gate');
  const plan = JSON.parse(JSON.stringify(t.plan));
  // S2 becomes a read-only review done by the guest
  plan.subtasks[1] = { ...plan.subtasks[1], effect: 'read', executor: sneaky.id };
  decideGate(rt, t.id, { approve: true, plan });
  assert.equal(t.plan!.subtasks[1].executor, sneaky.id, 'the plan keeps who does it');
  // S1 (兵部, writes) still asks to start writing in this mode
  const card = await waitFor(() => {
    const wt = pending(rt, 'write_task', t.id);
    if (wt) rt.decideApproval(wt.id, true, 'emperor', 'write');
    return pending(rt, 'guest', t.id);
  }, 40000, 'keep or revert card');
  assert.match(card.summary, /客卿 Sneaky 在只读子任务里改了 1 个文件/);
  assert.match(card.detail ?? '', /sneaky\.txt/);
  assert.ok(fs.existsSync(path.join(t.worktree!.path, 'sneaky.txt')));
  rt.decideApproval(card.id, true, 'emperor', 'revert');
  await waitFor(() => t.gate?.kind === 'final' || t.state === 'Blocked', 30000, 'final gate');
  assert.ok(!fs.existsSync(path.join(t.worktree!.path, 'sneaky.txt')), 'reverted');
  const ch = t.changes.find((c) => c.path === 'sneaky.txt')!;
  assert.equal(ch.via, 'guest');
  assert.equal(ch.reverted, true);
  await finish(rt, mock);
});

test('no structured conclusion: asked once more in the same session; cancelling the edict stops the guest', async () => {
  const mock = await startMockLlm();
  const rt = makeRuntime(mock.url);
  rt.setWorkspace(makeRepo());
  const nf = addFake(rt, 'noformat');
  setGuestDefaults(rt, { deptDefault: { bingbu: nf.id } });
  const t = await edict(rt);
  await atFinal(rt, t);
  const prompts = nf.log().filter((x) => x.prompt);
  assert.equal(prompts.length, 2);
  assert.match(prompts[1].prompt, /请只输出结构化结论/);
  assert.match(JSON.parse(s1(t).output!).summary, /补交结论/);
  await finish(rt, mock);

  const mock2 = await startMockLlm();
  const rt2 = makeRuntime(mock2.url);
  rt2.setWorkspace(makeRepo());
  const hang = addFake(rt2, 'hang');
  setGuestDefaults(rt2, { deptDefault: { bingbu: hang.id as string } as Partial<Record<MinistryId, string>> });
  const t2 = await edict(rt2);
  await waitFor(() => hang.log().some((x) => x.prompt), 30000, 'guest working');
  rt2.cancel(t2.id, '不办了');
  await waitFor(() => hang.log().some((x) => x.cancelled), 10000, 'session/cancel sent');
  await waitFor(() => rt2.agents.get('bingbu')?.status === 'idle', 10000, 'ministry idle again');
  assert.equal(t2.state, 'Cancelled');
  await finish(rt2, mock2);
});
