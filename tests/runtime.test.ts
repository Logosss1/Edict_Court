// Runtime integration tests against the MOCK LLM server (label: mock/integration).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startMockLlm } from './mockLlm';
import { makeRuntime, tmpDir, waitFor, stateOf } from './helpers';
import { submit, decideGate, retryNode } from '../src/main/runtime/orchestrator';
import { assertTransition } from '../src/main/runtime/stateMachine';
import { createDebate, interject, runDebate, concludeDebate } from '../src/main/runtime/debate';
import type { Protocol } from '../src/shared/types';

test('state machine rejects illegal transitions and human-only edges', () => {
  assert.throws(() => assertTransition('Doing', 'Taizi', 'full', 'system'), /非法状态流转/);
  assert.throws(() => assertTransition('Zhongshu', 'Assigned', 'full', 'system'), /允许的目标/); // cannot bypass 门下省
  assert.throws(() => assertTransition('PendingConfirm', 'Done', 'full', 'shangshu'), /皇上亲自确认/);
  assert.doesNotThrow(() => assertTransition('PendingConfirm', 'Done', 'full', 'emperor'));
  assert.throws(() => assertTransition('Pending', 'Doing', 'lite', 'system'));
  assert.doesNotThrow(() => assertTransition('Pending', 'Doing', 'solo', 'system'));
  assert.throws(() => assertTransition('Done', 'Doing', 'full', 'emperor'), /已终结/);
});

test('taizi triage: chat is answered directly without creating a task', async () => {
  const mock = await startMockLlm();
  const rt = makeRuntime(mock.url);
  const r = await submit(rt, { text: '你好', tier: 'lite', multiAgent: true });
  assert.equal(r.kind, 'chat');
  assert.equal(rt.tasks.size, 0);
  rt.dispose();
  await mock.close();
});

for (const protocol of ['openai-chat', 'anthropic-messages', 'openai-responses'] as Protocol[]) {
  test(`Court Lite end-to-end with 封驳 loop over ${protocol}`, async () => {
    const mock = await startMockLlm({ rejectPlanTimes: 1 });
    const rt = makeRuntime(mock.url, protocol);
    const ws = tmpDir('edict-ws-');
    rt.setWorkspace(ws);
    const r = await submit(rt, { text: '写一个 greet 函数并测试', tier: 'lite', multiAgent: true });
    assert.equal(r.kind, 'task');
    const id = (r as { taskId: string }).taskId;
    await waitFor(() => rt.tasks.get(id)!.gate?.kind === 'final' || stateOf(rt, id) === 'Blocked', 20000, 'final gate');
    const t = rt.tasks.get(id)!;
    assert.equal(t.state, 'PendingConfirm', t.blockedReason);
    // 封驳 happened once and forced a re-plan
    assert.equal(t.reviews.filter((x) => x.verdict === 'reject').length, 1);
    assert.equal(t.planHistory.length, 2);
    const states = t.flow.map((f) => f.state);
    assert.ok(states.indexOf('Zhongshu') < states.indexOf('Menxia'));
    assert.ok(fs.existsSync(path.join(ws, 'greet.js')), 'artifact greet.js exists');
    assert.ok(fs.existsSync(path.join(ws, 'greet.test.js')), 'artifact test exists');
    // usage accounted and key never leaked into audit
    assert.ok(t.usage.inputTokens > 0 && t.usage.costUsd > 0);
    const audit = fs.readFileSync(path.join(rt.opts.dataDir, 'audit.jsonl'), 'utf8');
    assert.ok(!audit.includes('SECRET'), 'api key must not be in audit');
    assert.ok(mock.calls.every((c) => (c.auth ?? '').includes('sk-test-SECRET')), 'key sent only as auth header');
    decideGate(rt, id, { approve: true, comment: '准' });
    assert.equal(stateOf(rt, id), 'Done');
    const m = rt.memorials.get(id)!;
    assert.equal(m.stages.length, 5);
    assert.ok(m.artifacts.some((a) => a.path === 'greet.js' && a.sha256.length === 64));
    assert.ok(rt.audit.verify().ok);
    rt.dispose();
    await mock.close();
  });
}

