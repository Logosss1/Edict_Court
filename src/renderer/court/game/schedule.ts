// Court schedule: where each official is, derived only from the local clock, whether court is in
// session and the official's own runtime status. Pure functions, so the scenes, the map and the
// tests all agree. Nothing here changes how edicts flow; it only decides where they are acted out.
import type { SceneKey } from './model';

export type Period = 'dawn' | 'chaohui' | 'office' | 'sanzhi' | 'night';
/** a place an official can be: a scene, or 'out' (gone home / asleep, not shown anywhere) */
export type Place = SceneKey | 'out';

/** 5–6 dawn (waiting for court) · 6–9 morning court · 9–17 office · 17–19 leaving · 19–5 night */
export function periodAt(hour: number): Period {
  if (hour >= 5 && hour < 6) return 'dawn';
  if (hour >= 6 && hour < 9) return 'chaohui';
  if (hour >= 9 && hour < 17) return 'office';
  if (hour >= 17 && hour < 19) return 'sanzhi';
  return 'night';
}
export const PERIOD_LABEL: Record<Period, string> = { dawn: '候朝', chaohui: '早朝', office: '办公', sanzhi: '散值', night: '夜' };

/** morning court opens on its own between 6 and 9 */
export const MORNING = { from: 6, to: 9 };
export const isMorning = (hour: number) => hour >= MORNING.from && hour < MORNING.to;

const MINISTRY = new Set(['hubu', 'libu', 'bingbu', 'xingbu', 'gongbu', 'libu_hr']);
const SANSHENG = new Set(['zhongshu', 'menxia', 'shangshu']);
/** who stands in the hall when court is in session */
export const ATTENDS = new Set(['taizi', 'zhongshu', 'menxia', 'shangshu', 'hubu', 'libu', 'bingbu', 'xingbu', 'gongbu', 'libu_hr', 'zaochao', 'solo']);

/** each official's own office when not at court */
export function homeOf(id: string): SceneKey {
  if (id === 'taizi') return 'donggong';
  if (SANSHENG.has(id) || id === 'solo') return 'junjichu';
  if (MINISTRY.has(id)) return 'liubu';
  if (id === 'zaochao') return 'chengtian';
  return 'taihe';
}

/** officials leave one by one between 17:00 and 19:00; the order is fixed per official */
export function leaveHour(id: string): number {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return 17 + (h % 113) / 60;
}

export interface PlaceCtx {
  hour: number;
  /** court is in session (morning court or the emperor called it) */
  session: boolean;
  /** the official has work in hand (any runtime status other than idle) */
  busy: boolean;
}

/**
 * Where an official is right now. In order: court in session → the hall (a ministry with work in
 * hand stays at its desk); work in hand → own office, any hour; office hours → own office; after
 * hours → gone home. The crown prince lives in the 东宫, so he is there until late at night.
 */
export function placeOf(id: string, c: PlaceCtx): Place {
  if (c.session && ATTENDS.has(id) && !(MINISTRY.has(id) && c.busy)) return 'taihe';
  const home = homeOf(id);
  if (c.busy) return home;
  if (id === 'taizi') return c.hour >= 6 && c.hour < 23 ? home : 'out';
  const p = periodAt(c.hour);
  if (p === 'dawn' && ATTENDS.has(id)) return 'guangchang';
  if (p === 'chaohui' || p === 'office') return home;
  if (p === 'sanzhi' && c.hour < leaveHour(id)) return home;
  return 'out';
}

/** a ministry that skipped court because it is busy (shown as 因公告假 in the hall) */
export const excused = (id: string, c: PlaceCtx) => c.session && MINISTRY.has(id) && c.busy;

// ───── how the halls connect (matches each scene's door spots) ─────
export const LINKS: Record<SceneKey, SceneKey[]> = {
  taihe: ['guangchang', 'junjichu', 'donggong'],
  guangchang: ['taihe', 'chengtian'],
  chengtian: ['guangchang', 'liubu', 'jiaolou'],
  junjichu: ['taihe', 'gongdao'],
  liubu: ['chengtian'],
  donggong: ['taihe'],
  gongdao: ['junjichu', 'yuhuayuan'],
  yuhuayuan: ['gongdao'],
  jiaolou: ['chengtian'],
  yutu: [],
};

