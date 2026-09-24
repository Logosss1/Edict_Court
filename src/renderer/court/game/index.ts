// Court game bootstrap: Phaser 3 with nearest-neighbour sampling and integer zoom.
import { loadPhaser } from '../../common/loaders';
import { makeScenes, type Bridge } from './scenes';
import type { CourtEvents, CourtModel, SceneKey } from './model';

export const WORLD_W = 640;
export const WORLD_H = 360;

export interface CourtGame {
  setModel(m: CourtModel): void;
  show(scene: SceneKey): void;
  resize(w: number, h: number): number; // returns integer zoom
  sleep(v: boolean): void;
  destroy(): void;
  zoom(): number;
}

export async function createCourtGame(parent: HTMLElement, model: CourtModel, events: CourtEvents, initial: SceneKey): Promise<CourtGame> {
  const P = await loadPhaser();
  try {
    await (document as any).fonts.load('12px FusionPixel', '朝堂');
  } catch {
    /* fall back to system font */
  }
  const bridge: Bridge & { initialScene?: SceneKey } = { model, events, current: null, initialScene: initial };
  const scenes = makeScenes(P, bridge);
  let zoom = 2;
  const game = new P.Game({
    type: P.AUTO,
    parent,
    width: WORLD_W,
    height: WORLD_H,
    pixelArt: true,
    roundPixels: true,
    antialias: false,
    backgroundColor: '#140e0b',
    scale: { mode: P.Scale.NONE, zoom },
    render: { pixelArt: true, antialias: false, roundPixels: true },
    input: { activePointers: 1 },
    banner: false,
    audio: { noAudio: true },
    scene: scenes,
  });
  let current: SceneKey = initial;
  return {
    setModel(m) {
      bridge.model = m;
      try {
        bridge.current?.sync(m);
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
      zoom = Math.max(1, Math.floor(Math.min(w / WORLD_W, h / WORLD_H)));
      game.scale.setZoom(zoom);
      return zoom;
    },
    zoom: () => zoom,
    sleep(v) {
      if (v) game.loop.sleep();
      else game.loop.wake();
    },
    destroy() {
      game.destroy(true);
    },
  };
}
