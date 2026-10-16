// 预算不限: 0 = 不限, 「不限预算，跑完为止」 on the budget gate, and approving a budget gate after a restart. Mock LLM.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startMockLlm } from './mockLlm';
import { makeRuntime, tmpDir, waitFor, stateOf } from './helpers';
import { submit, decideGate, resumeAll } from '../src/main/runtime/orchestrator';

const EDICT = '写一个 greet 函数并测试';

const tick = (ms = 50) => new Promise((r) => setTimeout(r, ms));

test('budget 0 = 不限: the edict gets no token cap and runs to the end without a budget gate', async () => {
  const mock = await startMockLlm();
  const rt = makeRuntime(mock.url);
  rt.updateSettings({ budgets: { solo: 0, lite: 0, full: 0 }, finalGate: true });
  rt.setWorkspace(tmpDir('edict-ws-'));
  const r = (await submit(rt, { text: EDICT, tier: 'lite', multiAgent: true })) as { taskId: string };
  await waitFor(() => rt.tasks.get(r.taskId)!.gate?.kind === 'final' || stateOf(rt, r.taskId) === 'Blocked', 20000, 'final gate');
  const t = rt.tasks.get(r.taskId)!;
  assert.equal(t.budget.maxTokens, 0);
  assert.ok(t.usage.inputTokens + t.usage.outputTokens > 600, 'used more than the small budget the other test trips on');
  const audit = fs.readFileSync(path.join(rt.opts.dataDir, 'audit.jsonl'), 'utf8');
  assert.ok(!audit.includes('"kind":"budget"'), 'no budget gate was opened');
  rt.dispose();
  await mock.close();
});

test('「不限预算，跑完为止」 lifts the token and cost caps of that edict and it runs on to the end', async () => {
  const mock = await startMockLlm();
  const rt = makeRuntime(mock.url);
  rt.updateSettings({ budgets: { solo: 300, lite: 600, full: 1000 }, maxCostUsd: 0.5, finalGate: true });
  rt.setWorkspace(tmpDir('edict-ws-'));
  const r = (await submit(rt, { text: EDICT, tier: 'lite', multiAgent: true })) as { taskId: string };
  await waitFor(() => rt.tasks.get(r.taskId)!.gate?.kind === 'budget', 20000, 'budget gate');
  decideGate(rt, r.taskId, { approve: true, unlimited: true });
  const t = rt.tasks.get(r.taskId)!;
  assert.deepEqual([t.budget.maxTokens, t.budget.maxCostUsd], [0, 0]);
  assert.equal(t.gate, undefined);
  await waitFor(() => t.gate?.kind === 'final' || t.state === 'Blocked', 20000, 'final gate');
  assert.equal(t.gate?.kind, 'final', t.blockedReason);
  assert.ok(rt.activities(r.taskId).some((a) => a.content.includes('跑完为止')));
  // the setting is untouched: the next edict gets the tier budget again
  assert.equal(rt.settings.budgets.lite, 600);
  // plain 「追加预算，继续」 still raises by half
  const r2 = (await submit(rt, { text: EDICT, tier: 'lite', multiAgent: true })) as { taskId: string };
  await waitFor(() => rt.tasks.get(r2.taskId)!.gate?.kind === 'budget', 20000, 'budget gate 2');
  decideGate(rt, r2.taskId, { approve: true });
  assert.ok(rt.tasks.get(r2.taskId)!.budget.maxTokens >= 900);
  rt.cancel(r2.taskId);
  rt.dispose();
  await mock.close();
});

test('a budget gate approved after Edict restarted starts the edict again (nothing was waiting at it)', async () => {
  const mock = await startMockLlm();
  const dataDir = tmpDir('edict-data-');
  const rt = makeRuntime(mock.url, 'openai-chat', dataDir);
  rt.updateSettings({ budgets: { solo: 300, lite: 600, full: 1000 }, finalGate: true });
  rt.setWorkspace(tmpDir('edict-ws-'));
  const r = (await submit(rt, { text: EDICT, tier: 'lite', multiAgent: true })) as { taskId: string };
  await waitFor(() => rt.tasks.get(r.taskId)!.gate?.kind === 'budget', 20000, 'budget gate');
  rt.flushAll();
  for (const c of rt.controllers.values()) c.abort();
  const rt2 = makeRuntime(mock.url, 'openai-chat', dataDir);
  rt.dispose();
  resumeAll(rt2);
  const t = rt2.tasks.get(r.taskId)!;
  assert.equal(t.gate?.kind, 'budget', `still at the gate after the restart (${t.state} ${t.blockedReason ?? ''})`);
  assert.notEqual(t.state, 'Blocked');
  const callsBefore = mock.calls.length;
  await tick(200);
  assert.equal(mock.calls.length, callsBefore, 'nothing runs while the gate is open');
  decideGate(rt2, r.taskId, { approve: true, unlimited: true });
  await waitFor(() => t.gate?.kind === 'final' || t.state === 'Blocked', 20000, 'final gate after the restart');
  assert.equal(t.gate?.kind, 'final', t.blockedReason);
  rt2.dispose();
  await mock.close();
});
