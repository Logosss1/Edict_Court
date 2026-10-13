// 三省六部 orchestration engine. State-driven and node-based: every step is a persisted
// RunNode, so an interrupted/failed node can be retried locally without replaying the
// whole agent tree. 门下省 review is structural — there is no code path from Zhongshu to
// Assigned that does not pass a Menxia verdict (or the emperor's explicit decision).
import type { CollabDesign, DesignPin, LaneSpec, MinistryId, ModelRef, PermissionMode, Plan, RevertResult, Review, RunNode, Session, Subtask, Task, TaskScheduleRef, Tier } from '../../shared/types';
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
import { askPrince, parsePrinceAsk, princeWaiting, type PrinceAsk } from './askEmperor';
import { hasOwnTree, prepareWorkspace } from './worktrees';
import { scheduleNote } from './scheduler';
import { worktreeNote } from './worktreeSetup';
import { execWithGuest, guestPrompt, pickGuest } from '../guests';
import { laneOf } from './attempts';
import { lanesWanted, laneWho, runAttempts } from './attemptRun';
import { expandMcpRefs } from '../mcp/refs';
import { BUILTIN_DESIGN_ID, PHASE_STATE } from '../../shared/design';
import {
  CHECK_TOOLS, REQUIREMENTS_PROMPT, canSupplement, ownedRequirementsText, parseRequirements, requirementCheckOn, requirementsText, runRequirementCheck,
  supplementPlan, uncovered, unmetRequirements, unmetText, withRequirements,
} from './requirements';
import { reqLabel } from '../../shared/requirements';

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
  rt.submitHook = (input) => submit(rt, input);
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
  /** 定时旨意: the folder it was scheduled for (null = none), its permission mode, and which schedule issued it */
  workspace?: string | null;
  permissionMode?: PermissionMode;
  schedule?: TaskScheduleRef;
}

export type SubmitResult = { kind: 'chat'; sessionId: string; reply: string } | { kind: 'task'; taskId: string };

// ───────────────────────── submission (下旨) ─────────────────────────
export async function submit(rt: Runtime, input: SubmitInput): Promise<SubmitResult> {
  const typed = input.text.trim();
  if (!typed) throw new Error('旨意内容为空');
  // a custom 协同设计 is pinned now (version + hash + snapshot); later switches never affect this edict
  const pinned = input.designId && input.designId !== BUILTIN_DESIGN_ID ? rt.designs.pin(input.designId) : undefined;
  const tier: Tier = pinned?.spec ? pinned.spec.policies.tier : input.multiAgent ? input.tier : 'solo';
  // @mcp:<server>/<uri> references: the resource text is appended (【附带资源】) to what every official sees
  const { text, refs } = await expandMcpRefs(rt, typed);
  rt.audit.record(input.schedule ? 'system' : 'emperor', 'edict_submitted', { schedule: input.schedule?.id, design: pinned ? `${pinned.pin.id}@${pinned.pin.version}` : null, tier, chars: typed.length, mcpRefs: refs.length || undefined, templateId: input.templateId, effort: input.effort ?? null, model: input.model ? `${input.model.providerId}/${input.model.model}` : null });

  if (tier === 'solo') {
    let session = input.sessionId ? rt.sessions.get(input.sessionId) : undefined;
    if (!session) {
      session = { id: uid('ss'), title: typed.slice(0, 30), source: 'solo', agentId: 'solo', messages: [], createdAt: now(), updatedAt: now(), status: 'active', usage: emptyUsage() };
      rt.sessions.set(session.id, session);
      const a = rt.agents.get('solo');
      if (a) a.sessions++;
    }
    session.messages.push({ role: 'user', content: text, at: now() });
    session.updatedAt = now();
    const task = createTask(rt, { text, tier, title: input.schedule?.title || typed.replace(/\s+/g, ' ').slice(0, 28), model: input.model ?? null, sessionId: session.id, templateId: input.templateId, effort: input.effort, ...scheduled(input) });
    session.taskId = task.id;
    rt.emit({ type: 'session', session });
    void drive(rt, task.id);
    return { kind: 'task', taskId: task.id };
  }

  // 太子分拣
  let title = typed.replace(/\s+/g, ' ').slice(0, 20);
  let triageOutput = '{"type":"edict","reason":"皇上直接下旨"}';
  let ask: PrinceAsk | null = null; // 太子追问 (never with 直接下旨, and Solo has no prince)
  const session: Session = { id: uid('ss'), title: typed.slice(0, 30), source: 'taizi-chat', agentId: 'taizi', messages: [{ role: 'user', content: text, at: now() }], createdAt: now(), updatedAt: now(), status: 'active', usage: emptyUsage() };
  if (!input.forceEdict) {
    rt.sessions.set(session.id, session);
    rt.emit({ type: 'session', session });
    const ta = rt.agents.get('taizi');
    if (ta) ta.sessions++;
    const r = await runAgent({ rt, agentId: 'taizi', session, prompt: `皇上输入：\n${text}`, maxTokens: 800, temperature: 0.2, label: '太子分拣' });
    let j = extractJson<{ type?: string; title?: string; reply?: string; reason?: string; question?: string; options?: string[]; assume?: string }>(r.text);
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
    if (rt.settings.taiziAsk !== false) ask = parsePrinceAsk(j);
    session.messages.push({ role: 'assistant', content: ask ? `已分拣为旨意：${title}（先向父皇请旨：${ask.question}）` : `已分拣为旨意：${title}`, at: now() });
    session.status = 'done';
    rt.emit({ type: 'session', session });
  }
  if (input.schedule) title = input.schedule.title || title;
  const task = createTask(rt, { text, tier, title, model: input.model ?? null, withDebate: pinned ? false : (input.withDebate ?? (tier === 'full' && rt.settings.debateBeforePlan)), templateId: input.templateId, effort: input.effort, design: pinned, ...scheduled(input) });
  task.nodes.push({ id: 'triage', kind: 'triage', agentId: 'taizi', label: '太子分拣', status: 'done', attempts: 1, startedAt: now(), endedAt: now(), exitStatus: 'ok', output: triageOutput, usage: session.usage });
  rt.transition(task, 'Taizi', 'taizi', input.schedule ? '定时旨意，直接接旨' : '太子接旨分拣');
  // the edict waits in 太子分拣 until the emperor answers; the answer drives it on
  if (ask) askPrince(rt, task, ask);
  else void drive(rt, task.id);
  return { kind: 'task', taskId: task.id };
}

