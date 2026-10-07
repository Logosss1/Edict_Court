// 协同设计解释器 — runs a declarative CollabDesign (never the built-in 三省六部, which stays on the native
// engine). Each step becomes persisted RunNodes (stable ids per loop iteration, so local retry and
// restart recovery work exactly like the native engine); each step's phase is shown as the protected
// Edict state, so the state machine, kanban, court and memorial stay in sync.
import type { Plan, RunNode, Task, TaskState } from '../../shared/types';
import { PHASE_STATE, statePath, type CollabDesign, type RoleSpec, type StepSpec } from '../../shared/design';
import { STATE_LABEL } from '../../shared/court';
import { runAgent, type RoleRun } from './agentLoop';
import { EXEC_OUTPUT_RULE } from './souls';
import { ALL_TOOLS, READ_TOOLS, type ToolName } from './tools';
import { TaskAbortedError, type Runtime } from './runtime';
import { extractJson, now, sha256, truncate } from './util';
import {
  block, ensureNode, otherDoing, parseConclusion, parseVerdict, repoContext, runNode, summarizeChanges, validatePlan, drive,
  type GateDecision,
} from './orchestrator';

type Outcome = { kind: 'next' } | { kind: 'wait' } | { kind: 'goto'; to: string; rework?: string[]; feedback?: string };

const spec = (t: Task) => t.designSpec!;
const run = (t: Task) => (t.flowRun ??= { cursor: 0, iter: {}, rejections: {} });
const iterOf = (t: Task, stepId: string) => run(t).iter[stepId] ?? 1;
const roleOf = (d: CollabDesign, id?: string) => d.roles.find((r) => r.id === id);
export const roleRun = (t: Task, r: RoleSpec): RoleRun => ({ key: `r:${t.design?.id ?? 'x'}:${r.id}`, id: r.id, name: r.name, prompt: r.prompt, modelClass: r.modelClass });

/** Steps that run together starting at `i` (a step plus following `parallel` steps). */
function groupAt(d: CollabDesign, i: number): StepSpec[] {
  const g = [d.steps[i]];
  for (let k = i + 1; k < d.steps.length && d.steps[k].parallel; k++) g.push(d.steps[k]);
  return g;
}

/** Walk the protected state machine to `to` (each hop audited). Returns false when queued behind another task. */
function moveTo(rt: Runtime, t: Task, to: TaskState, remark: string): boolean {
  if (t.state === to) return true;
  if (t.state === 'Next' && to === 'Doing') {
    if (otherDoing(rt, t)) return false;
    rt.transition(t, 'Doing', 'system', '工作区空闲，开始执行');
    return true;
  }
  const path = statePath(t.state, to);
  if (!path) throw new Error(`协同设计无法从 ${STATE_LABEL[t.state]} 流转到 ${STATE_LABEL[to]}`);
  for (const s of path) {
    if (s === 'Doing' && otherDoing(rt, t)) {
      if (t.state === 'Assigned') rt.transition(t, 'Next', 'system', '同一工作区已有旨意在执行，排队候旨');
      return false;
    }
    rt.transition(t, s, 'system', s === to ? remark : '本协同设计无此环节，顺延');
  }
  return true;
}

function toolsFor(rt: Runtime, t: Task, r: RoleSpec, extra: ToolName[] = []): ToolName[] | undefined {
  if (!rt.workspace || t.workspace !== rt.workspace.root || r.toolAccess === 'none') return undefined;
  return r.toolAccess === 'write' ? [...ALL_TOOLS, ...extra.filter((x) => !ALL_TOOLS.includes(x))] : [...READ_TOOLS, ...extra.filter((x) => !READ_TOOLS.includes(x))];
}

const latestNode = (t: Task, stepId: string, pred: (n: RunNode) => boolean = () => true) =>
  [...t.nodes].reverse().find((n) => n.stepId === stepId && n.status === 'done' && pred(n));

/** Latest output of a step (fanout: every subtask's latest conclusion). */
function stepOutput(t: Task, s: StepSpec): string {
  if (s.type === 'fanout') {
    const plan = planFor(t, s.planStep!);
    if (!plan) return '';
    return plan.subtasks.map((st) => `- ${st.id} ${st.title}（${roleOf(spec(t), st.dept)?.name ?? st.dept}）：${truncate(latestNode(t, s.id, (n) => n.subtaskId === st.id)?.output ?? '无', 1200)}`).join('\n');
  }
  return latestNode(t, s.id)?.output ?? '';
}

