// A clickable pixel official: sprite + name tag + speech/thought bubble + status animation.
// Sprites are drawn at 2× detail (64×96 frames) and shown at half scale, so one official still
// occupies 32×48 world units. The frame layout is shared with the art generator via anims.json.
import type { AgentRuntime } from '../../../shared/types';
import LAYOUT from './anims.json';
import { FONT, WORLD_W } from './model';

export const SPRITE_SCALE = LAYOUT.displayScale;

/** animation name → frame indices in the sheet (row-major, LAYOUT.columns per row) */
export const ANIMS: Record<string, number[]> = (() => {
  const out: Record<string, number[]> = {};
  let i = 0;
  for (const a of LAYOUT.anims) {
    out[a.name] = Array.from({ length: a.frames }, (_, k) => i + k);
    i += a.frames;
  }
  // still poses for officials standing sideways / with their backs to the viewer
  out.side_idle = [out.walk_side[0]];
  out.back_idle = [out.walk_up[0]];
  return out;
})();
const RATES: Record<string, number> = Object.fromEntries(LAYOUT.anims.map((a) => [a.name, a.rate]));

export function ensureAnims(scene: any, key: string) {
  for (const [name, frames] of Object.entries(ANIMS)) {
    const k = `${key}:${name}`;
    if (scene.anims.exists(k)) continue;
    scene.anims.create({ key: k, frames: scene.anims.generateFrameNumbers(key, { frames }), frameRate: RATES[name] ?? 1, repeat: -1 });
  }
}

/** the motion each ministry falls back to while it works (its "trade") */
const DEPT_ACTION: Record<string, string> = {
  hubu: 'abacus', libu: 'write', bingbu: 'scheme', xingbu: 'law', gongbu: 'measure', libu_hr: 'search',
  menxia: 'seal', shangshu: 'dispatch', zhongshu: 'write', taizi: 'talk', zaochao: 'read', solo: 'write',
};
/** what an agent looks like while the model is producing text */
const WRITING_ANIM: Record<string, string> = {
  zhongshu: 'write', menxia: 'read', shangshu: 'dispatch', hubu: 'abacus', libu: 'write', bingbu: 'scheme',
  xingbu: 'law', gongbu: 'measure', libu_hr: 'write', solo: 'write', taizi: 'talk', zaochao: 'talk',
};
/** pondering style */
const THINK_ANIM: Record<string, string> = { bingbu: 'scheme', xingbu: 'law' };

export function toolAnim(tool: string, role: string): string {
  const t = tool.toLowerCase();
  if (/web|fetch|http|brows|url|news/.test(t)) return 'view';
  if (/grep|glob|search|find|list|ls\b|tree/.test(t)) return 'search';
  if (/write|edit|patch|create|apply|replace|insert/.test(t)) return 'write';
  if (/read|cat|open|view|get_file|show/.test(t)) return 'read';
  return DEPT_ACTION[role] ?? 'think';
}

const IDLE_VARIANTS = ['tea', 'stretch', 'look', 'look', 'tea'];

/** text drawn at the pixel font's native 12px on the 2× canvas (6 world units tall) */
export const NATIVE = 1 / 2;
export function nativeText(scene: any, x: number, y: number, s: string, style: Record<string, unknown> = {}) {
  return scene.add.text(x, y, s, { fontFamily: FONT, fontSize: '12px', color: '#f4e6c4', resolution: 1, ...style }).setScale(NATIVE);
}

export type Facing = 'front' | 'left' | 'right' | 'back';

export interface OfficialOpts {
  facing?: Facing;
  label?: string;
  color?: string;
  onClick?: (o: Official) => void;
  onHover?: (o: Official, over: boolean) => void;
  seated?: boolean;
  role?: string;
}

export class Official {
  scene: any;
  key: string;
  role: string;
  sprite: any;
  tag: any;
  bubble: any = null;
  bubbleText: any = null;
  mark: any = null;
  facing: Facing;
  seated: boolean;
  current = '';
  private bubbleUntil = 0;
  bubbleShift = 0;
  rect: { x: number; y: number; w: number; h: number } | null = null;
  private lastBubble = '';
  /** a short one-off animation (reward, scold, completion…) that wins over the status pose */
  private override: { anim: string; until: number } | null = null;
  private idleVariant: { anim: string; until: number } | null = null;
  private nextIdleVariant = Date.now() + 4000 + Math.random() * 9000;
  private lastCompleted = -1;
  frozen = false; // replay / scripted motion owns this official
  /** 朝堂布局: the loop this official plays when idle ('' = tea / stretch / look variants) */
  idleAnim = '';
  /** 朝堂布局: facing to return to after scripted motion */
  homeFacing: Facing | null = null;
  /** placed by a design's court layout (not one of the built-in officials) */
  seat = false;