const scheduled = (i: SubmitInput) => (i.schedule ? { workspace: i.workspace ?? null, permissionMode: i.permissionMode, schedule: i.schedule } : {});

export function createTask(rt: Runtime, o: { text: string; tier: Tier; title: string; model: ModelRef | null; withDebate?: boolean; sessionId?: string; templateId?: string; effort?: string; design?: { pin: DesignPin; spec?: CollabDesign }; workspace?: string | null; permissionMode?: PermissionMode; schedule?: TaskScheduleRef }): Task {
  const s = rt.settings;
  const design = o.design ?? rt.designs.pin(BUILTIN_DESIGN_ID);
  const pol = design.spec?.policies;
  const est = rt.estimate(o.text, o.tier, o.model);
  const t: Task = {
    id: rt.newTaskId(), title: o.title, edict: o.text, tier: o.tier, state: 'Pending', createdAt: now(), updatedAt: now(),
    workspace: o.schedule ? (o.workspace ?? null) : (rt.workspace?.root ?? null),
    flow: [{ at: now(), from: o.schedule ? '定时旨意' : '皇上', to: o.tier === 'solo' ? '独相' : '太子', remark: o.schedule ? `按时下旨：${o.schedule.title}` : '下旨', state: 'Pending' }],
    planHistory: [], reviews: [], nodes: [], paused: false, changes: [], usage: emptyUsage(),
    budget: { maxTokens: pol?.tokenBudget || s.budgets[o.tier], maxRejections: pol ? pol.maxRejections : o.tier === 'full' ? s.maxRejections.full : s.maxRejections.lite, maxCostUsd: s.maxCostUsd },
    design: design.pin, designSpec: design.spec, flowRun: design.spec ? { cursor: 0, iter: {}, rejections: {} } : undefined,
    estimate: { tokens: est.tokens, costUsd: est.costUsd },
    strongModel: o.model ?? undefined, withDebate: o.withDebate, sessionId: o.sessionId, templateId: o.templateId, effort: o.effort && o.effort !== 'default' ? o.effort : undefined, lastActivityAt: now(), execRound: 1,
    ...(o.schedule ? { schedule: o.schedule, permissionMode: o.permissionMode } : {}),
  };
  rt.tasks.set(t.id, t);
  rt.audit.record(t.schedule ? 'system' : 'emperor', 'edict_issued', { id: t.id, title: t.title, tier: t.tier, estimate: t.estimate, budget: t.budget, workspace: t.workspace, ...(t.schedule ? { schedule: t.schedule.id, permission: t.schedule.permission } : {}), design: { id: design.pin.id, version: design.pin.version, hash: design.pin.hash } }, t.id);
  rt.activity('human', `${t.schedule ? `定时旨意按时下达${t.schedule.catchUp ? '（补跑错过的一次）' : ''}` : '皇上下旨'}（${design.spec ? `协同设计「${design.pin.name}」v${design.pin.version}` : t.tier}）：${t.title}`, { taskId: t.id });
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
      // 太子追问 still unanswered (put again after a restart): nothing moves, not even the worktree
      if (t.state === 'Taizi' && princeWaiting(rt, t)) return;
      // its own worktree is made when the edict leaves triage, before anything reads or writes files
      const missing = await prepareWorkspace(rt, t);
      if (missing) {
        block(rt, t, missing);
        return;
      }
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
  // only once the folder is free: re-driving a still-queued edict would kick itself again forever (a microtask loop)
  for (const t of rt.tasks.values()) if (t.state === 'Next' && t.workspace === ws && !drivingSet(rt).has(t.id) && !otherDoing(rt, t)) void drive(rt, t.id);
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

// (a 排班 node also waits while one of its lanes waits: their node ids extend its own)
const waitingOnEmperor = (rt: Runtime, t: Task, node: RunNode) => t.paused || !!t.gate || [...rt.approvals.values()].some((a) => a.status === 'pending' && a.taskId === t.id && (!a.nodeId || a.nodeId === node.id || a.nodeId.startsWith(`${node.id}-`)));

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

/** Another edict is executing in the same folder (edicts with their own worktree never wait, nor make others wait). */
export function otherDoing(rt: Runtime, t: Task) {
  if (hasOwnTree(t)) return false;
  return [...rt.tasks.values()].some((x) => x.id !== t.id && x.state === 'Doing' && x.tier !== 'solo' && !hasOwnTree(x) && x.workspace && x.workspace === t.workspace);
}

// ───────────────────────── 中书省 ─────────────────────────
export function repoContext(rt: Runtime, t: Task, node?: RunNode): string {
  const ws = rt.workspaceFor(t, node);
  if (!ws) return '（未打开工作区：本旨意不涉及本地文件，或仅产出文本。）';
  try {
    const map = ws.repoMap(120);
    const outline = ws.outlineMap(30, 10);
    const note = worktreeNote(laneOf(t, node)?.worktree ?? t.worktree);
    return `【仓库地图】\n${truncate(map, 6000)}\n\n【符号大纲（节选）】\n${truncate(outline || '（无）', 5000)}${note ? `\n\n${note}` : ''}`;
  } catch (e) {
    return `（仓库地图生成失败：${(e as Error).message}）`;
  }
}

/** E2: the workspace's rule files plus the emperor's 典章, for every prompt that plans, reviews or does the work. */
export function guidance(rt: Runtime, t: Task): string {
  return [scheduleNote(t), canonBlock(rt, t, rt.workspaceFor(t))].filter(Boolean).join('\n\n');
}

/** 排班 lanes as the plan card sent them: 2–3 entries, each an executor ('self' or a guest id) and maybe a model. */
export function cleanLanes(v: unknown): LaneSpec[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const lanes = v
    .filter((x): x is { executor?: unknown; model?: unknown } => !!x && typeof x === 'object')
    .map((x): LaneSpec => {
      const m = x.model as { providerId?: unknown; model?: unknown } | null | undefined;
      return { executor: typeof x.executor === 'string' && x.executor.trim() ? x.executor.trim().slice(0, 60) : 'self', ...(m && typeof m.providerId === 'string' && typeof m.model === 'string' ? { model: { providerId: m.providerId, model: m.model } } : {}) };
    })
    .slice(0, 3);
  return lanes.length >= 2 ? lanes : undefined;
}

/**
 * Who does each subtask (客卿) and its 排班 are the emperor's to set on the plan card: never taken from 中书省's
 * JSON, and kept for the same subtask (same id and ministry) when 中书省 revises the plan.
 */
export function keepEmperorChoices(plan: Plan, prev?: Plan): Plan {
  for (const s of plan.subtasks) {
    delete s.executor;
    delete s.lanes;
    const p = prev?.subtasks.find((x) => x.id === s.id && x.dept === s.dept);
    if (p?.executor) s.executor = p.executor;
    if (p?.lanes) s.lanes = p.lanes;
  }
  return plan;
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
  const requirements = parseRequirements(j.requirements, j.subtasks as { covers?: unknown }[], subs);
  (j.subtasks as Partial<Subtask>[]).forEach((s, i) => {
    if (s.supplement) subs[i].supplement = true;
    // 客卿 / 排班 (2.1): who does it, and the lanes when several do it side by side
    if (typeof s.executor === 'string' && s.executor.trim()) subs[i].executor = s.executor.trim().slice(0, 60);
    const lanes = cleanLanes(s.lanes);
    if (lanes) subs[i].lanes = lanes;
    if (typeof s.suggestAttempts === 'string' && s.suggestAttempts.trim()) subs[i].suggestAttempts = s.suggestAttempts.trim().slice(0, 200);
  });
  return { plan: { summary: String(j.summary ?? '').trim(), subtasks: subs, risks: Array.isArray(j.risks) ? j.risks.map(String) : [], ...(requirements ? { requirements: { ...requirements, ...((j.requirements as { derived?: boolean }).derived ? { derived: true } : {}) } } : {}) } };
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
    const reqOn = requirementCheckOn(rt, t.tier);
    if (reqOn) parts.push(REQUIREMENTS_PROMPT);
    parts.push('请输出方案 JSON。');
    const tools = rt.workspaceFor(t) ? READ_TOOLS : undefined;
    const r = await runAgent({ rt, agentId: 'zhongshu', task: t, node, prompt: parts.join('\n\n'), tools, maxSteps: 6, maxTokens: 4000, temperature: 0.3, label: node.label });
    let v = validatePlan(extractJson(r.text));
    if (!v.plan) {
      rt.activity('log', `中书省方案格式不合规（${v.error}），要求修正`, { taskId: t.id, agentId: 'zhongshu', nodeId: node.id });
      const r2 = await runAgent({ rt, agentId: 'zhongshu', task: t, node, history: r.messages, prompt: `方案不合规：${v.error}。请只输出一个合法的方案 JSON 对象，不要其他文字。`, maxTokens: 4000, temperature: 0, label: '中书省修正格式' });
      v = validatePlan(extractJson(r2.text));
    }
    if (!v.plan) throw new Error(`中书省方案格式无效：${v.error}`);
    v.plan = keepEmperorChoices(v.plan, t.plan);
    if (reqOn) v.plan = withRequirements(v.plan);
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
      latest.plan.requirements ? `${requirementsText(latest.plan, true)}${uncovered(latest.plan).length ? `\n注意：${uncovered(latest.plan).join('、')} 没有子任务负责。` : ''}\n审议完整性时，请核对需求说明是否漏了旨意里的要求、验收标准能否核对、每条是否都有子任务负责。` : '',
      reviews.length ? `【此前审议】\n${reviews.map((r) => `第${r.round}轮 ${r.verdict === 'approve' ? '准奏' : '封驳'}：${r.comment}`).join('\n')}` : '',
      guidance(rt, t),
      `这是第 ${round} 轮审议（封驳上限 ${t.budget.maxRejections} 次，超限将升级皇上裁决）。请从可行性、完整性、风险、资源四个维度审议，输出 JSON。`,
    ].filter(Boolean).join('\n\n');
    const tools = rt.workspaceFor(t) ? READ_TOOLS : undefined;
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
    const n = ensureNode(t, `exec-${id}-r${round}`, { kind: 'exec', agentId: sub.dept, label: `${AGENT_MAP[sub.dept].name}·${sub.title}${round > 1 && !(sub.supplement && !latestExecNode(t, id)) ? `（返工 ${round - 1}）` : ''}`, subtaskId: id, effect: effectOf(sub) });
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
  const madeUp = round > 1 && targets.every((id) => plan.subtasks.find((s) => s.id === id)?.supplement);
  rt.transition(t, 'Review', 'shangshu', madeUp ? '补办完成，再行对照检查' : round > 1 ? `返工完成（第 ${round - 1} 次），汇总回奏` : '六部执行完毕，汇总回奏');
  return true;
}

