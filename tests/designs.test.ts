// 协同设计 (Phase 1): design library, pinning, rollback, compatibility, and the interpreter
// running declarative designs (label: mock/integration — LLM replies come from tests/mockLlm.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startMockLlm, defaultBrain } from './mockLlm';
import { makeRuntime, tmpDir, waitFor, stateOf } from './helpers';
import { submit, decideGate, retryNode } from '../src/main/runtime/orchestrator';
import { BUILTIN_DESIGN_ID, DESIGN_SCHEMA, DEFAULT_RESILIENCE, validateDesign, statePath, type CollabDesign } from '../src/shared/design';
import { builtinDeclarative, designHash } from '../src/main/runtime/designs';

const customDesign = (): Omit<CollabDesign, 'version' | 'createdAt' | 'id'> => ({
  schema: DESIGN_SCHEMA, name: '架构师-工匠-批评家', description: 'critic-reviewer loop', origin: { kind: 'user' },
  roles: [
    { id: 'architect', name: '架构师', duty: '拆解', prompt: '【角色:ARCHITECT】你是架构师，负责把需求拆成子任务。', modelClass: 'strong', toolAccess: 'read', avatar: 'zhongshu' },
    { id: 'coder', name: '工匠', duty: '实现', prompt: '【角色:CODER】你是工匠，负责写代码。', modelClass: 'economy', toolAccess: 'write', avatar: 'bingbu' },
    { id: 'critic', name: '批评家', duty: '挑错', prompt: '【角色:CRITIC】你是批评家，审查产出。', modelClass: 'strong', toolAccess: 'read', avatar: 'menxia' },
    { id: 'scribe', name: '书记', duty: '汇总', prompt: '【角色:SCRIBE】你是书记，汇总成果。', modelClass: 'economy', toolAccess: 'none', avatar: 'libu' },
  ],
  steps: [
    { id: 'design', label: '架构拆解', type: 'plan', phase: 'plan', role: 'architect', executors: ['coder'], output: 'plan', instruction: '拆成 1~2 个子任务。' },
    { id: 'build', label: '工匠实现', type: 'fanout', phase: 'execute', planStep: 'design', executors: ['coder'], output: 'conclusion', instruction: '按子任务实现。' },
    { id: 'critique', label: '批评家审查', type: 'review', phase: 'report', role: 'critic', output: 'verdict', onReject: { goto: 'build', max: 2 }, instruction: '审查成果。CRITIQUE' },
    { id: 'notes', label: '书记汇总', type: 'summary', phase: 'report', role: 'scribe', output: 'text', instruction: '写一段总结。' },
  ],
  policies: { tier: 'lite', maxRejections: 2, tokenBudget: 0, parallelism: 0, finalGate: false, resilience: { ...DEFAULT_RESILIENCE } },
});

test('validator: built-in declarative descriptions are valid; bad designs are rejected with reasons', () => {
  const rtSettings = { maxRejections: { lite: 1, full: 3 }, planGate: { lite: false, full: true }, finalGate: true } as never;
  for (const tier of ['lite', 'full'] as const) {
    const v = validateDesign({ ...builtinDeclarative(tier, rtSettings) });
    assert.ok(v.ok, v.errors.join('; '));
  }
  assert.ok(validateDesign({ ...customDesign(), id: 'x', version: 1, createdAt: 0 }).ok);
  const bad = customDesign();
  bad.steps = [bad.steps[1], bad.steps[0], ...bad.steps.slice(2)]; // fanout before its plan, phases out of order
  const v = validateDesign({ ...bad, id: 'x', version: 1, createdAt: 0 });
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.includes('阶段')));
  assert.ok(v.errors.some((e) => e.includes('规划步骤')));
  const b2 = customDesign();
  b2.steps[2] = { ...b2.steps[2], onReject: { goto: 'notes', max: 2 } };
  assert.ok(validateDesign({ ...b2, id: 'x', version: 1, createdAt: 0 }).errors.some((e) => e.includes('封驳去向')));
  const b3 = { ...customDesign(), native: true };
  assert.ok(validateDesign({ ...b3, id: 'x', version: 1, createdAt: 0 }).errors.some((e) => e.includes('原生')));
  const b4 = customDesign();
  b4.roles[1] = { ...b4.roles[1], avatar: 'emperor' as never };
  assert.ok(!validateDesign({ ...b4, id: 'x', version: 1, createdAt: 0 }).ok);
  // every phase hop maps onto legal edges of the protected state machine; no path skips 门下省
  assert.deepEqual(statePath('Taizi', 'Doing'), ['Zhongshu', 'Menxia', 'Assigned', 'Doing']);
  assert.deepEqual(statePath('Review', 'Doing'), ['Doing']);
});

