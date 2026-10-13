// 三省六部 orchestration engine. State-driven and node-based: every step is a persisted
// RunNode, so an interrupted/failed node can be retried locally without replaying the
// whole agent tree. 门下省 review is structural — there is no code path from Zhongshu to
// Assigned that does not pass a Menxia verdict (or the emperor's explicit decision).
import type { CollabDesign, DesignPin, MinistryId, ModelRef, Plan, Review, RunNode, Session, Subtask, Task, Tier } from '../../shared/types';
import { emptyUsage } from '../../shared/types';
import { AGENT_MAP, MINISTRIES, STATE_LABEL, TERMINAL, agentName } from '../../shared/court';
import { runAgent } from './agentLoop';
import { LlmCallError } from '../llm/types';
import { EXEC_OUTPUT_RULE } from './souls';
import { ALL_TOOLS, READ_TOOLS } from './tools';
import { TaskAbortedError, type Runtime } from './runtime';
import { extractJson, now, sha256, truncate, uid } from './util';
import { createDebate, runDebate, concludeDebate } from './debate';
import { checkEvidence, confirmWriteTask, effectOf, execBlockReason, grantPrompt, nodeConclusion, parseConclusion, scheduleExec, toolsForNode } from './execPolicy';
export { parseConclusion, type ExecConclusion } from './execPolicy';
import { flowDecideGate, flowStep } from './flow';
import { canonBlock } from './canon';
import { BUILTIN_DESIGN_ID, PHASE_STATE } from '../../shared/design';

const drivingByRt = new WeakMap<Runtime, Set<string>>();
const drivingSet = (rt: Runtime) => {
  let s = drivingByRt.get(rt);
  if (!s) {
    s = new Set();
    drivingByRt.set(rt, s);
  }
  return s;
};

export function installOrchestrator(rt: Runtime) {
  rt.driveHook = (id) => void drive(rt, id);
}

export interface SubmitInput {
  text: string;
  tier: Tier;
  multiAgent: boolean;
  model?: ModelRef | null;
  forceEdict?: boolean;
  templateId?: string;
  withDebate?: boolean;
  sessionId?: string;
  effort?: string; // 思考程度 slider: a level name, 'default' or 'top'
  designId?: string; // 协同设计（缺省 = 内置三省六部）
}

export type SubmitResult = { kind: 'chat'; sessionId: string; reply: string } | { kind: 'task'; taskId: string };

// ───────────────────────── submission (下旨) ─────────────────────────
export async function submit(rt: Runtime, input: SubmitInput): Promise<SubmitResult> {
  const text = input.text.trim();
  if (!text) throw new Error('旨意内容为空');
  // a custom 协同设计 is pinned now (version + hash + snapshot); later switches never affect this edict
  const pinned = input.designId && input.designId !== BUILTIN_DESIGN_ID ? rt.designs.pin(input.designId) : undefined;
  const tier: Tier = pinned?.spec ? pinned.spec.policies.tier : input.multiAgent ? input.tier : 'solo';
  rt.audit.record('emperor', 'edict_submitted', { design: pinned ? `${pinned.pin.id}@${pinned.pin.version}` : null, tier, chars: text.length, templateId: input.templateId, effort: input.effort ?? null, model: input.model ? `${input.model.providerId}/${input.model.model}` : null });

  if (tier === 'solo') {
    let session = input.sessionId ? rt.sessions.get(input.sessionId) : undefined;
    if (!session) {
      session = { id: uid('ss'), title: text.slice(0, 30), source: 'solo', agentId: 'solo', messages: [], createdAt: now(), updatedAt: now(), status: 'active', usage: emptyUsage() };
      rt.sessions.set(session.id, session);
      const a = rt.agents.get('solo');
      if (a) a.sessions++;
    }
    session.messages.push({ role: 'user', content: text, at: now() });
    session.updatedAt = now();
    const task = createTask(rt, { text, tier, title: text.replace(/\s+/g, ' ').slice(0, 28), model: input.model ?? null, sessionId: session.id, templateId: input.templateId, effort: input.effort });
    session.taskId = task.id;
    rt.emit({ type: 'session', session });
    void drive(rt, task.id);
    return { kind: 'task', taskId: task.id };
  }

  // 太子分拣
  let title = text.replace(/\s+/g, ' ').slice(0, 20);
  let triageOutput = '{"type":"edict","reason":"皇上直接下旨"}';
  const session: Session = { id: uid('ss'), title: text.slice(0, 30), source: 'taizi-chat', agentId: 'taizi', messages: [{ role: 'user', content: text, at: now() }], createdAt: now(), updatedAt: now(), status: 'active', usage: emptyUsage() };
  if (!input.forceEdict) {
    rt.sessions.set(session.id, session);
    rt.emit({ type: 'session', session });
    const ta = rt.agents.get('taizi');
    if (ta) ta.sessions++;
    const r = await runAgent({ rt, agentId: 'taizi', session, prompt: `皇上输入：\n${text}`, maxTokens: 800, temperature: 0.2, label: '太子分拣' });
    let j = extractJson<{ type?: string; title?: string; reply?: string; reason?: string }>(r.text);
    if (!j) {
      const r2 = await runAgent({ rt, agentId: 'taizi', session, history: r.messages, prompt: '请只输出规定的 JSON 对象。', maxTokens: 600, temperature: 0, label: '太子分拣（格式修正）' });
      j = extractJson(r2.text);
    }
    triageOutput = JSON.stringify(j ?? { type: 'edict', reason: '分拣输出无法解析，按旨意处理' });
    if (j?.type === 'chat' && j.reply) {
      session.messages.push({ role: 'assistant', content: j.reply, at: now() });
      session.status = 'done';
      session.updatedAt = now();
      rt.emit({ type: 'session', session });
      rt.activity('log', `太子分拣：闲聊直答（${j.reason ?? ''}）`, { agentId: 'taizi' });
      rt.persist();
      return { kind: 'chat', sessionId: session.id, reply: j.reply };
    }
    if (j?.title) title = String(j.title).slice(0, 40);
    session.messages.push({ role: 'assistant', content: `已分拣为旨意：${title}`, at: now() });
    session.status = 'done';
    rt.emit({ type: 'session', session });
  }
  const task = createTask(rt, { text, tier, title, model: input.model ?? null, withDebate: pinned ? false : (input.withDebate ?? (tier === 'full' && rt.settings.debateBeforePlan)), templateId: input.templateId, effort: input.effort, design: pinned });
  task.nodes.push({ id: 'triage', kind: 'triage', agentId: 'taizi', label: '太子分拣', status: 'done', attempts: 1, startedAt: now(), endedAt: now(), exitStatus: 'ok', output: triageOutput, usage: session.usage });
  rt.transition(task, 'Taizi', 'taizi', '太子接旨分拣');
  void drive(rt, task.id);
  return { kind: 'task', taskId: task.id };
}

