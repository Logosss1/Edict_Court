// A clickable pixel official: sprite + name tag + speech/thought bubble + status animation.
import type { AgentRuntime } from '../../../shared/types';
import { FONT } from './model';

export const ANIMS: Record<string, number[]> = {
  idle: [0, 1], walk_down: [2, 3, 4, 5], walk_up: [6, 7, 8, 9], walk_side: [10, 11, 12, 13], talk: [14, 15], think: [16, 17], kneel: [18, 19], reject: [20, 21], side_idle: [11], back_idle: [7],
};

export function ensureAnims(scene: any, key: string) {
  for (const [name, frames] of Object.entries(ANIMS)) {
    const k = `${key}:${name}`;
    if (scene.anims.exists(k)) continue;
    const rate = name.startsWith('walk') ? 7 : name === 'idle' ? 1.6 : name === 'talk' ? 5 : name === 'reject' ? 4 : 2.2;
    scene.anims.create({ key: k, frames: scene.anims.generateFrameNumbers(key, { frames }), frameRate: rate, repeat: -1 });
  }
}

export type Facing = 'front' | 'left' | 'right' | 'back';

export class Official {
  scene: any;
  key: string;
  sprite: any;
  tag: any;
  bubble: any = null;
  bubbleText: any = null;
  mark: any = null;
  facing: Facing;
  current = '';
  private bubbleUntil = 0;
  bubbleShift = 0;
  rect: { x: number; y: number; w: number; h: number } | null = null;
  private lastBubble = '';

  constructor(scene: any, key: string, x: number, y: number, o: { facing?: Facing; label?: string; color?: string; onClick?: () => void; scale?: number } = {}) {
    this.scene = scene;
    this.key = key;
    this.facing = o.facing ?? 'front';
    ensureAnims(scene, key);
    this.sprite = scene.add.sprite(Math.round(x), Math.round(y), key, 0).setOrigin(0.5, 1).setDepth(y);
    if (o.onClick) {
      this.sprite.setInteractive({ useHandCursor: true, pixelPerfect: true, alphaTolerance: 1 });
      this.sprite.on('pointerdown', o.onClick);
      this.sprite.on('pointerover', () => this.sprite.setTint(0xfff1c8));
      this.sprite.on('pointerout', () => this.sprite.clearTint());
    }
    if (o.label) {
      this.tag = scene.add.text(Math.round(x), Math.round(y) + 1, o.label, { fontFamily: FONT, fontSize: '12px', color: o.color ?? '#f4e6c4', stroke: '#1a1220', strokeThickness: 3, resolution: 1 }).setOrigin(0.5, 0).setDepth(3000 + y);
    }
    this.play('idle');
  }

  play(name: string) {
    let anim = name;
    if (name === 'idle') anim = this.facing === 'front' ? 'idle' : this.facing === 'back' ? 'back_idle' : 'side_idle';
    if (anim === this.current) return;
    this.current = anim;
    this.sprite.setFlipX(this.facing === 'left' && (anim === 'side_idle' || anim === 'walk_side'));
    this.sprite.play(`${this.key}:${anim}`, true);
  }

  setPos(x: number, y: number) {
    this.sprite.setPosition(Math.round(x), Math.round(y)).setDepth(y);
    this.tag?.setPosition(Math.round(x), Math.round(y) + 1).setDepth(3000 + y);
    this.layoutBubble();
  }

