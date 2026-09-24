import type { ProviderConfig } from '../../shared/types';

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  rawArgs: string;
}

export interface LlmMessage {
  role: 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  toolName?: string;
  reasoning?: string;
}

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON schema (object)
}

export type DeltaType = 'text' | 'reasoning' | 'tool';

export interface LlmRequest {
  system: string;
  messages: LlmMessage[];
  tools?: ToolSpec[];
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
  onDelta?: (type: DeltaType, text: string) => void;
  idleTimeoutMs?: number;
  extraBody?: Record<string, unknown>; // e.g. reasoning params (merged into the request body)
  dropTemperature?: boolean; // reasoning models reject custom temperature
}

export interface LlmResult {
  text: string;
  reasoning: string;
  toolCalls: ToolCall[];
  usage: { input: number; output: number; cached: number };
  usageReported: boolean;
  stopReason: string;
  requestId?: string;
}

export interface ProviderRuntime {
  config: ProviderConfig;
  apiKey: string;
}

export type FetchLike = (url: string, init: RequestInit & { signal?: AbortSignal }) => Promise<Response>;

export class LlmHttpError extends Error {
  constructor(
    public status: number,
    public body: string,
    public url: string,
  ) {
    super(`LLM HTTP ${status}: ${body.slice(0, 400)}`);
    this.name = 'LlmHttpError';
  }
  get retryable() {
    return this.status === 429 || this.status === 408 || this.status >= 500;
  }
}

import type { ErrorInfo } from '../../shared/types';

const CONFIG_PATTERNS = /不支持.*(模型|接入|方式)|分组|无可用渠道|no available (channel|distributor)|model[_ ]?not[_ ]?found|model .*(does not exist|not (found|supported|available))|unsupported model|invalid model|模型.*(不存在|不可用|未开放)|not supported (for|by) this|not allowed to use|does not have access to (the )?model/i;
const PARAM_PATTERNS = /(reasoning|effort|thinking|enable_thinking|output_config|budget_tokens)[\s\S]{0,80}(unsupported|not supported|unknown|invalid|not permitted|unrecognized|extra)|(unsupported|unknown|unrecognized|invalid|extra)[\s\S]{0,40}(parameter|field|argument)[\s\S]{0,60}(reasoning|effort|thinking|output_config)/i;
const BILLING_PATTERNS = /insufficient|quota|余额|额度|billing|credit/i;

/** Map an LLM failure to an actionable category. `retryable` is false for configuration problems. */
export function classifyLlmError(e: unknown): ErrorInfo & { retryable: boolean } {
  if (e instanceof LlmHttpError) {
    const raw = e.body.slice(0, 1500);
    const s = e.status;
    if (PARAM_PATTERNS.test(raw)) return { kind: 'param', status: s, retryable: false, raw, hint: '服务不接受思考程度参数：请在「模型配置」中把该模型的思考方式改为「不发送思考参数」或调低档位。' };
    if (CONFIG_PATTERNS.test(raw) || s === 404) return { kind: 'config', status: s, retryable: false, raw, hint: s === 404 ? '接口地址或模型不存在：检查 base_url（是否需要 /v1）、协议选择与模型 id。' : '服务（或中转站当前分组）不支持该模型或接入方式：核对模型 id；在「模型配置 → 协议探测」中试试 Chat / Responses / Messages 哪种可用；或在中转站后台切换分组。' };
    if (s === 401 || s === 403) return { kind: 'auth', status: s, retryable: false, raw, hint: 'API Key 无效、过期或无此模型权限：在「模型配置」中重新填写 Key。' };
    if (s === 402 || BILLING_PATTERNS.test(raw)) return { kind: 'billing', status: s, retryable: false, raw, hint: '余额或额度不足：请充值或换用其他模型服务。' };
    if (s === 400 || s === 422) return { kind: 'config', status: s, retryable: false, raw, hint: '请求被拒绝（400）：多为模型 id、协议或参数不匹配，查看原始信息并调整「模型配置」。' };
    if (s === 429) return { kind: 'rate', status: s, retryable: true, raw, hint: '触发限流，稍后自动重试；频繁出现可降低六部并行度。' };
    if (s === 408) return { kind: 'timeout', status: s, retryable: true, raw, hint: '请求超时，已自动重试。' };
    return { kind: 'server', status: s, retryable: true, raw, hint: '模型服务暂时出错（5xx），已自动重试；持续失败可换模型后局部重试。' };
  }
  const msg = String((e as Error)?.message ?? e);
  if (/空闲超时|timeout/i.test(msg)) return { kind: 'timeout', retryable: true, raw: msg, hint: '模型长时间无输出，已自动重试；可换更快的模型或调低思考程度。' };
  if (/fetch failed|ECONN|ENOTFOUND|EAI_AGAIN|network|socket|TLS|certificate/i.test(msg)) return { kind: 'network', retryable: true, raw: msg, hint: '网络不通：检查 base_url、代理或本机网络。' };
  return { kind: 'other', retryable: true, raw: msg, hint: '未知错误，已自动重试。' };
}

export class LlmCallError extends Error {
  constructor(public info: ErrorInfo) {
    super(`${info.hint}${info.status ? `（HTTP ${info.status}）` : ''}`);
    this.name = 'LlmCallError';
  }
}
