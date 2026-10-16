// 回答参数: temperature, Top P, frequency / presence penalty. Set per model (模型服务) and per official
// (官员模型与路由); an official's own value wins over the model's, the model's over the temperature each step
// of the flow uses by default. A parameter left unticked is not sent at all, so the service's default applies.
import type { Protocol, SamplingParams } from './types';

export type SamplingKey = keyof SamplingParams;

export interface SamplingSpec {
  key: SamplingKey;
  label: string;
  desc: string;
  icon: string;
  min: number;
  max: number;
  step: number;
  /** where a newly ticked slider starts */
  initial: number;
}

export const SAMPLING_SPECS: SamplingSpec[] = [
  { key: 'temperature', label: 'Temperature', desc: '控制输出的随机性和创造性', icon: 'thermometer', min: 0, max: 2, step: 0.05, initial: 0.7 },
  { key: 'topP', label: 'Top P', desc: '核采样，控制词汇选择的多样性', icon: 'target', min: 0, max: 1, step: 0.01, initial: 1 },
  { key: 'frequencyPenalty', label: 'Frequency Penalty', desc: '频率惩罚，减少重复词汇的出现', icon: 'repeat', min: -2, max: 2, step: 0.05, initial: 0 },
  { key: 'presencePenalty', label: 'Presence Penalty', desc: '存在惩罚，鼓励讨论新话题', icon: 'ban', min: -2, max: 2, step: 0.05, initial: 0 },
];

/** Why a parameter cannot be sent over this protocol ('' = it can). */
export function samplingUnsupported(key: SamplingKey, protocol: Protocol): string {
  if (key === 'frequencyPenalty' || key === 'presencePenalty') {
    if (protocol === 'anthropic-messages') return 'Anthropic 协议没有这个参数';
    if (protocol === 'openai-responses') return 'Responses 协议没有这个参数';
  }
  return '';
}

const clamp = (v: number, s: SamplingSpec) => Math.min(s.max, Math.max(s.min, Math.round(v / s.step) * s.step));

/** Only the known fields, as finite numbers inside their range (rounded to the slider step). */
export function cleanSampling(v: unknown): SamplingParams | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const out: SamplingParams = {};
  for (const s of SAMPLING_SPECS) {
    const x = (v as Record<string, unknown>)[s.key];
    if (typeof x === 'number' && Number.isFinite(x)) out[s.key] = +clamp(x, s).toFixed(2);
  }
  return Object.keys(out).length ? out : undefined;
}

export interface ResolvedSampling extends SamplingParams {
  /** where each value came from (for the activity log / tests) */
  from: Partial<Record<SamplingKey, 'agent' | 'model' | 'step'>>;
}

/**
 * The parameters one request sends: the official's own, else the model's, else (temperature only) the step's
 * built-in default. Fields the protocol does not have are dropped.
 */
export function resolveSampling(o: { agent?: SamplingParams; model?: SamplingParams; stepTemperature?: number; protocol: Protocol }): ResolvedSampling {
  const out: ResolvedSampling = { from: {} };
  for (const s of SAMPLING_SPECS) {
    if (samplingUnsupported(s.key, o.protocol)) continue;
    const a = o.agent?.[s.key];
    const m = o.model?.[s.key];
    if (a !== undefined) {
      out[s.key] = a;
      out.from[s.key] = 'agent';
    } else if (m !== undefined) {
      out[s.key] = m;
      out.from[s.key] = 'model';
    } else if (s.key === 'temperature' && o.stepTemperature !== undefined) {
      out.temperature = o.stepTemperature;
      out.from.temperature = 'step';
    }
  }
  return out;
}

/** 「温度 0.7 · Top P 0.9」 — for summaries; '' when nothing is set. */
export function samplingSummary(p?: SamplingParams): string {
  if (!p) return '';
  const short: Record<SamplingKey, string> = { temperature: '温度', topP: 'Top P', frequencyPenalty: '频率惩罚', presencePenalty: '存在惩罚' };
  return SAMPLING_SPECS.filter((s) => p[s.key] !== undefined).map((s) => `${short[s.key]} ${p[s.key]}`).join(' · ');
}
