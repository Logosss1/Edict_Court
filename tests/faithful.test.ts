// 忠于旨意: word counts are targets unless the edict sets a floor, paperwork is never a deliverable, writing
// edicts get their own rules, and an edict that invites questions gets the prince's question. unit + mock/integration.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { approxRange, faithBlock, invitesQuestions, isWriting, quantities } from '../src/main/runtime/faithful';
import { REQUIREMENTS_PROMPT } from '../src/main/runtime/requirements';
import { startMockLlm, defaultBrain, type MockCall } from './mockLlm';
import { makeRuntime, tmpDir, waitFor, stateOf } from './helpers';
import { submit } from '../src/main/runtime/orchestrator';

test('quantities: 万/千/digits/Chinese numerals; floors only with 至少/不少于/以上', () => {
  assert.deepEqual(quantities('帮我写一篇1万字的小说'), [{ text: '1万字', n: 10000, unit: '字', floor: false }]);
  assert.deepEqual(quantities('写约3000字的文章').map((q) => [q.n, q.floor]), [[3000, false]]);
  assert.deepEqual(quantities('不少于五千字').map((q) => [q.n, q.floor]), [[5000, true]]);
  assert.deepEqual(quantities('两万字以上').map((q) => [q.n, q.floor]), [[20000, true]]);
  assert.deepEqual(quantities('一万五千字左右').map((q) => [q.n, q.floor]), [[15000, false]]);
  assert.deepEqual(quantities('1.5万字').map((q) => q.n), [15000]);
  assert.deepEqual(quantities('标题不超过三个字'), []);
  assert.deepEqual(quantities('修复登录 bug'), []);
  assert.deepEqual(approxRange(10000), [8500, 11500]);
});

test('isWriting / invitesQuestions', () => {
  assert.ok(isWriting('帮我写一篇1万字的黄文，内容和格式参照网文'));
  assert.ok(isWriting('写一个关于猫的短篇故事'));
  assert.ok(!isWriting('给登录页写 README 和 API 文档'));
  assert.ok(!isWriting('修复 search.py 的报错'));
  assert.ok(invitesQuestions('那个题材内容你不清楚的话，可以向我问清楚后再开始创作。'));
  assert.ok(invitesQuestions('有不清楚的先问我'));
  assert.ok(invitesQuestions('先确认需求再动手'));
  assert.ok(!invitesQuestions('把登录页改一下'));
  assert.ok(!invitesQuestions('写一个问答页面'));
});

test('faithBlock: approximate count, floor, writing rules only for writing edicts', () => {
  const story = faithBlock({ edict: '帮我写一篇1万字的小说' });
  assert.match(story, /【忠于旨意】/);
  assert.match(story, /「1万字」是约数：8500~11500 字都算达标/);
  assert.match(story, /【写作类旨意】/);
  assert.match(story, /按章分次写/);
  assert.match(faithBlock({ edict: '写不少于5000字的散文' }), /这是下限，5000 字以上即达标/);
  const code = faithBlock({ edict: '修复 search.py 的报错' });
  assert.match(code, /流程文书/);
  assert.doesNotMatch(code, /写作类|约数/);
  assert.match(REQUIREMENTS_PROMPT, /R1 写旨意的核心要求/);
});

const STORY = '帮我写一篇一万字的小说。题材你不清楚的话，可以向我问清楚后再开始创作。';
const ASKED = { type: 'ask', questions: [{ title: '这篇小说重点写什么？', options: ['情节', '人物'], recommend: '情节' }] };

/** 中书省 first judges the story clear (纪要 at once); asked again because the edict invites questions, it asks. */
async function court(askOnRetry: boolean) {
  const seen: MockCall[] = [];
  const base = defaultBrain({});
  const mock = await startMockLlm({
    brain: (c) => {
      seen.push(c);
      if (c.lastUser.includes('皇上明说了可以问，请至少问一个')) return { text: JSON.stringify(askOnRetry ? ASKED : { type: 'done', minutes: '- 照旨意写' }) };
      if (c.lastUser.includes('【细问】')) {
        if (c.tools.length && c.toolResults === 0) return { toolCalls: [{ name: 'list_dir', args: { path: '.' } }] };
        if (c.lastUser.includes('【已经问过的】')) return { text: JSON.stringify({ type: 'done', minutes: '- 重点写情节' }) };
        return { text: JSON.stringify({ type: 'done', minutes: '- 题材明确，照旨意写' }) };
      }
      if (c.system.includes('你是太子')) return { text: '{"type":"edict","title":"创作万字小说","reason":"题材明确"}' };
      return base(c);
    },
  });
  return { mock, seen };
}

