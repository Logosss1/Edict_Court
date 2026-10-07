// Court game bootstrap: Phaser 3 with nearest-neighbour sampling. The canvas is 1280×720 (2× detail)
// and every scene camera zooms ×2 onto the 640×360 world.
import { loadPhaser } from '../../common/loaders';
import { makeScenes, type Bridge } from './scenes';
import { DETAIL, WORLD_W, WORLD_H, type CourtEvents, type CourtModel, type SceneKey, type Weather } from './model';

export { WORLD_W, WORLD_H };

export interface CourtGame {
  setModel(m: CourtModel): void;
  show(scene: SceneKey): void;
  /** fit into w×h CSS px; returns CSS px per world unit */
  resize(w: number, h: number): number;
  sleep(v: boolean): void;
  destroy(): void;
  zoom(): number;
  /** arrow keys held / released, and one-shot keys (Space, Escape) — routed from React */
  key(code: string, down: boolean): void;
  setWeather(w: Weather): void;
  /** 赏赐 / 训诫 / 催办 reaction: animation only; false when the official is not in the current scene */
  react(id: string, kind: 'reward' | 'scold' | 'urge'): boolean;
  replay(taskId: string): void;
  stopReplay(): void;
  /** for tests: pin the clock to an hour (null = real time) */
  setHour(h: number | null): void;
}

export async function createCourtGame(parent: HTMLElement, model: CourtModel, events: CourtEvents, initial: SceneKey, opts: { weather?: Weather } = {}): Promise<CourtGame> {
  const P = await loadPhaser();
  try {
    await (document as any).fonts.load('12px FusionPixel', '朝堂');
  } catch {
    /* fall back to system font */
  }
  const bridge: Bridge & { initialScene?: SceneKey } = {
    model, events, current: null, initialScene: initial, keys: new Set(), weather: opts.weather ?? 'clear', arrivedFrom: null, lit: {}, pendingReplay: null, hourOverride: null,
  };
  const scenes = makeScenes(P, bridge);
  let canvasZoom = 1;
  const game = new P.Game({
    type: P.AUTO,
    parent,
    width: WORLD_W * DETAIL,
    height: WORLD_H * DETAIL,
    pixelArt: true,
    roundPixels: true,
    antialias: false,
    backgroundColor: '#140e0b',
    scale: { mode: P.Scale.NONE, zoom: canvasZoom },
    render: { pixelArt: true, antialias: false, roundPixels: true },
    input: { activePointers: 1, keyboard: false },
    banner: false,
    audio: { noAudio: true },
    scene: scenes,
  });
  let current: SceneKey = initial;
  const cur = () => bridge.current as any;
  return {
    setModel(m) {
      bridge.model = m;
      try {
        cur()?.sync(m);
      } catch (e) {
        console.error('[court] sync failed', e);
      }
    },
    show(key) {
      if (!(bridge as any).booted) {
        bridge.initialScene = key;
        current = key;
        return;
      }
      if (key === current && bridge.current) return;
      current = key;
      const active = game.scene.getScenes(true).map((s: any) => s.sys.settings.key).filter((k: string) => k !== key);
      for (const k of active) game.scene.stop(k);
      game.scene.start(key);
    },
    resize(w, h) {
      // at or above native size: whole-pixel steps keep the pixel grid crisp; below it the browser
      // scales smoothly so the 2× art still reads instead of dropping every other pixel
      const fit = Math.min(w / (WORLD_W * DETAIL), h / (WORLD_H * DETAIL));
      canvasZoom = fit >= 1 ? Math.floor(fit) : Math.max(0.25, Math.floor(fit * 20) / 20);
      game.scale.setZoom(canvasZoom);
      const c = game.canvas as HTMLCanvasElement | undefined;
      if (c) c.style.imageRendering = canvasZoom >= 1 ? 'pixelated' : 'auto';
      return canvasZoom * DETAIL;
    },
    zoom: () => canvasZoom * DETAIL,
    sleep(v) {
      if (v) game.loop.sleep();
      else game.loop.wake();
    },
    destroy() {
      game.destroy(true);
    },
    key(code, down) {
      if (down) bridge.keys.add(code);
      else bridge.keys.delete(code);
      if (down && (code === 'Space' || code === 'Escape' || code === 'Enter')) cur()?.action?.(code);
    },
    setWeather(w) {
      bridge.weather = w;
      cur()?.setWeather?.(w);
    },
    react(id, kind) {
      return !!cur()?.react?.(id, kind);
    },
    replay(taskId) {
      if (current === 'taihe' && cur()?.startReplay) void cur().startReplay(taskId);
      else bridge.pendingReplay = taskId;
    },
    stopReplay() {
      cur()?.stopReplay?.();
    },
    setHour(h) {
      bridge.hourOverride = h;
      cur()?.applyTime?.();
    },
  };
}
