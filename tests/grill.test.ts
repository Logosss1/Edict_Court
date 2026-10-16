// 细问: before the first plan the planning official interviews the emperor in rounds; facts are
// used only once confirmed; 问答纪要 is confirmed, then every later prompt carries it. 全自动: timed-out questions
// stay open and a late answer reworks what was done before it. mock/integration.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startMockLlm, defaultBrain, type MockCall } from './mockLlm';
import { makeRuntime, tmpDir, waitFor, stateOf } from './helpers';
import { submit, resumeAll, decideGate } from '../src/main/runtime/orchestrator';
import { answerGrill, answerGrillLate, grillWanted, mechanicalMinutes, parseRound } from '../src/main/runtime/grill';
import { buildMemorial, type Runtime } from '../src/main/runtime/runtime';
import { BUILTIN_DESIGN_ID, DESIGN_SCHEMA, DEFAULT_RESILIENCE } from '../src/shared/design';
import type { ApprovalRequest, GrillState, Task } from '../src/shared/types';

const EDICT = '写一个 greet 函数并测试';
const R1 = {
  type: 'ask',
  facts: [{ text: '工作区里还没有 greet.js', source: 'list_dir' }, { text: '项目用 node 18', source: 'package.json' }, { text: '测试用 jest' }],
  questions: [
    { title: '问候语用中文还是英文？', body: '影响 greet 的返回值', options: ['英文 Hello', '中文 你好'], recommend: '英文 Hello' },
    { title: '要不要处理空名字？', options: ['不处理', '返回默认问候'], recommend: '不处理' },
  ],
};

/** A court whose 中书省 (or any planning role) answers each 细问 round from the script, in order; records every call. */
async function court(rounds: object[], o: { delayExecMs?: number } = {}) {
  const seen: MockCall[] = [];
  const base = defaultBrain({});
  let k = 0;
  const mock = await startMockLlm({
    delayFor: (c) => (o.delayExecMs && /(兵部|刑部)尚书/.test(c.system) ? o.delayExecMs : undefined),
    brain: (c) => {
      seen.push(c);
      if (c.lastUser.includes('【细问】')) {
        if (c.tools.length && c.toolResults === 0) return { toolCalls: [{ name: 'list_dir', args: { path: '.' } }] };
        return { text: JSON.stringify(rounds[k++] ?? { type: 'done', minutes: '- 照旨意办' }) };
      }
      return base(c);
    },
  });
  const grillCalls = () => seen.filter((c) => c.lastUser.includes('【细问】') && !(c.tools.length && c.toolResults === 0));
  const plans = () => seen.filter((c) => c.system.includes('你是中书省') && !c.lastUser.includes('【细问】'));
  return { mock, seen, grillCalls, plans };
}

function prepare(rt: Runtime, ws = tmpDir('edict-ws-')) {
  rt.updateSettings({ grillAsk: true, finalGate: false, askTimeoutMin: 0 });
  rt.setWorkspace(ws);
  return ws;
}

const pendingGrill = (rt: Runtime, phase?: 'round' | 'minutes', not?: string) =>
  waitFor(() => [...rt.approvals.values()].find((a) => a.status === 'pending' && a.kind === 'grill' && (!phase || a.grill?.phase === phase) && a.id !== not), 10000, `grill ${phase ?? ''} card`) as Promise<ApprovalRequest>;
const finished = (rt: Runtime, id: string, states = ['Done', 'Blocked']) => waitFor(() => states.includes(stateOf(rt, id)), 30000, 'edict finished');
const settle = (ms = 200) => new Promise((r) => setTimeout(r, ms));