async function runExec(rt: Runtime, t: Task, node: RunNode, order?: string): Promise<void> {
  const plan = t.plan!;
  const sub = plan.subtasks.find((s) => s.id === node.subtaskId)!;
  const hasWs = !!rt.workspaceFor(t, node);
  // 排班 (2.1): 2–3 lanes side by side; 客卿 (2.1): an outside agent may do it in the ministry's place
  const want = lanesWanted(t, node, sub);
  if (want.why && node.status === 'pending') rt.activity('log', `「${sub.title}」排了班，但${want.why}，改为一路办`, { taskId: t.id, agentId: sub.dept, nodeId: node.id });
  const pick = pickGuest(rt, t, node, sub);
  if (!want.lanes && pick.fallback && node.status === 'pending') rt.activity('log', pick.fallback, { taskId: t.id, agentId: sub.dept, nodeId: node.id });
  const who = want.lanes
    ? `${AGENT_MAP[sub.dept].name}（排班 ${want.lanes.length} 路：${want.lanes.map((l) => laneWho(rt, sub.dept, l)).join('、')}）`
    : pick.launch ? `${AGENT_MAP[sub.dept].name}（请客卿 ${pick.launch.name} 代办）` : AGENT_MAP[sub.dept].name;
  await confirmWriteTask(rt, t, node, sub, who, hasWs);
  // (the emperor may have answered the write card with 只读: then one lane, as usual)
  const lanes = want.lanes && lanesWanted(t, node, sub).lanes;
  await runNode(rt, t, node, () =>
    lanes
      ? runAttempts(rt, t, node, sub, lanes, { ensureNode, runNode, execBody: (ln) => execBody(rt, t, ln, sub, order) })
      : execBody(rt, t, node, sub, order, pick),
  );
}

