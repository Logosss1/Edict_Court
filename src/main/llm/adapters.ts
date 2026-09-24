// Multi-protocol LLM adapters: OpenAI Chat Completions, Anthropic Messages, OpenAI Responses.
// All three stream; all normalise to LlmResult. Keys are only placed in request headers
// sent to the user-configured base URL — never logged.
import { readSse } from './sse';
import { deepMerge } from '../../shared/reasoning';
import { LlmHttpError, type FetchLike, type LlmMessage, type LlmRequest, type LlmResult, type ProviderRuntime, type ToolCall } from './types';

const trimSlash = (s: string) => s.replace(/\/+$/, '');

export function endpointFor(p: ProviderRuntime): string {
  const base = trimSlash(p.config.baseUrl.trim());
  switch (p.config.protocol) {
    case 'openai-chat':
      return base.endsWith('/chat/completions') ? base : `${base}/chat/completions`;
    case 'openai-responses':
      return base.endsWith('/responses') ? base : `${base}/responses`;
    case 'anthropic-messages':
      if (base.endsWith('/messages')) return base;
      return /\/v1$/.test(base) ? `${base}/messages` : `${base}/v1/messages`;
  }
}

function headersFor(p: ProviderRuntime): Record<string, string> {
  const h: Record<string, string> = { 'content-type': 'application/json', accept: 'text/event-stream' };
  if (p.config.protocol === 'anthropic-messages') {
    if (p.apiKey) h['x-api-key'] = p.apiKey;
    h['anthropic-version'] = '2023-06-01';
  } else if (p.apiKey) {
    h.authorization = `Bearer ${p.apiKey}`;
  }
  for (const [k, v] of Object.entries(p.config.extraHeaders ?? {})) h[k.toLowerCase()] = v;
  return h;
}

function parseArgs(raw: string): Record<string, unknown> {
  if (!raw || !raw.trim()) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? v : { value: v };
  } catch {
    return { __unparsed: raw };
  }
}

async function post(fetchImpl: FetchLike, url: string, headers: Record<string, string>, body: unknown, signal?: AbortSignal): Promise<Response> {
  const res = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(body), signal });
  if (!res.ok) {
    let text = '';
    try {
      text = await res.text();
    } catch {
      /* ignore */
    }
    throw new LlmHttpError(res.status, text, url);
  }
  if (!res.body) throw new Error('LLM 响应缺少正文流');
  return res;
}

function applyExtra(body: Record<string, unknown>, req: LlmRequest) {
  if (req.dropTemperature) delete body.temperature;
  if (req.extraBody && Object.keys(req.extraBody).length) Object.assign(body, deepMerge(body, req.extraBody));
  // OpenAI reasoning models on Chat Completions reject `max_tokens`; they take `max_completion_tokens`.
  if ('reasoning_effort' in body && body.reasoning_effort !== 'none' && body.max_tokens !== undefined) {
    body.max_completion_tokens = body.max_tokens;
    delete body.max_tokens;
  }
}

// ───────────────────────── OpenAI Chat Completions ─────────────────────────
function toOpenAiChat(p: ProviderRuntime, req: LlmRequest) {
  const msgs: Record<string, unknown>[] = [{ role: 'system', content: req.system }];
  for (const m of req.messages) {
    if (m.role === 'user') msgs.push({ role: 'user', content: m.content });
    else if (m.role === 'tool') msgs.push({ role: 'tool', tool_call_id: m.toolCallId, content: m.content });
    else {
      const out: Record<string, unknown> = { role: 'assistant', content: m.content || (m.toolCalls?.length ? null : '') };
      if (m.toolCalls?.length) out.tool_calls = m.toolCalls.map((t) => ({ id: t.id, type: 'function', function: { name: t.name, arguments: t.rawArgs || JSON.stringify(t.args) } }));
      if (p.config.replayReasoning && m.reasoning) out.reasoning_content = m.reasoning;
      msgs.push(out);
    }
  }
  return msgs;
}