test('parseRound: recommendation first among the options, strings accepted, done with minutes, junk rejected', () => {
  const r = parseRound(JSON.stringify({ type: 'ask', questions: [{ title: '用哪种？', options: ['甲', '乙', '甲'], recommend: '乙' }, '只是一句问题', { body: '没有标题' }], facts: ['事实一', { fact: '事实二', source: 'x' }, {}] }));
  assert.ok(r && r.type === 'ask');
  assert.deepEqual(r.questions.map((q) => [q.title, q.options, q.recommend]), [['用哪种？', ['乙', '甲'], '乙'], ['只是一句问题', [], '']]);
  assert.deepEqual(r.facts, [{ text: '事实一' }, { text: '事实二', source: 'x' }]);
  const q = parseRound('{"type":"ask","questions":[{"question":"要几个？","options":["一","二"]}]}');
  assert.ok(q && q.type === 'ask' && q.questions[0].recommend === '一', 'no recommendation: the first option');
  assert.deepEqual(parseRound('好的```json\n{"type":"done","minutes":"- 纪要"}\n```'), { type: 'done', minutes: '- 纪要' });
  assert.deepEqual(parseRound('{"minutes":"- 只有纪要"}'), { type: 'done', minutes: '- 只有纪要' });
  assert.equal(parseRound('{"type":"ask","questions":[]}'), null);
  assert.equal(parseRound('没有 JSON'), null);
});

test('grillWanted: Court Lite / Full before the first plan; never Solo, scheduled, 「这道不必问」 or an edict already planned', () => {
  const rt = { settings: { grillAsk: true } } as unknown as Runtime;
  const off = { settings: { grillAsk: false } } as unknown as Runtime;
  const t = (x: Partial<Task>) => ({ tier: 'lite', edict: EDICT, planHistory: [], ...x }) as Task;
  assert.equal(grillWanted(rt, t({})), true);
  assert.equal(grillWanted(rt, t({ tier: 'full' })), true);
  assert.equal(grillWanted(rt, t({ tier: 'solo' })), false);
  assert.equal(grillWanted(rt, t({ schedule: { id: 's', title: 's', permission: 'readonly', firedAt: 0 } })), false);
  assert.equal(grillWanted(rt, t({ noGrill: true })), false);
  assert.equal(grillWanted(rt, t({ planHistory: [{ version: 1 } as never] })), false);
  assert.equal(grillWanted(off, t({})), false);
  assert.equal(grillWanted(off, t({ edict: '写一首诗，不清楚可以问我' })), true, 'an invitation to ask overrides the switch');
});