function planFor(t: Task, planStepId: string): Plan | undefined {
  const n = latestNode(t, planStepId);
  if (!n?.output) return undefined;
  try {
    return JSON.parse(n.output) as Plan;
  } catch {
    return undefined;
  }
}

function context(t: Task, s: StepSpec): string {
  const d = spec(t);
  const idx = d.steps.findIndex((x) => x.id === s.id);
  const ids = s.inputs ?? d.steps.slice(0, idx).map((x) => x.id);
  const parts = ids
    .map((id) => d.steps.find((x) => x.id === id)!)
    .filter((x) => x && x.id !== s.id)
    .map((x) => {
      const out = stepOutput(t, x);
      return out ? `【${x.label}的产出】\n${truncate(out, 2500)}` : '';
    })
    .filter(Boolean);
  return parts.join('\n\n');
}

function header(t: Task, s: StepSpec) {
  return [`【旨意】${t.title}\n${truncate(t.edict, 3000)}`, `【本步骤：${s.label}】\n${s.instruction}`];
}

// ───────────────────────── driver ─────────────────────────
export async function flowStep(rt: Runtime, t: Task): Promise<boolean> {
  const d = spec(t);
  const r = run(t);
  if (t.state === 'PendingConfirm') {
    if (!t.gate) rt.setGate(t, { kind: 'final', message: '请御览回奏与改动：准奏则结案，封驳则发回返工' });
    return false;
  }
  if (r.cursor >= d.steps.length) return finish(rt, t);
  const group = groupAt(d, r.cursor);
  if (!moveTo(rt, t, PHASE_STATE[group[0].phase], `进入「${group[0].label}」`)) return false;
  if (t.state === 'Next') return false;
  let outcomes: Outcome[];
  if (group.length === 1) outcomes = [await execStep(rt, t, group[0])];
  else {
    const settled = await Promise.allSettled(group.map((s) => execStep(rt, t, s)));
    const aborted = settled.find((x) => x.status === 'rejected' && x.reason instanceof TaskAbortedError);
    if (aborted) throw new TaskAbortedError();
    const failed = settled.map((x, i) => (x.status === 'rejected' ? group[i].label : null)).filter(Boolean);
    if (failed.length) {
      block(rt, t, `${failed.join('、')} 执行失败。可对失败节点「局部重试」`);
      return false;
    }
    outcomes = settled.map((x) => (x as PromiseFulfilledResult<Outcome>).value);
  }
  const o = outcomes.find((x) => x.kind !== 'next') ?? { kind: 'next' };
  if (o.kind === 'wait') return false;
  if (o.kind === 'goto') {
    jump(rt, t, group[0], o.to, o.rework, o.feedback);
    return true;
  }
  r.cursor += group.length;
  rt.touch(t);
  return true;
}

/** Loop back: bump iterations of every step from the target up to (and including) the rejecting step. */
function jump(rt: Runtime, t: Task, from: StepSpec, to: string, rework?: string[], feedback?: string) {
  const d = spec(t);
  const r = run(t);
  const a = d.steps.findIndex((x) => x.id === to);
  const b = d.steps.findIndex((x) => x.id === from.id);
  for (let i = a; i <= Math.max(a, b); i++) r.iter[d.steps[i].id] = iterOf(t, d.steps[i].id) + 1;
  r.cursor = a;
  const target = d.steps[a];
  if (target.type === 'fanout') {
    const plan = planFor(t, target.planStep!);
    const valid = (rework ?? []).filter((id) => plan?.subtasks.some((s) => s.id === id));
    t.execRound = (t.execRound ?? 1) + 1;
    t.rework = { round: t.execRound, targets: valid.length ? valid : (plan?.subtasks.map((s) => s.id) ?? []), feedback: feedback ?? '', by: from.role === undefined ? 'emperor' : 'menxia' };
    rt.audit.record(from.role ? 'system' : 'emperor', 'rework_ordered', { round: t.execRound, targets: t.rework.targets, feedback: truncate(feedback ?? '', 500), step: target.id }, t.id);
  }
  rt.audit.record('system', 'flow_jump', { from: from.id, to, iteration: r.iter[to] }, t.id);
  rt.touch(t);
}

