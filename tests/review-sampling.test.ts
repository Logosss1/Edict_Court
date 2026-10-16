// 审查减负 (必改 / 建议, round 2 checks only the last 必改, 与旨意的出入 in the 回奏, one review of the result)
// and 回答参数 (Temperature / Top P / penalties per model and per official). Unit + mock/integration.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseVerdict, reReviewText, submit } from '../src/main/runtime/orchestrator';
import { builtinDeclarative } from '../src/main/runtime/designs';
import { BUILTIN_DESIGN_ID } from '../src/shared/design';
import { cleanSampling, resolveSampling, samplingSummary, samplingUnsupported } from '../src/shared/sampling';
import { classifyLlmError, LlmHttpError } from '../src/main/llm/types';
import { defaultBrain, startMockLlm, type Brain } from './mockLlm';
import { makeRuntime, stateOf, tmpDir, waitFor } from './helpers';
import type { Protocol } from '../src/shared/types';

test('verdict: only 必改 rejects; 建议 never does', () => {
  // a reject that only carries suggestions is an approval
  const a = parseVerdict('{"verdict":"reject","must":[],"suggest":["变量名可以更清楚"],"comment":"小问题"}')!;
  assert.equal(a.verdict, 'approve');
  assert.deepEqual(a.suggestions, ['变量名可以更清楚']);
  assert.deepEqual(a.issues, []);
  // an approve that still lists a 必改 is a rejection
  const b = parseVerdict('{"verdict":"approve","must":["漏了旨意要的导出功能"],"suggest":[],"comment":"基本可行"}')!;
  assert.equal(b.verdict, 'reject');
  assert.deepEqual(b.issues, ['漏了旨意要的导出功能']);
  // older `issues`: 必改 when rejecting, 建议 when approving; 「建议：」 items are always suggestions
  const c = parseVerdict('{"verdict":"reject","issues":["S2 验收标准不可验证","建议：补一条空字符串用例"],"comment":"需补充"}')!;
  assert.equal(c.verdict, 'reject');
  assert.deepEqual(c.issues, ['S2 验收标准不可验证']);
  assert.deepEqual(c.suggestions, ['补一条空字符串用例']);
  const d = parseVerdict('{"verdict":"approve","issues":["可以加注释"],"comment":"可行"}')!;
  assert.equal(d.verdict, 'approve');
  assert.deepEqual(d.suggestions, ['可以加注释']);
  // a bare reject with no opinion: its comment is the 必改
  const e = parseVerdict('{"verdict":"reject","comment":"方案没有覆盖旨意的核心"}')!;
  assert.equal(e.verdict, 'reject');
  assert.deepEqual(e.issues, ['方案没有覆盖旨意的核心']);
  // marks inside must are stripped; object items keep their text
  const f = parseVerdict('{"verdict":"reject","must":["必改：缺测试"],"suggest":[{"text":"拆小一点"}],"comment":""}')!;
  assert.deepEqual(f.issues, ['缺测试']);
  assert.deepEqual(f.suggestions, ['拆小一点']);
  assert.equal(parseVerdict('{"verdict":"maybe"}'), null);
});

test('round 2 checks only the last round’s 必改', () => {
  assert.equal(reReviewText(undefined), '');
  assert.equal(reReviewText({ round: 1, issues: [] }), '');
  const s = reReviewText({ round: 1, issues: ['S2 验收标准不可验证', '缺少回滚说明'] });
  assert.match(s, /【上一轮（第 1 轮）的必改】/);
  assert.match(s, /1\. S2 验收标准不可验证\n2\. 缺少回滚说明/);
  assert.match(s, /只核对这几条改好了没有/);
  assert.match(s, /不要另提新的必改/);
});

test('one review of the result: Full Court drops 门下审议成果 while 对照检查 is on', () => {
  const base = { planGate: { lite: false, full: false }, maxRejections: { lite: 2, full: 3 }, finalGate: true } as never;
  const on = builtinDeclarative('full', { ...(base as object), requirementCheck: { lite: true, full: true, maxSupplement: 1 } } as never);
  assert.ok(on.steps.some((s) => s.id === 'check'));
  assert.ok(!on.steps.some((s) => s.id === 'result-review'));
  assert.ok(!on.steps.find((s) => s.id === 'review')!.gate, 'Full plan gate off by default');
  const off = builtinDeclarative('full', { ...(base as object), requirementCheck: { lite: true, full: false, maxSupplement: 1 } } as never);
  assert.ok(!off.steps.some((s) => s.id === 'check'));
  assert.ok(off.steps.some((s) => s.id === 'result-review'), 'without 对照检查 门下审议成果 stays');
});