test('Full Court: plan gate with emperor plan edit (L2) executes the edited plan', async () => {
  const mock = await startMockLlm();
  const rt = makeRuntime(mock.url);
  const ws = tmpDir('edict-ws-');
  rt.setWorkspace(ws);
  const r = (await submit(rt, { text: '写一个 greet 函数并测试', tier: 'full', multiAgent: true })) as { taskId: string };
  await waitFor(() => rt.tasks.get(r.taskId)!.gate?.kind === 'plan', 20000, 'plan gate');
  const t = rt.tasks.get(r.taskId)!;
  const edited = JSON.parse(JSON.stringify(t.plan));
  edited.subtasks = [edited.subtasks[0]]; // emperor strikes out the testing subtask
  edited.subtasks[0].title = '实现 greet.js（皇上钦定）';
  decideGate(rt, r.taskId, { approve: true, plan: edited, comment: '只做实现' });
  await waitFor(() => rt.tasks.get(r.taskId)!.gate?.kind === 'final' || stateOf(rt, r.taskId) === 'Blocked', 20000, 'final gate');
  assert.equal(t.planHistory.at(-1)!.author, 'emperor');
  assert.equal(t.nodes.filter((n) => n.kind === 'exec').length, 1, 'only the edited plan subtasks ran');
  assert.ok(t.nodes.some((n) => n.kind === 'dispatch' && n.status === 'done'), 'shangshu dispatched in full court');
  assert.ok(t.nodes.some((n) => n.kind === 'result_review' && n.status === 'done'), 'menxia reviewed results');
  assert.ok(!fs.existsSync(path.join(ws, 'greet.test.js')));
  const auditActions = rt.audit.list({ taskId: r.taskId }).map((e) => e.action);
  assert.ok(auditActions.includes('plan_edited'));
  // final 封驳 → rework → final gate again
  decideGate(rt, r.taskId, { approve: false, comment: '再加一行注释', reworkTargets: ['S1'] });
  await waitFor(() => rt.tasks.get(r.taskId)!.gate?.kind === 'final', 20000, 'final gate after rework');
  assert.equal(t.execRound, 2);
  assert.ok(t.nodes.some((n) => n.id === 'exec-S1-r2' && n.status === 'done'));
  rt.dispose();
  await mock.close();
});

test('failed node blocks the task and local retry resumes only that node', async () => {
  const mock = await startMockLlm({ failExecTimes: 3 }); // 3 × 500 = first node attempt fails after internal retries
  const rt = makeRuntime(mock.url);
  rt.updateSettings({ finalGate: false });
  const ws = tmpDir('edict-ws-');
  rt.setWorkspace(ws);
  const r = (await submit(rt, { text: '写一个 greet 函数并测试', tier: 'lite', multiAgent: true })) as { taskId: string };
  await waitFor(() => stateOf(rt, r.taskId) === 'Blocked', 40000, 'blocked');
  const t = rt.tasks.get(r.taskId)!;
  const failed = t.nodes.find((n) => n.status === 'failed')!;
  assert.equal(failed.kind, 'exec');
  const planNodesBefore = t.nodes.filter((n) => n.kind === 'plan').length;
  const callsBefore = mock.calls.filter((c) => c.system.includes('你是中书省')).length;
  retryNode(rt, r.taskId, failed.id);
  await waitFor(() => stateOf(rt, r.taskId) === 'Done', 20000, 'done after retry');
  assert.equal(t.nodes.filter((n) => n.kind === 'plan').length, planNodesBefore, 'plan not replayed');
  assert.equal(mock.calls.filter((c) => c.system.includes('你是中书省')).length, callsBefore, 'zhongshu not called again');
  assert.equal(failed.status, 'done');
  assert.equal(failed.attempts, 2);
  rt.dispose();
  await mock.close();
});

test('pause/resume, annotation must be answered, cancel requires emperor', async () => {
  const mock = await startMockLlm({ delayMs: 5 });
  const rt = makeRuntime(mock.url);
  const ws = tmpDir('edict-ws-');
  rt.setWorkspace(ws);
  const r = (await submit(rt, { text: '写一个 greet 函数并测试', tier: 'lite', multiAgent: true })) as { taskId: string };
  const ann = rt.annotate('bingbu', '请在文件头加版权注释', r.taskId);
  await waitFor(() => stateOf(rt, r.taskId) === 'Doing', 20000, 'doing');
  rt.pause(r.taskId);
  await new Promise((res) => setTimeout(res, 300));
  const usageAtPause = rt.tasks.get(r.taskId)!.usage.calls;
  await new Promise((res) => setTimeout(res, 400));
  assert.ok(rt.tasks.get(r.taskId)!.usage.calls <= usageAtPause + 1, 'no progress while paused');
  rt.resume(r.taskId);
  await waitFor(() => rt.tasks.get(r.taskId)!.gate?.kind === 'final', 20000, 'final');
  assert.ok(ann.consumedAt && ann.response, 'annotation consumed and responded');
  rt.cancel(r.taskId, '测试取消');
  assert.equal(stateOf(rt, r.taskId), 'Cancelled');
  rt.dispose();
  await mock.close();
});

