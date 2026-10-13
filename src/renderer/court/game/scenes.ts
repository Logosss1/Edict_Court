// Phaser 3 scenes for the pixel court, drawn top-down. Art is drawn at 2× detail (1280×720
// backgrounds, 64×96 officials) and shown at half scale through a ×2 camera, so all game logic keeps
// using the 640×360 world. Everything here is a projection of the runtime: who stands where comes
// from the clock, the court session and each official's status (schedule.ts); the only things the
// user can change from the court are UI state (dialogs, panels, scenes, 上朝) and the existing 朱批 API.
import type { AgentId, FlowEntry, RunNode, Task } from '../../../shared/types';
import { AGENT_MAP, AGENTS, STATE_LABEL, TERMINAL, courtAddress } from '../../../shared/court';
import { Official, ensureAnims, nativeText, resolveBubbles, toolAnim, type Facing } from './official';
import { FONT, WORLD_W, WORLD_H, DETAIL, courtSig, type CourtModel, type SceneKey, type Weather } from './model';
import { ATTENDS, excused, festivalOf, nextHop, periodAt, placeOf, seasonOf, type Festival, type Period, type Place } from './schedule';
import { nearestFloor, onFloor, route, stepOnFloor, walkRects, type Pt, type Rect } from './walk';
import { makeHalls } from './halls';

export interface Bridge {
  model: CourtModel;
  events: import('./model').CourtEvents;
  current: any | null;
  /** arrow keys currently held (fed from the React side so text inputs never lose their keys) */
  keys: Set<string>;
  weather: Weather;
  /** set when the emperor walked through a door, so the next scene spawns him at its entrance */
  arrivedFrom: SceneKey | null;
  /** lantern on/off chosen by the user this session (scene:index → lit) */
  lit: Record<string, boolean>;
  pendingReplay: string | null;
  hourOverride: number | null;
  /** where each official is, as of the last sync */
  places: Record<string, Place>;
  /** where each one was before his latest move (so an arrival comes through the right door) */
  cameFrom: Record<string, Place>;
  /** flow entries already acted out, per task (null until the first sync) */
  flowSeen: Map<string, number> | null;
  /** court session at the last sync (null until the first sync) */
  lastSession: boolean | null;
  /** the officials should file into the hall now (after the 上朝 ceremony) */
  procession: boolean;
}

export const A = '../assets/pixel';
export const S = 1 / DETAIL; // display scale for 2× art
export const SCENE_KEYS: SceneKey[] = ['taihe', 'guangchang', 'chengtian', 'junjichu', 'liubu', 'donggong', 'yuhuayuan', 'gongdao', 'jiaolou', 'yutu'];
export const SCENE_NAME: Record<SceneKey, string> = {
  taihe: '太和殿', guangchang: '太和殿广场', chengtian: '承天门', junjichu: '军机处', liubu: '六部院',
  donggong: '东宫', yuhuayuan: '御花园', gongdao: '宫道长街', jiaolou: '角楼', yutu: '宫城舆图',
};
/** open-air scenes: weather falls everywhere, the night is darker */
export const OUTDOOR = new Set<SceneKey>(['guangchang', 'chengtian', 'liubu', 'yuhuayuan', 'gongdao', 'jiaolou']);
/** inside the palace walls the errand-runner is a eunuch; outside it is a clerk */
const INNER = new Set<SceneKey>(['taihe', 'junjichu', 'donggong', 'gongdao', 'yuhuayuan']);
const CHAR_KEYS = ['emperor', 'taizi', 'zhongshu', 'menxia', 'shangshu', 'hubu', 'libu', 'bingbu', 'xingbu', 'gongbu', 'libu_hr', 'zaochao', 'solo', 'guard', 'lady', 'clerk', 'eunuch'];
const MINISTRY_PROPS = ['hubu', 'libu', 'bingbu', 'xingbu', 'gongbu', 'libu_hr'];
const PROPS = ['desk', 'scroll', 'fan', 'seal', 'cloud', 'cloud2', 'ring', 'glow', 'rain', 'snow', 'petal',
  'zhezi_pending', 'zhezi_taizi', 'zhezi_zhongshu', 'zhezi_menxia', 'zhezi_assigned', 'zhezi_doing', 'zhezi_review', 'zhezi_done', 'zhezi_blocked', 'zhezi_cancelled',
  ...MINISTRY_PROPS.map((m) => `dept_${m}`)];
const SHEETS: [string, number, number][] = [['lantern', 32, 72], ['flame', 8, 12], ['smoke', 24, 48], ['flag', 40, 64], ['cat', 32, 24], ['bird', 16, 12]];

export const txt = (scene: any, x: number, y: number, s: string, o: Record<string, unknown> = {}) =>
  scene.add.text(Math.round(x), Math.round(y), s, { fontFamily: FONT, fontSize: '12px', color: '#f4e6c4', resolution: 2, ...o });
export const img = (scene: any, x: number, y: number, key: string) => scene.add.image(Math.round(x), Math.round(y), key).setScale(S);

export function snippetFor(model: CourtModel, id: string): string | undefined {
  const a = model.lastActivity[id];
  if (!a) return undefined;
  if (a.kind === 'thinking' || a.kind === 'text') return a.content.slice(-60);
  if (a.kind === 'tool_call') return `⚙ ${a.content}`;
  return undefined;
}
export function toolFor(model: CourtModel, id: string): string | undefined {
  const a = model.lastActivity[id];
  return a?.kind === 'tool_call' ? String((a.data as { name?: string } | undefined)?.name ?? a.content) : undefined;
}

export function zheziKey(t: Task) {
  const m: Record<string, string> = { Pending: 'pending', Taizi: 'taizi', Zhongshu: 'zhongshu', Menxia: 'menxia', Assigned: 'assigned', Next: 'assigned', Doing: 'doing', Review: 'review', PendingConfirm: 'review', Done: 'done', Blocked: 'blocked', Cancelled: 'cancelled' };
  return `zhezi_${m[t.state] ?? 'pending'}`;
}

export type DayPhase = 'dawn' | 'day' | 'dusk' | 'night';
export function dayPhase(hour: number): DayPhase {
  if (hour >= 5 && hour < 7) return 'dawn';
  if (hour >= 7 && hour < 17) return 'day';
  if (hour >= 17 && hour < 19) return 'dusk';
  return 'night';
}
/** 时辰: 子 23–1, 丑 1–3, … */
export function shichen(hour: number): string {
  return '子丑寅卯辰巳午未申酉戌亥'[Math.floor(((Math.floor(hour) + 1) % 24) / 2)] + '时';
}

// ───────────────────────── 奏折回放: a finished task's journey, rebuilt from its records ─────────────────────────
export interface ReplayStep { actor: string; anim: string; text: string; title: string }
const NAME_TO_ID: Record<string, string> = { ...Object.fromEntries(AGENTS.flatMap((a) => [[a.name, a.id], [a.official, a.id]])), 皇上: 'emperor', 陛下: 'emperor' };
export const idOfName = (name: string): string | undefined => NAME_TO_ID[name] ?? (name in AGENT_MAP ? name : undefined);
export function replaySteps(t: Task): ReplayStep[] {
  const steps: ReplayStep[] = [{ actor: 'emperor', anim: 'sit_talk', title: '皇上下旨', text: t.title.slice(0, 40) }];
  const nodes = [...t.nodes].filter((n) => n.startedAt).sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
  const reviewAt = (n: RunNode, stage: 'plan' | 'result') => t.reviews.filter((r) => r.stage === stage && r.reviewer === 'menxia' && r.at >= (n.startedAt ?? 0) - 1000).sort((a, b) => a.at - b.at)[0];
  for (const n of nodes) {
    const last = steps[steps.length - 1];
    switch (n.kind) {
      case 'triage': steps.push({ actor: 'taizi', anim: 'talk', title: '太子分拣', text: '旨意提炼，转中书省' }); break;
      case 'plan': steps.push({ actor: 'zhongshu', anim: 'write', title: '中书省拟旨', text: n.label || '拟定方案、拆解子任务' }); break;
      case 'review': {
        const r = reviewAt(n, 'plan');
        steps.push(r?.verdict === 'reject'
          ? { actor: 'menxia', anim: 'reject', title: '门下省封驳', text: `封驳：${r.comment || r.issues[0] || '方案欠妥'}` }
          : { actor: 'menxia', anim: 'seal', title: '门下省审议', text: '准奏，用印' });
        break;
      }
      case 'gate': steps.push({ actor: 'emperor', anim: 'sit_write', title: '御批', text: '朕已阅，照准' }); break;
      case 'dispatch': steps.push({ actor: 'shangshu', anim: 'dispatch', title: '尚书省派发', text: '分派六部办理' }); break;
      case 'exec': {
        const id = n.agentId in AGENT_MAP ? n.agentId : 'bingbu';
        if (last?.actor === id && last.title.endsWith('办差')) break; // merge runs of the same ministry
        steps.push({ actor: id, anim: toolAnim('', id), title: `${AGENT_MAP[id as AgentId].name}办差`, text: n.label || '领旨办差' });
        break;
      }
      case 'summary': steps.push({ actor: 'shangshu', anim: 'present', title: '尚书省汇总', text: '汇总六部回奏' }); break;
      case 'result_review': {
        const r = reviewAt(n, 'result');
        steps.push({ actor: 'menxia', anim: r?.verdict === 'reject' ? 'reject' : 'read', title: '门下省复核', text: r?.verdict === 'reject' ? `驳回：${r.comment || '尚需修改'}` : '复核无误' });
        break;
      }
      case 'solo': steps.push({ actor: 'solo', anim: 'write', title: '独相办理', text: n.label || '亲自办理' }); break;
      case 'debate': steps.push({ actor: 'zhongshu', anim: 'talk', title: '朝堂议政', text: '百官廷议' }); break;
      case 'step': {
        const id = n.agentId in AGENT_MAP ? n.agentId : 'shangshu';
        steps.push({ actor: id, anim: toolAnim('', id), title: n.label || '办理', text: n.label || '办理' });
        break;
      }
    }
  }
  if (steps.length === 1) {
    // no node records (older tasks / custom designs): fall back to the flow log
    for (const f of t.flow) {
      const id = NAME_TO_ID[f.to];
      if (!id || id === 'emperor' || id === steps[steps.length - 1].actor) continue;
      steps.push({ actor: id, anim: toolAnim('', id), title: `${f.from} → ${f.to}`, text: f.remark.slice(0, 40) || '流转' });
    }
  }
  const trimmed = steps.length > 14 ? [...steps.slice(0, 12), { actor: steps[steps.length - 1].actor, anim: 'bow', title: '……', text: `另有 ${steps.length - 13} 道流转` }, steps[steps.length - 1]] : steps;
  const ender = trimmed.some((s) => s.actor === 'shangshu') ? 'shangshu' : trimmed[trimmed.length - 1].actor === 'emperor' ? 'taizi' : trimmed[trimmed.length - 1].actor;
  trimmed.push({ actor: ender, anim: 'kneel', title: '回奏', text: (t.result?.summary || STATE_LABEL[t.state] || '回奏完毕').slice(0, 40) });
  trimmed.push({ actor: 'emperor', anim: 'sit_talk', title: t.state === 'Done' ? '结案' : STATE_LABEL[t.state], text: t.state === 'Done' ? '准奏，此事办得好！' : '朕知道了' });
  return trimmed;
}