test('migration: the Full Court plan gate is switched off once, later choices stick', async () => {
  const mock = await startMockLlm();
  const dataDir = tmpDir('edict-data-');
  const rt1 = makeRuntime(mock.url, 'openai-chat', dataDir);
  assert.equal(rt1.settings.planGate.full, false, 'fresh install: off');
  // an older install: gate on, migration not yet run
  rt1.settings.planGate = { lite: false, full: true };
  rt1.settings.migrations = [];
  rt1.saveSettings();
  rt1.dispose();
  const rt2 = makeRuntime(mock.url, 'openai-chat', dataDir);
  assert.equal(rt2.settings.planGate.full, false, 'migrated off');
  assert.ok(rt2.settings.migrations?.includes('plan-gate-full-off'));
  rt2.updateSettings({ planGate: { lite: false, full: true } });
  rt2.dispose();
  const rt3 = makeRuntime(mock.url, 'openai-chat', dataDir);
  assert.equal(rt3.settings.planGate.full, true, 'the emperor turned it back on: not migrated again');
  rt3.dispose();
  await mock.close();
});

/** 门下 rejects round 1 with one 必改 + one 建议, then "rejects" round 2 with only a 建议 (= approval); 兵部 reports a 出入. */
function reviewBrain(): Brain {
  const base = defaultBrain({});
  let planReviews = 0;
  return (c) => {
    const u = c.lastUser;
    const planReview = c.system.includes('你是门下省') && !/【对照检查】|【比试】|审议成果|核对实际改动|【系统核验的文件改动】/.test(u);
    if (planReview) {
      planReviews++;
      if (planReviews === 1) return { text: JSON.stringify({ verdict: 'reject', must: ['S2 验收标准不可验证'], suggest: ['可以加一条边界用例'], comment: '验收不清' }) };
      return { text: JSON.stringify({ verdict: 'reject', must: [], suggest: ['给 greet 加一行注释'], comment: '可行，小建议' }) };
    }
    if (c.system.includes('兵部尚书') && !(c.tools.length && c.toolResults === 0)) {
      return { text: '已完成。\n```json\n' + JSON.stringify({ status: 'done', summary: '完成 greet.js', artifacts: ['greet.js'], verification: '未验证', issues: [], deviations: ['用模板字符串代替字符串拼接，结果相同'] }) + '\n```' };
    }
    return base(c);
  };
}

for (const engine of ['native', 'design'] as const) {
  test(`review: 必改 / 建议 reach the right prompts, 出入 reaches the 回奏 (${engine}, mock)`, async () => {
    const mock = await startMockLlm({ brain: reviewBrain() });
    const rt = makeRuntime(mock.url);
    rt.setWorkspace(tmpDir('edict-ws-'));
    rt.updateSettings({ finalGate: false });
    const designId = engine === 'design' ? rt.designs.copy(BUILTIN_DESIGN_ID, { tier: 'lite' }).id : undefined;
    const r = (await submit(rt, { text: '写一个 greet 函数并测试', tier: 'lite', multiAgent: true, ...(designId ? { designId } : {}) })) as { taskId: string };
    await waitFor(() => ['Done', 'Blocked'].includes(stateOf(rt, r.taskId)), 30000, 'done');
    const t = rt.tasks.get(r.taskId)!;
    assert.equal(t.state, 'Done', t.blockedReason);
    const plan = t.reviews.filter((x) => x.stage === 'plan');
    assert.deepEqual(plan.map((x) => x.verdict), ['reject', 'approve'], 'a reject with only 建议 counts as approval');
    assert.deepEqual(plan[0].issues, ['S2 验收标准不可验证']);
    assert.deepEqual(plan[1].suggestions, ['给 greet 加一行注释']);
    const users = mock.calls.map((c) => ({ s: c.system, u: c.lastUser }));
    // re-plan: 必改 must be fixed, 建议 only for reference
    const replan = users.find((c) => c.s.includes('你是中书省') && c.u.includes('封驳意见'))!;
    assert.ok(replan, 'a re-plan prompt');
    assert.match(replan.u, /以上必改须逐条修正/);
    assert.match(replan.u, /建议（可参考，不强求）：\n- 可以加一条边界用例/);
    // round 2 only checks round 1's 必改
    const round2 = users.filter((c) => c.s.includes('你是门下省') && c.u.includes('【上一轮（第 1 轮）的必改】'));
    assert.equal(round2.length, 1, 'round 2 prompt carries the last 必改');
    assert.match(round2[0].u, /1\. S2 验收标准不可验证/);
    assert.match(round2[0].u, /"must":\["必改"\],"suggest":\["建议"\]/);
    // the approved plan's 建议 reach the ministries as reference
    const exec = users.find((c) => c.s.includes('兵部尚书'))!;
    assert.match(exec.u, /【门下省建议（参考，可不采纳）】\n- 给 greet 加一行注释/);
    // the ministry's 与旨意的出入 reaches 尚书汇总, which writes it into the 回奏 instead of reworking
    const summary = users.find((c) => c.s.includes('你是尚书省') && c.u.includes('【各部报告的与旨意的出入】'));
    assert.ok(summary, 'summary prompt lists the deviations');
    assert.match(summary!.u, /用模板字符串代替字符串拼接/);
    assert.match(summary!.u, /与旨意的出入/);
    assert.equal(t.nodes.filter((n) => n.kind === 'exec' && n.subtaskId === 'S1').length, 1, 'a 出入 is no reason to rework');
    rt.dispose();
    await mock.close();
  });
}

