// Edict 2.1 · 需求说明与对照检查: 中书 writes numbered acceptance criteria, 门下 checks each one against the
// record after the ministries finish, unmet ones go back as make-up subtasks (one round by default), and what
// is still unmet is 成果存疑 at the emperor's gate. Also as a 协同设计 step.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startMockLlm, defaultBrain, type MockCall } from './mockLlm';
import { makeRuntime, tmpDir, waitFor, stateOf } from './helpers';
import { decideGate, submit, validatePlan } from '../src/main/runtime/orchestrator';
import { parseCheckItems, requirementCheckOn, supplementPlan, withRequirements } from '../src/main/runtime/requirements';
import { BUILTIN_DESIGN_ID, validateDesign } from '../src/shared/design';
import { reqLabel } from '../src/shared/requirements';
import type { Plan, RequirementCheck, Task } from '../src/shared/types';

const sub = (id: string, dept: string, extra: Record<string, unknown> = {}) => ({ id, title: `做 ${id}`, dept, detail: '', acceptance: `${id} 的验收`, dependsOn: [], ...extra });

test('validatePlan reads the 需求说明: ids normalised to R1…, covers mapped, unknown ids dropped', () => {
  const v = validatePlan({
    summary: 's',
    requirements: { goal: ' 登录 ', outOfScope: '第三方登录', criteria: [{ id: 'A', text: '失败时提示' }, { id: '需2', text: '锁定 10 分钟' }, '记录日志', { id: 'R9', text: '' }], constraints: ['不改数据库'] },
    subtasks: [sub('S1', 'bingbu', { covers: ['A', 'R2'] }), sub('S2', 'xingbu', { covers: ['3', 'R7'] }), sub('S3', 'libu')],
    risks: [],
  });
  assert.ok(v.plan, v.error);
  const r = v.plan!.requirements!;
  assert.deepEqual(r.criteria, [{ id: 'R1', text: '失败时提示' }, { id: 'R2', text: '锁定 10 分钟' }, { id: 'R3', text: '记录日志' }]);
  assert.equal(r.goal, '登录');
  assert.deepEqual(r.outOfScope, ['第三方登录']);
  assert.deepEqual(r.constraints, ['不改数据库']);
  assert.deepEqual(v.plan!.subtasks.map((s) => s.covers), [['R1', 'R2'], ['R3'], undefined]);
  assert.equal(validatePlan({ summary: 's', subtasks: [sub('S1', 'bingbu')] }).plan!.requirements, undefined, 'older plans have none');
  assert.equal(reqLabel('R12'), '需12');
});

test('without a 需求说明 the criteria are taken from the acceptance lines', () => {
  const p = withRequirements({ summary: '做登录', subtasks: [sub('S1', 'bingbu'), { ...sub('S2', 'xingbu'), acceptance: '' }] as Plan['subtasks'], risks: [] });
  assert.equal(p.requirements!.derived, true);
  assert.deepEqual(p.requirements!.criteria, [{ id: 'R1', text: 'S1 的验收' }, { id: 'R2', text: '做 S2' }]);
  assert.deepEqual(p.subtasks.map((s) => s.covers), [['R1'], ['R2']]);
  assert.equal(withRequirements(p), p, 'a plan that has one keeps it');
});

test('check results: "done" is not evidence, missing items are unknown, verdict words are understood', () => {
  const criteria = [{ id: 'R1', text: 'a' }, { id: 'R2', text: 'b' }, { id: 'R3', text: 'c' }, { id: 'R4', text: 'd' }];
  const { items, parsed } = parseCheckItems('```json\n{"items":[{"id":"需1","verdict":"满足","evidence":"src/a.ts 第 3–9 行加了提示"},{"id":"R2","verdict":"met","evidence":"已完成。"},{"id":"R3","verdict":"fail","note":"没有锁定逻辑"}]}\n```', criteria);
  assert.equal(parsed, true);
  assert.deepEqual(items.map((i) => i.verdict), ['met', 'unknown', 'unmet', 'unknown']);
  assert.match(items[1].note!, /没有给出证据/);
  assert.equal(items[2].note, '没有锁定逻辑');
  assert.match(items[3].note!, /没有对这条作出判定/);
  const bad = parseCheckItems('都满足了', criteria);
  assert.equal(bad.parsed, false);
  assert.ok(bad.items.every((i) => i.verdict === 'unknown'));
});