  constructor(scene: any, key: string, x: number, y: number, o: OfficialOpts = {}) {
    this.scene = scene;
    this.key = key;
    this.role = o.role ?? key;
    this.facing = o.facing ?? 'front';
    this.seated = !!o.seated;
    ensureAnims(scene, key);
    this.sprite = scene.add.sprite(Math.round(x), Math.round(y), key, 0).setOrigin(0.5, 1).setScale(SPRITE_SCALE).setDepth(y);
    if (o.onClick || o.onHover) {
      this.sprite.setInteractive({ useHandCursor: !!o.onClick, pixelPerfect: true, alphaTolerance: 1 });
      if (o.onClick) this.sprite.on('pointerdown', (p: any) => { p?.event?.stopPropagation?.(); o.onClick!(this); });
      this.sprite.on('pointerover', () => { this.sprite.setTint(0xfff1c8); o.onHover?.(this, true); });
      this.sprite.on('pointerout', () => { this.sprite.clearTint(); o.onHover?.(this, false); });
    }
    if (o.label) {
      this.tag = nativeText(scene, Math.round(x), Math.round(y) + 1, o.label, { color: o.color ?? '#f4e6c4', stroke: '#1a1220', strokeThickness: 3 }).setOrigin(0.5, 0).setDepth(3000 + y);
    }
    this.play('idle');
  }

  get x() { return this.sprite.x; }
  get y() { return this.sprite.y; }

  play(name: string) {
    let anim = name;
    if (this.seated) anim = name === 'talk' ? 'sit_talk' : name === 'write' || name === 'read' || name === 'seal' ? 'sit_write' : name.startsWith('sit_') ? name : 'sit_idle';
    else if (name === 'idle') anim = this.facing === 'front' ? 'idle' : this.facing === 'back' ? 'back_idle' : 'side_idle';
    if (anim === this.current) return;
    this.current = anim;
    this.sprite.setFlipX(this.facing === 'left' && (anim === 'side_idle' || anim === 'walk_side'));
    this.sprite.play(`${this.key}:${anim}`, true);
  }

  /** play a one-off animation for a while; status updates resume afterwards */
  playFor(name: string, ms: number) {
    this.override = { anim: name, until: Date.now() + ms };
    this.current = '';
    this.play(name);
  }

  setPos(x: number, y: number) {
    this.sprite.setPosition(Math.round(x), Math.round(y)).setDepth(y);
    this.tag?.setPosition(Math.round(x), Math.round(y) + 1).setDepth(3000 + y);
    this.layoutBubble();
  }

  face(f: Facing) {
    this.facing = f;
    this.current = '';
  }

  walkTo(x: number, y: number, ms = 900): Promise<void> {
    return new Promise((resolve) => {
      const dx = x - this.sprite.x;
      const dy = y - this.sprite.y;
      const anim = Math.abs(dx) > Math.abs(dy) ? 'walk_side' : dy < 0 ? 'walk_up' : 'walk_down';
      const wasSeated = this.seated;
      this.seated = false;
      this.current = '';
      this.sprite.setFlipX(anim === 'walk_side' && dx < 0);
      this.sprite.play(`${this.key}:${anim}`, true);
      this.current = anim;
      this.scene.tweens.killTweensOf(this.sprite);
      this.scene.tweens.add({
        targets: this.sprite, x: Math.round(x), y: Math.round(y), duration: ms, ease: 'Linear',
        onUpdate: () => this.follow(),
        onComplete: () => {
          this.current = '';
          if (anim === 'walk_side') this.facing = dx < 0 ? 'left' : 'right';
          else this.facing = dy < 0 ? 'back' : 'front';
          void wasSeated;
          resolve();
        },
      });
    });
  }

  /** keep tag / bubble / mark attached while the sprite moves */
  follow() {
    this.sprite.setDepth(this.sprite.y);
    this.tag?.setPosition(Math.round(this.sprite.x), Math.round(this.sprite.y) + 1).setDepth(3000 + this.sprite.y);
    this.mark?.setPosition(Math.round(this.sprite.x + 9), Math.round(this.sprite.y - 44));
    this.layoutBubble();
  }