/** The work of one exec node: an official's run (or a guest's), the conclusion and its evidence check. */
async function execBody(rt: Runtime, t: Task, node: RunNode, sub: Subtask, order?: string, pick = pickGuest(rt, t, node, sub)): Promise<string> {
  const plan = t.plan!;
  const lane = laneOf(t, node);
  if (lane && pick.fallback) rt.activity('log', pick.fallback, { taskId: t.id, agentId: sub.dept, nodeId: node.id });
  const hasWs = !!rt.workspaceFor(t, node);
  const deps = sub.dependsOn.map((d) => {
    const n = latestExecNode(t, d);
    return `- ${d}（${AGENT_MAP[plan.subtasks.find((s) => s.id === d)!.dept].name}）结论：${truncate(n?.output ?? '无', 1200)}`;
  });
  const prev = [...t.nodes].reverse().find((n) => n.kind === 'exec' && n.subtaskId === sub.id && n.id !== node.id && n.status === 'done');
  const firstRun = lane || node.id.endsWith('-r1') || (sub.supplement && !prev);
  const lanes = lane ? t.attempts?.find((a) => a.lanes.includes(lane))?.lanes.length ?? 2 : 0;
  const parts = [
    `【旨意】${t.title}\n${truncate(t.edict, 3000)}`,
    `【方案概述】${plan.summary}`,
    `【你的子任务 ${sub.id}】${sub.title}\n做法：${sub.detail}\n验收标准：${sub.acceptance}`,
    ownedRequirementsText(plan, sub),
    order ? `【尚书省执行令】${order}` : '',
    lane ? `【排班】这个子任务由 ${lanes} 路同时办，你是${lane.label}路，在自己的工作树里独立完成，不必顾及其他各路。办完后门下省会比较各路成果，择优采用。` : '',
    deps.length ? `【上游子任务结论】\n${deps.join('\n')}` : '',
    firstRun ? '' : `【返工要求（${t.rework?.by === 'emperor' ? '皇上' : '门下省'}）】\n${t.rework?.feedback ?? ''}\n【你上一轮的结论】${truncate(prev?.output ?? '无', 1500)}`,
    hasWs ? grantPrompt(node) : '',
    hasWs ? repoContext(rt, t, node) : '（未打开工作区：无法读写文件，请直接在结论中给出成果文本）',
    guidance(rt, t),
    EXEC_OUTPUT_RULE,
  ].filter(Boolean);
  const tree = lane?.worktree ?? t.worktree;
  const g = pick.launch ? await execWithGuest(rt, t, node, sub, pick.launch, guestPrompt(sub.dept, pick.launch.name, parts.filter((x) => x !== EXEC_OUTPUT_RULE && !x.startsWith('【仓库地图】')).concat(worktreeNote(tree)))) : null;
  const tools = toolsForNode(node, hasWs ? ALL_TOOLS : undefined);
  const model = lane && lane.executor === 'self' && lane.model ? lane.model : undefined;
  const r = g ? { ...g, messages: [] } : await runAgent({ rt, agentId: sub.dept, task: t, node, prompt: parts.join('\n\n'), tools, maxSteps: 30, maxTokens: 8000, temperature: 0.2, label: node.label, model });
  let c = parseConclusion(r.text);
  if (!c.structured && !g) {
    // one format-repair turn: same conversation, no tools, conclusion only
    const r2 = await runAgent({ rt, agentId: sub.dept, task: t, node, history: r.messages, prompt: `请只输出结构化结论，不要再调用工具。\n${EXEC_OUTPUT_RULE}`, maxTokens: 1500, temperature: 0, label: `${node.label}（结论格式修正）`, model });
    const c2 = parseConclusion(r2.text);
    if (c2.structured) c = c2;
  }
  const { conclusion, systemCheck } = checkEvidence(t, node, c, r.toolCounts, rt.workspaceFor(t, node) ?? undefined);
  if (g) systemCheck.unshift(`由客卿 ${node.guest?.name ?? ''} 办理（费用由它自己的账号计）`);
  if (conclusion.status === 'failed') throw new Error(`${g ? `客卿 ${node.guest?.name ?? ''}` : AGENT_MAP[sub.dept].name}自报失败：${conclusion.summary}`);
  if (conclusion.status === 'partial') rt.activity('log', `⚠ ${node.label} 成果存疑：${conclusion.issues.join('；') || '自报部分完成'}`, { taskId: t.id, agentId: node.agentId, nodeId: node.id });
  const { structured: _s, ...plain } = conclusion as typeof conclusion & { structured?: boolean };
  return JSON.stringify({ ...plain, systemCheck });
}