test('design library: built-in is read-only; copy → versions → rollback; audit; no-op save', async () => {
  const mock = await startMockLlm();
  const rt = makeRuntime(mock.url);
  assert.equal(rt.designs.list()[0].id, BUILTIN_DESIGN_ID);
  assert.throws(() => rt.designs.save({ ...customDesign(), id: BUILTIN_DESIGN_ID }), /不可修改/);
  assert.throws(() => rt.designs.setStatus(BUILTIN_DESIGN_ID, 'disabled'), /不可停用/);
  const c = rt.designs.copy(BUILTIN_DESIGN_ID, { tier: 'full' });
  assert.equal(c.version, 1);
  assert.equal(c.origin.kind, 'copy');
  assert.equal(c.native, undefined);
  const edited = { ...c, steps: c.steps.filter((s) => s.id !== 'dispatch') };
  const v2 = rt.designs.save(edited, '去掉尚书派发');
  assert.equal(v2.version, 2);
  assert.equal(rt.designs.save(edited).version, 2, 'identical content does not create a version');
  const info = rt.designs.list().find((d) => d.id === c.id)!;
  assert.equal(info.activeVersion, 2);
  assert.deepEqual(info.versions.map((v) => v.version), [1, 2]);
  rt.designs.activate(c.id, 1); // rollback
  assert.equal(rt.designs.get(c.id)!.version, 1);
  assert.ok(fs.existsSync(path.join(rt.opts.dataDir, 'designs', c.id, 'v2.json')), 'old versions are immutable files');
  rt.designs.setStatus(c.id, 'disabled');
  assert.throws(() => rt.designs.pin(c.id), /停用/);
  const actions = rt.audit.list({ limit: 100 }).map((e) => e.action);
  for (const a of ['design_saved', 'design_copied', 'design_activated', 'design_status']) assert.ok(actions.includes(a), a);
  assert.ok(rt.audit.verify().ok);
  // the store survives a restart (index re-read) and re-discovers designs if the index is lost
  rt.flushAll();
  fs.rmSync(path.join(rt.opts.dataDir, 'designs', 'index.json'));
  const rt2 = makeRuntime(mock.url, 'openai-chat', rt.opts.dataDir);
  assert.ok(rt2.designs.list().some((d) => d.id === c.id && d.latestVersion === 2));
  rt.dispose();
  rt2.dispose();
  await mock.close();
});

