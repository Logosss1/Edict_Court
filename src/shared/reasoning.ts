// 思考程度（reasoning effort）— one slider in the UI, translated per protocol / model family.
// OpenAI:     Chat `reasoning_effort` · Responses `reasoning.effort`   (none · minimal · low · medium · high · xhigh · max)
// Anthropic:  `output_config.effort`                                   (low · medium · high · xhigh · max)
//             older extended-thinking models: `thinking.budget_tokens`
// Qwen:       `enable_thinking` + `thinking_budget`;  GLM: `thinking.type`
// custom:     any JSON merged into the body per level (for relays / private models, e.g. an `ultra` level)
import type { Protocol, ReasoningConfig, ReasoningStyle } from './types';

export const LEVEL_LABEL: Record<string, string> = {
  none: '关', off: '关', minimal: '极低', low: '低', medium: '中', high: '高', xhigh: '超高', max: '最高', ultra: 'Ultra', on: '开',
};
export const levelLabel = (l: string) => LEVEL_LABEL[l] ?? l;

export const STYLE_LABEL: Record<ReasoningStyle, string> = {
  none: '不发送思考参数',
  openai: 'OpenAI（reasoning_effort / reasoning.effort）',
  anthropic: 'Claude（output_config.effort）',
  'anthropic-budget': 'Claude 旧版（thinking.budget_tokens）',
  qwen: 'Qwen（enable_thinking + thinking_budget）',
  glm: 'GLM（thinking.type）',
  custom: '自定义 JSON（中转站 / 私有模型）',
};

export const STYLE_LEVELS: Record<ReasoningStyle, string[]> = {
  none: [],
  openai: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
  anthropic: ['low', 'medium', 'high', 'xhigh', 'max'],
  'anthropic-budget': ['off', 'low', 'medium', 'high', 'max'],
  qwen: ['off', 'low', 'medium', 'high', 'max'],
  glm: ['off', 'on'],
  custom: ['low', 'medium', 'high', 'ultra'],
};

const DEFAULT_BUDGETS: Record<string, number> = { minimal: 512, low: 2048, medium: 8192, high: 16384, xhigh: 32000, max: 32000, ultra: 64000, on: 8192 };

/** Best-effort preset from the model id. Unknown models get `none` (safest for relays). */
export function presetFor(modelId: string, protocol: Protocol): ReasoningConfig {
  const id = modelId.toLowerCase();
  if (/claude|opus|sonnet|haiku|fable|mythos/.test(id)) {
    if (/claude-(3|opus-4-[01]|sonnet-4-[0-5]|haiku)/.test(id)) return { style: 'anthropic-budget', levels: STYLE_LEVELS['anthropic-budget'], default: 'off' };
    const levels = /opus-4-6|sonnet-4-6/.test(id) ? ['low', 'medium', 'high', 'max'] : STYLE_LEVELS.anthropic;
    return { style: 'anthropic', levels, default: /opus-5-5/.test(id) ? 'medium' : 'high' };
  }
  if (/^(o[1-9]|gpt-5|gpt-6|codex)/.test(id) || /\/(o[1-9]|gpt-5|gpt-6)/.test(id)) {
    const levels = /gpt-6/.test(id) ? ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] : /^o[1-9]/.test(id) ? ['low', 'medium', 'high'] : ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'];
    return { style: 'openai', levels, default: 'medium' };
  }
  if (/qwen3|qwq|qwen-plus|qwen-max|qwen-turbo/.test(id)) return { style: 'qwen', levels: STYLE_LEVELS.qwen, default: 'off' };
  if (/glm-(4\.[5-9]|[5-9])/.test(id)) return { style: 'glm', levels: STYLE_LEVELS.glm, default: 'on' };
  void protocol;
  return { style: 'none', levels: [], default: '' };
}

export function effectiveConfig(cfg: ReasoningConfig | undefined, modelId: string, protocol: Protocol): ReasoningConfig {
  return cfg ?? presetFor(modelId, protocol);
}

/** Clamp any requested level onto the model's own ladder (by rank), so the slider's top is always the model's top. */
export function clampLevel(cfg: ReasoningConfig, level: string | undefined): string | undefined {
  if (!cfg.levels.length) return undefined;
  if (!level || level === 'default') return cfg.default || cfg.levels[Math.floor(cfg.levels.length / 2)];
  if (level === 'top') return cfg.levels[cfg.levels.length - 1];
  if (cfg.levels.includes(level)) return level;
  const rank = ['none', 'off', 'minimal', 'low', 'medium', 'on', 'high', 'xhigh', 'max', 'ultra'];
  const want = rank.indexOf(level);
  if (want < 0) return cfg.default;
  let best = cfg.levels[0];
  for (const l of cfg.levels) if (rank.indexOf(l) <= want) best = l;
  return best;
}

function deepMerge(a: Record<string, unknown>, b: Record<string, unknown>) {
  const out: Record<string, unknown> = { ...a };
  for (const [k, v] of Object.entries(b)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object') out[k] = deepMerge(out[k] as Record<string, unknown>, v as Record<string, unknown>);
    else out[k] = v;
  }
  return out;
}
export { deepMerge };

export interface ReasoningParams {
  body: Record<string, unknown>;
  minMaxTokens?: number;
  dropTemperature?: boolean;
}

/** Request-body fragment for a level. Returns an empty body when nothing should be sent. */
export function reasoningParams(cfg: ReasoningConfig, level: string | undefined, protocol: Protocol): ReasoningParams {
  if (!level || cfg.style === 'none') return { body: {} };
  const budget = cfg.budgets?.[level] ?? DEFAULT_BUDGETS[level] ?? 8192;
  switch (cfg.style) {
    case 'openai':
      if (protocol === 'openai-responses') return { body: { reasoning: { effort: level, summary: 'auto' } }, dropTemperature: level !== 'none' };
      return { body: { reasoning_effort: level }, dropTemperature: level !== 'none' };
    case 'anthropic':
      return { body: { output_config: { effort: level } }, minMaxTokens: level === 'max' || level === 'xhigh' ? 64000 : level === 'high' ? 16000 : undefined };
    case 'anthropic-budget':
      if (level === 'off') return { body: {} };
      return { body: { thinking: { type: 'enabled', budget_tokens: budget } }, minMaxTokens: budget + 4096, dropTemperature: true };
    case 'qwen':
      if (level === 'off') return { body: { enable_thinking: false } };
      return { body: { enable_thinking: true, thinking_budget: budget } };
    case 'glm':
      return { body: { thinking: { type: level === 'off' ? 'disabled' : 'enabled' } } };
    case 'custom':
      return { body: (cfg.custom?.[level] as Record<string, unknown>) ?? {} };
    default:
      return { body: {} };
  }
}