test('回答参数: official > model > step temperature; protocols without a field drop it', () => {
  const all = { temperature: 0.4, topP: 0.9, frequencyPenalty: 0.5, presencePenalty: 0.3 };
  const r = resolveSampling({ agent: { temperature: 0.9 }, model: all, stepTemperature: 0.2, protocol: 'openai-chat' });
  assert.equal(r.temperature, 0.9);
  assert.equal(r.from.temperature, 'agent');
  assert.equal(r.topP, 0.9);
  assert.equal(r.from.topP, 'model');
  assert.equal(r.frequencyPenalty, 0.5);
  assert.equal(r.presencePenalty, 0.3);
  const step = resolveSampling({ stepTemperature: 0.2, protocol: 'openai-chat' });
  assert.deepEqual({ ...step, from: undefined }, { temperature: 0.2, from: undefined });
  assert.equal(step.from.temperature, 'step');
  assert.equal(resolveSampling({ protocol: 'openai-chat' }).temperature, undefined, 'nothing set, no step default: nothing sent');
  for (const p of ['anthropic-messages', 'openai-responses'] as Protocol[]) {
    const x = resolveSampling({ model: all, protocol: p });
    assert.equal(x.temperature, 0.4);
    assert.equal(x.topP, 0.9);
    assert.equal(x.frequencyPenalty, undefined, `${p} has no frequency penalty`);
    assert.equal(x.presencePenalty, undefined);
    assert.ok(samplingUnsupported('presencePenalty', p));
    assert.equal(samplingUnsupported('topP', p), '');
  }
  assert.equal(samplingUnsupported('frequencyPenalty', 'openai-chat'), '');
  // cleaning: known fields only, finite, clamped, rounded to the slider step
  assert.deepEqual(cleanSampling({ temperature: 3, topP: 0.123, frequencyPenalty: -5, presencePenalty: Number.NaN, foo: 1 }), { temperature: 2, topP: 0.12, frequencyPenalty: -2 });
  assert.equal(cleanSampling({}), undefined);
  assert.equal(cleanSampling('x'), undefined);
  assert.equal(samplingSummary({ temperature: 0.7, topP: 0.9 }), '温度 0.7 · Top P 0.9');
  // a service that refuses them is told apart from other parameter errors
  const unsupported = classifyLlmError(new LlmHttpError(400, '{"error":{"message":"Unsupported parameter: \'top_p\' is not supported with this model."}}', 'u'));
  assert.equal(unsupported.kind, 'param');
  assert.match(unsupported.hint, /回答参数/);
  assert.equal(classifyLlmError(new LlmHttpError(400, '{"error":{"message":"`temperature` and `top_p` cannot both be specified for this model. Please use only one."}}', 'u')).kind, 'param');
  assert.match(classifyLlmError(new LlmHttpError(400, '{"error":{"message":"Unrecognized request argument supplied: reasoning_effort"}}', 'u')).hint, /思考程度/);
});

const SAMPLING = { temperature: 0.4, topP: 0.9, frequencyPenalty: 0.5, presencePenalty: 0.3 };

function withModelSampling(rt: ReturnType<typeof makeRuntime>, sampling: object | undefined) {
  const p = rt.providers[0];
  rt.upsertProvider({ ...p, models: p.models.map((m) => ({ ...m, sampling: sampling as never })) });
  rt.updateSettings({ routing: { strong: { providerId: 'mock', model: 'mock-strong' }, economy: { providerId: 'mock', model: 'mock-strong' } } });
}