export async function streamOpenAiChat(p: ProviderRuntime, model: string, req: LlmRequest, fetchImpl: FetchLike, withUsageOpt = true): Promise<LlmResult> {
  const body: Record<string, unknown> = {
    model,
    messages: toOpenAiChat(p, req),
    stream: true,
  };
  if (withUsageOpt) body.stream_options = { include_usage: true };
  if (req.maxTokens) body.max_tokens = req.maxTokens;
  if (req.temperature !== undefined) body.temperature = req.temperature;
  if (req.tools?.length) body.tools = req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
  applyExtra(body, req);
  let res: Response;
  try {
    res = await post(fetchImpl, endpointFor(p), headersFor(p), body, req.signal);
  } catch (e) {
    if (withUsageOpt && e instanceof LlmHttpError && e.status === 400 && /stream_options|include_usage/i.test(e.body)) {
      return streamOpenAiChat(p, model, req, fetchImpl, false);
    }
    throw e;
  }
  const result: LlmResult = { text: '', reasoning: '', toolCalls: [], usage: { input: 0, output: 0, cached: 0 }, usageReported: false, stopReason: '' };
  result.requestId = res.headers.get('x-request-id') ?? undefined;
  const calls: { id: string; name: string; args: string }[] = [];
  for await (const ev of readSse(res.body!, { idleTimeoutMs: req.idleTimeoutMs, signal: req.signal })) {
    if (ev.data === '[DONE]') break;
    let j: any;
    try {
      j = JSON.parse(ev.data);
    } catch {
      continue;
    }
    if (j.error) throw new Error(`模型服务返回错误：${JSON.stringify(j.error).slice(0, 300)}`);
    if (j.usage) {
      result.usageReported = true;
      result.usage.input = j.usage.prompt_tokens ?? result.usage.input;
      result.usage.output = j.usage.completion_tokens ?? result.usage.output;
      result.usage.cached = j.usage.prompt_tokens_details?.cached_tokens ?? j.usage.prompt_cache_hit_tokens ?? result.usage.cached;
    }
    const choice = j.choices?.[0];
    if (!choice) continue;
    const d = choice.delta ?? {};
    const reasoning = d.reasoning_content ?? d.reasoning ?? d.thinking;
    if (typeof reasoning === 'string' && reasoning) {
      result.reasoning += reasoning;
      req.onDelta?.('reasoning', reasoning);
    }
    if (typeof d.content === 'string' && d.content) {
      result.text += d.content;
      req.onDelta?.('text', d.content);
    }
    if (Array.isArray(d.tool_calls)) {
      for (const tc of d.tool_calls) {
        const idx = typeof tc.index === 'number' ? tc.index : calls.length;
        if (!calls[idx]) calls[idx] = { id: tc.id ?? `call_${idx}`, name: '', args: '' };
        if (tc.id) calls[idx].id = tc.id;
        if (tc.function?.name) calls[idx].name += tc.function.name;
        if (tc.function?.arguments) {
          calls[idx].args += tc.function.arguments;
          req.onDelta?.('tool', tc.function.arguments);
        }
      }
    }
    if (choice.finish_reason) result.stopReason = choice.finish_reason;
  }
  result.toolCalls = calls.filter(Boolean).map((c) => ({ id: c.id, name: c.name, rawArgs: c.args, args: parseArgs(c.args) }));
  return result;
}

// ───────────────────────── Anthropic Messages ─────────────────────────
function toAnthropic(req: LlmRequest) {
  const out: { role: 'user' | 'assistant'; content: any[] }[] = [];
  const push = (role: 'user' | 'assistant', block: any) => {
    const last = out[out.length - 1];
    if (last && last.role === role) last.content.push(block);
    else out.push({ role, content: [block] });
  };
  for (const m of req.messages) {
    if (m.role === 'user') push('user', { type: 'text', text: m.content || '(空)' });
    else if (m.role === 'tool') push('user', { type: 'tool_result', tool_use_id: m.toolCallId, content: m.content || '(无输出)' });
    else {
      if (m.content) push('assistant', { type: 'text', text: m.content });
      for (const t of m.toolCalls ?? []) push('assistant', { type: 'tool_use', id: t.id, name: t.name, input: t.args });
      if (!m.content && !m.toolCalls?.length) push('assistant', { type: 'text', text: '(空)' });
    }
  }
  if (out[0]?.role !== 'user') out.unshift({ role: 'user', content: [{ type: 'text', text: '开始。' }] });
  return out;
}

