// Generic agent loop: LLM ⇄ tools with checkpoints (pause/budget/cancel), annotations,
// rolling context compression, retries, live streaming activities and usage accounting.
import type { Activity, AgentId, ModelRef, RunNode, Session, Task } from '../../shared/types';
import { agentName } from '../../shared/court';
import type { LlmMessage, LlmResult, ToolSpec } from '../llm/types';
import { classifyLlmError, LlmCallError } from '../llm/types';
import { reasoningParams, levelLabel } from '../../shared/reasoning';
import { streamLlm } from '../llm/adapters';
import { SOULS } from './souls';
import { executeTool, describeToolCall, TOOL_SPECS, type ToolName } from './tools';
import { TaskAbortedError, type Runtime } from './runtime';
import { estimateTokens, sleep, truncate, uid, redactSecrets } from './util';

export interface AgentRunOptions {
  rt: Runtime;
  agentId: AgentId;
  prompt: string;
  task?: Task;
  node?: RunNode;
  session?: Session;
  history?: LlmMessage[];
  tools?: ToolName[];
  maxSteps?: number;
  maxTokens?: number;
  temperature?: number;
  model?: ModelRef;
  label?: string;
  onText?: (delta: string) => void;
  signal?: AbortSignal;
}

export interface AgentRunResult {
  text: string;
  messages: LlmMessage[];
  model: ModelRef;
  runId: string;
  steps: number;
}

export function systemPromptFor(rt: Runtime, agentId: AgentId): string {
  const skills = rt.skills.filter((s) => s.enabled !== false && (s.agents === 'all' || s.agents.includes(agentId)));
  const skillIdx = skills.length ? `\n\n可用技能（需要时用 load_skill 加载全文）：\n${skills.map((s) => `- ${s.name}：${s.description}`).join('\n')}` : '';
  return SOULS[agentId] + skillIdx;
}

const msgTokens = (ms: LlmMessage[]) => ms.reduce((n, m) => n + estimateTokens(m.content) + (m.toolCalls ? estimateTokens(JSON.stringify(m.toolCalls.map((t) => t.args))) : 0) + 4, 0);

function isAbort(e: unknown, signal?: AbortSignal) {
  return signal?.aborted || (e as Error)?.name === 'AbortError' || e instanceof TaskAbortedError;
}

/** Request fragments for the effective 思考程度 (empty when the model has no reasoning ladder or it was disabled). */
function effortRequest(o: AgentRunOptions, model: ModelRef, withEffort: boolean) {
  const { rt, agentId, task } = o;
  const info = rt.modelInfo(model);
  let maxTokens = o.maxTokens;
  const eff = withEffort ? rt.resolveEffort(agentId, model, task) : undefined;
  const rp = eff?.level ? reasoningParams(eff.cfg, eff.level, eff.protocol) : { body: {} as Record<string, unknown> };
  if (rp.minMaxTokens) maxTokens = Math.max(maxTokens ?? 0, rp.minMaxTokens);
  if (info?.maxOutputTokens && maxTokens) maxTokens = Math.min(maxTokens, info.maxOutputTokens);
  const thinking = rp.body.thinking as { budget_tokens?: number } | undefined;
  if (thinking?.budget_tokens && maxTokens && thinking.budget_tokens >= maxTokens) {
    rp.body = { ...rp.body, thinking: { ...thinking, budget_tokens: Math.max(1024, maxTokens - 2048) } };
  }
  return { level: eff?.level, maxTokens, extraBody: rp.body, dropTemperature: rp.dropTemperature };
}

