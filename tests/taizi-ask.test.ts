// 太子追问: at triage the prince may put ONE short question to the emperor before the edict goes to 中书省;
// 请旨 phrasing (courtAddress) for the prince and the officials. mock/integration.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startMockLlm, defaultBrain, type MockCall } from './mockLlm';
import { makeRuntime, tmpDir, waitFor, stateOf } from './helpers';
import { submit, resumeAll } from '../src/main/runtime/orchestrator';
import { parsePrinceAsk } from '../src/main/runtime/askEmperor';
import { executeTool } from '../src/main/runtime/tools';
import type { Runtime } from '../src/main/runtime/runtime';
import { courtAddress } from '../src/shared/court';
import type { RunNode, Task } from '../src/shared/types';

const EDICT = '把登录页改一下';
const ASK = { type: 'ask', title: '修改登录页', question: '要改哪个项目的登录页？', options: ['后台管理', '用户前台'], assume: '改用户前台的登录页', reason: '工作区里有两个登录页' };

/** Mock court whose prince asks about EDICT (everything else as usual); records every call. */
async function court() {
  const seen: MockCall[] = [];
  const base = defaultBrain({});
  const mock = await startMockLlm({
    brain: (c) => {
      seen.push(c);
      if (c.system.includes('你是太子') && c.lastUser.includes(EDICT)) return { text: JSON.stringify(ASK) };
      return base(c);
    },
  });
  return { mock, seen, zhongshu: () => seen.filter((c) => c.system.includes('你是中书省')) };
}

function prepare(rt: Runtime, ws = tmpDir('edict-ws-')) {
  rt.updateSettings({ finalGate: false, askTimeoutMin: 0 });
  rt.setWorkspace(ws);
  return ws;
}

const pendingQuestion = (rt: Runtime) => waitFor(() => [...rt.approvals.values()].find((a) => a.status === 'pending' && a.kind === 'question'), 5000, 'question card');
const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms));
const finished = (rt: Runtime, id: string) => waitFor(() => ['Done', 'Blocked'].includes(stateOf(rt, id)), 25000, 'edict finished');

test('parsePrinceAsk: only a well-formed ask; at most 3 options', () => {
  assert.equal(parsePrinceAsk({ type: 'edict', question: 'x' }), null);
  assert.equal(parsePrinceAsk({ type: 'ask', question: '  ' }), null);
  assert.equal(parsePrinceAsk(null), null);
  assert.deepEqual(parsePrinceAsk({ type: 'ask', question: ' 改哪个？ ', options: ['a', ' ', 'b', 'c', 'd'], assume: ' a ' }), { question: '改哪个？', options: ['a', 'b', 'c'], assume: 'a' });
  assert.deepEqual(parsePrinceAsk({ type: 'ask', question: '改哪个？' }), { question: '改哪个？', options: [], assume: '' });
});