test('make-up subtasks: one per ministry that owned the unmet criteria, with what is missing', () => {
  const plan: Plan = {
    summary: 's', risks: [],
    requirements: { goal: '', outOfScope: [], constraints: [], criteria: [{ id: 'R1', text: 'a' }, { id: 'R2', text: 'b' }, { id: 'R3', text: 'c' }] },
    subtasks: [{ ...sub('S1', 'bingbu', { covers: ['R1', 'R2'], effect: 'write' }) }, { ...sub('S2', 'xingbu', { covers: ['R3'], effect: 'verify' }) }, { ...sub('B1', 'bingbu', { supplement: true }) }] as Plan['subtasks'],
  };
  const chk: RequirementCheck = { round: 1, at: 0, nodeId: 'check-r1', supplements: [], items: [
    { id: 'R1', text: 'a', verdict: 'unmet', evidence: '', note: '缺提示' }, { id: 'R2', text: 'b', verdict: 'met', evidence: 'x' }, { id: 'R3', text: 'c', verdict: 'unmet', evidence: '只看到一半', note: '没跑测试' },
  ] };
  const r = supplementPlan(plan, chk);
  assert.deepEqual(r.ids, ['B2', 'B3'], 'ids never collide');
  const [b2, b3] = r.plan.subtasks.slice(-2);
  assert.deepEqual([b2.dept, b2.effect, b2.covers, b2.supplement], ['bingbu', 'write', ['R1'], true]);
  assert.deepEqual([b3.dept, b3.effect, b3.covers], ['xingbu', 'verify', ['R3']]);
  assert.match(b2.detail, /R1 a\n {2}还缺：缺提示/);
  assert.match(b3.detail, /检查所见：只看到一半/);
  assert.match(r.feedback, /2 条需求未满足/);
  assert.equal(plan.subtasks.length, 3, 'the old plan object is untouched');
});

async function liteRun(o: { unmetCheckTimes?: number; writeRequirements?: boolean; settings?: Record<string, unknown>; tier?: 'lite' | 'full' } = {}) {
  const seen: MockCall[] = [];
  const base = defaultBrain({ unmetCheckTimes: o.unmetCheckTimes, writeRequirements: o.writeRequirements });
  const mock = await startMockLlm({ brain: (c) => (seen.push(c), base(c)) });
  const rt = makeRuntime(mock.url);
  rt.updateSettings({ planGate: { lite: false, full: false }, ...(o.settings ?? {}) });
  rt.setWorkspace(tmpDir('edict-ws-'));
  const r = (await submit(rt, { text: '写一个 greet 函数并测试', tier: o.tier ?? 'lite', multiAgent: true })) as { taskId: string };
  const t = rt.tasks.get(r.taskId)!;
  return { rt, mock, seen, t, id: r.taskId };
}

test('Court Lite: 中书 writes the 需求说明, 门下 checks it with evidence, the memorial carries the checklist', async () => {
  const { rt, mock, seen, t, id } = await liteRun();
  await waitFor(() => t.gate?.kind === 'final' || t.state === 'Blocked', 25000, 'final gate');
  assert.equal(t.state, 'PendingConfirm', t.blockedReason);
  assert.equal(requirementCheckOn(rt, 'lite'), true, 'on by default in Lite too');
  assert.ok(seen.some((c) => c.system.includes('你是中书省') && c.lastUser.includes('《需求说明》')), 'the planner is asked for it');
  assert.ok(seen.some((c) => c.system.includes('你是门下省') && c.lastUser.includes('【需求说明】') && c.lastUser.includes('由 S1 负责')), '门下 sees it with coverage when reviewing the plan');
  assert.deepEqual(t.plan!.requirements!.criteria.map((c) => c.id), ['R1', 'R2']);
  assert.equal(t.plan!.requirements!.derived, undefined);
  const check = t.nodes.find((n) => n.kind === 'check')!;
  assert.equal(check.status, 'done');
  assert.equal(check.model, 'mock-economy', 'the economy model does the checklist');
  const ci = t.nodes.indexOf(check);
  assert.ok(ci > t.nodes.findIndex((n) => n.kind === 'exec') && ci < t.nodes.findIndex((n) => n.kind === 'summary'), 'after the ministries, before the summary');
  assert.equal(t.requirementChecks!.length, 1);
  assert.ok(t.requirementChecks![0].items.every((i) => i.verdict === 'met' && i.evidence));
  assert.ok(seen.some((c) => c.lastUser.includes('【你负责满足的需求】\nR1')), 'each ministry is told which criteria it owns');
  assert.ok(seen.some((c) => c.system.includes('你是尚书省') && c.lastUser.includes('【对照检查（第 1 轮）】')), 'the summary sees the check');
  assert.equal(t.gate!.message.includes('成果存疑'), false);
  decideGate(rt, id, { approve: true });
  const m = rt.memorials.get(id)!;
  const st = m.stages.find((s) => s.key === 'requirements')!;
  assert.equal(st.label, '需求对照');
  assert.ok(st.items.some((i) => i.startsWith('对照检查第 1 轮：满足 2 / 2')));
  assert.ok(st.items.some((i) => /^✅ 需2 .*证据：/.test(i)));
  assert.ok(rt.audit.list({ taskId: id }).some((e) => e.action === 'requirement_check'));
  rt.dispose();
  await mock.close();
});