async function callLlm(o: AgentRunOptions, model: ModelRef, system: string, messages: LlmMessage[], tools: ToolSpec[] | undefined, acts: { thinking?: Activity; text?: Activity }, useEffort = true): Promise<LlmResult> {
  const { rt, agentId, task, node } = o;
  const provider = rt.providerRuntime(model.providerId);
  const signal = o.signal ?? (task ? rt.controller(task.id).signal : undefined);
  let lastErr: unknown;
  let withEffort = useEffort;
  let paramFallback = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    const er = effortRequest(o, model, withEffort);
    try {
      let reasoning = '';
      let text = '';
      const r = await streamLlm(
        provider,
        model.model,
        {
          system, messages, tools, maxTokens: er.maxTokens, temperature: o.temperature, signal, idleTimeoutMs: 120_000,
          extraBody: er.extraBody, dropTemperature: er.dropTemperature,
          onDelta: (type, d) => {
            rt.heartbeat(agentId, task?.id);
            if (type === 'reasoning') {
              reasoning += d;
              if (!acts.thinking) {
                acts.thinking = rt.activity('thinking', '', { taskId: task?.id, agentId, nodeId: node?.id, streaming: true });
                rt.setAgent(agentId, { status: 'thinking', activity: '思考中…' });
              }
              rt.appendActivity(acts.thinking.id, d);
            } else if (type === 'text') {
              text += d;
              if (!acts.text) {
                acts.text = rt.activity('text', '', { taskId: task?.id, agentId, nodeId: node?.id, streaming: true });
                rt.setAgent(agentId, { status: 'writing', activity: '撰写中…' });
              }
              rt.appendActivity(acts.text.id, d);
              o.onText?.(d);
            } else {
              rt.setAgent(agentId, { status: 'tool', activity: '准备调用工具…' });
            }
          },
        },
        rt.opts.fetchImpl,
      );
      if (acts.thinking) rt.finishActivity(acts.thinking, reasoning);
      if (acts.text) rt.finishActivity(acts.text, text);
      const estimated = !r.usageReported;
      const usage = r.usageReported ? r.usage : { input: estimateTokens(system) + msgTokens(messages), output: estimateTokens(r.text + r.reasoning + JSON.stringify(r.toolCalls.map((t) => t.args))), cached: 0 };
      rt.recordUsage(model, usage, estimated, { task, node, agentId, session: o.session });
      return r;
    } catch (e) {
      if (acts.thinking?.streaming) rt.finishActivity(acts.thinking, acts.thinking.content || '（中断）');
      if (acts.text?.streaming) rt.finishActivity(acts.text, acts.text.content || '（中断）');
      acts.thinking = undefined;
      acts.text = undefined;
      if (isAbort(e, signal)) throw new TaskAbortedError();
      lastErr = e;
      const info = classifyLlmError(e);
      // The service rejected the reasoning parameters → drop them once, remember for this session, carry on.
      if (info.kind === 'param' && er.level && !paramFallback) {
        paramFallback = true;
        withEffort = false;
        rt.noReasoning.add(`${model.providerId}/${model.model}`);
        rt.activity('log', `${model.model} 不接受思考程度参数（${levelLabel(er.level)}），已自动改为不发送思考参数重试；可在「模型配置」中调整该模型的思考方式。`, { taskId: task?.id, agentId, nodeId: node?.id });
        rt.toast('warn', `${model.model} 不支持所选思考程度，已自动关闭思考参数`);
        attempt--;
        continue;
      }
      if (!info.retryable || attempt === 2) break;
      const wait = attempt === 0 ? 2000 : 6000;
      rt.activity('log', `模型调用失败，${wait / 1000}s 后重试（第 ${attempt + 2} 次）：${redactSecrets(info.hint)} ${redactSecrets(info.raw).slice(0, 160)}`, { taskId: task?.id, agentId, nodeId: node?.id });
      await sleep(wait);
    }
  }
  const info = classifyLlmError(lastErr);
  throw new LlmCallError({
    kind: info.kind, status: info.status, hint: info.hint, raw: redactSecrets(info.raw).slice(0, 1500),
    providerId: model.providerId, model: model.model, protocol: provider.config.protocol,
  });
}