test('太子追问: the edict waits in 太子分拣 for one question; the chosen option reaches 中书省 and the flow proceeds', async () => {
  const { mock, zhongshu } = await court();
  const rt = makeRuntime(mock.url);
  prepare(rt);
  const r = await submit(rt, { text: EDICT, tier: 'lite', multiAgent: true });
  assert.equal(r.kind, 'task');
  const id = (r as { taskId: string }).taskId;
  const t = rt.tasks.get(id)!;
  assert.equal(t.state, 'Taizi');
  assert.equal(t.title, '修改登录页');
  assert.ok(t.nodes.some((n) => n.id === 'triage' && n.status === 'done'));

  const ap = await pendingQuestion(rt);
  assert.equal(ap.agentId, 'taizi');
  assert.equal(ap.taskId, id);
  assert.equal(ap.summary, '太子请旨：父皇，要改哪个项目的登录页？');
  assert.deepEqual(ap.choices!.map((c) => c.id), ['o0', 'o1', 'free', 'self']);
  assert.deepEqual(ap.choices!.map((c) => c.label), ['后台管理', '用户前台', '回复', '不必问，照办']);
  assert.equal(ap.choices!.find((c) => c.id === 'free')!.comment, 'required');
  assert.match(ap.choices!.find((c) => c.id === 'self')!.hint ?? '', /改用户前台的登录页/);
  assert.deepEqual(t.questions!.map((q) => [q.agentId, q.question, q.assume]), [['taizi', '要改哪个项目的登录页？', '改用户前台的登录页']]);
  assert.ok(rt.activities(id, 100).some((a) => a.content === '太子请旨：父皇，要改哪个项目的登录页？（后台管理 / 用户前台）'));
  assert.ok(rt.audit.list({ limit: 200 }).some((e) => e.action === 'ask_emperor' && e.actor === 'taizi' && e.taskId === id));

  // nothing moves while the question is open, and driving again does not ask a second time
  resumeAll(rt);
  await settle();
  assert.equal(stateOf(rt, id), 'Taizi');
  assert.equal(zhongshu().length, 0);
  assert.equal([...rt.approvals.values()].filter((a) => a.kind === 'question').length, 1);

  rt.decideApproval(ap.id, true, 'emperor', 'o0');
  await finished(rt, id);
  assert.equal(stateOf(rt, id), 'Done', t.blockedReason);
  assert.ok(t.edict.endsWith(`${EDICT}\n\n【太子请旨】要改哪个项目的登录页？\n【皇上示下】后台管理`), t.edict);
  assert.ok(zhongshu().length > 0 && zhongshu().every((c) => c.lastUser.includes('【皇上示下】后台管理')), '中书省 plans with the answer');
  assert.deepEqual([t.questions!.length, t.questions![0].how, t.questions![0].answer], [1, 'option', '后台管理']);
  assert.ok(rt.audit.list({ limit: 300 }).some((e) => e.action === 'ask_emperor_answered' && e.actor === 'emperor' && e.taskId === id));
  const m = rt.memorials.get(id)!;
  assert.ok(m.stages.some((s) => s.key === 'questions' && s.items.some((i) => i.includes('太子 问：要改哪个项目的登录页？') && i.includes('后台管理'))));
  assert.equal(rt.agents.get('taizi')!.status, 'idle');
  rt.dispose();
  await mock.close();
});

test('太子追问: 「不必问，照办」 continues on the prince\'s assumption; a free reply is passed on as written', async () => {
  const { mock, zhongshu } = await court();
  const rt = makeRuntime(mock.url);
  prepare(rt);
  let r = (await submit(rt, { text: EDICT, tier: 'lite', multiAgent: true })) as { taskId: string };
  let ap = await pendingQuestion(rt);
  rt.decideApproval(ap.id, true, 'emperor', 'self');
  await finished(rt, r.taskId);
  let t = rt.tasks.get(r.taskId)!;
  assert.equal(t.state, 'Done', t.blockedReason);
  assert.equal(t.questions![0].how, 'self');
  assert.match(t.edict, /【皇上示下】不必问，照太子所拟：改用户前台的登录页$/);
  assert.ok(zhongshu().some((c) => c.lastUser.includes('不必问，照太子所拟：改用户前台的登录页')));

  const before = zhongshu().length;
  r = (await submit(rt, { text: EDICT, tier: 'lite', multiAgent: true })) as { taskId: string };
  ap = await pendingQuestion(rt);
  assert.throws(() => rt.decideApproval(ap.id, true, 'emperor', 'free'), /写明/);
  rt.decideApproval(ap.id, true, 'emperor', 'free', '两个都改，先改后台');
  await finished(rt, r.taskId);
  t = rt.tasks.get(r.taskId)!;
  assert.equal(t.state, 'Done', t.blockedReason);
  assert.deepEqual([t.questions![0].how, t.questions![0].answer], ['free', '两个都改，先改后台']);
  assert.match(t.edict, /【太子请旨】要改哪个项目的登录页？\n【皇上示下】两个都改，先改后台$/);
  assert.ok(zhongshu().slice(before).some((c) => c.lastUser.includes('【皇上示下】两个都改，先改后台')));
  rt.dispose();
  await mock.close();
});

