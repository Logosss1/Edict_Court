// 定时旨意 (2.1): the emperor sets edicts to be issued at set times (each day, some weekdays, every N hours,
// each morning court, or once), with a cap on what they may do. Officials may propose one; it only takes
// effect once the emperor approves it. Checked every 30 seconds while Edict runs: nothing is installed to run
// in the background. A time missed while Edict was closed or the Mac asleep runs once when back (never once
// per missed time), or is skipped, as the schedule says. A run whose previous edict is still going is skipped
// and noted. Schedules live in the kv table ('schedules') of edict.db.
import fs from 'node:fs';
import type { AgentId, EdictSchedule, ModelRef, PermissionMode, ScheduleRule, ScheduleRun, SchedulePermission, ScheduleStop, Task, Tier } from '../../shared/types';
import { TERMINAL, agentName } from '../../shared/court';
import { PERMISSION_TEXT, describeRule, fmtDateTime, nextFire, parseTime, permissionsFor, ruleProblem } from '../../shared/schedule';
import type { ToolSpec } from '../llm/types';
import type { Runtime } from './runtime';
import { now, truncate, uid } from './util';

export const TICK_MS = 30_000;
/** this much after its time a run counts as missed (Edict closed, the Mac asleep) rather than just due */
export const MISSED_AFTER_MS = 5 * 60_000;
const HISTORY = 30;
const KV = 'schedules';

/** What the 定时旨意 page sends when saving (ids and bookkeeping stay with the store). */
export interface ScheduleDraft {
  id?: string;
  title: string;
  text: string;
  workspace: string | null;
  tier: Tier;
  designId?: string;
  model?: ModelRef | null;
  effort?: string;
  rule: ScheduleRule;
  permission: SchedulePermission;
  stop: ScheduleStop;
  missed: 'once' | 'skip';
  enabled: boolean;
}

const TIERS: Tier[] = ['solo', 'lite', 'full'];

