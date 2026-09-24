// 16×16 tileset + four Tang-dynasty scene backgrounds (640×360) and runtime props.
import { Bitmap, C, rng } from './raster.mjs';

export const TS = 16;
export const SW = 640;
export const SH = 360;

// ───────────────────────── tiles ─────────────────────────
const TILE_DEFS = {};
function tile(name, draw) {
  TILE_DEFS[name] = draw;
}

tile('floor_jinzhuan', (b, r) => {
  // 金砖: dark polished stone slabs with sheen
  b.rect(0, 0, 16, 16, C.STONE_D);
  b.hline(0, 15, 0, C.BLACK);
  b.vline(0, 0, 15, C.BLACK);
  b.hline(1, 14, 1, C.STONE);
  b.set(3 + Math.floor(r() * 8), 4 + Math.floor(r() * 8), C.STONE);
  b.set(10, 11, C.STONE);
});
tile('carpet_c', (b) => {
  b.rect(0, 0, 16, 16, C.RED);
  for (let y = 2; y < 16; y += 8) for (let x = 2; x < 16; x += 8) { b.set(x + 2, y, C.GOLD); b.set(x, y + 2, C.GOLD); b.set(x + 4, y + 2, C.GOLD); b.set(x + 2, y + 4, C.GOLD); b.set(x + 2, y + 2, C.RED_L); }
});
tile('carpet_l', (b) => {
  b.rect(0, 0, 16, 16, C.RED);
  b.vline(0, 0, 15, C.RED_D);
  b.vline(1, 0, 15, C.GOLD);
  b.vline(3, 0, 15, C.GOLD_D);
  for (let y = 0; y < 16; y += 4) b.set(2, y, C.GOLD_L);
});
tile('carpet_r', (b) => {
  b.rect(0, 0, 16, 16, C.RED);
  b.vline(15, 0, 15, C.RED_D);
  b.vline(14, 0, 15, C.GOLD);
  b.vline(12, 0, 15, C.GOLD_D);
  for (let y = 2; y < 16; y += 4) b.set(13, y, C.GOLD_L);
});
tile('marble', (b) => {
  b.rect(0, 0, 16, 16, C.JADE);
  b.hline(0, 15, 15, C.STONE_L);
  b.vline(15, 0, 15, C.STONE_L);
  b.set(5, 6, C.STONE_L);
});
tile('marble_step', (b) => {
  b.rect(0, 0, 16, 16, C.JADE);
  for (let y = 3; y < 16; y += 4) { b.hline(0, 15, y, C.STONE_L); b.hline(0, 15, y + 1, C.STONE); }
});
tile('marble_rail', (b) => {
  // 汉白玉栏杆
  b.rect(0, 10, 16, 6, C.JADE);
  b.hline(0, 15, 10, C.STONE_L);
  b.rect(1, 2, 3, 9, C.JADE);
  b.rect(1, 1, 3, 1, C.STONE_L);
  b.vline(3, 2, 10, C.STONE_L);
  b.hline(4, 15, 5, C.JADE);
  b.hline(4, 15, 6, C.STONE_L);
  b.rect(8, 7, 5, 3, C.STONE_L);
});
tile('wall_red', (b) => {
  b.rect(0, 0, 16, 16, C.RED);
  b.set(4, 5, C.RED_D);
  b.set(11, 12, C.RED_D);
  b.set(9, 3, C.RED_L);
});
tile('wall_skirt', (b) => {
  b.rect(0, 0, 16, 16, C.STONE);
  b.hline(0, 15, 0, C.STONE_L);
  b.hline(0, 15, 8, C.STONE_D);
  b.vline(8, 0, 7, C.STONE_D);
  b.vline(0, 9, 15, C.STONE_D);
});
tile('beam_painted', (b, r, x) => {
  // 旋子彩画 beam band
  b.rect(0, 0, 16, 16, C.BLU_D);
  b.hline(0, 15, 0, C.GOLD_D);
  b.hline(0, 15, 15, C.GOLD_D);
  b.hline(0, 15, 1, C.TEAL);
  b.hline(0, 15, 14, C.TEAL);
  b.ellipse(8, 8, 4, 4, C.GRN);
  b.ellipse(8, 8, 2, 2, C.TEAL);
  b.set(8, 8, C.GOLD_L);
  b.set(8, 4, C.GOLD);
  b.set(8, 12, C.GOLD);
  b.set(4, 8, C.GOLD);
  b.set(12, 8, C.GOLD);
  void r;
  void x;
});
tile('beam_plain', (b) => {
  b.rect(0, 0, 16, 16, C.RED_D);
  b.hline(0, 15, 0, C.BLACK);
  b.hline(0, 15, 3, C.RED);
  b.hline(0, 15, 12, C.RED);
});
tile('ceiling', (b) => {
  // 藻井 coffered ceiling
  b.rect(0, 0, 16, 16, C.GRN_D);
  b.rect(1, 1, 14, 14, C.BLU_D);
  b.rect(0, 0, 16, 1, C.GOLD_D);
  b.rect(0, 0, 1, 16, C.GOLD_D);
  b.ellipse(8, 8, 3, 3, C.TEAL);
  b.set(8, 8, C.GOLD_L);
});
tile('lattice', (b) => {
  // 格扇门 lattice with paper
  b.rect(0, 0, 16, 16, C.PAPER);
  b.rect(0, 0, 16, 1, C.BROWN);
  b.rect(0, 0, 1, 16, C.BROWN);
  b.rect(15, 0, 1, 16, C.BROWN);
  for (let i = 3; i < 16; i += 4) { b.vline(i, 0, 15, C.WOOD); b.hline(0, 15, i, C.WOOD); }
});
tile('lattice_low', (b) => {
  b.rect(0, 0, 16, 16, C.RED_D);
  b.rect(2, 2, 12, 12, C.RED);
  b.rect(4, 4, 8, 8, C.RED_D);
  b.set(8, 8, C.GOLD);
});
tile('wood_wall', (b) => {
  b.rect(0, 0, 16, 16, C.BROWN);
  b.vline(0, 0, 15, C.DBROWN);
  b.vline(8, 0, 15, C.DBROWN);
  b.set(3, 5, C.WOOD);
  b.set(12, 10, C.WOOD);
});
tile('wood_floor', (b, r) => {
  b.rect(0, 0, 16, 16, C.WOOD);
  b.hline(0, 15, 0, C.BROWN);
  b.hline(0, 15, 8, C.BROWN);
  const k = Math.floor(r() * 12);
  b.vline(k + 2, 1, 7, C.BROWN);
  b.vline((k + 7) % 14 + 1, 9, 15, C.BROWN);
  b.set(5, 4, C.GOLD_D);
});
tile('stone_floor', (b) => {
  b.rect(0, 0, 16, 16, C.STONE);
  b.hline(0, 15, 0, C.STONE_D);
  b.vline(0, 0, 15, C.STONE_D);
  b.hline(1, 15, 1, C.STONE_L);
  b.set(6, 9, C.STONE_L);
});
tile('plaza', (b, r) => {
  b.rect(0, 0, 16, 16, C.STONE_L);
  b.hline(0, 15, 0, C.STONE);
  b.hline(0, 15, 8, C.STONE);
  b.vline(Math.floor(r() * 2) ? 4 : 11, 1, 7, C.STONE);
  b.vline(Math.floor(r() * 2) ? 7 : 13, 9, 15, C.STONE);
});
tile('brick_wall', (b) => {
  b.rect(0, 0, 16, 16, C.RED_D);
  for (let y = 0; y < 16; y += 4) {
    b.hline(0, 15, y, C.DBROWN);
    const off = (y / 4) % 2 ? 0 : 8;
    b.vline(off, y + 1, y + 3, C.DBROWN);
    b.set((off + 3) % 16, y + 1, C.CRIMSON);
  }
});
tile('sky', (b) => b.rect(0, 0, 16, 16, C.SKY));
tile('sky_light', (b) => {
  b.rect(0, 0, 16, 16, C.SKY);
  b.dither(0, 8, 16, 8, C.SKY, C.SKY_L);
});
tile('sky_haze', (b) => b.rect(0, 0, 16, 16, C.SKY_L));
tile('roof_tile', (b) => {
  // 灰瓦 with green glazed ridge line
  b.rect(0, 0, 16, 16, C.STONE_D);
  for (let x = 0; x < 16; x += 4) { b.vline(x, 0, 15, C.BLACK); b.vline(x + 1, 0, 15, C.STONE); }
  b.hline(0, 15, 15, C.BLACK);
});
tile('roof_edge', (b) => {
  b.rect(0, 0, 16, 16, C.STONE_D);
  for (let x = 0; x < 16; x += 4) { b.vline(x, 0, 11, C.BLACK); b.vline(x + 1, 0, 11, C.STONE); b.ellipse(x + 2, 13, 2, 2, C.GRN); b.set(x + 2, 13, C.GRN_L); }
});
tile('crenel', (b) => {
  b.rect(0, 6, 16, 10, C.RED_D);
  b.rect(0, 0, 8, 6, C.RED_D);
  b.hline(0, 7, 0, C.CRIMSON);
  b.hline(0, 15, 6, C.CRIMSON);
  b.hline(0, 15, 15, C.DBROWN);
});
tile('tatami_mat', (b) => {
  b.rect(0, 0, 16, 16, C.GOLD_D);
  b.dither(1, 1, 14, 14, C.GOLD_D, C.WOOD);
  b.rect(0, 0, 16, 1, C.GRN_D);
});

