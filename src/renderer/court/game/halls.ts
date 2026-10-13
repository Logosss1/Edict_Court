// The halls of the top-down court. Each one says who sits where (its residents come and go by the
// schedule), what can be clicked, and what moves in the background. Shared behaviour lives in Base
// (scenes.ts): walking, doors, visitors, handoffs, time of day.
import type { AgentId, Task } from '../../../shared/types';
import { AGENT_MAP, KANBAN_COLUMNS, STATE_LABEL, TERMINAL } from '../../../shared/court';
import { Official, nativeText } from './official';
import { WORLD_W, WORLD_H, type CourtModel, type SceneKey } from './model';
import { ATTENDS, FESTIVAL_LABEL, PERIOD_LABEL, moonPhase, seasonOf, type Place } from './schedule';
import { nearestFloor, route, type Pt } from './walk';
import { S, SCENE_NAME, img, txt, replaySteps, shichen, snippetFor, starField, toolFor, zheziKey, type Bridge, type DayPhase, type NpcSpec, type ReplayStep, type Seat } from './scenes';

const EAST: AgentId[] = ['zhongshu', 'menxia', 'shangshu', 'libu', 'hubu', 'libu_hr'];
const WEST: AgentId[] = ['bingbu', 'xingbu', 'gongbu', 'zaochao', 'solo'];

// the name board under the eaves reads top to bottom, as on the real halls
const vplaque = (scene: any, [x, y]: number[], s: string) =>
  nativeText(scene, x, y, s.split('').join('\n'), { color: '#f2d27a', fontSize: '14px', lineSpacing: -4, align: 'center' }).setOrigin(0.5).setDepth(10);

