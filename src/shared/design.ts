// 协同设计（CollabDesign）— a multi-agent collaboration logic as a named, versioned, declarative
// object. The built-in 三省六部 is executed by the native engine (orchestrator.ts); every other
// design is pure data interpreted by runtime/flow.ts. Nothing here is executable code.
import type { AgentId, TaskState, Tier } from './types';
import { BASE_TRANSITIONS } from './court';

export const DESIGN_SCHEMA = 'edict.collab/1';
export const BUILTIN_DESIGN_ID = 'edict-court';

export type DesignPhase = 'plan' | 'review' | 'dispatch' | 'execute' | 'report' | 'confirm';
export type StepType = 'agent' | 'plan' | 'review' | 'fanout' | 'summary' | 'gate';
export type StepOutput = 'text' | 'plan' | 'verdict' | 'conclusion';
export type ToolAccess = 'none' | 'read' | 'write';

/** Lifecycle phase → the protected Edict state it is shown as (kanban, court, memorial stay in sync). */
export const PHASE_STATE: Record<DesignPhase, TaskState> = {
  plan: 'Zhongshu',
  review: 'Menxia',
  dispatch: 'Assigned',
  execute: 'Doing',
  report: 'Review',
  confirm: 'PendingConfirm',
};
export const PHASE_LABEL: Record<DesignPhase, string> = { plan: '规划', review: '审议', dispatch: '派发', execute: '执行', report: '汇总', confirm: '待确认' };
const PHASE_ORDER: DesignPhase[] = ['plan', 'review', 'dispatch', 'execute', 'report', 'confirm'];

export interface RoleSpec {
  id: string; // [a-z][a-z0-9_-]*, unique in the design
  name: string;
  duty: string;
  prompt: string; // persona / system prompt — text only
  modelClass: 'strong' | 'economy';
  /** a specific model for this role; unset = follow the strong / economy routing of modelClass */
  model?: { providerId: string; model: string };
  /** 思考程度 for this role (a level, or 'top'); unset = follow the edict / model default */
  effort?: string;
  toolAccess: ToolAccess; // ceiling; the global permission mode still applies on top
  avatar: AgentId; // which pixel official represents this role in the court
}

export interface StepSpec {
  id: string;
  label: string;
  type: StepType;
  phase: DesignPhase;
  role?: string; // performing role (agent / plan / review / summary)
  executors?: string[]; // fanout: roles that may receive subtasks; plan: roles the planner may assign to
  instruction: string; // what this step must do (prompt text)
  inputs?: string[]; // step ids whose latest output is given as context (default: every earlier step)
  parallel?: boolean; // run together with the previous step (same phase)
  output: StepOutput;
  planStep?: string; // fanout: which plan step's subtasks to execute
  onReject?: { goto: string; max: number }; // review / gate: where a rejection sends the flow, and the limit
  gate?: 'plan' | 'final'; // review: ask the emperor after an approval; gate: kind of human gate
  optional?: boolean; // may be skipped when blocked (Phase 3 self-healing)
  timeoutSec?: number;
}

export interface ResiliencePolicy {
  enabled: boolean;
  maxHealActions: number;
  maxExtraCostRatio: number; // fraction of the task budget self-healing may spend
}

export interface DesignPolicies {
  tier: Tier; // budget defaults & labels
  maxRejections: number;
  tokenBudget: number; // 0 = use the tier default
  parallelism: number; // 0 = use the global setting
  finalGate: boolean;
  resilience: ResiliencePolicy;
}