test('pinning: switching / rolling back a design never changes a running edict; old tasks without a design still load', async () => {
  const base = defaultBrain({});
  const mock = await startMockLlm({ delayMs: 20, brain: base });
  const dataDir = tmpDir('edict-data-');
  const rt = makeRuntime(mock.url, 'openai-chat', dataDir);
  rt.setWorkspace(tmpDir('edict-ws-'));
  const d1 = rt.designs.save(customDesign());
  const r = (await submit(rt, { text: '写一个 greet 函数并测试', tier: 'lite', multiAgent: true, designId: d1.id, forceEdict: true })) as { taskId: string };
  const t = rt.tasks.get(r.taskId)!;
  assert.equal(t.design?.version, 1);
  const pinnedHash = t.design!.hash;
  // a new version while the task runs
  rt.designs.save({ ...customDesign(), id: d1.id, name: '改名后的设计', steps: customDesign().steps.slice(0, 2).concat(customDesign().steps[3]) });
  assert.equal(rt.designs.get(d1.id)!.version, 2);
  assert.equal(t.design!.version, 1);
  assert.equal(t.design!.hash, pinnedHash);
  assert.equal(t.designSpec!.steps.length, 4, 'frozen snapshot');
  assert.equal(designHash(t.designSpec!), pinnedHash);
  rt.cancel(r.taskId, '测试结束');
  // legacy task (no design fields) loads and is treated as built-in
  rt.dispose();
  const state = JSON.parse(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8'));
  for (const x of state.tasks) {
    delete x.design;
    delete x.designSpec;
    delete x.flowRun;
  }
  fs.writeFileSync(path.join(dataDir, 'state.json'), JSON.stringify(state));
  const rt2 = makeRuntime(mock.url, 'openai-chat', dataDir);
  assert.equal(rt2.tasks.get(r.taskId)!.design, undefined);
  assert.ok(rt2.snapshot().tasks.length >= 1);
  rt2.dispose();
  await mock.close();
});

for (const tier of ['lite', 'full'] as const) {
  test(`copied 三省六部 (${tier}) runs on the interpreter with the same court flow, gates and loops`, async () => {
    const mock = await startMockLlm({ rejectPlanTimes: 1 });
    const rt = makeRuntime(mock.url);
    const ws = tmpDir('edict-ws-');
    rt.setWorkspace(ws);
    const d = rt.designs.copy(BUILTIN_DESIGN_ID, { tier });
    const r = (await submit(rt, { text: '写一个 greet 函数并测试', tier, multiAgent: true, designId: d.id })) as { taskId: string };
    const t = rt.tasks.get(r.taskId)!;
    assert.equal(t.design?.native, false);
    if (tier === 'full') {
      await waitFor(() => t.gate?.kind === 'plan' || t.state === 'Blocked', 20000, 'plan gate');
      assert.equal(t.state, 'Menxia', t.blockedReason);
      decideGate(rt, r.taskId, { approve: true });
    }
    await waitFor(() => t.gate?.kind === 'final' || t.state === 'Blocked', 25000, 'final gate');
    assert.equal(t.state, 'PendingConfirm', t.blockedReason);
    assert.equal(t.reviews.filter((x) => x.stage === 'plan' && x.verdict === 'reject').length, 1, '封驳 loop happened once');
    assert.equal(t.planHistory.length, 2);
    const states = t.flow.map((f) => f.state);
    assert.ok(states.indexOf('Zhongshu') < states.indexOf('Menxia') && states.indexOf('Menxia') < states.indexOf('Assigned') && states.indexOf('Assigned') < states.indexOf('Doing'), 'state machine order kept');
    assert.ok(fs.existsSync(path.join(ws, 'greet.js')) && fs.existsSync(path.join(ws, 'greet.test.js')), 'artifacts produced');
    assert.equal(t.nodes.filter((n) => n.kind === 'exec' && n.status === 'done').length, 2);
    if (tier === 'full') {
      assert.ok(t.nodes.some((n) => n.kind === 'dispatch' && n.status === 'done'));
      assert.ok(t.nodes.some((n) => n.kind === 'result_review' && n.status === 'done'));
    }
    // final 封驳 → rework of S1 only → final gate again
    decideGate(rt, r.taskId, { approve: false, comment: '再加一行注释', reworkTargets: ['S1'] });
    await waitFor(() => t.gate?.kind === 'final' && t.execRound === 2, 25000, 'final gate after rework');
    assert.ok(t.nodes.some((n) => n.id === 's-execute-2-S1' && n.status === 'done'));
    assert.ok(!t.nodes.some((n) => n.id === 's-execute-2-S2'), 'only the rework target re-ran');
    decideGate(rt, r.taskId, { approve: true, comment: '准' });
    assert.equal(stateOf(rt, r.taskId), 'Done');
    assert.ok(rt.memorials.get(r.taskId), 'memorial archived');
    assert.ok(rt.audit.verify().ok);
    rt.dispose();
    await mock.close();
  });
}

test('custom design with custom roles: critic loop sends work back, roles keep their own identity', async () => {
  let critiques = 0;
  const seenSystems = new Set<string>();
  const mock = await startMockLlm({
    brain: (c) => {
      const role = /【角色:(\w+)】/.exec(c.system)?.[1];
      if (role) seenSystems.add(role);
      if (role === 'ARCHITECT') return { text: JSON.stringify({ summary: '一个子任务', subtasks: [{ id: 'S1', title: '写 hello.txt', dept: 'coder', detail: '写文件', acceptance: '文件存在', dependsOn: [] }], risks: [] }) };
      if (role === 'CODER') {
        if (c.tools.includes('write_file') && c.toolResults === 0) return { toolCalls: [{ name: 'write_file', args: { path: 'hello.txt', content: `hello ${critiques}\n` } }] };
        return { text: '```json\n{"status":"done","summary":"写了 hello.txt","artifacts":["hello.txt"],"verification":"已写入","issues":[]}\n```' };
      }
      if (role === 'CRITIC') {
        critiques++;
        return { text: critiques === 1 ? '{"verdict":"reject","issues":["内容太短"],"comment":"再改","rework":["S1"]}' : '{"verdict":"approve","issues":[],"comment":"可以","rework":[]}' };
      }
      if (role === 'SCRIBE') return { text: '## 总结\n已完成 hello.txt' };
      return { text: '（未知）' };
    },
  });
  const rt = makeRuntime(mock.url);
  const ws = tmpDir('edict-ws-');
  rt.setWorkspace(ws);
  const d = rt.designs.save(customDesign());
  const r = (await submit(rt, { text: '写 hello.txt', tier: 'lite', multiAgent: true, designId: d.id, forceEdict: true })) as { taskId: string };
  await waitFor(() => ['Done', 'Blocked'].includes(stateOf(rt, r.taskId)), 25000, 'done');
  const t = rt.tasks.get(r.taskId)!;
  assert.equal(t.state, 'Done', t.blockedReason);
  assert.equal(critiques, 2);
  assert.deepEqual([...seenSystems].sort(), ['ARCHITECT', 'CODER', 'CRITIC', 'SCRIBE'], 'each role used its own prompt');
  const builds = t.nodes.filter((n) => n.stepId === 'build');
  assert.deepEqual(builds.map((n) => n.id), ['s-build-1-S1', 's-build-2-S1']);
  assert.ok(builds.every((n) => n.roleId === 'coder' && n.roleName === '工匠' && n.agentId === 'bingbu'));
  assert.equal(fs.readFileSync(path.join(ws, 'hello.txt'), 'utf8'), 'hello 1\n', 'second build ran after the critique');
  assert.equal(t.result?.summary.includes('hello.txt'), true);
  // the state machine still walked through 门下省 although the design has no plan review
  assert.ok(t.flow.some((f) => f.state === 'Menxia'));
  rt.dispose();
  await mock.close();
});

test('interpreter: restart mid-step → interrupted node → local retry resumes only that node', async () => {
  const mock = await startMockLlm({ delayMs: 30 });
  const dataDir = tmpDir('edict-data-');
  const rt = makeRuntime(mock.url, 'openai-chat', dataDir);
  const ws = tmpDir('edict-ws-');
  rt.setWorkspace(ws);
  rt.updateSettings({ finalGate: false });
  const d = rt.designs.copy(BUILTIN_DESIGN_ID, { tier: 'lite' });
  const r = (await submit(rt, { text: '写一个 greet 函数并测试', tier: 'lite', multiAgent: true, designId: d.id })) as { taskId: string };
  await waitFor(() => rt.tasks.get(r.taskId)!.nodes.some((n) => n.kind === 'exec' && n.status === 'running'), 20000, 'exec running');
  const planCalls = mock.calls.filter((c) => c.system.includes('你是中书省')).length;
  rt.flushAll();
  for (const c of rt.controllers.values()) c.abort();
  const rt2 = makeRuntime(mock.url, 'openai-chat', dataDir);
  const t2 = rt2.tasks.get(r.taskId)!;
  assert.equal(t2.state, 'Blocked');
  const interrupted = t2.nodes.find((n) => n.exitStatus === 'interrupted')!;
  rt2.setWorkspace(ws);
  retryNode(rt2, r.taskId, interrupted.id);
  await waitFor(() => ['Done', 'Blocked'].includes(rt2.tasks.get(r.taskId)!.state), 25000, 'recovered');
  assert.equal(rt2.tasks.get(r.taskId)!.state, 'Done', rt2.tasks.get(r.taskId)!.blockedReason);
  assert.equal(mock.calls.filter((c) => c.system.includes('你是中书省')).length, planCalls, 'plan not replayed');
  rt.dispose();
  rt2.dispose();
  await mock.close();
});
