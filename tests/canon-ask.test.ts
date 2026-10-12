// Edict 2.0 · E1 请旨 (ask_emperor) and E2 项目规约 / 典章 (canon) injection.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startMockLlm, defaultBrain, type MockCall } from './mockLlm';
import { makeRuntime, tmpDir, waitFor, stateOf } from './helpers';
import { submit } from '../src/main/runtime/orchestrator';
import { addCanon, canonBlock, canonFromReview, projectRules, removeCanon, selectCanon, updateCanon } from '../src/main/runtime/canon';
import { executeTool } from '../src/main/runtime/tools';
import { buildMemorial } from '../src/main/runtime/runtime';
import { Workspace } from '../src/main/services/workspace';
import type { RunNode, Task } from '../src/shared/types';

test('project rule files: AGENTS.md, CLAUDE.md and .edict/rules.md are read within budget', () => {
  const dir = tmpDir('edict-ws-');
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# 约定\n所有函数都要写 JSDoc。\n');
  fs.mkdirSync(path.join(dir, '.edict'));
  fs.writeFileSync(path.join(dir, '.edict/rules.md'), '提交前必须跑 npm test。\n' + 'x'.repeat(9000));
  const r = projectRules(new Workspace(dir));
  assert.deepEqual(r.files, ['AGENTS.md', '.edict/rules.md']);
  assert.match(r.text, /JSDoc/);
  assert.match(r.text, /npm test/);
  assert.ok(r.text.length < 4300, 'budget respected');
  assert.deepEqual(projectRules(new Workspace(tmpDir('edict-ws-'))).files, []);
});

test('canon selection: 禁止 always, keywords match the edict, workspace scope, disabled entries skipped', async () => {
  const mock = await startMockLlm();
  const rt = makeRuntime(mock.url);
  const ws = tmpDir('edict-ws-');
  rt.setWorkspace(ws);
  const forbid = addCanon(rt, { kind: 'forbid', text: '不要改动 migrations 目录', keywords: ['数据库'] });
  const pref = addCanon(rt, { kind: 'preference', text: '前端一律用 TypeScript', keywords: '前端，页面' });
  const all = addCanon(rt, { kind: 'rule', text: '回奏用中文' });
  const other = addCanon(rt, { kind: 'rule', text: '只在别的项目里适用', root: '/somewhere/else' });
  const lesson = addCanon(rt, { kind: 'lesson', text: '上次忘了更新 README', keywords: ['文档'] });
  assert.deepEqual(pref.keywords, ['前端', '页面']);
  const t = { id: 'T1', title: '做一个登录页面', edict: '用 React 写', workspace: ws } as unknown as Task;
  const ids = selectCanon(rt, t).map((c) => c.id);
  assert.deepEqual(ids, [forbid.id, all.id, pref.id], 'order 禁止 → 规矩 → 偏好; no lesson (keyword missing), no other-root entry');
  assert.ok(!ids.includes(other.id) && !ids.includes(lesson.id));
  updateCanon(rt, pref.id, { enabled: false });
  assert.ok(!selectCanon(rt, t).some((c) => c.id === pref.id));
  removeCanon(rt, all.id);
  assert.ok(!rt.settings.canon.some((c) => c.id === all.id));
  assert.throws(() => addCanon(rt, { text: '  ' }), /不能为空/);
  rt.dispose();
  await mock.close();
});

test('planning, review and execution prompts carry the rule files and the canon; 封驳 can be collected as a lesson', async () => {
  const seen: MockCall[] = [];
  const base = defaultBrain({ rejectPlanTimes: 1 });
  const mock = await startMockLlm({ brain: (c) => (seen.push(c), base(c)) });
  const rt = makeRuntime(mock.url);
  rt.updateSettings({ finalGate: false });
  const ws = tmpDir('edict-ws-');
  fs.writeFileSync(path.join(ws, 'CLAUDE.md'), '本项目缩进用 4 个空格。\n');
  rt.setWorkspace(ws);
  addCanon(rt, { kind: 'forbid', text: '禁止使用 eval' });
  const r = (await submit(rt, { text: '写一个 greet 函数并测试', tier: 'lite', multiAgent: true })) as { taskId: string };
  await waitFor(() => ['Done', 'Blocked'].includes(stateOf(rt, r.taskId)), 25000, 'done');
  const t = rt.tasks.get(r.taskId)!;
  const withCanon = (who: string) => seen.filter((c) => c.system.includes(who)).some((c) => c.lastUser.includes('禁止使用 eval') || (c as unknown as { messages: { content: string }[] }).messages?.some((m) => m.content.includes('禁止使用 eval')));
  assert.ok(withCanon('你是中书省'), 'plan prompt has the canon');
  assert.ok(withCanon('你是门下省'), 'review prompt has the canon');
  assert.ok(seen.some((c) => (c as unknown as { messages: { content: string }[] }).messages?.some((m) => m.content.includes('4 个空格'))), 'CLAUDE.md reached the officials');
  assert.equal(t.canonUsed?.length, 1);
  // the first plan was rejected by 门下 → collect it into the canon for this workspace
  const idx = t.reviews.findIndex((x) => x.verdict === 'reject');
  assert.ok(idx >= 0);
  const lesson = canonFromReview(rt, t.id, idx);
  assert.equal(lesson.kind, 'lesson');
  assert.equal(lesson.root, rt.permRoot(t));
  assert.match(lesson.text, /验收/);
  assert.throws(() => canonFromReview(rt, t.id, t.reviews.findIndex((x) => x.verdict === 'approve')), /只有封驳/);
  assert.match(canonBlock(rt, t, rt.workspace), /\[教训\]/);
  rt.dispose();
  await mock.close();
});

