// 思考程度（reasoning effort）— one slider in the UI, translated per protocol / model family.
// OpenAI:     Chat `reasoning_effort` · Responses `reasoning.effort`   (none · minimal · low · medium · high · xhigh · max)
// Anthropic:  `output_config.effort`                                   (low · medium · high · xhigh · max)
//             older extended-thinking models: `thinking.budget_tokens`
// Qwen:       `enable_thinking` + `thinking_budget`;  GLM: `thinking.type`
// custom:     any JSON merged into the body per level (for relays / private models, e.g. an `ultra` level)
import type { Protocol, ReasoningConfig, ReasoningStyle } from './types';

// levels are shown by the names the model's own API uses
export const LEVEL_LABEL: Record<string, string> = {
  none: 'None', off: 'Off', minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'XHigh', max: 'Max', ultra: 'Ultra', on: 'On',
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

/** every level name 检测思考档位 tries, low → high (also the rank used to clamp a level onto a ladder) */
export const LEVEL_RANK = ['none', 'off', 'minimal', 'low', 'medium', 'on', 'high', 'xhigh', 'max', 'ultra'];
export const DETECT_CANDIDATES = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

/** Fallback ladder when the name is unknown and the service accepts any level (so detection can't tell): five steps, the right end = thinking fully on. */
export function fallbackLadder(protocol: Protocol): ReasoningConfig {
  return protocol === 'anthropic-messages'
    ? { style: 'anthropic', levels: ['low', 'medium', 'high', 'xhigh', 'max'], default: 'medium' }
    : { style: 'openai', levels: ['none', 'low', 'medium', 'high', 'xhigh'], default: 'medium' };
}

// ───────────── 固定六档 ─────────────
// The UI always shows the same six levels. Each model maps them onto its own API level names (auto from the
// detected / guessed ladder, or set by hand in cfg.tierMap); a level the model has no counterpart for is greyed out.
export const TIERS = ['none', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Tier = (typeof TIERS)[number];
export const TIER_LABEL: Record<Tier, string> = { none: '无思考', low: '轻度', medium: '中度', high: 'High', xhigh: 'XHigh', max: 'Max' };
const isTier = (v: string | undefined): v is Tier => !!v && (TIERS as readonly string[]).includes(v);

/** which of the six a stored value means (tier ids, plus older saved API names) */
export function tierOf(v: string | undefined): Tier | undefined {
  if (!v) return undefined;
  if (isTier(v)) return v;
  return ({ off: 'none', minimal: 'low', on: 'medium', ultra: 'max' } as Record<string, Tier>)[v];
}

/** user-facing name for a stored level value ('top' = the model's highest) */
export function tierLabel(v: string | undefined): string {
  if (!v) return '';
  if (v === 'top') return '最高一档';
  const t = tierOf(v);
  return t ? TIER_LABEL[t] : levelLabel(v);
}

// API level names that can stand for each of the six, best first. 'minimal' stands in for 无思考 only when the
// model has nothing lower (it is the lowest level, not "off"); otherwise it is not used.
const TIER_CANDIDATES: Record<Tier, string[]> = { none: ['none', 'off', 'minimal'], low: ['low', 'minimal'], medium: ['medium', 'on'], high: ['high'], xhigh: ['xhigh'], max: ['max', 'ultra'] };

/** six levels → this model's API level (undefined = the model has none) */
export function tierMap(cfg: ReasoningConfig | null | undefined): Partial<Record<Tier, string>> {
  const out: Partial<Record<Tier, string>> = {};
  if (!cfg || cfg.style === 'none' || !cfg.levels.length) return out;
  if (cfg.tierMap) {
    for (const t of TIERS) {
      const l = cfg.tierMap[t];
      if (l && cfg.levels.includes(l)) out[t] = l;
    }
    if (Object.keys(out).length) return out;
  }
  const used = new Set<string>();
  for (const t of TIERS) {
    const l = TIER_CANDIDATES[t].find((c) => cfg.levels.includes(c) && !used.has(c));
    if (l) {
      out[t] = l;
      used.add(l);
    }
  }
  // custom ladders with their own names: put what's left on the free slots, in order
  const rest = cfg.levels.filter((l) => !used.has(l));
  if (rest.length) {
    const free = TIERS.filter((t) => !out[t]);
    const start = Object.keys(out).length ? 0 : Math.max(0, Math.floor((free.length - rest.length) / 2));
    rest.slice(0, free.length).forEach((l, i) => (out[free[Math.min(free.length - 1, start + i)]] = l));
  }
  return out;
}

export const availableTiers = (cfg: ReasoningConfig | null | undefined): Tier[] => {
  const m = tierMap(cfg);
  return TIERS.filter((t) => m[t]);
};

/** which of the six the model's default level is */
export function defaultTier(cfg: ReasoningConfig | null | undefined): Tier | undefined {
  const m = tierMap(cfg);
  return TIERS.find((t) => m[t] === cfg?.default) ?? availableTiers(cfg)[Math.floor((availableTiers(cfg).length - 1) / 2)];
}

/** nearest of the model's tiers to the wanted one (lower first, then higher) */
export function nearestTier(cfg: ReasoningConfig | null | undefined, want: Tier): Tier | undefined {
  const av = availableTiers(cfg);
  if (av.includes(want)) return want;
  const i = TIERS.indexOf(want);
  for (let d = 1; d < TIERS.length; d++) {
    if (i - d >= 0 && av.includes(TIERS[i - d])) return TIERS[i - d];
    if (i + d < TIERS.length && av.includes(TIERS[i + d])) return TIERS[i + d];
  }
  return undefined;
}

/** stored value ('default' / 'top' / tier / old API name) → which of the six it lands on for this model */
export function resolveTier(cfg: ReasoningConfig | null | undefined, value: string | undefined): Tier | undefined {
  const av = availableTiers(cfg);
  if (!av.length) return undefined;
  if (!value || value === 'default') return defaultTier(cfg);
  if (value === 'top') return av[av.length - 1];
  const m = tierMap(cfg);
  if (!isTier(value) && cfg!.levels.includes(value)) return TIERS.find((t) => m[t] === value) ?? defaultTier(cfg);
  const t = tierOf(value);
  return t ? nearestTier(cfg, t) : defaultTier(cfg);
}

/** one line saying which API level each of the six sends, and which ones this model lacks */
export function tierHint(cfg: ReasoningConfig | null | undefined): string {
  const m = tierMap(cfg);
  const av = TIERS.filter((t) => m[t]);
  if (!av.length) return '这个模型不发送思考参数，六档都不可用。';
  const parts = av.map((t) => `${TIER_LABEL[t]} → ${m[t]}${t === 'none' && m[t] === 'minimal' ? '（最低一档，不是完全关闭）' : ''}`);
  const missing = TIERS.filter((t) => !m[t]).map((t) => TIER_LABEL[t]);
  return `${parts.join(' · ')}${missing.length ? `；此模型没有：${missing.join('、')}` : ''}`;
}

/** Clamp any requested level onto the model's own ladder, via the six fixed levels; returns the API level name to send. */
export function clampLevel(cfg: ReasoningConfig, level: string | undefined): string | undefined {
  if (!cfg.levels.length) return undefined;
  const t = resolveTier(cfg, level);
  if (t) return tierMap(cfg)[t];
  return clampNative(cfg, level);
}

function clampNative(cfg: ReasoningConfig, level: string | undefined): string | undefined {
  if (!cfg.levels.length) return undefined;
  if (!level || level === 'default') return cfg.default || cfg.levels[Math.floor(cfg.levels.length / 2)];
  if (level === 'top') return cfg.levels[cfg.levels.length - 1];
  if (cfg.levels.includes(level)) return level;
  const rank = LEVEL_RANK;
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
