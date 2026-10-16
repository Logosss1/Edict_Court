// 查看原因: each block cause gets a plain explanation and fixes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { explainBlock } from '../src/shared/blocked';
import type { RunNode, Task } from '../src/shared/types';

const node = (p: Partial<RunNode>): RunNode => ({ id: 'n1', kind: 'exec', agentId: 'libu', label: '礼部·写稿', status: 'failed', attempts: 1, ...p }) as RunNode;
const task = (nodes: RunNode[], blockedReason?: string) => ({ id: 't', title: '写稿', nodes, blockedReason }) as unknown as Task;

test('node timeout points at the time limit setting', () => {
  const r = explainBlock(task([node({ error: '超过单节点时限 30 分钟，已终止。可局部重试，或在「设置」里调整时限' })], '礼部·写稿 执行失败；1 个子任务因依赖未完成而未启动。可对节点「局部重试」'));
  assert.equal(r.causes.length, 2);
  assert.match(r.causes[0].title, /30 分钟/);
  assert.equal(r.causes[0].action?.id, 'settings:permissions');
  assert.match(r.causes[1].title, /1 个子任务在等/);
});

test('model errors explain by kind; no failed node falls back to 继续', () => {
  const r = explainBlock(task([node({ error: 'x', errorInfo: { kind: 'network', hint: '连不上', raw: '' } })]));
  assert.match(r.causes[0].title, /连不上模型服务/);
  const r2 = explainBlock(task([node({ status: 'done' })], '工作区不存在'));
  assert.equal(r2.causes[0].title, '工作区不存在');
  assert.equal(r2.causes[0].action?.id, 'unblock');
});
