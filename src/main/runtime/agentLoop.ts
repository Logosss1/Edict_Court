// Generic agent loop: LLM ⇄ tools with checkpoints (pause/budget/cancel), annotations,
// rolling context compression, retries, live streaming activities and usage accounting.
import type { Activity, AgentId, ModelRef, RunNode, Session, Task } from '../../shared/types';
import { AGENT_MAP, agentName } from '../../shared/court';
import type { LlmMessage, LlmResult, ToolSpec } from '../llm/types';
import { backoffMs, classifyLlmError, LlmCallError, LlmHttpError } from '../llm/types';
import { reasoningParams, levelLabel } from '../../shared/reasoning';
import { streamLlm } from '../llm/adapters';
import { SOULS } from './souls';
import { executeTool, describeToolCall, TOOL_SPECS, type ToolName } from './tools';
import { mcpResourceToolSpecsFor } from '../mcp/resourceTools';
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
  /** A custom 协同设计 role. `agentId` is then the role's court avatar (status / court display only). */
  role?: RoleRun;
}

export interface RoleRun {
  key: string; // unique runtime identity, e.g. r:<designId>:<roleId> — used for the agent lock
  id: string;
  name: string;
  prompt: string;
  modelClass: 'strong' | 'economy';
  model?: ModelRef;
  effort?: string;
}

export interface AgentRunResult {
  text: string;
  messages: LlmMessage[];
  model: ModelRef;
  runId: string;
  steps: number;
  /** tool calls actually executed in this run, by tool name */
  toolCounts: Record<string, number>;
}

export function systemPromptFor(rt: Runtime, agentId: AgentId, role?: RoleRun): string {
  const skills = rt.skills.filter((s) => s.enabled !== false && (s.agents === 'all' || s.agents.includes(agentId)));
  const skillIdx = skills.length ? `\n\n可用技能（需要时用 load_skill 加载全文）：\n${skills.map((s) => `- ${s.name}：${s.description}`).join('\n')}` : '';
  return (role ? role.prompt : SOULS[agentId]) + skillIdx;
}

export const msgTokens = (ms: LlmMessage[]) => ms.reduce((n, m) => n + estimateTokens(m.content) + (m.toolCalls ? estimateTokens(JSON.stringify(m.toolCalls.map((t) => t.args))) : 0) + 4, 0);

function isAbort(e: unknown, signal?: AbortSignal) {
  return signal?.aborted || (e as Error)?.name === 'AbortError' || e instanceof TaskAbortedError;
}

/** Request fragments for the effective 思考程度 (empty when the model has no reasoning ladder or it was disabled). */
function effortRequest(o: AgentRunOptions, model: ModelRef, withEffort: boolean) {
  const { rt, agentId, task } = o;
  const info = rt.modelInfo(model);
  let maxTokens = o.maxTokens;
  const eff = withEffort ? rt.resolveEffort(agentId, model, task, o.role?.modelClass, o.role?.effort) : undefined;
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
  const signal = o.signal ?? (task ? rt.signalFor(task.id, node?.id) : undefined);
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
      const told = e instanceof LlmHttpError ? e.retryAfterMs : undefined;
      const wait = backoffMs(attempt, told);
      rt.activity('log', `模型调用失败，${Math.round(wait / 100) / 10}s 后重试（第 ${attempt + 2} 次${told !== undefined ? '，按服务要求的等待时间' : ''}）：${redactSecrets(info.hint)} ${redactSecrets(info.raw).slice(0, 160)}`, { taskId: task?.id, agentId, nodeId: node?.id });
      await abortableSleep(wait, signal);
    }
  }
  const info = classifyLlmError(lastErr);
  throw new LlmCallError({
    kind: info.kind, status: info.status, hint: info.hint, raw: redactSecrets(info.raw).slice(0, 1500),
    providerId: model.providerId, model: model.model, protocol: provider.config.protocol,
  });
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return sleep(ms).then(() => undefined);
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(new TaskAbortedError());
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new TaskAbortedError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

const contextWindow = (rt: Runtime, model: ModelRef) => Math.min(rt.modelInfo(model)?.contextWindow ?? 128_000, rt.settings.contextWindowTokens);

const PRUNE_MARK = '[已裁剪]';

/**
 * Cheap first line of defence before LLM compression: once the conversation passes `budget` tokens,
 * shorten all but the newest `keep` tool results (skill text is never pruned; command output keeps
 * its header and tail, other tools keep their head).
 */
