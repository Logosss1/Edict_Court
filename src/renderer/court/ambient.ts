// Court ambience — 钟鼓 and birdsong synthesised with WebAudio (no audio files). Off by default;
// nothing here touches the runtime.
import type { SoundCue } from './game/model';

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let enabled = false;
let timer: ReturnType<typeof setTimeout> | null = null;
let isDay = () => {
  const h = new Date().getHours();
  return h >= 6 && h < 19;
};

export function soundEnabled() {
  return enabled;
}

export function setSound(on: boolean, dayFn?: () => boolean) {
  enabled = on;
  if (dayFn) isDay = dayFn;
  if (on) {
    try {
      ctx ??= new AudioContext();
      if (!master) {
        master = ctx.createGain();
        master.gain.value = 0.22;
        master.connect(ctx.destination);
      }
      void ctx.resume();
    } catch {
      enabled = false;
      return;
    }
    schedule();
    cue('bell');
  } else {
    if (timer) clearTimeout(timer);
    timer = null;
    void ctx?.suspend();
  }
}

/** occasional birdsong by day, a distant temple bell every now and then */
function schedule() {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    if (!enabled) return;
    if (isDay() && Math.random() < 0.7) cue('chirp');
    else if (Math.random() < 0.25) cue('bell', 0.35);
    schedule();
  }, 5000 + Math.random() * 11000);
}

export function cue(name: SoundCue, vol = 1) {
  if (!enabled || !ctx || !master) return;
  const t = ctx.currentTime + 0.01;
  switch (name) {
    case 'bell': return bell(t, 196, 3.6, 0.5 * vol);
    case 'gong': return bell(t, 110, 2.8, 0.6 * vol, [1, 1.48, 2.1, 2.9]);
    case 'chime': return bell(t, 1318, 0.9, 0.18 * vol, [1, 1.5, 2.0]);
    case 'drum': return drum(t, vol);
    case 'chirp': return chirp(t, vol);
    case 'meow': return meow(t, vol);
  }
}

function env(g: GainNode, t: number, peak: number, decay: number, attack = 0.005) {
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
}

function bell(t: number, f: number, decay: number, peak: number, partials = [1, 2.76, 5.4, 8.93]) {
  partials.forEach((p, i) => {
    const o = ctx!.createOscillator();
    const g = ctx!.createGain();
    o.type = 'sine';
    o.frequency.value = f * p;
    env(g, t, peak / (i + 1), decay / (1 + i * 0.6));
    o.connect(g).connect(master!);
    o.start(t);
    o.stop(t + decay + 0.1);
  });
}

function drum(t: number, vol: number) {
  for (let k = 0; k < 3; k++) {
    const tt = t + k * 0.42;
    const o = ctx!.createOscillator();
    const g = ctx!.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(120, tt);
    o.frequency.exponentialRampToValueAtTime(48, tt + 0.35);
    env(g, tt, 0.9 * vol, 0.6, 0.003);
    o.connect(g).connect(master!);
    o.start(tt);
    o.stop(tt + 0.7);
    // skin noise
    const len = Math.floor(ctx!.sampleRate * 0.12);
    const buf = ctx!.createBuffer(1, len, ctx!.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const n = ctx!.createBufferSource();
    const lp = ctx!.createBiquadFilter();
    const ng = ctx!.createGain();
    lp.type = 'lowpass';
    lp.frequency.value = 700;
    n.buffer = buf;
    env(ng, tt, 0.35 * vol, 0.12, 0.002);
    n.connect(lp).connect(ng).connect(master!);
    n.start(tt);
  }
}

function chirp(t: number, vol: number) {
  const notes = 2 + Math.floor(Math.random() * 3);
  const base = 2600 + Math.random() * 900;
  for (let k = 0; k < notes; k++) {
    const tt = t + k * (0.11 + Math.random() * 0.05);
    const o = ctx!.createOscillator();
    const g = ctx!.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(base, tt);
    o.frequency.exponentialRampToValueAtTime(base * (1.25 + Math.random() * 0.3), tt + 0.06);
    env(g, tt, 0.12 * vol, 0.09, 0.004);
    o.connect(g).connect(master!);
    o.start(tt);
    o.stop(tt + 0.12);
  }
}

function meow(t: number, vol: number) {
  const o = ctx!.createOscillator();
  const bp = ctx!.createBiquadFilter();
  const g = ctx!.createGain();
  o.type = 'sawtooth';
  o.frequency.setValueAtTime(520, t);
  o.frequency.linearRampToValueAtTime(820, t + 0.18);
  o.frequency.linearRampToValueAtTime(460, t + 0.5);
  bp.type = 'bandpass';
  bp.frequency.setValueAtTime(900, t);
  bp.frequency.linearRampToValueAtTime(1500, t + 0.2);
  bp.Q.value = 3;
  env(g, t, 0.25 * vol, 0.55, 0.04);
  o.connect(bp).connect(g).connect(master!);
  o.start(t);
  o.stop(t + 0.6);
}