test('细问: rounds with recommendations, facts confirmed before use, 纪要 confirmed after 补充; the plan and every later stage follow it', async () => {
  const R2 = { type: 'ask', questions: [{ title: '默认问候写什么？', options: ['Hello, friend', 'Hi'], recommend: 'Hello, friend' }] };
  const R3 = { type: 'done', minutes: '- 英文问候\n- 空名字返回默认问候' };
  const R4 = { type: 'done', minutes: '- 英文问候\n- 空名字返回 Hello, friend\n- 不用 jest，用 node 直接跑' };
  const { mock, seen, grillCalls, plans } = await court([R1, R2, R3, R4]);
  const rt = makeRuntime(mock.url);
  prepare(rt);
  const r = (await submit(rt, { text: EDICT, tier: 'lite', multiAgent: true })) as { taskId: string };
  const t = rt.tasks.get(r.taskId)!;
  let ap = await pendingGrill(rt, 'round');
  assert.equal(t.state, 'Zhongshu');
  assert.equal(ap.agentId, 'zhongshu');
  assert.equal(ap.summary, '中书省细问（第 1 轮）：2 个问题，3 条事实待确认');
  assert.deepEqual(ap.grill!.questions.map((q) => q.id), ['Q1', 'Q2']);
  assert.deepEqual(ap.grill!.facts.map((f) => [f.id, f.status]), [['F1', 'pending'], ['F2', 'pending'], ['F3', 'pending']]);
  assert.equal(plans().length, 0, 'no plan while asking');
  assert.match(grillCalls()[0].lastUser, /每个问题都写出你的推荐答案/);
  assert.ok(grillCalls()[0].tools.includes('read_file'), 'the official looks things up with read tools');
  assert.ok(!grillCalls()[0].tools.includes('write_file'));
  assert.ok(t.nodes.some((n) => n.id === 'grill-1' && n.kind === 'grill' && n.status === 'done'));

  answerGrill(rt, ap.id, {
    answers: [{ id: 'Q1', answer: '英文 Hello', how: 'option' }, { id: 'Q2', answer: '返回默认问候', how: 'option' }],
    facts: [{ id: 'F1', status: 'confirmed' }, { id: 'F2', status: 'corrected', correction: '项目用 node 20' }, { id: 'F3', status: 'wrong' }],
    note: '注释写中文',
  });
  ap = await pendingGrill(rt, 'round', ap.id);
  assert.equal(ap.grill!.round, 2);
  assert.deepEqual(ap.grill!.questions.map((q) => q.id), ['Q3']);
  const g2 = grillCalls()[1].lastUser;
  assert.match(g2, /Q1（第 1 轮）问候语用中文还是英文？\n {2}推荐：英文 Hello\n {2}答复：英文 Hello（按推荐）/);
  assert.match(g2, /Q2（第 1 轮）要不要处理空名字？\n {2}推荐：不处理\n {2}答复：返回默认问候（皇上选定）/);
  assert.match(g2, /F2 项目用 node 18：皇上更正为：项目用 node 20/);
  assert.match(g2, /F3 测试用 jest：皇上说不对，不要用/);
  assert.match(g2, /【皇上的补充】\n- 注释写中文/);
  assert.match(g2, /已经问过的不要再问/);

  rt.decideApproval(ap.id, true, 'emperor', 'recommend');
  ap = await pendingGrill(rt, 'minutes');
  assert.equal(ap.summary, '中书省呈上问答纪要，请皇上过目');
  assert.match(ap.grill!.minutes!, /空名字返回默认问候/);
  assert.equal(t.grill!.questions[2].answer, 'Hello, friend');
  assert.throws(() => rt.decideApproval(ap.id, true, 'emperor', 'more'), /请先写明/);
  rt.decideApproval(ap.id, true, 'emperor', 'more', '不用 jest，用 node 直接跑');
  ap = await pendingGrill(rt, 'minutes', ap.id);
  const g4 = grillCalls()[3].lastUser;
  assert.match(g4, /【你上次写的问答纪要】\n- 英文问候\n- 空名字返回默认问候/);
  assert.match(g4, /不用 jest，用 node 直接跑/);
  rt.decideApproval(ap.id, true, 'emperor', 'ok');

  await finished(rt, r.taskId);
  assert.equal(t.state, 'Done', t.blockedReason);
  const g = t.grill as GrillState;
  assert.equal(g.ended, 'confirmed');
  assert.equal(g.rounds, 4);
  assert.equal(g.minutes, R4.minutes, 'the 纪要 he approved, as written');
  for (const c of [plans()[0], seen.find((x) => x.system.includes('你是门下省'))!, seen.find((x) => x.system.includes('兵部尚书'))!, seen.find((x) => x.system.includes('你是尚书省'))!]) {
    assert.match(c.lastUser, /【细问纪要】（规划前中书省向皇上问清的事[^\n]*\n- 英文问候\n- 空名字返回 Hello, friend\n- 不用 jest/);
  }
  const stage = buildMemorial(t).stages.find((s) => s.key === 'grill')!;
  assert.equal(buildMemorial(t).stages[1].key, 'grill');
  assert.ok(stage.items.includes('中书省问了 4 轮，皇上准了纪要'));
  assert.ok(stage.items.includes('Q2 要不要处理空名字？ —— 返回默认问候（皇上答复）'));
  assert.ok(stage.items.includes('F2 项目用 node 18 —— 皇上更正：项目用 node 20'));
  assert.ok(rt.activities(r.taskId, 300).some((a) => a.content.startsWith('皇上答复中书省细问（第 1 轮）')));
  const actions = rt.audit.list({ limit: 500 }).filter((e) => e.taskId === r.taskId).map((e) => e.action);
  for (const a of ['grill_started', 'grill_round', 'grill_answered', 'grill_minutes', 'grill_more', 'grill_done']) assert.ok(actions.includes(a), a);
  rt.dispose();
  await mock.close();
});