export function buildTileset() {
  const names = Object.keys(TILE_DEFS);
  const cols = 8;
  const rows = Math.ceil(names.length / cols);
  const ts = new Bitmap(cols * TS, rows * TS);
  const index = {};
  names.forEach((n, i) => {
    const t = new Bitmap(TS, TS);
    TILE_DEFS[n](t, rng(i + 7), i);
    ts.blit(t, (i % cols) * TS, Math.floor(i / cols) * TS, { transparent: false });
    index[n] = i + 1; // Tiled-style gid (1-based)
  });
  return { tileset: ts, index, cols, names };
}

// ───────────────────────── props (drawn onto backgrounds or exported) ─────────────────────────
export function pillar(b, x, top, bottom, w = 14) {
  b.rect(x, top, w, bottom - top, C.RED);
  b.rect(x, top, 2, bottom - top, C.RED_L);
  b.rect(x + w - 3, top, 3, bottom - top, C.RED_D);
  // bracket set 斗拱
  b.rect(x - 5, top - 10, w + 10, 4, C.TEAL);
  b.rect(x - 3, top - 6, w + 6, 3, C.GRN);
  b.rect(x - 1, top - 3, w + 2, 3, C.BLU);
  b.hline(x - 5, x + w + 4, top - 10, C.GOLD);
  b.set(x + Math.floor(w / 2), top - 8, C.GOLD_L);
  // lotus stone base 柱础
  b.rect(x - 3, bottom - 5, w + 6, 5, C.JADE);
  b.hline(x - 3, x + w + 2, bottom - 5, C.STONE_L);
  b.rect(x - 1, bottom - 7, w + 2, 2, C.STONE_L);
  b.hline(x - 3, x + w + 2, bottom - 1, C.STONE);
}