test('太子追问 off (taiziAsk: false) or 直接下旨: no question, the edict goes straight on', async () => {
  const { mock, seen, zhongshu } = await court();
  const rt = makeRuntime(mock.url);
  prepare(rt);
  rt.updateSettings({ taiziAsk: false });
  let r = (await submit(rt, { text: EDICT, tier: 'lite', multiAgent: true })) as { taskId: string };
  await finished(rt, r.taskId);
  let t = rt.tasks.get(r.taskId)!;
  assert.equal(t.state, 'Done', t.blockedReason);
  assert.equal(t.title, '修改登录页');
  assert.equal(t.edict, EDICT);
  assert.equal(t.questions, undefined);
  assert.ok(![...rt.approvals.values()].some((a) => a.kind === 'question'));
  assert.ok(zhongshu().every((c) => !c.lastUser.includes('太子请旨')));

  rt.updateSettings({ taiziAsk: true });
  const princeCalls = seen.filter((c) => c.system.includes('你是太子')).length;
  r = (await submit(rt, { text: EDICT, tier: 'lite', multiAgent: true, forceEdict: true })) as { taskId: string };
  await finished(rt, r.taskId);
  t = rt.tasks.get(r.taskId)!;
  assert.equal(t.state, 'Done', t.blockedReason);
  assert.equal(seen.filter((c) => c.system.includes('你是太子')).length, princeCalls, '直接下旨 skips triage');
  assert.ok(![...rt.approvals.values()].some((a) => a.kind === 'question'));
  rt.dispose();
  await mock.close();
});

test('太子追问 in 全自动: an unanswered question continues on the prince\'s assumption after the timeout', async () => {
  const { mock, zhongshu } = await court();
  const rt = makeRuntime(mock.url);
  prepare(rt);
  rt.updateSettings({ permissionMode: 'auto', askTimeoutMin: 0.002 });
  const r = (await submit(rt, { text: EDICT, tier: 'lite', multiAgent: true })) as { taskId: string };
  const ap = await pendingQuestion(rt);
  assert.match(ap.reason, /全自动模式/);
  await finished(rt, r.taskId);
  const t = rt.tasks.get(r.taskId)!;
  assert.equal(t.state, 'Done', t.blockedReason);
  assert.equal(rt.approvals.get(ap.id)!.status, 'approved');
  assert.equal(t.questions![0].how, 'timeout');
  assert.match(t.edict, /【皇上示下】（0.002 分钟未答复）照太子所拟：改用户前台的登录页$/);
  assert.ok(zhongshu().some((c) => c.lastUser.includes('照太子所拟：改用户前台的登录页')));
  assert.ok(rt.audit.list({ limit: 300 }).some((e) => e.action === 'ask_emperor_answered' && e.actor === 'system' && e.taskId === r.taskId));
  rt.dispose();
  await mock.close();
});

test('太子追问: cancelling while the question is open closes the card and the edict is not driven', async () => {
  const { mock, zhongshu } = await court();
  const rt = makeRuntime(mock.url);
  prepare(rt);
  const r = (await submit(rt, { text: EDICT, tier: 'lite', multiAgent: true })) as { taskId: string };
  const ap = await pendingQuestion(rt);
  rt.cancel(r.taskId);
  await settle();
  const t = rt.tasks.get(r.taskId)!;
  assert.equal(t.state, 'Cancelled');
  assert.equal(rt.approvals.get(ap.id)!.status, 'denied');
  assert.equal(t.questions![0].answeredAt, undefined);
  assert.equal(t.edict, EDICT);
  assert.equal(zhongshu().length, 0);
  assert.equal(rt.agents.get('taizi')!.status, 'idle');
  rt.dispose();
  await mock.close();
});