test('细问: 「不必再问，开始规划」 ends it at once; answers given stand, the rest take the recommendation, unmarked facts are not used', async () => {
  const { mock, grillCalls, plans } = await court([R1]);
  const rt = makeRuntime(mock.url);
  prepare(rt);
  const r = (await submit(rt, { text: EDICT, tier: 'full', multiAgent: true })) as { taskId: string };
  const t = rt.tasks.get(r.taskId)!;
  const ap = await pendingGrill(rt, 'round');
  assert.throws(() => answerGrill(rt, ap.id, { answers: [], facts: [{ id: 'F1', status: 'corrected' }] }), /写明正确的说法/);
  answerGrill(rt, ap.id, { answers: [{ id: 'Q1', answer: '中文 你好', how: 'option' }], facts: [{ id: 'F1', status: 'confirmed' }], stop: true });
  await finished(rt, r.taskId);
  assert.equal(t.state, 'Done', t.blockedReason);
  assert.equal(grillCalls().length, 1, 'no further round');
  const g = t.grill!;
  assert.equal(g.ended, 'stopped');
  assert.deepEqual(g.questions.map((q) => [q.answer, q.how]), [['中文 你好', 'option'], ['不处理', 'recommend']]);
  assert.deepEqual(g.facts.map((f) => f.status), ['confirmed', 'unconfirmed', 'unconfirmed']);
  assert.match(g.minutes!, /Q1 问候语用中文还是英文？：中文 你好（皇上选定）/);
  assert.match(g.minutes!, /Q2 要不要处理空名字？：不处理（按推荐）/);
  assert.match(g.minutes!, /F1 工作区里还没有 greet.js（皇上确认）/);
  assert.match(g.minutes!, /F2 项目用 node 18（未经确认，不作依据）/);
  assert.match(plans()[0].lastUser, /【细问纪要】[\s\S]*中文 你好/);
  // Full Court: 方案御览 is off by default now; 对照检查 is the one review of the result
  assert.ok(!t.flow.some((f) => f.remark?.includes('御览')));
  assert.ok(!t.nodes.some((n) => n.kind === 'result_review'));
  assert.ok(t.nodes.some((n) => n.kind === 'check' && n.status === 'done'));
  rt.dispose();
  await mock.close();
});

test('细问 in 全自动: nobody answers → recommendations stand but stay open; a late answer is a 口谕 and reworks what started before it', async () => {
  const { mock, seen } = await court([R1], { delayExecMs: 25 });
  const rt = makeRuntime(mock.url);
  prepare(rt);
  rt.updateSettings({ permissionMode: 'auto', askTimeoutMin: 0.002 });
  const r = (await submit(rt, { text: EDICT, tier: 'lite', multiAgent: true })) as { taskId: string };
  const t = rt.tasks.get(r.taskId)!;
  const ap = await pendingGrill(rt, 'round');
  assert.match(ap.reason, /全自动模式：0.002 分钟内未答复将先按推荐答案办，问题留着可以补答/);
  await waitFor(() => t.grill?.status === 'done', 5000, 'timed out');
  assert.equal(t.grill!.ended, 'timeout');
  assert.deepEqual(t.grill!.questions.map((q) => [q.answer, q.how]), [['英文 Hello', 'timeout'], ['不处理', 'timeout']]);
  assert.ok(t.grill!.facts.every((f) => f.status === 'unconfirmed'));
  assert.match(t.grill!.minutes!, /英文 Hello（皇上未答，暂按推荐）/);
  assert.ok(rt.audit.list({ limit: 300 }).some((e) => e.action === 'grill_timeout' && e.actor === 'system' && e.taskId === r.taskId));

  await waitFor(() => t.nodes.some((n) => n.kind === 'exec' && n.status === 'running'), 20000, 'a ministry at work');
  const res = answerGrillLate(rt, r.taskId, { answers: [{ id: 'Q1', answer: '中文 你好', how: 'option' }, { id: 'Q2', answer: '不处理', how: 'recommend' }], facts: [{ id: 'F1', status: 'confirmed' }] });
  assert.deepEqual(res, { rework: true, changed: 2 }, 'Q1 and F1 changed; keeping Q2 on its recommendation is a confirmation only');
  assert.deepEqual(t.grill!.questions.map((q) => q.how), ['option', 'recommend']);
  assert.ok(t.orals?.some((o) => o.text.startsWith('皇上补答细问') && o.text.includes('Q1 问候语用中文还是英文？：中文 你好')));
  assert.match(t.grill!.minutes!, /中文 你好（皇上补答）/);
  assert.ok(t.grill!.lateRework);
  await finished(rt, r.taskId);
  assert.equal(t.state, 'Done', t.blockedReason);
  assert.equal(t.grill!.lateRework, undefined);
  assert.equal(t.execRound, 2);
  assert.match(t.rework!.feedback, /皇上补答细问[\s\S]*请按皇上补答调整成品/);
  assert.ok(t.rework!.targets.includes('S1'), 'the subtask that had started reworks');
  const redo = seen.filter((c) => c.system.includes('兵部尚书') && c.lastUser.includes('【返工要求'));
  assert.ok(redo.length && redo[0].lastUser.includes('中文 你好'));
  assert.ok(seen.filter((c) => c.system.includes('你是尚书省')).at(-1)!.lastUser.includes('中文 你好'), 'the report reads the late answer in the 纪要');
  rt.dispose();
  await mock.close();
});