async function finish(rt: Runtime, t: Task): Promise<boolean> {
  const d = spec(t);
  if (d.policies.finalGate) {
    if (!moveTo(rt, t, 'Review', '流程完成，汇总待审')) return false;
    rt.transition(t, 'PendingConfirm', 'system', '回奏待皇上御批');
    rt.setGate(t, { kind: 'final', message: '请御览回奏与改动：准奏则结案，封驳则发回返工' });
    return false;
  }
  if (t.state !== 'Doing' && t.state !== 'Review') moveTo(rt, t, 'Review', '流程完成');
  rt.transition(t, 'Done', 'system', '协同设计流程完成，结案');
  return true;
}

// ───────────────────────── steps ─────────────────────────
async function execStep(rt: Runtime, t: Task, s: StepSpec): Promise<Outcome> {
  switch (s.type) {
    case 'agent':
    case 'summary':
      return agentStep(rt, t, s);
    case 'plan':
      return planStep(rt, t, s);
    case 'review':
      return reviewStep(rt, t, s);
    case 'fanout':
      return fanoutStep(rt, t, s);
    case 'gate':
      return gateStep(rt, t, s);
  }
}

function nodeFor(t: Task, s: StepSpec, kind: RunNode['kind'], extra: Partial<RunNode> = {}, suffix = '') {
  const it = iterOf(t, s.id);
  const r = roleOf(spec(t), s.role);
  return ensureNode(t, `s-${s.id}-${it}${suffix}`, { kind, agentId: r?.avatar ?? 'shangshu', label: `${s.label}${it > 1 ? `（第 ${it} 轮）` : ''}`, stepId: s.id, iter: it, roleId: r?.id, roleName: r?.name, ...extra });
}

async function agentStep(rt: Runtime, t: Task, s: StepSpec): Promise<Outcome> {
  const role = roleOf(spec(t), s.role)!;
  const node = nodeFor(t, s, s.type === 'summary' ? 'summary' : s.phase === 'dispatch' ? 'dispatch' : 'step');
  if (node.status === 'done') return { kind: 'next' };
  await runNode(rt, t, node, async () => {
    const tools = toolsFor(rt, t, role);
    const parts = [...header(t, s), context(t, s)];
    if (s.type === 'summary') parts.push(`【系统核验的文件改动】\n${summarizeChanges(t) || '无'}`);
    if (tools) parts.push(repoContext(rt, t));
    if (s.output === 'conclusion') parts.push(EXEC_OUTPUT_RULE);
    const r = await runAgent({ rt, agentId: role.avatar, role: roleRun(t, role), task: t, node, prompt: parts.filter(Boolean).join('\n\n'), tools, maxSteps: tools ? 24 : 1, maxTokens: s.output === 'conclusion' ? 8000 : 4000, temperature: 0.2, label: node.label });
    if (s.type === 'summary') t.result = { summary: r.text.trim(), artifacts: t.result?.artifacts ?? [] };
    if (s.output === 'conclusion') {
      const c = parseConclusion(r.text);
      if (c.status === 'failed') throw new Error(`${role.name}自报失败：${c.summary}`);
      return JSON.stringify(c);
    }
    return truncate(r.text.trim(), 6000);
  });
  return { kind: 'next' };
}

const executorMap = (t: Task, s: StepSpec) => Object.fromEntries((s.executors ?? []).map((id) => [id, roleOf(spec(t), id)?.name ?? id]));