/** the next hall on the way from `from` to `to` ('out' = leave the palace through 承天门 or the 六部 gate) */
export function nextHop(from: SceneKey, to: Place): Place | null {
  if (from === to) return null;
  if (to === 'out' && (from === 'chengtian' || from === 'liubu')) return 'out';
  const goal = (k: SceneKey) => (to === 'out' ? k === 'chengtian' || k === 'liubu' : k === to);
  const prev = new Map<SceneKey, SceneKey>();
  const q: SceneKey[] = [from];
  const seen = new Set<SceneKey>([from]);
  while (q.length) {
    const k = q.shift()!;
    for (const n of LINKS[k]) {
      if (seen.has(n)) continue;
      seen.add(n);
      prev.set(n, k);
      if (goal(n)) {
        let step = n;
        while (prev.get(step) !== from) step = prev.get(step)!;
        return step;
      }
      q.push(n);
    }
  }
  return null;
}

// ───── court session (manual 上朝, morning court, auto 退朝 when idle) ─────
export interface Session {
  active: boolean;
  manual: boolean;
  /** last user input while in session (ms) */
  lastInput: number;
  /** yyyy-mm-dd of the day whose morning court was already dismissed */
  dismissed: string;
}
export const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;

/**
 * Next session state at `now`. Morning court opens by itself (once a day) between 6 and 9; any
 * session closes after `idleMs` without input; a morning session also closes at 9 unless the emperor
 * called it himself.
 */
export function tickSession(s: Session, now: Date, hour: number, idleMs: number): { s: Session; event: 'open' | 'close' | null } {
  const today = dayKey(now);
  if (s.active) {
    const idle = now.getTime() - s.lastInput > idleMs;
    const over = !s.manual && !isMorning(hour);
    if (idle || over) return { s: { ...s, active: false, manual: false, dismissed: isMorning(hour) ? today : s.dismissed }, event: 'close' };
    return { s, event: null };
  }
  if (isMorning(hour) && s.dismissed !== today) return { s: { ...s, active: true, manual: false, lastInput: now.getTime() }, event: 'open' };
  return { s, event: null };
}

// ───── calendar: moon phase, season, festivals ─────
/** 0 = new moon, 0.5 = full moon */
export function moonPhase(d: Date): number {
  const synodic = 29.530588853;
  const ref = Date.UTC(2000, 0, 6, 18, 14);
  const days = (d.getTime() - ref) / 86400000;
  return (((days % synodic) + synodic) % synodic) / synodic;
}

export type Season = 'spring' | 'summer' | 'autumn' | 'winter';
export function seasonOf(d: Date): Season {
  const m = d.getMonth() + 1;
  return m >= 3 && m <= 5 ? 'spring' : m >= 6 && m <= 8 ? 'summer' : m >= 9 && m <= 11 ? 'autumn' : 'winter';
}

/** Chinese lunar month and day (null when the runtime has no Chinese calendar) */
export function lunarDate(d: Date): { month: number; day: number; leap: boolean } | null {
  try {
    const parts = new Intl.DateTimeFormat('zh-CN-u-ca-chinese', { month: 'numeric', day: 'numeric' }).formatToParts(d);
    const m = parts.find((p) => p.type === 'month')?.value ?? '';
    const day = Number(parts.find((p) => p.type === 'day')?.value);
    const month = Number(m.replace(/\D/g, ''));
    if (!month || !day) return null;
    return { month, day, leap: m.includes('闰') };
  } catch {
    return null;
  }
}

export type Festival = 'chunjie' | 'yuanxiao' | 'zhongqiu' | null;
export const FESTIVAL_LABEL: Record<Exclude<Festival, null>, string> = { chunjie: '春节', yuanxiao: '元宵', zhongqiu: '中秋' };
export function festivalOf(d: Date): Festival {
  const l = lunarDate(d);
  if (!l || l.leap) return null;
  if (l.month === 1 && l.day === 15) return 'yuanxiao';
  if (l.month === 1 && l.day <= 14) return 'chunjie';
  if (l.month === 12 && l.day >= 29) return 'chunjie'; // 除夕 (the last day of a 29- or 30-day month)
  if (l.month === 8 && l.day === 15) return 'zhongqiu';
  return null;
}