  /** step by (dx, dy) world units this frame — used for the emperor's free walk */
  step(dx: number, dy: number) {
    if (!dx && !dy) {
      if (this.current.startsWith('walk')) {
        this.facing = this.current === 'walk_side' ? (this.sprite.flipX ? 'left' : 'right') : this.current === 'walk_up' ? 'back' : 'front';
        this.current = '';
        this.play('idle');
      }
      return;
    }
    this.seated = false;
    const anim = Math.abs(dx) > Math.abs(dy) ? 'walk_side' : dy < 0 ? 'walk_up' : 'walk_down';
    if (this.current !== anim || (anim === 'walk_side' && this.sprite.flipX !== dx < 0)) {
      this.current = anim;
      this.sprite.setFlipX(anim === 'walk_side' && dx < 0);
      this.sprite.play(`${this.key}:${anim}`, true);
    }
    this.sprite.x += dx;
    this.sprite.y += dy;
    this.follow();
  }

  /** speech ('say'), thought ('think') or alert bubble */
  say(text: string, kind: 'say' | 'think' | 'alert' = 'say', holdMs = 0) {
    const t = (text || '').replace(/\s+/g, ' ').trim();
    if (!t) return this.clearBubble();
    const shown = t.length > 44 ? '…' + t.slice(-43) : t;
    if (shown === this.lastBubble && this.bubble) {
      if (holdMs) this.bubbleUntil = Date.now() + holdMs;
      return;
    }
    this.lastBubble = shown;
    if (holdMs) this.bubbleUntil = Date.now() + holdMs;
    if (!this.bubbleText) {
      this.bubble = this.scene.add.graphics().setDepth(5000);
      this.bubbleText = nativeText(this.scene, 0, 0, '', { color: '#1a1220', wordWrap: { width: 192, useAdvancedWrap: true }, lineSpacing: 2 }).setDepth(5001);
    }
    this.bubbleText.setText(shown);
    (this.bubble as any).kind = kind;
    this.layoutBubble();
  }

  clearBubble(force = false) {
    if (!force && Date.now() < this.bubbleUntil) return;
    this.lastBubble = '';
    this.rect = null;
    this.bubbleShift = 0;
    this.bubble?.destroy();
    this.bubbleText?.destroy();
    this.bubble = null;
    this.bubbleText = null;
  }

  layoutBubble() {
    if (!this.bubble || !this.bubbleText) return;
    const kind = (this.bubble as any).kind as string;
    const h1 = 0.5; // one canvas pixel
    const w = Math.ceil(this.bubbleText.displayWidth) + 6;
    const h = Math.ceil(this.bubbleText.displayHeight) + 4;
    let x = Math.round(this.sprite.x - w / 2);
    x = Math.max(2, Math.min(WORLD_W - w - 2, x));
    const top = this.seated ? 40 : 48;
    const y = Math.round(this.sprite.y - top - h - 6 - this.bubbleShift);
    this.rect = { x, y, w, h };
    const g = this.bubble;
    g.clear();
    const fill = kind === 'alert' ? 0xffe7a3 : kind === 'think' ? 0xdcebe8 : 0xfbf6ea;
    const border = kind === 'alert' ? 0xb3322a : 0x2a1a14;
    // drop shadow, 1px ink border with clipped corners, paper fill, gold hairline inside the top edge
    g.fillStyle(0x000000, 0.22);
    g.fillRect(x + 1, y + 1, w, h);
    g.fillStyle(border, 1);
    g.fillRect(x, y - h1, w, h + 2 * h1);
    g.fillRect(x - h1, y, w + 2 * h1, h);
    g.fillStyle(fill, 1);
    g.fillRect(x, y, w, h);
    if (kind !== 'think') {
      g.fillStyle(kind === 'alert' ? 0xe0604a : 0xd9b25a, 1);
      g.fillRect(x + h1, y + h1, w - 1, h1);
    }
    const tx = Math.round(this.sprite.x * 2) / 2;
    if (kind === 'think') {
      g.fillStyle(border, 1);
      g.fillRect(tx - 1.5, y + h + 1.5, 2.5, 2.5);
      g.fillRect(tx - 0.5, y + h + 5, 1.5, 1.5);
      g.fillStyle(fill, 1);
      g.fillRect(tx - 1, y + h + 2, 1.5, 1.5);
    } else {
      for (let i = 0; i < 4; i++) {
        g.fillStyle(border, 1);
        g.fillRect(tx - 3 + i * 0.75, y + h + i, 6 - i * 1.5, 1);
        if (i < 3) {
          g.fillStyle(fill, 1);
          g.fillRect(tx - 2.5 + i * 0.75, y + h + i - h1, 5 - i * 1.5, 1);
        }
      }
    }
    if (this.bubbleShift > 0 && kind !== 'think') {
      g.fillStyle(border, 1);
      g.fillRect(tx, y + h + 4, h1, this.bubbleShift);
    }
    this.bubbleText.setPosition(x + 3, y + 2);
  }