  walkTo(x: number, y: number, ms = 900): Promise<void> {
    return new Promise((resolve) => {
      const dx = x - this.sprite.x;
      const dy = y - this.sprite.y;
      const anim = Math.abs(dx) > Math.abs(dy) ? 'walk_side' : dy < 0 ? 'walk_up' : 'walk_down';
      this.current = '';
      this.sprite.setFlipX(anim === 'walk_side' && dx < 0);
      this.sprite.play(`${this.key}:${anim}`, true);
      this.current = anim;
      this.scene.tweens.add({
        targets: this.sprite, x: Math.round(x), y: Math.round(y), duration: ms, ease: 'Linear',
        onUpdate: () => {
          this.sprite.setDepth(this.sprite.y);
          this.tag?.setPosition(Math.round(this.sprite.x), Math.round(this.sprite.y) + 1).setDepth(3000 + this.sprite.y);
          this.layoutBubble();
        },
        onComplete: () => {
          this.current = '';
          resolve();
        },
      });
    });
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
      this.bubbleText = this.scene.add.text(0, 0, '', { fontFamily: FONT, fontSize: '12px', color: '#1a1220', resolution: 1, wordWrap: { width: 132, useAdvancedWrap: true }, lineSpacing: 1 }).setDepth(5001);
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
    const w = Math.ceil(this.bubbleText.width) + 8;
    const h = Math.ceil(this.bubbleText.height) + 5;
    const worldW = this.scene.scale.gameSize.width;
    let x = Math.round(this.sprite.x - w / 2);
    x = Math.max(2, Math.min(worldW - w - 2, x));
    const y = Math.round(this.sprite.y - 48 - h - 8 - this.bubbleShift);
    this.rect = { x, y, w, h };
    const g = this.bubble;
    g.clear();
    const fill = kind === 'alert' ? 0xffe7a3 : kind === 'think' ? 0xd2e6e4 : 0xf8f4ea;
    const border = kind === 'alert' ? 0xb3322a : 0x1a1220;
    g.fillStyle(border, 1);
    g.fillRect(x, y - 1, w, h + 2);
    g.fillRect(x - 1, y, w + 2, h);
    g.fillStyle(fill, 1);
    g.fillRect(x, y, w, h);
    const tx = Math.round(this.sprite.x);
    if (kind === 'think') {
      g.fillStyle(border, 1);
      g.fillRect(tx - 2, y + h + 2, 3, 3);
      g.fillRect(tx - 1, y + h + 6, 2, 2);
      g.fillStyle(fill, 1);
      g.fillRect(tx - 1, y + h + 3, 1, 1);
    } else {
      g.fillStyle(border, 1);
      g.fillRect(tx - 3, y + h, 7, 1);
      g.fillRect(tx - 2, y + h + 1, 5, 1);
      g.fillRect(tx - 1, y + h + 2, 3, 1);
      g.fillRect(tx, y + h + 3, 1, 1);
      g.fillStyle(fill, 1);
      g.fillRect(tx - 2, y + h, 5, 1);
      g.fillRect(tx - 1, y + h + 1, 3, 1);
    }
    if (this.bubbleShift > 0 && kind !== 'think') {
      g.fillStyle(border, 1);
      g.fillRect(tx, y + h + 4, 1, this.bubbleShift);
    }
    this.bubbleText.setPosition(x + 4, y + 2);
  }

  /** small status mark above the head: ! ? … */
  setMark(ch: string | null, color = '#b3322a') {
    if (!ch) {
      this.mark?.destroy();
      this.mark = null;
      return;
    }
    if (!this.mark) this.mark = this.scene.add.text(0, 0, ch, { fontFamily: FONT, fontSize: '12px', color, stroke: '#1a1220', strokeThickness: 3, resolution: 1 }).setOrigin(0.5, 1).setDepth(4000);
    this.mark.setText(ch).setColor(color).setPosition(Math.round(this.sprite.x + 9), Math.round(this.sprite.y - 44));
  }

  /** map runtime agent status to animation + bubble */
  applyStatus(a: AgentRuntime | undefined, snippet: string | undefined) {
    if (!a || a.status === 'idle') {
      this.play('idle');
      this.clearBubble();
      this.setMark(null);
      return;
    }
    switch (a.status) {
      case 'thinking':
        this.play('think');
        this.say(snippet || '思量中…', 'think');
        break;
      case 'writing':
        this.play('talk');
        this.say(snippet || '…', 'say');
        break;
      case 'tool':
        this.play('think');
        this.say(`⚙ ${a.activity || '办差中'}`, 'think');
        break;
      case 'waiting':
        this.play('kneel');
        this.say(`臣请旨：${a.activity.replace(/^等待批准：/, '')}`, 'alert');
        break;
      case 'paused':
        this.play('idle');
        this.say('（奉旨暂停）', 'think');
        break;
      case 'error':
        this.play('reject');
        this.say('出错了！', 'alert');
        break;
    }
    this.setMark(a.health === 'alert' ? '!' : a.health === 'stale' ? '?' : null, a.health === 'alert' ? '#e0604a' : '#f2d27a');
  }

  destroy() {
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