async function maybeCompress(o: AgentRunOptions, model: ModelRef, messages: LlmMessage[]): Promise<LlmMessage[]> {
  const { rt } = o;
  const info = rt.modelInfo(model);
  const window = Math.min(info?.contextWindow ?? 128_000, rt.settings.contextWindowTokens);
  const threshold = Math.floor(window * 0.6);
  if (msgTokens(messages) < threshold || messages.length < 8) return messages;
  let cut = messages.length - 6;
  while (cut > 1 && messages[cut].role === 'tool') cut--;
  const head = messages[0];
  const middle = messages.slice(1, cut);
  const tail = messages.slice(cut);
  if (!middle.length) return messages;
  const serial = middle
    .map((m) => (m.role === 'tool' ? `[工具结果 ${m.toolName ?? ''}] ${truncate(m.content, 1500)}` : m.toolCalls?.length ? `[${m.role}] ${m.content} 调用：${m.toolCalls.map((t) => `${t.name}(${JSON.stringify(t.args).slice(0, 300)})`).join('; ')}` : `[${m.role}] ${truncate(m.content, 2500)}`))
    .join('\n');
  let econ: ModelRef;
  try {
    econ = rt.settings.routing.economy ?? model;
  } catch {
    econ = model;
  }
  const r = await callLlm(
    { ...o, onText: undefined },
    econ,
    '你是上下文压缩器。把工作过程压缩为要点，保留：目标与约束、已完成的操作、已修改的文件及要点、关键发现与结论、未完成事项。≤500字。',
    [{ role: 'user', content: truncate(serial, 24000) }],
    undefined,
    {},
    false,
  );
  rt.activity('log', `上下文已滚动压缩：${middle.length} 条消息 → 摘要（约 ${estimateTokens(r.text)} tokens）`, { taskId: o.task?.id, agentId: o.agentId, nodeId: o.node?.id });
  rt.audit.record('system', 'context_compressed', { agentId: o.agentId, messages: middle.length }, o.task?.id);
  return [head, { role: 'user', content: `【前情摘要（自动压缩）】\n${r.text}` }, ...tail];
}

