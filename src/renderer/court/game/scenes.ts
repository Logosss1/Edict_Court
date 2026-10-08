// Phaser 3 scenes for the pixel court. Art is drawn at 2× detail (1280×720 backgrounds, 64×96
// officials) and shown at half scale through a ×2 camera, so all game logic keeps using the
// 640×360 world. Everything here is a projection of the runtime: the only things the user can
// change from the court are UI state (dialogs, panels, scenes) and the existing 朱批 API.
import type { AgentId, RunNode, Task } from '../../../shared/types';
import { AGENT_MAP, AGENTS, KANBAN_COLUMNS, STATE_LABEL, TERMINAL } from '../../../shared/court';
import { Official, ensureAnims, nativeText, resolveBubbles, toolAnim } from './official';
import { FONT, WORLD_W, WORLD_H, DETAIL, courtSig, type CourtEvents, type CourtModel, type SceneKey, type Weather } from './model';

export interface Bridge {
  model: CourtModel;
  events: CourtEvents;
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
}

const A = '../assets/pixel';
const S = 1 / DETAIL; // display scale for 2× art
const SCENE_KEYS: SceneKey[] = ['taihe', 'junjichu', 'liubu', 'chengtian'];
const SCENE_NAME: Record<SceneKey, string> = { taihe: '太和殿', junjichu: '军机处值房', liubu: '六部值房', chengtian: '承天门' };
const CHAR_KEYS = ['emperor', 'taizi', 'zhongshu', 'menxia', 'shangshu', 'hubu', 'libu', 'bingbu', 'xingbu', 'gongbu', 'libu_hr', 'zaochao', 'solo', 'guard', 'lady', 'clerk'];
const MINISTRY_PROPS = ['hubu', 'libu', 'bingbu', 'xingbu', 'gongbu', 'libu_hr'];
const PROPS = ['desk', 'scroll', 'fan', 'seal', 'cloud', 'cloud2', 'ring', 'glow', 'rain', 'snow', 'petal',
  'zhezi_pending', 'zhezi_taizi', 'zhezi_zhongshu', 'zhezi_menxia', 'zhezi_assigned', 'zhezi_doing', 'zhezi_review', 'zhezi_done', 'zhezi_blocked', 'zhezi_cancelled',
  ...MINISTRY_PROPS.map((m) => `dept_${m}`)];
const SHEETS: [string, number, number][] = [['lantern', 32, 72], ['flame', 8, 12], ['smoke', 24, 48], ['flag', 40, 64], ['cat', 32, 24], ['bird', 16, 12]];

/** where the emperor may walk (world units) */
const WALK: Record<SceneKey, { x0: number; x1: number; y0: number; y1: number }> = {
  taihe: { x0: 24, x1: 616, y0: 180, y1: 352 },
  junjichu: { x0: 20, x1: 620, y0: 238, y1: 352 },
  liubu: { x0: 12, x1: 628, y0: 262, y1: 352 },
  chengtian: { x0: 12, x1: 628, y0: 252, y1: 352 },
};
/** windows through which weather is visible indoors */
const WINDOWS: Partial<Record<SceneKey, number[][]>> = { taihe: [[22, 59, 98, 75], [520, 59, 98, 75]], liubu: [[20, 65, 70, 150]] };
const THRONE = { x: 320, y: 118, foot: 182 };

const txt = (scene: any, x: number, y: number, s: string, o: Record<string, unknown> = {}) =>
  scene.add.text(Math.round(x), Math.round(y), s, { fontFamily: FONT, fontSize: '12px', color: '#f4e6c4', resolution: 2, ...o });
const img = (scene: any, x: number, y: number, key: string) => scene.add.image(Math.round(x), Math.round(y), key).setScale(S);

function snippetFor(model: CourtModel, id: string): string | undefined {
  const a = model.lastActivity[id];
  if (!a) return undefined;
  if (a.kind === 'thinking' || a.kind === 'text') return a.content.slice(-60);
  if (a.kind === 'tool_call') return `⚙ ${a.content}`;
  return undefined;
}
function toolFor(model: CourtModel, id: string): string | undefined {
  const a = model.lastActivity[id];
  return a?.kind === 'tool_call' ? String((a.data as { name?: string } | undefined)?.name ?? a.content) : undefined;
}