test('细问 late answer at the final 御批 sends the result back at once; after the edict is done it is only recorded', async () => {
  const { mock } = await court([R1]);
  const rt = makeRuntime(mock.url);
  prepare(rt);
  rt.updateSettings({ permissionMode: 'auto', askTimeoutMin: 0.002, finalGate: true });
  const r = (await submit(rt, { text: EDICT, tier: 'lite', multiAgent: true })) as { taskId: string };
  const t = rt.tasks.get(r.taskId)!;
  await waitFor(() => t.gate?.kind === 'final' || t.state === 'Blocked', 30000, 'final gate');
  assert.equal(t.state, 'PendingConfirm', t.blockedReason);
  assert.deepEqual(answerGrillLate(rt, r.taskId, { answers: [{ id: 'Q1', answer: '中文 你好', how: 'option' }], facts: [] }), { rework: true, changed: 1 });
  assert.notEqual(t.state, 'PendingConfirm');
  const rej = t.reviews.at(-1)!;
  assert.equal(rej.reviewer, 'emperor');
  assert.equal(rej.verdict, 'reject');
  assert.match(rej.comment, /皇上补答细问/);
  await waitFor(() => (t.gate?.kind === 'final' && t.execRound === 2) || t.state === 'Blocked', 30000, 'final gate again');
  assert.equal(t.grill!.lateRework, undefined);
  decideGate(rt, r.taskId, { approve: true });
  assert.equal(stateOf(rt, r.taskId), 'Done');
  const orals = t.orals?.length ?? 0;
  assert.deepEqual(answerGrillLate(rt, r.taskId, { answers: [{ id: 'Q2', answer: '返回默认问候', how: 'option' }], facts: [] }), { rework: false, changed: 1 });
  assert.equal(t.orals?.length ?? 0, orals, 'no 口谕 to a finished edict');
  assert.equal(t.grill!.questions[1].answer, '返回默认问候');
  assert.ok(rt.activities(r.taskId, 300).some((a) => a.content.includes('旨意已结束，只记录在案')));
  assert.throws(() => answerGrillLate(rt, r.taskId, { answers: [], facts: [] }), /没有补答/);
  rt.dispose();
  await mock.close();
});