export function createTask(rt: Runtime, o: { text: string; tier: Tier; title: string; model: ModelRef | null; withDebate?: boolean; sessionId?: string; templateId?: string; effort?: string; design?: { pin: DesignPin; spec?: CollabDesign } }): Task {
  const s = rt.settings;
  const design = o.design ?? rt.designs.pin(BUILTIN_DESIGN_ID);
  const pol = design.spec?.policies;
  const est = rt.estimate(o.text, o.tier, o.model);
  const t: Task = {
    id: rt.newTaskId(), title: o.title, edict: o.text, tier: o.tier, state: 'Pending', createdAt: now(), updatedAt: now(),
    workspace: rt.workspace?.root ?? null,
    flow: [{ at: now(), from: '皇上', to: o.tier === 'solo' ? '独相' : '太子', remark: '下旨', state: 'Pending' }],
    planHistory: [], reviews: [], nodes: [], paused: false, changes: [], usage: emptyUsage(),
    budget: { maxTokens: pol?.tokenBudget || s.budgets[o.tier], maxRejections: pol ? pol.maxRejections : o.tier === 'full' ? s.maxRejections.full : s.maxRejections.lite, maxCostUsd: s.maxCostUsd },
    design: design.pin, designSpec: design.spec, flowRun: design.spec ? { cursor: 0, iter: {}, rejections: {} } : undefined,
    estimate: { tokens: est.tokens, costUsd: est.costUsd },
    strongModel: o.model ?? undefined, withDebate: o.withDebate, sessionId: o.sessionId, templateId: o.templateId, effort: o.effort && o.effort !== 'default' ? o.effort : undefined, lastActivityAt: now(), execRound: 1,
  };
  rt.tasks.set(t.id, t);
  rt.audit.record('emperor', 'edict_issued', { id: t.id, title: t.title, tier: t.tier, estimate: t.estimate, budget: t.budget, workspace: t.workspace, design: { id: design.pin.id, version: design.pin.version, hash: design.pin.hash } }, t.id);
  rt.activity('human', `皇上下旨（${design.spec ? `协同设计「${design.pin.name}」v${design.pin.version}` : t.tier}）：${t.title}`, { taskId: t.id });
  rt.touch(t);
  return t;
}

// ───────────────────────── driver ─────────────────────────
export async function drive(rt: Runtime, taskId: string): Promise<void> {
  const driving = drivingSet(rt);
  if (driving.has(taskId)) return;
  driving.add(taskId);
  let ws: string | null = null;
  try {
    for (let guard = 0; guard < 300; guard++) {
      const t = rt.tasks.get(taskId);
      if (!t) return;
      ws = t.workspace;
      if (TERMINAL.includes(t.state) || t.state === 'Blocked' || t.paused || t.gate) return;
      const progressed = await step(rt, t);
      if (!progressed) return;
    }
  } catch (e) {
    const t = rt.tasks.get(taskId);
    if (!t || e instanceof TaskAbortedError || TERMINAL.includes(t.state)) return;
    if (t.state !== 'Blocked') block(rt, t, (e as Error).message);
  } finally {
    driving.delete(taskId);
    kickQueued(rt, ws);
  }
}

function kickQueued(rt: Runtime, ws: string | null) {
  for (const t of rt.tasks.values()) if (t.state === 'Next' && t.workspace === ws && !drivingSet(rt).has(t.id)) void drive(rt, t.id);
}

export function block(rt: Runtime, t: Task, reason: string) {
  t.resumeState = t.state;
  t.blockedReason = reason;
  try {
    rt.transition(t, 'Blocked', 'system', truncate(reason, 300));
  } catch {
    /* already terminal */
  }
  rt.notifyDesktop('attention', '旨意阻塞', `${t.title}：${truncate(reason, 80)}`);
}

export class NodeFailedError extends Error {}

export async function runNode(rt: Runtime, t: Task, node: RunNode, fn: () => Promise<string>): Promise<string> {
  node.status = 'running';
  node.attempts++;
  node.startedAt = now();
  node.endedAt = undefined;
  node.error = undefined;
  node.errorInfo = undefined;
  node.sideEffects = false;
  rt.touch(t);
  rt.activity('log', `▶ ${node.label}（${agentName(node.agentId)}）${node.attempts > 1 ? ` 第 ${node.attempts} 次` : ''}`, { taskId: t.id, agentId: node.agentId, nodeId: node.id });
  // wall-clock limit per node (time spent waiting on the emperor does not count)
  const key = `${t.id}/${node.id}`;
  const ctl = new AbortController();
  rt.nodeControllers.set(key, ctl);
  const limitMin = Math.max(0, rt.settings.nodeTimeoutMin ?? 30);
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = (ms: number) => {
    timer = setTimeout(() => {
      if (waitingOnEmperor(rt, t, node)) return arm(60_000);
      timedOut = true;
      rt.audit.record('system', 'node_timeout', { node: node.id, minutes: limitMin }, t.id);
      ctl.abort();
    }, ms);
    timer.unref?.();
  };
  if (limitMin) arm(limitMin * 60_000);
  try {
    const out = await fn();
    node.output = out;
    node.status = 'done';
    node.exitStatus = 'ok';
    node.endedAt = now();
    const a = rt.agents.get(node.agentId);
    if (a) a.completed++;
    rt.touch(t);
    return out;
  } catch (err) {
    let e = err;
    node.endedAt = now();
    const taskAborted = rt.controllers.get(t.id)?.signal.aborted;
    if (timedOut && !taskAborted) e = new Error(`超过单节点时限 ${limitMin} 分钟，已终止。可局部重试，或在「设置」里调整时限`);
    else if (e instanceof TaskAbortedError || taskAborted) {
      node.status = 'cancelled';
      node.exitStatus = 'cancelled';
      rt.touch(t);
      throw new TaskAbortedError();
    }
    node.status = 'failed';
    node.exitStatus = 'error';
    node.error = (e as Error).message;
    if (e instanceof LlmCallError) node.errorInfo = e.info;
    rt.activity('error', `✖ ${node.label} 失败：${node.error}`, { taskId: t.id, agentId: node.agentId, nodeId: node.id });
    rt.audit.record(node.agentId, 'node_failed', { node: node.id, error: truncate(node.error, 300), kind: node.errorInfo?.kind ?? null, runId: node.runId }, t.id);
    rt.touch(t);
    throw new NodeFailedError(`${node.label} 失败：${node.error}`);
  } finally {
    if (timer) clearTimeout(timer);
    rt.nodeControllers.delete(key);
    rt.releaseWriteLock(t.id, node.id);
  }
}

const waitingOnEmperor = (rt: Runtime, t: Task, node: RunNode) => t.paused || !!t.gate || [...rt.approvals.values()].some((a) => a.status === 'pending' && a.taskId === t.id && (!a.nodeId || a.nodeId === node.id));