export async function streamAnthropic(p: ProviderRuntime, model: string, req: LlmRequest, fetchImpl: FetchLike): Promise<LlmResult> {
  const body: Record<string, unknown> = {
    model,
    max_tokens: req.maxTokens ?? 8192,
    // stable prefix → prompt cache
    system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
    messages: toAnthropic(req),
    stream: true,
  };
  if (req.temperature !== undefined) body.temperature = req.temperature;
  if (req.tools?.length) body.tools = req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
  applyExtra(body, req);
  const res = await post(fetchImpl, endpointFor(p), headersFor(p), body, req.signal);
  const result: LlmResult = { text: '', reasoning: '', toolCalls: [], usage: { input: 0, output: 0, cached: 0 }, usageReported: false, stopReason: '' };
  result.requestId = res.headers.get('request-id') ?? undefined;
  const blocks: Record<number, { type: string; id?: string; name?: string; json: string }> = {};
  for await (const ev of readSse(res.body!, { idleTimeoutMs: req.idleTimeoutMs, signal: req.signal })) {
    let j: any;
    try {
      j = JSON.parse(ev.data);
    } catch {
      continue;
    }
    const type = j.type ?? ev.event;
    if (type === 'error') throw new Error(`模型服务返回错误：${JSON.stringify(j.error ?? j).slice(0, 300)}`);
    if (type === 'message_start') {
      const u = j.message?.usage ?? {};
      result.usageReported = true;
      result.usage.input = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
      result.usage.cached = u.cache_read_input_tokens ?? 0;
      result.usage.output = u.output_tokens ?? 0;
    } else if (type === 'content_block_start') {
      const b = j.content_block ?? {};
      blocks[j.index] = { type: b.type, id: b.id, name: b.name, json: '' };
    } else if (type === 'content_block_delta') {
      const d = j.delta ?? {};
      if (d.type === 'text_delta') {
        result.text += d.text;
        req.onDelta?.('text', d.text);
      } else if (d.type === 'thinking_delta') {
        result.reasoning += d.thinking;
        req.onDelta?.('reasoning', d.thinking);
      } else if (d.type === 'input_json_delta') {
        const b = blocks[j.index];
        if (b) b.json += d.partial_json;
        req.onDelta?.('tool', d.partial_json);
      }
    } else if (type === 'message_delta') {
      if (j.delta?.stop_reason) result.stopReason = j.delta.stop_reason;
      if (j.usage?.output_tokens !== undefined) result.usage.output = j.usage.output_tokens;
    }
  }
  const calls: ToolCall[] = [];
  for (const k of Object.keys(blocks).map(Number).sort((a, b) => a - b)) {
    const b = blocks[k];
    if (b.type === 'tool_use') calls.push({ id: b.id ?? `toolu_${k}`, name: b.name ?? '', rawArgs: b.json, args: parseArgs(b.json || '{}') });
  }
  result.toolCalls = calls;
  return result;
}

// ───────────────────────── OpenAI Responses ─────────────────────────
function toResponsesInput(req: LlmRequest) {
  const items: any[] = [];
  for (const m of req.messages) {
    if (m.role === 'user') items.push({ role: 'user', content: m.content });
    else if (m.role === 'tool') items.push({ type: 'function_call_output', call_id: m.toolCallId, output: m.content });
    else {
      if (m.content) items.push({ role: 'assistant', content: m.content });
      for (const t of m.toolCalls ?? []) items.push({ type: 'function_call', call_id: t.id, name: t.name, arguments: t.rawArgs || JSON.stringify(t.args) });
    }
  }
  return items;
}