function zheziKey(t: Task) {
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

// ───────────────────────── 奏折回放: a finished task's journey, rebuilt from its records ─────────────────────────
export interface ReplayStep { actor: string; anim: string; text: string; title: string }
const NAME_TO_ID: Record<string, string> = Object.fromEntries(AGENTS.flatMap((a) => [[a.name, a.id], [a.official, a.id]]));
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
      if (!id || id === steps[steps.length - 1].actor) continue;
      steps.push({ actor: id, anim: toolAnim('', id), title: `${f.from} → ${f.to}`, text: f.remark.slice(0, 40) || '流转' });
    }
  }
  const trimmed = steps.length > 14 ? [...steps.slice(0, 12), { actor: steps[steps.length - 1].actor, anim: 'bow', title: '……', text: `另有 ${steps.length - 13} 道流转` }, steps[steps.length - 1]] : steps;
  const ender = trimmed.some((s) => s.actor === 'shangshu') ? 'shangshu' : trimmed[trimmed.length - 1].actor === 'emperor' ? 'taizi' : trimmed[trimmed.length - 1].actor;
  trimmed.push({ actor: ender, anim: 'kneel', title: '回奏', text: (t.result?.summary || STATE_LABEL[t.state] || '回奏完毕').slice(0, 40) });
  trimmed.push({ actor: 'emperor', anim: 'sit_talk', title: t.state === 'Done' ? '结案' : STATE_LABEL[t.state], text: t.state === 'Done' ? '准奏，此事办得好！' : '朕知道了' });
  return trimmed;
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
    key: SceneKey;
    spots: Record<string, any> = {};
    emperor: Official | null = null;
    shade: any = null;
    glows: { img: any; night: boolean }[] = [];
    weatherFx: any = null;
    weatherMask: any = null;
    hint: any = null;
    near: Official | null = null;
    doorArmed = false;
    walking = 0; // token for click-to-walk
    idleTick = 0;
    lanterns: { spr: any; glow: any; id: string }[] = [];
    seatSig = '';
    constructor(key: SceneKey) {
      super(key);
      this.key = key;
    }
    create() {
      this.cameras.main.setZoom(DETAIL).centerOn(WORLD_W / 2, WORLD_H / 2);
      this.officials = new Map();
      this.extras = [];
      this.glows = [];
      this.lanterns = [];
      this.weatherFx = null;
      this.hint = null;
      this.near = null;
      this.spots = this.cache.json.get(`spots_${this.key}`)?.spots ?? {};
      img(this, 0, 0, `bg_${this.key}`).setOrigin(0, 0).setDepth(-10);
      this.build();
      this.applyLayout();
      this.doors();
      this.ambient();
      this.spawnEmperor();
      this.setupEnv();
      this.input.on('pointerdown', (p: any, over: any[]) => this.onFloor(p, over));
      bridge.current = this;
      bridge.events.sceneChanged(this.key);
      this.cameras.main.fadeIn(220, 20, 12, 10);
      this.syncAll(bridge.model);
      this.events.once('shutdown', () => {
        if (bridge.current === this) bridge.current = null;
        this.officials.forEach((o) => o.destroy());
        this.extras.forEach((o) => o.destroy());
        this.emperor?.destroy();
        this.emperor = null;
      });
    }
    build() {}
    sync(_m: CourtModel) {}
    /** model update: rebuild when the 朝堂布局 changed, else let the scene sync, then the layout's seats */
    syncAll(m: CourtModel) {
      if (courtSig(m.court) !== this.seatSig) {
        if (!(this as any).busy) this.scene.restart();
        return;
      }
      this.sync(m);
      if (this.key === 'taihe') return; // 太和殿 already drives every official
      for (const [key, o] of this.officials) {
        if (!o.seat) continue;
        const id = key.split('#')[0];
        o.applyStatus(m.agents[id], snippetFor(m, id), toolFor(m, id));
      }
    }

    /** place the chosen design's roles where its 朝堂布局 says (replacing the built-in seating if asked) */
    applyLayout() {
      const c = bridge.model.court;
      this.seatSig = courtSig(c);
      if (!c) return;
      if (c.layout.hideBuiltin) {
        this.officials.forEach((o) => o.destroy());
        this.officials.clear();
      }
      for (const s of c.layout.seats) {
        if (s.scene !== this.key) continue;
        const r = c.roles[s.role];
        if (!r) continue;
        // a role takes over its avatar's built-in spot; a second role with the same avatar gets its own key
        let key: string = r.avatar;
        if (this.officials.get(key)?.seat) key = `${r.avatar}#${s.role}`;
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
      const home = (this as any).home as Map<string, [number, number]> | undefined;
      if (home) {
        home.clear();
        for (const [id, o] of this.officials) home.set(id, [o.x, o.y]);
      }
    }
    ambient() {}

    addOfficial(id: string, x: number, y: number, facing: 'front' | 'left' | 'right' | 'back', label?: string, key?: string) {
      const meta = AGENT_MAP[id as AgentId];
      const o = new Official(this, key ?? id, x, y, {
        facing, role: id, label: label ?? meta?.name ?? id, color: meta ? '#f4e6c4' : '#f2d27a',
        onClick: meta ? (me) => bridge.events.agentMenu(id as AgentId, me.x, me.y - 48) : undefined,
        onHover: meta ? (me, over) => bridge.events.hoverAgent(over ? { id: id as AgentId, x: me.x, y: me.y - 48 } : null) : undefined,
      });
      this.officials.set(id, o);
      return o;
    }
    extra(key: string, x: number, y: number, facing: 'front' | 'left' | 'right' | 'back' = 'front', seated = false) {
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
      z.on('pointerdown', (p: any) => { p?.event?.stopPropagation?.(); onClick(); });
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
    spawnEmperor() {
      const from = bridge.arrivedFrom;
      bridge.arrivedFrom = null;
      const door = from ? (this.spots.doors?.[from] as number[] | undefined) : undefined;
      const w = WALK[this.key];
      if (this.key === 'taihe' && !door) {
        this.emperor = new Official(this, 'emperor', THRONE.x, THRONE.y, { facing: 'front', seated: true, label: '皇上', color: '#f2d27a', onClick: () => this.clickEmperor() });
        this.emperor.sprite.setDepth(THRONE.y + 5);
        this.emperor.tag?.setDepth(THRONE.y + 6);
        return;
      }
      let x = { chengtian: 320, junjichu: 430, liubu: 520, taihe: 360 }[this.key];
      let y = { chengtian: 300, junjichu: 290, liubu: 318, taihe: 300 }[this.key];
      if (door) {
        const [dx, dy, dw, dh] = door;
        x = Math.max(w.x0 + 24, Math.min(w.x1 - 24, dx + dw / 2));
        y = Math.max(w.y0 + 8, Math.min(w.y1 - 14, dy + dh / 2));
        if (dx < 40) x = dx + dw + 22;
        if (dx + dw > WORLD_W - 40) x = dx - 22;
      }
      this.emperor = new Official(this, 'emperor', x, y, { facing: door && door[1] > WORLD_H - 40 ? 'back' : 'front', label: '皇上', color: '#f2d27a', onClick: () => this.clickEmperor() });
      this.doorArmed = false;
    }
    clickEmperor() {
      const e = this.emperor!;
      if (this.key === 'taihe') {
        if (!e.seated) return void this.backToThrone();
        const gated = bridge.model.tasks.find((t) => t.gate);
        if (gated) bridge.events.openReview(gated.id);
        else e.say('朕在此，众卿有本早奏。', 'say', 2500);
      } else e.say(['朕来看看。', '众卿辛苦了。', '诸事可还顺遂？'][Math.floor(Math.random() * 3)], 'say', 2200);
    }
    standUp(): Promise<void> {
      const e = this.emperor!;
      if (this.key !== 'taihe' || !e.seated) return Promise.resolve();
      e.seated = false;
      e.sprite.setDepth(THRONE.foot);
      return e.walkTo(THRONE.x, THRONE.foot, 500);
    }
    async backToThrone() {
      const e = this.emperor;
      if (!e || this.key !== 'taihe' || e.seated) return;
      const tok = ++this.walking;
      const d = Math.hypot(e.x - THRONE.x, e.y - THRONE.foot);
      await e.walkTo(THRONE.x, THRONE.foot, Math.max(200, d * 12));
      if (tok !== this.walking) return;
      await e.walkTo(THRONE.x, THRONE.y, 500);
      if (tok !== this.walking) return;
      e.facing = 'front';
      e.seated = true;
      e.current = '';
      e.play('idle');
      e.sprite.setDepth(THRONE.y + 5);
      e.tag?.setDepth(THRONE.y + 6);
    }
    async onFloor(p: any, over: any[]) {
      if (over.length || !this.emperor || (this as any).busy) return;
      const pt = this.cameras.main.getWorldPoint(p.x, p.y);
      const w = WALK[this.key];
      if (pt.x < w.x0 || pt.x > w.x1 || pt.y < w.y0 - 12 || pt.y > WORLD_H) return;
      const tx = Math.max(w.x0, Math.min(w.x1, pt.x));
      const ty = Math.max(w.y0, Math.min(w.y1, pt.y));
      const tok = ++this.walking;
      await this.standUp();
      if (tok !== this.walking || !this.emperor) return;
      const e = this.emperor;
      const ms = Math.max(160, Math.hypot(tx - e.x, ty - e.y) * 14);
      await e.walkTo(tx, ty, ms);
      if (tok !== this.walking) return;
      e.play('idle');
    }
    /** Space: summon the official the emperor stands next to (or speak from the throne) */
    action(code: string) {
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
          if (this.key === 'taihe' && e.seated) {
            void this.standUp();
          } else if (!this.tweens.isTweening(e.sprite)) {
            const v = (72 * dt) / 1000 / (dx && dy ? Math.SQRT2 : 1);
            const w = WALK[this.key];
            dx = Math.max(w.x0, Math.min(w.x1, e.x + dx * v)) - e.x;
            dy = Math.max(w.y0, Math.min(w.y1, e.y + dy * v)) - e.y;
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
      }
      if ((this.idleTick += dt) > 600) {
        this.idleTick = 0;
        for (const [id, o] of this.officials) {
          const a = bridge.model.agents[id];
          if (!o.frozen && (!a || a.status === 'idle')) o.applyStatus(a, undefined);
        }
        for (const o of this.extras) if (o.key === 'lady' || o.key === 'clerk') o.idle();
      }
    }
    updateNear() {
      const e = this.emperor!;
      let best: Official | null = null;
      let bd = 34;
      if (!e.seated) {
        for (const [id, o] of this.officials) {
          if (!AGENT_MAP[id as AgentId]) continue;
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

    // ───── reward / scold (animation only) ─────
    react(id: string, kind: 'reward' | 'scold' | 'urge') {
      const o = this.officials.get(id);
      if (!o || o.frozen) return false;
      if (kind === 'urge') {
        o.playFor('bow', 1400);
        o.say('臣遵旨，即刻去办！', 'say', 2200);
        this.floatText(o.x, o.y - 56, '催办', '#f4e6c4');
        bridge.events.sound('chime');
      } else if (kind === 'reward') {
        o.playFor('joy', 2400);
        this.time.delayedCall(2400, () => o.playFor('bow', 1300));
        o.say('谢主隆恩！', 'say', 2400);
        this.floatText(o.x, o.y - 56, '恩赏 +1', '#f2d27a');
        for (let i = 0; i < 6; i++) {
          const c = img(this, o.x + (i - 2.5) * 6, o.y - 60, 'seal').setDepth(4700).setTint(0xf2d27a).setScale(S * 0.5);
          this.tweens.add({ targets: c, y: o.y - 8, x: c.x + (Math.random() - 0.5) * 18, alpha: 0, duration: 900 + i * 90, ease: 'Quad.easeIn', onComplete: () => c.destroy() });
        }
        bridge.events.sound('chime');
      } else {
        o.playFor('fear', 2000);
        this.time.delayedCall(2000, () => o.playFor('bow', 1300));
        o.say('臣知罪，必当尽心！', 'alert', 2400);
        this.floatText(o.x, o.y - 56, '训诫', '#e0604a');
        this.cameras.main.shake(160, 0.003);
        bridge.events.sound('gong');
      }
      return true;
    }
    floatText(x: number, y: number, s: string, color: string) {
      const t = txt(this, x, y, s, { color, stroke: '#1a1220', strokeThickness: 3 }).setOrigin(0.5, 1).setDepth(5200);
      this.tweens.add({ targets: t, y: y - 18, alpha: 0, duration: 1500, ease: 'Quad.easeOut', onComplete: () => t.destroy() });
    }

    // ───── ambient helpers ─────
    flame(x: number, y: number) {
      this.add.sprite(Math.round(x), Math.round(y), 'flame').setScale(S).setOrigin(0.5, 1).setDepth(y + 1).play({ key: 'flame', startFrame: Math.floor(Math.random() * 3) });
      const g = img(this, x, y - 3, 'glow').setDepth(2600).setBlendMode(P.BlendModes.ADD).setScale(S * 0.45).setAlpha(0);
      this.glows.push({ img: g, night: true });
    }
    smoke(x: number, y: number, alpha = 0.5) {
      const s = this.add.sprite(Math.round(x), Math.round(y), 'smoke').setScale(S).setOrigin(0.5, 1).setDepth(y + 2).setAlpha(alpha).play('smoke');
      return s;
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
      return bridge.lit[id] ?? (this.phase() === 'night' || this.phase() === 'dusk');
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
    /** a cat that wanders between points, sits, and jumps when poked */
    cat(points: number[][], depth?: number) {
      const [sx, sy] = points[0];
      const c = this.add.sprite(sx, sy, 'cat', 4).setScale(S).setOrigin(0.5, 1).setDepth(depth ?? sy).setInteractive({ useHandCursor: true, pixelPerfect: true });
      c.play('cat_sit');
      let busy = false;
      const wander = () => {
        if (!c.active) return;
        if (busy) return void this.time.delayedCall(2000, wander);
        const [tx, ty] = points[Math.floor(Math.random() * points.length)];
        const d = Math.hypot(tx - c.x, ty - c.y);
        if (d < 4) return void this.time.delayedCall(3000, wander);
        c.setFlipX(tx < c.x);
        c.play('cat_walk');
        this.tweens.add({ targets: c, x: tx, y: ty, duration: d * 45, onUpdate: () => depth ?? c.setDepth(c.y), onComplete: () => {
          c.play('cat_sit');
          this.time.delayedCall(5000 + Math.random() * 9000, wander);
        } });
      };
      this.time.delayedCall(3000 + Math.random() * 4000, wander);
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
    birds() {
      if (this.phase() === 'night' || bridge.weather === 'rain') return void this.time.delayedCall(15000, () => this.birds());
      const dir = Math.random() < 0.5 ? 1 : -1;
      const y0 = 18 + Math.random() * 70;
      const n = 3 + Math.floor(Math.random() * 3);
      for (let i = 0; i < n; i++) {
        const b = this.add.sprite(dir > 0 ? -20 - i * 14 : WORLD_W + 20 + i * 14, y0 + (i % 2) * 7 + i * 2, 'bird').setScale(S).setDepth(-4).setFlipX(dir < 0).play({ key: 'bird', startFrame: i % 3 });
        this.tweens.add({ targets: b, x: b.x + dir * (WORLD_W + 80), y: b.y - 20 + Math.random() * 30, duration: 9000 + Math.random() * 3000, onComplete: () => b.destroy() });
      }
      if (Math.random() < 0.6) bridge.events.sound('chirp');
      this.time.delayedCall(9000 + Math.random() * 14000, () => this.birds());
    }

    // ───── time of day & weather ─────
    phase(): DayPhase {
      const d = new Date();
      return dayPhase(bridge.hourOverride ?? d.getHours() + d.getMinutes() / 60);
    }
    setupEnv() {
      // a translucent wash rather than a MULTIPLY blend: it looks the same on WebGL and Canvas renderers
      this.shade = this.add.rectangle(0, 0, WORLD_W, WORLD_H, 0x000000, 0).setOrigin(0, 0).setDepth(2500);
      this.applyTime();
      this.time.addEvent({ delay: 30000, loop: true, callback: () => this.applyTime() });
      this.setWeather(bridge.weather);
    }
    applyTime() {
      const ph = this.phase();
      const outdoor = this.key === 'chengtian';
      const wash: Record<DayPhase, [number, number]> = { dawn: [0xffb070, 0.1], day: [0x000000, 0], dusk: [0xff7a3a, 0.14], night: outdoor ? [0x101838, 0.5] : [0x141a36, 0.34] };
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
      this.applyLanterns();
      (this as any).onTime?.(ph);
    }
    setWeather(w: Weather) {
      bridge.weather = w;
      this.weatherFx?.destroy();
      this.weatherFx = null;
      this.weatherMask?.destroy();
      this.weatherMask = null;
      if (this.shade) this.applyTime();
      if (w === 'clear') return;
      const windows = WINDOWS[this.key];
      if (this.key !== 'chengtian' && !windows) return;
      const cfg: Record<Exclude<Weather, 'clear'>, any> = {
        rain: { speedY: { min: 300, max: 380 }, speedX: { min: -50, max: -30 }, lifespan: 1300, frequency: 8, quantity: 3, alpha: 0.75, scale: S },
        snow: { speedY: { min: 14, max: 32 }, speedX: { min: -12, max: 12 }, lifespan: 16000, frequency: 70, quantity: 1, alpha: { min: 0.7, max: 1 }, scale: { min: S * 0.75, max: S * 1.25 } },
        petals: { speedY: { min: 12, max: 26 }, speedX: { min: 8, max: 30 }, lifespan: 18000, frequency: 220, quantity: 1, rotate: { min: 0, max: 360 }, alpha: 0.95, scale: S },
      };
      const tex = w === 'rain' ? 'rain' : w === 'snow' ? 'snow' : 'petal';
      this.weatherFx = this.add.particles(0, -12, tex, { x: { min: -40, max: WORLD_W + 40 }, ...cfg[w] }).setDepth(2400);
      this.weatherFx.fastForward?.(w === 'rain' ? 1500 : 12000);
      if (this.key !== 'chengtian' && windows) {
        const g = this.make.graphics({ add: false });
        g.fillStyle(0xffffff);
        for (const [x, y, ww, hh] of windows) g.fillRect(x, y, ww, hh);
        this.weatherMask = g;
        this.weatherFx.setMask(g.createGeometryMask());
      }
    }
  }

  // ───────────────────────── 太和殿 ─────────────────────────
  class Taihe extends Base {
    presenter: Official | null = null;
    presenterTask: string | null = null;
    petitioner: Official | null = null;
    petitionId: string | null = null;
    scrollIcon: any = null;
    replay: { steps: ReplayStep[]; caption: any; skip: any; scroll: any; stop: boolean } | null = null;
    home = new Map<string, [number, number]>();
    constructor() {
      super('taihe');
    }
    build() {
      this.presenter = null;
      this.presenterTask = null;
      this.petitioner = null;
      this.petitionId = null;
      this.scrollIcon = null;
      this.replay = null;
      this.home = new Map();
      const s = { fans: [[290, 122], [350, 122]], guards: [[224, 192], [416, 192], [96, 330], [544, 330]], west: [[250, 226], [196, 226], [250, 280], [196, 280], [250, 334]], east: [[390, 226], [444, 226], [390, 280], [444, 280], [390, 334], [444, 334]], prince: [262, 152] };
      for (const [x, y] of s.fans) {
        img(this, x, y - 30, 'fan').setOrigin(0.5, 1).setDepth(y - 30);
        this.extra('lady', x, y).sprite.setDepth(y - 20);
      }
      s.guards.forEach(([x, y]) => this.extra('guard', x, y));
      const east: AgentId[] = ['zhongshu', 'menxia', 'shangshu', 'libu', 'hubu', 'libu_hr'];
      const west: AgentId[] = ['bingbu', 'xingbu', 'gongbu', 'zaochao', 'solo'];
      east.forEach((id, i) => this.addOfficial(id, s.east[i][0], s.east[i][1], 'left'));
      west.forEach((id, i) => this.addOfficial(id, s.west[i][0], s.west[i][1], 'right'));
      this.addOfficial('taizi', s.prince[0], s.prince[1], 'front', '太子');
      for (const [id, o] of this.officials) this.home.set(id, [o.x, o.y]);
      // 御案 (the throne table) opens the memorial archive
      const [dx, dy] = this.spots.desk ?? [320, 112];
      this.hotspot(dx - 30, dy + 4, 60, 10, '御案 · 奏折阁', () => bridge.events.openPanel('memorials'), 7);
      txt(this, 320, 352, '太 和 殿', { color: '#f2d27a', stroke: '#1a1220', strokeThickness: 3 }).setOrigin(0.5, 1).setDepth(9000);
    }
    ambient() {
      for (const [x, y] of this.spots.lamps ?? []) this.flame(x, y);
      for (const [x, y] of this.spots.incense ?? []) this.burner(x, y);
      (this.spots.lanterns ?? []).forEach(([x, y]: number[], i: number) => this.lantern(x, y, i));
      if (bridge.pendingReplay) {
        const id = bridge.pendingReplay;
        bridge.pendingReplay = null;
        this.time.delayedCall(400, () => this.startReplay(id));
      }
    }
    sync(m: CourtModel) {
      const d = m.debate;
      const speaking = d?.speaking;
      for (const [key, o] of this.officials) {
        if (o.frozen) continue;
        const id = key.split('#')[0];
        const a = m.agents[id];
        if (d && d.participants.includes(id as AgentId) && d.status !== 'concluded') {
          if (speaking === id) {
            const msg = [...d.messages].reverse().find((x) => x.speaker === id);
            o.play('talk');
            o.say(msg?.content || '…', 'say');
          } else {
            const lastAny = [...d.messages].reverse().find((x) => x.kind === 'official' && x.content);
            const last = lastAny && lastAny.speaker === id ? lastAny : undefined;
            if (!speaking && last && Date.now() - last.at < 12000 && !a?.status?.match(/thinking|writing/)) {
              o.play('idle');
              o.say(last.content, 'say', 1500);
            } else o.applyStatus(a, snippetFor(m, id), toolFor(m, id));
          }
          continue;
        }
        if (id === 'menxia') {
          const recent = m.tasks.flatMap((t) => t.reviews.filter((r) => r.reviewer === 'menxia' && Date.now() - r.at < 6000));
          const rej = recent.find((r) => r.verdict === 'reject');
          if (rej && (!a || a.status === 'idle')) {
            o.play('reject');
            o.say(`封驳！${rej.comment}`.slice(0, 40), 'alert', 1200);
            continue;
          }
          if (recent.length && (!a || a.status === 'idle')) {
            o.play('seal');
            o.say('准奏，用印。', 'say', 1200);
            continue;
          }
        }
        o.applyStatus(a, snippetFor(m, id), toolFor(m, id));
      }
      // the emperor's own words
      const emp = this.emperor;
      if (emp && !this.replay) {
        if (m.emperorSaid && Date.now() - m.emperorSaid.at < 9000) {
          emp.play('talk');
          emp.say(m.emperorSaid.text, 'say');
        } else if (d?.pendingInterjections.length) {
          const em = d.messages.find((x) => x.id === d.pendingInterjections[d.pendingInterjections.length - 1]);
          emp.play('talk');
          emp.say(em?.content ?? '', 'say');
        } else {
          if (emp.current === 'sit_talk' || emp.current === 'talk') {
            emp.current = '';
            emp.play('idle');
          }
          emp.clearBubble();
        }
      }
      // memorial presenter (gates)
      const gated = m.tasks.filter((t) => t.gate && !TERMINAL.includes(t.state));
      const first = gated[0];
      if (first && this.presenterTask !== first.id && !this.replay) {
        this.presenter?.destroy();
        this.scrollIcon?.destroy();
        const who = first.gate!.kind === 'final' ? 'shangshu' : first.gate!.kind === 'budget' ? 'hubu' : 'menxia';
        this.presenterTask = first.id;
        this.presenter = new Official(this, who, 320, 352, { facing: 'back', role: who, onClick: () => bridge.events.openReview(first.id) });
        void this.presenter.walkTo(320, 240, 1100).then(() => {
          if (!this.presenter) return;
          this.presenter.facing = 'front';
          this.presenter.playFor('present', 1600);
          this.time.delayedCall(1600, () => this.presenter?.play('kneel'));
          this.scrollIcon = img(this, 320, 198, 'scroll').setDepth(6000).setInteractive({ useHandCursor: true }).on('pointerdown', () => bridge.events.openReview(first.id));
          this.tweens.add({ targets: this.scrollIcon, y: 194, duration: 600, yoyo: true, repeat: -1 });
        });
      } else if (!first && this.presenter) {
        this.presenter.destroy();
        this.scrollIcon?.destroy();
        this.presenter = null;
        this.scrollIcon = null;
        this.presenterTask = null;
      }
      if (this.presenter && first) {
        const label = first.gate!.kind === 'plan' ? '中书方案已审，请御览' : first.gate!.kind === 'final' ? '回奏已至，请御批' : first.gate!.kind === 'budget' ? '用度超支，请示下' : '封驳逾限，请圣裁';
        this.presenter.say(`${label}${gated.length > 1 ? `（共${gated.length}本）` : ''}`, 'alert');
      }
      // high-risk petitions
      const ap = m.approvals.find((x) => x.status === 'pending');
      if (ap && this.petitionId !== ap.id) {
        this.petitioner?.destroy();
        this.petitionId = ap.id;
        const who = ap.agentId in AGENT_MAP && ap.agentId !== 'solo' ? ap.agentId : 'clerk';
        this.petitioner = new Official(this, who, 372, 262, { facing: 'front', role: who, onClick: () => bridge.events.clickApproval(ap.id) });
        this.petitioner.play('kneel');
        this.petitioner.say(`${ap.risk === 'high' ? '⚠ ' : ''}请旨：${ap.summary}`, 'alert');
      } else if (!ap && this.petitioner) {
        this.petitioner.destroy();
        this.petitioner = null;
        this.petitionId = null;
      }
      this.bubbles();
    }
    bubbles() {
      resolveBubbles([...this.officials.values(), ...(this.emperor ? [this.emperor] : []), ...(this.presenter ? [this.presenter] : []), ...(this.petitioner ? [this.petitioner] : [])]);
    }

    // ───── 奏折回放 ─────
    async startReplay(taskId: string) {
      const t = bridge.model.tasks.find((x) => x.id === taskId);
      if (!t) return;
      this.stopReplay(true);
      const steps = replaySteps(t);
      const caption = nativeText(this, 320, 5, '', { color: '#f2d27a', backgroundColor: '#2a1a14', padding: { x: 8, y: 3 } }).setOrigin(0.5, 0).setDepth(9600);
      const skip = nativeText(this, 634, 5, '结束回放 ✕', { color: '#f4e6c4', backgroundColor: '#6e1a1c', padding: { x: 6, y: 3 } }).setOrigin(1, 0).setDepth(9600).setInteractive({ useHandCursor: true });
      skip.on('pointerdown', (p: any) => { p?.event?.stopPropagation?.(); this.stopReplay(); });
      const scroll = img(this, THRONE.x, THRONE.y - 20, 'scroll').setDepth(6100);
      this.replay = { steps, caption, skip, scroll, stop: false };
      (this as any).busy = true;
      for (const o of this.officials.values()) { o.frozen = true; o.clearBubble(true); o.setMark(null); o.play('idle'); }
      const emp = this.emperor!;
      if (!emp.seated) { emp.destroy(); this.emperor = null; this.spawnEmperorOnThrone(); }
      bridge.events.sound('bell');
      const at = (id: string): Official | null => (id === 'emperor' ? this.emperor : this.officials.get(id) ?? null);
      for (let i = 0; i < steps.length; i++) {
        const r = this.replay;
        if (!r || r.stop) return;
        const st = steps[i];
        r.caption.setText(`奏折回放 · ${t.title.slice(0, 12)}　${i + 1}/${steps.length}　${st.title}`);
        const o = at(st.actor);
        if (!o) continue;
        const [hx, hy] = st.actor === 'emperor' ? [THRONE.x, THRONE.y] : this.home.get(st.actor) ?? [o.x, o.y];
        // the memorial travels to whoever handles it next
        this.tweens.add({ targets: r.scroll, x: o.x, y: o.y - 54, duration: 520, ease: 'Sine.easeInOut' });
        if (st.actor !== 'emperor') {
          const fx = hx + (320 - hx) * 0.35;
          const fy = hy + (st.anim === 'kneel' ? 0 : -4);
          await o.walkTo(st.anim === 'kneel' ? 320 : fx, st.anim === 'kneel' ? 236 : fy, st.anim === 'kneel' ? 900 : 420);
          if (!this.replay || this.replay.stop) return;
          o.facing = st.anim === 'kneel' ? 'back' : 'front';
        }
        o.current = '';
        o.play(st.anim);
        o.say(st.text, st.anim === 'reject' ? 'alert' : 'say');
        this.bubbles();
        await this.wait(st.anim === 'kneel' ? 2000 : 1500);
        if (!this.replay || this.replay.stop) return;
        o.clearBubble(true);
        if (st.actor !== 'emperor') {
          await o.walkTo(hx, hy, st.anim === 'kneel' ? 800 : 380);
          o.facing = o.homeFacing ?? ((this.home.get(st.actor)?.[0] ?? 320) < 320 ? 'right' : 'left');
          if (st.actor === 'taizi' && !o.homeFacing) o.facing = 'front';
          o.current = '';
          o.play('idle');
        } else {
          o.current = '';
          o.play('idle');
        }
      }
      for (const o of this.officials.values()) o.playFor('bow', 1500);
      this.floatText(320, 70, '结 案', '#f2d27a');
      bridge.events.sound('gong');
      await this.wait(1600);
      this.stopReplay();
    }
    spawnEmperorOnThrone() {
      this.emperor = new Official(this, 'emperor', THRONE.x, THRONE.y, { facing: 'front', seated: true, label: '皇上', color: '#f2d27a', onClick: () => this.clickEmperor() });
      this.emperor.sprite.setDepth(THRONE.y + 5);
      this.emperor.tag?.setDepth(THRONE.y + 6);
    }
    wait(ms: number) {
      return new Promise<void>((res) => this.time.delayedCall(ms, res));
    }
    stopReplay(silent = false) {
      const r = this.replay;
      if (!r) return;
      r.stop = true;
      r.caption.destroy();
      r.skip.destroy();
      r.scroll.destroy();
      this.replay = null;
      (this as any).busy = false;
      for (const [id, o] of this.officials) {
        this.tweens.killTweensOf(o.sprite);
        const h = this.home.get(id);
        if (h) o.setPos(h[0], h[1]);
        o.facing = o.homeFacing ?? (id === 'taizi' ? 'front' : (h?.[0] ?? 320) < 320 ? 'right' : 'left');
        o.frozen = false;
        o.current = '';
        o.clearBubble(true);
      }
      this.syncAll(bridge.model);
      if (!silent) bridge.events.replayDone();
    }
  }

  // ───────────────────────── 军机处值房 ─────────────────────────
  class Junjichu extends Base {
    slips = new Map<string, { img: any; label: any; col: number }>();
    chain: any[] = [];
    clerks: Official[] = [];
    constructor() {
      super('junjichu');
    }
    build() {
      this.slips = new Map();
      this.chain = [];
      this.clerks = [];
      // the whole memorial wall opens the 旨意看板 (individual slips sit on top and open their task)
      this.hotspot(15, 22, 610, 200, '折子墙 · 旨意看板', () => bridge.events.openPanel('kanban'), 4);
      KANBAN_COLUMNS.forEach((c, k) => nativeText(this, 24 + k * 74 + 37, 35, c.label, { color: '#fbf0d4', stroke: '#6e1a1c', strokeThickness: 2 }).setOrigin(0.5, 0).setDepth(10));
      [[150, 318], [330, 333], [500, 318]].forEach(([x, y]) => {
        const o = this.extra('clerk', x, y, 'front', true);
        o.play('sit_write');
        this.clerks.push(o);
        img(this, x, y + 4, 'desk').setOrigin(0.5, 1).setDepth(y + 2);
      });
      this.addOfficial('shangshu', 560, 318, 'left', '尚书令');
      txt(this, 320, 352, '军 机 处 值 房', { color: '#f2d27a', stroke: '#1a1220', strokeThickness: 3 }).setOrigin(0.5, 1).setDepth(9000);
    }
    ambient() {
      for (const [x, y] of this.spots.incense ?? []) this.burner(x, y - 14);
      (this.spots.lanterns ?? []).forEach(([x, y]: number[], i: number) => this.lantern(x, y, i));
      const [cx, cy] = this.spots.cat ?? [520, 336];
      this.cat([[cx, cy], [cx - 60, cy + 6], [cx + 40, cy - 4], [cx - 140, cy + 2]]);
    }
    colOf(t: Task) {
      return Math.max(0, KANBAN_COLUMNS.findIndex((c) => c.states.includes(t.state)));
    }
    sync(m: CourtModel) {
      const byCol = new Map<number, Task[]>();
      const sorted = [...m.tasks].sort((a, b) => b.updatedAt - a.updatedAt);
      for (const t of sorted) {
        const c = this.colOf(t);
        const arr = byCol.get(c) ?? [];
        if (arr.length < 8) arr.push(t);
        byCol.set(c, arr);
      }
      const keep = new Set<string>();
      byCol.forEach((list, col) =>
        list.forEach((t, i) => {
          keep.add(t.id);
          const x = 24 + col * 74 + 6;
          const y = 52 + i * 20;
          const title = t.title.replace(/\s+/g, '').slice(0, 4);
          let s = this.slips.get(t.id);
          if (!s) {
            const im = img(this, x, y, zheziKey(t)).setOrigin(0, 0).setDepth(20).setInteractive({ useHandCursor: true }).on('pointerdown', () => bridge.events.clickTask(t.id));
            im.on('pointerover', () => im.setTint(0xfff1c8));
            im.on('pointerout', () => im.clearTint());
            const label = txt(this, x + 17, y + 2, title, { color: '#2b2118' }).setDepth(21).setInteractive({ useHandCursor: true }).on('pointerdown', () => bridge.events.clickTask(t.id));
            s = { img: im, label, col };
            this.slips.set(t.id, s);
          } else {
            s.img.setTexture(zheziKey(t));
            s.label.setText(title);
            if (s.col !== col) {
              // the slip is carried to its new column — flow is visible
              this.tweens.add({ targets: s.img, x, y, duration: 700, ease: 'Sine.easeInOut' });
              this.tweens.add({ targets: s.label, x: x + 17, y: y + 2, duration: 700, ease: 'Sine.easeInOut' });
              const clerk = this.clerks[col % this.clerks.length];
              if (clerk && !clerk.frozen) {
                const home = { x: clerk.x, y: clerk.y };
                clerk.frozen = true;
                void clerk.walkTo(x + 20, 240, 500)
                  .then(() => { clerk.facing = 'back'; clerk.playFor('present', 600); return new Promise((r) => this.time.delayedCall(600, r)); })
                  .then(() => clerk.walkTo(home.x, home.y, 600))
                  .then(() => { clerk.facing = 'front'; clerk.seated = true; clerk.current = ''; clerk.play('sit_write'); clerk.frozen = false; });
              }
              s.col = col;
            } else {
              s.img.setPosition(x, y);
              s.label.setPosition(x + 17, y + 2);
            }
          }
          const sel = t.id === m.selectedTaskId;
          s.label.setColor(sel ? '#b3322a' : t.gate ? '#8a5a1c' : '#2b2118');
          s.img.setAlpha(t.state === 'Cancelled' ? 0.5 : 1);
        }),
      );
      for (const [id, s] of this.slips)
        if (!keep.has(id)) {
          s.img.destroy();
          s.label.destroy();
          this.slips.delete(id);
        }
      // flow chain of the selected task (流转链)
      this.chain.forEach((c) => c.destroy());
      this.chain = [];
      const sel = m.tasks.find((t) => t.id === m.selectedTaskId) ?? sorted[0];
      if (sel) {
        const steps = sel.flow.slice(-7);
        let x = 16;
        const head = txt(this, x, 226, `「${sel.title.slice(0, 10)}」${STATE_LABEL[sel.state]}：`, { color: '#f2d27a', stroke: '#1a1220', strokeThickness: 3 }).setDepth(30);
        this.chain.push(head);
        x += Math.ceil(head.width) + 4;
        for (const f of steps) {
          const seal = img(this, x, 228, 'seal').setOrigin(0, 0).setDepth(30);
          const t = txt(this, x + 14, 226, f.to, { color: '#f4e6c4', stroke: '#1a1220', strokeThickness: 3 }).setDepth(30);
          this.chain.push(seal, t);
          x += 18 + Math.ceil(t.width);
          if (x > 600) break;
        }
      }
      // clerks copy memorials while anything is in flight, otherwise they rest
      const busy = m.tasks.some((t) => !TERMINAL.includes(t.state));
      for (const c of this.clerks) if (!c.frozen) { c.seated = true; c.play(busy ? 'sit_write' : 'sit_idle'); }
      const ss = this.officials.get('shangshu');
      ss?.applyStatus(m.agents.shangshu, snippetFor(m, 'shangshu'), toolFor(m, 'shangshu'));
    }
  }

  // ───────────────────────── 六部值房 ─────────────────────────
  class Liubu extends Base {
    dept: AgentId = 'bingbu';
    plaqueText: any = null;
    prop: any = null;
    constructor() {
      super('liubu');
    }
    build() {
      this.dept = bridge.model.dept;
      this.plaqueText = txt(this, 90, 23, `${AGENT_MAP[this.dept].name}值房`, { color: '#f2d27a' }).setOrigin(0.5, 0).setDepth(10);
      this.addOfficial(this.dept, 130, 292, 'front');
      const desk = img(this, 130, 304, 'desk').setOrigin(0.5, 1).setDepth(300);
      void desk;
      this.hotspot(98, 280, 64, 24, '案几 · 本部办过的旨意', () => bridge.events.showHistory(this.dept), 320);
      const [px, py] = this.spots.deptProp ?? [250, 352];
      this.prop = img(this, px, py, `dept_${this.dept}`).setOrigin(0.5, 1).setDepth(py - 10);
      this.hotspot(px - 55, py - 70, 110, 70, '本部陈设 · 办过的旨意', () => bridge.events.showHistory(this.dept), 6);
      this.extra('clerk', 64, 330, 'right');
      txt(this, 405, 352, '六 部 值 房', { color: '#f2d27a', stroke: '#1a1220', strokeThickness: 3 }).setOrigin(0.5, 1).setDepth(9000);
    }
    sync(m: CourtModel) {
      if (m.dept !== this.dept && m.court?.layout.hideBuiltin) {
        this.dept = m.dept;
        this.plaqueText.setText(`${AGENT_MAP[this.dept].name}值房`);
        this.prop?.setTexture(`dept_${this.dept}`);
        return;
      }
      if (m.dept !== this.dept) {
        const old = this.officials.get(this.dept);
        if (old && !old.seat) {
          old.destroy();
          this.officials.delete(this.dept);
        }
        this.dept = m.dept;
        this.plaqueText.setText(`${AGENT_MAP[this.dept].name}值房`);
        this.prop?.setTexture(`dept_${this.dept}`);
        if (this.officials.get(this.dept)?.seat) return;
        const o = this.addOfficial(this.dept, 130, 360, 'front');
        o.frozen = true;
        void o.walkTo(130, 292, 700).then(() => { o.facing = 'front'; o.current = ''; o.frozen = false; o.playFor('bow', 1200); });
      }
      const own = this.officials.get(this.dept);
      if (own && !own.seat) own.applyStatus(m.agents[this.dept], snippetFor(m, this.dept), toolFor(m, this.dept));
    }
  }

  // ───────────────────────── 承天门告示区 ─────────────────────────
  class Chengtian extends Base {
    lines: any[] = [];
    playing = false;
    banner: any = null;
    stars: any[] = [];
    constructor() {
      super('chengtian');
    }
    build() {
      this.playing = false;
      this.lines = [];
      this.stars = [];
      [[196, 246], [444, 246], [274, 246], [366, 246]].forEach(([x, y]) => this.extra('guard', x, y));
      this.addOfficial('zaochao', 250, 320, 'front', '鸿胪寺卿');
      const [bx, by, bw, bh] = this.spots.board ?? [28, 204, 192, 90];
      this.hotspot(bx, by - 18, bw, bh + 18, '告示榜 · 天下要闻', () => bridge.events.openPanel('news'), 30);
      txt(this, bx + bw / 2, 188, '诏 令 告 示', { color: '#f2d27a', stroke: '#1a1220', strokeThickness: 3 }).setOrigin(0.5, 0).setDepth(50);
      txt(this, 320, 47, '承天门', { color: '#f2d27a' }).setOrigin(0.5, 0).setDepth(10);
      const [dx, dy] = this.spots.drum ?? [568, 286];
      this.hotspot(dx - 22, dy - 22, 44, 44, '登闻鼓 · 击鼓上朝', () => this.ceremony(), 55);
      const btn = txt(this, dx, dy + 32, '【击鼓上朝】', { color: '#f2d27a', stroke: '#1a1220', strokeThickness: 3 }).setOrigin(0.5, 0).setDepth(60).setInteractive({ useHandCursor: true });
      btn.on('pointerdown', (p: any) => { p?.event?.stopPropagation?.(); this.ceremony(); });
    }
    ambient() {
      for (const [x, y] of this.spots.flags ?? []) this.add.sprite(x, y, 'flag').setScale(S).setOrigin(0, 0).setDepth(y).play({ key: 'flag', startFrame: Math.floor(Math.random() * 4) });
      // a cat patrols the wall top; birds cross the sky now and then
      const wall = (this.spots.wallTop as number[][] | undefined) ?? [[0, 119], [150, 119]];
      this.cat(wall.slice(0, 2), 200);
      this.cat(wall.slice(2, 4).length ? [[wall[3][0] - 30, wall[3][1]], [wall[3][0] - 120, wall[3][1]]] : wall, 200).setVisible(Math.random() < 0.5);
      this.time.delayedCall(2500, () => this.birds());
    }
    onTime(ph: DayPhase) {
      this.stars.forEach((s) => s.destroy());
      this.stars = [];
      if (ph !== 'night') return;
      for (let i = 0; i < 26; i++) {
        const s = this.add.rectangle(Math.round(Math.random() * WORLD_W), Math.round(4 + Math.random() * 90), 1, 1, 0xfff6d0).setOrigin(0, 0).setDepth(2550);
        this.tweens.add({ targets: s, alpha: { from: 1, to: 0.3 }, duration: 800 + Math.random() * 1600, yoyo: true, repeat: -1, delay: Math.random() * 1000 });
        this.stars.push(s);
      }
    }
    sync(m: CourtModel) {
      this.lines.forEach((l) => l.destroy());
      this.lines = [];
      const [bx, by] = this.spots.board ?? [28, 204];
      const items = [...m.news.slice(0, 5)];
      items.forEach((n, i) => {
        const l = txt(this, bx + 6, by + 6 + i * 16, `· ${n.title}`.slice(0, 13), { color: i === 0 ? '#f2d27a' : '#f4e6c4' }).setDepth(40).setInteractive({ useHandCursor: true });
        l.on('pointerdown', (p: any) => { p?.event?.stopPropagation?.(); bridge.events.clickNotice(i); });
        l.on('pointerover', () => l.setColor('#ffffff'));
        l.on('pointerout', () => l.setColor(i === 0 ? '#f2d27a' : '#f4e6c4'));
        this.lines.push(l);
      });
      if (!items.length) this.lines.push(txt(this, bx + 6, by + 10, '（尚无告示）', { color: '#c4bdb0' }).setDepth(40));
      this.officials.get('zaochao')?.applyStatus(m.agents.zaochao, snippetFor(m, 'zaochao'), toolFor(m, 'zaochao'));
      if (m.ceremony && !this.playing) this.ceremony();
    }
    async ceremony() {
      if (this.playing) return;
      this.playing = true;
      (this as any).busy = true;
      bridge.events.sound('drum');
      this.cameras.main.shake(260, 0.006);
      this.banner = txt(this, 320, 110, '上  朝', { fontSize: '24px', color: '#f2d27a', stroke: '#6e1a1c', strokeThickness: 6 }).setOrigin(0.5).setDepth(9500).setAlpha(0);
      this.tweens.add({ targets: this.banner, alpha: 1, y: 100, duration: 500 });
      const sub = txt(this, 320, 132, bridge.model.totalsText, { color: '#f4e6c4', stroke: '#1a1220', strokeThickness: 3 }).setOrigin(0.5).setDepth(9500);
      const ids = ['taizi', 'zhongshu', 'menxia', 'shangshu', 'bingbu', 'libu'];
      const walkers: Official[] = [];
      ids.forEach((id, i) => {
        const o = new Official(this, id, 250 + (i % 2) * 140, 372 + Math.floor(i / 2) * 10, { facing: 'back', role: id });
        walkers.push(o);
        this.time.delayedCall(i * 260, () => {
          void o.walkTo(320 + (i % 2 ? 8 : -8), 252, 1500).then(() => this.tweens.add({ targets: o.sprite, alpha: 0, duration: 300 }));
        });
      });
      this.time.delayedCall(1200, () => bridge.events.sound('bell'));
      this.time.delayedCall(3600, () => {
        this.cameras.main.fadeOut(400, 20, 12, 10);
        this.time.delayedCall(420, () => {
          walkers.forEach((w) => w.destroy());
          sub.destroy();
          this.banner?.destroy();
          this.playing = false;
          (this as any).busy = false;
          bridge.events.ceremonyDone();
        });
      });
    }
  }

  return [Boot, Taihe, Junjichu, Liubu, Chengtian];
}

/** linear mix of two 0xRRGGBB colours (t = 0 → a, 1 → b) */
function mix(a: number, b: number, t: number) {
  const ch = (s: number) => Math.round(((a >> s) & 255) * (1 - t) + ((b >> s) & 255) * t);
  return (ch(16) << 16) | (ch(8) << 8) | ch(0);
}