async function planStep(rt: Runtime, t: Task, s: StepSpec): Promise<Outcome> {
  const role = roleOf(spec(t), s.role)!;
  const node = nodeFor(t, s, 'plan');
  if (node.status === 'done') return { kind: 'next' };
  const allowed = executorMap(t, s);
  await runNode(rt, t, node, async () => {
    const prev = t.planHistory.at(-1);
    const lastRej = [...t.reviews].reverse().find((x) => x.stage === 'plan' && x.verdict === 'reject');
    const tools = toolsFor(rt, t, role);
    const parts = [...header(t, s), context(t, s), tools ? repoContext(rt, t) : ''];
    if (prev && lastRej && lastRej.at > prev.at) {
      parts.push(`【上一版方案 v${prev.version}】\n${JSON.stringify(prev.plan, null, 1)}`);
      parts.push(`【${lastRej.reviewer === 'emperor' ? '皇上' : '审议'}封驳意见（第 ${lastRej.round} 轮）】\n${lastRej.comment}\n${lastRej.issues.map((i, k) => `${k + 1}. ${i}`).join('\n')}\n必须逐条修正。`);
    }
    parts.push(`【可分派的执行角色】\n${(s.executors ?? []).map((id) => `- ${id}：${allowed[id]}（${roleOf(spec(t), id)?.duty ?? ''}）`).join('\n')}`);
    parts.push('只输出一个方案 JSON（dept 填执行角色 id）：{"summary":"方案概述","subtasks":[{"id":"S1","title":"","dept":"角色id","detail":"","acceptance":"可验证的验收标准","dependsOn":[]}],"risks":[]}');
    const r = await runAgent({ rt, agentId: role.avatar, role: roleRun(t, role), task: t, node, prompt: parts.filter(Boolean).join('\n\n'), tools, maxSteps: tools ? 6 : 1, maxTokens: 4000, temperature: 0.3, label: node.label });
    let v = validatePlan(extractJson(r.text), allowed);
    if (!v.plan) {
      rt.activity('log', `${role.name}方案格式不合规（${v.error}），要求修正`, { taskId: t.id, agentId: role.avatar, nodeId: node.id });
      const r2 = await runAgent({ rt, agentId: role.avatar, role: roleRun(t, role), task: t, node, history: r.messages, prompt: `方案不合规：${v.error}。请只输出一个合法的方案 JSON 对象，不要其他文字。`, maxTokens: 4000, temperature: 0, label: `${role.name}修正格式` });
      v = validatePlan(extractJson(r2.text), allowed);
    }
    if (!v.plan) throw new Error(`${role.name}方案格式无效：${v.error}`);
    const version = t.planHistory.length + 1;
    t.planHistory.push({ version, plan: v.plan, author: 'zhongshu', at: now() });
    t.plan = v.plan;
    rt.audit.record(role.avatar, 'plan_submitted', { version, step: s.id, role: role.id, subtasks: v.plan.subtasks.map((x) => ({ id: x.id, dept: x.dept, title: x.title })), hash: sha256(JSON.stringify(v.plan)) }, t.id);
    return JSON.stringify(v.plan);
  });
  return { kind: 'next' };
}