export function lantern(b, cx, top) {
  b.vline(cx, 0, top, C.BLACK);
  b.rect(cx - 5, top, 11, 2, C.GOLD);
  b.rect(cx - 6, top + 2, 13, 12, C.RED);
  b.rect(cx - 4, top + 3, 9, 10, C.GLOW);
  b.rect(cx - 2, top + 4, 5, 8, C.GOLD_L);
  b.vline(cx - 6, top + 2, top + 13, C.RED_D);
  b.vline(cx + 6, top + 2, top + 13, C.RED_D);
  b.rect(cx - 5, top + 14, 11, 2, C.GOLD);
  b.vline(cx - 2, top + 16, top + 21, C.RED);
  b.vline(cx + 2, top + 16, top + 21, C.RED);
  b.vline(cx, top + 16, top + 23, C.GOLD);
}

export function tripod(b, cx, y) {
  // bronze ding 鼎 with incense smoke
  b.ellipse(cx, y, 10, 6, C.GOLD_D);
  b.rect(cx - 10, y - 4, 21, 5, C.GOLD_D);
  b.hline(cx - 10, cx + 10, y - 4, C.GOLD);
  b.hline(cx - 8, cx + 8, y - 2, C.GOLD);
  b.rect(cx - 12, y - 8, 3, 5, C.GOLD_D);
  b.rect(cx + 10, y - 8, 3, 5, C.GOLD_D);
  b.rect(cx - 8, y + 5, 2, 6, C.GOLD_D);
  b.rect(cx + 7, y + 5, 2, 6, C.GOLD_D);
  b.rect(cx - 1, y + 5, 2, 6, C.GOLD_D);
  for (let i = 0; i < 18; i++) b.set(cx + Math.round(Math.sin(i / 2.5) * 3), y - 9 - i, i % 3 ? C.SKY_L : C.STONE_L);
}

