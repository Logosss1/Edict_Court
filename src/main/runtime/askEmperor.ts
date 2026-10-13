// E1 · 请旨: an official stops and asks the emperor a question (with optional answer options) instead of
// guessing. Reuses the approval wait (the official kneels in court); the answer comes back as the tool result.
// 太子追问 (below): at triage the prince may put one short question before the edict goes to 中书省.
import type { ApprovalChoice, EdictQuestion, Task } from '../../shared/types';
import type { ToolSpec } from '../llm/types';
import { TERMINAL, agentName, courtAddress } from '../../shared/court';
import type { Runtime } from './runtime';
import type { ToolContext } from './tools';
import { now, truncate, uid } from './util';

export const ASK_EMPEROR_SPEC: ToolSpec = {
  name: 'ask_emperor',
  description: '向皇上请旨：需求含糊、几种做法差别很大、或缺少只有皇上知道的信息（偏好、账号、取舍）时使用。能自己合理判断的不要问；一次只问一个问题，尽量给 2~4 个选项。问题以臣子口吻、第一人称写，例如「臣对“兼容旧版”一句不甚明白：要支持到哪个版本？」；不要写称呼，系统会自动加上「皇上，」。',
  parameters: {
    type: 'object',
    properties: {
      question: { type: 'string', description: '要问的问题：以臣子口吻一句话说清楚，不写称呼（如「臣不知登录失败的提示该放在何处？」）' },
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
  rt.activity('log', `${who}请旨：${courtAddress(agentId, q.question)}${options.length ? `（${options.join(' / ')}）` : ''}`, { taskId: task?.id, agentId, nodeId: node?.id });
  rt.audit.record(agentId, 'ask_emperor', { id: q.id, question: q.question, options }, task?.id);

  const choices: ApprovalChoice[] = [
    ...options.map((o, i): ApprovalChoice => ({ id: `o${i}`, label: o, approve: true, tone: i === 0 ? 'primary' : undefined, comment: 'optional' })),
    { id: 'free', label: options.length ? '另行口谕' : '回复', hint: '写下你的答复', approve: true, tone: options.length ? undefined : 'primary', comment: 'required' },
    { id: 'self', label: '你自己判断', hint: fallback ? `按它说的默认做法：${truncate(fallback, 80)}` : '按最合理的理解继续，并在结论里写明假设', approve: true, comment: 'optional' },
  ];
  const timeoutMin = askTimeout(rt, task);
  let apId = '';
  const decision = rt.requestDecision({
    kind: 'question', taskId: task?.id, agentId, nodeId: node?.id, tool: 'ask_emperor',
    summary: `${who}请旨：${courtAddress(agentId, truncate(q.question, 120))}`,
    detail: [context && `缘由：${truncate(context, 1500)}`, fallback && `皇上没空答复时：${truncate(fallback, 300)}`].filter(Boolean).join('\n'),
    risk: 'normal', reason: timeoutMin > 0 ? `全自动模式：${timeoutMin} 分钟内未答复将按默认继续` : '官员遇到需要皇上定夺的问题',
    choices,
  }, { onId: (id) => (apId = id) });
  const timer = autoAnswer(rt, timeoutMin, () => apId);
  const d = await decision;
  timer.clear();
  const timedOut = timer.fired();
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

/** 全自动 mode only: minutes after which an unanswered 请旨 continues on the asker's default (0 = wait). */
const askTimeout = (rt: Runtime, task?: Task) => (rt.modeFor(task) === 'auto' ? rt.settings.askTimeoutMin ?? 0 : 0);

/** After `min` minutes the system answers a still-pending question card (the asker's default then applies). */
function autoAnswer(rt: Runtime, min: number, apId: () => string) {
  let fired = false;
  const timer = min > 0
    ? setTimeout(() => {
        if (rt.approvals.get(apId())?.status !== 'pending') return;
        fired = true;
        rt.decideApproval(apId(), true, 'system');
      }, min * 60_000)
    : undefined;
  timer?.unref?.();
  return { fired: () => fired, clear: () => timer && clearTimeout(timer) };
}

// ───────────────────────── 太子追问 ─────────────────────────
// When the edict lacks something that changes the work, triage may return {"type":"ask",…}: the edict is created and
// waits in 太子分拣 (no node runs) while ONE question goes to the emperor. The answer is appended to the edict text
// that every later stage reads, then the edict is driven on. The prince never asks twice about the same edict.

export interface PrinceAsk {
  question: string;
  options: string[];
  /** what the prince goes with on 「不必问，照办」 */
  assume: string;
}

/** Triage JSON → the prince's question; null unless it is a well-formed `ask`. */
export function parsePrinceAsk(j: { type?: unknown; question?: unknown; options?: unknown; assume?: unknown } | null | undefined): PrinceAsk | null {
  if (!j || j.type !== 'ask' || typeof j.question !== 'string' || !j.question.trim()) return null;
  const options = (Array.isArray(j.options) ? j.options : []).map((o) => String(o).trim()).filter(Boolean).slice(0, 3);
  return { question: truncate(j.question.trim(), 500), options, assume: typeof j.assume === 'string' ? truncate(j.assume.trim(), 500) : '' };
}

// questions with a live card in this process (cards are not persisted, so none survive a restart)
const openByRt = new WeakMap<Runtime, Set<string>>();
const openAsks = (rt: Runtime) => {
  let s = openByRt.get(rt);
  if (!s) {
    s = new Set();
    openByRt.set(rt, s);
  }
  return s;
};

/** The prince's question on this edict that has not been answered yet. */
export const princeQuestion = (t: Task) => (t.questions ?? []).find((q) => q.agentId === 'taizi' && !q.answeredAt);

/** Record the prince's question on a freshly triaged edict and put it to the emperor (returns at once). */
export function askPrince(rt: Runtime, t: Task, a: PrinceAsk) {
  if (t.questions?.some((q) => q.agentId === 'taizi')) return; // at most one per edict
  const q: EdictQuestion = { id: uid('q'), agentId: 'taizi', nodeId: 'triage', question: a.question, options: a.options, assume: a.assume, at: now() };
  t.questions = [...(t.questions ?? []), q];
  rt.touch(t);
  rt.activity('log', `太子请旨：${courtAddress('taizi', q.question)}${q.options.length ? `（${q.options.join(' / ')}）` : ''}`, { taskId: t.id, agentId: 'taizi', nodeId: 'triage' });
  rt.audit.record('taizi', 'ask_emperor', { id: q.id, question: q.question, options: q.options, assume: q.assume ?? '' }, t.id);
  putPrinceQuestion(rt, t, q);
}

/**
 * Checked before each step: true while the prince's question is unanswered, so the edict stays in 太子分拣.
 * After a restart the card is gone — the same question is put to the emperor again instead of moving on.
 */
export function princeWaiting(rt: Runtime, t: Task): boolean {
  const q = princeQuestion(t);
  if (!q) return false;
  if (!openAsks(rt).has(q.id)) {
    rt.activity('log', `太子再次请旨（此前未获答复）：${courtAddress('taizi', q.question)}`, { taskId: t.id, agentId: 'taizi', nodeId: 'triage' });
    putPrinceQuestion(rt, t, q);
  }
  return true;
}

function putPrinceQuestion(rt: Runtime, t: Task, q: EdictQuestion) {
  const open = openAsks(rt);
  open.add(q.id);
  const assume = q.assume ?? '';
  const choices: ApprovalChoice[] = [
    ...q.options.map((o, i): ApprovalChoice => ({ id: `o${i}`, label: o, approve: true, tone: i === 0 ? 'primary' : undefined, comment: 'optional' })),
    { id: 'free', label: '回复', hint: '写下你的答复', approve: true, tone: q.options.length ? undefined : 'primary', comment: 'required' },
    { id: 'self', label: '不必问，照办', hint: assume ? `照太子所拟：${truncate(assume, 80)}` : '按太子的理解去办', approve: true, comment: 'optional' },
  ];
  const timeoutMin = askTimeout(rt, t);
  const summary = `太子请旨：${courtAddress('taizi', truncate(q.question, 120))}`;
  let apId = '';
  const decision = rt.requestDecision({
    kind: 'question', taskId: t.id, agentId: 'taizi', nodeId: 'triage', tool: 'ask_emperor', summary,
    detail: assume ? `若不必问，太子照此办理：${truncate(assume, 300)}` : '',
    risk: 'normal', reason: timeoutMin > 0 ? `全自动模式：${timeoutMin} 分钟内未答复将照太子所拟继续` : '旨意有不清楚之处，太子先问一句再办',
    choices,
  }, { onId: (id) => (apId = id) });
  const timer = autoAnswer(rt, timeoutMin, () => apId);
  void decision.then((d) => {
    timer.clear();
    open.delete(q.id);
    const ag = rt.agents.get('taizi');
    if (ag?.status === 'waiting' && ag.activity === `等待批准：${summary}`) rt.setAgent('taizi', { status: 'idle', activity: '' });
    // cancelled (or the app is closing) while waiting: the edict does not move on
    if (rt.tasks.get(t.id) !== t || TERMINAL.includes(t.state) || rt.controllers.get(t.id)?.signal.aborted || q.answeredAt) return;
    const fallback = assume ? `照太子所拟：${assume}` : '照太子的理解去办';
    if (timer.fired()) {
      q.how = 'timeout';
      q.answer = `（${timeoutMin} 分钟未答复）${fallback}`;
    } else if (!d.approve) {
      q.how = 'none';
      q.answer = `未答复，${fallback}${d.comment ? `（${d.comment}）` : ''}`;
    } else if (d.choice?.startsWith('o')) {
      const picked = q.options[Number(d.choice.slice(1))] ?? '';
      q.how = 'option';
      q.answer = d.comment ? `${picked}（${d.comment}）` : picked;
    } else if (d.choice === 'free') {
      q.how = 'free';
      q.answer = d.comment ?? '';
    } else {
      q.how = 'self';
      q.answer = `不必问，${fallback}${d.comment ? `（${d.comment}）` : ''}`;
    }
    q.answeredAt = now();
    t.edict = `${t.edict}\n\n【太子请旨】${q.question}\n【皇上示下】${q.answer}`;
    rt.activity('human', `皇上答复太子：${q.answer}`, { taskId: t.id, agentId: 'taizi', nodeId: 'triage' });
    rt.audit.record(timer.fired() ? 'system' : 'emperor', 'ask_emperor_answered', { id: q.id, how: q.how, answer: q.answer }, t.id);
    rt.touch(t);
    rt.driveHook(t.id);
  });
}
