// 定时旨意 (2.1): when a schedule fires and how it reads, shared by the scheduler and the 定时旨意 page.
// All times are the Mac's local time; daily and weekly rules keep their clock time across daylight saving.
import type { EdictSchedule, ScheduleRule, SchedulePermission, ScheduleStop, Tier } from './types';

/** morning court (早朝) opens at 6:00, as in the court scene */
export const COURT_HOUR = 6;
export const WEEKDAY = ['日', '一', '二', '三', '四', '五', '六'];

export const PERMISSION_TEXT: Record<SchedulePermission, { label: string; hint: string }> = {
  readonly: { label: '只读', hint: '只看、只分析、出报告：不改文件，也不跑命令' },
  ask: { label: '每次改动都问我', hint: '要写文件、跑命令时停下来等你批，同时发通知' },
  worktree: { label: '在旨意工作树里改', hint: '在自己的 git 工作树里放手改、跑命令（高风险操作和有外部影响的 MCP 工具仍会问你），结案时由你决定合不合并' },
};

export function parseTime(s: unknown): [number, number] | null {
  const m = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(String(s ?? ''));
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  return h < 24 && mi < 60 ? [h, mi] : null;
}
const pad = (n: number) => String(n).padStart(2, '0');
export const fmtTime = (h: number, m: number) => `${pad(h)}:${pad(m)}`;

/** The rule as people say it, e.g. 每周一、三 09:00. */
export function describeRule(r: ScheduleRule): string {
  switch (r.kind) {
    case 'daily':
      return `每天 ${r.time}`;
    case 'weekly': {
      const days = [...r.days].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));
      return `每周${days.map((d) => WEEKDAY[d]).join('、')} ${r.time}`;
    }
    case 'interval':
      return `每隔 ${r.hours} 小时`;
    case 'court':
      return `每次早朝（每天 ${fmtTime(COURT_HOUR, 0)}）`;
    case 'once':
      return `${fmtDateTime(r.at)} 一次`;
  }
}

export function describeStop(s: ScheduleStop): string {
  if (s.kind === 'count') return `执行 ${s.n} 次后停`;
  if (s.kind === 'until') return `到 ${fmtDate(s.at)} 为止`;
  return '一直执行';
}

export function fmtDate(at: number): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
export function fmtDateTime(at: number): string {
  const d = new Date(at);
  return `${fmtDate(at)} ${fmtTime(d.getHours(), d.getMinutes())}`;
}

/** Local `day` (any time in it) at h:m. */
function at(day: Date, h: number, m: number): number {
  const d = new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m, 0, 0);
  return d.getTime();
}

/**
 * The first time strictly after `after` that the rule names, or null when it will not fire again.
 * `base` (interval rules): the last run, or when the schedule was made; the next run is base + N hours,
 * moved on in whole steps when that has already passed (missed runs are never stacked up).
 */
export function nextFire(rule: ScheduleRule, after: number, base?: number): number | null {
  switch (rule.kind) {
    case 'once':
      return rule.at > after ? rule.at : null;
    case 'interval': {
      const step = Math.max(1, rule.hours) * 3_600_000;
      const b = base ?? after;
      let t = b + step;
      if (t <= after) t = b + (Math.floor((after - b) / step) + 1) * step;
      return t;
    }
    case 'daily':
    case 'court':
    case 'weekly': {
      const hm = rule.kind === 'court' ? ([COURT_HOUR, 0] as [number, number]) : parseTime(rule.time);
      if (!hm) return null;
      const days = rule.kind === 'weekly' ? new Set(rule.days) : null;
      if (days && !days.size) return null;
      const start = new Date(after);
      for (let i = 0; i <= 8; i++) {
        const day = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
        if (days && !days.has(day.getDay())) continue;
        const t = at(day, hm[0], hm[1]);
        if (t > after) return t;
      }
      return null;
    }
  }
}

/** The next `n` times after `from` (for the form's preview). */
export function upcoming(rule: ScheduleRule, from: number, n: number, base?: number): number[] {
  const out: number[] = [];
  let cur = from;
  let b = base;
  for (let i = 0; i < n; i++) {
    const t = nextFire(rule, cur, b);
    if (t == null) break;
    out.push(t);
    cur = t;
    if (rule.kind === 'interval') b = t;
  }
  return out;
}

/** Problems with a rule, in words (empty = fine). */
export function ruleProblem(r: ScheduleRule | undefined, nowMs: number): string | null {
  if (!r) return '没有设时间';
  switch (r.kind) {
    case 'daily':
      return parseTime(r.time) ? null : '时间要写成 时:分，例如 09:00';
    case 'weekly':
      if (!parseTime(r.time)) return '时间要写成 时:分，例如 09:00';
      return r.days.length ? null : '至少选一天';
    case 'interval':
      return Number.isFinite(r.hours) && r.hours >= 1 && r.hours <= 24 * 30 ? null : '间隔要在 1 到 720 小时之间';
    case 'court':
      return null;
    case 'once':
      return Number.isFinite(r.at) && r.at > nowMs ? null : '执行时间要在将来';
  }
}

/** A scheduled Solo edict has no worktree, so the worktree cap is not offered for it. */
export const permissionsFor = (tier: Tier): SchedulePermission[] => (tier === 'solo' ? ['readonly', 'ask'] : ['readonly', 'ask', 'worktree']);

export const isLive = (s: EdictSchedule) => s.enabled && !s.proposal && s.nextAt != null;