export function dragonScreen(b, x, y, w, h) {
  b.rect(x, y, w, h, C.RED_D);
  b.rect(x + 3, y + 3, w - 6, h - 6, C.GOLD);
  b.rect(x + 5, y + 5, w - 10, h - 10, C.GOLD_L);
  // clouds
  const r = rng(99);
  for (let i = 0; i < 16; i++) {
    const cx = x + 10 + Math.floor(r() * (w - 20));
    const cy = y + 10 + Math.floor(r() * (h - 20));
    b.ellipse(cx, cy, 3, 2, C.GOLD);
    b.set(cx, cy, C.GOLD_L);
  }
  // serpentine dragon
  let px = x + 12;
  let py = y + h / 2;
  for (let t = 0; t < w - 24; t++) {
    const yy = y + h / 2 + Math.sin(t / 9) * (h / 4);
    b.ellipse(x + 12 + t, Math.round(yy), 2, 2, C.RED);
    if (t % 5 === 0) b.set(x + 12 + t, Math.round(yy) - 3, C.RED_D);
    px = x + 12 + t;
    py = yy;
  }
  // head + pearl
  b.ellipse(px, Math.round(py), 5, 4, C.RED);
  b.set(px + 2, Math.round(py) - 1, C.GOLD_L);
  b.line(px + 3, Math.round(py) - 4, px + 7, Math.round(py) - 8, C.RED_D);
  b.ellipse(x + w / 2, y + 9, 3, 3, C.JADE);
  b.set(x + w / 2, y + 9, C.GLOW);
  // panel seams (屏风 folds)
  for (let k = 1; k < 5; k++) b.vline(x + Math.round((w * k) / 5), y + 3, y + h - 4, C.GOLD_D);
  b.rect(x - 2, y + h, w + 4, 4, C.RED_D);
}

export function throne(b, cx, y) {
  // 御座: gilded chair with dragon-head arms on a low platform
  b.rect(cx - 30, y + 28, 61, 8, C.RED_D);
  b.hline(cx - 30, cx + 30, y + 28, C.GOLD);
  b.rect(cx - 24, y - 6, 49, 30, C.GOLD); // back
  b.rect(cx - 21, y - 3, 43, 24, C.RED);
  b.rect(cx - 18, y, 37, 18, C.RED_D);
  b.ellipse(cx, y - 8, 10, 4, C.GOLD);
  b.set(cx, y - 10, C.GOLD_L);
  b.rect(cx - 28, y + 8, 8, 18, C.GOLD); // arms
  b.rect(cx + 21, y + 8, 8, 18, C.GOLD);
  b.ellipse(cx - 25, y + 7, 4, 3, C.GOLD_L);
  b.ellipse(cx + 25, y + 7, 4, 3, C.GOLD_L);
  b.set(cx - 26, y + 6, C.RED);
  b.set(cx + 26, y + 6, C.RED);
  b.rect(cx - 20, y + 20, 41, 8, C.GOLD_D); // seat
  b.hline(cx - 20, cx + 20, y + 20, C.GOLD_L);
}

export function dais(b, cx, y, widths) {
  // stepped 汉白玉 platform, widths from top tier to bottom tier
  let yy = y;
  for (const w of widths) {
    b.rect(cx - w / 2, yy, w, 14, C.JADE);
    b.hline(cx - w / 2, cx + w / 2, yy, C.STONE_L);
    b.hline(cx - w / 2, cx + w / 2, yy + 13, C.STONE);
    for (let x = cx - w / 2 + 3; x < cx + w / 2 - 3; x += 10) b.rect(x, yy + 4, 6, 6, C.STONE_L);
    yy += 14;
  }
  return yy;
}