async function reviewStep(rt: Runtime, t: Task, s: StepSpec): Promise<Outcome> {
  const d = spec(t);
  const role = roleOf(d, s.role)!;
  const target = d.steps.find((x) => x.id === s.onReject!.goto)!;
  const stage: 'plan' | 'result' = target.type === 'plan' ? 'plan' : 'result';
  const node = nodeFor(t, s, stage === 'plan' ? 'review' : 'result_review');
  let verdict: ReturnType<typeof parseVerdict> = null;
  if (node.status === 'done') {
    // restart / re-entry: re-derive the outcome from the recorded verdict
    try {
      const j = JSON.parse(node.output ?? '{}');
      if (j.verdict) verdict = j;
    } catch {
      /* fall through */
    }
    if (verdict && node.id === lastAppliedReview(t, s)) return { kind: 'next' };
  } else {
    await runNode(rt, t, node, async () => {
      const prior = t.reviews.filter((x) => x.stage === stage);
      const tools = toolsFor(rt, t, role, ['view_changes']);
      const parts = [
        ...header(t, s),
        context(t, s),
        prior.length ? `【此前审议】\n${prior.map((x) => `第${x.round}轮 ${x.verdict === 'approve' ? '准奏' : '封驳'}：${x.comment}`).join('\n')}` : '',
        stage === 'result' ? `【系统核验的文件改动】\n${summarizeChanges(t) || '无'}` : '',
        `这是第 ${iterOf(t, s.id)} 轮审议（封驳上限 ${s.onReject!.max} 次，超限将升级皇上裁决）。只输出 JSON：{"verdict":"approve"|"reject","issues":[],"comment":"","rework":[${stage === 'result' ? '"需返工的子任务 id"' : ''}]}`,
      ];
      const r = await runAgent({ rt, agentId: role.avatar, role: roleRun(t, role), task: t, node, prompt: parts.filter(Boolean).join('\n\n'), tools, maxSteps: tools ? 6 : 1, maxTokens: 1500, temperature: 0.2, label: node.label });
      verdict = parseVerdict(r.text);
      if (!verdict) {
        const r2 = await runAgent({ rt, agentId: role.avatar, role: roleRun(t, role), task: t, node, history: r.messages, prompt: '请只输出审议结论 JSON：{"verdict":"approve"|"reject","issues":[],"comment":"","rework":[]}', maxTokens: 800, temperature: 0, label: `${role.name}修正格式` });
        verdict = parseVerdict(r2.text);
      }
      return JSON.stringify(verdict ?? { error: '审议结论无法解析' });
    });
  }
  if (!verdict) {
    rt.setGate(t, { kind: 'reject_limit', message: `${role.name}的审议结论无法解析，关卡不可跳过——请皇上亲自裁决（准奏 / 封驳）`, nodeId: node.id });
    return { kind: 'wait' };
  }
  const v = verdict as NonNullable<ReturnType<typeof parseVerdict>>;
  const round = t.reviews.filter((x) => x.stage === stage).length + 1;
  t.reviews.push({ round, stage, verdict: v.verdict, issues: v.issues, comment: v.comment, reviewer: 'menxia', at: now() });
  run(t).lastReview = { ...(run(t).lastReview ?? {}), [s.id]: node.id };
  rt.audit.record(role.avatar, `${stage}_${v.verdict === 'approve' ? 'approved' : 'rejected'}`, { round, step: s.id, role: role.id, issues: v.issues, comment: v.comment, rework: v.rework }, t.id);
  rt.activity('log', `${role.name}${v.verdict === 'approve' ? '✅ 准奏' : '❌ 封驳'}：${v.comment}${v.issues.length ? '\n' + v.issues.map((i) => '· ' + i).join('\n') : ''}`, { taskId: t.id, agentId: role.avatar, nodeId: node.id, data: { verdict: v.verdict } });
  rt.touch(t);
  if (v.verdict === 'approve') {
    if (s.gate === 'plan') {
      rt.setGate(t, { kind: 'plan', message: `${role.name}已准奏。请皇上御览方案——可直接涂改后放行，或封驳重拟`, nodeId: node.id });
      return { kind: 'wait' };
    }
    return { kind: 'next' };
  }
  const r = run(t);
  r.rejections[s.id] = (r.rejections[s.id] ?? 0) + 1;
  if (r.rejections[s.id] > s.onReject!.max) {
    rt.setGate(t, { kind: 'reject_limit', message: `${role.name}已封驳 ${r.rejections[s.id]} 次，超出上限 ${s.onReject!.max}，请皇上裁决`, nodeId: node.id });
    return { kind: 'wait' };
  }
  return { kind: 'goto', to: target.id, rework: v.rework, feedback: [v.comment, ...v.issues].filter(Boolean).join('\n') };
}

const lastAppliedReview = (t: Task, s: StepSpec) => run(t).lastReview?.[s.id];

async function fanoutStep(rt: Runtime, t: Task, s: StepSpec): Promise<Outcome> {
  const d = spec(t);
  const plan = planFor(t, s.planStep!);
  if (!plan) throw new Error(`「${s.label}」找不到可执行的规划（${s.planStep}）`);
  const it = iterOf(t, s.id);
  const targets = it === 1 || !t.rework?.targets.length ? plan.subtasks.map((x) => x.id) : t.rework.targets.filter((id) => plan.subtasks.some((x) => x.id === id));
  const isDone = (subId: string) => !!latestNode(t, s.id, (n) => n.subtaskId === subId);
  const nodes = targets.map((id) => {
    const sub = plan.subtasks.find((x) => x.id === id)!;
    const r = roleOf(d, sub.dept);
    if (!r) throw new Error(`子任务 ${id} 的执行角色不存在：${sub.dept}`);
    return ensureNode(t, `s-${s.id}-${it}-${id}`, { kind: 'exec', agentId: r.avatar, label: `${r.name}·${sub.title}${it > 1 ? `（返工 ${it - 1}）` : ''}`, subtaskId: id, stepId: s.id, iter: it, roleId: r.id, roleName: r.name });
  });
  rt.touch(t);
  const limit = Math.max(1, d.policies.parallelism || rt.settings.parallelism);
  const running = new Map<string, Promise<void>>();
  const failed: string[] = [];
  const doneThisRound = (n: RunNode) => n.status === 'done';
  while (true) {
    const pending = nodes.filter((n) => n.status === 'pending');
    const ready = pending.filter((n) => plan.subtasks.find((x) => x.id === n.subtaskId)!.dependsOn.every((dep) => (targets.includes(dep) ? doneThisRound(nodes.find((m) => m.subtaskId === dep)!) : isDone(dep))));
    for (const n of ready) {
      if (running.size >= limit) break;
      if (running.has(n.id)) continue;
      const p = execSubtask(rt, t, s, plan, n)
        .catch((e) => {
          if (e instanceof TaskAbortedError) throw e;
          failed.push(n.label);
        })
        .finally(() => running.delete(n.id));
      running.set(n.id, p);
    }
    if (!running.size) break;
    await Promise.race(running.values());
  }
  const stuck = nodes.filter((n) => n.status === 'pending');
  const bad = nodes.filter((n) => n.status === 'failed' || n.status === 'cancelled');
  if (bad.length || stuck.length) {
    block(rt, t, `${bad.length ? `${bad.map((n) => n.label).join('、')} 执行失败` : ''}${stuck.length ? `；${stuck.length} 个子任务因依赖未完成而未启动` : ''}。可对失败节点「局部重试」`);
    return { kind: 'wait' };
  }
  return { kind: 'next' };
}

