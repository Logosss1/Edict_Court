// The prince no longer asks at triage (细问 by the planning official replaced 太子追问, tests/grill.test.ts); an
// older edict still waiting on his question is asked again and goes on. 请旨 phrasing (courtAddress) for the
// prince and the officials. mock/integration.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startMockLlm, defaultBrain, type MockCall } from './mockLlm';
import { makeRuntime, tmpDir, waitFor, stateOf } from './helpers';
import { submit, resumeAll, createTask } from '../src/main/runtime/orchestrator';
import { parsePrinceAsk } from '../src/main/runtime/askEmperor';
import { executeTool } from '../src/main/runtime/tools';
import type { Runtime } from '../src/main/runtime/runtime';
import { courtAddress } from '../src/shared/court';
import type { RunNode, Task } from '../src/shared/types';

const EDICT = '把登录页改一下';
const ASK = { type: 'ask', title: '修改登录页', question: '要改哪个项目的登录页？', options: ['后台管理', '用户前台'], assume: '改用户前台的登录页', reason: '工作区里有两个登录页' };

/** Mock court whose prince still replies with an ask about EDICT (as an older prompt would); records every call. */
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

test('the prince only sorts: even an ask-shaped triage reply is filed as an edict and goes straight on', async () => {
  const { mock, seen, zhongshu } = await court();
  const rt = makeRuntime(mock.url);
  prepare(rt);
  const r = (await submit(rt, { text: EDICT, tier: 'lite', multiAgent: true })) as { taskId: string };
  await finished(rt, r.taskId);
  const t = rt.tasks.get(r.taskId)!;
  assert.equal(t.state, 'Done', t.blockedReason);
  assert.equal(t.title, '修改登录页');
  assert.equal(t.edict, EDICT);
  assert.equal(t.questions, undefined);
  assert.ok(![...rt.approvals.values()].some((a) => a.kind === 'question'));
  assert.equal(seen.filter((c) => c.system.includes('你是太子')).length, 1, 'one triage call, no follow-up question');
  assert.ok(zhongshu().every((c) => !c.lastUser.includes('太子请旨')));
  assert.match(seen.find((c) => c.system.includes('你是太子'))!.system, /中书省规划前会向皇上细问/);
  rt.dispose();
  await mock.close();
});

test('an older edict still waiting on the prince\'s question: asked again after a restart, the answer reaches 中书省', async () => {
  const { mock, zhongshu } = await court();
  const dataDir = tmpDir('edict-data-');
  const rt = makeRuntime(mock.url, 'openai-chat', dataDir);
  const ws = prepare(rt);
  const t = createTask(rt, { text: EDICT, tier: 'lite', title: '修改登录页', model: null });
  t.nodes.push({ id: 'triage', kind: 'triage', agentId: 'taizi', label: '太子分拣', status: 'done', attempts: 1, output: JSON.stringify(ASK) });
  rt.transition(t, 'Taizi', 'taizi', '太子接旨分拣');
  t.questions = [{ id: 'q-old', agentId: 'taizi', nodeId: 'triage', question: ASK.question, options: ASK.options, assume: ASK.assume, at: Date.now() }];
  rt.touch(t);
  rt.flushAll();
  const rt2 = makeRuntime(mock.url, 'openai-chat', dataDir);
  rt.dispose();
  prepare(rt2, ws);
  resumeAll(rt2);
  const ap = await pendingQuestion(rt2);
  assert.equal(ap.summary, '太子请旨：父皇，要改哪个项目的登录页？');
  assert.ok(rt2.activities(t.id, 100).some((a) => a.content.startsWith('太子再次请旨')));
  await settle();
  assert.equal(stateOf(rt2, t.id), 'Taizi');
  assert.equal(zhongshu().length, 0);
  rt2.decideApproval(ap.id, true, 'emperor', 'o1', '只改样式');
  await finished(rt2, t.id);
  const t2 = rt2.tasks.get(t.id)!;
  assert.equal(t2.state, 'Done', t2.blockedReason);
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