export function desk(b, x, y, w = 44) {
  b.rect(x, y, w, 6, C.BROWN);
  b.hline(x, x + w - 1, y, C.WOOD);
  b.rect(x + 2, y + 6, 3, 10, C.DBROWN);
  b.rect(x + w - 5, y + 6, 3, 10, C.DBROWN);
  b.rect(x + 6, y - 3, 12, 3, C.PAPER); // scroll
  b.set(x + 6, y - 3, C.RED);
  b.rect(x + w - 14, y - 5, 5, 5, C.BLACK); // ink stone
  b.vline(x + w - 8, y - 9, y - 1, C.WOOD); // brush
  b.set(x + w - 8, y - 1, C.BLACK);
}

export function bookshelf(b, x, y, w = 40, h = 64) {
  b.rect(x, y, w, h, C.BROWN);
  b.rect(x + 2, y + 2, w - 4, h - 4, C.DBROWN);
  const r = rng(x + y);
  for (let sy = y + 3; sy < y + h - 6; sy += 14) {
    b.hline(x + 2, x + w - 3, sy + 11, C.WOOD);
    for (let sx = x + 3; sx < x + w - 5; sx += 4) {
      const c = [C.PAPER, C.GOLD, C.RED, C.TEAL, C.PAPER][Math.floor(r() * 5)];
      b.rect(sx, sy + 3 + Math.floor(r() * 3), 3, 8 - Math.floor(r() * 2), c);
    }
  }
}

export function plaque(b, cx, y, w = 80) {
  // 匾额 blank (text drawn at runtime)
  b.rect(cx - w / 2 - 4, y - 4, w + 8, 26, C.GOLD);
  b.rect(cx - w / 2, y, w, 18, C.BLU_D);
  b.hline(cx - w / 2 - 4, cx + w / 2 + 3, y - 4, C.GOLD_L);
}

// ───────────────────────── scene composition ─────────────────────────
function tileFill(bg, tileset, index, name, x0, y0, x1, y1, map) {
  const id = index[name] - 1;
  const cols = tileset.w / TS;
  const sx = (id % cols) * TS;
  const sy = Math.floor(id / cols) * TS;
  for (let y = y0; y < y1; y += TS)
    for (let x = x0; x < x1; x += TS) {
      for (let j = 0; j < TS; j++) for (let i = 0; i < TS; i++) { const c = tileset.get(sx + i, sy + j); if (c) bg.set(x + i, y + j, c); }
      if (map) map[Math.floor(y / TS) * map.w + Math.floor(x / TS)] = index[name];
    }
}

function newMap() {
  const m = new Array(40 * 23).fill(0);
  m.w = 40;
  return m;
}