async function execSubtask(rt: Runtime, t: Task, s: StepSpec, plan: Plan, node: RunNode): Promise<void> {
  const d = spec(t);
  const sub = plan.subtasks.find((x) => x.id === node.subtaskId)!;
  const role = roleOf(d, sub.dept)!;
  await runNode(rt, t, node, async () => {
    const deps = sub.dependsOn.map((dep) => `- ${dep}（${roleOf(d, plan.subtasks.find((x) => x.id === dep)?.dept)?.name ?? dep}）结论：${truncate(latestNode(t, s.id, (n) => n.subtaskId === dep)?.output ?? '无', 1200)}`);
    const prev = latestNode(t, s.id, (n) => n.subtaskId === sub.id && n.id !== node.id);
    const tools = toolsFor(rt, t, role);
    const parts = [
      `【旨意】${t.title}\n${truncate(t.edict, 3000)}`,
      `【方案概述】${plan.summary}`,
      `【你的子任务 ${sub.id}】${sub.title}\n做法：${sub.detail}\n验收标准：${sub.acceptance}`,
      // context: explicit inputs, or by default the dispatch-phase steps (e.g. 尚书执行令) before this fan-out
      context(t, { ...s, inputs: (s.inputs ?? d.steps.slice(0, d.steps.findIndex((x) => x.id === s.id)).filter((x) => x.phase === 'dispatch').map((x) => x.id)).filter((x) => x !== s.planStep) }),
      deps.length ? `【上游子任务结论】\n${deps.join('\n')}` : '',
      (node.iter ?? 1) > 1 ? `【返工要求】\n${t.rework?.feedback ?? ''}\n【你上一轮的结论】${truncate(prev?.output ?? '无', 1500)}` : '',
      tools ? repoContext(rt, t) : '（无文件工具：请直接在结论中给出成果文本）',
      s.instruction || EXEC_OUTPUT_RULE,
      s.instruction === EXEC_OUTPUT_RULE ? '' : EXEC_OUTPUT_RULE,
    ].filter(Boolean);
    const r = await runAgent({ rt, agentId: role.avatar, role: roleRun(t, role), task: t, node, prompt: parts.join('\n\n'), tools, maxSteps: 30, maxTokens: 8000, temperature: 0.2, label: node.label });
    const c = parseConclusion(r.text);
    const checks: string[] = [];
    if (rt.workspace && t.workspace === rt.workspace.root) {
      for (const a of c.artifacts) {
        try {
          const buf = rt.workspace.readBuffer(a);
          checks.push(buf ? `${a} ✓ sha256:${sha256(buf).slice(0, 12)}` : `${a} ✗ 不存在`);
        } catch (e) {
          checks.push(`${a} ✗ ${(e as Error).message}`);
        }
      }
      const touched = t.changes.filter((ch) => ch.nodeId === node.id).map((ch) => `${ch.op}:${ch.path}`);
      checks.push(`系统记录的改动：${touched.length ? touched.join(', ') : '无'}`);
    }
    if (c.status === 'failed') throw new Error(`${role.name}自报失败：${c.summary}`);
    return JSON.stringify({ ...c, systemCheck: checks });
  });
}