/** Latest exec nodes whose conclusion is partial (成果存疑). */
function doubtfulNodes(t: Task): RunNode[] {
  return (t.plan?.subtasks ?? []).map((s) => latestExecNode(t, s.id)).filter((n): n is RunNode => !!n && nodeConclusion(n)?.status === 'partial');
}

const doubtText = (nodes: RunNode[]) => nodes.map((n) => `${n.label}（${(nodeConclusion(n)?.issues ?? []).slice(0, 2).join('；') || '自报部分完成'}）`).join('；');

// ───────────────────────── 回奏 & 成果审议 ─────────────────────────
/**
 * 对照检查 before 尚书汇总: 'rework' = unmet requirements went back to the ministries as make-up subtasks
 * (now Doing); 'stop' = the check node failed and waits for a retry; 'go' = carry on to the summary.
 */
async function stepCheck(rt: Runtime, t: Task, round: number): Promise<'go' | 'rework' | 'stop'> {
  const plan = t.plan!;
  const node = ensureNode(t, `check-r${round}`, { kind: 'check', agentId: 'menxia', label: round > 1 ? `对照检查（第 ${round} 轮）` : '对照检查' });
  if (node.status === 'failed' || node.status === 'cancelled') return 'stop';
  if (node.status !== 'done') {
    await runNode(rt, t, node, async () => {
      const conclusions = plan.subtasks.map((s) => `- ${s.id}（${AGENT_MAP[s.dept].name}）${s.title}${s.covers?.length ? `〔负责 ${s.covers.join('、')}〕` : ''}：${truncate(latestExecNode(t, s.id)?.output ?? '无', 1200)}`).join('\n');
      const chk = await runRequirementCheck(rt, t, node, round, { plan, conclusions, changes: summarizeChanges(t), guidance: guidance(rt, t), tools: CHECK_TOOLS(!!rt.workspaceFor(t)) });
      return JSON.stringify({ items: chk.items.map(({ id, verdict, evidence, note }) => ({ id, verdict, evidence, note })) });
    });
  }
  const chk = t.requirementChecks?.find((c) => c.nodeId === node.id);
  if (!chk || !canSupplement(rt, t, chk)) return 'go';
  const sup = supplementPlan(plan, chk);
  chk.supplements = sup.ids;
  t.plan = sup.plan;
  rt.audit.record('menxia', 'requirement_supplement', { round, subtasks: sup.plan.subtasks.filter((s) => sup.ids.includes(s.id)).map((s) => ({ id: s.id, dept: s.dept, covers: s.covers })) }, t.id);
  startRework(rt, t, sup.ids, sup.feedback, 'menxia');
  rt.transition(t, 'Doing', 'menxia', `对照检查：${chk.items.filter((i) => i.verdict === 'unmet').map((i) => reqLabel(i.id)).join('、')} 未满足，追加补办 ${sup.ids.join('、')}`);
  return 'rework';
}