export function buildScenes(tileset, index) {
  const scenes = {};

  // ── 太和殿 ──
  {
    const b = new Bitmap(SW, SH);
    const map = newMap();
    tileFill(b, tileset, index, 'ceiling', 0, 0, SW, 16, map);
    tileFill(b, tileset, index, 'beam_painted', 0, 16, SW, 32, map);
    tileFill(b, tileset, index, 'wall_red', 0, 32, SW, 144, map);
    tileFill(b, tileset, index, 'lattice', 16, 48, 128, 128, map);
    tileFill(b, tileset, index, 'lattice', 512, 48, 624, 128, map);
    tileFill(b, tileset, index, 'lattice_low', 16, 128, 128, 144, map);
    tileFill(b, tileset, index, 'lattice_low', 512, 128, 624, 144, map);
    tileFill(b, tileset, index, 'floor_jinzhuan', 0, 144, SW, SH, map);
    // central carpet from the dais to the front
    tileFill(b, tileset, index, 'carpet_l', 288, 160, 304, SH, map);
    tileFill(b, tileset, index, 'carpet_c', 304, 160, 336, SH, map);
    tileFill(b, tileset, index, 'carpet_r', 336, 160, 352, SH, map);
    dragonScreen(b, 236, 38, 168, 86);
    const bottom = dais(b, 320, 124, [180, 230, 280]);
    // steps in the middle of the dais
    for (let y = 124; y < bottom; y += 3) b.hline(300, 340, y, y % 2 ? C.STONE_L : C.JADE);
    tileFill(b, tileset, index, 'marble_rail', 176, 108, 232, 124);
    tileFill(b, tileset, index, 'marble_rail', 408, 108, 464, 124);
    throne(b, 320, 88);
    tripod(b, 196, 190);
    tripod(b, 444, 190);
    for (const x of [40, 156, 470, 586]) pillar(b, x, 42, x === 40 || x === 586 ? SH : 250, x === 40 || x === 586 ? 16 : 14);
    for (const x of [86, 236, 404, 554]) lantern(b, x, 8);
    scenes.taihe = { bg: b, map, spots: {
      emperor: [320, 118],
      fans: [[276, 120], [364, 120]],
      guards: [[216, 186], [424, 186], [118, 300], [522, 300]],
      west: [[236, 222], [236, 262], [236, 302], [196, 242], [196, 282]], // 武 (viewer's left)
      east: [[404, 222], [404, 262], [404, 302], [444, 242], [444, 282], [444, 322]], // 文 (viewer's right)
      present: [320, 232],
      prince: [274, 196],
    } };
  }

  // ── 军机处值房 ──
  {
    const b = new Bitmap(SW, SH);
    const map = newMap();
    tileFill(b, tileset, index, 'beam_plain', 0, 0, SW, 16, map);
    tileFill(b, tileset, index, 'wood_wall', 0, 16, SW, 224, map);
    tileFill(b, tileset, index, 'wood_floor', 0, 224, SW, SH, map);
    // memorial board (折子墙) frame
    b.rect(20, 26, 600, 190, C.DBROWN);
    b.rect(24, 30, 592, 182, C.PAPER);
    b.hline(20, 619, 26, C.GOLD_D);
    for (let k = 0; k < 8; k++) {
      const x = 24 + k * 74;
      b.rect(x, 30, 74, 16, k === 2 ? C.RED : C.RED_D);
      b.vline(x, 30, 211, C.WOOD);
    }
    b.rect(20, 216, 600, 6, C.BROWN);
    bookshelf(b, 8, 250, 40, 70);
    bookshelf(b, 592, 250, 40, 70);
    for (const x of [90, 550]) lantern(b, x, 0);
    scenes.junjichu = { bg: b, map, spots: { columns: Array.from({ length: 8 }, (_, k) => [24 + k * 74 + 37, 38]), clerks: [[150, 300], [330, 316], [500, 300]], door: [320, 350] } };
  }

  // ── 六部值房 ──
  {
    const b = new Bitmap(SW, SH);
    const map = newMap();
    tileFill(b, tileset, index, 'beam_painted', 0, 0, SW, 16, map);
    tileFill(b, tileset, index, 'wall_red', 0, 16, SW, 256, map);
    tileFill(b, tileset, index, 'wall_skirt', 0, 240, SW, 256, map);
    tileFill(b, tileset, index, 'stone_floor', 0, 256, SW, SH, map);
    tileFill(b, tileset, index, 'lattice', 16, 64, 96, 224, map);
    // large hanging screen / scroll area for the embedded live panel
    b.rect(186, 28, 438, 222, C.BROWN);
    b.rect(190, 32, 430, 214, C.PAPER);
    b.rect(186, 24, 438, 6, C.GOLD_D);
    b.rect(186, 250, 438, 6, C.GOLD_D);
    b.set(186, 24, C.GOLD_L);
    plaque(b, 90, 22, 110);
    bookshelf(b, 20, 250, 36, 80);
    tripod(b, 600, 300);
    scenes.liubu = { bg: b, map, spots: { official: [130, 282], screen: [190, 32, 430, 214], plaque: [90, 31], aides: [[60, 320]] } };
  }

  // ── 承天门告示区 ──
  {
    const b = new Bitmap(SW, SH);
    const map = newMap();
    tileFill(b, tileset, index, 'sky', 0, 0, SW, 64, map);
    tileFill(b, tileset, index, 'sky_light', 0, 64, SW, 96, map);
    tileFill(b, tileset, index, 'sky_haze', 0, 96, SW, 128, map);
    // city wall
    tileFill(b, tileset, index, 'crenel', 0, 112, SW, 128, map);
    tileFill(b, tileset, index, 'brick_wall', 0, 128, SW, 240, map);
    tileFill(b, tileset, index, 'plaza', 0, 240, SW, SH, map);
    // gate tower 城楼 on the wall
    b.rect(170, 70, 300, 44, C.RED);
    for (let x = 180; x < 460; x += 28) { b.rect(x, 70, 4, 44, C.RED_D); b.rect(x + 6, 76, 16, 30, C.RED_D); b.rect(x + 8, 78, 12, 26, C.PAPER); }
    pillarsRow(b);
    // roof (hip roof with upturned eaves 鸱吻)
    b.poly([[140, 70], [500, 70], [470, 46], [170, 46]], C.STONE_D);
    for (let x = 146; x < 496; x += 4) b.vline(x, 50 + Math.max(0, Math.round(Math.abs(x - 320) / 60) - 3), 69, C.BLACK);
    b.hline(140, 499, 70, C.GRN);
    b.hline(142, 497, 71, C.GRN_D);
    b.poly([[200, 46], [440, 46], [420, 30], [220, 30]], C.STONE_D);
    b.hline(214, 426, 30, C.BLACK);
    b.rect(216, 26, 208, 5, C.BLACK);
    b.poly([[210, 20], [222, 30], [212, 30]], C.GRN); // chiwen
    b.poly([[430, 20], [418, 30], [428, 30]], C.GRN);
    b.poly([[138, 64], [128, 56], [146, 68]], C.STONE_D);
    b.poly([[502, 64], [512, 56], [494, 68]], C.STONE_D);
    plaque(b, 320, 50, 70);
    // three gate openings
    for (const gx of [230, 320, 410]) {
      const w = gx === 320 ? 46 : 36;
      b.rect(gx - w / 2, 170, w, 70, C.BLACK);
      b.ellipse(gx, 170, w / 2, 14, C.BLACK);
      b.rect(gx - w / 2 + 2, 176, w / 2 - 3, 64, C.RED);
      b.rect(gx + 1, 176, w / 2 - 3, 64, C.RED_D);
      for (let y = 184; y < 236; y += 9) for (let x = gx - w / 2 + 5; x < gx + w / 2 - 3; x += 7) b.set(x, y, C.GOLD);
    }
    // notice board 诏令告示墙
    b.rect(24, 196, 200, 104, C.BROWN);
    b.rect(28, 204, 192, 90, C.RED_D);
    b.poly([[16, 198], [232, 198], [222, 184], [26, 184]], C.STONE_D);
    b.hline(16, 231, 198, C.GRN);
    b.rect(34, 300, 6, 30, C.BROWN);
    b.rect(208, 300, 6, 30, C.BROWN);
    // drum 登闻鼓
    b.rect(540, 262, 6, 48, C.BROWN);
    b.rect(590, 262, 6, 48, C.BROWN);
    b.hline(536, 600, 262, C.BROWN);
    b.ellipse(568, 286, 18, 16, C.RED);
    b.ellipse(568, 286, 14, 12, C.PAPER);
    b.ellipse(568, 286, 6, 5, C.RED_L);
    // flags
    for (const fx of [150, 490]) {
      b.vline(fx, 60, 170, C.WOOD);
      b.rect(fx + 1, 64, 18, 26, C.RED);
      b.rect(fx + 3, 68, 14, 18, C.GOLD);
      b.set(fx + 10, 77, C.RED);
    }
    // clouds
    for (const [x, y] of [[60, 24], [560, 40], [300, 12]]) { b.ellipse(x, y, 20, 5, C.SKY_L); b.ellipse(x + 12, y - 3, 10, 5, C.SKY_L); }
    scenes.chengtian = { bg: b, map, spots: { board: [28, 204, 192, 90], gate: [320, 236], drum: [568, 286], guards: [[196, 244], [444, 244], [274, 244], [366, 244]], plaza: [[300, 300], [340, 300]] } };
  }
  return scenes;
}