async function gateStep(rt: Runtime, t: Task, s: StepSpec): Promise<Outcome> {
  const node = nodeFor(t, s, 'gate', { agentId: 'shangshu' });
  if (node.status === 'done') return { kind: 'next' };
  node.status = 'waiting';
  rt.setGate(t, { kind: s.gate === 'plan' ? 'plan' : 'final', message: s.instruction || '请皇上裁决', nodeId: node.id });
  return { kind: 'wait' };
}

// ───────────────────────── human decisions on flow tasks ─────────────────────────
export function flowDecideGate(rt: Runtime, t: Task, dcs: GateDecision) {
  const d = spec(t);
  const g = t.gate!;
  const comment = (dcs.comment ?? '').trim();
  const r = run(t);
  const step = d.steps[r.cursor];
  if (g.kind === 'final' && t.state === 'PendingConfirm') {
    t.gate = undefined;
    if (dcs.approve) {
      rt.transition(t, 'Done', 'emperor', `皇上准奏结案${comment ? '：' + comment : ''}`);
      return;
    }
    const lastFan = [...d.steps].reverse().find((x) => x.type === 'fanout') ?? d.steps.find((x) => x.phase === 'execute') ?? d.steps[0];
    jump(rt, t, { ...lastFan, id: d.steps.at(-1)!.id, role: undefined }, lastFan.id, dcs.reworkTargets, comment || '皇上封驳回奏，请返工');
    rt.transition(t, 'Review', 'emperor', '皇上封驳回奏');
    void drive(rt, t.id);
    return;
  }
  if (!step) throw new Error('流程状态异常：没有当前步骤');
  if (step.type === 'gate') {
    const node = t.nodes.find((n) => n.id === g.nodeId);
    t.gate = undefined;
    if (node) {
      node.status = 'done';
      node.output = JSON.stringify({ verdict: dcs.approve ? 'approve' : 'reject', comment });
      node.endedAt = now();
    }
    if (dcs.approve || !step.onReject) r.cursor += 1;
    else jump(rt, t, { ...step, role: undefined }, step.onReject.goto, dcs.reworkTargets, comment || '皇上封驳');
    rt.touch(t);
    void drive(rt, t.id);
    return;
  }
  if (step.type === 'review' && (g.kind === 'plan' || g.kind === 'reject_limit')) {
    const target = d.steps.find((x) => x.id === step.onReject!.goto)!;
    if (dcs.plan && target.type === 'plan') {
      const v = validatePlan(dcs.plan, executorMap(t, target));
      if (!v.plan) throw new Error(`涂改后的方案无效：${v.error}`);
      if (JSON.stringify(t.plan) !== JSON.stringify(v.plan)) {
        const version = t.planHistory.length + 1;
        t.planHistory.push({ version, plan: v.plan, author: 'emperor', at: now(), note: comment || '皇上朱笔涂改' });
        t.plan = v.plan;
        // the edited plan becomes the plan step's output for this iteration
        const pn = latestNode(t, target.id);
        if (pn) pn.output = JSON.stringify(v.plan);
        rt.audit.record('emperor', 'plan_edited', { version, step: target.id, subtasks: v.plan.subtasks.map((x) => `${x.id}:${x.dept}:${x.title}`) }, t.id);
        rt.activity('human', `皇上朱笔涂改方案 → v${version}（${v.plan.subtasks.length} 个子任务）`, { taskId: t.id });
      }
    }
    const stage: 'plan' | 'result' = target.type === 'plan' ? 'plan' : 'result';
    t.reviews.push({ round: t.reviews.filter((x) => x.stage === stage).length + 1, stage, verdict: dcs.approve ? 'approve' : 'reject', issues: comment ? [comment] : [], comment: comment || (dcs.approve ? '皇上准奏' : '皇上封驳'), reviewer: 'emperor', at: now() + 1 });
    t.gate = undefined;
    r.lastReview = { ...(r.lastReview ?? {}), [step.id]: t.nodes.find((n) => n.id === g.nodeId)?.id ?? '' };
    if (dcs.approve) r.cursor += 1;
    else jump(rt, t, { ...step, role: undefined }, target.id, dcs.reworkTargets, comment || '皇上封驳');
    rt.touch(t);
    void drive(rt, t.id);
    return;
  }
  throw new Error(`当前关卡（${g.kind}）不适用于此协同设计步骤`);
}