test('细问 across a restart: the open round is put again from what was asked, the model is not asked again', async () => {
  const { mock, grillCalls } = await court([R1]);
  const dataDir = tmpDir('edict-data-');
  const rt = makeRuntime(mock.url, 'openai-chat', dataDir);
  const ws = prepare(rt);
  const r = (await submit(rt, { text: EDICT, tier: 'lite', multiAgent: true })) as { taskId: string };
  await pendingGrill(rt, 'round');
  rt.flushAll();
  const rt2 = makeRuntime(mock.url, 'openai-chat', dataDir);
  rt.dispose();
  prepare(rt2, ws);
  const t2 = rt2.tasks.get(r.taskId)!;
  assert.equal(t2.grill!.status, 'waiting');
  assert.equal([...rt2.approvals.values()].length, 0, 'cards are not persisted');
  resumeAll(rt2);
  const ap = await pendingGrill(rt2, 'round');
  assert.deepEqual(ap.grill!.questions.map((q) => q.title), R1.questions.map((q) => q.title));
  assert.ok(rt2.activities(r.taskId, 100).some((a) => a.content === '中书省再次呈上细问（此前未获答复）'));
  await settle();
  assert.equal(grillCalls().length, 1);
  assert.equal(stateOf(rt2, r.taskId), 'Zhongshu');
  rt2.decideApproval(ap.id, true, 'emperor', 'stop');
  await finished(rt2, r.taskId);
  assert.equal(stateOf(rt2, r.taskId), 'Done', t2.blockedReason);
  assert.equal(t2.grill!.ended, 'stopped');
  rt2.dispose();
  await mock.close();
});

test('no 细问 with 「这道不必问」 or the switch off; cancelling while a card is open leaves the edict alone', async () => {
  const { mock, grillCalls, plans } = await court([R1]);
  const rt = makeRuntime(mock.url);
  prepare(rt);
  const a = (await submit(rt, { text: EDICT, tier: 'lite', multiAgent: true, noGrill: true })) as { taskId: string };
  await finished(rt, a.taskId);
  assert.equal(stateOf(rt, a.taskId), 'Done');
  assert.equal(rt.tasks.get(a.taskId)!.noGrill, true);
  assert.equal(rt.tasks.get(a.taskId)!.grill, undefined);
  rt.updateSettings({ grillAsk: false });
  const b = (await submit(rt, { text: EDICT, tier: 'full', multiAgent: true })) as { taskId: string };
  await finished(rt, b.taskId);
  assert.equal(rt.tasks.get(b.taskId)!.grill, undefined);
  assert.equal(grillCalls().length, 0);
  assert.equal(plans().filter((c) => c.lastUser.includes('【细问纪要】')).length, 0);

  rt.updateSettings({ grillAsk: true });
  const c = (await submit(rt, { text: EDICT, tier: 'lite', multiAgent: true })) as { taskId: string };
  const ap = await pendingGrill(rt, 'round');
  rt.cancel(c.taskId);
  assert.equal(rt.approvals.get(ap.id)!.status, 'denied');
  await settle();
  assert.equal(stateOf(rt, c.taskId), 'Cancelled');
  assert.equal(rt.tasks.get(c.taskId)!.grill!.status, 'waiting');
  rt.dispose();
  await mock.close();
});