function pillarsRow(b) {
  for (let x = 172; x < 470; x += 56) {
    b.rect(x, 70, 6, 44, C.RED);
    b.rect(x, 70, 2, 44, C.RED_L);
  }
  b.rect(166, 110, 308, 4, C.JADE);
}

// runtime props exported as separate images
export function buildProps() {
  const props = {};
  // 折子 (folded memorial) — one per state colour
  const zhezi = (band) => {
    const b = new Bitmap(14, 18);
    b.rect(1, 1, 12, 16, C.PAPER);
    b.rect(1, 1, 12, 4, band);
    b.hline(1, 12, 5, C.GOLD_D);
    for (let y = 8; y < 16; y += 2) b.hline(3, 10, y, C.STONE_L);
    b.vline(12, 1, 16, C.STONE_L);
    b.outline(C.INK);
    return b;
  };
  const bands = { pending: C.STONE, taizi: C.GOLD, zhongshu: C.PUR, menxia: C.RED, assigned: C.BLU, doing: C.RED_L, review: C.TEAL, done: C.GRN, blocked: C.BLACK, cancelled: C.STONE_D };
  for (const [k, v] of Object.entries(bands)) props[`zhezi_${k}`] = zhezi(v);
  // presented memorial scroll (奏折 in hands)
  {
    const b = new Bitmap(20, 10);
    b.rect(1, 2, 18, 6, C.PAPER);
    b.rect(1, 1, 3, 8, C.GOLD);
    b.rect(16, 1, 3, 8, C.GOLD);
    b.hline(4, 15, 4, C.RED);
    b.outline(C.INK);
    props.scroll = b;
  }
  // 障扇 ceremonial fan on a pole
  {
    const b = new Bitmap(24, 60);
    b.vline(12, 20, 59, C.WOOD);
    b.ellipse(12, 12, 11, 11, C.RED);
    b.ellipse(12, 12, 8, 8, C.GOLD);
    b.ellipse(12, 12, 4, 4, C.RED);
    b.set(12, 12, C.GOLD_L);
    b.outline(C.INK);
    props.fan = b;
  }
  // notice sheet
  {
    const b = new Bitmap(40, 30);
    b.rect(0, 0, 40, 30, C.PAPER);
    b.rect(0, 0, 40, 5, C.RED);
    for (let y = 8; y < 28; y += 3) b.hline(3, 36, y, C.STONE_L);
    b.ellipse(33, 23, 4, 4, C.RED);
    props.notice = b;
  }
  // 朱印 seal
  {
    const b = new Bitmap(12, 12);
    b.rect(0, 0, 12, 12, C.RED);
    b.rect(2, 2, 8, 8, C.RED_L);
    b.rect(4, 4, 4, 4, C.RED);
    props.seal = b;
  }
  // brush-writing indicator (think/work)
  {
    const b = new Bitmap(10, 10);
    b.line(1, 8, 8, 1, C.WOOD);
    b.set(1, 8, C.BLACK);
    b.set(2, 9, C.BLACK);
    b.outline(C.INK);
    props.brush = b;
  }
  // writing desk 书案 (drawn above seated officials so they sit behind it)
  {
    const b = new Bitmap(64, 26);
    desk(b, 2, 10, 60);
    b.outline(C.INK);
    props.desk = b;
  }
  // cloud
  {
    const b = new Bitmap(56, 16);
    b.ellipse(20, 9, 18, 5, C.SKY_L);
    b.ellipse(34, 6, 12, 5, C.SKY_L);
    b.ellipse(14, 6, 7, 4, C.SKY_L);
    props.cloud = b;
  }
  // selection ring (drawn at feet)
  {
    const b = new Bitmap(28, 10);
    for (let a = 0; a < 64; a++) {
      const x = 14 + Math.round(Math.cos((a / 64) * Math.PI * 2) * 12);
      const y = 5 + Math.round(Math.sin((a / 64) * Math.PI * 2) * 3);
      b.set(x, y, C.GOLD_L);
    }
    props.ring = b;
  }
  return props;
}