  /** small status mark above the head: ! ? … */
  setMark(ch: string | null, color = '#b3322a') {
    if (!ch) {
      this.mark?.destroy();
      this.mark = null;
      return;
    }
    if (!this.mark) this.mark = this.scene.add.text(0, 0, ch, { fontFamily: FONT, fontSize: '12px', color, stroke: '#1a1220', strokeThickness: 3, resolution: 2 }).setOrigin(0.5, 1).setDepth(4000);
    this.mark.setText(ch).setColor(color).setPosition(Math.round(this.sprite.x + 9), Math.round(this.sprite.y - 44));
  }

  /** map runtime agent status to animation + bubble */
  applyStatus(a: AgentRuntime | undefined, snippet: string | undefined, tool?: string) {
    if (this.frozen) return;
    const now = Date.now();
    // a finished assignment earns a little celebration
    if (a) {
      if (this.lastCompleted >= 0 && a.completed > this.lastCompleted) this.playFor('joy', 2600);
      this.lastCompleted = a.completed;
    }
    if (this.override && now < this.override.until) {
      this.play(this.override.anim);
      if (!a || a.status === 'idle') this.clearBubble();
      return;
    }
    this.override = null;
    if (!a || a.status === 'idle') {
      this.setMark(null);
      this.clearBubble();
      this.idle(now);
      return;
    }
    this.idleVariant = null;
    switch (a.status) {
      case 'thinking':
        this.play(THINK_ANIM[this.role] ?? 'think');
        this.say(snippet || '思量中…', 'think');
        break;
      case 'writing':
        this.play(WRITING_ANIM[this.role] ?? 'talk');
        this.say(snippet || '…', 'say');
        break;
      case 'tool':
        this.play(toolAnim(tool ?? a.activity ?? '', this.role));
        this.say(`⚙ ${a.activity || '办差中'}`, 'think');
        break;
      case 'waiting':
        this.play('kneel');
        this.say(`臣请旨：${a.activity.replace(/^等待批准：/, '')}`, 'alert');
        break;
      case 'paused':
        this.play('tea');
        this.say('（奉旨暂停）', 'think');
        break;
      case 'error':
        this.play('worry');
        this.say('出错了！', 'alert');
        break;
    }
    this.setMark(a.health === 'alert' ? '!' : a.health === 'stale' ? '?' : null, a.health === 'alert' ? '#e0604a' : '#f2d27a');
  }

  /** idle officials sip tea, stretch or look around now and then */
  idle(now = Date.now()) {
    if (this.frozen) return;
    if (this.idleAnim) return this.play(this.idleAnim);
    if (this.seated || this.facing !== 'front') return this.play('idle');
    if (this.idleVariant && now < this.idleVariant.until) return this.play(this.idleVariant.anim);
    if (this.idleVariant) {
      this.idleVariant = null;
      this.nextIdleVariant = now + 7000 + Math.random() * 12000;
    }
    if (now >= this.nextIdleVariant) {
      const anim = IDLE_VARIANTS[Math.floor(Math.random() * IDLE_VARIANTS.length)];
      this.idleVariant = { anim, until: now + 2600 + Math.random() * 2000 };
      return this.play(anim);
    }
    this.play('idle');
  }

  destroy() {
    this.scene.tweens?.killTweensOf(this.sprite);
    this.sprite.destroy();
    this.tag?.destroy();
    this.clearBubble(true);
    this.mark?.destroy();
  }
}


/** Push overlapping speech bubbles upward so every line stays readable. */
export function resolveBubbles(list: Official[]) {
  const withB = list.filter((o) => o.bubble);
  for (const o of withB) {
    o.bubbleShift = 0;
    o.layoutBubble();
  }
  withB.sort((a, b) => b.sprite.y - a.sprite.y || a.sprite.x - b.sprite.x);
  const placed: Official[] = [];
  for (const o of withB) {
    let guard = 0;
    while (guard++ < 8) {
      const r = o.rect!;
      const hit = placed.find((p) => p.rect && r.x < p.rect.x + p.rect.w + 2 && p.rect.x < r.x + r.w + 2 && r.y < p.rect.y + p.rect.h + 3 && p.rect.y < r.y + r.h + 3);
      if (!hit) break;
      o.bubbleShift += r.y + r.h + 4 - hit.rect!.y;
      o.layoutBubble();
      if (o.rect!.y < 2) break;
    }
    placed.push(o);
  }
}