test('协同设计: the plan step\'s role asks under its own name and model; a design with no plan step does not ask', async () => {
  const { mock, grillCalls } = await court([{ type: 'done', minutes: '- 照旨意办' }]);
  const rt = makeRuntime(mock.url);
  prepare(rt);
  const copy = rt.designs.copy(BUILTIN_DESIGN_ID, { tier: 'lite' });
  const r = (await submit(rt, { text: EDICT, tier: 'lite', multiAgent: true, designId: copy.id })) as { taskId: string };
  const t = rt.tasks.get(r.taskId)!;
  const ap = await pendingGrill(rt, 'minutes');
  assert.equal(ap.agentId, 'zhongshu');
  assert.equal(ap.summary, '中书省呈上问答纪要，请皇上过目');
  assert.equal(t.nodes.find((n) => n.id === 'grill-1')!.roleId, 'zhongshu');
  assert.ok(!t.nodes.some((n) => n.kind === 'plan'), 'the plan node is made after 细问');
  rt.decideApproval(ap.id, true, 'emperor', 'ok');
  await finished(rt, r.taskId);
  assert.equal(t.state, 'Done', t.blockedReason);

  const arch = rt.designs.save({
    schema: DESIGN_SCHEMA, name: '架构师单干', description: 'x', origin: { kind: 'user' },
    roles: [
      { id: 'architect', name: '架构师', duty: '拆解', prompt: '【角色:ARCHITECT】你是架构师。', modelClass: 'strong', toolAccess: 'read', avatar: 'zhongshu' },
      { id: 'coder', name: '工匠', duty: '实现', prompt: '【角色:CODER】你是工匠。', modelClass: 'economy', toolAccess: 'write', avatar: 'bingbu' },
    ],
    steps: [
      { id: 'design', label: '架构拆解', type: 'plan', phase: 'plan', role: 'architect', executors: ['coder'], output: 'plan', instruction: '拆成子任务。' },
      { id: 'build', label: '工匠实现', type: 'fanout', phase: 'execute', planStep: 'design', executors: ['coder'], output: 'conclusion', instruction: '实现。' },
    ],
    policies: { tier: 'lite', maxRejections: 1, tokenBudget: 0, parallelism: 0, finalGate: false, resilience: { ...DEFAULT_RESILIENCE } },
  });
  const r2 = (await submit(rt, { text: EDICT, tier: 'lite', multiAgent: true, designId: arch.id, forceEdict: true })) as { taskId: string };
  const ap2 = await pendingGrill(rt, 'minutes');
  assert.equal(ap2.summary, '架构师呈上问答纪要，请皇上过目');
  assert.match(grillCalls().at(-1)!.system, /ARCHITECT/);
  assert.match(grillCalls().at(-1)!.lastUser, /动手规划之前，架构师要先把这道旨意向皇上问清楚/);
  rt.cancel(r2.taskId);

  const solo = rt.designs.save({
    schema: DESIGN_SCHEMA, name: '只写总结', description: 'x', origin: { kind: 'user' },
    roles: [{ id: 'scribe', name: '书记', duty: '汇总', prompt: '【角色:SCRIBE】你是书记。', modelClass: 'economy', toolAccess: 'none', avatar: 'libu' }],
    steps: [{ id: 'notes', label: '书记汇总', type: 'summary', phase: 'report', role: 'scribe', output: 'text', instruction: '写一段总结。' }],
    policies: { tier: 'lite', maxRejections: 1, tokenBudget: 0, parallelism: 0, finalGate: false, resilience: { ...DEFAULT_RESILIENCE } },
  });
  const before = grillCalls().length;
  const r3 = (await submit(rt, { text: EDICT, tier: 'lite', multiAgent: true, designId: solo.id, forceEdict: true })) as { taskId: string };
  await finished(rt, r3.taskId);
  assert.equal(stateOf(rt, r3.taskId), 'Done', rt.tasks.get(r3.taskId)!.blockedReason);
  assert.equal(rt.tasks.get(r3.taskId)!.grill, undefined);
  assert.equal(grillCalls().length, before);
  rt.dispose();
  await mock.close();
});

test('mechanicalMinutes: every answer with how it was given, facts with the emperor\'s word, his notes', () => {
  const g: GrillState = {
    by: 'zhongshu', name: '中书省', status: 'done', rounds: 1, notes: ['先做后台'],
    questions: [
      { id: 'Q1', round: 1, title: 'A？', body: '', options: [], recommend: 'a', answer: 'a', how: 'timeout', answeredAt: 1 },
      { id: 'Q2', round: 1, title: 'B？', body: '', options: [], recommend: 'b', answer: 'c', how: 'free', answeredAt: 1, lateAt: 2 },
      { id: 'Q3', round: 1, title: 'C？', body: '', options: [], recommend: 'x' },
    ],
    facts: [{ id: 'F1', round: 1, text: '甲', status: 'corrected', correction: '乙' }, { id: 'F2', round: 1, text: '丙', status: 'wrong' }, { id: 'F3', round: 1, text: '丁', status: 'pending' }],
  };
  assert.equal(mechanicalMinutes(g), '问答：\n- Q1 A？：a（皇上未答，暂按推荐）\n- Q2 B？：c（皇上补答）\n\n查到的事实：\n- F1 乙（皇上更正，原为：甲）\n- F2 丙（皇上说不对，不要用）\n\n皇上补充：\n- 先做后台');
  assert.equal(mechanicalMinutes({ ...g, questions: [], facts: [], notes: [] }), '（旨意已清楚，无须细问）');
});