export function ensureNode(t: Task, id: string, init: Omit<RunNode, 'id' | 'status' | 'attempts'>): RunNode {
  let n = t.nodes.find((x) => x.id === id);
  if (!n) {
    n = { id, status: 'pending', attempts: 0, ...init };
    t.nodes.push(n);
  }
  return n;
}

const planReviews = (t: Task) => t.reviews.filter((r) => r.stage === 'plan');

async function step(rt: Runtime, t: Task): Promise<boolean> {
  // 协同设计（非内置）由解释器驱动；内置三省六部继续走下面的原生引擎
  if (t.designSpec && t.design && !t.design.native && t.state !== 'Pending') return flowStep(rt, t);
  switch (t.state) {
    case 'Pending':
      rt.transition(t, t.tier === 'solo' ? 'Doing' : 'Taizi', 'system', t.tier === 'solo' ? 'Solo 直接执行，无需三省流转' : '太子接旨');
      return true;
    case 'Taizi':
      rt.transition(t, 'Zhongshu', 'taizi', '太子传旨中书省');
      return true;
    case 'Zhongshu':
      return stepZhongshu(rt, t);
    case 'Menxia':
      return stepMenxia(rt, t);
    case 'Assigned':
      return stepAssigned(rt, t);
    case 'Next': {
      if (otherDoing(rt, t)) return false;
      rt.transition(t, 'Doing', 'shangshu', '工作区空闲，开始执行');
      return true;
    }
    case 'Doing':
      return t.tier === 'solo' ? stepSolo(rt, t) : stepDoing(rt, t);
    case 'Review':
      return stepReview(rt, t);
    case 'PendingConfirm':
      if (!t.gate) rt.setGate(t, { kind: 'final', message: '请御览回奏与改动，准奏则结案，封驳则发回返工' });
      return false;
    default:
      return false;
  }
}

export function otherDoing(rt: Runtime, t: Task) {
  return [...rt.tasks.values()].some((x) => x.id !== t.id && x.state === 'Doing' && x.tier !== 'solo' && x.workspace && x.workspace === t.workspace);
}

// ───────────────────────── 中书省 ─────────────────────────
export function repoContext(rt: Runtime, t: Task): string {
  if (!rt.workspace || t.workspace !== rt.workspace.root) return '（未打开工作区：本旨意不涉及本地文件，或仅产出文本。）';
  try {
    const map = rt.workspace.repoMap(120);
    const outline = rt.workspace.outlineMap(30, 10);
    return `【仓库地图】\n${truncate(map, 6000)}\n\n【符号大纲（节选）】\n${truncate(outline || '（无）', 5000)}`;
  } catch (e) {
    return `（仓库地图生成失败：${(e as Error).message}）`;
  }
}

/** E2: the workspace's rule files plus the emperor's 典章, for every prompt that plans, reviews or does the work. */
export function guidance(rt: Runtime, t: Task): string {
  return canonBlock(rt, t, rt.workspace && t.workspace === rt.workspace.root ? rt.workspace : null);
}

/** `allowed` = executor roles of a 协同设计 (id → name); default = the six ministries. */
export function validatePlan(p: unknown, allowed?: Record<string, string>): { plan?: Plan; error?: string } {
  const j = p as Partial<Plan> | null;
  if (!j || typeof j !== 'object') return { error: '不是 JSON 对象' };
  if (!Array.isArray(j.subtasks) || !j.subtasks.length) return { error: 'subtasks 为空' };
  const subs: Subtask[] = [];
  const ids = new Set<string>();
  for (const [i, s] of (j.subtasks as Partial<Subtask>[]).entries()) {
    const id = String(s.id ?? `S${i + 1}`).trim() || `S${i + 1}`;
    if (ids.has(id)) return { error: `子任务 id 重复：${id}` };
    ids.add(id);
    let dept = String(s.dept ?? '').trim() as MinistryId;
    const deptIds: string[] = allowed ? Object.keys(allowed) : MINISTRIES;
    if (!deptIds.includes(dept)) {
      const byName = deptIds.find((m) => (allowed ? allowed[m] : AGENT_MAP[m as MinistryId].name) === (s.dept as string));
      if (byName) dept = byName as MinistryId;
      else return { error: `子任务 ${id} 的${allowed ? '执行角色' : '部门'}无效：${s.dept}（应为 ${deptIds.join('/')}）` };
    }
    subs.push({ id, title: String(s.title ?? '').trim() || `子任务 ${id}`, dept, detail: String(s.detail ?? ''), acceptance: String(s.acceptance ?? ''), dependsOn: Array.isArray(s.dependsOn) ? s.dependsOn.map(String) : [], effect: effectOf(s) });
  }
  for (const s of subs) for (const d of s.dependsOn) if (!ids.has(d)) return { error: `子任务 ${s.id} 依赖不存在的 ${d}` };
  // cycle check
  const visiting = new Set<string>();
  const done = new Set<string>();
  const byId = new Map(subs.map((s) => [s.id, s]));
  const dfs = (id: string): boolean => {
    if (done.has(id)) return true;
    if (visiting.has(id)) return false;
    visiting.add(id);
    for (const d of byId.get(id)!.dependsOn) if (!dfs(d)) return false;
    visiting.delete(id);
    done.add(id);
    return true;
  };
  for (const s of subs) if (!dfs(s.id)) return { error: '子任务依赖存在环' };
  return { plan: { summary: String(j.summary ?? '').trim(), subtasks: subs, risks: Array.isArray(j.risks) ? j.risks.map(String) : [] } };
}

