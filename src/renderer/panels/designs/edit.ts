// Pure editing helpers for 协同设计 drafts: templates, reference-safe renames / removals, step
// placement used by the drag-and-drop canvas, and the automatic court seating.
import { AGENT_MAP } from '../../../shared/court';
import type { AgentId } from '../../../shared/types';
import {
  AVATARS, DEFAULT_RESILIENCE, DESIGN_SCHEMA, type CollabDesign, type CourtLayout, type CourtSeat, type DesignPhase, type RoleSpec, type StepSpec, type StepType,
} from '../../../shared/design';

export type Draft = Omit<CollabDesign, 'version' | 'createdAt'> & { version?: number; createdAt?: number };

export const PHASES: DesignPhase[] = ['plan', 'review', 'dispatch', 'execute', 'report', 'confirm'];
export const STEP_TYPES: StepType[] = ['agent', 'plan', 'review', 'fanout', 'summary', 'gate'];
export const STEP_TYPE_LABEL: Record<StepType, string> = { agent: '单人执行', plan: '规划拆解', review: '审议（可封驳）', fanout: '分派执行', summary: '汇总', gate: '皇上关卡' };
export const STEP_TYPE_HINT: Record<StepType, string> = {
  agent: '一个角色独立完成一件事',
  plan: '把旨意拆成子任务，分给执行角色',
  review: '审查前面的产出，不合格就封驳退回',
  fanout: '按规划把子任务分给各执行角色并行去做',
  summary: '把前面的成果汇总成回奏',
  gate: '停下来等皇上（你）亲自批',
};
const TYPE_PHASE: Record<StepType, DesignPhase> = { agent: 'execute', plan: 'plan', review: 'review', fanout: 'execute', summary: 'report', gate: 'confirm' };
export const OUTPUTS: Record<StepType, StepSpec['output'][]> = { agent: ['text', 'conclusion'], plan: ['plan'], review: ['verdict'], fanout: ['conclusion'], summary: ['text'], gate: ['verdict'] };
export const OUTPUT_LABEL: Record<StepSpec['output'], string> = { text: '文字', plan: '方案 JSON', verdict: '审议结论', conclusion: '执行结论' };

export const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));

export function uniqueId(prefix: string, taken: Iterable<string>) {
  const set = new Set(taken);
  if (!set.has(prefix)) return prefix;
  for (let i = 2; ; i++) if (!set.has(`${prefix}${i}`)) return `${prefix}${i}`;
}

export function newRole(d: Draft, avatar?: AgentId): RoleSpec {
  const av = avatar ?? AVATARS.find((a) => !d.roles.some((r) => r.avatar === a)) ?? 'solo';
  const id = uniqueId(av.replace(/[^a-z0-9_-]/g, '') || 'role', d.roles.map((r) => r.id));
  const meta = AGENT_MAP[av];
  return { id, name: meta?.name ?? '新角色', duty: meta?.duty ?? '', prompt: `你是${meta?.name ?? '一名官员'}。${meta?.duty ?? ''}`, modelClass: 'economy', toolAccess: 'read', avatar: av };
}

export function newStep(d: Draft, type: StepType, at = d.steps.length): StepSpec {
  const id = uniqueId(type === 'agent' ? 'step' : type, d.steps.map((s) => s.id));
  const before = d.steps.slice(0, at);
  const role = d.roles[0]?.id;
  const others = d.roles.filter((r) => r.id !== role).map((r) => r.id);
  const base: StepSpec = { id, label: STEP_TYPE_LABEL[type].replace(/（.*）/, ''), type, phase: TYPE_PHASE[type], instruction: '', output: OUTPUTS[type][0] };
  switch (type) {
    case 'agent':
      return { ...base, role, instruction: '请完成这一步，并写清结果。' };
    case 'plan':
      return { ...base, role, executors: others.length ? others : d.roles.map((r) => r.id), instruction: '把旨意拆成 1~4 个子任务，写清每个子任务的目标、负责人和验收标准。' };
    case 'review': {
      const prev = before.at(-1);
      return { ...base, role, onReject: { goto: prev?.id ?? '', max: 2 }, instruction: '从可行性、完整性和风险审议前面的产出。不合格就封驳，并写清要改什么。' };
    }
    case 'fanout': {
      const plan = [...before].reverse().find((s) => s.type === 'plan');
      return { ...base, planStep: plan?.id, executors: plan?.executors ?? others, instruction: '按规划完成分到的子任务，最后写明做了什么、改了哪些文件、如何验证。' };
    }
    case 'summary':
      return { ...base, role, instruction: '汇总前面所有成果，写一份回奏（Markdown）。' };
    case 'gate':
      return { ...base, gate: 'final', instruction: '请皇上御批。' };
  }
}

