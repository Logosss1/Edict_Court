// 口谕: words given while an edict runs reach the next official at work and every later prompt that quotes the edict.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startMockLlm } from './mockLlm';
import { makeRuntime, tmpDir, waitFor, stateOf } from './helpers';
import { submit } from '../src/main/runtime/orchestrator';
import { edictBlock, giveOralOrder } from '../src/main/runtime/oral';

test('口谕 reaches the officials and the later prompts; finished edicts refuse it', async () => {
  const mock = await startMockLlm();
  const rt = makeRuntime(mock.url);
  rt.setWorkspace(tmpDir('edict-ws-'));
  const r = (await submit(rt, { text: '写一个 greet 函数并测试', tier: 'lite', multiAgent: true })) as { taskId: string };
  const res = giveOralOrder(rt, r.taskId, '不用写测试文件，函数写好就收尾');
  const t = rt.tasks.get(r.taskId)!;
  assert.equal(t.orals?.length, 1);
  assert.match(edictBlock(t, 2000), /【皇上口谕】[\s\S]*不用写测试文件/);
  assert.ok(Array.isArray(res.to));
  await waitFor(() => t.gate?.kind === 'final' || stateOf(rt, r.taskId) === 'Done', 30000, 'final');
  const ann = rt.annotations.find((a) => a.oral && a.taskId === r.taskId)!;
  assert.ok(ann.consumedAt && ann.response, 'an official read and answered the 口谕');
  const sent = JSON.stringify(mock.bodies);
  assert.match(sent, /【皇上口谕】/);
  assert.ok(mock.bodies.filter((b) => JSON.stringify(b).includes('不用写测试文件')).length >= 2, 'quoted in the agent turn and in later prompts');
  rt.cancel(r.taskId, '测试结束');
  assert.throws(() => giveOralOrder(rt, r.taskId, '再改改'), /已经结束/);
  rt.dispose();
  await mock.close();
});