async function stepZhongshu(rt: Runtime, t: Task): Promise<boolean> {
  // optional 朝堂议政 before planning (Full Court)
  if (t.withDebate && t.tier === 'full') {
    const dn = ensureNode(t, 'debate', { kind: 'debate', agentId: 'zhongshu', label: '朝堂议政' });
    if (dn.status !== 'done') {
      await runNode(rt, t, dn, async () => {
        let d = t.debateId ? rt.debates.get(t.debateId) : undefined;
        if (!d) {
          d = createDebate(rt, { topic: t.edict, taskId: t.id, maxRounds: rt.settings.debateRounds });
          t.debateId = d.id;
          rt.touch(t);
        }
        await runDebate(rt, d.id);
        return d.conclusion ?? (await concludeDebate(rt, d.id));
      });
      return true;
    }
  }
  const latest = t.planHistory.at(-1);
  const lastRej = [...t.reviews].reverse().find((r) => r.stage === 'plan');
  const needPlan = !latest || (lastRej && lastRej.verdict === 'reject' && lastRej.at > latest.at);
  if (!needPlan) {
    rt.transition(t, 'Menxia', 'zhongshu', `中书省呈上方案 v${latest!.version}，请门下省审议`);
    return true;
  }
  const version = t.planHistory.length + 1;
  const node = ensureNode(t, `plan-${version}`, { kind: 'plan', agentId: 'zhongshu', label: version === 1 ? '中书规划' : `中书重拟 v${version}` });
  if (node.status === 'failed' || node.status === 'cancelled') return false;
  await runNode(rt, t, node, async () => {
    const parts = [`【旨意】${t.title}\n${t.edict}`, repoContext(rt, t), guidance(rt, t)].filter(Boolean);
    const debate = t.debateId ? rt.debates.get(t.debateId) : undefined;
    if (debate?.conclusion) parts.push(`【朝堂议政结论】\n${truncate(debate.conclusion, 3000)}`);
    if (latest && lastRej) {
      parts.push(`【上一版方案 v${latest.version}】\n${JSON.stringify(latest.plan, null, 1)}`);
      parts.push(`【${lastRej.reviewer === 'emperor' ? '皇上' : '门下省'}封驳意见（第 ${lastRej.round} 轮）】\n${lastRej.comment}\n${lastRej.issues.map((i, k) => `${k + 1}. ${i}`).join('\n')}\n必须逐条修正。`);
    }
    parts.push(t.tier === 'lite' ? '档位：Court Lite —— 子任务控制在 1~3 个，避免仪式性步骤。' : '档位：Full Court —— 子任务 2~6 个，充分利用六部并行，写清依赖。');
    parts.push('请输出方案 JSON。');
    const tools = rt.workspace && t.workspace === rt.workspace.root ? READ_TOOLS : undefined;
    const r = await runAgent({ rt, agentId: 'zhongshu', task: t, node, prompt: parts.join('\n\n'), tools, maxSteps: 6, maxTokens: 4000, temperature: 0.3, label: node.label });
    let v = validatePlan(extractJson(r.text));
    if (!v.plan) {
      rt.activity('log', `中书省方案格式不合规（${v.error}），要求修正`, { taskId: t.id, agentId: 'zhongshu', nodeId: node.id });
      const r2 = await runAgent({ rt, agentId: 'zhongshu', task: t, node, history: r.messages, prompt: `方案不合规：${v.error}。请只输出一个合法的方案 JSON 对象，不要其他文字。`, maxTokens: 4000, temperature: 0, label: '中书省修正格式' });
      v = validatePlan(extractJson(r2.text));
    }
    if (!v.plan) throw new Error(`中书省方案格式无效：${v.error}`);
    t.planHistory.push({ version, plan: v.plan, author: 'zhongshu', at: now() });
    t.plan = v.plan;
    const est = rt.estimate(t.edict + JSON.stringify(v.plan), t.tier, t.strongModel);
    t.estimate = { tokens: est.tokens + t.usage.inputTokens + t.usage.outputTokens, costUsd: +(est.costUsd + t.usage.costUsd).toFixed(4) };
    rt.audit.record('zhongshu', 'plan_submitted', { version, subtasks: v.plan.subtasks.map((s) => ({ id: s.id, dept: s.dept, title: s.title })), hash: sha256(JSON.stringify(v.plan)) }, t.id);
    return JSON.stringify(v.plan);
  });
  rt.transition(t, 'Menxia', 'zhongshu', `中书省呈上方案 v${version}，请门下省审议`);
  return true;
}

// ───────────────────────── 门下省 ─────────────────────────
export function parseVerdict(text: string): { verdict: 'approve' | 'reject'; issues: string[]; comment: string; rework: string[] } | null {
  const j = extractJson<{ verdict?: string; issues?: unknown; comment?: string; rework?: unknown }>(text);
  if (!j || typeof j !== 'object') return null;
  const v = String(j.verdict ?? '').toLowerCase();
  const verdict = ['approve', 'approved', '准奏', 'pass'].includes(v) ? 'approve' : ['reject', 'rejected', '封驳', 'fail'].includes(v) ? 'reject' : null;
  if (!verdict) return null;
  return { verdict, issues: Array.isArray(j.issues) ? j.issues.map(String) : [], comment: String(j.comment ?? ''), rework: Array.isArray(j.rework) ? j.rework.map(String) : [] };
}

async function stepMenxia(rt: Runtime, t: Task): Promise<boolean> {
  const latest = t.planHistory.at(-1);
  if (!latest) {
    rt.transition(t, 'Zhongshu', 'menxia', '无方案可审，退回中书省');
    return true;
  }
  const reviews = planReviews(t);
  const last = reviews.at(-1);
  if (last && last.at >= latest.at) {
    // verdict already given for the latest plan (e.g. after restart or emperor decision)
    if (last.verdict === 'approve') {
      rt.transition(t, 'Assigned', last.reviewer, last.reviewer === 'emperor' ? '皇上准奏' : '门下省准奏');
      return true;
    }
    rt.transition(t, 'Zhongshu', last.reviewer, `❌ 封驳：${last.comment}`);
    return true;
  }
  const round = reviews.length + 1;
  const node = ensureNode(t, `review-${round}`, { kind: 'review', agentId: 'menxia', label: `门下审议 第 ${round} 轮` });
  if (node.status === 'failed' || node.status === 'cancelled') return false;
  let verdict: ReturnType<typeof parseVerdict> = null;
  await runNode(rt, t, node, async () => {
    const prompt = [
      `【旨意】${t.title}\n${t.edict}`,
      `【中书省方案 v${latest.version}${latest.author === 'emperor' ? '（皇上涂改版）' : ''}】\n${JSON.stringify(latest.plan, null, 1)}`,
      reviews.length ? `【此前审议】\n${reviews.map((r) => `第${r.round}轮 ${r.verdict === 'approve' ? '准奏' : '封驳'}：${r.comment}`).join('\n')}` : '',
      guidance(rt, t),
      `这是第 ${round} 轮审议（封驳上限 ${t.budget.maxRejections} 次，超限将升级皇上裁决）。请从可行性、完整性、风险、资源四个维度审议，输出 JSON。`,
    ].filter(Boolean).join('\n\n');
    const tools = rt.workspace && t.workspace === rt.workspace.root ? READ_TOOLS : undefined;
    const r = await runAgent({ rt, agentId: 'menxia', task: t, node, prompt, tools, maxSteps: 4, maxTokens: 1500, temperature: 0.2, label: node.label });
    verdict = parseVerdict(r.text);
    if (!verdict) {
      const r2 = await runAgent({ rt, agentId: 'menxia', task: t, node, history: r.messages, prompt: '请只输出审议结论 JSON：{"verdict":"approve"|"reject","issues":[],"comment":""}', maxTokens: 800, temperature: 0, label: '门下省修正格式' });
      verdict = parseVerdict(r2.text);
    }
    return JSON.stringify(verdict ?? { error: '审议结论无法解析' });
  });
  if (!verdict) {
    rt.setGate(t, { kind: 'reject_limit', message: '门下省审议结论无法解析，封驳关卡不可跳过——请皇上亲自裁决（准奏 / 封驳 / 涂改）', nodeId: node.id });
    return false;
  }
  const v = verdict as NonNullable<ReturnType<typeof parseVerdict>>;
  const rev: Review = { round, stage: 'plan', verdict: v.verdict, issues: v.issues, comment: v.comment, reviewer: 'menxia', at: now() };
  t.reviews.push(rev);
  rt.audit.record('menxia', v.verdict === 'approve' ? 'plan_approved' : 'plan_rejected', { round, planVersion: latest.version, issues: v.issues, comment: v.comment }, t.id);
  rt.activity('log', `门下省${v.verdict === 'approve' ? '✅ 准奏' : '❌ 封驳'}：${v.comment}${v.issues.length ? '\n' + v.issues.map((i) => '· ' + i).join('\n') : ''}`, { taskId: t.id, agentId: 'menxia', nodeId: node.id, data: { verdict: v.verdict } });
  rt.touch(t);
  if (v.verdict === 'approve') {
    const gateOn = t.tier === 'full' ? rt.settings.planGate.full : rt.settings.planGate.lite;
    if (gateOn) {
      rt.setGate(t, { kind: 'plan', message: '门下省已准奏。请皇上御览方案——可直接涂改后放行，或封驳重拟', nodeId: node.id });
      return false;
    }
    rt.transition(t, 'Assigned', 'menxia', '门下省准奏');
    return true;
  }
  const rejections = planReviews(t).filter((r) => r.verdict === 'reject' && r.reviewer === 'menxia').length;
  if (rejections > t.budget.maxRejections) {
    rt.setGate(t, { kind: 'reject_limit', message: `门下省已封驳 ${rejections} 次，超出上限 ${t.budget.maxRejections}，请皇上裁决`, nodeId: node.id });
    return false;
  }
  rt.transition(t, 'Zhongshu', 'menxia', `❌ 封驳：${v.comment || v.issues[0] || '方案不达标'}`);
  return true;
}