/** The latest check as prompt text for the summary and the result review. */
function checkText(t: Task): string {
  const chk = t.requirementChecks?.at(-1);
  if (!chk) return '';
  return `【对照检查（第 ${chk.round} 轮）】\n${chk.items.map((i) => `${i.id} ${i.text}：${i.verdict === 'met' ? '满足' : i.verdict === 'unmet' ? '未满足' : '无法判断'}${i.evidence ? `；证据：${truncate(i.evidence, 200)}` : ''}${i.note ? `；${truncate(i.note, 120)}` : ''}`).join('\n')}`;
}

async function stepReview(rt: Runtime, t: Task): Promise<boolean> {
  const round = t.execRound ?? 1;
  if (t.plan?.requirements && requirementCheckOn(rt, t.tier)) {
    const c = await stepCheck(rt, t, round);
    if (c === 'stop') return false;
    if (c === 'rework') return true;
  }
  const plan = t.plan!;
  const sNode = ensureNode(t, `summary-r${round}`, { kind: 'summary', agentId: 'shangshu', label: round > 1 ? `尚书汇总（第 ${round} 轮）` : '尚书汇总回奏' });
  if (sNode.status === 'failed' || sNode.status === 'cancelled') return false;
  if (sNode.status !== 'done') {
    await runNode(rt, t, sNode, async () => {
      const concl = plan.subtasks.map((s) => `- ${s.id}（${AGENT_MAP[s.dept].name}）${s.title}：${truncate(latestExecNode(t, s.id)?.output ?? '无', 1500)}`);
      const changes = summarizeChanges(t);
      const chk = checkText(t);
      const r = await runAgent({ rt, agentId: 'shangshu', task: t, node: sNode, prompt: `【旨意】${t.title}\n${truncate(t.edict, 2000)}\n\n【各部结构化结论】\n${concl.join('\n')}\n\n【系统核验的文件改动】\n${changes || '无'}${chk ? `\n\n${chk}\n未满足或无法判断的需求，要在「遗留问题」里如实写明。` : ''}\n\n请撰写回奏折（Markdown）。`, tools: ['load_skill'], maxSteps: 4, maxTokens: 2000, temperature: 0.3, label: sNode.label });
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
        const tools = rt.workspaceFor(t) ? (['view_changes', 'read_file', 'list_dir', 'search', 'load_skill'] as const) : (['view_changes', 'load_skill'] as const);
        const r = await runAgent({ rt, agentId: 'menxia', task: t, node, prompt: `【旨意】${t.title}\n${truncate(t.edict, 2000)}${(() => { const g = guidance(rt, t); return g ? `\n\n${g}` : ''; })()}\n\n【方案验收标准与各部结论】\n${concl.join('\n')}\n\n【尚书回奏】\n${truncate(t.result?.summary ?? '', 3000)}${(() => { const c = checkText(t); return c ? `\n\n${c}` : ''; })()}\n\n请核对实际改动（view_changes）与验收标准，审议成果。不合格则 reject 并在 rework 中列出需返工的子任务 id。输出 JSON。`, tools: [...tools], maxSteps: 6, maxTokens: 1500, temperature: 0.2, label: node.label });
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
  // Court Lite has no 门下 result review: doubtful conclusions must not close the edict unseen; requirements the
  // check still finds unmet (after the make-up round) never close it unseen in either tier
  const doubtful = t.tier === 'lite' ? doubtfulNodes(t) : [];
  const unmet = requirementCheckOn(rt, t.tier) ? unmetRequirements(t) : [];
  const doubt = [doubtful.length ? doubtText(doubtful) : '', unmet.length ? `需求未满足：${unmetText(unmet)}` : ''].filter(Boolean).join('；');
  if (rt.settings.finalGate) {
    rt.transition(t, 'PendingConfirm', 'shangshu', '回奏待皇上御批');
    rt.setGate(t, { kind: 'final', message: doubt ? `成果存疑：${doubt}。请御览回奏与改动：准奏则结案，封驳则发回返工` : '请御览回奏与改动：准奏则结案，封驳则发回返工' });
    return false;
  }
  if (doubt && !t.reviews.some((r) => r.stage === 'result' && r.round === round && r.reviewer === 'emperor')) {
    const at = doubtful[0]?.id ?? t.requirementChecks?.at(-1)?.nodeId;
    rt.setGate(t, { kind: 'reject_limit', message: `成果存疑：${doubt}。请皇上裁决：准奏则结案，封驳则发回返工`, ...(at ? { nodeId: at } : {}) });
    return false;
  }
  rt.transition(t, 'Done', 'shangshu', '回奏结案');
  return true;
}

export function summarizeChanges(t: Task): string {
  const m = new Map<string, string>();
  for (const c of t.changes) if (!c.reverted) m.set(c.path, `${c.op} ${c.path} (${c.op === 'delete' ? '已删除' : c.oversize ? '大文件，未记录内容' : c.afterHash?.slice(0, 12) ?? '—'}) by ${AGENT_MAP[c.agentId]?.name ?? c.agentId}${c.via === 'command' ? ` · 命令 ${(c.command ?? '').slice(0, 80)}` : ''}`);
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
      const tools = rt.workspaceFor(t) ? ALL_TOOLS : undefined;
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
      // the 需求说明 stays with the plan; one taken from the acceptance lines follows the emperor's edits to them
      if (t.plan?.requirements && requirementCheckOn(rt, t.tier)) {
        if (!v.plan.requirements) v.plan = withRequirements({ ...v.plan, requirements: t.plan.requirements.derived ? undefined : t.plan.requirements });
        else if (v.plan.requirements.derived) v.plan = withRequirements({ ...v.plan, requirements: undefined });
      }
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

/**
 * E3 「撤回此部改动并重做」(门下封驳 / 奏折批阅): undo every file change of one node, then redo it. A failed or
 * interrupted node is retried in place; a finished exec node at a 封驳 / 御批 gate is sent back as rework of its
 * subtask (the gate is answered with a rejection). A conflict reverts nothing and redoes nothing.
 */
export function revertNodeAndRedo(rt: Runtime, taskId: string, nodeId: string, o: { comment?: string; force?: boolean } = {}): RevertResult & { redo: 'retry' | 'rework' | null } {
  const t = rt.getTask(taskId);
  if (TERMINAL.includes(t.state)) throw new Error('任务已终结，无法重做');
  const n = t.nodes.find((x) => x.id === nodeId);
  if (!n) throw new Error('节点不存在');
  const atGate = !!t.gate && (t.gate.kind === 'final' || t.gate.kind === 'reject_limit') && (t.state === 'PendingConfirm' || t.state === 'Review');
  const mode = n.status === 'failed' || n.status === 'cancelled' ? 'retry' : n.status === 'done' && n.kind === 'exec' && n.subtaskId && atGate ? 'rework' : null;
  if (!mode) throw new Error('只能对失败或中断的节点，或在封驳 / 御批关卡处对六部执行节点「撤回并重做」');
  const r = rt.revertNode(taskId, nodeId, { force: o.force });
  rt.audit.record('emperor', 'revert_redo', { nodeId, mode, reverted: r.reverted.length, conflicts: r.conflicts, skipped: r.skipped }, taskId);
  if (r.conflicts.length) return { ...r, redo: null };
  const note = `皇上已撤回「${n.label}」此前的文件改动${r.skipped.length ? `（${r.skipped.join('、')} 为大文件，未能撤回）` : ''}，请在原状态上重做`;
  try {
    if (mode === 'retry') retryNode(rt, taskId, nodeId);
    else decideGate(rt, taskId, { approve: false, comment: [o.comment?.trim(), note].filter(Boolean).join('\n'), reworkTargets: [n.subtaskId!] });
  } catch (e) {
    throw new Error(`已撤回 ${r.reverted.length} 个文件，但重做未能开始：${(e as Error).message}`);
  }
  return { ...r, redo: mode };
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
    case 'check':
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