// ───────────────────────── 朝堂布局 (display only) ─────────────────────────
// Where each role stands in the pixel court and what it does when idle. Purely visual: never part of
// the behaviour hash, never read by the runtime.
export type CourtScene = 'taihe' | 'junjichu' | 'liubu' | 'chengtian';
export type CourtPose = 'stand' | 'sit' | 'kneel';
export type CourtFacing = 'front' | 'back' | 'left' | 'right';
export const COURT_SCENES: CourtScene[] = ['taihe', 'junjichu', 'liubu', 'chengtian'];
export const COURT_SCENE_LABEL: Record<CourtScene, string> = { taihe: '太和殿', junjichu: '军机处', liubu: '六部值房', chengtian: '承天门' };
/** idle actions a seat may loop when its role has nothing to do ('' = the usual tea / stretch / look) */
export const COURT_IDLE: Record<string, string> = {
  '': '随意（喝茶、伸腰、张望）', read: '读书', write: '书写', abacus: '打算盘', scheme: '谋划', law: '查律', measure: '丈量',
  seal: '用印', dispatch: '派发', search: '翻查', view: '远望', think: '沉思', tea: '喝茶', talk: '交谈', bow: '作揖',
};
export interface CourtSeat {
  role: string;
  scene: CourtScene;
  x: number; // world units, 0..640
  y: number; // feet, 40..360
  facing: CourtFacing;
  pose: CourtPose;
  idle?: string; // key of COURT_IDLE
  desk?: boolean; // draw a writing desk in front (seated poses)
}
export interface CourtLayout {
  seats: CourtSeat[];
  hideBuiltin: boolean; // true: only this design's roles stand in the court
}

export interface CollabDesign {
  schema: typeof DESIGN_SCHEMA;
  id: string;
  name: string;
  version: number;
  description: string;
  origin: { kind: 'builtin' | 'user' | 'copy' | 'github'; from?: string; url?: string; commit?: string; reportId?: string };
  native?: boolean; // only the built-in 三省六部: executed by the native engine
  roles: RoleSpec[];
  steps: StepSpec[];
  policies: DesignPolicies;
  court?: CourtLayout;
  createdAt: number;
  note?: string; // change note for this version
}

/** What a task records about the design it runs (pinned at creation; switching never affects it). */
export interface DesignPin {
  id: string;
  version: number;
  hash: string;
  name: string;
  native: boolean;
}

export interface DesignInfo {
  id: string;
  name: string;
  description: string;
  native: boolean;
  origin: CollabDesign['origin'];
  status: 'active' | 'disabled';
  favorite?: boolean;
  activeVersion: number;
  latestVersion: number;
  updatedAt?: number;
  versions: { version: number; hash: string; createdAt: number; note?: string }[];
  roles: number;
  steps: number;
}

export const DEFAULT_RESILIENCE: ResiliencePolicy = { enabled: true, maxHealActions: 6, maxExtraCostRatio: 0.3 };

// ───────────────────────── canonical hashing ─────────────────────────
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v as Record<string, unknown>)
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v ?? null);
}

/** The part of a design that defines behaviour (metadata like createdAt / note / version excluded). */
export function designBody(d: CollabDesign) {
  return { schema: d.schema, roles: d.roles, steps: d.steps, policies: d.policies, native: !!d.native };
}

// ───────────────────────── validation ─────────────────────────
const ID_RE = /^[a-z][a-z0-9_-]{0,31}$/;
// any level name a model's ladder can have, plus 'top' (older designs: the model's highest level)
export const ROLE_EFFORTS = ['none', 'off', 'minimal', 'low', 'medium', 'on', 'high', 'xhigh', 'max', 'ultra', 'top'];
export const AVATARS: AgentId[] = ['taizi', 'zhongshu', 'menxia', 'shangshu', 'hubu', 'libu', 'bingbu', 'xingbu', 'gongbu', 'libu_hr', 'zaochao', 'solo'];