// ───────────────────────── 尚书省派发 ─────────────────────────
async function stepAssigned(rt: Runtime, t: Task): Promise<boolean> {
  if (otherDoing(rt, t)) {
    rt.transition(t, 'Next', 'shangshu', '同一工作区已有旨意在执行，排队候旨');
    return false;
  }
  const plan = t.plan!;
  if (t.tier === 'full') {
    const v = t.planHistory.at(-1)?.version ?? 1;
    const node = ensureNode(t, `dispatch-${v}`, { kind: 'dispatch', agentId: 'shangshu', label: '尚书派发' });
    if (node.status === 'failed' || node.status === 'cancelled') return false;
    if (node.status !== 'done') {
      await runNode(rt, t, node, async () => {
        const r = await runAgent({ rt, agentId: 'shangshu', task: t, node, prompt: `【旨意】${t.title}\n${t.edict}\n\n【准奏方案】\n${JSON.stringify(plan, null, 1)}\n\n请为每个子任务写执行令，输出 JSON。`, tools: ['load_skill'], maxSteps: 4, maxTokens: 2500, temperature: 0.2, label: '尚书派发' });
        const j = extractJson<{ orders?: { subtaskId: string; instruction: string }[]; note?: string }>(r.text);
        const orders = (j?.orders ?? []).filter((o) => plan.subtasks.some((s) => s.id === o.subtaskId));
        return JSON.stringify({ orders, note: j?.note ?? '' });
      });
    }
  }
  rt.transition(t, 'Doing', 'shangshu', t.tier === 'full' ? '尚书省派发六部' : '直接派发六部（Court Lite 省去派发仪式）');
  return true;
}

// ───────────────────────── 六部执行 ─────────────────────────
function latestExecNode(t: Task, subId: string): RunNode | undefined {
  return [...t.nodes].reverse().find((n) => n.kind === 'exec' && n.subtaskId === subId);
}

async function stepDoing(rt: Runtime, t: Task): Promise<boolean> {
  const plan = t.plan!;
  const round = t.execRound ?? 1;
  const targets = round === 1 || !t.rework?.targets.length ? plan.subtasks.map((s) => s.id) : t.rework.targets.filter((id) => plan.subtasks.some((s) => s.id === id));
  const dispatch = [...t.nodes].reverse().find((n) => n.kind === 'dispatch' && n.status === 'done');
  const orders: Record<string, string> = {};
  try {
    for (const o of (JSON.parse(dispatch?.output ?? '{}').orders ?? []) as { subtaskId: string; instruction: string }[]) orders[o.subtaskId] = o.instruction;
  } catch {
    /* ignore */
  }
  const nodes = targets.map((id) => {
    const sub = plan.subtasks.find((s) => s.id === id)!;
    const n = ensureNode(t, `exec-${id}-r${round}`, { kind: 'exec', agentId: sub.dept, label: `${AGENT_MAP[sub.dept].name}·${sub.title}${round > 1 ? `（返工 ${round - 1}）` : ''}`, subtaskId: id, effect: effectOf(sub) });
    n.effect ??= effectOf(sub);
    return n;
  });
  rt.touch(t);
  const isDone = (subId: string) => latestExecNode(t, subId)?.status === 'done';
  await scheduleExec(nodes, {
    limit: Math.max(1, rt.settings.parallelism),
    ready: (n) => plan.subtasks.find((s) => s.id === n.subtaskId)!.dependsOn.every(isDone),
    run: (n) =>
      runExec(rt, t, n, orders[n.subtaskId!]).catch((e) => {
        if (e instanceof TaskAbortedError) throw e;
      }),
  });
  const stuck = nodes.filter((n) => n.status === 'pending');
  const bad = nodes.filter((n) => n.status === 'failed' || n.status === 'cancelled');
  if (bad.length || stuck.length) {
    block(rt, t, execBlockReason(bad, stuck));
    return false;
  }
  rt.transition(t, 'Review', 'shangshu', round > 1 ? `返工完成（第 ${round - 1} 次），汇总回奏` : '六部执行完毕，汇总回奏');
  return true;
}

