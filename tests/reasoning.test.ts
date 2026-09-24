// 思考程度 + error classification (unit) and fallback / model-switch retry (mock/integration).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clampLevel, presetFor, reasoningParams, STYLE_LEVELS } from '../src/shared/reasoning';
import { classifyLlmError, LlmHttpError } from '../src/main/llm/types';
import { startMockLlm } from './mockLlm';
import { makeRuntime, tmpDir, waitFor, stateOf } from './helpers';
import { submit, retryNodeWithModel } from '../src/main/runtime/orchestrator';

test('presets: model families map to their own ladders; unknown models send nothing', () => {
  const opus = presetFor('claude-opus-5-5', 'anthropic-messages');
  assert.equal(opus.style, 'anthropic');
  assert.deepEqual(opus.levels, STYLE_LEVELS.anthropic);
  assert.equal(opus.default, 'medium');
  assert.equal(presetFor('claude-sonnet-4-5', 'anthropic-messages').style, 'anthropic-budget');
  assert.equal(presetFor('gpt-5.2', 'openai-chat').style, 'openai');
  assert.deepEqual(presetFor('o3', 'openai-chat').levels, ['low', 'medium', 'high']);
  assert.equal(presetFor('qwen3-coder-plus', 'openai-chat').style, 'qwen');
  assert.equal(presetFor('glm-4.6', 'openai-chat').style, 'glm');
  assert.equal(presetFor('my-private-model', 'openai-chat').style, 'none');
});

test('slider semantics: right end = the model top level; ranks clamp onto shorter ladders', () => {
  const o3 = presetFor('o3', 'openai-chat');
  assert.equal(clampLevel(o3, 'top'), 'high'); // o3 has no xhigh/max/ultra → its own highest
  assert.equal(clampLevel(o3, 'max'), 'high');
  assert.equal(clampLevel(o3, 'ultra'), 'high');
  assert.equal(clampLevel(o3, 'default'), 'medium');
  const opus = presetFor('claude-opus-5-5', 'anthropic-messages');
  assert.equal(clampLevel(opus, 'top'), 'max');
  assert.equal(clampLevel(opus, 'minimal'), 'low');
  const custom = { style: 'custom' as const, levels: ['low', 'high', 'ultra'], default: 'high', custom: { low: { a: 1 }, high: { a: 2 }, ultra: { a: 3, b: { c: 1 } } } };
  assert.equal(clampLevel(custom, 'top'), 'ultra');
  assert.deepEqual(reasoningParams(custom, 'ultra', 'openai-chat').body, { a: 3, b: { c: 1 } });
  assert.equal(clampLevel({ style: 'none', levels: [], default: '' }, 'top'), undefined);
});

test('reasoning params per protocol', () => {
  const g = presetFor('gpt-5.2', 'openai-chat');
  assert.deepEqual(reasoningParams(g, 'high', 'openai-chat').body, { reasoning_effort: 'high' });
  assert.deepEqual(reasoningParams(g, 'high', 'openai-responses').body, { reasoning: { effort: 'high', summary: 'auto' } });
  const a = reasoningParams(presetFor('claude-opus-5-5', 'anthropic-messages'), 'max', 'anthropic-messages');
  assert.deepEqual(a.body, { output_config: { effort: 'max' } });
  assert.equal(a.minMaxTokens, 64000);
  const b = reasoningParams(presetFor('claude-sonnet-4-5', 'anthropic-messages'), 'medium', 'anthropic-messages');
  assert.deepEqual(b.body, { thinking: { type: 'enabled', budget_tokens: 8192 } });
  assert.equal(b.dropTemperature, true);
  assert.deepEqual(reasoningParams(presetFor('qwen3-max', 'openai-chat'), 'off', 'openai-chat').body, { enable_thinking: false });
});

test('error classification: relay 503 "分组不支持" is a config error and is NOT retried', () => {
  const relay = new LlmHttpError(503, '{"error":{"message":"当前分组暂不支持您请求的模型或接入方式，请尝试其他模型或联系管理员 (request id: x)","type":"new_api_error"}}', 'u');
  const c = classifyLlmError(relay);
  assert.equal(c.kind, 'config');
  assert.equal(c.retryable, false);
  assert.match(c.hint, /协议探测/);
  assert.equal(classifyLlmError(new LlmHttpError(400, '{"error":{"message":"Unrecognized request argument supplied: reasoning_effort"}}', 'u')).kind, 'param');
  assert.equal(classifyLlmError(new LlmHttpError(401, 'invalid api key', 'u')).kind, 'auth');
  assert.equal(classifyLlmError(new LlmHttpError(502, 'bad gateway', 'u')).retryable, true);
  assert.equal(classifyLlmError(new LlmHttpError(429, 'slow down', 'u')).kind, 'rate');
});