export async function streamResponses(p: ProviderRuntime, model: string, req: LlmRequest, fetchImpl: FetchLike): Promise<LlmResult> {
  const body: Record<string, unknown> = {
    model,
    instructions: req.system,
    input: toResponsesInput(req),
    stream: true,
  };
  if (req.maxTokens) body.max_output_tokens = req.maxTokens;
  if (req.temperature !== undefined) body.temperature = req.temperature;
  if (req.tools?.length) body.tools = req.tools.map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.parameters }));
  applyExtra(body, req);
  const res = await post(fetchImpl, endpointFor(p), headersFor(p), body, req.signal);
  const result: LlmResult = { text: '', reasoning: '', toolCalls: [], usage: { input: 0, output: 0, cached: 0 }, usageReported: false, stopReason: '' };
  const fc: Record<string, { call_id: string; name: string; args: string }> = {};
  for await (const ev of readSse(res.body!, { idleTimeoutMs: req.idleTimeoutMs, signal: req.signal })) {
    let j: any;
    try {
      j = JSON.parse(ev.data);
    } catch {
      continue;
    }
    const type: string = j.type ?? ev.event;
    if (type === 'error' || type === 'response.failed') throw new Error(`模型服务返回错误：${JSON.stringify(j.error ?? j.response?.error ?? j).slice(0, 300)}`);
    if (type === 'response.output_text.delta') {
      result.text += j.delta;
      req.onDelta?.('text', j.delta);
    } else if (type === 'response.reasoning_summary_text.delta' || type === 'response.reasoning_text.delta') {
      result.reasoning += j.delta;
      req.onDelta?.('reasoning', j.delta);
    } else if (type === 'response.output_item.added' && j.item?.type === 'function_call') {
      fc[j.item.id] = { call_id: j.item.call_id, name: j.item.name, args: j.item.arguments ?? '' };
    } else if (type === 'response.function_call_arguments.delta') {
      const f = fc[j.item_id];
      if (f) f.args += j.delta;
      req.onDelta?.('tool', j.delta);
    } else if (type === 'response.output_item.done' && j.item?.type === 'function_call') {
      fc[j.item.id] = { call_id: j.item.call_id, name: j.item.name, args: j.item.arguments ?? fc[j.item.id]?.args ?? '' };
    } else if (type === 'response.completed' || type === 'response.incomplete') {
      const u = j.response?.usage;
      if (u) {
        result.usageReported = true;
        result.usage.input = u.input_tokens ?? 0;
        result.usage.output = u.output_tokens ?? 0;
        result.usage.cached = u.input_tokens_details?.cached_tokens ?? 0;
      }
      result.stopReason = j.response?.status ?? type;
      result.requestId = j.response?.id;
    }
  }
  result.toolCalls = Object.values(fc).map((f) => ({ id: f.call_id, name: f.name, rawArgs: f.args, args: parseArgs(f.args) }));
  return result;
}

export async function streamLlm(p: ProviderRuntime, model: string, req: LlmRequest, fetchImpl: FetchLike): Promise<LlmResult> {
  switch (p.config.protocol) {
    case 'openai-chat':
      return streamOpenAiChat(p, model, req, fetchImpl);
    case 'anthropic-messages':
      return streamAnthropic(p, model, req, fetchImpl);
    case 'openai-responses':
      return streamResponses(p, model, req, fetchImpl);
    default:
      throw new Error(`未知协议 ${(p.config as { protocol: string }).protocol}`);
  }
}

export async function listRemoteModels(p: ProviderRuntime, fetchImpl: FetchLike): Promise<string[]> {
  const base = trimSlash(p.config.baseUrl.trim());
  const url = p.config.protocol === 'anthropic-messages' ? (/\/v1$/.test(base) ? `${base}/models` : `${base}/v1/models`) : `${base}/models`;
  const h = headersFor(p);
  delete h.accept;
  const res = await fetchImpl(url, { method: 'GET', headers: h });
  if (!res.ok) throw new LlmHttpError(res.status, await res.text().catch(() => ''), url);
  const j: any = await res.json();
  const arr: any[] = j.data ?? j.models ?? [];
  return arr.map((m) => m.id ?? m.name).filter(Boolean);
}

export type { LlmMessage };