function cleanRule(r: unknown): ScheduleRule | null {
  const x = (r ?? {}) as Record<string, unknown>;
  switch (x.kind) {
    case 'daily':
      return parseTime(x.time) ? { kind: 'daily', time: String(x.time).trim().padStart(5, '0') } : null;
    case 'weekly': {
      const days = [...new Set((Array.isArray(x.days) ? x.days : []).map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort();
      return parseTime(x.time) && days.length ? { kind: 'weekly', days, time: String(x.time).trim().padStart(5, '0') } : null;
    }
    case 'interval': {
      const h = Number(x.hours);
      return Number.isFinite(h) && h >= 1 && h <= 720 ? { kind: 'interval', hours: Math.round(h * 100) / 100 } : null;
    }
    case 'court':
      return { kind: 'court' };
    case 'once': {
      const at = Number(x.at);
      return Number.isFinite(at) && at > 0 ? { kind: 'once', at } : null;
    }
    default:
      return null;
  }
}

function cleanStop(s: unknown): ScheduleStop {
  const x = (s ?? {}) as Record<string, unknown>;
  if (x.kind === 'count' && Number(x.n) >= 1) return { kind: 'count', n: Math.min(10_000, Math.floor(Number(x.n))) };
  if (x.kind === 'until' && Number(x.at) > 0) return { kind: 'until', at: Number(x.at) };
  return { kind: 'never' };
}

/** A scheduled Solo edict has no worktree: the worktree cap falls back to asking. */
const capFor = (tier: Tier, p: unknown): SchedulePermission => {
  const want: SchedulePermission = p === 'readonly' || p === 'ask' || p === 'worktree' ? p : 'readonly';
  return permissionsFor(tier).includes(want) ? want : 'ask';
};

/**
 * The permission mode a scheduled edict runs under. 「在旨意工作树里改」 is 全自动 inside its own worktree (high-risk
 * actions still ask) and falls back to asking anywhere else (Runtime.modeFor).
 */
export function modeForCap(p: SchedulePermission): PermissionMode {
  return p === 'readonly' ? 'readonly' : p === 'ask' ? 'ask' : 'auto';
}

export class ScheduleStore {
  private list: EdictSchedule[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastTick = 0;
  private ticking = false;

  constructor(private rt: Runtime) {}

  load() {
    const raw = this.rt.store.getKv<EdictSchedule[]>(KV);
    this.list = Array.isArray(raw) ? raw.filter((s) => s && typeof s.id === 'string') : [];
  }

  all(): EdictSchedule[] {
    return this.list;
  }

  get(id: string): EdictSchedule | undefined {
    return this.list.find((s) => s.id === id);
  }

  private save() {
    this.list = [...this.list];
    this.rt.store.setKv(KV, this.list);
    this.rt.emit({ type: 'schedules', schedules: this.list });
  }

  // ───────────── the emperor's edits ─────────────

  /** Create or update (validated). Changing the time recomputes the next run from now. */
  upsert(d: ScheduleDraft, actor = 'emperor'): EdictSchedule {
    const t = now();
    const title = String(d.title ?? '').trim().slice(0, 40);
    const text = String(d.text ?? '').trim();
    if (!text) throw new Error('旨意内容为空');
    const tier: Tier = TIERS.includes(d.tier) ? d.tier : 'lite';
    const rule = cleanRule(d.rule);
    const bad = ruleProblem(rule ?? (d.rule as ScheduleRule | undefined), t) ?? (rule ? null : '时间规则无效');
    if (!rule || bad) throw new Error(bad ?? '时间规则无效');
    const workspace = d.workspace ? String(d.workspace) : null;
    if (workspace && !fs.existsSync(workspace)) throw new Error(`工作区不存在：${workspace}`);
    const prev = d.id ? this.get(d.id) : undefined;
    if (d.id && !prev) throw new Error('定时旨意不存在（可能已删除）');
    const base: EdictSchedule = prev ?? {
      id: uid('sch'), title: '', text: '', workspace: null, tier, rule, permission: 'readonly', stop: { kind: 'never' }, missed: 'once', enabled: true,
      createdAt: t, updatedAt: t, origin: { by: 'emperor' }, runs: 0, nextAt: null, history: [],
    };
    const s: EdictSchedule = {
      ...base,
      title: title || text.replace(/\s+/g, ' ').slice(0, 20),
      text, workspace, tier,
      designId: d.designId || undefined,
      model: d.model ?? null,
      effort: d.effort && d.effort !== 'default' ? d.effort : undefined,
      rule,
      permission: capFor(tier, d.permission),
      stop: cleanStop(d.stop),
      missed: d.missed === 'skip' ? 'skip' : 'once',
      enabled: d.enabled !== false,
      updatedAt: t,
      ended: undefined,
    };
    // a schedule the emperor saves is no longer a proposal
    delete s.proposal;
    const timeChanged = !prev || JSON.stringify(prev.rule) !== JSON.stringify(rule) || !prev.enabled || !!prev.proposal;
    if (timeChanged || s.nextAt == null) s.nextAt = s.enabled ? nextFire(rule, t, s.lastRunAt ?? t) : null;
    if (!s.enabled) s.nextAt = null;
    this.endIfStopped(s, t);
    if (prev) this.list = this.list.map((x) => (x.id === s.id ? s : x));
    else this.list.push(s);
    // an official's proposal the emperor edited and saved: that is his answer, so its card closes
    if (prev?.proposal) {
      const ap = this.card(s.id);
      if (ap) this.rt.decideApproval(ap.id, true, actor, 'approve', '皇上修改后排定');
    }
    this.rt.audit.record(actor, prev ? 'schedule_updated' : 'schedule_created', { id: s.id, title: s.title, rule: describeRule(rule), permission: s.permission, tier: s.tier, workspace: s.workspace, stop: s.stop.kind, missed: s.missed, enabled: s.enabled });
    this.save();
    return s;
  }

  setEnabled(id: string, on: boolean): EdictSchedule {
    const s = this.need(id);
    if (s.proposal) throw new Error('官员的提议还没准奏');
    const was = s.ended;
    s.enabled = on;
    s.ended = on ? undefined : s.ended;
    s.nextAt = on ? nextFire(s.rule, now(), s.lastRunAt ?? now()) : null;
    s.updatedAt = now();
    if (on && this.endIfStopped(s, now())) {
      // nothing left to run under these rules: stays off, as it was
      s.ended = was ?? s.ended;
      this.save();
      throw new Error(`${s.ended}：要再启用，请先在「修改」里改时间或停止条件`);
    }
    this.rt.audit.record('emperor', on ? 'schedule_enabled' : 'schedule_disabled', { id, title: s.title });
    this.save();
    return s;
  }

  remove(id: string) {
    const s = this.need(id);
    this.list = this.list.filter((x) => x.id !== id);
    this.rt.audit.record('emperor', 'schedule_deleted', { id, title: s.title });
    const ap = this.card(id);
    if (ap) this.rt.decideApproval(ap.id, false, 'system');
    this.save();
  }

  /** 「立即执行一次」: issue it now (counts as a run; the regular times stay as they are). */
  async runNow(id: string): Promise<{ taskId?: string }> {
    const s = this.need(id);
    if (s.proposal) throw new Error('官员的提议还没准奏');
    const busy = this.running(s);
    if (busy) throw new Error(`上一次（${busy.id}）还没办完`);
    const r = await this.fire(s, { manual: true });
    if (r.outcome !== 'started') throw new Error(r.note ?? '没能下旨');
    return { taskId: r.taskId };
  }

  /** The open 定时提议 card of a proposal. */
  private card(id: string) {
    return [...this.rt.approvals.values()].find((a) => a.kind === 'schedule' && a.status === 'pending' && a.tool === `schedule:${id}`);
  }

  private need(id: string): EdictSchedule {
    const s = this.get(id);
    if (!s) throw new Error('定时旨意不存在（可能已删除）');
    return s;
  }

  // ───────────── running ─────────────

  /** Check every 30 s; the first check right away catches up on what was missed while Edict was closed. */
  start() {
    if (this.timer) return;
    this.reraiseProposals();
    void this.tick();
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** The edict this schedule issued last, while it is still going. */
  running(s: EdictSchedule): Task | undefined {
    const t = s.lastTaskId ? this.rt.tasks.get(s.lastTaskId) : undefined;
    return t && !TERMINAL.includes(t.state) ? t : undefined;
  }

  /** Fire what is due at `at`. Exposed for tests (they pass the clock). */
  async tick(at = now()): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      this.lastTick = at;
      for (const s of [...this.list]) {
        if (!s.enabled || s.proposal || s.nextAt == null) continue;
        if (this.endIfStopped(s, at)) {
          this.save();
          continue;
        }
        if (s.nextAt > at) continue;
        const due = s.nextAt;
        const late = at - due > MISSED_AFTER_MS;
        if (late && s.missed === 'skip') {
          this.note(s, { at, outcome: 'skipped', note: `错过了 ${fmtDateTime(due)}（Edict 没开或电脑在睡眠），按设置跳过` });
          s.nextAt = nextFire(s.rule, at, s.lastRunAt ?? due);
          if (s.rule.kind === 'once') this.end(s, '错过了执行时间');
          this.save();
          continue;
        }
        await this.fire(s, { catchUp: late, due, at });
      }
    } finally {
      this.ticking = false;
    }
  }

  private async fire(s: EdictSchedule, o: { catchUp?: boolean; due?: number; at?: number; manual?: boolean }): Promise<ScheduleRun> {
    const at = o.at ?? now();
    const advance = () => {
      if (o.manual) return;
      // from now on: a run missed several times over is made up once, never once per missed time
      s.nextAt = nextFire(s.rule, at, at);
      if (s.rule.kind === 'once') s.nextAt = null;
    };
    const busy = this.running(s);
    if (busy) {
      const run = this.note(s, { at, outcome: 'skipped', taskId: busy.id, note: `上一次（${busy.id}）还没办完，这次跳过` });
      advance();
      this.save();
      return run;
    }
    if (s.workspace && !fs.existsSync(s.workspace)) {
      const run = this.note(s, { at, outcome: 'failed', note: `工作区不存在：${s.workspace}` });
      advance();
      this.save();
      this.rt.notifyDesktop('attention', '定时旨意没能下达', `${s.title}：工作区不存在`);
      return run;
    }
    let run: ScheduleRun;
    try {
      const r = await this.rt.submitHook({
        text: s.text, tier: s.tier, multiAgent: s.tier !== 'solo', forceEdict: true, model: s.model ?? null, effort: s.effort, designId: s.designId,
        workspace: s.workspace, permissionMode: modeForCap(s.permission),
        schedule: { id: s.id, title: s.title, permission: s.permission, firedAt: at, catchUp: o.catchUp || undefined },
      });
      if (r.kind !== 'task') throw new Error('没有生成旨意');
      run = this.note(s, { at, outcome: 'started', taskId: r.taskId, catchUp: o.catchUp || undefined, note: o.manual ? '手动执行' : o.catchUp && o.due ? `补跑错过的 ${fmtDateTime(o.due)}` : undefined });
      s.runs++;
      s.lastRunAt = at;
      s.lastTaskId = r.taskId;
      this.rt.notifyDesktop('info', '定时旨意已下达', s.title);
    } catch (e) {
      run = this.note(s, { at, outcome: 'failed', note: truncate((e as Error).message, 200) });
      this.rt.notifyDesktop('attention', '定时旨意没能下达', `${s.title}：${truncate((e as Error).message, 80)}`);
    }
    advance();
    this.endIfStopped(s, at);
    this.save();
    return run;
  }

  private note(s: EdictSchedule, run: ScheduleRun): ScheduleRun {
    s.history = [run, ...s.history].slice(0, HISTORY);
    s.updatedAt = run.at;
    this.rt.audit.record('system', `schedule_${run.outcome}`, { id: s.id, title: s.title, taskId: run.taskId ?? null, catchUp: run.catchUp ?? false, note: run.note ?? null }, run.taskId);
    if (run.outcome !== 'started') this.rt.activity(run.outcome === 'failed' ? 'error' : 'log', `定时旨意「${s.title}」${run.outcome === 'failed' ? '没能下达' : '跳过一次'}：${run.note ?? ''}`, {});
    return run;
  }

  /** Apply the stop rule; true when the schedule just ended. */
  private endIfStopped(s: EdictSchedule, at: number): boolean {
    if (!s.enabled) return false;
    if (s.stop.kind === 'count' && s.runs >= s.stop.n) return this.end(s, `已执行 ${s.runs} 次`);
    if (s.stop.kind === 'until' && (s.nextAt == null ? at > s.stop.at : s.nextAt > s.stop.at)) return this.end(s, `已到截止日期`);
    if (s.nextAt == null) return this.end(s, s.rule.kind === 'once' ? (s.runs ? '已执行' : '错过了执行时间') : '不会再执行');
    return false;
  }

  private end(s: EdictSchedule, why: string): true {
    s.enabled = false;
    s.nextAt = null;
    s.ended = why;
    this.rt.audit.record('system', 'schedule_ended', { id: s.id, title: s.title, reason: why });
    return true;
  }

  /** While a scheduled edict is actually working (not waiting on the emperor), the Mac should stay awake. */
  keepAwake(): boolean {
    const pending = new Set([...this.rt.approvals.values()].filter((a) => a.status === 'pending' && a.taskId).map((a) => a.taskId!));
    for (const t of this.rt.tasks.values()) {
      if (!t.schedule || TERMINAL.includes(t.state) || t.state === 'Blocked' || t.paused || t.gate || pending.has(t.id)) continue;
      return true;
    }
    return false;
  }

  // ───────────── officials' proposals ─────────────

  /** An official proposes a schedule: stored as a proposal and put to the emperor on a card. */
  propose(p: { agentId: AgentId; taskId?: string; title: string; text: string; rule: ScheduleRule; permission: SchedulePermission; reason: string; workspace: string | null; tier: Tier }): EdictSchedule {
    const t = now();
    const s: EdictSchedule = {
      id: uid('sch'), title: p.title.slice(0, 40), text: p.text, workspace: p.workspace, tier: p.tier, rule: p.rule, permission: capFor(p.tier, p.permission),
      stop: { kind: 'never' }, missed: 'once', enabled: false, createdAt: t, updatedAt: t,
      origin: { by: 'official', agentId: p.agentId, taskId: p.taskId, reason: p.reason || undefined }, proposal: 'pending', runs: 0, nextAt: null, history: [],
    };
    this.list.push(s);
    this.rt.audit.record(p.agentId, 'schedule_proposed', { id: s.id, title: s.title, rule: describeRule(s.rule), permission: s.permission, reason: s.origin.by === 'official' ? s.origin.reason ?? null : null }, p.taskId);
    this.save();
    this.raise(s);
    return s;
  }

  /** The emperor's answer to a proposal: schedule it (running, or paused to edit first) or turn it down. */
  decideProposal(id: string, choice: 'approve' | 'paused' | 'deny', comment?: string) {
    const s = this.get(id);
    if (!s || !s.proposal) return;
    if (choice === 'deny') {
      this.list = this.list.filter((x) => x.id !== id);
      this.rt.audit.record('emperor', 'schedule_proposal_denied', { id, title: s.title, comment: comment ?? null });
      if (s.origin.by === 'official' && s.origin.taskId) this.rt.activity('human', `皇上没有准奏定时提议「${s.title}」${comment ? `：${comment}` : ''}`, { taskId: s.origin.taskId });
      this.save();
      return;
    }
    delete s.proposal;
    s.enabled = choice === 'approve';
    s.nextAt = s.enabled ? nextFire(s.rule, now(), now()) : null;
    s.updatedAt = now();
    this.rt.audit.record('emperor', 'schedule_proposal_approved', { id, title: s.title, enabled: s.enabled, comment: comment ?? null });
    if (s.origin.by === 'official' && s.origin.taskId) this.rt.activity('human', `皇上准奏定时提议「${s.title}」（${describeRule(s.rule)}${s.enabled ? '' : '，先停用待改'}）`, { taskId: s.origin.taskId });
    this.save();
  }

  /** Approval cards live in memory: after a restart, put the pending proposals again. */
  reraiseProposals() {
    for (const s of this.list) if (s.proposal === 'pending' && !this.card(s.id)) this.raise(s);
  }

  /**
   * The card is not tied to the edict it came from: the official goes on working (it does not wait), and the
   * proposal outlives that edict being cancelled or finished.
   */
  private raise(s: EdictSchedule) {
    if (s.origin.by !== 'official') return;
    const o = s.origin;
    const from = o.taskId ? this.rt.tasks.get(o.taskId) : undefined;
    void this.rt
      .requestDecision({
        kind: 'schedule', agentId: o.agentId, tool: `schedule:${s.id}`,
        summary: `${agentName(o.agentId)}上疏提议定时旨意：${s.title}（${describeRule(s.rule)}）`,
        detail: [
          `每次下的旨意：${s.text}`,
          `时间：${describeRule(s.rule)}`,
          `权限：${PERMISSION_TEXT[s.permission].label}（${PERMISSION_TEXT[s.permission].hint}）`,
          `工作区：${s.workspace ?? '（无）'}`,
          from ? `提议自旨意：${from.title}（${from.id}）` : '',
        ].filter(Boolean).join('\n'),
        risk: 'normal',
        reason: o.reason || '官员认为这件事值得定期做',
        choices: [
          { id: 'approve', label: '准奏，按此排定', hint: `${describeRule(s.rule)}，${PERMISSION_TEXT[s.permission].label}`, approve: true, tone: 'primary', comment: 'optional' },
          { id: 'paused', label: '排上，但先停用', hint: '到「定时旨意」页改好再启用', approve: true, comment: 'optional' },
          { id: 'deny', label: '不必', hint: '提议作废', approve: false, tone: 'danger', comment: 'optional' },
        ],
      })
      .then((d) => {
        const cur = this.get(s.id);
        if (!cur?.proposal) return;
        if (!d.approve) return this.decideProposal(s.id, 'deny', d.comment);
        this.decideProposal(s.id, d.choice === 'paused' ? 'paused' : 'approve', d.comment);
      });
  }
}

/** What the officials of a scheduled edict are told (in every prompt, with the canon). */
export function scheduleNote(t: Task): string {
  const s = t.schedule;
  if (!s) return '';
  const cap =
    s.permission === 'readonly' ? '只读：不改文件、不执行命令，把发现和建议写进结论'
    : s.permission === 'ask' ? '每次改文件、执行命令都要等皇上批准'
    : '在本旨意自己的工作树里可以放手改文件、执行命令（高风险操作仍须皇上确认），结案时由皇上决定合不合并';
  return `【定时旨意】这道旨意是按皇上排定的时间自动下达的（「${s.title}」），皇上此刻可能不在跟前。能自己合理判断的照常办，不要为小事请旨。本旨意的权限：${cap}。`;
}

// ───────────── propose_schedule (officials) ─────────────

export const PROPOSE_SCHEDULE_SPEC: ToolSpec = {
  name: 'propose_schedule',
  description: '向皇上提议一道定时旨意：某件事值得定期做时（例如每周检查依赖更新、每天早上跑一遍测试并汇报）。皇上准奏后才生效，提议后照常继续手头的事，不用等答复。一次性的事不要提议；每道旨意至多提议一次。',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: '定时旨意的名字，20 字以内' },
      edict: { type: 'string', description: '每次到点下达的旨意全文，写清要做什么、产出什么' },
      when: {
        type: 'object',
        description: '时间规则。kind: daily 每天（time）、weekly 每周（days 0=周日…6=周六，time）、interval 每隔 hours 小时、court 每次早朝',
        properties: {
          kind: { type: 'string', enum: ['daily', 'weekly', 'interval', 'court'] },
          time: { type: 'string', description: '时:分，如 09:00' },
          days: { type: 'array', items: { type: 'integer' } },
          hours: { type: 'number' },
        },
        required: ['kind'],
      },
      permission: { type: 'string', enum: ['readonly', 'ask', 'worktree'], description: 'readonly 只读（默认）；ask 每次改动都问皇上；worktree 在旨意工作树里改、结案时皇上定合并' },
      reason: { type: 'string', description: '为什么值得定期做（一句话）' },
    },
    required: ['title', 'edict', 'when', 'reason'],
  },
};