export function makeHalls(P: any, bridge: Bridge, Base: any): any[] {
  // ───────────────────────── 太和殿 ─────────────────────────
  class Taihe extends Base {
    replay: { steps: ReplayStep[]; caption: any; skip: any; scroll: any; stop: boolean } | null = null;
    forceAll = false;
    deskScroll: any = null;
    stepped = new Set<string>();
    constructor() {
      super('taihe');
    }
    throne() {
      return this.spots.throne ?? { x: 320, y: 114, foot: 156 };
    }
    build() {
      this.replay = null;
      this.deskScroll = null;
      this.stepped = new Set();
      const E: Pt[] = this.spots.east ?? [[390, 226], [444, 226], [390, 280], [444, 280], [390, 334], [444, 334]];
      const W: Pt[] = this.spots.west ?? [[250, 226], [196, 226], [250, 280], [196, 280], [250, 334]];
      // 文东武西: civil offices on the east side, military and the rest on the west, all facing the aisle
      EAST.forEach((id, i) => this.seats.set(id, { x: E[i][0], y: E[i][1], facing: 'left' }));
      WEST.forEach((id, i) => this.seats.set(id, { x: W[i][0], y: W[i][1], facing: 'right' }));
      const [px, py] = this.spots.prince ?? [278, 141];
      this.seats.set('taizi', { x: px, y: py, facing: 'front', label: '太子' });
      // 御案: a memorial laid on it opens for review; otherwise the memorial archive
      const [dx, dy] = this.spots.desk ?? [320, 116];
      this.hotspot(dx - 30, dy - 8, 60, 14, '御案 · 奏折', () => {
        const gated = bridge.model.tasks.find((t: Task) => t.gate && !TERMINAL.includes(t.state));
        if (this.deskScroll && gated) bridge.events.openReview(gated.id);
        else bridge.events.openPanel('memorials');
      }, 7);
      this.title();
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
      if (bridge.procession) this.time.delayedCall(3800, () => this.courtEunuch()?.say('有事早奏，无事退朝——', 'say', 2600));
    }
    /** fan-bearing maids and the court eunuch stand by the throne only while court sits */
    npcList(): NpcSpec[] {
      const list: NpcSpec[] = super.npcList();
      if (!bridge.model.session && !this.forceAll) return list;
      // in session only the guards stay; the sweepers and lamp maids keep out of the way
      for (let i = list.length - 1; i >= 0; i--) if (list[i].kind !== 'guard') list.splice(i, 1);
      for (const [x, y] of (this.spots.fans as Pt[] | undefined) ?? []) list.push({ kind: 'lady', x, y, facing: 'front', act: 'idle', tag: 'fan' });
      const [ex, ey] = this.spots.eunuch ?? [296, 150];
      list.push({ kind: 'eunuch', x: ex, y: ey, facing: 'front', act: 'idle', tag: 'court' });
      return list;
    }
    courtEunuch(): Official | null {
      return this.npcs.find((n: any) => n.n.tag === 'court')?.o ?? null;
    }
    forcePlace(id: string): Place | null {
      return this.forceAll && ATTENDS.has(id) ? 'taihe' : null;
    }
    onSession(open: boolean) {
      if (open) {
        this.refreshNpcs();
        bridge.events.sound('whip');
        this.time.delayedCall(500, () => this.backToThrone());
        this.time.delayedCall(4200, () => this.courtEunuch()?.say('有事早奏，无事退朝——', 'say', 2600));
        return;
      }
      // 退朝: three cracks of the whip, the eunuch calls it, everyone bows, then they file out
      this.holdUntil = Date.now() + 2600;
      bridge.events.sound('whip');
      this.courtEunuch()?.say('退——朝——', 'say', 2400);
      for (const o of this.officials.values()) if (!o.frozen && !o.seat) o.playFor('bow', 1800);
      this.time.delayedCall(2600, () => this.refreshNpcs());
    }
    sync(m: CourtModel) {
      const d = m.debate;
      const speaking = d?.speaking;
      for (const [key, o] of this.officials) {
        if (o.frozen || o.moving) continue;
        const id = key.split('#')[0];
        const a = m.agents[id];
        if (d && d.participants.includes(id as AgentId) && d.status !== 'concluded') {
          this.stepOut(id, o, speaking === id);
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
        this.stepOut(id, o, false);
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
    }
    /** 廷议: the speaker steps out of line toward the aisle, and back when done */
    stepOut(id: string, o: Official, out: boolean) {
      const seat = this.seats.get(id);
      if (!seat || o.seat) return;
      if (out && !this.stepped.has(id)) {
        this.stepped.add(id);
        const dx = seat.x < 320 ? 18 : seat.x > 320 ? -18 : 0;
        void o.walkTo(seat.x + dx, seat.y + (dx ? 0 : 12), 320).then(() => { o.facing = dx > 0 ? 'right' : dx < 0 ? 'left' : 'front'; o.current = ''; });
      } else if (!out && this.stepped.has(id)) {
        this.stepped.delete(id);
        void o.walkTo(seat.x, seat.y, 320).then(() => { o.facing = seat.facing; o.current = ''; o.idle(); });
      }
    }
    /** 递折子: the court eunuch takes the memorial from the kneeling official and lays it on the 御案 */
    onVisitorArrived(v: any) {
      if (v.kind !== 'gate' || v.who === 'eunuch') return;
      const eu = this.courtEunuch();
      const [dx, dy] = this.spots.desk ?? [320, 116];
      if (!eu) return this.layOnDesk(dx, dy);
      const home: Pt = [eu.x, eu.y];
      eu.frozen = true;
      eu.moving = true;
      const scroll = img(this, v.o.x, v.o.y - 30, 'scroll').setDepth(5100).setScale(S * 0.7);
      void (async () => {
        await this.walkPath(eu, route(this.rects, home, [v.o.x - 16, v.o.y - 2]), 12);
        if (this.visit !== v) return void scroll.destroy();
        eu.facing = 'right';
        eu.playFor('present', 600);
        await new Promise((r) => this.time.delayedCall(600, r));
        const ev = this.time.addEvent({ delay: 40, loop: true, callback: () => scroll.active && scroll.setPosition(Math.round(eu.x), Math.round(eu.y - 50)) });
        await this.walkPath(eu, [...route(this.rects, [eu.x, eu.y], home), [dx - 18, dy + 20]], 12);
        ev.remove();
        scroll.destroy();
        if (this.visit === v) this.layOnDesk(dx, dy);
        await this.walkPath(eu, [home], 12);
        eu.facing = 'front';
        eu.frozen = false;
        eu.moving = false;
        eu.current = '';
        eu.idle();
      })();
    }
    layOnDesk(dx: number, dy: number) {
      this.deskScroll?.destroy();
      this.deskScroll = img(this, dx + 8, dy - 6, 'scroll').setDepth(dy + 8).setScale(S * 0.8).setInteractive({ useHandCursor: true });
      this.deskScroll.on('pointerdown', (p: any) => {
        p?.event?.stopPropagation?.();
        const gated = bridge.model.tasks.find((t: Task) => t.gate && !TERMINAL.includes(t.state));
        if (gated) bridge.events.openReview(gated.id);
      });
      this.tweens.add({ targets: this.deskScroll, y: dy - 9, duration: 600, yoyo: true, repeat: -1 });
    }
    onVisitorLeft() {
      this.deskScroll?.destroy();
      this.deskScroll = null;
    }
    /** 御批: the vermilion seal on the desk, and the whole court hails it */
    onGateDecided() {
      if (!bridge.model.session || !this.emperor?.seated) return;
      const [dx, dy] = this.spots.desk ?? [320, 116];
      this.stamp(dx, dy - 10, '准');
      bridge.events.sound('chime');
      let first = true;
      for (const [id, o] of this.officials) {
        if (o.frozen || o.moving || o.seat) continue;
        o.playFor('bow', 1600);
        if (first && (id === 'taizi' || id === 'zhongshu')) {
          o.say('陛下圣明！', 'say', 1800);
          first = false;
        }
      }
    }

    // ───── 奏折回放 ─────
    async startReplay(taskId: string) {
      const t = bridge.model.tasks.find((x: Task) => x.id === taskId);
      if (!t) return;
      this.stopReplay(true);
      // everyone is called into the hall for the replay, whatever the hour
      this.forceAll = true;
      if (this.visit) {
        const v = this.visit;
        this.visit = null;
        if (!v.seat) v.o.destroy();
        else { v.o.borrowed = false; v.o.clickOverride = null; }
      }
      for (const [id] of this.seats) {
        const o = this.officials.get(id);
        if (o && !o.seat) { o.destroy(); this.officials.delete(id); }
      }
      this.settled = false;
      this.computePlaces(bridge.model);
      this.syncResidents(bridge.model);
      this.settled = true;
      this.refreshNpcs();
      const steps = replaySteps(t);
      const caption = nativeText(this, 320, 5, '', { color: '#f2d27a', backgroundColor: '#2a1a14', padding: { x: 8, y: 3 } }).setOrigin(0.5, 0).setDepth(9600);
      const skip = nativeText(this, 634, 5, '结束回放 ✕', { color: '#f4e6c4', backgroundColor: '#6e1a1c', padding: { x: 6, y: 3 } }).setOrigin(1, 0).setDepth(9600).setInteractive({ useHandCursor: true });
      skip.on('pointerdown', (p: any) => { p?.event?.stopPropagation?.(); this.stopReplay(); });
      const th = this.throne();
      const scroll = img(this, th.x, th.y - 20, 'scroll').setDepth(6100);
      this.replay = { steps, caption, skip, scroll, stop: false };
      (this as any).busy = true;
      for (const o of this.officials.values()) { o.frozen = true; o.clearBubble(true); o.setMark(null); o.play('idle'); }
      if (this.emperor && !this.emperor.seated) { this.emperor.destroy(); this.emperor = null; }
      if (!this.emperor) this.spawnOnThrone();
      bridge.events.sound('bell');
      const at = (id: string): Official | null => (id === 'emperor' ? this.emperor : this.officials.get(id) ?? null);
      const kneel: Pt = this.spots.kneel ?? [320, 176];
      for (let i = 0; i < steps.length; i++) {
        const r = this.replay;
        if (!r || r.stop) return;
        const st = steps[i];
        r.caption.setText(`奏折回放 · ${t.title.slice(0, 12)}　${i + 1}/${steps.length}　${st.title}`);
        const o = at(st.actor);
        if (!o) continue;
        const seat = this.seats.get(st.actor);
        const [hx, hy] = st.actor === 'emperor' ? [th.x, th.y] : seat ? [seat.x, seat.y] : [o.x, o.y];
        // the memorial travels to whoever handles it next
        this.tweens.add({ targets: r.scroll, x: o.x, y: o.y - 54, duration: 520, ease: 'Sine.easeInOut' });
        if (st.actor !== 'emperor') {
          const fx = hx + (320 - hx) * 0.35;
          await o.walkTo(st.anim === 'kneel' ? kneel[0] : fx, st.anim === 'kneel' ? kneel[1] : hy - 4, st.anim === 'kneel' ? 900 : 420);
          if (!this.replay || this.replay.stop) return;
          o.facing = st.anim === 'kneel' ? 'back' : 'front';
        }
        o.current = '';
        o.play(st.anim);
        o.say(st.text, st.anim === 'reject' ? 'alert' : 'say');
        if (st.anim === 'reject') this.stamp(o.x, o.y - 40, '驳');
        else if (st.anim === 'seal') this.stamp(o.x, o.y - 40, '准');
        this.bubbles();
        await this.wait(st.anim === 'kneel' ? 2000 : 1500);
        if (!this.replay || this.replay.stop) return;
        o.clearBubble(true);
        if (st.actor !== 'emperor') {
          await o.walkTo(hx, hy, st.anim === 'kneel' ? 800 : 380);
          o.facing = seat?.facing ?? 'front';
        }
        o.current = '';
        o.play('idle');
      }
      for (const o of this.officials.values()) o.playFor('bow', 1500);
      this.floatText(320, 70, '结 案', '#f2d27a');
      bridge.events.sound('gong');
      await this.wait(1600);
      this.stopReplay();
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
      this.forceAll = false;
      for (const [id, o] of this.officials) {
        this.tweens.killTweensOf(o.sprite);
        const h = this.seats.get(id);
        if (h) this.settle(o, h);
        o.frozen = false;
        o.current = '';
        o.clearBubble(true);
      }
      this.refreshNpcs();
      this.syncAll(bridge.model);
      if (!silent) bridge.events.replayDone();
    }
  }

  // ───────────────────────── 太和殿广场 ─────────────────────────
  class Guangchang extends Base {
    dial: any = null;
    constructor() {
      super('guangchang');
    }
    build() {
      // before morning court the officials line up by the bronze rank markers (品级山), facing the hall
      const r = this.spots.ranks ?? { east: [], west: [] };
      EAST.forEach((id, i) => r.east?.[i] && this.seats.set(id, { x: r.east[i][0], y: r.east[i][1], facing: 'back' }));
      WEST.forEach((id, i) => r.west?.[i] && this.seats.set(id, { x: r.west[i][0], y: r.west[i][1], facing: 'back' }));
      if (this.spots.plaque) vplaque(this, this.spots.plaque, '太和殿');
      this.dial = this.add.graphics().setDepth(6);
      if (this.spots.sundial) {
        const [x, y, rr] = this.spots.sundial;
        this.hotspot(x - rr, y - rr, rr * 2, rr * 2, '日晷 · 看时辰', () => this.floatText(x, y - rr - 4, `${shichen(this.hour())}（${PERIOD_LABEL[this.period() as keyof typeof PERIOD_LABEL]}）`, '#f2d27a'), 7);
      }
      this.title();
    }
    ambient() {
      (this.spots.lanterns ?? []).forEach(([x, y]: number[], i: number) => this.lantern(x, y, i));
      for (const [x, y] of this.spots.incense ?? []) this.burner(x, y);
      const cat = this.spots.cat as number[][] | undefined;
      if (cat?.length) this.cat(cat);
      this.time.delayedCall(3000, () => this.birds());
    }
    /** the gnomon's shadow follows the real sun */
    onTime() {
      const g = this.dial;
      if (!g || !this.spots.sundial) return;
      g.clear();
      const [x, y, r] = this.spots.sundial;
      const h = this.hour();
      if (h < 6 || h > 18 || bridge.weather === 'rain' || bridge.weather === 'snow') return;
      const a = ((-90 - (12 - h) * 15) * Math.PI) / 180;
      g.lineStyle(1, 0x2a1a14, 0.75);
      g.lineBetween(x, y, x + Math.cos(a) * r * 0.85, y + Math.sin(a) * r * 0.85 * 0.7);
    }
  }

  // ───────────────────────── 承天门 ─────────────────────────
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
      const [bx, by, bw, bh] = this.spots.board ?? [28, 204, 96, 45];
      const herald: Pt = this.spots.herald ?? nearestFloor(this.rects, bx + bw + 24, by + bh + 26);
      this.seats.set('zaochao', { x: herald[0], y: herald[1], facing: 'front', label: '鸿胪寺卿' });
      this.hotspot(bx, by - 12, bw, bh + 12, '告示榜 · 天下要闻', () => bridge.events.openPanel('news'), 30);
      txt(this, bx + bw / 2, by - 12, '诏 令 告 示', { color: '#f2d27a', stroke: '#1a1220', strokeThickness: 3 }).setOrigin(0.5, 0).setDepth(50);
      if (this.spots.plaque) vplaque(this, this.spots.plaque, '承天门');
      const [dx, dy] = this.spots.drum ?? [568, 286];
      this.hotspot(dx - 18, dy - 26, 36, 32, '登闻鼓 · 击鼓上朝', () => this.ceremony(), 55);
      const btn = txt(this, dx, dy + 8, '【击鼓上朝】', { color: '#f2d27a', stroke: '#1a1220', strokeThickness: 3 }).setOrigin(0.5, 0).setDepth(60).setInteractive({ useHandCursor: true });
      btn.on('pointerdown', (p: any) => { p?.event?.stopPropagation?.(); this.ceremony(); });
      this.title();
    }
    ambient() {
      for (const [x, y] of this.spots.flags ?? []) this.add.sprite(x, y, 'flag').setScale(S).setOrigin(0, 0).setDepth(y).play({ key: 'flag', startFrame: Math.floor(Math.random() * 4) });
      (this.spots.lanterns ?? []).forEach(([x, y]: number[], i: number) => this.lantern(x, y, i));
      const wall = this.spots.wallTop as number[][] | undefined;
      if (wall?.length) this.cat(wall, 200);
      this.time.delayedCall(2500, () => this.birds());
    }
    sync(m: CourtModel) {
      this.lines.forEach((l) => l.destroy());
      this.lines = [];
      const [bx, by, bw] = this.spots.board ?? [28, 204, 96, 45];
      const per = Math.max(6, Math.floor((bw - 8) / 6));
      const items = [...m.news.slice(0, 5)];
      items.forEach((n, i) => {
        const l = nativeText(this, bx + 4, by + 4 + i * 8, `· ${n.title}`.slice(0, per), { color: i === 0 ? '#6e1a1c' : '#2b2118' }).setDepth(40).setInteractive({ useHandCursor: true });
        l.on('pointerdown', (p: any) => { p?.event?.stopPropagation?.(); bridge.events.clickNotice(i); });
        l.on('pointerover', () => l.setColor('#b3322a'));
        l.on('pointerout', () => l.setColor(i === 0 ? '#6e1a1c' : '#2b2118'));
        this.lines.push(l);
      });
      if (!items.length) this.lines.push(nativeText(this, bx + 4, by + 6, '（尚无告示）', { color: '#7c6a55' }).setDepth(40));
      if (m.ceremony && !this.playing) this.ceremony();
    }
    /** 击鼓上朝: the drum, the officials file through the gate, then on to the hall */
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
      const gate = this.entryPoint('guangchang');
      const out = this.exitPoint('guangchang');
      const walkers: Official[] = ids.map((id, i) => new Official(this, id, 250 + (i % 2) * 140, WORLD_H + 12 + Math.floor(i / 2) * 10, { facing: 'back', role: id }));
      walkers.forEach((o, i) => this.time.delayedCall(i * 260, () => {
        void this.walkPath(o, [[gate[0] + (i % 2 ? 8 : -8), gate[1] + 10], out], 9).then(() => this.tweens.add({ targets: o.sprite, alpha: 0, duration: 300 }));
      }));
      this.time.delayedCall(1200, () => bridge.events.sound('bell'));
      this.time.delayedCall(3600, () => {
        this.cameras.main.fadeOut(400, 20, 12, 10);
        this.time.delayedCall(420, () => {
          walkers.forEach((w) => w.destroy());
          sub.destroy();
          this.banner?.destroy();
          this.playing = false;
          (this as any).busy = false;
          bridge.procession = true;
          bridge.events.ceremonyDone();
        });
      });
    }
  }

  // ───────────────────────── 军机处 ─────────────────────────
  class Junjichu extends Base {
    slips = new Map<string, { img: any; label: any; col: number }>();
    chain: any[] = [];
    clerks: Official[] = [];
    board = { x: 24, colW: 74, headerY: 35, slipY0: 52, slipDy: 20 };
    constructor() {
      super('junjichu');
    }
    build() {
      this.slips = new Map();
      this.chain = [];
      this.clerks = [];
      this.board = { ...this.board, ...(this.spots.board ?? {}) };
      const b = this.board;
      const seats = this.spots.seats ?? {};
      for (const id of ['zhongshu', 'menxia', 'shangshu'] as const) {
        const p = seats[id];
        if (p) this.seats.set(id, { x: p[0], y: p[1], facing: 'front', seated: true, label: id === 'zhongshu' ? '中书令' : id === 'menxia' ? '侍中' : '尚书令' });
      }
      const solo: Pt = seats.solo ?? nearestFloor(this.rects, (seats.shangshu?.[0] ?? 500) + 56, (seats.shangshu?.[1] ?? 300) + 6);
      this.seats.set('solo', { x: solo[0], y: solo[1], facing: 'front', seated: !!seats.solo });
      // the whole memorial wall opens the 旨意看板 (individual slips sit on top and open their task)
      const bottom = b.slipY0 + 8 * b.slipDy;
      this.hotspot(b.x - 9, b.headerY - 13, KANBAN_COLUMNS.length * b.colW + 18, bottom - b.headerY + 13, '折子墙 · 旨意看板', () => bridge.events.openPanel('kanban'), 4);
      KANBAN_COLUMNS.forEach((c, k) => nativeText(this, b.x + k * b.colW + b.colW / 2, b.headerY, c.label, { color: '#fbf0d4', stroke: '#6e1a1c', strokeThickness: 2 }).setOrigin(0.5, 0).setDepth(10));
      for (const [x, y] of (this.spots.clerks as Pt[] | undefined) ?? []) {
        const o = this.extra('clerk', x, y, 'front', true);
        o.play('sit_write');
        this.clerks.push(o);
      }
      this.title();
    }
    ambient() {
      for (const [x, y] of this.spots.incense ?? []) this.burner(x, y);
      for (const [x, y] of this.spots.lamps ?? []) this.flame(x, y);
      (this.spots.lanterns ?? []).forEach(([x, y]: number[], i: number) => this.lantern(x, y, i));
      const cat = this.spots.cat as number[][] | undefined;
      if (cat?.length) this.cat(cat);
    }
    colOf(t: Task) {
      return Math.max(0, KANBAN_COLUMNS.findIndex((c) => c.states.includes(t.state)));
    }
    sync(m: CourtModel) {
      const b = this.board;
      const byCol = new Map<number, Task[]>();
      const sorted = [...m.tasks].sort((a, c) => c.updatedAt - a.updatedAt);
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
          const x = b.x + col * b.colW + 6;
          const y = b.slipY0 + i * b.slipDy;
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
              const clerk = this.clerks[col % Math.max(1, this.clerks.length)];
              if (clerk && !clerk.frozen) {
                const home = { x: clerk.x, y: clerk.y };
                clerk.frozen = true;
                const wallFoot = nearestFloor(this.rects, x + 20, b.slipY0 + 8 * b.slipDy + 20);
                void this.walkPath(clerk, route(this.rects, [home.x, home.y], wallFoot), 10)
                  .then(() => { clerk.facing = 'back'; clerk.playFor('present', 600); return new Promise((r) => this.time.delayedCall(600, r)); })
                  .then(() => this.walkPath(clerk, [...route(this.rects, [clerk.x, clerk.y], [home.x, home.y]), [home.x, home.y]], 10))
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
      const [cx, cy] = this.spots.chain ?? [16, 226];
      if (sel) {
        const steps = sel.flow.slice(-7);
        let x = cx;
        const head = nativeText(this, x, cy + 2, `「${sel.title.slice(0, 12)}」${STATE_LABEL[sel.state]}：`, { color: '#f2d27a', stroke: '#1a1220', strokeThickness: 3 }).setDepth(30);
        this.chain.push(head);
        x += Math.ceil(head.displayWidth) + 3;
        for (const f of steps) {
          const seal = img(this, x, cy + 2, 'seal').setOrigin(0, 0).setDepth(30).setScale(S * 0.7);
          const t = nativeText(this, x + 9, cy + 2, f.to, { color: '#f4e6c4', stroke: '#1a1220', strokeThickness: 3 }).setDepth(30);
          this.chain.push(seal, t);
          x += 12 + Math.ceil(t.displayWidth);
          if (x > WORLD_W - 40) break;
        }
      }
      // clerks copy memorials while anything is in flight, otherwise they rest (and doze at night)
      const busy = m.tasks.some((t) => !TERMINAL.includes(t.state));
      for (const c of this.clerks) if (!c.frozen) { c.seated = true; c.play(busy ? 'sit_write' : 'sit_idle'); }
    }
  }

  // ───────────────────────── 六部院 ─────────────────────────
  class Liubu extends Base {
    dept: AgentId = 'bingbu';
    room: AgentId | null = null;
    plaques = new Map<string, any>();
    constructor() {
      super('liubu');
    }
    rooms(): Record<string, { rect: number[]; seat: Pt; clerk: Pt; plaque: Pt; door: number[] }> {
      return this.spots.rooms ?? {};
    }
    build() {
      this.dept = bridge.model.dept;
      this.room = null;
      this.plaques = new Map();
      for (const [dept, r] of Object.entries(this.rooms())) {
        const name = AGENT_MAP[dept as AgentId]?.name ?? dept;
        this.seats.set(dept, { x: r.seat[0], y: r.seat[1], facing: 'front', seated: true });
        this.plaques.set(dept, nativeText(this, r.plaque[0], r.plaque[1], name, { color: '#f2d27a', stroke: '#2a1a14', strokeThickness: 2 }).setOrigin(0.5).setDepth(12));
        this.hotspot(r.seat[0] - 22, r.seat[1] - 2, 44, 14, `${name}案几 · 办过的旨意`, () => bridge.events.showHistory(dept as AgentId), 8);
      }
      this.highlight();
      this.title();
    }
    /** each room's clerk at his stool; at night only two stay on duty */
    npcList(): NpcSpec[] {
      const list: NpcSpec[] = super.npcList();
      const night = this.period() === 'night';
      Object.values(this.rooms()).forEach((r, i) => {
        if (!night || i < 2) list.push({ kind: 'clerk', x: r.clerk[0], y: r.clerk[1], facing: 'front' });
      });
      return list;
    }
    ambient() {
      (this.spots.lanterns ?? []).forEach(([x, y]: number[], i: number) => this.lantern(x, y, i));
      for (const [x, y] of this.spots.lamps ?? []) this.flame(x, y);
      const cat = this.spots.cat as number[][] | undefined;
      if (cat?.length) this.cat(cat);
      this.time.delayedCall(4000, () => this.birds());
    }
    highlight() {
      for (const [d, t] of this.plaques) t.setColor(d === this.dept ? '#ffffff' : '#f2d27a');
    }
    sync(m: CourtModel) {
      if (m.dept !== this.dept) {
        this.dept = m.dept;
        this.highlight();
        // the HUD picked a ministry: the emperor walks over to its room
        const r = this.rooms()[this.dept];
        const e = this.emperor;
        if (r && e && this.settled) {
          const tok = ++this.walking;
          e.tok++;
          const goal: Pt = nearestFloor(this.rects, r.seat[0], r.seat[1] + 22);
          void (async () => {
            for (const [x, y] of route(this.rects, [e.x, e.y], goal)) {
              await e.walkTo(x, y, Math.max(120, Math.hypot(x - e.x, y - e.y) * 10));
              if (tok !== this.walking) return;
            }
            e.facing = 'back';
            e.current = '';
            e.play('idle');
          })();
        }
      }
    }
    update(t: number, dt: number) {
      super.update(t, dt);
      const e = this.emperor;
      if (!e) return;
      let inside: AgentId | null = null;
      for (const [dept, r] of Object.entries(this.rooms())) {
        const [x, y, w, h] = r.rect;
        if (e.x >= x && e.x <= x + w && e.y >= y && e.y <= y + h) inside = dept as AgentId;
      }
      if (inside !== this.room) {
        this.room = inside;
        bridge.events.roomEntered(inside);
      }
    }
  }

  // ───────────────────────── 东宫 ─────────────────────────
  class Donggong extends Base {
    constructor() {
      super('donggong');
    }
    build() {
      const p: Pt = this.spots.seats?.taizi ?? [320, 200];
      this.seats.set('taizi', { x: p[0], y: p[1], facing: 'front', seated: true, label: '太子' });
      const [x, y, w, h] = this.spots.desk ?? [p[0] - 24, p[1] - 2, 48, 16];
      this.hotspot(x, y, w, h, '太子书案 · 分拣过的旨意', () => bridge.events.showHistory('taizi'), 8);
      // 毓庆宫 was the crown prince's palace in the Forbidden City
      const pl = this.spots.plaque as Pt | undefined;
      if (pl) nativeText(this, pl[0], pl[1], '毓 庆 宫', { color: '#f2d27a' }).setOrigin(0.5).setDepth(10);
      this.title();
    }
    ambient() {
      for (const [x, y] of this.spots.incense ?? []) this.burner(x, y);
      for (const [x, y] of this.spots.lamps ?? []) this.flame(x, y);
      (this.spots.lanterns ?? []).forEach(([x, y]: number[], i: number) => this.lantern(x, y, i));
      const cat = this.spots.cat as number[][] | undefined;
      if (cat?.length) this.cat(cat);
    }
  }

  // ───────────────────────── 御花园 (just to look at) ─────────────────────────
  class Yuhuayuan extends Base {
    fish: any[] = [];
    flies: any[] = [];
    ice: any = null;
    constructor() {
      super('yuhuayuan');
    }
    build() {
      this.fish = [];
      this.flies = [];
      this.ice = null;
      const w = this.spots.water as number[] | undefined;
      if (w) {
        const [x, y, ww, hh] = w;
        this.hotspot(x, y, ww, hh, '锦鲤池 · 喂鱼', () => this.feed(), 6);
      }
      this.title();
    }
    ambient() {
      (this.spots.lanterns ?? []).forEach(([x, y]: number[], i: number) => this.lantern(x, y, i));
      for (const [x, y] of this.spots.lamps ?? []) this.flame(x, y);
      const cat = this.spots.cat as number[][] | undefined;
      if (cat?.length) this.cat(cat);
      this.time.delayedCall(2000, () => this.birds());
      ripples(this);
    }
    onTime(ph: DayPhase) {
      const winter = seasonOf(this.now()) === 'winter';
      // the pond freezes in winter: no fish, a pale sheet of ice
      this.ice?.destroy();
      this.ice = null;
      const w = this.spots.water as number[] | undefined;
      if (winter && w) this.ice = this.add.rectangle(w[0], w[1], w[2], w[3], 0xdcebe8, 0.45).setOrigin(0, 0).setDepth(5);
      if (!winter && !this.fish.length) this.spawnFish();
      if (winter) { this.fish.forEach((f) => f.destroy()); this.fish = []; }
      // fireflies on summer nights
      this.flies.forEach((f) => f.destroy());
      this.flies = [];
      const box = this.spots.fireflies as number[] | undefined;
      if (box && ph === 'night' && seasonOf(this.now()) === 'summer') {
        for (let i = 0; i < 14; i++) {
          const f = this.add.rectangle(box[0] + Math.random() * box[2], box[1] + Math.random() * box[3], 1, 1, 0xf6f0a0).setDepth(2600).setBlendMode(P.BlendModes.ADD);
          this.tweens.add({ targets: f, x: f.x + (Math.random() - 0.5) * 30, y: f.y + (Math.random() - 0.5) * 20, alpha: { from: 1, to: 0.1 }, duration: 1500 + Math.random() * 2000, yoyo: true, repeat: -1, delay: Math.random() * 1500 });
          this.flies.push(f);
        }
      }
    }
    spawnFish() {
      const pts = (this.spots.fish as Pt[] | undefined) ?? [];
      const colors = [0xe0702a, 0xf4e6c4, 0xe0402a, 0xf2d27a];
      pts.slice(0, 6).forEach(([x, y], i) => {
        const f = this.add.ellipse(x, y, 4, 1.6, colors[i % colors.length]).setDepth(4);
        this.fish.push(f);
        const swim = () => {
          if (!f.active) return;
          const [tx, ty] = pts[Math.floor(Math.random() * pts.length)];
          f.setScale(tx < f.x ? -1 : 1, 1);
          this.tweens.add({ targets: f, x: tx + (Math.random() - 0.5) * 8, y: ty + (Math.random() - 0.5) * 4, duration: 2500 + Math.random() * 3000, ease: 'Sine.easeInOut', onComplete: () => this.time.delayedCall(500 + Math.random() * 2500, swim) });
        };
        (f as any).swim = swim;
        this.time.delayedCall(Math.random() * 2000, swim);
      });
    }
    /** the one little interaction here: the koi come for the crumbs */
    feed() {
      const w = this.spots.water as number[] | undefined;
      if (!w) return;
      const p = this.input.activePointer;
      const pt = this.cameras.main.getWorldPoint(p.x, p.y);
      if (seasonOf(this.now()) === 'winter') return void this.floatText(pt.x, pt.y - 4, '池面结冰了', '#f4e6c4');
      this.floatText(pt.x, pt.y - 4, '锦鲤游了过来', '#f2d27a');
      for (const f of this.fish) {
        this.tweens.killTweensOf(f);
        this.tweens.add({ targets: f, x: pt.x + (Math.random() - 0.5) * 10, y: pt.y + (Math.random() - 0.5) * 5, duration: 900 + Math.random() * 700, ease: 'Quad.easeOut' });
      }
      const ring = this.add.ellipse(pt.x, pt.y, 4, 2).setStrokeStyle(0.5, 0xfbf6ea, 0.9).setDepth(5);
      this.tweens.add({ targets: ring, scaleX: 4, scaleY: 4, alpha: 0, duration: 1100, onComplete: () => ring.destroy() });
      // after a while they lose interest and swim off again
      this.time.delayedCall(4000, () => this.fish.forEach((f) => (f as any).swim?.()));
    }
  }

  // ───────────────────────── 宫道长街 (just to look at) ─────────────────────────
  class Gongdao extends Base {
    constructor() {
      super('gongdao');
    }
    build() {
      this.title();
    }
    ambient() {
      (this.spots.lanterns ?? []).forEach(([x, y]: number[], i: number) => this.lantern(x, y, i));
      for (const [x, y] of this.spots.lamps ?? []) this.flame(x, y);
      const cat = this.spots.cat as number[][] | undefined;
      if (cat?.length) this.cat(cat, 200);
      this.time.delayedCall(3000, () => this.birds());
    }
  }

  // ───────────────────────── 角楼 (just to look at) ─────────────────────────
  class Jiaolou extends Base {
    stars: any[] = [];
    moon: any[] = [];
    fireworks: any = null;
    constructor() {
      super('jiaolou');
    }
    build() {
      this.stars = [];
      this.moon = [];
      this.fireworks = null;
      this.title();
    }
    ambient() {
      (this.spots.lanterns ?? []).forEach(([x, y]: number[], i: number) => this.lantern(x, y, i));
      for (const [x, y] of this.spots.lamps ?? []) this.flame(x, y);
      const cat = this.spots.cat as number[][] | undefined;
      if (cat?.length) this.cat(cat);
      this.time.delayedCall(2000, () => this.birds());
      ripples(this);
    }
    onTime(ph: DayPhase) {
      this.stars = starField(this, this.stars, ph, 40);
      this.moon.forEach((m) => m.destroy());
      this.moon = [];
      if (ph === 'night' || ph === 'dusk' || ph === 'dawn') this.drawMoon(ph);
      this.fireworks?.remove();
      this.fireworks = null;
      if (ph === 'night' && this.festival) this.fireworks = this.time.addEvent({ delay: 1600, loop: true, callback: () => this.burst() });
    }
    /** the real moon phase, and its reflection wobbling on the moat */
    drawMoon(ph: DayPhase) {
      const p = moonPhase(this.now());
      const lit = (1 - Math.cos(2 * Math.PI * p)) / 2;
      if (lit < 0.04) return;
      const [rx, ry] = this.spots.moon ?? [480, 250];
      const r = this.festival === 'zhongqiu' ? 9 : 7;
      const sky: Pt = [rx, 22];
      const alpha = ph === 'night' ? 1 : 0.55;
      for (const [x, y, refl] of [[sky[0], sky[1], false], [rx, ry, true]] as [number, number, boolean][]) {
        const g = this.add.graphics().setDepth(refl ? 6 : 2560).setAlpha(refl ? alpha * 0.55 : alpha);
        g.fillStyle(0xfff6d0, 1);
        if (lit >= 0.97) g.fillCircle(x, y, r);
        else {
          // only the lit part: the bright limb, then back along the terminator (waxing lit on the right, waning on the left)
          const side = p < 0.5 ? 1 : -1;
          const k = 1 - 2 * lit;
          const pts: { x: number; y: number }[] = [];
          for (let i = 0; i <= 16; i++) {
            const t = -Math.PI / 2 + (Math.PI * i) / 16;
            pts.push({ x: x + side * r * Math.cos(t), y: y + r * Math.sin(t) });
          }
          for (let i = 16; i >= 0; i--) {
            const t = -Math.PI / 2 + (Math.PI * i) / 16;
            pts.push({ x: x + side * r * k * Math.cos(t), y: y + r * Math.sin(t) });
          }
          g.fillPoints(pts, true);
        }
        if (refl) {
          g.setScale(1, 0.5).setY(y * 0.5);
          this.tweens.add({ targets: g, scaleX: 1.08, duration: 1400, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' });
        } else {
          const halo = img(this, x, y, 'glow').setDepth(2555).setBlendMode(P.BlendModes.ADD).setScale(S * 0.6).setAlpha(0.35 * alpha);
          this.moon.push(halo);
        }
        this.moon.push(g);
      }
    }
    /** festival fireworks over the far city */
    burst() {
      const x = 60 + Math.random() * (WORLD_W - 120);
      const y = 20 + Math.random() * 50;
      const c = [0xf2d27a, 0xe0604a, 0xf4e6c4, 0x8ad0e0][Math.floor(Math.random() * 4)];
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * Math.PI * 2;
        const s = this.add.rectangle(x, y, 1, 1, c).setDepth(2560).setBlendMode(P.BlendModes.ADD);
        this.tweens.add({ targets: s, x: x + Math.cos(a) * 16, y: y + Math.sin(a) * 12 + 4, alpha: 0, duration: 1100, ease: 'Quad.easeOut', onComplete: () => s.destroy() });
      }
    }
  }

  // ───────────────────────── 宫城舆图 (the map) ─────────────────────────
  class Yutu extends Base {
    marks: any[] = [];
    head: any = null;
    constructor() {
      super('yutu');
    }
    build() {
      this.marks = [];
      const places = (this.spots.places ?? {}) as Record<string, number[]>;
      for (const [k, [x, y, w, h]] of Object.entries(places)) {
        this.hotspot(x, y, w, h, SCENE_NAME[k as SceneKey] ?? k, () => {
          bridge.arrivedFrom = 'yutu';
          bridge.events.sound('chime');
          bridge.events.gotoScene(k as SceneKey);
        }, 6).setName(`place_${k}`);
      }
      const labels = (this.spots.label ?? {}) as Record<string, number[]>;
      for (const [k, [x, y]] of Object.entries(labels)) nativeText(this, x, y, SCENE_NAME[k as SceneKey] ?? k, { color: '#2b2118', stroke: '#fbf0d4', strokeThickness: 2 }).setOrigin(0.5).setDepth(8);
      this.head = nativeText(this, 8, 6, '', { color: '#f2d27a', backgroundColor: '#2a1a14', padding: { x: 5, y: 2 } }).setDepth(9000);
    }
    applyTime() {
      super.applyTime();
      // a map in the study: the evening only dims it a little
      this.shade?.setAlpha(Math.min(this.shade.fillAlpha ?? 0, 0.22));
    }
    sync(m: CourtModel) {
      this.marks.forEach((x) => x.destroy());
      this.marks = [];
      const places = (this.spots.places ?? {}) as Record<string, number[]>;
      const night = this.phase() === 'night' || this.phase() === 'dusk';
      // who is where: a small count on each building, busy ones in red; lamps at night
      const count = new Map<string, { n: number; busy: number }>();
      for (const id of ATTENDS) {
        const p = bridge.places[id];
        if (!p || p === 'out') continue;
        const c = count.get(p) ?? { n: 0, busy: 0 };
        c.n++;
        const a = m.agents[id];
        if (a && a.status !== 'idle') c.busy++;
        count.set(p, c);
      }
      for (const [k, [x, y, w, h]] of Object.entries(places)) {
        const c = count.get(k);
        if (night && k !== 'yuhuayuan' && k !== 'jiaolou') {
          const g = img(this, x + w / 2, y + h / 2, 'glow').setDepth(2600).setBlendMode(P.BlendModes.ADD).setScale(S * 0.3).setAlpha(c ? 0.8 : 0.35);
          this.marks.push(g);
        }
        if (!c) continue;
        const t = nativeText(this, x + w - 1, y + 1, c.busy ? `${c.n}人·${c.busy}办差` : `${c.n}人`, { color: '#fbf0d4', backgroundColor: c.busy ? '#8e2a22' : '#4a3a2a', padding: { x: 2, y: 0 } }).setOrigin(1, 0).setDepth(9);
        this.marks.push(t);
      }
      // the emperor has someone waiting for him
      const waiting = m.approvals.filter((a) => a.status === 'pending').length + m.tasks.filter((t) => t.gate && !TERMINAL.includes(t.state)).length;
      const fest = this.festival ? ` · ${FESTIVAL_LABEL[this.festival as keyof typeof FESTIVAL_LABEL]}` : '';
      this.head?.setText(`${shichen(this.hour())} · ${m.session ? '朝会中' : PERIOD_LABEL[this.period() as keyof typeof PERIOD_LABEL]}${fest}${waiting ? ` · 候见 ${waiting}` : ''}`);
    }
  }

  return [Taihe, Guangchang, Chengtian, Junjichu, Liubu, Donggong, Yuhuayuan, Gongdao, Jiaolou, Yutu];
}

/** now and then a ring spreads on the water */
function ripples(scene: any) {
  const w = scene.spots.water as number[] | undefined;
  if (!w) return;
  scene.time.addEvent({ delay: 1800, loop: true, callback: () => {
    if (Math.random() < 0.4) return;
    const x = w[0] + 6 + Math.random() * (w[2] - 12);
    const y = w[1] + 4 + Math.random() * (w[3] - 8);
    const r = scene.add.ellipse(x, y, 3, 1.4).setStrokeStyle(0.5, 0xfbf6ea, 0.7).setDepth(5);
    scene.tweens.add({ targets: r, scaleX: 3.5, scaleY: 3.5, alpha: 0, duration: 1600, onComplete: () => r.destroy() });
  } });
}