export function blankDesign(): Draft {
  const d: Draft = {
    schema: DESIGN_SCHEMA, id: '', name: '我的协同设计', description: '', origin: { kind: 'user' }, roles: [], steps: [],
    policies: { tier: 'lite', maxRejections: 2, tokenBudget: 0, parallelism: 0, finalGate: true, resilience: { ...DEFAULT_RESILIENCE } },
  };
  d.roles.push({ ...newRole(d, 'zhongshu'), toolAccess: 'read' });
  d.roles.push({ ...newRole(d, 'bingbu'), toolAccess: 'write' });
  d.steps.push({ ...newStep(d, 'agent'), role: d.roles[1].id, label: '执行', output: 'conclusion' });
  d.steps.push({ ...newStep(d, 'summary'), role: d.roles[0].id, label: '回奏' });
  return d;
}

/** groups of step indices that run together (a step plus the following `parallel` steps) */
export function groupsOf(steps: StepSpec[]): number[][] {
  const out: number[][] = [];
  steps.forEach((s, i) => {
    if (i > 0 && s.parallel && out.length) out[out.length - 1].push(i);
    else out.push([i]);
  });
  return out;
}

export type Drop = { mode: 'insert'; col: number } | { mode: 'join'; col: number };

/**
 * Put `step` (moved from `fromIdx`, or new when null) into the flow: as its own column at `col`
 * ('insert', 0..ncols) or alongside column `col` ('join' → runs in parallel, same phase).
 */
export function placeStep(d: Draft, step: StepSpec, fromIdx: number | null, drop: Drop, phase: DesignPhase): Draft {
  const out = clone(d);
  const groups: (StepSpec | null)[][] = groupsOf(out.steps).map((g) => g.map((i) => out.steps[i]));
  const moving: StepSpec = fromIdx === null ? clone(step) : out.steps[fromIdx];
  if (fromIdx !== null) for (const g of groups) { const k = g.indexOf(moving); if (k >= 0) g[k] = null; }
  if (drop.mode === 'join' && groups[drop.col]?.some((x) => x)) {
    const g = groups[drop.col];
    moving.phase = g.find((x) => x)!.phase;
    g.push(moving);
  } else {
    moving.phase = phase;
    groups.splice(Math.max(0, Math.min(groups.length, drop.col)), 0, [moving]);
  }
  out.steps = [];
  for (const g of groups) {
    const live = g.filter((x): x is StepSpec => !!x);
    live.forEach((s, k) => {
      if (k === 0) delete s.parallel;
      else s.parallel = true;
      out.steps.push(s);
    });
  }
  return out;
}

export function removeStep(d: Draft, idx: number): Draft {
  const out = clone(d);
  const [gone] = out.steps.splice(idx, 1);
  if (!gone) return out;
  if (out.steps[idx]?.parallel && (idx === 0 || !d.steps[idx]?.parallel)) delete out.steps[idx].parallel;
  for (const s of out.steps) {
    if (s.inputs) s.inputs = s.inputs.filter((x) => x !== gone.id);
    if (s.planStep === gone.id) s.planStep = out.steps.find((x) => x.type === 'plan')?.id;
    if (s.onReject?.goto === gone.id) s.onReject.goto = out.steps[Math.max(0, out.steps.indexOf(s) - 1)]?.id ?? '';
  }
  return out;
}

