// 固定六档：the same six levels everywhere, mapped per model onto its own API level names.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { availableTiers, clampLevel, defaultTier, presetFor, resolveTier, tierHint, tierLabel, tierMap } from '../src/shared/reasoning';
import type { ReasoningConfig } from '../src/shared/types';

const fourLevels: ReasoningConfig = { style: 'openai', levels: ['none', 'low', 'medium', 'xhigh'], default: 'medium', detected: { at: 1, reliable: true, accepted: ['none', 'low', 'medium', 'xhigh'], rejected: ['minimal', 'high', 'max', 'ultra'] } };

test('a model with four of the six, High and Max greyed', () => {
  assert.deepEqual(tierMap(fourLevels), { none: 'none', low: 'low', medium: 'medium', xhigh: 'xhigh' });
  assert.deepEqual(availableTiers(fourLevels), ['none', 'low', 'medium', 'xhigh']);
  assert.equal(defaultTier(fourLevels), 'medium');
  assert.match(tierHint(fourLevels), /此模型没有：High、Max/);
  // a saved High (from another model) lands on the nearest lower level this model has
  assert.equal(clampLevel(fourLevels, 'high'), 'medium');
  assert.equal(clampLevel(fourLevels, 'max'), 'xhigh');
  assert.equal(clampLevel(fourLevels, 'top'), 'xhigh');
  assert.equal(clampLevel(fourLevels, 'default'), 'medium');
  assert.equal(clampLevel(fourLevels, 'none'), 'none');
});

test('GPT ladder without none: minimal stands in for 无思考 and the hint says so', () => {
  const gpt6 = presetFor('gpt-6.1-sol', 'openai-chat');
  const m = tierMap(gpt6);
  assert.equal(m.none, 'minimal');
  assert.equal(m.low, 'low');
  assert.equal(m.max, 'max');
  assert.match(tierHint(gpt6), /无思考 → minimal（最低一档，不是完全关闭）/);
  // a model with none AND minimal keeps none for 无思考, low for 轻度
  const gpt5 = presetFor('gpt-5.2', 'openai-chat');
  assert.equal(tierMap(gpt5).none, 'none');
  assert.equal(tierMap(gpt5).low, 'low');
});

test('Claude: no 无思考; Qwen preset off/…/max; GLM off/on', () => {
  const opus = presetFor('claude-opus-5-5', 'anthropic-messages');
  assert.deepEqual(availableTiers(opus), ['low', 'medium', 'high', 'xhigh', 'max']);
  const q = presetFor('qwen3-coder-plus', 'openai-chat');
  assert.deepEqual(tierMap(q), { none: 'off', low: 'low', medium: 'medium', high: 'high', max: 'max' });
  const glm = presetFor('glm-4.6', 'openai-chat');
  assert.deepEqual(tierMap(glm), { none: 'off', medium: 'on' });
  assert.equal(clampLevel(glm, 'high'), 'on');
});

test('old saved values still work; hand-set mapping wins', () => {
  const gpt6 = presetFor('gpt-6.1-sol', 'openai-chat');
  assert.equal(clampLevel(gpt6, 'minimal'), 'minimal'); // the model's own API name, saved before
  assert.equal(resolveTier(gpt6, 'ultra'), 'max');
  assert.equal(tierLabel('off'), '无思考');
  assert.equal(tierLabel('medium'), '中度');
  assert.equal(tierLabel('top'), '最高一档');
  const hand: ReasoningConfig = { ...fourLevels, tierMap: { high: 'xhigh', xhigh: 'xhigh', none: 'none' } };
  assert.deepEqual(availableTiers(hand), ['none', 'high', 'xhigh']);
  assert.equal(clampLevel(hand, 'high'), 'xhigh');
  // custom names land on free slots in order
  const custom: ReasoningConfig = { style: 'custom', levels: ['fast', 'deep'], default: 'fast', custom: { fast: {}, deep: {} } };
  assert.equal(availableTiers(custom).length, 2);
  assert.equal(clampLevel(custom, 'default'), 'fast');
  // no levels → nothing
  assert.deepEqual(availableTiers({ style: 'none', levels: [], default: '' }), []);
});
