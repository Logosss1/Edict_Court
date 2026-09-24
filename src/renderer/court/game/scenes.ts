// Phaser 3 scenes for the pixel court. Nearest-neighbour, integer zoom, pixel-perfect hits.
import type { AgentId, Task } from '../../../shared/types';
import { AGENT_MAP, KANBAN_COLUMNS, STATE_LABEL, TERMINAL } from '../../../shared/court';
import { Official, ensureAnims, resolveBubbles } from './official';
import { FONT, type CourtEvents, type CourtModel, type SceneKey } from './model';

export interface Bridge {
  model: CourtModel;
  events: CourtEvents;
  current: any | null;
}

const A = '../assets/pixel';
const CHAR_KEYS = ['emperor', 'taizi', 'zhongshu', 'menxia', 'shangshu', 'hubu', 'libu', 'bingbu', 'xingbu', 'gongbu', 'libu_hr', 'zaochao', 'solo', 'guard', 'lady', 'clerk'];
const PROPS = ['desk', 'scroll', 'fan', 'notice', 'seal', 'brush', 'cloud', 'ring', 'zhezi_pending', 'zhezi_taizi', 'zhezi_zhongshu', 'zhezi_menxia', 'zhezi_assigned', 'zhezi_doing', 'zhezi_review', 'zhezi_done', 'zhezi_blocked', 'zhezi_cancelled'];

const txt = (scene: any, x: number, y: number, s: string, o: Record<string, unknown> = {}) =>
  scene.add.text(Math.round(x), Math.round(y), s, { fontFamily: FONT, fontSize: '12px', color: '#f4e6c4', resolution: 1, ...o });

function snippetFor(model: CourtModel, id: string): string | undefined {
  const a = model.lastActivity[id];
  if (!a) return undefined;
  if (a.kind === 'thinking' || a.kind === 'text') return a.content.slice(-60);
  if (a.kind === 'tool_call') return `⚙ ${a.content}`;
  return undefined;
}

function zheziKey(t: Task) {
  const s = t.state;
  const m: Record<string, string> = { Pending: 'pending', Taizi: 'taizi', Zhongshu: 'zhongshu', Menxia: 'menxia', Assigned: 'assigned', Next: 'assigned', Doing: 'doing', Review: 'review', PendingConfirm: 'review', Done: 'done', Blocked: 'blocked', Cancelled: 'cancelled' };
  return `zhezi_${m[s]}`;
}