test('太子追问 across a restart: the unanswered question is asked again on resume, not skipped', async () => {
  const { mock, zhongshu } = await court();
  const dataDir = tmpDir('edict-data-');
  const rt = makeRuntime(mock.url, 'openai-chat', dataDir);
  const ws = prepare(rt);
  const r = (await submit(rt, { text: EDICT, tier: 'lite', multiAgent: true })) as { taskId: string };
  await pendingQuestion(rt);
  rt.flushAll(); // the app quits while the card is open
  const rt2 = makeRuntime(mock.url, 'openai-chat', dataDir);
  rt.dispose();
  prepare(rt2, ws);
  const t2 = rt2.tasks.get(r.taskId)!;
  assert.equal(t2.state, 'Taizi');
  assert.equal(t2.questions!.length, 1);
  assert.equal(t2.questions![0].answeredAt, undefined);
  assert.equal([...rt2.approvals.values()].length, 0, 'cards are not persisted');

  resumeAll(rt2);
  const ap = await pendingQuestion(rt2);
  assert.equal(ap.taskId, r.taskId);
  assert.equal(ap.summary, '太子请旨：父皇，要改哪个项目的登录页？');
  assert.ok(rt2.activities(r.taskId, 100).some((a) => a.content.startsWith('太子再次请旨')));
  await settle();
  assert.equal(stateOf(rt2, r.taskId), 'Taizi');
  assert.equal(zhongshu().length, 0);
  assert.equal(t2.questions!.length, 1, 'the same question, not a second one');

  rt2.decideApproval(ap.id, true, 'emperor', 'o1', '只改样式');
  await finished(rt2, r.taskId);
  assert.equal(stateOf(rt2, r.taskId), 'Done', t2.blockedReason);
  assert.match(t2.edict, /【皇上示下】用户前台（只改样式）$/);
  assert.ok(zhongshu().some((c) => c.lastUser.includes('【皇上示下】用户前台（只改样式）')));
  rt2.dispose();
  await mock.close();
});

test('courtAddress: 父皇 for the prince, 皇上 for officials, an existing address kept; used on ask_emperor cards', async () => {
  assert.equal(courtAddress('taizi', '要改哪个项目？'), '父皇，要改哪个项目？');
  assert.equal(courtAddress('bingbu', '臣对“兼容旧版”一句不甚明白：要支持到哪个版本？'), '皇上，臣对“兼容旧版”一句不甚明白：要支持到哪个版本？');
  assert.equal(courtAddress('menxia', '  陛下，臣有一问  '), '陛下，臣有一问');
  assert.equal(courtAddress('taizi', '皇上，要改哪个？'), '皇上，要改哪个？');
  assert.equal(courtAddress('xingbu', '父皇明鉴'), '父皇明鉴');

  const mock = await startMockLlm();
  const rt = makeRuntime(mock.url);
  rt.updateSettings({ askTimeoutMin: 0 });
  const t = { id: 'T-addr', title: 't', edict: 'x', nodes: [], changes: [], reviews: [], usage: {}, updatedAt: Date.now() } as unknown as Task;
  rt.tasks.set(t.id, t);
  const node = { id: 'n1', kind: 'exec', agentId: 'bingbu', label: '兵部 · 测试', status: 'running', attempts: 1 } as RunNode;
  const q = '臣对“兼容旧版”一句不甚明白：要支持到哪个版本？';
  const p = executeTool({ rt, agentId: 'bingbu', task: t, node }, 'ask_emperor', { question: q });
  const ap = await pendingQuestion(rt);
  assert.equal(ap.summary, `兵部请旨：皇上，${q}`);
  assert.ok(rt.activities(t.id, 50).some((a) => a.content === `兵部请旨：皇上，${q}`));
  rt.decideApproval(ap.id, true, 'emperor', 'free', '支持到 2.x');
  assert.match((await p).output, /皇上口谕：支持到 2.x/);
  rt.dispose();
  await mock.close();
});