export function pruneToolResults(messages: LlmMessage[], budget: number, keep = 8): { messages: LlmMessage[]; pruned: number } {
  if (msgTokens(messages) < budget) return { messages, pruned: 0 };
  const toolIdx = messages.flatMap((m, i) => (m.role === 'tool' ? [i] : []));
  const protect = new Set(toolIdx.slice(-keep));
  let pruned = 0;
  const out = messages.map((m, i) => {
    if (m.role !== 'tool' || protect.has(i) || m.toolName === 'load_skill' || m.content.startsWith(PRUNE_MARK) || m.content.length <= 800) return m;
    pruned++;
    const note = `${PRUNE_MARK} 较早的 ${m.toolName ?? '工具'} 结果已省略以节省上下文（原 ${m.content.length} 字符），需要时请重新调用。`;
    if (m.toolName === 'run_command') {
      const head = m.content.split('\n').slice(0, 2).join('\n');
      return { ...m, content: `${note}\n${head}\n…末尾：\n${m.content.slice(-1500)}` };
    }
    return { ...m, content: `${note}\n开头：\n${m.content.slice(0, 400)}` };
  });
  return { messages: out, pruned };
}

async function maybeCompress(o: AgentRunOptions, model: ModelRef, messages: LlmMessage[], force = false): Promise<LlmMessage[]> {
  const { rt } = o;
  const threshold = Math.floor(contextWindow(rt, model) * 0.6);
  if (force ? messages.length < 4 : msgTokens(messages) < threshold || messages.length < 8) return messages;
  let cut = messages.length - (force ? 2 : 6);
  while (cut > 1 && messages[cut].role === 'tool') cut--;
  const head = messages[0];
  const middle = messages.slice(1, cut);
  const tail = messages.slice(cut);
  if (!middle.length) return messages;
  const serial = middle
    .map((m) => (m.role === 'tool' ? `[工具结果 ${m.toolName ?? ''}] ${truncate(m.content, 1500)}` : m.toolCalls?.length ? `[${m.role}] ${m.content} 调用：${m.toolCalls.map((t) => `${t.name}(${JSON.stringify(t.args).slice(0, 300)})`).join('; ')}` : `[${m.role}] ${truncate(m.content, 2500)}`))
    .join('\n');
  const e = rt.settings.routing.economy;
  const econ: ModelRef = e && !rt.badModels.has(`${e.providerId}/${e.model}`) ? e : model;
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
  const role = o.role;
  let model = o.model ?? rt.resolveModel(agentId, task, role);
  let provider = rt.providerRuntime(model.providerId);
  const warnKey = `${task?.id ?? ''}/${role?.id ?? ''}`;
  if (role?.model && !o.model && (role.model.providerId !== model.providerId || role.model.model !== model.model) && !task?.roleModels?.[role.id] && !rt.roleModelWarned.has(warnKey)) {
    rt.roleModelWarned.add(warnKey);
    rt.activity('log', `${role.name} 指定的模型 ${role.model.model} 当前不可用（服务已删除、停用或本次运行中报错），改用 ${model.model}。可在「协同设计」里修改这个角色的模型。`, { taskId: task?.id, agentId, nodeId: node?.id });
  }
  const runId = uid('run-');
  const stamp = () => {
    if (!node) return;
    node.model = model.model;
    node.providerId = model.providerId;
    node.protocol = provider.config.protocol;
    node.effort = rt.resolveEffort(agentId, model, task, role?.modelClass, role?.effort).level;
  };
  if (node) {
    node.runId = runId;
    stamp();
    if (role) {
      node.roleId = role.id;
      node.roleName = role.name;
    }
    node.errorInfo = undefined;
    if (task) rt.touch(task);
  }
  const effort = rt.resolveEffort(agentId, model, task, role?.modelClass, role?.effort).level;
  const system = systemPromptFor(rt, agentId, role);
  /** one model call; if the service says it does not offer this (routed) model, switch once to a working one */
  let switched = false;
  const llm = async (msgs: LlmMessage[]) => {
    try {
      return await callLlm(o, model, system, msgs, tools, {});
    } catch (e) {
      // only routed economy-class models are swapped; the main model the emperor picked fails visibly with its error card
      const economy = (role ? role.modelClass : AGENT_MAP[agentId]?.modelClass) === 'economy' && agentId !== 'solo';
      const fb = e instanceof LlmCallError && e.info.kind === 'config' && economy && !o.model && !switched ? rt.fallbackModel(model, task) : null;
      if (!fb || !(e instanceof LlmCallError)) throw e;
      switched = true;
      const bad = model;
      rt.badModels.add(`${bad.providerId}/${bad.model}`);
      model = fb;
      provider = rt.providerRuntime(model.providerId);
      stamp();
      if (task) rt.touch(task);
      const who = role?.name ?? agentName(agentId);
      rt.activity('log', `${who} 用的模型 ${bad.model} 在当前服务不可用（${e.info.status ? `HTTP ${e.info.status}，` : ''}${e.info.hint.split('：')[0]}），已改用 ${model.model} 继续；本次运行期间不再使用 ${bad.model}。要长期解决，请在「模型配置 → 模型路由」里把经济模型换成可用的模型。`, { taskId: task?.id, agentId, nodeId: node?.id });
      rt.toast('warn', `模型 ${bad.model} 不可用，已自动改用 ${model.model}。请到「模型配置」检查经济模型`);
      rt.audit.record(agentId, 'model_fallback', { from: bad.model, to: model.model, kind: e.info.kind, status: e.info.status ?? null }, task?.id);
      return await callLlm(o, model, system, msgs, tools, {});
    }
  };
  // built-in tools + MCP tools granted to this agent (read-only toolsets only see MCP tools marked read)
  const tools = o.tools?.length ? [...o.tools.map((t) => TOOL_SPECS[t]), ...rt.mcp.toolSpecsFor(agentId, !o.tools.includes('write_file')), ...mcpResourceToolSpecsFor(rt, agentId)] : undefined;
  let messages: LlmMessage[] = [...(o.history ?? []), { role: 'user', content: o.prompt }];
  const maxSteps = o.maxSteps ?? (tools ? 24 : 1);
  const signal = o.signal ?? (task ? rt.signalFor(task.id, node?.id) : undefined);
  const busy = rt.agents.get(agentId);
  if (busy && busy.status !== 'idle' && busy.taskId !== task?.id) {
    if (!role) rt.activity('log', `${agentName(agentId)} 正在处理其他事务，排队等候`, { taskId: task?.id, agentId, nodeId: node?.id });
  }
  const release = await rt.acquireAgent(role?.key ?? agentId, signal);
  rt.setAgent(agentId, { status: 'thinking', taskId: task?.id, nodeId: node?.id, activity: o.label ?? '处理中' });
  rt.audit.record(agentId, 'run_start', { runId, model: model.model, provider: provider.config.name, protocol: provider.config.protocol, effort: effort ?? null, node: node?.id, role: role?.key ?? null }, task?.id);
  let finalText = '';
  let steps = 0;
  let pendingResp: ReturnType<Runtime['pendingAnnotations']> | null = null;
  // files read during this run (read-before-overwrite guard)
  const reads = new Map<string, string>();
  // identical consecutive tool calls (doom-loop guard)
  const loop = { sig: '', streak: 0 };
  const toolCounts: Record<string, number> = {};
  // the conversation outgrew the model's context: prune hard, compress, try once more
  let contextRetried = false;
  const llmFit = async () => {
    try {
      return await llm(messages);
    } catch (e) {
      if (!(e instanceof LlmCallError) || e.info.kind !== 'context' || contextRetried) throw e;
      contextRetried = true;
      messages = pruneToolResults(messages, 0, 3).messages;
      messages = await maybeCompress(o, model, messages, true);
      rt.activity('log', `对话超出 ${model.model} 的上下文长度，已裁剪旧工具结果并压缩上下文后重试。`, { taskId: task?.id, agentId, nodeId: node?.id });
      rt.audit.record('system', 'context_overflow', { agentId, model: model.model }, task?.id);
      return await llm(messages);
    }
  };
  try {
    for (; steps < maxSteps; steps++) {
      await rt.checkpoint(task, agentId);
      if (signal?.aborted) throw new TaskAbortedError();
      const anns = rt.pendingAnnotations(agentId, task?.id);
      if (anns.length) {
        messages.push({ role: 'user', content: `【皇上朱批】\n${anns.map((a) => `- ${a.text}`).join('\n')}\n请在本次回复开头明确回应朱批（写明将如何调整），然后继续工作。` });
        rt.markAnnotationsConsumed(anns);
        pendingResp = [...(pendingResp ?? []), ...anns];
        rt.activity('annotation', `${agentName(agentId)} 已接阅朱批 ${anns.length} 条`, { taskId: task?.id, agentId, nodeId: node?.id });
      }
      const pr = pruneToolResults(messages, Math.floor(contextWindow(rt, model) * 0.4));
      if (pr.pruned) {
        messages = pr.messages;
        rt.audit.record('system', 'tool_results_pruned', { agentId, count: pr.pruned }, task?.id);
      }
      messages = await maybeCompress(o, model, messages);
      const r = await llmFit();
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
      const ctx = { rt, task, node, agentId, signal: task ? rt.signalFor(task.id, node?.id) : undefined, reads };
      for (const batch of toolBatches(calls)) {
        await rt.checkpoint(task, agentId);
        const descs = batch.map((c) => describeToolCall(c.name, c.args));
        rt.setAgent(agentId, { status: 'tool', activity: batch.length > 1 ? `${descs[0]} 等 ${batch.length} 项（并行读取）` : descs[0] });
        const acts = batch.map((call, i) => rt.activity('tool_call', descs[i], { taskId: task?.id, agentId, nodeId: node?.id, data: { name: call.name, args: sanitizeArgs(call.args) } }));
        const streaks = batch.map((call) => trackLoop(loop, call.name, call.args));
        const results = await Promise.all(batch.map((call, i) => runToolGuarded(ctx, call.name, call.args, streaks[i], descs[i], () => (loop.streak = 0))));
        rt.heartbeat(agentId, task?.id);
        batch.forEach((call, i) => {
          const res = results[i];
          toolCounts[call.name] = (toolCounts[call.name] ?? 0) + 1;
          rt.activity('tool_result', truncate(res.output, 5000), { taskId: task?.id, agentId, nodeId: node?.id, data: { ok: res.ok, name: call.name, callId: acts[i].id } });
          messages.push({ role: 'tool', toolCallId: call.id, toolName: call.name, content: truncate(res.output, 12000) });
        });
      }
    }
    if (!finalText && steps >= maxSteps && tools) {
      messages.push({ role: 'user', content: '已达到本轮工具调用步数上限。请不要再调用工具，直接给出最终结论（按要求的格式）。' });
      const r = await llmFit();
      messages.push({ role: 'assistant', content: r.text });
      finalText = r.text;
    }
    rt.audit.record(agentId, 'run_end', { runId, exit: 'ok', steps }, task?.id);
    return { text: finalText, messages, model, runId, steps, toolCounts };
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

/** Built-in tools that only read: consecutive calls to these run concurrently within one step. */
const PARALLEL_SAFE = new Set<string>(['list_dir', 'read_file', 'search', 'outline', 'load_skill', 'view_changes', 'lsp', 'mcp_list_resources', 'mcp_read_resource']);

/** Split one step's tool calls into batches: runs of read-only built-ins together, everything else alone, order kept. */
export function toolBatches<T extends { name: string }>(calls: T[]): T[][] {
  const out: T[][] = [];
  for (const c of calls) {
    const last = out[out.length - 1];
    if (last && PARALLEL_SAFE.has(c.name) && PARALLEL_SAFE.has(last[0].name)) last.push(c);
    else out.push([c]);
  }
  return out;
}

const DOOM_WARN = 3;
const DOOM_ASK = 4;

/** Count identical consecutive calls (same tool, same arguments); returns the current streak. */
export function trackLoop(loop: { sig: string; streak: number }, name: string, args: Record<string, unknown>): number {
  const sig = `${name}:${stableJson(args)}`;
  if (sig === loop.sig) loop.streak++;
  else {
    loop.sig = sig;
    loop.streak = 1;
  }
  return loop.streak;
}

function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${stableJson((v as Record<string, unknown>)[k])}`).join(',')}}`;
  return JSON.stringify(v) ?? 'null';
}

/** executeTool plus the doom-loop guard: warn on the 3rd identical call, ask the emperor from the 4th. */
async function runToolGuarded(ctx: Parameters<typeof executeTool>[0], name: string, args: Record<string, unknown>, streak: number, desc: string, resetLoop: () => void): Promise<{ ok: boolean; output: string }> {
  const { rt, task, agentId, node } = ctx;
  if (streak >= DOOM_ASK) {
    rt.audit.record(agentId, 'doom_loop', { tool: name, streak }, task?.id);
    const ok = await rt.requestApproval({ kind: 'loop', taskId: task?.id, agentId, nodeId: node?.id, tool: name, summary: `疑似死循环：${desc}`, detail: `${agentName(agentId)} 已连续 ${streak} 次用相同参数调用 ${name}，结果大概率不会变化。\n准许则继续执行这一次；驳回则让它换个做法或直接给出结论。\n\n参数：\n${truncate(JSON.stringify(args, null, 2), 2000)}`, risk: 'normal', reason: '疑似死循环' });
    if (!ok) return { ok: false, output: '皇上叫停了这次重复调用。不要再用相同参数重复调用，请换一种做法；做不下去就直接给出结论，说明卡在哪里。' };
    resetLoop();
  }
  const res = await executeTool(ctx, name, args);
  if (streak === DOOM_WARN) return { ...res, output: `${res.output}\n\n【系统提示】你已连续 ${streak} 次用相同参数调用 ${name}，结果不会因此改变。请换一种做法，或直接给出结论。` };
  return res;
}

function sanitizeArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) out[k] = typeof v === 'string' && v.length > 600 ? `${v.slice(0, 600)}…(${v.length} chars)` : v;
  return out;
}
