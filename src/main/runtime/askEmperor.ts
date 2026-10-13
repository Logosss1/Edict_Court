// E1 · 请旨: an official stops and asks the emperor a question (with optional answer options) instead of
// guessing. Reuses the approval wait (the official kneels in court); the answer comes back as the tool result.
import type { ApprovalChoice, EdictQuestion } from '../../shared/types';
import type { ToolSpec } from '../llm/types';
import { agentName } from '../../shared/court';
import type { ToolContext } from './tools';
import { now, truncate, uid } from './util';

export const ASK_EMPEROR_SPEC: ToolSpec = {
  name: 'ask_emperor',
  description: '向皇上请旨：需求含糊、几种做法差别很大、或缺少只有皇上知道的信息（偏好、账号、取舍）时使用。能自己合理判断的不要问；一次只问一个问题，尽量给 2~4 个选项。',
  parameters: {
    type: 'object',
    properties: {
      question: { type: 'string', description: '要问的问题，一句话说清楚' },
      options: { type: 'array', items: { type: 'string' }, description: '可选：2~4 个备选答案' },
      default: { type: 'string', description: '可选：皇上没空答复时你会怎么做' },
      context: { type: 'string', description: '可选：为什么要问、你目前的理解' },
    },
    required: ['question'],
    additionalProperties: false,
  },
};

const MAX_OPTIONS = 6;
const MAX_PER_NODE = 3;

export async function askEmperor(ctx: ToolContext, args: Record<string, unknown>): Promise<{ ok: boolean; output: string }> {
  const { rt, task, node, agentId } = ctx;
  const question = typeof args.question === 'string' ? args.question.trim() : '';
  if (!question) return { ok: false, output: '请写明要问皇上的问题（question）' };
  const options = (Array.isArray(args.options) ? args.options : []).map((o) => String(o).trim()).filter(Boolean).slice(0, MAX_OPTIONS);
  const fallback = typeof args.default === 'string' ? args.default.trim() : '';
  const context = typeof args.context === 'string' ? args.context.trim() : '';
  if (task && node && (task.questions ?? []).filter((q) => q.nodeId === node.id).length >= MAX_PER_NODE)
    return { ok: false, output: `本子任务已请旨 ${MAX_PER_NODE} 次，不能再问了：请按最合理的理解继续，并在结论里写明你的假设。` };

  const q: EdictQuestion = { id: uid('q'), agentId, nodeId: node?.id, question: truncate(question, 500), options, at: now() };
  if (task) {
    task.questions = [...(task.questions ?? []), q];
    rt.touch(task);
  }
  const who = agentName(agentId);
  rt.activity('log', `${who}请旨：${q.question}${options.length ? `（${options.join(' / ')}）` : ''}`, { taskId: task?.id, agentId, nodeId: node?.id });
  rt.audit.record(agentId, 'ask_emperor', { id: q.id, question: q.question, options }, task?.id);

  const choices: ApprovalChoice[] = [
    ...options.map((o, i): ApprovalChoice => ({ id: `o${i}`, label: o, approve: true, tone: i === 0 ? 'primary' : undefined, comment: 'optional' })),
    { id: 'free', label: options.length ? '另行口谕' : '回复', hint: '写下你的答复', approve: true, tone: options.length ? undefined : 'primary', comment: 'required' },
    { id: 'self', label: '你自己判断', hint: fallback ? `按它说的默认做法：${truncate(fallback, 80)}` : '按最合理的理解继续，并在结论里写明假设', approve: true, comment: 'optional' },
  ];
  const timeoutMin = rt.settings.permissionMode === 'auto' ? rt.settings.askTimeoutMin ?? 0 : 0;
  let timedOut = false;
  let apId = '';
  const decision = rt.requestDecision({
    kind: 'question', taskId: task?.id, agentId, nodeId: node?.id, tool: 'ask_emperor',
    summary: `${who}请旨：${truncate(q.question, 120)}`,
    detail: [context && `缘由：${truncate(context, 1500)}`, fallback && `皇上没空答复时：${truncate(fallback, 300)}`].filter(Boolean).join('\n'),
    risk: 'normal', reason: timeoutMin > 0 ? `全自动模式：${timeoutMin} 分钟内未答复将按默认继续` : '官员遇到需要皇上定夺的问题',
    choices,
  }, { onId: (id) => (apId = id) });
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (timeoutMin > 0) {
    timer = setTimeout(() => {
      if (rt.approvals.get(apId)?.status !== 'pending') return;
      timedOut = true;
      rt.decideApproval(apId, true, 'system');
    }, timeoutMin * 60_000);
    timer.unref?.();
  }
  const d = await decision;
  if (timer) clearTimeout(timer);
  if (ctx.signal?.aborted) return { ok: false, output: '旨意已停止。' };

  let output: string;
  if (timedOut) {
    q.how = 'timeout';
    q.answer = fallback ? `（${timeoutMin} 分钟未答复）按默认：${fallback}` : `（${timeoutMin} 分钟未答复）自行判断`;
    output = `${timeoutMin} 分钟内皇上未答复。${fallback ? `按你说的默认做法继续：${fallback}` : '请按最合理的理解继续'}，并在结论里写明这一点。`;
  } else if (!d.approve) {
    q.how = 'none';
    output = `皇上没有答复这个问题${d.comment ? `（批示：${d.comment}）` : ''}。请按最合理的理解继续，并在结论里写明你的假设。`;
  } else if (d.choice?.startsWith('o')) {
    const picked = options[Number(d.choice.slice(1))] ?? '';
    q.how = 'option';
    q.answer = d.comment ? `${picked}（${d.comment}）` : picked;
    output = `皇上选择：${picked}${d.comment ? `\n皇上批示：${d.comment}` : ''}`;
  } else if (d.choice === 'free') {
    q.how = 'free';
    q.answer = d.comment ?? '';
    output = `皇上口谕：${d.comment ?? ''}`;
  } else {
    q.how = 'self';
    q.answer = `由你判断${d.comment ? `（${d.comment}）` : ''}`;
    output = `皇上让你自己判断${d.comment ? `：${d.comment}` : ''}。${fallback ? `可按你说的默认做法：${fallback}。` : ''}请在结论里写明你的假设。`;
  }
  q.answeredAt = now();
  if (task) rt.touch(task);
  rt.activity('human', `皇上答复${who}：${q.answer ?? '（未答复）'}`, { taskId: task?.id, agentId, nodeId: node?.id });
  rt.audit.record(timedOut ? 'system' : 'emperor', 'ask_emperor_answered', { id: q.id, how: q.how, answer: q.answer ?? null }, task?.id);
  return { ok: true, output };
}