test('path boundary: agent tool cannot escape workspace; high-risk command asks for approval', async () => {
  const { executeTool } = await import('../src/main/runtime/tools');
  const mock = await startMockLlm();
  const rt = makeRuntime(mock.url);
  const ws = tmpDir('edict-ws-');
  rt.setWorkspace(ws);
  fs.symlinkSync('/etc', path.join(ws, 'etc-link'));
  const a = await executeTool({ rt, agentId: 'bingbu' }, 'read_file', { path: '../../etc/passwd' });
  assert.equal(a.ok, false);
  assert.match(a.output, /越界/);
  const b = await executeTool({ rt, agentId: 'bingbu' }, 'read_file', { path: 'etc-link/passwd' });
  assert.equal(b.ok, false);
  assert.match(b.output, /越界/);
  const c = await executeTool({ rt, agentId: 'bingbu' }, 'write_file', { path: '.git/config', content: 'x' });
  assert.equal(c.ok, false);
  const pending = executeTool({ rt, agentId: 'bingbu' }, 'run_command', { command: 'rm -rf build' });
  const ap = await waitFor(() => [...rt.approvals.values()].find((x) => x.status === 'pending'), 2000, 'approval');
  assert.equal(ap.risk, 'high');
  rt.decideApproval(ap.id, false);
  const res = await pending;
  assert.equal(res.ok, false);
  rt.dispose();
  await mock.close();
});

test('朝堂议政: emperor interjection is answered by officials (L2)', async () => {
  const mock = await startMockLlm();
  const rt = makeRuntime(mock.url);
  const d = createDebate(rt, { topic: '是否先写测试', participants: ['zhongshu', 'menxia', 'bingbu'], maxRounds: 1 });
  await runDebate(rt, d.id);
  const em = interject(rt, d.id, '朕以为必须先写测试');
  await waitFor(() => d.pendingInterjections.length === 0 && d.status === 'idle', 10000, 'answered');
  const replies = d.messages.filter((m) => m.repliesTo === em.id);
  assert.ok(replies.length >= 2);
  assert.ok(replies[0].content.includes('回禀皇上'));
  const c = await concludeDebate(rt, d.id);
  assert.ok(c.includes('共识'));
  rt.dispose();
  await mock.close();
});

test('Solo tier: direct execution, no court nodes', async () => {
  const mock = await startMockLlm();
  const rt = makeRuntime(mock.url);
  const ws = tmpDir('edict-ws-');
  rt.setWorkspace(ws);
  const r = (await submit(rt, { text: '写个文件', tier: 'lite', multiAgent: false })) as { taskId: string };
  await waitFor(() => stateOf(rt, r.taskId) === 'Done', 10000, 'solo done');
  const t = rt.tasks.get(r.taskId)!;
  assert.equal(t.tier, 'solo');
  assert.deepEqual(t.nodes.map((n) => n.kind), ['solo']);
  assert.ok(fs.existsSync(path.join(ws, 'solo.txt')));
  rt.dispose();
  await mock.close();
});

test('restart recovery marks running nodes interrupted and blocks for local retry', async () => {
  const mock = await startMockLlm({ delayMs: 30 });
  const dataDir = tmpDir('edict-data-');
  const rt = makeRuntime(mock.url, 'openai-chat', dataDir);
  const ws = tmpDir('edict-ws-');
  rt.setWorkspace(ws);
  const r = (await submit(rt, { text: '写一个 greet 函数并测试', tier: 'lite', multiAgent: true })) as { taskId: string };
  await waitFor(() => rt.tasks.get(r.taskId)!.nodes.some((n) => n.kind === 'exec' && n.status === 'running'), 20000, 'exec running');
  rt.flushAll(); // simulate crash: state persisted mid-run
  for (const c of rt.controllers.values()) c.abort();
  const rt2 = makeRuntime(mock.url, 'openai-chat', dataDir);
  const t2 = rt2.tasks.get(r.taskId)!;
  assert.equal(t2.state, 'Blocked');
  const interrupted = t2.nodes.find((n) => n.exitStatus === 'interrupted')!;
  assert.ok(interrupted);
  rt2.setWorkspace(ws);
  retryNode(rt2, r.taskId, interrupted.id);
  await waitFor(() => rt2.tasks.get(r.taskId)!.gate?.kind === 'final', 20000, 'recovered');
  rt.dispose();
  rt2.dispose();
  await mock.close();
});

test('budget gate pauses the task until the emperor raises the budget', async () => {
  const mock = await startMockLlm();
  const rt = makeRuntime(mock.url);
  rt.updateSettings({ budgets: { solo: 300, lite: 600, full: 1000 } });
  const ws = tmpDir('edict-ws-');
  rt.setWorkspace(ws);
  const r = (await submit(rt, { text: '写一个 greet 函数并测试', tier: 'lite', multiAgent: true })) as { taskId: string };
  await waitFor(() => rt.tasks.get(r.taskId)!.gate?.kind === 'budget', 20000, 'budget gate');
  decideGate(rt, r.taskId, { approve: true });
  assert.ok(rt.tasks.get(r.taskId)!.budget.maxTokens > 600);
  rt.cancel(r.taskId);
  rt.dispose();
  await mock.close();
});