/** Shortest legal path between two states over the protected state machine (no terminal / Blocked hops). */
export function statePath(from: TaskState, to: TaskState): TaskState[] | null {
  if (from === to) return [];
  const skip = new Set<TaskState>(['Blocked', 'Cancelled', 'Done']);
  const prev = new Map<TaskState, TaskState>();
  const q: TaskState[] = [from];
  const seen = new Set<TaskState>([from]);
  while (q.length) {
    const s = q.shift()!;
    for (const n of BASE_TRANSITIONS[s] ?? []) {
      if (seen.has(n) || (skip.has(n) && n !== to)) continue;
      seen.add(n);
      prev.set(n, s);
      if (n === to) {
        const path: TaskState[] = [n];
        let c = n;
        while (prev.get(c) && prev.get(c) !== from) {
          c = prev.get(c)!;
          path.unshift(c);
        }
        return path;
      }
      q.push(n);
    }
  }
  return null;
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

/** Structural validation shared by the editor, the importer and the runtime. Never trusts input. */
export function validateDesign(input: unknown): ValidationResult & { design?: CollabDesign } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const d = input as Partial<CollabDesign> | null;
  if (!d || typeof d !== 'object') return { ok: false, errors: ['不是对象'], warnings };
  if (d.schema !== DESIGN_SCHEMA) errors.push(`schema 必须是 ${DESIGN_SCHEMA}`);
  if (!d.name || typeof d.name !== 'string' || d.name.length > 60) errors.push('名称为空或超过 60 字');
  if (d.native) errors.push('只有内置三省六部可以是原生设计');
  const roles = Array.isArray(d.roles) ? d.roles : [];
  const steps = Array.isArray(d.steps) ? d.steps : [];
  if (!roles.length) errors.push('至少需要一个角色');
  if (roles.length > 24) errors.push('角色不超过 24 个');
  if (!steps.length) errors.push('至少需要一个步骤');
  if (steps.length > 40) errors.push('步骤不超过 40 个');
  const roleIds = new Set<string>();
  for (const r of roles) {
    if (!r || typeof r !== 'object') {
      errors.push('角色格式错误');
      continue;
    }
    if (!ID_RE.test(String(r.id))) errors.push(`角色 id 不合法：${r.id}（小写字母开头，仅 a-z 0-9 _ -）`);
    if (roleIds.has(r.id)) errors.push(`角色 id 重复：${r.id}`);
    roleIds.add(r.id);
    if (!r.name) errors.push(`角色 ${r.id} 缺少名称`);
    if (typeof r.prompt !== 'string' || r.prompt.length > 20000) errors.push(`角色 ${r.id} 的提示词缺失或过长（≤20000 字）`);
    if (!['strong', 'economy'].includes(r.modelClass)) errors.push(`角色 ${r.id} 的模型档位无效`);
    if (r.model !== undefined && (!r.model || typeof r.model.providerId !== 'string' || typeof r.model.model !== 'string' || !r.model.providerId || !r.model.model || r.model.model.length > 200)) errors.push(`角色 ${r.id} 指定的模型格式错误`);
    if (r.effort !== undefined && !ROLE_EFFORTS.includes(r.effort)) errors.push(`角色 ${r.id} 的思考程度无效：${r.effort}`);
    if (!['none', 'read', 'write'].includes(r.toolAccess)) errors.push(`角色 ${r.id} 的工具权限无效`);
    if (!AVATARS.includes(r.avatar)) errors.push(`角色 ${r.id} 的朝堂形象无效：${r.avatar}`);
  }
  const stepIds = new Map<string, number>();
  steps.forEach((s, i) => {
    if (!s || typeof s !== 'object') return void errors.push(`第 ${i + 1} 步格式错误`);
    if (!ID_RE.test(String(s.id))) errors.push(`步骤 id 不合法：${s.id}`);
    if (stepIds.has(s.id)) errors.push(`步骤 id 重复：${s.id}`);
    stepIds.set(s.id, i);
  });
  let lastPhase = -1;
  let planSteps = 0;
  steps.forEach((s, i) => {
    if (!s || typeof s !== 'object') return;
    const where = `步骤「${s.label || s.id}」`;
    if (!['agent', 'plan', 'review', 'fanout', 'summary', 'gate'].includes(s.type)) errors.push(`${where} 类型无效：${s.type}`);
    if (!PHASE_ORDER.includes(s.phase)) errors.push(`${where} 阶段无效：${s.phase}`);
    const pi = PHASE_ORDER.indexOf(s.phase);
    if (pi < lastPhase) errors.push(`${where} 的阶段（${PHASE_LABEL[s.phase]}）早于前一步——步骤必须按 规划→审议→派发→执行→汇总→确认 的顺序排列（回退请用审议的「封驳回到」）`);
    lastPhase = Math.max(lastPhase, pi);
    if (s.type !== 'fanout' && s.type !== 'gate') {
      if (!s.role || !roleIds.has(s.role)) errors.push(`${where} 需要指定已存在的执行角色`);
    }
    if (typeof s.instruction !== 'string' || s.instruction.length > 8000) errors.push(`${where} 的说明缺失或过长`);
    const expectOut: Record<string, StepOutput[]> = { agent: ['text', 'conclusion'], plan: ['plan'], review: ['verdict'], fanout: ['conclusion'], summary: ['text'], gate: ['verdict'] };
    if (expectOut[s.type] && !expectOut[s.type].includes(s.output)) errors.push(`${where} 的产出类型应为 ${expectOut[s.type].join(' / ')}`);
    if (s.type === 'plan') {
      planSteps++;
      const ex = s.executors ?? [];
      if (!ex.length) errors.push(`${where}（规划）需要列出可分派的执行角色`);
      for (const e of ex) if (!roleIds.has(e)) errors.push(`${where} 的执行角色不存在：${e}`);
    }
    if (s.type === 'fanout') {
      const p = s.planStep ? steps.find((x) => x.id === s.planStep) : undefined;
      if (!p || p.type !== 'plan' || (stepIds.get(p.id) ?? 99) >= i) errors.push(`${where}（分派执行）必须引用它之前的一个规划步骤`);
    }
    for (const inp of s.inputs ?? []) if (!stepIds.has(inp) || stepIds.get(inp)! >= i) errors.push(`${where} 的输入引用了不存在或在其后的步骤：${inp}`);
    if (s.parallel) {
      if (i === 0) errors.push(`${where} 是第一步，不能与上一步并行`);
      else if (steps[i - 1]?.phase !== s.phase) errors.push(`${where} 与上一步并行时必须处于同一阶段`);
      if (['review', 'gate', 'plan', 'fanout'].includes(s.type)) errors.push(`${where}：${s.type} 类步骤不能并行`);
    }
    if (s.onReject) {
      if (s.type !== 'review' && s.type !== 'gate') errors.push(`${where}：只有审议 / 关卡步骤可以设置封驳去向`);
      const t = stepIds.get(s.onReject.goto);
      if (t === undefined || t >= i) errors.push(`${where} 的封驳去向必须是它之前的步骤`);
      if (!Number.isInteger(s.onReject.max) || s.onReject.max < 0 || s.onReject.max > 10) errors.push(`${where} 的封驳上限应为 0~10`);
    } else if (s.type === 'review') errors.push(`${where}（审议）需要设置封驳去向与上限`);
    if (s.gate && !['plan', 'final'].includes(s.gate)) errors.push(`${where} 关卡类型无效`);
    if (s.type === 'gate' && !s.gate) errors.push(`${where}（关卡）需要指定关卡类型`);
    if (s.timeoutSec !== undefined && (!(s.timeoutSec > 0) || s.timeoutSec > 7200)) errors.push(`${where} 超时应在 1~7200 秒`);
  });
  if (planSteps > 1) warnings.push('有多个规划步骤：分派执行会使用各自引用的规划');
  // every phase hop must be expressible on the protected state machine
  const states = ['Taizi' as TaskState, ...steps.filter((s) => s && PHASE_STATE[s.phase]).map((s) => PHASE_STATE[s.phase])];
  for (let i = 1; i < states.length; i++) if (!statePath(states[i - 1], states[i])) errors.push(`阶段跳转 ${states[i - 1]} → ${states[i]} 无法在受保护的状态机上表达`);
  for (const s of steps) if (s?.onReject && stepIds.has(s.onReject.goto)) {
    const tgt = steps[stepIds.get(s.onReject.goto)!];
    if (!statePath(PHASE_STATE[s.phase], PHASE_STATE[tgt.phase])) errors.push(`封驳回退 ${PHASE_LABEL[s.phase]} → ${PHASE_LABEL[tgt.phase]} 无法在状态机上表达`);
  }
  const p = (d.policies ?? {}) as Partial<DesignPolicies>;
  if (!['lite', 'full'].includes(p.tier as string)) errors.push('policies.tier 应为 lite 或 full（决定预算默认值）');
  const lastStep = steps.at(-1);
  if (lastStep && !['execute', 'report', 'confirm'].includes(lastStep.phase)) errors.push('流程最后一步应处于「执行 / 汇总 / 确认」阶段');
  if (!(Number.isInteger(p.maxRejections) && p.maxRejections! >= 0 && p.maxRejections! <= 10)) errors.push('policies.maxRejections 应为 0~10');
  if (!(typeof p.tokenBudget === 'number' && p.tokenBudget >= 0)) errors.push('policies.tokenBudget 无效');
  if (!(typeof p.parallelism === 'number' && p.parallelism >= 0 && p.parallelism <= 8)) errors.push('policies.parallelism 应为 0~8');
  const rp = p.resilience;
  if (!rp || typeof rp.enabled !== 'boolean' || !(rp.maxHealActions >= 0 && rp.maxHealActions <= 30) || !(rp.maxExtraCostRatio >= 0 && rp.maxExtraCostRatio <= 2)) errors.push('policies.resilience 无效（自愈动作 0~30 次，额外花费比例 0~2）');
  // reachability: every step must be on the forward path (all are, since the list is ordered); warn on unused roles
  const used = new Set<string>();
  for (const s of steps) {
    if (s?.role) used.add(s.role);
    for (const e of s?.executors ?? []) used.add(e);
  }
  if (d.court !== undefined) validateCourt(d.court, roleIds, errors);
  for (const r of roles) if (r && !used.has(r.id)) warnings.push(`角色「${r.name}」没有被任何步骤使用`);
  if (!steps.some((s) => s?.type === 'review' || s?.type === 'gate')) warnings.push('流程中没有任何审议或关卡：产出不经复核直接结案');
  return errors.length ? { ok: false, errors, warnings } : { ok: true, errors, warnings, design: d as CollabDesign };
}