async function runExec(rt: Runtime, t: Task, node: RunNode, order?: string): Promise<void> {
  const plan = t.plan!;
  const sub = plan.subtasks.find((s) => s.id === node.subtaskId)!;
  const hasWs = !!rt.workspace && t.workspace === rt.workspace.root;
  await confirmWriteTask(rt, t, node, sub, AGENT_MAP[sub.dept].name, hasWs);
  await runNode(rt, t, node, async () => {
    const deps = sub.dependsOn.map((d) => {
      const n = latestExecNode(t, d);
      return `- ${d}（${AGENT_MAP[plan.subtasks.find((s) => s.id === d)!.dept].name}）结论：${truncate(n?.output ?? '无', 1200)}`;
    });
    const prev = [...t.nodes].reverse().find((n) => n.kind === 'exec' && n.subtaskId === sub.id && n.id !== node.id && n.status === 'done');
    const parts = [
      `【旨意】${t.title}\n${truncate(t.edict, 3000)}`,
      `【方案概述】${plan.summary}`,
      `【你的子任务 ${sub.id}】${sub.title}\n做法：${sub.detail}\n验收标准：${sub.acceptance}`,
      order ? `【尚书省执行令】${order}` : '',
      deps.length ? `【上游子任务结论】\n${deps.join('\n')}` : '',
      node.id.endsWith('-r1') ? '' : `【返工要求（${t.rework?.by === 'emperor' ? '皇上' : '门下省'}）】\n${t.rework?.feedback ?? ''}\n【你上一轮的结论】${truncate(prev?.output ?? '无', 1500)}`,
      hasWs ? grantPrompt(node) : '',
      hasWs ? repoContext(rt, t) : '（未打开工作区：无法读写文件，请直接在结论中给出成果文本）',
      guidance(rt, t),
      EXEC_OUTPUT_RULE,
    ].filter(Boolean);
    const tools = toolsForNode(node, hasWs ? ALL_TOOLS : undefined);
    const r = await runAgent({ rt, agentId: sub.dept, task: t, node, prompt: parts.join('\n\n'), tools, maxSteps: 30, maxTokens: 8000, temperature: 0.2, label: node.label });
    let c = parseConclusion(r.text);
    if (!c.structured) {
      // one format-repair turn: same conversation, no tools, conclusion only
      const r2 = await runAgent({ rt, agentId: sub.dept, task: t, node, history: r.messages, prompt: `请只输出结构化结论，不要再调用工具。\n${EXEC_OUTPUT_RULE}`, maxTokens: 1500, temperature: 0, label: `${node.label}（结论格式修正）` });
      const c2 = parseConclusion(r2.text);
      if (c2.structured) c = c2;
    }
    const { conclusion, systemCheck } = checkEvidence(t, node, c, r.toolCounts, hasWs ? rt.workspace! : undefined);
    if (conclusion.status === 'failed') throw new Error(`${AGENT_MAP[sub.dept].name}自报失败：${conclusion.summary}`);
    if (conclusion.status === 'partial') rt.activity('log', `⚠ ${node.label} 成果存疑：${conclusion.issues.join('；') || '自报部分完成'}`, { taskId: t.id, agentId: node.agentId, nodeId: node.id });
    const { structured: _s, ...plain } = conclusion as typeof conclusion & { structured?: boolean };
    return JSON.stringify({ ...plain, systemCheck });
  });
}

/** Latest exec nodes whose conclusion is partial (成果存疑). */
function doubtfulNodes(t: Task): RunNode[] {
  return (t.plan?.subtasks ?? []).map((s) => latestExecNode(t, s.id)).filter((n): n is RunNode => !!n && nodeConclusion(n)?.status === 'partial');
}

const doubtText = (nodes: RunNode[]) => nodes.map((n) => `${n.label}（${(nodeConclusion(n)?.issues ?? []).slice(0, 2).join('；') || '自报部分完成'}）`).join('；');

// ───────────────────────── 回奏 & 成果审议 ─────────────────────────
async function stepReview(rt: Runtime, t: Task): Promise<boolean> {
  const round = t.execRound ?? 1;
  const plan = t.plan!;
  const sNode = ensureNode(t, `summary-r${round}`, { kind: 'summary', agentId: 'shangshu', label: round > 1 ? `尚书汇总（第 ${round} 轮）` : '尚书汇总回奏' });
  if (sNode.status === 'failed' || sNode.status === 'cancelled') return false;
  if (sNode.status !== 'done') {
    await runNode(rt, t, sNode, async () => {
      const concl = plan.subtasks.map((s) => `- ${s.id}（${AGENT_MAP[s.dept].name}）${s.title}：${truncate(latestExecNode(t, s.id)?.output ?? '无', 1500)}`);
      const changes = summarizeChanges(t);
      const r = await runAgent({ rt, agentId: 'shangshu', task: t, node: sNode, prompt: `【旨意】${t.title}\n${truncate(t.edict, 2000)}\n\n【各部结构化结论】\n${concl.join('\n')}\n\n【系统核验的文件改动】\n${changes || '无'}\n\n请撰写回奏折（Markdown）。`, tools: ['load_skill'], maxSteps: 4, maxTokens: 2000, temperature: 0.3, label: sNode.label });
      t.result = { summary: r.text.trim(), artifacts: t.result?.artifacts ?? [] };
      return truncate(r.text.trim(), 4000);
    });
  }
  if (t.tier === 'full') {
    const resultReviews = t.reviews.filter((r) => r.stage === 'result' && r.round === round);
    const last = resultReviews.at(-1);
    if (!last) {
      const node = ensureNode(t, `rreview-r${round}`, { kind: 'result_review', agentId: 'menxia', label: `门下审议成果（第 ${round} 轮）` });
      if (node.status === 'failed' || node.status === 'cancelled') return false;
      let verdict: ReturnType<typeof parseVerdict> = null;
      await runNode(rt, t, node, async () => {
        const concl = plan.subtasks.map((s) => `- ${s.id} ${s.title}（验收：${s.acceptance}）：${truncate(latestExecNode(t, s.id)?.output ?? '无', 1200)}`);
        const tools = rt.workspace && t.workspace === rt.workspace.root ? (['view_changes', 'read_file', 'list_dir', 'search', 'load_skill'] as const) : (['view_changes', 'load_skill'] as const);
        const r = await runAgent({ rt, agentId: 'menxia', task: t, node, prompt: `【旨意】${t.title}\n${truncate(t.edict, 2000)}${(() => { const g = guidance(rt, t); return g ? `\n\n${g}` : ''; })()}\n\n【方案验收标准与各部结论】\n${concl.join('\n')}\n\n【尚书回奏】\n${truncate(t.result?.summary ?? '', 3000)}\n\n请核对实际改动（view_changes）与验收标准，审议成果。不合格则 reject 并在 rework 中列出需返工的子任务 id。输出 JSON。`, tools: [...tools], maxSteps: 6, maxTokens: 1500, temperature: 0.2, label: node.label });
        verdict = parseVerdict(r.text);
        if (!verdict) {
          const r2 = await runAgent({ rt, agentId: 'menxia', task: t, node, history: r.messages, prompt: '请只输出审议结论 JSON：{"verdict":"approve"|"reject","issues":[],"comment":"","rework":[]}', maxTokens: 800, temperature: 0, label: '门下省修正格式' });
          verdict = parseVerdict(r2.text);
        }
        return JSON.stringify(verdict ?? { error: '审议结论无法解析' });
      });
      if (!verdict) {
        rt.setGate(t, { kind: 'reject_limit', message: '门下省成果审议结论无法解析，请皇上亲自裁决（准奏 / 封驳返工）', nodeId: node.id });
        return false;
      }
      const v = verdict as NonNullable<ReturnType<typeof parseVerdict>>;
      t.reviews.push({ round, stage: 'result', verdict: v.verdict, issues: v.issues, comment: v.comment, reviewer: 'menxia', at: now() });
      rt.audit.record('menxia', v.verdict === 'approve' ? 'result_approved' : 'result_rejected', { round, issues: v.issues, rework: v.rework }, t.id);
      rt.activity('log', `门下省审议成果：${v.verdict === 'approve' ? '✅ 准奏' : '❌ 封驳'} ${v.comment}`, { taskId: t.id, agentId: 'menxia', nodeId: node.id, data: { verdict: v.verdict } });
      if (v.verdict === 'reject') {
        const rej = t.reviews.filter((r) => r.stage === 'result' && r.verdict === 'reject' && r.reviewer === 'menxia').length;
        if (rej > t.budget.maxRejections) {
          rt.setGate(t, { kind: 'reject_limit', message: `门下省已封驳成果 ${rej} 次，超出上限，请皇上裁决`, nodeId: node.id });
          return false;
        }
        startRework(rt, t, v.rework, [v.comment, ...v.issues].filter(Boolean).join('\n'), 'menxia');
        rt.transition(t, 'Doing', 'menxia', `❌ 封驳成果，发回返工：${truncate(v.comment, 80)}`);
        return true;
      }
    } else if (last.verdict === 'reject') {
      return false; // waiting for emperor (gate) — handled by decideGate
    }
  }
  // Court Lite has no 门下 result review: doubtful conclusions must not close the edict unseen
  const doubtful = t.tier === 'lite' ? doubtfulNodes(t) : [];
  if (rt.settings.finalGate) {
    rt.transition(t, 'PendingConfirm', 'shangshu', '回奏待皇上御批');
    rt.setGate(t, { kind: 'final', message: doubtful.length ? `成果存疑：${doubtText(doubtful)}。请御览回奏与改动：准奏则结案，封驳则发回返工` : '请御览回奏与改动：准奏则结案，封驳则发回返工' });
    return false;
  }
  if (doubtful.length && !t.reviews.some((r) => r.stage === 'result' && r.round === round && r.reviewer === 'emperor')) {
    rt.setGate(t, { kind: 'reject_limit', message: `成果存疑：${doubtText(doubtful)}。请皇上裁决：准奏则结案，封驳则发回返工`, nodeId: doubtful[0].id });
    return false;
  }
  rt.transition(t, 'Done', 'shangshu', '回奏结案');
  return true;
}