const proposedIn = new WeakMap<Runtime, Set<string>>();

export function proposeScheduleTool(rt: Runtime, task: Task | undefined, agentId: AgentId, args: Record<string, unknown>): { ok: boolean; output: string } {
  if (task?.schedule) return { ok: false, output: '定时旨意里不再提议新的定时旨意。' };
  const seen = proposedIn.get(rt) ?? new Set<string>();
  proposedIn.set(rt, seen);
  const key = task?.id ?? `agent:${agentId}`;
  if (seen.has(key)) return { ok: false, output: '这道旨意已经提议过一次定时旨意，等皇上定夺即可。' };
  const title = String(args.title ?? '').trim();
  const text = String(args.edict ?? '').trim();
  if (!title || !text) return { ok: false, output: '提议要写明 title 和 edict。' };
  const rule = cleanRule(args.when);
  if (!rule || rule.kind === 'once') return { ok: false, output: 'when 无效：kind 只能是 daily（time）、weekly（days、time）、interval（hours ≥ 1）或 court；time 写成 09:00。' };
  const permission: SchedulePermission = args.permission === 'ask' || args.permission === 'worktree' ? args.permission : 'readonly';
  const tier: Tier = task?.tier ?? 'lite';
  seen.add(key);
  const s = rt.schedules.propose({ agentId, taskId: task?.id, title, text, rule, permission, reason: String(args.reason ?? '').trim().slice(0, 300), workspace: task ? rt.permRoot(task) : (rt.workspace?.root ?? null), tier });
  return { ok: true, output: `已上疏提议定时旨意「${s.title}」（${describeRule(s.rule)}，${PERMISSION_TEXT[s.permission].label}）。皇上准奏后才生效；请继续手头的事。` };
}