test('an unmet requirement goes back to its ministry as a make-up subtask; a second check closes it', async () => {
  const { rt, mock, t } = await liteRun({ unmetCheckTimes: 1 });
  await waitFor(() => t.gate?.kind === 'final' || t.state === 'Blocked', 30000, 'final gate');
  assert.equal(t.state, 'PendingConfirm', t.blockedReason);
  assert.equal(t.requirementChecks!.length, 2);
  assert.deepEqual(t.requirementChecks![0].items.map((i) => i.verdict), ['met', 'unmet']);
  assert.deepEqual(t.requirementChecks![0].supplements, ['B1']);
  const b1 = t.plan!.subtasks.find((s) => s.id === 'B1')!;
  assert.deepEqual([b1.dept, b1.supplement, b1.covers], ['xingbu', true, ['R2']], 'R2 belonged to 刑部 (S2)');
  assert.match(b1.detail, /没有空字符串的用例/);
  const ex = t.nodes.find((n) => n.id === 'exec-B1-r2')!;
  assert.equal(ex.status, 'done');
  assert.ok(!ex.label.includes('返工'), 'a make-up subtask is not a rework');
  assert.ok(!t.nodes.some((n) => n.id === 'exec-S1-r2' || n.id === 'exec-S2-r2'), 'only the make-up ran');
  assert.ok(!t.nodes.some((n) => n.id === 'summary-r1'), 'no summary before the make-up');
  assert.ok(t.nodes.some((n) => n.id === 'check-r2' && n.status === 'done'));
  assert.ok(t.flow.some((f) => /需2 未满足，追加补办 B1/.test(f.remark)));
  assert.equal(t.rework!.by, 'menxia');
  assert.ok(t.requirementChecks![1].items.every((i) => i.verdict === 'met'));
  assert.equal(t.gate!.message.includes('成果存疑'), false);
  rt.dispose();
  await mock.close();
});

test('still unmet after the make-up round: 成果存疑 at the gate; with auto-close on it still waits for the emperor', async () => {
  let a = await liteRun({ unmetCheckTimes: 9 });
  await waitFor(() => a.t.gate?.kind === 'final' || a.t.state === 'Blocked', 30000, 'final gate');
  assert.equal(a.t.requirementChecks!.length, 2, 'one make-up round by default');
  assert.match(a.t.gate!.message, /成果存疑：需求未满足：需2/);
  a.rt.dispose();
  await a.mock.close();

  a = await liteRun({ unmetCheckTimes: 9, settings: { finalGate: false, requirementCheck: { lite: true, full: true, maxSupplement: 0 } } });
  await waitFor(() => a.t.gate?.kind === 'reject_limit' || ['Blocked', 'Done'].includes(a.t.state), 30000, 'doubt gate');
  assert.equal(a.t.state, 'Review');
  assert.equal(a.t.requirementChecks!.length, 1, 'no make-up rounds when set to 0');
  assert.match(a.t.gate!.message, /需求未满足：需2/);
  decideGate(a.rt, a.id, { approve: true, comment: '先这样' });
  await waitFor(() => a.t.state === 'Done', 10000, 'done');
  a.rt.dispose();
  await a.mock.close();
});