/** what a flow entry looks like when acted out */
export function flowKind(remark: string): 'reject' | 'approve' | 'pass' {
  if (/封驳|驳回|退回|打回/.test(remark)) return 'reject';
  if (/准奏|用印|照准|批准|通过|准了/.test(remark)) return 'approve';
  return 'pass';
}

export interface Seat { x: number; y: number; facing: Facing; seated?: boolean; label?: string }
export interface NpcSpec { kind: string; x: number; y: number; facing?: Facing; act?: string; route?: Pt[]; tag?: string }
interface Visit {
  key: string;
  kind: 'gate' | 'ap';
  who: string;
  text: string;
  click: () => void;
  taskId?: string;
}

/** does this NPC belong in the scene at this time of day? */
function npcShows(n: NpcSpec, p: Period): boolean {
  if (n.kind === 'guard' || n.kind === 'clerk') return true;
  switch (n.act) {
    case 'sweep': return p === 'dawn' || p === 'chaohui' || p === 'office';
    case 'lamp': return p === 'sanzhi' || p === 'night';
    case 'patrol': return p === 'night' || p === 'sanzhi';
    case 'tray': return p === 'chaohui' || p === 'office' || p === 'sanzhi';
    default: return p !== 'night';
  }
}

export function makeScenes(P: any, bridge: Bridge) {
  class Boot extends P.Scene {
    constructor() {
      super('boot');
    }
    preload() {
      this.cameras.main.setZoom(DETAIL).centerOn(WORLD_W / 2, WORLD_H / 2);
      for (const k of CHAR_KEYS) this.load.spritesheet(k, `${A}/chars/${k}.png`, { frameWidth: 64, frameHeight: 96 });
      for (const s of SCENE_KEYS) {
        this.load.image(`bg_${s}`, `${A}/scenes/${s}.png`);
        this.load.json(`spots_${s}`, `${A}/scenes/${s}.json`);
      }
      for (const p of PROPS) this.load.image(p, `${A}/props/${p}.png`);
      for (const [k, w, h] of SHEETS) this.load.spritesheet(k, `${A}/props/${k}.png`, { frameWidth: w, frameHeight: h });
      const bar = this.add.graphics();
      this.load.on('progress', (v: number) => {
        bar.clear();
        bar.fillStyle(0x6e1a1c, 1);
        bar.fillRect(219, 175, 202, 10);
        bar.fillStyle(0xd9b25a, 1);
        bar.fillRect(220, 176, Math.round(200 * v), 8);
      });
    }
    create() {
      for (const k of CHAR_KEYS) ensureAnims(this, k);
      const mk = (key: string, sheet: string, frames: number[], rate: number, repeat = -1) => {
        if (!this.anims.exists(key)) this.anims.create({ key, frames: this.anims.generateFrameNumbers(sheet, { frames }), frameRate: rate, repeat });
      };
      mk('flame', 'flame', [0, 1, 2, 1], 8);
      mk('smoke', 'smoke', [0, 1, 2, 3, 4, 5], 5);
      mk('flag', 'flag', [0, 1, 2, 3], 6);
      mk('cat_walk', 'cat', [0, 1, 2, 3], 8);
      mk('cat_sit', 'cat', [4, 5], 1.5);
      mk('cat_jump', 'cat', [6, 7, 6], 6, 0);
      mk('bird', 'bird', [0, 1, 2, 1], 9);
      (bridge as any).booted = true;
      const first = (bridge as any).initialScene ?? 'taihe';
      this.scene.start(first);
    }
  }

  class Base extends P.Scene {
    officials = new Map<string, Official>();
    extras: Official[] = [];
    /** where each built-in official sits or stands in this scene when he is here */
    seats = new Map<string, Seat>();
    /** official ids whose spot a 协同设计's court layout took over */
    layoutTaken = new Set<string>();
    npcs: { o: Official; n: NpcSpec; glow: any }[] = [];
    npcSig = '';
    key: SceneKey;
    spots: Record<string, any> = {};
    rects: Rect[] = [];
    emperor: Official | null = null;
    shade: any = null;
    glows: { img: any; night: boolean }[] = [];
    weatherFx: any = null;
    seasonFx: any = null;
    hint: any = null;
    near: Official | null = null;
    doorArmed = false;
    walking = 0; // token for the emperor's click-to-walk
    idleTick = 0;
    reactTick = 0;
    lanterns: { spr: any; glow: any; id: string }[] = [];
    seatSig = '';
    /** the first sync places everyone at once; later ones walk them in and out */
    settled = false;
    /** departures wait for the 退朝 bows until this time */
    holdUntil = 0;
    excusedTags = new Map<string, any>();
    visit: (Visit & { o: Official; seat: Seat | null; hop: Place | null; arrived: boolean; target: Pt }) | null = null;
    waiting: Official[] = [];
    queueTag: any = null;
    fxQueue: (() => Promise<void>)[] = [];
    fxBusy = 0;
    gatedSeen = new Set<string>();
    festival: Festival = null;
    constructor(key: SceneKey) {
      super(key);
      this.key = key;
    }
    create() {
      this.cameras.main.setZoom(DETAIL).centerOn(WORLD_W / 2, WORLD_H / 2);
      this.officials = new Map();
      this.extras = [];
      this.seats = new Map();
      this.layoutTaken = new Set();
      this.npcs = [];
      this.npcSig = '';
      this.glows = [];
      this.lanterns = [];
      this.weatherFx = null;
      this.seasonFx = null;
      this.hint = null;
      this.near = null;
      this.settled = false;
      this.holdUntil = 0;
      this.excusedTags = new Map();
      this.visit = null;
      this.waiting = [];
      this.queueTag = null;
      this.fxQueue = [];
      this.fxBusy = 0;
      this.gatedSeen = new Set(bridge.model.tasks.filter((t) => t.gate).map((t) => t.id));
      this.festival = festivalOf(this.now());
      this.spots = this.cache.json.get(`spots_${this.key}`)?.spots ?? {};
      this.rects = this.key === 'yutu' ? [] : walkRects(this.spots);
      img(this, 0, 0, `bg_${this.key}`).setOrigin(0, 0).setDepth(-10);
      this.build();
      this.applyLayout();
      this.doors();
      this.ambient();
      if (this.key !== 'yutu') this.spawnEmperor();
      this.setupEnv();
      this.input.on('pointerdown', (p: any, over: any[]) => this.onFloor(p, over));
      bridge.current = this;
      bridge.events.sceneChanged(this.key);
      this.cameras.main.fadeIn(220, 20, 12, 10);
      const viaDoor = !!this.emperor && !this.emperor.seated && bridge.lastSession !== null && !!(this as any).cameThrough;
      this.syncAll(bridge.model);
      this.settled = true;
      bridge.procession = false;
      // a servant by the door announces the emperor to whoever is in the hall
      if (viaDoor && this.officials.size) {
        const e = this.emperor!;
        const crier = [...this.npcs].sort((a, b) => Math.hypot(a.o.x - e.x, a.o.y - e.y) - Math.hypot(b.o.x - e.x, b.o.y - e.y))[0]?.o;
        crier?.say('圣驾到——', 'say', 1800);
        this.time.delayedCall(600, () => {
          for (const [id, o] of this.officials) {
            const a = bridge.model.agents[id];
            if (!AGENT_MAP[id as AgentId] || o.moving || o.frozen || o.seat || (a && a.status !== 'idle')) continue;
            o.greetAt = Date.now();
            this.bowOnce(o);
          }
        });
      }
      this.events.once('shutdown', () => {
        if (bridge.current === this) bridge.current = null;
        this.officials.forEach((o) => o.destroy());
        this.extras.forEach((o) => o.destroy());
        this.npcs.forEach((n) => n.o.destroy());
        this.waiting.forEach((o) => o.destroy());
        if (this.visit && !this.officials.has(this.visit.who)) this.visit.o.destroy();
        this.visit = null;
        this.emperor?.destroy();
        this.emperor = null;
      });
    }
    build() {}
    sync(_m: CourtModel) {}
    now() {
      const d = new Date();
      if (bridge.hourOverride != null) d.setHours(Math.floor(bridge.hourOverride), Math.round((bridge.hourOverride % 1) * 60), 0, 0);
      return d;
    }
    hour() {
      const d = new Date();
      return bridge.hourOverride ?? d.getHours() + d.getMinutes() / 60;
    }
    period(): Period {
      return periodAt(this.hour());
    }
    title(name = SCENE_NAME[this.key]) {
      const [x, y] = this.spots.title ?? [320, 352];
      txt(this, x, y, name.split('').join(' '), { color: '#f2d27a', stroke: '#1a1220', strokeThickness: 3 }).setOrigin(0.5, 1).setDepth(9000);
    }

    /** model update: rebuild when the 朝堂布局 changed, else move people, then let the scene sync */
    syncAll(m: CourtModel) {
      if (courtSig(m.court) !== this.seatSig) {
        if (!(this as any).busy) this.scene.restart();
        return;
      }
      this.computePlaces(m);
      if (bridge.lastSession !== null && bridge.lastSession !== m.session) this.onSession(m.session);
      bridge.lastSession = m.session;
      if (!(this as any).busy) this.syncResidents(m);
      this.sync(m);
      if (this.key !== 'taihe') {
        for (const [key, o] of this.officials) {
          if (o.frozen || o.moving) continue;
          const id = key.split('#')[0];
          o.applyStatus(m.agents[id], snippetFor(m, id), toolFor(m, id));
        }
      }
      if (!(this as any).busy) {
        this.syncVisitors(m);
        this.syncFlows(m);
      }
      this.bubbles();
    }
    bubbles() {
      resolveBubbles([...this.officials.values(), ...(this.emperor ? [this.emperor] : []), ...(this.visit && !this.officials.has(this.visit.who) ? [this.visit.o] : []), ...this.npcs.map((n) => n.o)]);
    }
    /** where every official is now (the same answer in every scene) */
    computePlaces(m: CourtModel) {
      const hour = this.hour();
      for (const id of ATTENDS) {
        const a = m.agents[id];
        const next = this.forcePlace(id) ?? placeOf(id, { hour, session: m.session, busy: !!a && a.status !== 'idle' });
        const was = bridge.places[id];
        if (was && was !== next) bridge.cameFrom[id] = was;
        bridge.places[id] = next;
      }
    }
    forcePlace(_id: string): Place | null {
      return null;
    }
    onSession(_open: boolean) {}

    // ───── residents: walk in when they should be here, walk out when they should not ─────
    syncResidents(m: CourtModel) {
      let i = 0;
      const hour = this.hour();
      for (const [id, seat] of this.seats) {
        if (this.layoutTaken.has(id)) continue;
        const want = bridge.places[id] === this.key;
        const o = this.officials.get(id);
        if (o?.borrowed) continue;
        if (want && !o) this.arrive(id, seat, bridge.cameFrom[id], i++);
        else if (want && o?.leaving) this.cancelLeave(o, seat);
        else if (!want && o && !o.leaving) this.depart(id, o, bridge.places[id] ?? 'out', i++);
        // a ministry that skipped court because it is busy
        if (this.key === 'taihe') {
          const ex = excused(id, { hour, session: m.session, busy: !!m.agents[id] && m.agents[id]!.status !== 'idle' }) && !(this as any).forceAll;
          const tag = this.excusedTags.get(id);
          if (ex && !tag) this.excusedTags.set(id, nativeText(this, seat.x, seat.y - 22, `${AGENT_MAP[id as AgentId]?.name ?? id}\n因公告假`, { color: '#c4bdb0', align: 'center', stroke: '#1a1220', strokeThickness: 2 }).setOrigin(0.5, 1).setDepth(seat.y).setAlpha(0.85));
          else if (!ex && tag) { tag.destroy(); this.excusedTags.delete(id); }
        }
      }
    }
    newResident(id: string, x: number, y: number, facing: Facing, label?: string) {
      const meta = AGENT_MAP[id as AgentId];
      const o = new Official(this, id, x, y, {
        facing, role: id, label: label ?? meta?.name ?? id, color: meta ? '#f4e6c4' : '#f2d27a',
        onClick: meta ? (me) => bridge.events.agentMenu(id as AgentId, me.x, me.y - 48) : undefined,
        onHover: meta ? (me, over) => bridge.events.hoverAgent(over ? { id: id as AgentId, x: me.x, y: me.y - 48 } : null) : undefined,
      });
      this.officials.set(id, o);
      return o;
    }
    settle(o: Official, seat: Seat) {
      o.sprite.setVisible(true).setAlpha(1);
      o.tag?.setVisible(true).setAlpha(1);
      o.setPos(seat.x, seat.y);
      o.facing = seat.facing;
      o.homeFacing = seat.facing;
      o.seated = !!seat.seated;
      o.current = '';
      o.frozen = false;
      o.moving = false;
      o.leaving = false;
      o.idle();
    }
    arrive(id: string, seat: Seat, from: Place | undefined, i: number) {
      const animate = this.settled || bridge.procession;
      if (!animate) {
        const o = this.newResident(id, seat.x, seat.y, seat.facing, seat.label);
        this.settle(o, seat);
        return;
      }
      const hop = (from && from !== this.key ? nextHop(this.key, from) : null) ?? this.defaultHop(id);
      const [sx, sy] = this.exitPoint(hop);
      const o = this.newResident(id, sx, sy, 'front', seat.label);
      o.frozen = true;
      o.moving = true;
      // waits out of sight (off the frame edge, or hidden until his turn at an inner door)
      o.sprite.setVisible(false);
      o.tag?.setVisible(false);
      const night = this.period() === 'night';
      this.time.delayedCall(i * 380, async () => {
        if (!o.sprite.active || !o.moving) return;
        o.sprite.setVisible(true);
        o.tag?.setVisible(true);
        const lamp = night ? this.carryLamp(o) : null;
        if (night && id !== 'taizi') o.say('臣奉召入宫。', 'say', 1800);
        const ok = await this.walkPath(o, [this.entryPoint(hop), ...route(this.rects, this.entryPoint(hop), [seat.x, seat.y]), [seat.x, seat.y]], 15);
        lamp?.destroy();
        if (!ok || !o.moving) return;
        this.settle(o, seat);
        if (!o.seated && seat.facing !== 'back') o.playFor('bow', 900);
        o.applyStatus(bridge.model.agents[id], snippetFor(bridge.model, id), toolFor(bridge.model, id));
        this.bubbles();
      });
    }
    depart(id: string, o: Official, to: Place, i: number) {
      o.leaving = true;
      o.frozen = true;
      o.clearBubble(true);
      o.setMark(null);
      const hop = nextHop(this.key, to) ?? this.defaultHop(id);
      const wait = Math.max(0, this.holdUntil - Date.now()) + i * 300;
      const tok = ++o.tok;
      this.time.delayedCall(wait, async () => {
        if (o.tok !== tok || !o.leaving || !o.sprite.active) return;
        o.moving = true;
        o.seated = false;
        const lamp = this.period() === 'night' ? this.carryLamp(o) : null;
        const entry = this.entryPoint(hop);
        const ok = await this.walkPath(o, [...route(this.rects, [o.x, o.y], entry), this.exitPoint(hop)], 15);
        lamp?.destroy();
        if (!ok || !o.leaving) return;
        this.tweens.add({ targets: [o.sprite, o.tag].filter(Boolean), alpha: 0, duration: 250, onComplete: () => {
          if (!o.leaving) return;
          o.destroy();
          if (this.officials.get(id) === o) this.officials.delete(id);
        } });
      });
    }
    cancelLeave(o: Official, seat: Seat) {
      o.leaving = false;
      o.moving = true;
      o.sprite.setVisible(true).setAlpha(1);
      o.tag?.setVisible(true).setAlpha(1);
      void this.walkPath(o, [...route(this.rects, [o.x, o.y], [seat.x, seat.y]), [seat.x, seat.y]], 15).then((ok) => ok && this.settle(o, seat));
    }
    /** a little lantern glow that follows an official walking at night */
    carryLamp(o: Official) {
      const g = img(this, o.x + 7, o.y - 18, 'glow').setDepth(2650).setBlendMode(P.BlendModes.ADD).setScale(S * 0.35).setAlpha(0.7);
      const ev = this.time.addEvent({ delay: 40, loop: true, callback: () => g.active && o.sprite.active && g.setPosition(Math.round(o.x + 7), Math.round(o.y - 18)) });
      return { destroy: () => { ev.remove(); g.destroy(); } };
    }
    /** walk through the given points; false when another walk took over */
    async walkPath(o: Official, pts: Pt[], msPerUnit = 16): Promise<boolean> {
      const tok = ++o.tok;
      for (const [x, y] of pts) {
        const d = Math.hypot(x - o.x, y - o.y);
        if (d < 0.5) continue;
        await o.walkTo(x, y, Math.max(90, d * msPerUnit));
        if (o.tok !== tok || !o.sprite.active) return false;
      }
      return true;
    }

    // ───── doors ─────
    doorRect(to: Place | null): number[] | undefined {
      if (!to || to === 'out') return undefined;
      return (this.spots.doors as Record<string, number[]> | undefined)?.[to];
    }
    defaultHop(_id?: string): Place | null {
      const d = Object.keys(this.spots.doors ?? {});
      return (d[0] as SceneKey) ?? null;
    }
    /** the floor point just inside the door that leads toward `to` (a step past the doorway, so whoever
     *  comes in is not standing in it and can turn round and walk straight back out) */
    entryPoint(to: Place | null): Pt {
      const d = this.doorRect(to);
      if (!d) {
        const bottom = Math.max(...this.rects.map((r) => r.y1), 300);
        return nearestFloor(this.rects, 320, bottom);
      }
      const [x, y, w, h] = d;
      const [cx, cy] = [x + w / 2, y + h / 2];
      if (x < 40) return nearestFloor(this.rects, x + w + 14, cy);
      if (x + w > WORLD_W - 40) return nearestFloor(this.rects, x - 14, cy);
      if (y > WORLD_H - 40) return nearestFloor(this.rects, cx, y - 14);
      return nearestFloor(this.rects, cx, y + h + 14);
    }
    /** just outside that door (off screen at the frame edges) */
    exitPoint(to: Place | null): Pt {
      const d = this.doorRect(to);
      if (!d) return [320, WORLD_H + 30];
      const [x, y, w, h] = d;
      if (x < 40) return [-20, y + h / 2];
      if (x + w > WORLD_W - 40) return [WORLD_W + 20, y + h / 2];
      if (y > WORLD_H - 40) return [x + w / 2, WORLD_H + 30];
      return [x + w / 2, y + h / 2 - 6];
    }

    /** place the chosen design's roles where its 朝堂布局 says (replacing the built-in seating if asked) */
    applyLayout() {
      const c = bridge.model.court;
      this.seatSig = courtSig(c);
      if (!c) return;
      if (c.layout.hideBuiltin) this.seats.clear();
      for (const s of c.layout.seats) {
        if (s.scene !== this.key) continue;
        const r = c.roles[s.role];
        if (!r) continue;
        // a role takes over its avatar's built-in spot; a second role with the same avatar gets its own key
        let key: string = r.avatar;
        if (this.officials.get(key)?.seat) key = `${r.avatar}#${s.role}`;
        this.layoutTaken.add(r.avatar);
        this.officials.get(key)?.destroy();
        const av = r.avatar;
        const o = new Official(this, av, s.x, s.y, {
          facing: s.facing, seated: s.pose === 'sit', role: av, label: r.name, color: '#f4e6c4',
          onClick: (me) => bridge.events.agentMenu(av, me.x, me.y - 48),
          onHover: (me, over) => bridge.events.hoverAgent(over ? { id: av, x: me.x, y: me.y - 48 } : null),
        });
        o.seat = true;
        o.homeFacing = s.facing;
        o.idleAnim = s.pose === 'kneel' ? 'kneel' : s.idle ?? '';
        o.current = '';
        o.idle();
        if (s.pose === 'sit' && s.desk) img(this, s.x, s.y + 4, 'desk').setOrigin(0.5, 1).setDepth(s.y + 2);
        this.officials.set(key, o);
      }
    }
    ambient() {}

    extra(key: string, x: number, y: number, facing: Facing = 'front', seated = false) {
      const o = new Official(this, key, x, y, { facing, seated });
      this.extras.push(o);
      return o;
    }

    /** a rectangle the user can hover (gold outline + caption) and click */
    hotspot(x: number, y: number, w: number, h: number, label: string, onClick: () => void, depth = 5) {
      const z = this.add.zone(x, y, w, h).setOrigin(0, 0).setDepth(depth).setInteractive({ useHandCursor: true });
      const g = this.add.graphics().setDepth(4800).setVisible(false);
      g.lineStyle(1, 0xf2d27a, 1);
      g.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
      g.lineStyle(1, 0x6e1a1c, 0.8);
      g.strokeRect(x + 1.5, y + 1.5, w - 3, h - 3);
      const cap = txt(this, x + w / 2, y - 2, label, { color: '#f2d27a', stroke: '#1a1220', strokeThickness: 3 }).setOrigin(0.5, 1).setDepth(4801).setVisible(false);
      if (cap.y - cap.height < 0) cap.setOrigin(0.5, 0).setY(y + h + 2);
      cap.setX(Math.max(cap.width / 2 + 2, Math.min(WORLD_W - cap.width / 2 - 2, cap.x)));
      z.on('pointerover', () => { g.setVisible(true); cap.setVisible(true); });
      z.on('pointerout', () => { g.setVisible(false); cap.setVisible(false); });
      z.on('pointerdown', (p: any) => { p?.event?.stopPropagation?.(); bridge.events.activity(); onClick(); });
      return z;
    }

    doors() {
      const d = this.spots.doors as Record<SceneKey, number[]> | undefined;
      if (!d) return;
      const arrow: Record<string, string> = { left: '← ', right: ' →', down: '↓ ', up: '↑ ' };
      for (const [to, [x, y, w, h]] of Object.entries(d) as [SceneKey, number[]][]) {
        const dir = x < 40 ? 'left' : x + w > WORLD_W - 40 ? 'right' : y > WORLD_H - 40 ? 'down' : 'up';
        const label = dir === 'right' ? `${SCENE_NAME[to]}${arrow.right}` : `${arrow[dir]}${SCENE_NAME[to]}`;
        this.hotspot(x, y, w, h, label, () => this.go(to), 6).setName(`door_${to}`);
      }
    }
    go(to: SceneKey) {
      bridge.arrivedFrom = this.key;
      bridge.events.sound('chime');
      bridge.events.gotoScene(to);
    }

    // ───── the emperor's own avatar (walk with arrow keys / click the floor; Space = 召见) ─────
    throne(): { x: number; y: number; foot: number } | null {
      return null;
    }
    spawnEmperor() {
      const from = bridge.arrivedFrom;
      bridge.arrivedFrom = null;
      const th = this.throne();
      const door = from ? this.doorRect(from) : undefined;
      if (th && !door && bridge.model.session) return void this.spawnOnThrone();
      let [x, y] = (this.spots.emperorStart as Pt | undefined) ?? nearestFloor(this.rects, 320, 300);
      if (door) [x, y] = this.entryPoint(from);
      (this as any).cameThrough = !!door;
      this.emperor = new Official(this, 'emperor', x, y, { facing: door && door[1] > WORLD_H - 40 ? 'back' : 'front', label: '皇上', color: '#f2d27a', onClick: () => this.clickEmperor() });
      this.doorArmed = false;
    }
    spawnOnThrone() {
      const th = this.throne()!;
      this.emperor = new Official(this, 'emperor', th.x, th.y, { facing: 'front', seated: true, label: '皇上', color: '#f2d27a', onClick: () => this.clickEmperor() });
      this.emperor.sprite.setDepth(th.y + 5);
      this.emperor.tag?.setDepth(th.y + 6);
    }
    clickEmperor() {
      const e = this.emperor!;
      bridge.events.activity();
      const th = this.throne();
      if (th) {
        if (!e.seated) return void this.backToThrone();
        const gated = bridge.model.tasks.find((t) => t.gate);
        if (gated) bridge.events.openReview(gated.id);
        else e.say(bridge.model.session ? '朕在此，众卿有本早奏。' : '殿中空寂，朕坐一坐。', 'say', 2500);
      } else e.say(['朕来看看。', '众卿辛苦了。', '诸事可还顺遂？'][Math.floor(Math.random() * 3)], 'say', 2200);
    }
    standUp(): Promise<void> {
      const e = this.emperor!;
      const th = this.throne();
      if (!th || !e.seated) return Promise.resolve();
      e.seated = false;
      e.sprite.setDepth(th.foot);
      return e.walkTo(th.x, th.foot, 500);
    }
    async backToThrone() {
      const e = this.emperor;
      const th = this.throne();
      if (!e || !th || e.seated) return;
      const tok = ++this.walking;
      e.tok++;
      for (const [x, y] of route(this.rects, [e.x, e.y], [th.x, th.foot])) {
        await e.walkTo(x, y, Math.max(160, Math.hypot(x - e.x, y - e.y) * 12));
        if (tok !== this.walking) return;
      }
      await e.walkTo(th.x, th.y, 500);
      if (tok !== this.walking) return;
      e.facing = 'front';
      e.seated = true;
      e.current = '';
      e.play('idle');
      e.sprite.setDepth(th.y + 5);
      e.tag?.setDepth(th.y + 6);
    }
    async onFloor(p: any, over: any[]) {
      if (over.length || !this.emperor || (this as any).busy) return;
      const pt = this.cameras.main.getWorldPoint(p.x, p.y);
      if (!onFloor(this.rects, pt.x, pt.y, 14)) return;
      bridge.events.activity();
      const tok = ++this.walking;
      await this.standUp();
      if (tok !== this.walking || !this.emperor) return;
      const e = this.emperor;
      e.tok++;
      for (const [x, y] of route(this.rects, [e.x, e.y], [pt.x, pt.y])) {
        await e.walkTo(x, y, Math.max(160, Math.hypot(x - e.x, y - e.y) * 14));
        if (tok !== this.walking) return;
      }
      e.play('idle');
    }
    /** Space: summon the official the emperor stands next to */
    action(code: string) {
      bridge.events.activity();
      if (code === 'Escape') return void this.backToThrone();
      if (code !== 'Space' && code !== 'Enter') return;
      if (this.near) {
        const id = [...this.officials.entries()].find(([, o]) => o === this.near)?.[0];
        if (id && AGENT_MAP[id as AgentId]) {
          this.emperor?.say(`宣${AGENT_MAP[id as AgentId].name}觐见。`, 'say', 1600);
          bridge.events.clickAgent(id as AgentId);
        }
      }
    }

    update(_t: number, dt: number) {
      const e = this.emperor;
      if (e && !(this as any).busy) {
        const k = bridge.keys;
        let dx = (k.has('ArrowRight') || k.has('KeyD') ? 1 : 0) - (k.has('ArrowLeft') || k.has('KeyA') ? 1 : 0);
        let dy = (k.has('ArrowDown') || k.has('KeyS') ? 1 : 0) - (k.has('ArrowUp') || k.has('KeyW') ? 1 : 0);
        if (dx || dy) {
          this.walking++;
          this.tweens.killTweensOf(e.sprite);
          if (e.seated) {
            void this.standUp();
          } else {
            const v = (72 * dt) / 1000 / (dx && dy ? Math.SQRT2 : 1);
            const [nx, ny] = stepOnFloor(this.rects, e.x, e.y, dx * v, dy * v);
            dx = nx - e.x;
            dy = ny - e.y;
            e.step(dx, dy);
          }
        } else if (!this.tweens.isTweening(e.sprite)) e.step(0, 0);
        // walking into a doorway leads to the next hall
        if (!e.seated) {
          const d = this.spots.doors as Record<string, number[]> | undefined;
          const inside = d && Object.entries(d).find(([, [x, y, w, h]]) => e.x >= x - 6 && e.x <= x + w + 6 && e.y >= y - 4 && e.y <= y + h + 6);
          if (!inside) this.doorArmed = true;
          else if (this.doorArmed && (dx || dy || !this.tweens.isTweening(e.sprite))) {
            this.doorArmed = false;
            this.go(inside[0] as SceneKey);
          }
        }
        this.updateNear();
        if ((this.reactTick += dt) > 250) {
          this.reactTick = 0;
          this.reactToEmperor();
          this.followEmperor();
        }
      }
      if ((this.idleTick += dt) > 600) {
        this.idleTick = 0;
        for (const [id, o] of this.officials) {
          const a = bridge.model.agents[id];
          if (!o.frozen && !o.moving && (!a || a.status === 'idle')) o.applyStatus(a, undefined);
        }
        // palace staff only ever speak a line at a time: let it fade once its moment has passed
        for (const n of this.npcs) n.o?.expireBubble();
        this.emperor?.expireBubble();
        for (const o of this.extras) if (!o.frozen && (o.key === 'lady' || o.key === 'clerk' || o.key === 'eunuch')) o.idle();
      }
    }
    updateNear() {
      const e = this.emperor!;
      let best: Official | null = null;
      let bd = 34;
      if (!e.seated) {
        for (const [id, o] of this.officials) {
          if (!AGENT_MAP[id as AgentId] || o.moving || o.leaving) continue;
          const d = Math.hypot(o.x - e.x, (o.y - e.y) * 1.4);
          if (d < bd) { bd = d; best = o; }
        }
      }
      if (best !== this.near) {
        this.near = best;
        this.hint?.destroy();
        this.hint = best ? nativeText(this, best.x, best.y - 50, '␣ 空格 召见', { color: '#1a1220', backgroundColor: '#f2d27a', padding: { x: 3, y: 1 } }).setOrigin(0.5, 1).setDepth(4900) : null;
      } else if (best && this.hint) this.hint.setPosition(Math.round(best.x), Math.round(best.y - 50));
    }
    /** officials notice the emperor walking by; servants kneel; someone worked over his shoulder sweats */
    reactToEmperor() {
      const e = this.emperor!;
      if (e.seated) return;
      const now = Date.now();
      for (const [id, o] of this.officials) {
        if (o.frozen || o.moving || o.leaving || o.seat || !AGENT_MAP[id as AgentId]) continue;
        const d = Math.hypot(o.x - e.x, (o.y - e.y) * 1.3);
        const a = bridge.model.agents[id];
        const busy = !!a && a.status !== 'idle';
        if (d < 40 && now - o.greetAt > 45000) {
          o.greetAt = now;
          if (busy) {
            o.say(`${id === 'taizi' ? '父皇' : '陛下'}稍候，正办：${(a?.activity || '差事').slice(0, 14)}`, 'say', 1800);
          } else {
            if (!o.seated) o.facing = Math.abs(e.x - o.x) < 10 ? (e.y < o.y ? 'back' : 'front') : e.x < o.x ? 'left' : 'right';
            this.bowOnce(o);
            o.say(id === 'taizi' ? '儿臣给父皇请安。' : '臣参见陛下。', 'say', 1600);
            this.bubbles();
          }
        }
        // standing right behind (north of) a busy official for a while makes him nervous
        if (busy && d < 30 && e.y < o.y - 3) {
          if (!o.behindSince) o.behindSince = now;
          else if (now - o.behindSince > 5000) {
            o.behindSince = now + 20000;
            o.playFor('worry', 1800);
            o.say('（额头冒汗）', 'think', 1800);
          }
        } else if (o.behindSince && o.behindSince < now) o.behindSince = 0;
      }
      for (const n of this.npcs) {
        const o = n.o;
        if (o.frozen || o.moving) continue;
        const d = Math.hypot(o.x - e.x, (o.y - e.y) * 1.3);
        if (d < 30 && now - o.greetAt > 30000) {
          o.greetAt = now;
          if (o.key === 'guard') o.playFor('bow', 700);
          else {
            const sat = o.seated;
            o.seated = false;
            o.playFor('kneel', 1600);
            this.time.delayedCall(1600, () => { o.seated = sat; o.current = ''; });
          }
        }
      }
    }

    /** rise (if seated), bow, and go back to what he was doing */
    bowOnce(o: Official, ms = 1300) {
      const sat = o.seated;
      o.seated = false;
      o.playFor('bow', ms);
      this.time.delayedCall(ms, () => {
        if (o.moving || o.leaving || !o.sprite.active) return;
        const seat = [...this.seats.entries()].find(([k]) => this.officials.get(k) === o)?.[1];
        o.seated = sat;
        o.facing = seat?.facing ?? o.homeFacing ?? 'front';
        o.current = '';
        o.idle();
      });
    }

    // ───── reward / scold (animation only) ─────
    react(id: string, kind: 'reward' | 'scold' | 'urge') {
      const o = this.officials.get(id);
      if (!o || o.frozen || o.moving) return false;
      if (kind === 'urge') {
        o.playFor('bow', 1400);
        o.say(id === 'taizi' ? '儿臣遵旨，即刻去办！' : '臣遵旨，即刻去办！', 'say', 2200);
        this.floatText(o.x, o.y - 56, '催办', '#f4e6c4');
        bridge.events.sound('chime');
      } else if (kind === 'reward') {
        o.playFor('joy', 2400);
        this.time.delayedCall(2400, () => o.playFor('bow', 1300));
        o.say(id === 'taizi' ? '谢父皇！' : '谢主隆恩！', 'say', 2400);
        this.floatText(o.x, o.y - 56, '恩赏 +1', '#f2d27a');
        for (let i = 0; i < 6; i++) {
          const c = img(this, o.x + (i - 2.5) * 6, o.y - 60, 'seal').setDepth(4700).setTint(0xf2d27a).setScale(S * 0.5);
          this.tweens.add({ targets: c, y: o.y - 8, x: c.x + (Math.random() - 0.5) * 18, alpha: 0, duration: 900 + i * 90, ease: 'Quad.easeIn', onComplete: () => c.destroy() });
        }
        bridge.events.sound('chime');
      } else {
        o.playFor('fear', 2000);
        this.time.delayedCall(2000, () => o.playFor('bow', 1300));
        o.say(id === 'taizi' ? '儿臣知错！' : '臣知罪，必当尽心！', 'alert', 2400);
        this.floatText(o.x, o.y - 56, '训诫', '#e0604a');
        this.cameras.main.shake(160, 0.003);
        bridge.events.sound('gong');
      }
      return true;
    }
    floatText(x: number, y: number, s: string, color: string, size = 12) {
      const t = txt(this, x, y, s, { color, stroke: '#1a1220', strokeThickness: 3, fontSize: `${size}px` }).setOrigin(0.5, 1).setDepth(5200);
      this.tweens.add({ targets: t, y: y - 18, alpha: 0, duration: 1500, ease: 'Quad.easeOut', onComplete: () => t.destroy() });
    }
    /** a red seal word (准 / 驳) that thumps down and fades */
    stamp(x: number, y: number, s: string) {
      const t = txt(this, x, y, s, { fontSize: '18px', color: '#e0402a', stroke: '#fbf0d4', strokeThickness: 3 }).setOrigin(0.5).setDepth(5300).setScale(1.8).setAlpha(0);
      this.tweens.add({ targets: t, scale: 1, alpha: 1, duration: 180, ease: 'Back.easeOut', onComplete: () => {
        this.tweens.add({ targets: t, alpha: 0, delay: 900, duration: 500, onComplete: () => t.destroy() });
      } });
    }

    // ───── 请旨 / 递折子: the one asking walks to wherever the emperor is; the rest wait their turn ─────
    visitQueue(m: CourtModel): Visit[] {
      const out: Visit[] = [];
      for (const ap of m.approvals.filter((x) => x.status === 'pending').sort((a, b) => a.at - b.at)) {
        const who = ap.agentId in AGENT_MAP ? ap.agentId : 'eunuch';
        const self = who === 'taizi' ? '儿臣' : '臣';
        const body = ap.kind === 'question' ? ap.summary : `${self}请旨：${ap.summary}`;
        out.push({ key: `ap:${ap.id}`, kind: 'ap', who, text: `${ap.risk === 'high' && ap.kind !== 'question' ? '⚠ ' : ''}${courtAddress(who, body)}`, click: () => bridge.events.clickApproval(ap.id), taskId: ap.taskId });
      }
      for (const t of m.tasks.filter((x) => x.gate && !TERMINAL.includes(x.state))) {
        const g = t.gate!;
        const label = g.kind === 'plan' ? '中书方案已审，请御览' : g.kind === 'final' ? '回奏已至，请御批' : g.kind === 'budget' ? '用度超支，请示下' : g.kind === 'risk' ? '事涉风险，请圣裁' : '封驳逾限，请圣裁';
        const inHall = this.key === 'taihe' && m.session && !!this.emperor?.seated;
        const who = inHall ? (g.kind === 'final' ? 'shangshu' : g.kind === 'budget' ? 'hubu' : 'menxia') : 'eunuch';
        out.push({ key: `gate:${t.id}:${who}`, kind: 'gate', who, text: `${who === 'eunuch' ? '启禀皇上' : '皇上'}，${label}`, click: () => bridge.events.openReview(t.id), taskId: t.id });
      }
      return out;
    }
    syncVisitors(m: CourtModel) {
      if (!this.emperor) return;
      // a memorial taken off the queue: in the hall, everyone hails the decision
      const gatedNow = new Set(m.tasks.filter((t) => t.gate).map((t) => t.id));
      for (const id of this.gatedSeen) {
        const t = m.tasks.find((x) => x.id === id);
        if (!gatedNow.has(id) && t && t.state !== 'Cancelled') this.onGateDecided(t);
      }
      this.gatedSeen = gatedNow;
      const q = this.visitQueue(m);
      const head = q[0];
      if (this.visit && (!head || this.visit.key !== head.key)) this.dismissVisitor();
      if (head && !this.visit) this.summonVisitor(head);
      else if (head && this.visit) this.visit.text = head.text;
      if (this.visit?.arrived) this.visit.o.say(this.visit.text, 'alert');
      this.syncWaiting(q.slice(1));
    }
    onGateDecided(_t: Task) {}
    /** spots near the emperor where the visitor kneels */
    visitTarget(): Pt {
      const e = this.emperor!;
      const th = this.throne();
      if (th && e.seated) return (this.spots.kneel as Pt | undefined) ?? [th.x, th.foot + 20];
      const side = e.x > WORLD_W / 2 ? -1 : 1;
      let p = nearestFloor(this.rects, e.x + side * 26, e.y + 2);
      if (Math.hypot(p[0] - e.x, p[1] - e.y) < 14) p = nearestFloor(this.rects, e.x - side * 26, e.y + 2);
      return p;
    }
    summonVisitor(v: Visit) {
      const resident = this.officials.get(v.who);
      const target = this.visitTarget();
      let o: Official;
      let seat: Seat | null = null;
      let hop: Place | null = null;
      if (resident && !resident.leaving && !resident.moving && !resident.seat) {
        o = resident;
        o.borrowed = true;
        seat = this.seats.get(v.who) ?? { x: o.x, y: o.y, facing: o.facing, seated: o.seated };
      } else {
        hop = v.who === 'eunuch' ? nextHop(this.key, 'junjichu') ?? this.defaultHop() : nextHop(this.key, bridge.places[v.who] ?? 'out') ?? this.defaultHop();
        const [sx, sy] = this.exitPoint(hop);
        o = new Official(this, v.who, sx, sy, { facing: 'front', role: v.who, onClick: () => v.click() });
      }
      o.clickOverride = v.click;
      o.frozen = true;
      o.moving = true;
      o.clearBubble(true);
      o.setMark(null);
      this.visit = { ...v, o, seat, hop, arrived: false, target };
      const visit = this.visit;
      const start: Pt[] = hop !== null ? [this.entryPoint(hop)] : [];
      void this.walkPath(o, [...start, ...route(this.rects, start[0] ?? [o.x, o.y], target)], 14).then((ok) => {
        if (!ok || this.visit !== visit) return;
        this.kneelBefore(visit);
      });
    }
    kneelBefore(visit: NonNullable<Base['visit']>) {
      const o = visit.o;
      const e = this.emperor;
      o.moving = false;
      o.seated = false;
      o.facing = !e ? 'back' : Math.abs(e.x - o.x) < 12 ? (e.y < o.y ? 'back' : 'front') : e.x < o.x ? 'left' : 'right';
      o.current = '';
      visit.arrived = true;
      if (visit.kind === 'gate' && visit.who !== 'eunuch') {
        o.playFor('present', 1400);
        this.time.delayedCall(1400, () => this.visit === visit && o.play('kneel'));
      } else o.play('kneel');
      o.say(visit.text, 'alert');
      this.onVisitorArrived(visit);
      this.bubbles();
    }
    onVisitorArrived(_v: NonNullable<Base['visit']>) {}
    /** the emperor moved away: the visitor follows once he stops */
    followEmperor() {
      const v = this.visit;
      const e = this.emperor;
      if (!v || !v.arrived || !e || this.tweens.isTweening(e.sprite) || bridge.keys.size) return;
      const t = this.visitTarget();
      if (Math.hypot(t[0] - v.target[0], t[1] - v.target[1]) < 36) return;
      v.target = t;
      v.arrived = false;
      v.o.moving = true;
      v.o.clearBubble(true);
      void this.walkPath(v.o, route(this.rects, [v.o.x, v.o.y], t), 12).then((ok) => ok && this.visit === v && this.kneelBefore(v));
    }
    dismissVisitor() {
      const v = this.visit!;
      this.visit = null;
      const o = v.o;
      o.clickOverride = null;
      o.clearBubble(true);
      this.onVisitorLeft(v);
      if (!o.sprite.active) return;
      o.say(v.kind === 'gate' ? '遵旨。' : v.who === 'taizi' ? '儿臣明白了。' : '臣遵旨。', 'say', 1200);
      o.playFor('bow', 900);
      this.time.delayedCall(900, async () => {
        if (!o.sprite.active) return;
        if (v.seat) {
          const seat = v.seat;
          const ok = await this.walkPath(o, [...route(this.rects, [o.x, o.y], [seat.x, seat.y]), [seat.x, seat.y]], 14);
          if (!ok) return;
          o.borrowed = false;
          this.settle(o, seat);
          return;
        }
        const hop = v.hop ?? this.defaultHop();
        const ok = await this.walkPath(o, [...route(this.rects, [o.x, o.y], this.entryPoint(hop)), this.exitPoint(hop)], 14);
        if (ok) this.tweens.add({ targets: o.sprite, alpha: 0, duration: 250, onComplete: () => o.destroy() });
      });
    }
    onVisitorLeft(_v: Visit) {}
    /** the next ones in line wait by the door (or at the hall's waiting spots) */
    syncWaiting(rest: Visit[]) {
      const spots = (this.spots.queue as Pt[] | undefined) ?? [];
      const want = rest.slice(0, spots.length).map((v) => (v.who === 'eunuch' ? 'eunuch' : v.who));
      if (this.waiting.map((o) => o.key).join() !== want.join()) {
        this.waiting.forEach((o) => o.destroy());
        this.waiting = want.map((k, i) => {
          const o = new Official(this, k, spots[i][0], spots[i][1], { facing: 'back', role: k });
          o.play('bow');
          return o;
        });
      }
      this.queueTag?.destroy();
      this.queueTag = null;
      if (rest.length) {
        const [x, y] = spots[0] ?? this.entryPoint(this.visit?.hop ?? this.defaultHop());
        this.queueTag = nativeText(this, x, y + 2, `候见 ×${rest.length}`, { color: '#1a1220', backgroundColor: '#f2d27a', padding: { x: 3, y: 1 } }).setOrigin(0.5, 0).setDepth(4950);
      }
    }

    // ───── 交办 / 传话: flow entries acted out between whoever is in this scene ─────
    syncFlows(m: CourtModel) {
      if (!bridge.flowSeen) {
        bridge.flowSeen = new Map(m.tasks.map((t) => [t.id, t.flow.length]));
        return;
      }
      const now = Date.now();
      for (const t of m.tasks) {
        const n = t.flow.length;
        const seen = bridge.flowSeen.get(t.id) ?? (now - t.createdAt < 60000 ? 0 : n);
        if (n > seen) for (const f of t.flow.slice(seen)) if (now - f.at < 30000) this.queueHandoff(f);
        bridge.flowSeen.set(t.id, n);
      }
    }
    queueHandoff(f: FlowEntry) {
      const from = idOfName(f.from);
      const to = idOfName(f.to);
      if (!from || !to || from === to) return;
      if (this.fxQueue.length > 4) this.fxQueue.shift();
      this.fxQueue.push(() => this.handoff(from, to, f.remark));
      this.pumpFx();
    }
    pumpFx() {
      while (this.fxBusy < 2 && this.fxQueue.length) {
        const job = this.fxQueue.shift()!;
        this.fxBusy++;
        void job().catch(() => undefined).finally(() => {
          this.fxBusy--;
          if (this.sys?.isActive?.()) this.pumpFx();
        });
      }
    }
    actor(id: string): Official | null {
      if (id === 'emperor') return this.emperor;
      const o = this.officials.get(id);
      return o && !o.leaving && !o.moving && !o.borrowed ? o : null;
    }
    async handoff(fromId: string, toId: string, remark: string) {
      const from = this.actor(fromId);
      const to = this.actor(toId);
      if (!from && !to) return;
      const kind = flowKind(remark);
      const short = remark.replace(/\s+/g, '').slice(0, 18);
      if (from && from !== this.emperor && short) {
        from.playFor(kind === 'reject' ? 'reject' : 'present', 900);
        from.say(short, kind === 'reject' ? 'alert' : 'say', 2200);
        this.bubbles();
      }
      if (from && to) {
        if (Math.hypot(to.x - from.x, to.y - from.y) <= 170) await this.flyScroll(from, to, kind);
        else await this.runner([from.x, from.y + 4], [to.x, to.y + 4], to, kind);
        return;
      }
      // only one end is here: an errand-runner carries it out of / into the scene
      if (from) {
        const hop = nextHop(this.key, bridge.places[toId] ?? 'out') ?? this.defaultHop();
        await this.runner([from.x, from.y + 4], this.exitPoint(hop), null, kind, hop);
      } else if (to) {
        const hop = nextHop(this.key, bridge.places[fromId] ?? 'out') ?? this.defaultHop();
        await this.runner(this.exitPoint(hop), [to.x, to.y + 4], to, kind, hop);
      }
    }
    /** the document flies in an arc from one official to the other, leaving a dotted trail */
    flyScroll(from: Official, to: Official, kind: 'reject' | 'approve' | 'pass') {
      return new Promise<void>((resolve) => {
        const x0 = from.x, y0 = from.y - 30, x1 = to.x, y1 = to.y - 30;
        const peak = Math.min(y0, y1) - 24 - Math.abs(x1 - x0) * 0.12;
        const s = img(this, x0, y0, 'scroll').setDepth(5100).setScale(S * 0.8);
        if (kind === 'reject') s.setTint(0xffb0a0);
        const trail = this.add.graphics().setDepth(5090);
        const dots: Pt[] = [];
        this.tweens.addCounter({
          from: 0, to: 1, duration: 650 + Math.hypot(x1 - x0, y1 - y0) * 3, ease: 'Sine.easeInOut',
          onUpdate: (tw: any) => {
            const u = tw.getValue();
            const x = (1 - u) * (1 - u) * x0 + 2 * (1 - u) * u * ((x0 + x1) / 2) + u * u * x1;
            const y = (1 - u) * (1 - u) * y0 + 2 * (1 - u) * u * peak + u * u * y1;
            s.setPosition(Math.round(x), Math.round(y));
            const last = dots[dots.length - 1];
            if (!last || Math.hypot(last[0] - x, last[1] - y) > 6) {
              dots.push([x, y]);
              trail.fillStyle(kind === 'reject' ? 0xe0604a : 0xf2d27a, 0.9);
              trail.fillRect(Math.round(x), Math.round(y), 1, 1);
            }
          },
          onComplete: () => {
            s.destroy();
            // arrowhead at the receiver, then the trail fades
            trail.fillStyle(kind === 'reject' ? 0xe0604a : 0xf2d27a, 1);
            trail.fillTriangle(x1 - 3, y1 - 6, x1 + 3, y1 - 6, x1, y1 - 2);
            this.tweens.add({ targets: trail, alpha: 0, delay: 500, duration: 700, onComplete: () => trail.destroy() });
            if (kind === 'reject') this.stamp(x1, y1 - 14, '驳');
            else if (kind === 'approve') this.stamp(x1, y1 - 14, '准');
            if (to !== this.emperor && !to.frozen) to.playFor(to.seated ? 'read' : 'bow', 900);
            resolve();
          },
        });
      });
    }
    /** a eunuch (inside the palace) or a clerk (outside) runs the document over */
    async runner(a: Pt, b: Pt, to: Official | null, kind: 'reject' | 'approve' | 'pass', hop: Place | null = null) {
      const key = INNER.has(this.key) ? 'eunuch' : 'clerk';
      const o = new Official(this, key, a[0], a[1], { facing: 'front', role: key });
      o.frozen = true;
      const scroll = img(this, a[0], a[1] - 50, 'scroll').setDepth(5100).setScale(S * 0.7);
      const ev = this.time.addEvent({ delay: 40, loop: true, callback: () => o.sprite.active && scroll.active && scroll.setPosition(Math.round(o.x), Math.round(o.y - 50)) });
      const fromDoor = !onFloor(this.rects, a[0], a[1], 4) && hop !== null;
      const pts: Pt[] = fromDoor ? [this.entryPoint(hop), ...route(this.rects, this.entryPoint(hop), b)] : to ? [...route(this.rects, a, b)] : [...route(this.rects, a, this.entryPoint(hop)), b];
      await this.walkPath(o, pts, 9);
      if (to && to.sprite.active) {
        o.facing = to.x < o.x ? 'left' : 'right';
        o.playFor('present', 700);
        if (kind === 'reject') this.stamp(to.x, to.y - 44, '驳');
        else if (kind === 'approve') this.stamp(to.x, to.y - 44, '准');
        await new Promise((r) => this.time.delayedCall(700, r));
        if (to !== this.emperor && !to.frozen) to.playFor(to.seated ? 'read' : 'bow', 900);
        scroll.destroy();
        const back = this.defaultHop();
        const exit = nearestDoor(this, o.x, o.y) ?? back;
        await this.walkPath(o, [...route(this.rects, [o.x, o.y], this.entryPoint(exit)), this.exitPoint(exit)], 9);
      }
      ev.remove();
      scroll.destroy();
      if (o.sprite.active) this.tweens.add({ targets: o.sprite, alpha: 0, duration: 200, onComplete: () => o.destroy() });
    }

    // ───── point-and-click NPCs: guards, eunuchs, maids, clerks — chosen by the hour ─────
    npcList(): NpcSpec[] {
      return [...((this.spots.npcs as NpcSpec[] | undefined) ?? []), ...((this.spots.guards as Pt[] | undefined) ?? []).map(([x, y]) => ({ kind: 'guard', x, y, facing: 'front' as Facing }))];
    }
    refreshNpcs() {
      const p = this.period();
      const list = this.npcList().filter((n) => npcShows(n, p));
      const sig = `${p}|${list.map((n) => `${n.kind}${n.x},${n.y}${n.act ?? ''}`).join(';')}`;
      if (sig === this.npcSig) return;
      this.npcSig = sig;
      this.npcs.forEach((n) => { n.o.destroy(); n.glow?.destroy(); });
      this.npcs = list.map((n) => {
        const o = new Official(this, n.kind, n.x, n.y, { facing: n.facing ?? 'front', seated: n.kind === 'clerk' && !n.route, role: n.kind });
        const glow = p === 'night' && (n.act === 'patrol' || n.act === 'lamp') ? img(this, n.x + 7, n.y - 18, 'glow').setDepth(2650).setBlendMode(P.BlendModes.ADD).setScale(S * 0.35).setAlpha(0.75) : null;
        const rec = { o, n, glow };
        this.startNpc(rec, p);
        return rec;
      });
    }
    startNpc(rec: { o: Official; n: NpcSpec; glow: any }, p: Period) {
      const { o, n } = rec;
      if (n.kind === 'clerk' && !n.route) {
        o.seated = true;
        o.play(p === 'night' ? 'sit_idle' : 'sit_write');
        if (p === 'night') this.time.addEvent({ delay: 7000 + Math.random() * 5000, loop: true, callback: () => o.sprite.active && o.say('Zz…', 'think', 2500) });
        return;
      }
      if (n.act === 'sweep') o.idleAnim = 'measure';
      if (n.act === 'lamp') o.idleAnim = p === 'sanzhi' ? 'present' : '';
      o.idle();
      const route = n.route && n.route.length > 1 ? n.route : null;
      if (!route) return;
      let i = 0;
      const next = async () => {
        if (!o.sprite.active) return;
        if (o.frozen) return void this.time.delayedCall(1500, next);
        i = (i + 1) % route.length;
        o.moving = true;
        const ok = await this.walkPath(o, [route[i]], n.act === 'patrol' ? 30 : 24);
        if (!ok || !o.sprite.active) return;
        o.moving = false;
        o.current = '';
        o.idle();
        if (n.act === 'patrol' && p === 'night' && Math.random() < 0.5) o.say(Math.random() < 0.5 ? '天干物燥，小心火烛——' : '梆——梆——', 'say', 2200);
        this.time.delayedCall(1500 + Math.random() * 3500, next);
      };
      this.time.delayedCall(800 + Math.random() * 2500, next);
      if (rec.glow) this.time.addEvent({ delay: 40, loop: true, callback: () => rec.glow.active && o.sprite.active && rec.glow.setPosition(Math.round(o.x + 7), Math.round(o.y - 18)) });
    }

    // ───── ambient helpers ─────
    flame(x: number, y: number) {
      this.add.sprite(Math.round(x), Math.round(y), 'flame').setScale(S).setOrigin(0.5, 1).setDepth(y + 1).play({ key: 'flame', startFrame: Math.floor(Math.random() * 3) });
      const g = img(this, x, y - 3, 'glow').setDepth(2600).setBlendMode(P.BlendModes.ADD).setScale(S * 0.45).setAlpha(0);
      this.glows.push({ img: g, night: true });
    }
    smoke(x: number, y: number, alpha = 0.5) {
      return this.add.sprite(Math.round(x), Math.round(y), 'smoke').setScale(S).setOrigin(0.5, 1).setDepth(y + 2).setAlpha(alpha).play('smoke');
    }
    lantern(x: number, y: number, i: number) {
      const id = `${this.key}:${i}`;
      const spr = this.add.sprite(Math.round(x), Math.round(y), 'lantern', 0).setScale(S).setOrigin(0.5, 0).setDepth(2700).setInteractive({ useHandCursor: true, pixelPerfect: true });
      const glow = img(this, x, y + 22, 'glow').setDepth(2650).setBlendMode(P.BlendModes.ADD).setScale(S * 0.8).setAlpha(0);
      this.tweens.add({ targets: spr, angle: { from: -2, to: 2 }, duration: 2200 + i * 300, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' });
      spr.on('pointerdown', (p: any) => {
        p?.event?.stopPropagation?.();
        bridge.lit[id] = !this.isLit(id);
        this.applyLanterns();
        bridge.events.sound('chime');
      });
      this.lanterns.push({ spr, glow, id });
    }
    isLit(id: string) {
      return bridge.lit[id] ?? (this.phase() === 'night' || this.phase() === 'dusk' || this.festival === 'chunjie' || this.festival === 'yuanxiao');
    }
    applyLanterns() {
      for (const l of this.lanterns) {
        const on = this.isLit(l.id);
        l.spr.setFrame(on ? 1 : 0);
        this.tweens.killTweensOf(l.glow);
        l.glow.setAlpha(on ? 0.55 : 0);
        if (on) this.tweens.add({ targets: l.glow, alpha: 0.38, duration: 900, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' });
      }
    }
    /** 博山炉: click to add incense — thicker smoke and a fragrant word */
    burner(x: number, y: number) {
      const s = this.smoke(x, y, 0.45);
      this.hotspot(x - 9, y - 4, 18, 22, '添香', () => {
        this.tweens.killTweensOf(s);
        s.setAlpha(0.95).setScale(S * 1.25);
        const extra = [this.smoke(x - 3, y - 4, 0.8), this.smoke(x + 3, y - 8, 0.7)];
        this.floatText(x, y - 26, '香火鼎盛', '#f4e6c4');
        bridge.events.sound('chime');
        this.tweens.add({ targets: s, alpha: 0.45, scale: S, delay: 12000, duration: 3000 });
        this.time.delayedCall(9000, () => extra.forEach((e) => this.tweens.add({ targets: e, alpha: 0, duration: 2500, onComplete: () => e.destroy() })));
      }, 8);
    }
    /** a cat that wanders between points, sits, and jumps when poked; it trots off when the emperor comes close */
    cat(pts: number[][] | number[], depth?: number) {
      // a single [x, y] spot: wander around it
      const points: number[][] = typeof pts[0] === 'number' ? (([x, y]) => [[x, y], [x - 60, y + 6], [x + 40, y - 4], [x - 140, y + 2]])(pts as number[]) : (pts as number[][]);
      const [sx, sy] = points[0];
      const c = this.add.sprite(sx, sy, 'cat', 4).setScale(S).setOrigin(0.5, 1).setDepth(depth ?? sy).setInteractive({ useHandCursor: true, pixelPerfect: true });
      c.play('cat_sit');
      let busy = false;
      const walkTo = (tx: number, ty: number, speed: number, done: () => void) => {
        c.setFlipX(tx < c.x);
        c.play('cat_walk');
        this.tweens.add({ targets: c, x: tx, y: ty, duration: Math.hypot(tx - c.x, ty - c.y) * speed, onUpdate: () => depth ?? c.setDepth(c.y), onComplete: () => { c.play('cat_sit'); done(); } });
      };
      const wander = () => {
        if (!c.active) return;
        if (busy) return void this.time.delayedCall(2000, wander);
        const [tx, ty] = points[Math.floor(Math.random() * points.length)];
        if (Math.hypot(tx - c.x, ty - c.y) < 4) return void this.time.delayedCall(3000, wander);
        walkTo(tx, ty, 45, () => this.time.delayedCall(5000 + Math.random() * 9000, wander));
      };
      this.time.delayedCall(3000 + Math.random() * 4000, wander);
      // the emperor coming close: half the time it rubs against him, half the time it trots away
      this.time.addEvent({ delay: 500, loop: true, callback: () => {
        const e = this.emperor;
        if (!c.active || busy || !e || e.seated || Math.hypot(e.x - c.x, e.y - c.y) > 22) return;
        busy = true;
        this.tweens.killTweensOf(c);
        if (Math.random() < 0.5) {
          c.play('cat_sit');
          this.floatText(c.x, c.y - 12, '喵～（蹭）', '#f4e6c4');
          this.time.delayedCall(2500, () => { busy = false; });
        } else {
          const far = points.reduce((b, p) => (Math.hypot(p[0] - e.x, p[1] - e.y) > Math.hypot(b[0] - e.x, b[1] - e.y) ? p : b), points[0]);
          walkTo(far[0], far[1], 18, () => { busy = false; });
        }
      } });
      c.on('pointerdown', (p: any) => {
        p?.event?.stopPropagation?.();
        if (busy) return;
        busy = true;
        this.tweens.killTweensOf(c);
        c.play('cat_jump');
        this.tweens.add({ targets: c, y: c.y - 10, duration: 220, yoyo: true, ease: 'Quad.easeOut', onComplete: () => {
          c.play('cat_sit');
          busy = false;
        } });
        this.floatText(c.x, c.y - 14, '喵～', '#f4e6c4');
        bridge.events.sound('meow');
      });
      return c;
    }
    birds(dark = false) {
      if (this.phase() === 'night' || bridge.weather === 'rain') return void this.time.delayedCall(15000, () => this.birds(dark));
      // at dusk the crows come home to roost (the palace really is full of crows at sunset)
      const crows = this.phase() === 'dusk';
      const dir = Math.random() < 0.5 ? 1 : -1;
      const y0 = 18 + Math.random() * 70;
      const n = (crows ? 5 : 3) + Math.floor(Math.random() * 3);
      for (let i = 0; i < n; i++) {
        const b = this.add.sprite(dir > 0 ? -20 - i * 14 : WORLD_W + 20 + i * 14, y0 + (i % 2) * 7 + i * 2, 'bird').setScale(S).setDepth(2450).setFlipX(dir < 0).play({ key: 'bird', startFrame: i % 3 });
        if (crows || dark) b.setTint(0x2a2430);
        this.tweens.add({ targets: b, x: b.x + dir * (WORLD_W + 80), y: b.y - 20 + Math.random() * 30, duration: 9000 + Math.random() * 3000, onComplete: () => b.destroy() });
      }
      if (Math.random() < 0.6) bridge.events.sound('chirp');
      this.time.delayedCall(9000 + Math.random() * 14000, () => this.birds(dark));
    }

    // ───── time of day, season & weather ─────
    phase(): DayPhase {
      return dayPhase(this.hour());
    }
    setupEnv() {
      // a translucent wash rather than a MULTIPLY blend: it looks the same on WebGL and Canvas renderers
      this.shade = this.add.rectangle(0, 0, WORLD_W, WORLD_H, 0x000000, 0).setOrigin(0, 0).setDepth(2500);
      this.applyTime();
      this.time.addEvent({ delay: 30000, loop: true, callback: () => { this.applyTime(); this.syncAll(bridge.model); } });
      this.setWeather(bridge.weather);
    }
    applyTime() {
      const ph = this.phase();
      const outdoor = OUTDOOR.has(this.key);
      const wash: Record<DayPhase, [number, number]> = { dawn: [0xffb070, 0.1], day: [0x000000, 0], dusk: [0xff7a3a, 0.14], night: outdoor ? [0x101838, 0.52] : [0x141a36, 0.4] };
      let [c, a] = wash[ph];
      if (bridge.weather === 'rain' || bridge.weather === 'snow') {
        // overcast: blend toward slate grey
        const g = outdoor ? 0.22 : 0.1;
        c = a ? mix(c, 0x3a4250, g / (a + g)) : 0x3a4250;
        a = Math.min(0.6, a + g);
      }
      this.shade.setFillStyle(c, a).setVisible(a > 0);
      for (const g of this.glows) {
        const on = ph === 'night' || ph === 'dusk';
        this.tweens.killTweensOf(g.img);
        g.img.setAlpha(on ? 0.5 : ph === 'dawn' ? 0.2 : 0);
        if (on) this.tweens.add({ targets: g.img, alpha: 0.35, duration: 700 + Math.random() * 500, yoyo: true, repeat: -1 });
      }
      this.festival = festivalOf(this.now());
      this.applyLanterns();
      this.refreshNpcs();
      (this as any).onTime?.(ph);
    }
    setWeather(w: Weather) {
      bridge.weather = w;
      this.weatherFx?.destroy();
      this.weatherFx = null;
      this.seasonFx?.destroy();
      this.seasonFx = null;
      if (this.shade) this.applyTime();
      if (!OUTDOOR.has(this.key)) return;
      if (w === 'clear') return void this.seasonal();
      const cfg: Record<Exclude<Weather, 'clear'>, any> = {
        rain: { speedY: { min: 300, max: 380 }, speedX: { min: -50, max: -30 }, lifespan: 1300, frequency: 8, quantity: 3, alpha: 0.75, scale: S },
        snow: { speedY: { min: 14, max: 32 }, speedX: { min: -12, max: 12 }, lifespan: 16000, frequency: 70, quantity: 1, alpha: { min: 0.7, max: 1 }, scale: { min: S * 0.75, max: S * 1.25 } },
        petals: { speedY: { min: 12, max: 26 }, speedX: { min: 8, max: 30 }, lifespan: 18000, frequency: 220, quantity: 1, rotate: { min: 0, max: 360 }, alpha: 0.95, scale: S },
      };
      const tex = w === 'rain' ? 'rain' : w === 'snow' ? 'snow' : 'petal';
      this.weatherFx = this.add.particles(0, -12, tex, { x: { min: -40, max: WORLD_W + 40 }, ...cfg[w] }).setDepth(2400);
      this.weatherFx.fastForward?.(w === 'rain' ? 1500 : 12000);
    }
    /** on a clear day the season shows: a few petals in spring, leaves in autumn */
    seasonal() {
      const s = seasonOf(this.now());
      if (s !== 'spring' && s !== 'autumn') return;
      this.seasonFx = this.add.particles(0, -12, 'petal', {
        x: { min: -40, max: WORLD_W + 40 }, speedY: { min: 10, max: 22 }, speedX: { min: 6, max: 26 }, lifespan: 20000, frequency: 1400, quantity: 1,
        rotate: { min: 0, max: 360 }, alpha: 0.9, scale: S, tint: s === 'autumn' ? [0xd08a3a, 0xb8562a, 0xe0b048] : undefined,
      }).setDepth(2400);
      this.seasonFx.fastForward?.(15000);
    }
  }

  return [Boot, ...makeHalls(P, bridge, Base)];
}

/** the door nearest to a point */
function nearestDoor(scene: any, x: number, y: number): SceneKey | null {
  const d = scene.spots.doors as Record<string, number[]> | undefined;
  if (!d) return null;
  let best: SceneKey | null = null;
  let bd = Infinity;
  for (const [k, [dx, dy, w, h]] of Object.entries(d)) {
    const dist = Math.hypot(dx + w / 2 - x, dy + h / 2 - y);
    if (dist < bd) { bd = dist; best = k as SceneKey; }
  }
  return best;
}

/** twinkling stars over the open sky at night (replaces the previous set) */
export function starField(scene: any, old: any[], ph: DayPhase, maxY: number) {
  old.forEach((s) => s.destroy());
  if (ph !== 'night') return [];
  const out: any[] = [];
  for (let i = 0; i < 26; i++) {
    const s = scene.add.rectangle(Math.round(Math.random() * WORLD_W), Math.round(4 + Math.random() * maxY), 1, 1, 0xfff6d0).setOrigin(0, 0).setDepth(2550);
    scene.tweens.add({ targets: s, alpha: { from: 1, to: 0.3 }, duration: 800 + Math.random() * 1600, yoyo: true, repeat: -1, delay: Math.random() * 1000 });
    out.push(s);
  }
  return out;
}

/** linear mix of two 0xRRGGBB colours (t = 0 → a, 1 → b) */
export function mix(a: number, b: number, t: number) {
  const ch = (s: number) => Math.round(((a >> s) & 255) * (1 - t) + ((b >> s) & 255) * t);
  return (ch(16) << 16) | (ch(8) << 8) | ch(0);
}