export function summarizeChanges(t: Task): string {
  const m = new Map<string, string>();
  for (const c of t.changes) if (!c.reverted) m.set(c.path, `${c.op} ${c.path} (${c.afterHash ? c.afterHash.slice(0, 12) : '已删除'}) by ${AGENT_MAP[c.agentId]?.name ?? c.agentId}`);
  return [...m.values()].join('\n');
}

function startRework(rt: Runtime, t: Task, targets: string[], feedback: string, by: 'menxia' | 'emperor') {
  const valid = targets.filter((id) => t.plan?.subtasks.some((s) => s.id === id));
  const round = (t.execRound ?? 1) + 1;
  t.execRound = round;
  t.rework = { round, targets: valid.length ? valid : (t.plan?.subtasks.map((s) => s.id) ?? []), feedback, by };
  rt.audit.record(by, 'rework_ordered', { round, targets: t.rework.targets, feedback: truncate(feedback, 500) }, t.id);
  rt.touch(t);
}

// ───────────────────────── Solo ─────────────────────────
async function stepSolo(rt: Runtime, t: Task): Promise<boolean> {
  const node = ensureNode(t, 'solo', { kind: 'solo', agentId: 'solo', label: 'Solo 执行' });
  if (node.status === 'failed' || node.status === 'cancelled') return false;
  if (node.status !== 'done') {
    const session = t.sessionId ? rt.sessions.get(t.sessionId) : undefined;
    await runNode(rt, t, node, async () => {
      const hist = (session?.messages ?? []).slice(0, -1).slice(-16).map((m) => ({ role: m.role, content: m.content }));
      const tools = rt.workspace && t.workspace === rt.workspace.root ? ALL_TOOLS : undefined;
      const ctx = [tools ? repoContext(rt, t) : '', guidance(rt, t)].filter(Boolean).map((x) => `\n\n${x}`).join('');
      const r = await runAgent({ rt, agentId: 'solo', task: t, node, session, history: hist, prompt: `${t.edict}${hist.length ? '' : ctx}`, tools, maxSteps: 40, maxTokens: 8000, temperature: 0.2, label: 'Solo 执行', model: t.strongModel });
      if (session) {
        session.messages.push({ role: 'assistant', content: r.text, at: now() });
        session.updatedAt = now();
        rt.emit({ type: 'session', session });
      }
      t.result = { summary: r.text, artifacts: [] };
      return truncate(r.text, 4000);
    });
  }
  rt.transition(t, 'Done', 'solo', 'Solo 完成');
  return true;
}

// ───────────────────────── human decisions ─────────────────────────
export interface GateDecision {
  approve: boolean;
  comment?: string;
  plan?: Plan; // edited plan (L2 涂改)
  reworkTargets?: string[];
  raiseBudget?: boolean;
}