test('effort flows into the request body; unsupported reasoning params fall back once automatically (mock)', async () => {
  const mock = await startMockLlm({
    reject: (_c, body) => ('reasoning_effort' in body ? { status: 400, body: '{"error":{"message":"Unrecognized request argument supplied: reasoning_effort"}}' } : undefined),
  });
  const rt = makeRuntime(mock.url);
  // mark mock-strong as an OpenAI-style reasoning model
  const p = rt.providers[0];
  rt.upsertProvider({ ...p, models: p.models.map((m) => (m.id === 'mock-strong' ? { ...m, reasoning: { style: 'openai', levels: ['low', 'medium', 'high', 'xhigh'], default: 'medium' }, maxOutputTokens: 32000 } : m)) });
  assert.equal(rt.providers[0].models[0].reasoning?.style, 'openai', 'reasoning config survives save');
  rt.updateSettings({ routing: { strong: { providerId: 'mock', model: 'mock-strong' }, economy: { providerId: 'mock', model: 'mock-strong' } } });
  rt.setWorkspace(tmpDir('edict-ws-'));
  const r = (await submit(rt, { text: '写 solo.txt', tier: 'solo', multiAgent: false, effort: 'top' })) as { taskId: string };
  await waitFor(() => ['Done', 'Blocked'].includes(stateOf(rt, r.taskId)), 20000, 'solo done');
  const t = rt.tasks.get(r.taskId)!;
  assert.equal(t.state, 'Done', t.blockedReason);
  const first = mock.bodies[0];
  assert.equal(first.reasoning_effort, 'xhigh', 'slider top → model top level');
  assert.equal(first.max_tokens, undefined, 'reasoning models get max_completion_tokens');
  assert.equal(first.temperature, undefined, 'temperature dropped for reasoning');
  assert.ok(mock.bodies.slice(1).every((b) => !('reasoning_effort' in b)), 'after the param error no more reasoning params are sent');
  assert.ok(rt.noReasoning.has('mock/mock-strong'));
  assert.equal(t.nodes.find((n) => n.kind === 'solo')?.effort, 'xhigh');
  rt.dispose();
  await mock.close();
});

test('relay 503 fails fast (no blind retries) with an error card; 换模型重试 completes on another model (mock)', async () => {
  const mock = await startMockLlm({
    reject: (c) => (c.model === 'mock-strong' ? { status: 503, body: '{"error":{"message":"当前分组暂不支持您请求的模型或接入方式","type":"new_api_error"}}' } : undefined),
  });
  const rt = makeRuntime(mock.url);
  rt.updateSettings({ routing: { strong: { providerId: 'mock', model: 'mock-strong' }, economy: { providerId: 'mock', model: 'mock-economy' } } });
  rt.setWorkspace(tmpDir('edict-ws-'));
  const r = (await submit(rt, { text: '写 solo.txt', tier: 'solo', multiAgent: false })) as { taskId: string };
  await waitFor(() => stateOf(rt, r.taskId) === 'Blocked', 20000, 'blocked');
  const t = rt.tasks.get(r.taskId)!;
  const n = t.nodes.find((x) => x.status === 'failed')!;
  assert.equal(n.errorInfo?.kind, 'config');
  assert.equal(n.errorInfo?.status, 503);
  assert.equal(n.errorInfo?.model, 'mock-strong');
  assert.equal(mock.calls.filter((c) => c.model === 'mock-strong').length, 1, 'config errors are not retried');
  retryNodeWithModel(rt, r.taskId, n.id, { providerId: 'mock', model: 'mock-economy' });
  await waitFor(() => stateOf(rt, r.taskId) === 'Done', 20000, 'done after switching model');
  assert.equal(n.model, 'mock-economy');
  assert.equal(t.strongModel?.model, 'mock-economy');
  rt.dispose();
  await mock.close();
});

test('protocol probe reports which protocol works, with and without reasoning (mock)', async () => {
  const mock = await startMockLlm({
    reject: (c, body) => (c.protocol === 'openai-responses' ? { status: 503, body: '{"error":{"message":"当前分组暂不支持您请求的模型或接入方式"}}' } : body.output_config ? { status: 400, body: '{"error":{"message":"output_config: Extra inputs are not permitted"}}' } : undefined),
  });
  const rt = makeRuntime(mock.url);
  const p = rt.providers[0];
  rt.upsertProvider({ ...p, models: p.models.map((m) => ({ ...m, reasoning: { style: 'anthropic', levels: ['low', 'high'], default: 'high' } })) });
  const rows = await rt.probeProvider('mock', 'mock-strong');
  const by = Object.fromEntries(rows.map((r) => [r.protocol, r]));
  assert.equal(by['openai-responses'].plain.ok, false);
  assert.equal(by['openai-responses'].plain.kind, 'config');
  assert.equal(by['anthropic-messages'].plain.ok, true);
  assert.equal(by['anthropic-messages'].reasoning.ok, false);
  assert.equal(by['anthropic-messages'].reasoning.kind, 'param');
  assert.equal(by['openai-chat'].plain.ok, true);
  rt.dispose();
  await mock.close();
});