for (const protocol of ['openai-chat', 'anthropic-messages', 'openai-responses'] as Protocol[]) {
  test(`回答参数 reach the request body over ${protocol} (mock)`, async () => {
    const mock = await startMockLlm();
    const rt = makeRuntime(mock.url, protocol);
    withModelSampling(rt, SAMPLING);
    assert.deepEqual(rt.providers[0].models[0].sampling, SAMPLING, 'saved with the model');
    rt.setWorkspace(tmpDir('edict-ws-'));
    const r = (await submit(rt, { text: '写 solo.txt', tier: 'solo', multiAgent: false })) as { taskId: string };
    await waitFor(() => ['Done', 'Blocked'].includes(stateOf(rt, r.taskId)), 20000, 'solo done');
    assert.equal(stateOf(rt, r.taskId), 'Done', rt.tasks.get(r.taskId)!.blockedReason);
    const b = mock.bodies.find((x) => x.temperature !== undefined)!;
    assert.ok(b, 'a request with the parameters');
    assert.equal(b.temperature, 0.4);
    assert.equal(b.top_p, 0.9);
    if (protocol === 'openai-chat') {
      assert.equal(b.frequency_penalty, 0.5);
      assert.equal(b.presence_penalty, 0.3);
    } else {
      assert.ok(!('frequency_penalty' in b) && !('presence_penalty' in b), 'no penalty fields on this protocol');
    }
    rt.dispose();
    await mock.close();
  });
}

test('回答参数: an official’s own values win over the model’s; unset officials follow the model (mock)', async () => {
  const mock = await startMockLlm();
  const rt = makeRuntime(mock.url);
  withModelSampling(rt, { temperature: 0.4 });
  rt.updateSettings({ agentSampling: { bingbu: { temperature: 0.95, topP: 0.8 } } });
  assert.deepEqual(rt.settings.agentSampling?.bingbu, { temperature: 0.95, topP: 0.8 });
  rt.setWorkspace(tmpDir('edict-ws-'));
  rt.updateSettings({ finalGate: false });
  const r = (await submit(rt, { text: '写一个 greet 函数并测试', tier: 'lite', multiAgent: true })) as { taskId: string };
  await waitFor(() => ['Done', 'Blocked'].includes(stateOf(rt, r.taskId)), 30000, 'done');
  assert.equal(stateOf(rt, r.taskId), 'Done', rt.tasks.get(r.taskId)!.blockedReason);
  const sent = mock.calls.map((c, i) => ({ s: c.system, b: mock.bodies[i] }));
  const bing = sent.filter((x) => x.s.includes('兵部尚书'));
  assert.ok(bing.length && bing.every((x) => x.b.temperature === 0.95 && x.b.top_p === 0.8), '兵部 uses its own');
  const others = sent.filter((x) => x.s.includes('你是中书省') || x.s.includes('刑部尚书'));
  assert.ok(others.length && others.every((x) => x.b.temperature === 0.4 && !('top_p' in x.b)), 'the others follow the model');
  rt.dispose();
  await mock.close();
});

test('回答参数 the service refuses are dropped once for that model, and the edict carries on (mock)', async () => {
  const mock = await startMockLlm({
    reject: (_c, body) => ('top_p' in body ? { status: 400, body: '{"error":{"message":"Unsupported parameter: \'top_p\' is not supported with this model."}}' } : undefined),
  });
  const rt = makeRuntime(mock.url);
  withModelSampling(rt, { temperature: 0.4, topP: 0.9 });
  rt.setWorkspace(tmpDir('edict-ws-'));
  const r = (await submit(rt, { text: '写 solo.txt', tier: 'solo', multiAgent: false })) as { taskId: string };
  await waitFor(() => ['Done', 'Blocked'].includes(stateOf(rt, r.taskId)), 20000, 'solo done');
  assert.equal(stateOf(rt, r.taskId), 'Done', rt.tasks.get(r.taskId)!.blockedReason);
  assert.equal(mock.bodies.filter((b) => 'top_p' in b).length, 1, 'tried once with the parameters, then without');
  assert.ok(rt.noSampling.has('mock/mock-strong'));
  assert.ok(rt.activities(r.taskId).some((a) => a.content.includes('不接受所设的回答参数')), 'the log says what happened');
  // changing the model's parameters gives them another try
  withModelSampling(rt, { temperature: 0.5 });
  assert.ok(!rt.noSampling.has('mock/mock-strong'));
  rt.dispose();
  await mock.close();
});