export function decideGate(rt: Runtime, taskId: string, d: GateDecision) {
  const t = rt.getTask(taskId);
  const g = t.gate;
  if (!g) throw new Error('此旨意当前没有待批关卡');
  const comment = (d.comment ?? '').trim();
  rt.audit.record('emperor', 'gate_decision', { kind: g.kind, approve: d.approve, comment, edited: !!d.plan }, t.id);

  if (g.kind === 'budget') {
    if (d.approve) {
      const used = t.usage.inputTokens + t.usage.outputTokens;
      t.budget.maxTokens = Math.max(Math.round(t.budget.maxTokens * 1.5), Math.round(used * 1.3));
      if (t.budget.maxCostUsd) t.budget.maxCostUsd = +Math.max(t.budget.maxCostUsd * 1.5, t.usage.costUsd * 1.3).toFixed(3);
      rt.activity('human', `皇上追加预算：${t.budget.maxTokens} tokens`, { taskId });
      rt.clearGate(t);
    } else {
      rt.clearGate(t);
      rt.cancel(taskId, `预算超限，皇上取消${comment ? '：' + comment : ''}`);
    }
    return;
  }

  if (t.designSpec && t.design && !t.design.native) return flowDecideGate(rt, t, d);

  if (t.state === 'Menxia' && (g.kind === 'plan' || g.kind === 'reject_limit')) {
    let edited = false;
    if (d.plan) {
      const v = validatePlan(d.plan);
      if (!v.plan) throw new Error(`涂改后的方案无效：${v.error}`);
      const before = t.plan;
      if (JSON.stringify(before) !== JSON.stringify(v.plan)) {
        edited = true;
        const version = t.planHistory.length + 1;
        t.planHistory.push({ version, plan: v.plan, author: 'emperor', at: now(), note: comment || '皇上朱笔涂改' });
        t.plan = v.plan;
        rt.audit.record('emperor', 'plan_edited', { version, before: before ? sha256(JSON.stringify(before)) : null, after: sha256(JSON.stringify(v.plan)), subtasks: v.plan.subtasks.map((s) => `${s.id}:${s.dept}:${s.title}`) }, t.id);
        rt.activity('human', `皇上朱笔涂改方案 → v${version}（${v.plan.subtasks.length} 个子任务）`, { taskId });
      }
    }
    const round = planReviews(t).length + 1;
    t.reviews.push({ round, stage: 'plan', verdict: d.approve ? 'approve' : 'reject', issues: comment ? [comment] : [], comment: comment || (d.approve ? '皇上准奏' : '皇上封驳'), reviewer: 'emperor', at: now() + 1 });
    t.gate = undefined;
    if (d.approve) rt.transition(t, 'Assigned', 'emperor', `皇上准奏${edited ? '（已朱笔涂改方案）' : ''}`);
    else rt.transition(t, 'Zhongshu', 'emperor', `皇上封驳：${comment || '重拟'}`);
    rt.touch(t);
    void drive(rt, taskId);
    return;
  }

  if (t.state === 'Review' && g.kind === 'reject_limit') {
    const round = t.execRound ?? 1;
    t.reviews.push({ round, stage: 'result', verdict: d.approve ? 'approve' : 'reject', issues: comment ? [comment] : [], comment: comment || (d.approve ? '皇上准奏' : '皇上封驳'), reviewer: 'emperor', at: now() });
    t.gate = undefined;
    if (d.approve) {
      rt.touch(t);
      void drive(rt, taskId);
      return;
    }
    startRework(rt, t, d.reworkTargets ?? [], comment || '皇上封驳成果，请返工', 'emperor');
    rt.transition(t, 'Doing', 'emperor', `皇上封驳成果，发回返工`);
    void drive(rt, taskId);
    return;
  }

  if (t.state === 'PendingConfirm' && g.kind === 'final') {
    t.gate = undefined;
    if (d.approve) {
      rt.transition(t, 'Done', 'emperor', `皇上准奏结案${comment ? '：' + comment : ''}`);
      return;
    }
    const round = t.execRound ?? 1;
    t.reviews.push({ round, stage: 'result', verdict: 'reject', issues: comment ? [comment] : [], comment: comment || '皇上封驳回奏', reviewer: 'emperor', at: now() });
    rt.transition(t, 'Review', 'emperor', `皇上封驳回奏：${comment || '返工'}`);
    if (t.tier === 'solo') {
      rt.transition(t, 'Doing', 'emperor', '发回返工');
    } else {
      startRework(rt, t, d.reworkTargets ?? [], comment || '皇上封驳回奏，请返工', 'emperor');
      rt.transition(t, 'Doing', 'emperor', '发回六部返工');
    }
    void drive(rt, taskId);
    return;
  }
  throw new Error(`当前状态 ${STATE_LABEL[t.state]} 不接受此关卡决定（${g.kind}）`);
}

export function retryNode(rt: Runtime, taskId: string, nodeId: string) {
  const t = rt.getTask(taskId);
  if (TERMINAL.includes(t.state)) throw new Error('任务已终结，无法重试');
  const n = t.nodes.find((x) => x.id === nodeId);
  if (!n) throw new Error('节点不存在');
  if (n.status !== 'failed' && n.status !== 'cancelled') throw new Error('只能重试失败或中断的节点');
  n.status = 'pending';
  n.error = undefined;
  rt.audit.record('emperor', 'node_retry', { nodeId, label: n.label, previousRunId: n.runId }, taskId);
  rt.activity('human', `皇上下令局部重试：${n.label}（其余已完成节点不重放）`, { taskId, nodeId });
  if (t.state === 'Blocked') {
    const back = t.resumeState && t.resumeState !== 'Blocked' ? t.resumeState : inferState(n, t);
    t.blockedReason = undefined;
    rt.transition(t, back, 'emperor', `局部恢复：重试 ${n.label}`);
  }
  rt.touch(t);
  void drive(rt, taskId);
}

/** Local retry of one failed node on another model (the choice sticks to this task + agent). */
export function retryNodeWithModel(rt: Runtime, taskId: string, nodeId: string, ref: ModelRef) {
  const t = rt.getTask(taskId);
  const n = t.nodes.find((x) => x.id === nodeId);
  if (!n) throw new Error('节点不存在');
  if (!rt.providers.some((p) => p.id === ref.providerId && p.enabled)) throw new Error('所选模型服务不可用');
  if (n.roleId) t.roleModels = { ...(t.roleModels ?? {}), [n.roleId]: ref };
  else t.agentModels = { ...(t.agentModels ?? {}), [n.agentId]: ref };
  if (n.agentId === 'solo' || n.kind === 'plan') t.strongModel = ref;
  rt.audit.record('emperor', 'node_model_switch', { nodeId, agentId: n.agentId, providerId: ref.providerId, model: ref.model }, taskId);
  rt.activity('human', `皇上改用 ${ref.model} 重试：${n.label}`, { taskId, nodeId });
  retryNode(rt, taskId, nodeId);
}

function inferState(n: RunNode, t?: Task) {
  const st = n.stepId ? t?.designSpec?.steps.find((x) => x.id === n.stepId) : undefined;
  if (st) return PHASE_STATE[st.phase];
  switch (n.kind) {
    case 'plan':
    case 'debate':
      return 'Zhongshu' as const;
    case 'review':
      return 'Menxia' as const;
    case 'dispatch':
      return 'Assigned' as const;
    case 'summary':
    case 'result_review':
      return 'Review' as const;
    default:
      return 'Doing' as const;
  }
}

export function unblock(rt: Runtime, taskId: string) {
  const t = rt.getTask(taskId);
  if (t.state !== 'Blocked') throw new Error('旨意未处于阻塞状态');
  for (const n of t.nodes) if (n.status === 'failed' || n.status === 'cancelled') n.status = 'pending';
  const back = t.resumeState && t.resumeState !== 'Blocked' ? t.resumeState : 'Zhongshu';
  t.blockedReason = undefined;
  rt.transition(t, back, 'emperor', '皇上解除阻塞，恢复执行');
  void drive(rt, taskId);
}

export function resumeAll(rt: Runtime) {
  for (const t of rt.tasks.values()) if (!TERMINAL.includes(t.state) && t.state !== 'Blocked' && !t.gate && !t.paused) void drive(rt, t.id);
}