export function makeScenes(P: any, bridge: Bridge) {
  class Boot extends P.Scene {
    constructor() {
      super('boot');
    }
    preload() {
      for (const k of CHAR_KEYS) this.load.spritesheet(k, `${A}/chars/${k}.png`, { frameWidth: 32, frameHeight: 48 });
      for (const s of ['taihe', 'junjichu', 'liubu', 'chengtian']) this.load.image(`bg_${s}`, `${A}/scenes/${s}.png`);
      for (const p of PROPS) this.load.image(p, `${A}/props/${p}.png`);
      const bar = this.add.graphics();
      this.load.on('progress', (v: number) => {
        bar.clear();
        bar.fillStyle(0xb3322a, 1);
        bar.fillRect(220, 176, Math.round(200 * v), 8);
      });
    }
    create() {
      for (const k of CHAR_KEYS) ensureAnims(this, k);
      (bridge as any).booted = true;
      const first = (bridge as any).initialScene ?? 'taihe';
      this.scene.start(first);
    }
  }

  class Base extends P.Scene {
    officials = new Map<string, Official>();
    key: SceneKey;
    constructor(key: SceneKey) {
      super(key);
      this.key = key;
    }
    create() {
      this.officials = new Map();
      this.add.image(0, 0, `bg_${this.key}`).setOrigin(0, 0).setDepth(-10);
      this.build();
      bridge.current = this;
      bridge.events.sceneChanged(this.key);
      this.cameras.main.fadeIn(220, 20, 12, 10);
      this.sync(bridge.model);
      this.events.once('shutdown', () => {
        if (bridge.current === this) bridge.current = null;
        this.officials.forEach((o) => o.destroy());
      });
    }
    build() {}
    sync(_m: CourtModel) {}
    addOfficial(id: string, x: number, y: number, facing: 'front' | 'left' | 'right' | 'back', label?: string, key?: string) {
      const meta = AGENT_MAP[id as AgentId];
      const o = new Official(this, key ?? id, x, y, { facing, label: label ?? meta?.name ?? id, color: meta ? '#f4e6c4' : '#f2d27a', onClick: meta ? () => bridge.events.clickAgent(id as AgentId) : undefined });
      this.officials.set(id, o);
      return o;
    }
  }

  // ───────────────────────── 太和殿 ─────────────────────────
  class Taihe extends Base {
    presenter: Official | null = null;
    presenterTask: string | null = null;
    petitioner: Official | null = null;
    petitionId: string | null = null;
    scrollIcon: any = null;
    constructor() {
      super('taihe');
    }
    build() {
      this.presenter = null;
      this.presenterTask = null;
      this.petitioner = null;
      this.petitionId = null;
      this.scrollIcon = null;
      const s = { emperor: [320, 118], fans: [[274, 120], [366, 120]], guards: [[214, 186], [426, 186], [112, 330], [528, 330]], west: [[250, 218], [196, 218], [250, 274], [196, 274], [250, 330]], east: [[390, 218], [444, 218], [390, 274], [444, 274], [390, 330], [444, 330]], present: [320, 236], prince: [240, 140] };
      for (const [x, y] of s.fans) {
        this.add.image(x, y - 34, 'fan').setOrigin(0.5, 1).setDepth(y - 30);
        new Official(this, 'lady', x, y, { facing: 'front' }).sprite.setDepth(y - 20);
      }
      const emp = new Official(this, 'emperor', s.emperor[0], s.emperor[1], { facing: 'front', label: '皇上', color: '#f2d27a', onClick: () => {
        const gated = bridge.model.tasks.find((t) => t.gate);
        if (gated) bridge.events.openReview(gated.id);
        else emp.say('朕在此，众卿有本早奏。', 'say', 2500);
      } });
      emp.sprite.setDepth(s.emperor[1] + 5);
      emp.tag?.setDepth(s.emperor[1] + 6);
      this.officials.set('emperor', emp);
      s.guards.forEach(([x, y]) => new Official(this, 'guard', x, y, { facing: 'front' }));
      const east: AgentId[] = ['zhongshu', 'menxia', 'shangshu', 'libu', 'hubu', 'libu_hr'];
      const west: AgentId[] = ['bingbu', 'xingbu', 'gongbu', 'zaochao', 'solo'];
      east.forEach((id, i) => this.addOfficial(id, s.east[i][0], s.east[i][1], 'left'));
      west.forEach((id, i) => this.addOfficial(id, s.west[i][0], s.west[i][1], 'right'));
      this.addOfficial('taizi', s.prince[0], s.prince[1], 'front', '太子');
      // front guards moved beside the pillars so the ranks stay readable
      txt(this, 320, 350, '太 和 殿', { color: '#f2d27a', stroke: '#1a1220', strokeThickness: 3 }).setOrigin(0.5, 1).setDepth(9000);
    }
    sync(m: CourtModel) {
      // agent statuses (debate speech overrides)
      const d = m.debate;
      const speaking = d?.speaking;
      for (const [id, o] of this.officials) {
        if (id === 'emperor') continue;
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
            } else o.applyStatus(a, snippetFor(m, id));
          }
          continue;
        }
        // 门下省 just 封驳 → reject pose
        if (id === 'menxia') {
          const rej = m.tasks.flatMap((t) => t.reviews.filter((r) => r.reviewer === 'menxia' && r.verdict === 'reject' && Date.now() - r.at < 6000));
          if (rej.length && (!a || a.status === 'idle')) {
            o.play('reject');
            o.say(`封驳！${rej[0].comment}`.slice(0, 40), 'alert', 1200);
            continue;
          }
        }
        o.applyStatus(a, snippetFor(m, id));
      }
      // emperor speech
      const emp = this.officials.get('emperor')!;
      if (m.emperorSaid && Date.now() - m.emperorSaid.at < 9000) {
        emp.play('talk');
        emp.say(m.emperorSaid.text, 'say');
      } else if (d?.pendingInterjections.length) {
        const em = d.messages.find((x) => x.id === d.pendingInterjections[d.pendingInterjections.length - 1]);
        emp.play('talk');
        emp.say(em?.content ?? '', 'say');
      } else {
        emp.play('idle');
        emp.clearBubble();
      }
      // memorial presenter (gates)
      const gated = m.tasks.filter((t) => t.gate && !TERMINAL.includes(t.state));
      const first = gated[0];
      if (first && this.presenterTask !== first.id) {
        this.presenter?.destroy();
        this.scrollIcon?.destroy();
        const who = first.gate!.kind === 'final' ? 'shangshu' : first.gate!.kind === 'budget' ? 'hubu' : 'menxia';
        this.presenterTask = first.id;
        this.presenter = new Official(this, who, 320, 340, { facing: 'back', onClick: () => bridge.events.openReview(first.id) });
        void this.presenter.walkTo(320, 236, 1100).then(() => {
          if (!this.presenter) return;
          this.presenter.play('kneel');
          this.scrollIcon = this.add.image(320, 196, 'scroll').setDepth(6000).setInteractive({ useHandCursor: true }).on('pointerdown', () => bridge.events.openReview(first.id));
          this.tweens.add({ targets: this.scrollIcon, y: 192, duration: 600, yoyo: true, repeat: -1 });
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
        this.petitioner = new Official(this, ap.agentId in AGENT_MAP && ap.agentId !== 'solo' ? ap.agentId : 'clerk', 372, 262, { facing: 'front', onClick: () => bridge.events.clickApproval(ap.id) });
        this.petitioner.play('kneel');
        this.petitioner.say(`${ap.risk === 'high' ? '⚠ ' : ''}请旨：${ap.summary}`, 'alert');
      } else if (!ap && this.petitioner) {
        this.petitioner.destroy();
        this.petitioner = null;
        this.petitionId = null;
      }
      resolveBubbles([...this.officials.values(), ...(this.presenter ? [this.presenter] : []), ...(this.petitioner ? [this.petitioner] : [])]);
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
      KANBAN_COLUMNS.forEach((c, k) => txt(this, 24 + k * 74 + 37, 32, c.label, { color: '#f2d27a' }).setOrigin(0.5, 0).setDepth(10));
      [[150, 306], [330, 322], [500, 306]].forEach(([x, y]) => {
        const o = new Official(this, 'clerk', x, y, { facing: 'front' });
        o.play('think');
        this.clerks.push(o);
        this.add.image(x - 32, y - 18, 'desk').setOrigin(0, 0).setDepth(y + 2);
      });
      this.addOfficial('shangshu', 600, 344, 'left', '尚书令');
      txt(this, 320, 350, '军 机 处 值 房', { color: '#f2d27a', stroke: '#1a1220', strokeThickness: 3 }).setOrigin(0.5, 1).setDepth(9000);
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
            const img = this.add.image(x, y, zheziKey(t)).setOrigin(0, 0).setDepth(20).setInteractive({ useHandCursor: true, pixelPerfect: false }).on('pointerdown', () => bridge.events.clickTask(t.id));
            const label = txt(this, x + 17, y + 2, title, { color: '#2b2118' }).setDepth(21).setInteractive({ useHandCursor: true }).on('pointerdown', () => bridge.events.clickTask(t.id));
            s = { img, label, col };
            this.slips.set(t.id, s);
          } else {
            s.img.setTexture(zheziKey(t));
            s.label.setText(title);
            if (s.col !== col) {
              // the slip is carried to its new column — flow is visible
              this.tweens.add({ targets: s.img, x, y, duration: 700, ease: 'Sine.easeInOut' });
              this.tweens.add({ targets: s.label, x: x + 17, y: y + 2, duration: 700, ease: 'Sine.easeInOut' });
              const clerk = this.clerks[col % this.clerks.length];
              if (clerk) {
                const home = { x: clerk.sprite.x, y: clerk.sprite.y };
                void clerk.walkTo(x + 20, 236, 500).then(() => clerk.walkTo(home.x, home.y, 600)).then(() => clerk.play('think'));
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
          const seal = this.add.image(x, 228, 'seal').setOrigin(0, 0).setDepth(30);
          const t = txt(this, x + 14, 226, f.to, { color: '#f4e6c4', stroke: '#1a1220', strokeThickness: 3 }).setDepth(30);
          this.chain.push(seal, t);
          x += 18 + Math.ceil(t.width);
          if (x > 600) break;
        }
      }
      const ss = this.officials.get('shangshu');
      ss?.applyStatus(m.agents.shangshu, snippetFor(m, 'shangshu'));
    }
  }

  // ───────────────────────── 六部值房 ─────────────────────────
  class Liubu extends Base {
    dept: AgentId = 'bingbu';
    plaqueText: any = null;
    constructor() {
      super('liubu');
    }
    build() {
      this.dept = bridge.model.dept;
      this.plaqueText = txt(this, 90, 25, `${AGENT_MAP[this.dept].name}值房`, { color: '#f2d27a' }).setOrigin(0.5, 0).setDepth(10);
      this.addOfficial(this.dept, 130, 292, 'front');
      this.add.image(98, 276, 'desk').setOrigin(0, 0).setDepth(300);
      const aide = new Official(this, 'clerk', 64, 330, { facing: 'right' });
      aide.play('idle');
      txt(this, 405, 350, '六 部 值 房', { color: '#f2d27a', stroke: '#1a1220', strokeThickness: 3 }).setOrigin(0.5, 1).setDepth(9000);
    }
    sync(m: CourtModel) {
      if (m.dept !== this.dept) {
        this.officials.get(this.dept)?.destroy();
        this.officials.delete(this.dept);
        this.dept = m.dept;
        this.plaqueText.setText(`${AGENT_MAP[this.dept].name}值房`);
        const o = this.addOfficial(this.dept, 130, 360, 'front');
        void o.walkTo(130, 292, 700).then(() => (o.current = ''));
      }
      this.officials.get(this.dept)?.applyStatus(m.agents[this.dept], snippetFor(m, this.dept));
    }
  }

  // ───────────────────────── 承天门告示区 ─────────────────────────
  class Chengtian extends Base {
    lines: any[] = [];
    playing = false;
    banner: any = null;
    constructor() {
      super('chengtian');
    }
    build() {
      this.playing = false;
      this.lines = [];
      [[196, 244], [444, 244], [274, 244], [366, 244]].forEach(([x, y]) => new Official(this, 'guard', x, y, { facing: 'front' }));
      this.addOfficial('zaochao', 250, 320, 'front', '鸿胪寺卿');
      txt(this, 124, 188, '诏 令 告 示', { color: '#f2d27a', stroke: '#1a1220', strokeThickness: 3 }).setOrigin(0.5, 0).setDepth(50);
      txt(this, 320, 51, '承天门', { color: '#f2d27a' }).setOrigin(0.5, 0).setDepth(10);
      const btn = txt(this, 568, 318, '【击鼓上朝】', { color: '#f2d27a', stroke: '#1a1220', strokeThickness: 3 }).setOrigin(0.5, 0).setDepth(60).setInteractive({ useHandCursor: true });
      btn.on('pointerdown', () => this.ceremony());
      const clouds = [this.add.image(-60, 26, 'cloud').setDepth(-5), this.add.image(300, 44, 'cloud').setDepth(-5)];
      clouds.forEach((c, i) => this.tweens.add({ targets: c, x: c.x + 700, duration: 60000 + i * 20000, repeat: -1 }));
    }
    sync(m: CourtModel) {
      this.lines.forEach((l) => l.destroy());
      this.lines = [];
      const items = [...m.news.slice(0, 5)];
      items.forEach((n, i) => {
        const l = txt(this, 34, 210 + i * 16, `· ${n.title}`.slice(0, 13), { color: i === 0 ? '#f2d27a' : '#f4e6c4' }).setDepth(40).setInteractive({ useHandCursor: true });
        l.on('pointerdown', () => bridge.events.clickNotice(i));
        this.lines.push(l);
      });
      if (!items.length) this.lines.push(txt(this, 34, 214, '（尚无告示）', { color: '#c4bdb0' }).setDepth(40));
      this.officials.get('zaochao')?.applyStatus(m.agents.zaochao, snippetFor(m, 'zaochao'));
      if (m.ceremony && !this.playing) this.ceremony();
    }
    async ceremony() {
      if (this.playing) return;
      this.playing = true;
      this.cameras.main.shake(260, 0.006);
      this.banner = txt(this, 320, 110, '上  朝', { fontSize: '24px', color: '#f2d27a', stroke: '#6e1a1c', strokeThickness: 6 }).setOrigin(0.5).setDepth(9500).setAlpha(0);
      this.tweens.add({ targets: this.banner, alpha: 1, y: 100, duration: 500 });
      const sub = txt(this, 320, 132, bridge.model.totalsText, { color: '#f4e6c4', stroke: '#1a1220', strokeThickness: 3 }).setOrigin(0.5).setDepth(9500);
      const ids = ['taizi', 'zhongshu', 'menxia', 'shangshu', 'bingbu', 'libu'];
      const walkers: Official[] = [];
      ids.forEach((id, i) => {
        const o = new Official(this, id, 250 + (i % 2) * 140, 372 + Math.floor(i / 2) * 10, { facing: 'back' });
        walkers.push(o);
        this.time.delayedCall(i * 260, () => {
          void o.walkTo(320 + (i % 2 ? 8 : -8), 250, 1500).then(() => this.tweens.add({ targets: o.sprite, alpha: 0, duration: 300 }));
        });
      });
      this.time.delayedCall(3600, () => {
        this.cameras.main.fadeOut(400, 20, 12, 10);
        this.time.delayedCall(420, () => {
          walkers.forEach((w) => w.destroy());
          sub.destroy();
          this.banner?.destroy();
          this.playing = false;
          bridge.events.ceremonyDone();
        });
      });
    }
  }

  return [Boot, Taihe, Junjichu, Liubu, Chengtian];
}