test('an edict that invites questions gets 中书省\'s 细问 even with 细问 off, and round 1 must ask', async () => {
  const { mock, seen } = await court(true);
  const rt = makeRuntime(mock.url); // 细问 switched off (tests/helpers)
  rt.updateSettings({ finalGate: false, askTimeoutMin: 0 });
  rt.setWorkspace(tmpDir('edict-ws-'));
  const r = (await submit(rt, { text: STORY, tier: 'lite', multiAgent: true })) as { taskId: string };
  const ap = await waitFor(() => [...rt.approvals.values()].find((a) => a.status === 'pending' && a.kind === 'grill'), 5000, 'grill card');
  assert.equal(ap.summary, '中书省细问（第 1 轮）：1 个问题');
  assert.equal(stateOf(rt, r.taskId), 'Zhongshu');
  assert.equal(seen.filter((c) => c.system.includes('你是太子')).length, 1, 'the prince sorts once and never asks');
  assert.ok(seen.some((c) => c.lastUser.includes('【细问】') && c.lastUser.includes('这一轮至少问一个问题')));
  assert.ok(seen.some((c) => c.lastUser.includes('皇上明说了可以问，请至少问一个')), 'a 纪要 straight away is sent back once');
  rt.decideApproval(ap.id, true, 'emperor', 'answer');
  const m = await waitFor(() => [...rt.approvals.values()].find((a) => a.status === 'pending' && a.kind === 'grill' && a.grill?.phase === 'minutes'), 8000, 'minutes card');
  rt.decideApproval(m.id, true, 'emperor', 'ok');
  await waitFor(() => seen.some((c) => c.system.includes('你是中书省') && c.lastUser.includes('请输出方案 JSON')), 10000, 'planning');
  const plan = seen.find((c) => c.system.includes('你是中书省') && c.lastUser.includes('请输出方案 JSON'))!;
  assert.match(plan.lastUser, /【细问纪要】[\s\S]*重点写情节/);
  assert.match(plan.lastUser, /【忠于旨意】[\s\S]*约数：8500~11500 字[\s\S]*【写作类旨意】/);
  assert.equal(rt.tasks.get(r.taskId)!.grill!.questions[0].answer, '情节', '答复 without a change: the recommendation');
  rt.dispose();
  await mock.close();
});

test('if 中书省 still asks nothing, its 纪要 goes to the emperor; no 细问 at all without an invitation while it is off', async () => {
  const { mock, seen } = await court(false);
  const rt = makeRuntime(mock.url);
  rt.updateSettings({ finalGate: false, askTimeoutMin: 0 });
  rt.setWorkspace(tmpDir('edict-ws-'));
  await submit(rt, { text: STORY, tier: 'lite', multiAgent: true });
  const m = await waitFor(() => [...rt.approvals.values()].find((a) => a.status === 'pending' && a.kind === 'grill'), 8000, 'minutes card');
  assert.equal(m.grill!.phase, 'minutes');
  rt.decideApproval(m.id, true, 'emperor', 'ok');
  await waitFor(() => seen.some((c) => c.system.includes('你是中书省') && c.lastUser.includes('请输出方案 JSON')), 10000, 'planning');
  const before = seen.filter((c) => c.lastUser.includes('【细问】')).length;
  const r2 = (await submit(rt, { text: '实现 greet 函数', tier: 'lite', multiAgent: true })) as { taskId: string };
  await waitFor(() => ['Done', 'Blocked'].includes(stateOf(rt, r2.taskId)), 20000, 'second edict');
  assert.equal(seen.filter((c) => c.lastUser.includes('【细问】')).length, before);
  assert.equal(rt.tasks.get(r2.taskId)!.grill, undefined);
  rt.dispose();
  await mock.close();
});