export function renameStep(d: Draft, from: string, to: string): Draft {
  const out = clone(d);
  for (const s of out.steps) {
    if (s.id === from) s.id = to;
    if (s.inputs) s.inputs = s.inputs.map((x) => (x === from ? to : x));
    if (s.planStep === from) s.planStep = to;
    if (s.onReject?.goto === from) s.onReject.goto = to;
  }
  return out;
}

export function renameRole(d: Draft, from: string, to: string): Draft {
  const out = clone(d);
  for (const r of out.roles) if (r.id === from) r.id = to;
  for (const s of out.steps) {
    if (s.role === from) s.role = to;
    if (s.executors) s.executors = s.executors.map((x) => (x === from ? to : x));
  }
  for (const seat of out.court?.seats ?? []) if (seat.role === from) seat.role = to;
  return out;
}

export function removeRole(d: Draft, id: string): Draft {
  const out = clone(d);
  out.roles = out.roles.filter((r) => r.id !== id);
  for (const s of out.steps) {
    if (s.role === id) s.role = undefined;
    if (s.executors) s.executors = s.executors.filter((x) => x !== id);
  }
  if (out.court) out.court.seats = out.court.seats.filter((x) => x.role !== id);
  return out;
}

/** Which roles a step involves (performer + executors) — for highlighting. */
export const stepRoles = (s: StepSpec) => [...(s.role ? [s.role] : []), ...(s.executors ?? [])];

// ───────────────────────── 朝堂排班 ─────────────────────────
// the built-in 太和殿 rows (east faces left, west faces right), then a row in 军机处
const TAIHE_EAST: [number, number][] = [[390, 226], [444, 226], [390, 280], [444, 280], [390, 334], [444, 334]];
const TAIHE_WEST: [number, number][] = [[250, 226], [196, 226], [250, 280], [196, 280], [250, 334]];

export function autoLayout(d: Draft): CourtLayout {
  const seats: CourtSeat[] = [];
  let e = 0;
  let w = 0;
  d.roles.forEach((r, i) => {
    if (i % 2 === 0 && e < TAIHE_EAST.length) {
      const [x, y] = TAIHE_EAST[e++];
      seats.push({ role: r.id, scene: 'taihe', x, y, facing: 'left', pose: 'stand' });
    } else if (w < TAIHE_WEST.length) {
      const [x, y] = TAIHE_WEST[w++];
      seats.push({ role: r.id, scene: 'taihe', x, y, facing: 'right', pose: 'stand' });
    } else if (e < TAIHE_EAST.length) {
      const [x, y] = TAIHE_EAST[e++];
      seats.push({ role: r.id, scene: 'taihe', x, y, facing: 'left', pose: 'stand' });
    } else {
      const k = seats.filter((s) => s.scene === 'junjichu').length;
      seats.push({ role: r.id, scene: 'junjichu', x: 70 + (k % 9) * 60, y: 300 + Math.floor(k / 9) * 40, facing: 'front', pose: 'sit', desk: true, idle: 'write' });
    }
  });
  return { seats, hideBuiltin: true };
}

/** sheet frame of a still pose, for CSS previews (row-major, 8 columns) */
export function poseFrame(seat: Pick<CourtSeat, 'facing' | 'pose'>): number {
  if (seat.pose === 'sit') return 104; // sit_idle
  if (seat.pose === 'kneel') return 24; // kneel
  if (seat.facing === 'back') return 8; // walk_up[0]
  if (seat.facing === 'left' || seat.facing === 'right') return 12; // walk_side[0]
  return 0;
}

/** CSS for one 32×48 frame of a character sheet */
export function spriteStyle(avatar: string, frame: number, flip = false): Record<string, string> {
  return {
    backgroundImage: `url(../assets/pixel/chars/${avatar}.png)`,
    backgroundSize: '256px 720px',
    backgroundPosition: `${-(frame % 8) * 32}px ${-Math.floor(frame / 8) * 48}px`,
    transform: flip ? 'scaleX(-1)' : '',
  };
}