function fakeNode(id = 'n1'): RunNode {
  return { id, kind: 'exec', agentId: 'bingbu', label: '兵部 · 测试', status: 'running', attempts: 1 } as RunNode;
}

test('ask_emperor: options, free answer, let-them-decide; recorded on the edict and the memorial', async () => {
  const mock = await startMockLlm();
  const rt = makeRuntime(mock.url);
  rt.updateSettings({ permissionMode: 'ask' });
  rt.setWorkspace(tmpDir('edict-ws-'));
  const t = { id: 'T-ask', title: '问题测试', edict: 'x', tier: 'lite', state: 'Doing', nodes: [], changes: [], reviews: [], planHistory: [], flow: [], usage: {}, createdAt: Date.now(), updatedAt: Date.now(), lastActivityAt: Date.now(), workspace: rt.workspace!.root } as unknown as Task;
  rt.tasks.set(t.id, t);
  const node = fakeNode();
  const ask = (args: Record<string, unknown>) => executeTool({ rt, agentId: 'bingbu', task: t, node }, 'ask_emperor', args);
  const pending = () => waitFor(() => [...rt.approvals.values()].find((a) => a.status === 'pending' && a.kind === 'question'), 3000, 'question card');

  let p = ask({ question: '登录失败提示放在哪里？', options: ['输入框下方', '页面顶部'], default: '输入框下方' });
  let ap = await pending();
  assert.deepEqual(ap.choices!.map((c) => c.id), ['o0', 'o1', 'free', 'self']);
  rt.decideApproval(ap.id, true, 'emperor', 'o1', '红色字');
  let r = await p;
  assert.equal(r.ok, true);
  assert.match(r.output, /皇上选择：页面顶部\n皇上批示：红色字/);

  p = ask({ question: '要不要支持第三方登录？' });
  ap = await pending();
  assert.deepEqual(ap.choices!.map((c) => c.id), ['free', 'self']);
  assert.throws(() => rt.decideApproval(ap.id, true, 'emperor', 'free'), /写明/);
  rt.decideApproval(ap.id, true, 'emperor', 'free', '先不做');
  r = await p;
  assert.match(r.output, /皇上口谕：先不做/);

  p = ask({ question: '按钮用什么颜色？', default: '主题色' });
  ap = await pending();
  rt.decideApproval(ap.id, true, 'emperor', 'self');
  r = await p;
  assert.match(r.output, /自己判断[\s\S]*主题色/);

  assert.equal(t.questions?.length, 3);
  assert.deepEqual(t.questions!.map((q) => q.how), ['option', 'free', 'self']);
  // per-subtask cap
  r = await ask({ question: '第四个问题' });
  assert.equal(r.ok, false);
  assert.match(r.output, /不能再问/);
  const m = buildMemorial(t);
  assert.ok(m.stages.some((s) => s.key === 'questions' && s.items.some((i) => i.includes('页面顶部'))));
  assert.ok(rt.audit.list({ limit: 50 }).some((e) => e.action === 'ask_emperor_answered'));
  rt.dispose();
  await mock.close();
});

test('ask_emperor in 全自动: unanswered questions continue on the default after the timeout', async () => {
  const mock = await startMockLlm();
  const rt = makeRuntime(mock.url);
  rt.updateSettings({ permissionMode: 'auto', askTimeoutMin: 0.002 });
  const t = { id: 'T-auto', title: 't', edict: 'x', nodes: [], changes: [], reviews: [], usage: {}, updatedAt: Date.now() } as unknown as Task;
  rt.tasks.set(t.id, t);
  const r = await executeTool({ rt, agentId: 'gongbu', task: t, node: fakeNode('n2') }, 'ask_emperor', { question: '部署到哪个环境？', options: ['staging', 'prod'], default: 'staging' });
  assert.equal(r.ok, true);
  assert.match(r.output, /未答复[\s\S]*staging/);
  assert.equal(t.questions![0].how, 'timeout');
  assert.equal([...rt.approvals.values()].find((a) => a.kind === 'question')!.status, 'approved');
  rt.dispose();
  await mock.close();
});