test('switched off: no 需求说明, no check (the 2.0 flow)', async () => {
  const { rt, mock, seen, t } = await liteRun({ settings: { requirementCheck: { lite: false, full: true, maxSupplement: 1 } } });
  await waitFor(() => t.gate?.kind === 'final' || t.state === 'Blocked', 25000, 'final gate');
  assert.equal(t.plan!.requirements, undefined);
  assert.ok(!t.nodes.some((n) => n.kind === 'check'));
  assert.ok(!seen.some((c) => c.lastUser.includes('《需求说明》')));
  assert.equal(requirementCheckOn(rt, 'full'), true);
  assert.equal(requirementCheckOn(rt, 'solo'), false);
  rt.dispose();
  await mock.close();
});

test('a planner that writes no 需求说明 gets one from the acceptance lines; the emperor’s plan edit keeps it in step', async () => {
  const { rt, mock, t, id } = await liteRun({ writeRequirements: false, tier: 'full', settings: { planGate: { lite: false, full: true } } });
  await waitFor(() => t.gate?.kind === 'plan' || t.state === 'Blocked', 25000, 'plan gate');
  assert.equal(t.plan!.requirements!.derived, true);
  assert.deepEqual(t.plan!.requirements!.criteria.map((c) => c.text), ['greet("A") 返回 "Hello, A"', '测试可运行']);
  // the emperor rewrites S2's acceptance line and drops the 需求说明 from what the editor sends
  const edited = JSON.parse(JSON.stringify(t.plan)) as Plan;
  edited.subtasks[1].acceptance = 'greet("") 返回 "Hello, "';
  delete edited.requirements;
  decideGate(rt, id, { approve: true, plan: edited });
  assert.equal(t.plan!.requirements!.criteria[1].text, 'greet("") 返回 "Hello, "');
  await waitFor(() => t.gate?.kind === 'final' || t.state === 'Blocked', 30000, 'final gate');
  assert.ok(t.nodes.some((n) => n.kind === 'check' && n.status === 'done'));
  // the check is the one review of the result: Full Court no longer adds 门下审议成果 on top of it
  assert.ok(!t.nodes.some((n) => n.kind === 'result_review'));
  rt.dispose();
  await mock.close();
});

test('协同设计: the copied 三省六部 has a 对照检查 step; a design can use it and it sends make-ups to its fan-out', async () => {
  const mock = await startMockLlm({ unmetCheckTimes: 1 });
  const rt = makeRuntime(mock.url);
  rt.setWorkspace(tmpDir('edict-ws-'));
  const d = rt.designs.copy(BUILTIN_DESIGN_ID, { tier: 'lite' });
  const spec = rt.designs.get(d.id)!;
  const chk = spec.steps.find((s) => s.type === 'check')!;
  assert.deepEqual([chk.role, chk.planStep, chk.onReject], ['menxia', 'plan', { goto: 'execute', max: 1 }]);
  assert.deepEqual(spec.steps.map((s) => s.id), ['plan', 'review', 'execute', 'check', 'summary']);
  // validation of the step
  const bad = JSON.parse(JSON.stringify(spec));
  bad.steps.find((s: { id: string }) => s.id === 'check').onReject = { goto: 'review', max: 1 };
  assert.ok(validateDesign(bad).errors.some((e) => e.includes('补办只能交回')));
  bad.steps.find((s: { id: string }) => s.id === 'check').planStep = 'execute';
  assert.ok(validateDesign(bad).errors.some((e) => e.includes('必须引用它之前的一个规划步骤')));

  const r = (await submit(rt, { text: '写一个 greet 函数并测试', tier: 'lite', multiAgent: true, designId: d.id })) as { taskId: string };
  const t = rt.tasks.get(r.taskId)! as Task;
  await waitFor(() => t.gate?.kind === 'final' || t.state === 'Blocked', 30000, 'final gate');
  assert.equal(t.state, 'PendingConfirm', t.blockedReason);
  assert.equal(t.design?.native, false);
  assert.ok(t.plan!.requirements && !t.plan!.requirements.derived, 'the plan step was asked for the 需求说明');
  assert.ok(t.nodes.some((n) => n.id === 's-execute-2-B1' && n.status === 'done'), 'make-up ran on the fan-out');
  assert.ok(t.nodes.some((n) => n.id === 's-check-2' && n.status === 'done'));
  assert.equal(t.requirementChecks!.length, 2);
  assert.ok(t.requirementChecks!.at(-1)!.items.every((i) => i.verdict === 'met'));
  decideGate(rt, r.taskId, { approve: true });
  assert.equal(stateOf(rt, r.taskId), 'Done');
  rt.dispose();
  await mock.close();
});