function validateCourt(c: unknown, roleIds: Set<string>, errors: string[]) {
  const l = c as Partial<CourtLayout> | null;
  if (!l || typeof l !== 'object' || !Array.isArray(l.seats) || typeof l.hideBuiltin !== 'boolean') return void errors.push('朝堂布局格式错误');
  if (l.seats.length > 24) errors.push('朝堂布局最多 24 个站位');
  const seen = new Set<string>();
  for (const s of l.seats) {
    if (!s || typeof s !== 'object') {
      errors.push('朝堂站位格式错误');
      continue;
    }
    const who = `朝堂站位「${s.role}」`;
    if (!roleIds.has(s.role)) errors.push(`${who} 对应的角色不存在`);
    if (seen.has(s.role)) errors.push(`${who} 重复：每个角色只能站一个位置`);
    seen.add(s.role);
    if (!COURT_SCENES.includes(s.scene)) errors.push(`${who} 的场景无效`);
    if (!(typeof s.x === 'number' && s.x >= 0 && s.x <= 640 && typeof s.y === 'number' && s.y >= 40 && s.y <= 360)) errors.push(`${who} 的位置超出场景`);
    if (!['front', 'back', 'left', 'right'].includes(s.facing)) errors.push(`${who} 的朝向无效`);
    if (!['stand', 'sit', 'kneel'].includes(s.pose)) errors.push(`${who} 的姿态无效`);
    if (s.idle !== undefined && !(s.idle in COURT_IDLE)) errors.push(`${who} 的空闲动作无效`);
    if (s.desk !== undefined && typeof s.desk !== 'boolean') errors.push(`${who} 的案几设置无效`);
  }
}