export async function runAgent(o: AgentRunOptions): Promise<AgentRunResult> {
  const { rt, agentId, task, node } = o;
  const model = o.model ?? rt.resolveModel(agentId, task);
  const provider = rt.providerRuntime(model.providerId);
  const runId = uid('run-');
  if (node) {
    node.runId = runId;
    node.model = model.model;
    node.providerId = model.providerId;
    node.protocol = provider.config.protocol;
    node.effort = rt.resolveEffort(agentId, model, task).level;
    node.errorInfo = undefined;
    if (task) rt.touch(task);
  }
  const effort = rt.resolveEffort(agentId, model, task).level;
  const system = systemPromptFor(rt, agentId);
  // built-in tools + MCP tools granted to this agent (read-only toolsets only see MCP tools marked read)
  const tools = o.tools?.length ? [...o.tools.map((t) => TOOL_SPECS[t]), ...rt.mcp.toolSpecsFor(agentId, !o.tools.includes('write_file'))] : undefined;
  let messages: LlmMessage[] = [...(o.history ?? []), { role: 'user', content: o.prompt }];
  const maxSteps = o.maxSteps ?? (tools ? 24 : 1);
  const signal = o.signal ?? (task ? rt.controller(task.id).signal : undefined);
  const busy = rt.agents.get(agentId);
  if (busy && busy.status !== 'idle' && busy.taskId !== task?.id) {
    rt.activity('log', `${agentName(agentId)} 正在处理其他事务，排队等候`, { taskId: task?.id, agentId, nodeId: node?.id });
  }
  const release = await rt.acquireAgent(agentId, signal);
  rt.setAgent(agentId, { status: 'thinking', taskId: task?.id, nodeId: node?.id, activity: o.label ?? '处理中' });
  rt.audit.record(agentId, 'run_start', { runId, model: model.model, provider: provider.config.name, protocol: provider.config.protocol, effort: effort ?? null, node: node?.id }, task?.id);
  let finalText = '';
  let steps = 0;
  let pendingResp: ReturnType<Runtime['pendingAnnotations']> | null = null;
  try {
    for (; steps < maxSteps; steps++) {
      await rt.checkpoint(task, agentId);
      const anns = rt.pendingAnnotations(agentId, task?.id);
      if (anns.length) {
        messages.push({ role: 'user', content: `【皇上朱批】\n${anns.map((a) => `- ${a.text}`).join('\n')}\n请在本次回复开头明确回应朱批（写明将如何调整），然后继续工作。` });
        rt.markAnnotationsConsumed(anns);
        pendingResp = [...(pendingResp ?? []), ...anns];
        rt.activity('annotation', `${agentName(agentId)} 已接阅朱批 ${anns.length} 条`, { taskId: task?.id, agentId, nodeId: node?.id });
      }
      messages = await maybeCompress(o, model, messages);
      const r = await callLlm(o, model, system, messages, tools, {});
      if (pendingResp) {
        const resp = r.text.trim() || (r.toolCalls.length ? `（已阅朱批，随即调用：${r.toolCalls.map((t) => describeToolCall(t.name, t.args)).join('；')}）` : '（已阅）');
        rt.respondAnnotations(pendingResp, resp);
        pendingResp = null;
      }
      const calls = tools ? r.toolCalls : [];
      if (!calls.length) {
        messages.push({ role: 'assistant', content: r.text, reasoning: r.reasoning || undefined });
        finalText = r.text;
        break;
      }
      messages.push({ role: 'assistant', content: r.text, toolCalls: calls, reasoning: r.reasoning || undefined });
      for (const call of calls) {
        await rt.checkpoint(task, agentId);
        const desc = describeToolCall(call.name, call.args);
        rt.setAgent(agentId, { status: 'tool', activity: desc });
        const callAct = rt.activity('tool_call', desc, { taskId: task?.id, agentId, nodeId: node?.id, data: { name: call.name, args: sanitizeArgs(call.args) } });
        const res = await executeTool({ rt, task, node, agentId, signal: task ? rt.controller(task.id).signal : undefined }, call.name, call.args);
        rt.heartbeat(agentId, task?.id);
        rt.activity('tool_result', truncate(res.output, 5000), { taskId: task?.id, agentId, nodeId: node?.id, data: { ok: res.ok, name: call.name, callId: callAct.id } });
        messages.push({ role: 'tool', toolCallId: call.id, toolName: call.name, content: truncate(res.output, 12000) });
      }
    }
    if (!finalText && steps >= maxSteps && tools) {
      messages.push({ role: 'user', content: '已达到本轮工具调用步数上限。请不要再调用工具，直接给出最终结论（按要求的格式）。' });
      const r = await callLlm(o, model, system, messages, tools, {});
      messages.push({ role: 'assistant', content: r.text });
      finalText = r.text;
    }
    rt.audit.record(agentId, 'run_end', { runId, exit: 'ok', steps }, task?.id);
    return { text: finalText, messages, model, runId, steps };
  } catch (e) {
    const aborted = e instanceof TaskAbortedError;
    rt.audit.record(agentId, 'run_end', { runId, exit: aborted ? 'cancelled' : 'error', error: redactSecrets(String((e as Error).message)).slice(0, 300) }, task?.id);
    if (!aborted) {
      const a = rt.agents.get(agentId);
      if (a) a.errors++;
    }
    throw e;
  } finally {
    rt.setAgent(agentId, { status: 'idle', activity: '', taskId: undefined, nodeId: undefined });
    release();
  }
}

function sanitizeArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) out[k] = typeof v === 'string' && v.length > 600 ? `${v.slice(0, 600)}…(${v.length} chars)` : v;
  return out;
}
