// Procedural Tang-style court scenes (2× detail): 1280×720 backgrounds shown at half scale over the
// 640×360 world. Reference points (all Tang, not Ming/Qing): 太极宫承天门 / 大明宫含元殿 —
// rammed-earth gate platform faced with brick, flat-lintel (过梁式) gate passages, 阙楼 on stepped
// bases, hip roofs with gentle slopes, deep eaves, big 斗拱 and 鸱尾 at the ridge ends, grey tiles
// with green-glazed edges, 朱柱粉壁 (vermilion columns, white plaster walls), 直棂窗, 七朱八白 beams,
// 莲花柱础 and 莲花纹方砖, 宝帐 over the 御床, 青绿山水 screens, 灯树 and 博山炉.
import { Bitmap, C, rng } from './raster.mjs';

export const SW = 1280;
export const SH = 720;
export const SCALE = 2; // px per world unit

// ───────────────────────── texture helpers ─────────────────────────
function noise(b, x, y, w, h, colors, density, seed) {
  const r = rng(seed);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) if (r() < density) b.set(x + i, y + j, colors[Math.floor(r() * colors.length)]);
}
function ditherBand(b, x, y, w, h, c, step = 2, phase = 0) {
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) if ((i + j + phase) % step === 0) b.set(x + i, y + j, c);
}
/** vertical gradient made of solid bands with dithered seams */
function gradient(b, x, y, w, h, colors) {
  const n = colors.length;
  const bh = h / n;
  for (let k = 0; k < n; k++) {
    const y0 = Math.round(y + k * bh), y1 = Math.round(y + (k + 1) * bh);
    b.rect(x, y0, w, y1 - y0, colors[k]);
    if (k + 1 < n) ditherBand(b, x, y1 - 3, w, 3, colors[k + 1], 2);
    if (k + 1 < n) ditherBand(b, x, y1 - 6, w, 3, colors[k + 1], 4);
  }
}
function frameRect(b, x, y, w, h, c) {
  b.hline(x, x + w - 1, y, c);
  b.hline(x, x + w - 1, y + h - 1, c);
  b.vline(x, y, y + h - 1, c);
  b.vline(x + w - 1, y, y + h - 1, c);
}

// ───────────────────────── architecture ─────────────────────────
/** vermilion round column with a lotus (覆盆) base and a 栌斗 cap */
export function column(b, x, top, bottom, w = 28, base = true) {
  b.rect(x, top, w, bottom - top, C.RED);
  b.rect(x + 3, top, 4, bottom - top, C.RED_L);
  b.rect(x + 2, top, 1, bottom - top, C.RED);
  b.rect(x + w - 9, top, 5, bottom - top, C.RED_M);
  b.rect(x + w - 4, top, 4, bottom - top, C.RED_D);
  b.vline(x, top, bottom - 1, C.RED_D);
  // cap
  b.rect(x - 4, top - 10, w + 8, 10, C.WOOD);
  b.hline(x - 4, x + w + 3, top - 10, C.WOOD_L);
  b.rect(x - 4, top - 3, w + 8, 3, C.BROWN);
  if (base) {
    // lotus base: stone disc with petals
    const cx = x + w / 2;
    b.rect(x - 8, bottom - 4, w + 16, 6, C.STONE);
    b.hline(x - 8, x + w + 7, bottom - 4, C.STONE_L);
    b.hline(x - 8, x + w + 7, bottom + 1, C.STONE_D);
    b.ellipse(cx, bottom - 5, w / 2 + 6, 5, C.STONE_L);
    for (let i = -3; i <= 3; i++) {
      const px = Math.round(cx + i * (w / 7 + 1));
      b.ellipse(px, bottom - 5, 3, 3, C.JADE);
      b.set(px + 1, bottom - 3, C.STONE);
    }
    b.hline(x - 2, x + w + 1, bottom - 9, C.STONE);
  }
}

/** 七朱八白: a red beam with evenly spaced white panels */
export function qizhuBeam(b, x0, x1, y, h = 14) {
  b.rect(x0, y, x1 - x0, h, C.RED);
  b.hline(x0, x1 - 1, y, C.RED_L);
  b.hline(x0, x1 - 1, y + h - 1, C.RED_D);
  b.hline(x0, x1 - 1, y + h - 2, C.RED_M);
  for (let x = x0 + 10; x + 22 < x1; x += 34) {
    b.rect(x, y + 4, 22, h - 8, C.JADE);
    b.hline(x, x + 21, y + h - 5, C.PLASTER_S);
  }
}

/** row of Tang bracket sets (斗拱) */
export function dougongRow(b, x0, x1, y, spacing = 64) {
  b.rect(x0, y + 26, x1 - x0, 6, C.BROWN);
  b.hline(x0, x1 - 1, y + 26, C.WOOD);
  for (let x = x0 + spacing / 2; x < x1; x += spacing) dougong(b, Math.round(x), y);
  b.rect(x0, y - 4, x1 - x0, 5, C.DBROWN);
}
function dougong(b, cx, y) {
  // 栌斗
  b.rect(cx - 7, y + 18, 14, 8, C.WOOD);
  b.hline(cx - 7, cx + 6, y + 18, C.WOOD_L);
  b.rect(cx - 5, y + 24, 10, 2, C.BROWN);
  // 华拱 + 泥道拱 (curved arms)
  for (let i = -18; i <= 18; i++) {
    const yy = y + 14 + Math.round((i * i) / 90);
    b.vline(cx + i, yy - 4, yy, C.RED);
    b.set(cx + i, yy - 4, C.RED_L);
    b.set(cx + i, yy, C.RED_D);
  }
  // small 斗 on the arms
  for (const dx of [-17, 0, 17]) {
    b.rect(cx + dx - 4, y + 4, 8, 6, C.TEAL);
    b.hline(cx + dx - 4, cx + dx + 3, y + 4, C.SKY);
    b.hline(cx + dx - 4, cx + dx + 3, y + 9, C.BLU_D);
  }
  // upper 令拱
  for (let i = -12; i <= 12; i++) {
    const yy = y + 2 + Math.round((i * i) / 70);
    b.vline(cx + i, yy - 3, yy, C.GRN);
    b.set(cx + i, yy - 3, C.GRN_L);
  }
}

/** 平棊 coffered ceiling band */
export function coffers(b, x0, x1, y, h, cell = 32) {
  b.rect(x0, y, x1 - x0, h, C.DEEP);
  for (let x = x0; x < x1; x += cell) {
    for (let yy = y + 2; yy + cell / 2 < y + h; yy += cell) {
      const cx = x + cell / 2, cy = yy + cell / 2 - 2;
      b.rect(x + 2, yy, cell - 4, cell - 4, C.GRN_D);
      frameRect(b, x + 2, yy, cell - 4, cell - 4, C.GOLD_D);
      b.ellipse(cx, cy, 8, 8, C.TEAL);
      b.ellipse(cx, cy, 6, 6, C.RED);
      for (let a = 0; a < 8; a++) b.set(cx + Math.round(Math.cos(a * 0.785) * 7), cy + Math.round(Math.sin(a * 0.785) * 7), C.GOLD);
      b.ellipse(cx, cy, 2, 2, C.GOLD_L);
    }
  }
}

/** white plaster wall panel framed with red posts and rails */
export function plaster(b, x, y, w, h) {
  b.rect(x, y, w, h, C.JADE);
  b.rect(x, y + h - 10, w, 10, C.PLASTER_S);
  ditherBand(b, x, y + h - 16, w, 6, C.PLASTER_S, 2);
  b.rect(x, y, w, 3, C.PLASTER_S);
  noise(b, x, y, w, h - 12, [C.PAPER], 0.02, x * 7 + y);
}

/** 直棂窗: vertical wooden bars with light behind */
export function zhilingWindow(b, x, y, w, h, lit = true) {
  b.rect(x - 6, y - 6, w + 12, h + 12, C.RED_D);
  b.rect(x - 4, y - 4, w + 8, h + 8, C.RED);
  b.hline(x - 4, x + w + 3, y - 4, C.RED_L);
  b.rect(x, y, w, h, lit ? C.GLOW : C.PAPER);
  ditherBand(b, x, y + h - 10, w, 10, C.PAPER, 2);
  for (let i = 0; i < w; i += 8) {
    b.rect(x + i, y, 4, h, C.WOOD);
    b.vline(x + i, y, y + h - 1, C.WOOD_L);
    b.vline(x + i + 3, y, y + h - 1, C.BROWN);
  }
  b.rect(x, y + Math.round(h / 3), w, 3, C.BROWN);
  b.rect(x, y + Math.round((2 * h) / 3), w, 3, C.BROWN);
}

/** floor of square grey bricks (方砖), lotus-patterned tiles (莲花纹方砖) on a regular grid */
export function brickFloor(b, x0, y0, x1, y1, size = 32, seed = 1) {
  const r = rng(seed);
  b.rect(x0, y0, x1 - x0, y1 - y0, C.STONE_D);
  for (let y = y0, row = 0; y < y1; y += size, row++)
    for (let x = x0 - ((row % 2) * size) / 2, col = 0; x < x1; x += size, col++) {
      const v = r();
      const c = v < 0.06 ? C.FLOOR : v < 0.9 ? C.STONE_D : C.FLOOR_D;
      b.rect(x + 1, y + 1, size - 2, size - 2, c);
      b.hline(x + 2, x + size - 3, y + 1, c === C.FLOOR ? C.FLOOR_L : C.STONE);
      b.hline(x, x + size - 1, y + size - 1, C.BLACK);
      b.vline(x + size - 1, y, y + size - 1, C.BLACK);
      if (row % 2 === 1 && col % 3 === 1 && c === C.STONE_D) lotusTile(b, Math.round(x + size / 2), Math.round(y + size / 2), Math.round(size / 2 - 4));
    }
}
function lotusTile(b, cx, cy, r) {
  for (let a = 0; a < 8; a++) {
    const px = cx + Math.round(Math.cos((a * Math.PI) / 4) * (r - 4));
    const py = cy + Math.round(Math.sin((a * Math.PI) / 4) * (r - 4));
    b.ellipse(px, py, 2, 2, C.STONE);
    b.set(px, py, C.STONE_D);
  }
  b.ellipse(cx, cy, 3, 3, C.STONE);
  b.set(cx, cy, C.STONE_L);
}
export function woodFloor(b, x0, y0, x1, y1, seed = 3) {
  const r = rng(seed);
  b.rect(x0, y0, x1 - x0, y1 - y0, C.BROWN);
  for (let y = y0; y < y1; y += 14) {
    b.hline(x0, x1 - 1, y, C.DBROWN);
    b.hline(x0, x1 - 1, y + 1, C.WOOD);
    let x = x0 - Math.floor(r() * 120);
    while (x < x1) {
      const L = 90 + Math.floor(r() * 110);
      b.vline(x, y, y + 13, C.DBROWN);
      for (let k = 0; k < 4; k++) b.hline(x + 6 + Math.floor(r() * (L - 30)), x + 14 + Math.floor(r() * (L - 30)), y + 4 + Math.floor(r() * 8), C.DBROWN);
      x += L;
    }
  }
}
/** reed mat (席) */
export function mat(b, x, y, w, h) {
  b.rect(x, y, w, h, C.GOLD_D);
  for (let j = 0; j < h; j += 3) b.hline(x, x + w - 1, y + j, C.WOOD);
  for (let i = 0; i < w; i += 6) for (let j = 0; j < h; j += 6) b.set(x + i + ((j / 6) % 2) * 3, y + j + 1, C.BRONZE);
  frameRect(b, x, y, w, h, C.RED_D);
  frameRect(b, x + 1, y + 1, w - 2, h - 2, C.CRIMSON);
}

/** central carpet with a gold 宝相花 border */
export function carpet(b, x, y, w, h) {
  b.rect(x, y, w, h, C.RED);
  b.rect(x, y, 6, h, C.GOLD_D);
  b.rect(x + w - 6, y, 6, h, C.GOLD_D);
  b.vline(x + 7, y, y + h - 1, C.GOLD);
  b.vline(x + w - 8, y, y + h - 1, C.GOLD);
  for (let yy = y + 20; yy < y + h; yy += 44) {
    const cx = x + w / 2;
    b.ellipse(cx, yy, 12, 10, C.RED_M);
    for (let a = 0; a < 6; a++) b.ellipse(cx + Math.round(Math.cos(a * 1.047) * 9), yy + Math.round(Math.sin(a * 1.047) * 7), 3, 3, C.GOLD);
    b.ellipse(cx, yy, 4, 3, C.GOLD_L);
    b.set(cx, yy, C.RED);
  }
  for (let yy = y; yy < y + h; yy += 6) { b.set(x + 2, yy, C.GOLD); b.set(x + w - 3, yy + 3, C.GOLD); }
  ditherBand(b, x + 8, y, w - 16, h, C.RED_M, 7);
}

/** 钩阑: red wooden balustrade with gold-capped posts */
export function goulan(b, x0, x1, y, h = 22) {
  b.rect(x0, y + h - 5, x1 - x0, 5, C.RED);
  b.hline(x0, x1 - 1, y + h - 5, C.RED_L);
  b.rect(x0, y + 2, x1 - x0, 4, C.RED);
  b.hline(x0, x1 - 1, y + 2, C.RED_L);
  b.hline(x0, x1 - 1, y + 5, C.RED_D);
  for (let x = x0 + 8; x < x1 - 4; x += 12) {
    b.rect(x, y + 6, 3, h - 11, C.RED_M);
    b.set(x, y + 6, C.RED);
  }
  for (const x of [x0, x1 - 6]) {
    b.rect(x, y - 4, 6, h + 4, C.RED);
    b.vline(x, y - 4, y + h - 1, C.RED_L);
    b.rect(x - 1, y - 7, 8, 4, C.GOLD);
    b.set(x, y - 7, C.GOLD_L);
  }
  for (let x = x0 + 40; x < x1 - 30; x += 60) {
    b.rect(x, y - 2, 5, h + 2, C.RED);
    b.vline(x, y - 2, y + h - 1, C.RED_L);
    b.rect(x - 1, y - 5, 7, 3, C.GOLD);
  }
}

/** folding screen with a 青绿山水 painting */
export function landscapeScreen(b, x, y, w, h, panels = 5) {
  b.rect(x - 6, y - 6, w + 12, h + 12, C.GOLD_D);
  b.rect(x - 4, y - 4, w + 8, h + 8, C.GOLD);
  b.hline(x - 4, x + w + 3, y - 4, C.GOLD_L);
  b.rect(x, y, w, h, C.PAPER);
  const r = rng(77);
  // mist + mountains in three layers
  gradient(b, x, y, w, Math.round(h * 0.5), [C.PAPER, C.SKY_L]);
  const ridge = (baseY, amp, col, colHi, seed) => {
    const rr = rng(seed);
    let peak = 0;
    const tops = [];
    for (let i = 0; i < w; i++) {
      if (i % 26 === 0) peak = amp * (0.4 + rr() * 0.6);
      const t = (i % 26) / 26;
      tops.push(Math.round(baseY - peak * Math.sin(t * Math.PI)));
    }
    for (let i = 0; i < w; i++) {
      b.vline(x + i, tops[i], y + h - 1, col);
      b.set(x + i, tops[i], colHi);
      if (i > 0 && tops[i] < tops[i - 1]) b.set(x + i, tops[i] + 1, colHi);
    }
  };
  ridge(y + h * 0.55, h * 0.35, C.TEAL, C.SKY, 5);
  ridge(y + h * 0.75, h * 0.38, C.GRN, C.GRN_L, 9);
  ridge(y + h * 0.95, h * 0.3, C.GRN_D, C.GRN, 13);
  // pines, a pavilion, a red sun
  for (let k = 0; k < 9; k++) {
    const px = x + 8 + Math.floor(r() * (w - 16));
    const py = y + Math.round(h * (0.6 + r() * 0.3));
    b.vline(px, py, py + 6, C.DBROWN);
    b.ellipse(px, py, 3, 2, C.GRN_D);
  }
  b.ellipse(x + w - 30, y + 18, 7, 7, C.RED);
  b.ellipse(x + w - 30, y + 18, 5, 5, C.RED_L);
  // panel seams
  for (let k = 1; k < panels; k++) {
    const sx = x + Math.round((w * k) / panels);
    b.vline(sx, y, y + h - 1, C.GOLD_D);
    b.vline(sx + 1, y, y + h - 1, C.GOLD);
  }
  b.rect(x - 6, y + h + 6, w + 12, 8, C.DBROWN);
  b.hline(x - 6, x + w + 5, y + h + 6, C.WOOD);
}

/** 宝帐: canopy with tied-back curtains above the throne */
export function canopy(b, x, y, w, h) {
  // top frame & valance
  b.rect(x - 8, y, w + 16, 12, C.GOLD_D);
  b.rect(x - 8, y + 2, w + 16, 6, C.GOLD);
  b.hline(x - 8, x + w + 7, y + 2, C.GOLD_L);
  for (let i = 0; i < w + 16; i += 16) {
    b.ellipse(x - 8 + i + 8, y + 16, 8, 6, C.RED);
    b.ellipse(x - 8 + i + 8, y + 14, 8, 4, C.RED_L);
    b.vline(x - 8 + i + 8, y + 20, y + 30, C.GOLD);
    b.set(x - 8 + i + 8, y + 31, C.RED_L);
  }
  // curtains gathered at the sides
  for (const [cx, dir] of [[x + 6, 1], [x + w - 6, -1]]) {
    for (let yy = y + 12; yy < y + h; yy++) {
      const t = (yy - y) / h;
      const half = Math.round(14 - 9 * Math.sin(Math.min(1, t * 1.4) * Math.PI * 0.55));
      for (let i = -half; i <= half; i++) b.set(cx + i, yy, Math.abs(i) > half - 2 ? C.RED_D : (i + yy) % 7 === 0 ? C.RED_M : C.RED);
      b.set(cx - half * dir, yy, C.RED_L);
    }
    // tie
    b.rect(cx - 8, y + Math.round(h * 0.55), 16, 4, C.GOLD);
    b.set(cx, y + Math.round(h * 0.55) + 5, C.GOLD_L);
    b.vline(cx, y + Math.round(h * 0.55) + 4, y + Math.round(h * 0.55) + 18, C.GOLD);
  }
}

/** 御床: low throne couch with an armrest (凭几) */
export function throneCouch(b, cx, y) {
  // y = seat line (where the seated emperor's knees rest)
  b.rect(cx - 52, y - 4, 104, 10, C.RED);
  b.hline(cx - 52, cx + 51, y - 4, C.RED_L);
  b.rect(cx - 56, y + 6, 112, 18, C.RED_D);
  b.rect(cx - 54, y + 8, 108, 14, C.RED_M);
  for (let x = cx - 46; x < cx + 46; x += 23) {
    b.rect(x, y + 10, 18, 10, C.GOLD_D);
    b.rect(x + 2, y + 12, 14, 6, C.GOLD);
    b.ellipse(x + 9, y + 15, 3, 2, C.GOLD_L);
  }
  b.hline(cx - 56, cx + 55, y + 6, C.GOLD);
  // carved legs
  for (const x of [cx - 56, cx + 46]) { b.rect(x, y + 24, 10, 8, C.DBROWN); b.rect(x + 2, y + 24, 6, 6, C.BROWN); }
  // back screen of the couch
  b.rect(cx - 50, y - 42, 100, 40, C.DBROWN);
  b.rect(cx - 46, y - 38, 92, 32, C.RED_D);
  for (let i = 0; i < 4; i++) b.rect(cx - 42 + i * 22, y - 34, 18, 24, C.CRIMSON);
  b.hline(cx - 50, cx + 49, y - 42, C.GOLD);
  b.rect(cx - 54, y - 48, 108, 6, C.GOLD_D);
  b.hline(cx - 54, cx + 53, y - 48, C.GOLD_L);
  // cushion
  b.ellipse(cx, y - 2, 30, 5, C.GOLD);
  b.hline(cx - 26, cx + 26, y - 5, C.GOLD_L);
}

/** stone dais (御阶) with central steps */
export function dais(b, cx, top, w, h) {
  b.rect(cx - w / 2, top, w, h, C.STONE);
  b.hline(cx - w / 2, cx + w / 2 - 1, top, C.STONE_L);
  b.rect(cx - w / 2, top + h - 6, w, 6, C.STONE_D);
  for (let x = cx - w / 2 + 4; x < cx + w / 2; x += 40) { b.rect(x, top + 8, 34, h - 18, C.STONE_L); b.rect(x + 2, top + 10, 30, h - 22, C.STONE); }
  // steps
  const sw = 92;
  for (let k = 0; k < Math.floor(h / 8); k++) {
    const y = top + k * 8;
    b.rect(cx - sw / 2, y, sw, 8, k % 2 ? C.STONE_L : C.JADE);
    b.hline(cx - sw / 2, cx + sw / 2 - 1, y + 7, C.STONE);
  }
  b.rect(cx - sw / 2 - 6, top, 6, h, C.STONE_D);
  b.rect(cx + sw / 2, top, 6, h, C.STONE_D);
  // 龙尾道 relief in the middle of the steps
  b.rect(cx - 10, top, 20, h, C.STONE_L);
  for (let y = top + 4; y < top + h; y += 10) b.ellipse(cx, y, 6, 3, C.STONE);
}

/** 灯树 — standing bronze lamp tree (flames are runtime sprites) */
export function lampTree(b, cx, bottom, h = 110) {
  b.ellipse(cx, bottom - 3, 16, 5, C.BRONZE);
  b.ellipse(cx, bottom - 5, 12, 4, C.GOLD_D);
  b.rect(cx - 2, bottom - h, 5, h - 4, C.BRONZE);
  b.vline(cx - 2, bottom - h, bottom - 5, C.GOLD);
  for (const [k, y] of [[0, bottom - h + 6], [1, bottom - h + 34], [2, bottom - h + 62]]) {
    const span = 14 + k * 8;
    for (const s of [-1, 1]) {
      b.line(cx, y + 8, cx + s * span, y, C.BRONZE);
      b.line(cx, y + 9, cx + s * span, y + 1, C.GOLD_D);
      b.rect(cx + s * span - 3, y - 2, 7, 3, C.GOLD);
    }
  }
  b.rect(cx - 3, bottom - h - 3, 7, 3, C.GOLD);
}
export const LAMP_CUPS = (cx, bottom, h = 110) => {
  const out = [[cx, bottom - h - 4]];
  for (const [k, y] of [[0, bottom - h + 6], [1, bottom - h + 34], [2, bottom - h + 62]]) for (const s of [-1, 1]) out.push([cx + s * (14 + k * 8), y - 3]);
  return out;
};

/** 博山炉 — bronze incense burner with a mountain-shaped lid on a stand */
export function boshanlu(b, cx, bottom) {
  b.ellipse(cx, bottom - 3, 18, 5, C.BRONZE);
  b.ellipse(cx, bottom - 4, 14, 3, C.GOLD_D);
  b.rect(cx - 3, bottom - 22, 7, 18, C.BRONZE);
  b.vline(cx - 3, bottom - 22, bottom - 5, C.GOLD);
  b.ellipse(cx, bottom - 26, 14, 7, C.BRONZE);
  b.hline(cx - 13, cx + 13, bottom - 26, C.GOLD);
  // mountain lid
  b.poly([[cx - 13, bottom - 28], [cx - 8, bottom - 40], [cx - 4, bottom - 34], [cx, bottom - 48], [cx + 4, bottom - 36], [cx + 8, bottom - 42], [cx + 13, bottom - 28]], C.GOLD_D);
  b.line(cx - 8, bottom - 40, cx - 4, bottom - 34, C.GOLD);
  b.line(cx, bottom - 48, cx - 4, bottom - 34, C.GOLD);
  b.set(cx, bottom - 48, C.GOLD_L);
  for (const [x, y] of [[cx - 5, bottom - 31], [cx + 5, bottom - 32], [cx, bottom - 38]]) b.set(x, y, C.DEEP);
}

/** shelves full of scrolls seen end-on (轴头), 牙签 tags hanging from some */
export function scrollShelf(b, x, y, w, h, seed = 4) {
  const r = rng(seed);
  b.rect(x, y, w, h, C.DBROWN);
  b.rect(x + 3, y + 3, w - 6, h - 6, C.DEEP);
  const rows = Math.floor((h - 6) / 24);
  for (let k = 0; k < rows; k++) {
    const yy = y + 3 + k * 24;
    b.rect(x + 3, yy + 21, w - 6, 3, C.WOOD);
    b.hline(x + 3, x + w - 4, yy + 21, C.WOOD_L);
    // two stacked layers of rolled scrolls
    for (const [dy, off] of [[15, 0], [8, 5]]) {
      for (let i = x + 9 + off; i < x + w - 8; i += 10) {
        if (r() < (dy === 8 ? 0.35 : 0.08)) continue;
        const rim = [C.PAPER, C.PLASTER_S, C.GOLD_L, C.JADE][Math.floor(r() * 4)];
        b.ellipse(i, yy + dy, 4, 4, C.DBROWN);
        b.ellipse(i, yy + dy, 3, 3, rim);
        b.ellipse(i, yy + dy, 1, 1, [C.WOOD, C.RED_D, C.GRN_D][Math.floor(r() * 3)]);
        if (dy === 15 && r() < 0.5) { b.vline(i + 2, yy + 18, yy + 20, C.RED); b.set(i + 2, yy + 20, [C.RED_L, C.TEAL, C.GOLD][Math.floor(r() * 3)]); }
      }
    }
  }
  b.vline(x, y, y + h - 1, C.WOOD);
  b.hline(x, x + w - 1, y, C.WOOD_L);
}
/** low writing table (案) with inkstone, brushes and paper */
export function lowDesk(b, x, y, w = 120) {
  b.rect(x, y, w, 8, C.WOOD);
  b.hline(x, x + w - 1, y, C.WOOD_L);
  b.rect(x, y + 8, w, 4, C.BROWN);
  b.rect(x + 2, y + 2, w - 4, 2, C.WOOD_L);
  // curved legs
  for (const lx of [x + 6, x + w - 14]) {
    b.rect(lx, y + 12, 8, 14, C.DBROWN);
    b.rect(lx - 2, y + 24, 12, 3, C.DBROWN);
  }
  // paper, inkstone, brush rest
  b.rect(x + 18, y - 2, 34, 6, C.PAPER);
  b.hline(x + 18, x + 51, y + 3, C.STONE_L);
  b.rect(x + w - 40, y - 3, 14, 6, C.BLACK);
  b.rect(x + w - 38, y - 2, 6, 3, C.STONE_D);
  b.rect(x + w - 22, y - 3, 10, 3, C.BRONZE);
  for (let i = 0; i < 3; i++) b.vline(x + w - 20 + i * 3, y - 10, y - 4, C.WOOD);
}
/** hanging silk swags (帷幔) */
export function valance(b, x0, x1, y, color = C.RED, edge = C.GOLD) {
  for (let x = x0; x < x1; x += 40) {
    for (let i = 0; i < 40; i++) {
      const sag = Math.round(10 * Math.sin((i / 40) * Math.PI));
      b.vline(x + i, y, y + 6 + sag, color);
      b.set(x + i, y + 6 + sag, edge);
      b.set(x + i, y + 5 + sag, color === C.RED ? C.RED_D : C.PUR_D);
    }
    b.rect(x - 2, y, 4, 22, edge);
    b.set(x - 1, y + 22, C.RED_L);
  }
  b.rect(x0, y - 4, x1 - x0, 6, C.DBROWN);
}
export function pottedPlant(b, cx, bottom) {
  b.poly([[cx - 12, bottom - 18], [cx + 12, bottom - 18], [cx + 9, bottom], [cx - 9, bottom]], C.TEAL);
  b.hline(cx - 12, cx + 12, bottom - 18, C.SKY);
  b.vline(cx + 8, bottom - 17, bottom - 1, C.BLU_D);
  const r = rng(cx);
  b.line(cx, bottom - 18, cx - 6, bottom - 40, C.DBROWN);
  b.line(cx, bottom - 18, cx + 7, bottom - 34, C.DBROWN);
  for (let k = 0; k < 40; k++) {
    const a = r() * Math.PI * 2, d = r() * 10;
    b.set(cx - 6 + Math.round(Math.cos(a) * d), bottom - 42 + Math.round(Math.sin(a) * d * 0.6), r() < 0.3 ? C.GRN_L : C.GRN);
    b.set(cx + 7 + Math.round(Math.cos(a) * d * 0.8), bottom - 36 + Math.round(Math.sin(a) * d * 0.5), r() < 0.3 ? C.GRN_L : C.GRN_D);
  }
}

// ───────────────────────── exterior ─────────────────────────
/** hip roof (庑殿顶) with tile rows, eave tiles, ridge and 鸱尾 */
export function hipRoof(b, cx, eaveY, eaveHalf, ridgeY, ridgeHalf, o = {}) {
  const lift = o.lift ?? 6; // upturned corners
  const rows = [];
  for (let y = ridgeY; y <= eaveY; y++) {
    const t = (y - ridgeY) / (eaveY - ridgeY);
    // concave slope: half-width grows faster near the eaves
    const half = Math.round(ridgeHalf + (eaveHalf - ridgeHalf) * Math.pow(t, 0.75));
    rows.push([y, half]);
  }
  for (const [y, half] of rows) b.hline(cx - half, cx + half, y, C.TILE);
  // tile ridges (vertical rows converging)
  for (let k = -40; k <= 40; k++) {
    for (const [y, half] of rows) {
      const x = Math.round(cx + (k / 40) * half);
      if (k % 2 === 0) b.set(x, y, C.TILE_D);
      else if ((y + k) % 3 === 0) b.set(x, y, C.TILE_L);
    }
  }
  // hips (diagonal ridges)
  b.line(cx - ridgeHalf, ridgeY, cx - eaveHalf, eaveY - lift, C.TILE_D);
  b.line(cx + ridgeHalf, ridgeY, cx + eaveHalf, eaveY - lift, C.TILE_D);
  b.line(cx - ridgeHalf + 1, ridgeY, cx - eaveHalf + 1, eaveY - lift, C.TILE_L);
  // eave edge: green-glazed edge tiles (剪边) + 瓦当 row, corners lifted
  for (let x = cx - eaveHalf - 6; x <= cx + eaveHalf + 6; x++) {
    const d = Math.max(0, Math.abs(x - cx) - (eaveHalf - 40)) / 46;
    const yy = eaveY - Math.round(lift * d * d);
    b.vline(x, yy - 4, yy, C.GRN);
    b.set(x, yy - 4, C.GRN_L);
    b.set(x, yy + 1, C.TILE_D);
    if ((x - cx) % 6 === 0) { b.ellipse(x, yy + 2, 2, 2, C.TILE_L); b.set(x, yy + 2, C.TILE_D); }
  }
  // ridge
  b.rect(cx - ridgeHalf - 4, ridgeY - 7, ridgeHalf * 2 + 9, 8, C.TILE_D);
  b.hline(cx - ridgeHalf - 4, cx + ridgeHalf + 4, ridgeY - 7, C.TILE_L);
  b.hline(cx - ridgeHalf - 4, cx + ridgeHalf + 4, ridgeY - 5, C.GRN);
  // 鸱尾: tall curved fins at both ends of the ridge
  const fin = o.fin ?? 26;
  for (const s of [-1, 1]) {
    const fx = cx + s * (ridgeHalf + 2);
    for (let k = 0; k < fin; k++) {
      const w = Math.round(9 - (k / fin) * 6);
      const xx = fx + s * Math.round(Math.sin((k / fin) * 1.6) * 5) - s * Math.round((k * k) / (fin * 4));
      for (let i = 0; i < w; i++) b.set(xx + s * i, ridgeY - 6 - k, i === 0 ? C.TILE_L : i < w - 2 ? C.TILE_D : C.GRN_D);
    }
    // the fin curls inward at the top
    b.rect(fx - (s > 0 ? 4 : 0) - s * 6, ridgeY - 6 - fin, 5, 4, C.TILE_D);
    b.set(fx - s * 4, ridgeY - 6 - fin, C.GRN_L);
  }
}

/** tower hall body: red columns, white walls, 直棂窗, beam and brackets */
export function hallBody(b, x0, x1, top, bottom, bays = 7) {
  b.rect(x0, top, x1 - x0, bottom - top, C.JADE);
  b.rect(x0, bottom - 6, x1 - x0, 6, C.STONE_L);
  const bw = (x1 - x0) / bays;
  for (let k = 0; k < bays; k++) {
    const bx = Math.round(x0 + k * bw);
    if (k % 2 === 1 || k === Math.floor(bays / 2)) {
      // door / window bay
      b.rect(bx + 8, top + 18, Math.round(bw) - 14, bottom - top - 26, C.RED_D);
      for (let i = bx + 10; i < bx + bw - 8; i += 5) b.vline(i, top + 20, bottom - 10, C.RED);
    } else plaster(b, bx + 6, top + 16, Math.round(bw) - 10, bottom - top - 22);
  }
  for (let k = 0; k <= bays; k++) column(b, Math.round(x0 + k * bw) - 5, top + 12, bottom - 4, 10, false);
  qizhuBeam(b, x0 - 6, x1 + 6, top, 12);
}

/** stepped 阙楼 (que tower): 母阙 plus two lower 子阙, each a pavilion on a brick-faced base */
export function queTower(b, cx, base, s = 1) {
  const steps = [[cx + s * 92, 64, 0.72], [cx + s * 48, 34, 0.86], [cx, 0, 1]];
  for (const [x, drop, k] of steps) {
    const top = base - 150 + drop;
    const hw = Math.round(40 * k);
    brickBase(b, x - hw, top + 30, hw * 2, base - top - 30, 9 + drop);
    hallBody(b, x - hw + 8, x + hw - 8, top + 4, top + 30, 3);
    hipRoof(b, x, top + 6, hw + 14, top - 14, Math.round(hw * 0.45), { fin: 12, lift: 5 });
  }
}
function brickBase(b, x, y, w, h, seed) {
  b.rect(x, y, w, h, C.FLOOR_L);
  for (let yy = y; yy < y + h; yy += 6) {
    b.hline(x, x + w - 1, yy, C.FLOOR);
    for (let xx = x + ((yy / 6) % 2) * 6; xx < x + w; xx += 12) b.vline(xx, yy, yy + 5, C.FLOOR);
  }
  noise(b, x, y, w, h, [C.WOOD_L, C.FLOOR], 0.05, seed);
  b.rect(x, y, w, 4, C.STONE_L);
  b.vline(x + w - 1, y, y + h - 1, C.FLOOR_D);
  b.vline(x + w - 2, y, y + h - 1, C.FLOOR);
}
function mountainsFar(b, y, seed) {
  const r = rng(seed);
  let h1 = 20, h2 = 12;
  for (let x = 0; x < SW; x++) {
    if (x % 9 === 0) { h1 = Math.max(6, Math.min(48, h1 + (r() - 0.5) * 14)); h2 = Math.max(4, Math.min(30, h2 + (r() - 0.5) * 10)); }
    b.vline(x, Math.round(y - h1), y + 40, C.HILL_L);
    b.vline(x, Math.round(y + 14 - h2), y + 40, C.HILL);
  }
}
function cloudBank(b, x, y, w) {
  for (let i = 0; i < w; i += 14) { b.ellipse(x + i, y, 12, 5, C.SKY_L); b.ellipse(x + i + 7, y - 4, 8, 4, C.JADE); }
  b.hline(x - 10, x + w + 8, y + 4, C.SKY);
}
export function tree(b, cx, bottom, s = 1, seed = 1) {
  const r = rng(seed);
  const sc = (v) => Math.round(v * s);
  b.rect(cx - sc(5), bottom - sc(70), sc(10), sc(70), C.DBROWN);
  b.vline(cx - sc(5), bottom - sc(70), bottom - 1, C.BROWN);
  b.line(cx, bottom - sc(50), cx - sc(26), bottom - sc(86), C.DBROWN);
  b.line(cx, bottom - sc(56), cx + sc(24), bottom - sc(92), C.DBROWN);
  // foliage: overlapping clumps, dark underside, lit tops (light from top-left)
  const clumps = [];
  for (let k = 0; k < 9; k++) {
    const a = r() * Math.PI * 2, d = Math.sqrt(r()) * sc(34);
    clumps.push([cx + Math.round(Math.cos(a) * d * 1.3), bottom - sc(100) + Math.round(Math.sin(a) * d * 0.6), sc(16 + r() * 8)]);
  }
  clumps.sort((p, q) => p[1] - q[1]);
  for (const [x, y, rr] of clumps) b.ellipse(x, y + 3, rr, Math.round(rr * 0.7), C.GRN_D);
  for (const [x, y, rr] of clumps) b.ellipse(x - 1, y, rr - 2, Math.round(rr * 0.7) - 2, C.GRN);
  for (const [x, y, rr] of clumps) b.ellipse(x - Math.round(rr / 3), y - Math.round(rr / 4), Math.round(rr / 2), Math.round(rr / 3), C.GRN_L);
  for (let k = 0; k < 500 * s; k++) {
    const [x, y, rr] = clumps[Math.floor(r() * clumps.length)];
    const px = x + Math.round((r() - 0.5) * rr * 2), py = y + Math.round((r() - 0.5) * rr * 1.3);
    if (b.get(px, py) === C.GRN || b.get(px, py) === C.GRN_L) b.set(px, py, r() < 0.5 ? C.GRN_D : C.GRN_L);
  }
}
// ───────────────────────── scene composition ─────────────────────────
export function buildScenes() {
  const scenes = {};
  scenes.taihe = taihe();
  scenes.junjichu = junjichu();
  scenes.liubu = liubu();
  scenes.chengtian = chengtian();
  return scenes;
}

function lightShaft(b, x, y, w, h, slant) {
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const px = x + i + Math.round(j * slant);
    const v = b.get(px, y + j);
    if ((i + j) % 2 === 0 && v !== C.RED && v !== C.RED_D) {
      const lighter = { [C.STONE_D]: C.STONE, [C.FLOOR_D]: C.FLOOR, [C.FLOOR]: C.FLOOR_L, [C.STONE]: C.STONE_L, [C.BLACK]: C.STONE_D, [C.BROWN]: C.WOOD, [C.DBROWN]: C.BROWN, [C.RED_M]: C.RED };
      if (lighter[v] !== undefined) b.set(px, y + j, lighter[v]);
    }
  }
}

// 太和殿 (含元殿-style throne hall)
function taihe() {
  const b = new Bitmap(SW, SH);
  coffers(b, 0, SW, 0, 36);
  dougongRow(b, 0, SW, 40, 80);
  qizhuBeam(b, 0, SW, 72, 18);
  // back wall: plaster between posts
  plaster(b, 0, 90, SW, 210);
  for (const x of [0, 260, 1004, 1264]) b.rect(x, 90, 16, 210, C.RED_D);
  b.rect(0, 296, SW, 8, C.RED_D);
  b.hline(0, SW - 1, 296, C.RED);
  // tall windows on both sides
  zhilingWindow(b, 44, 118, 196, 150);
  zhilingWindow(b, 1040, 118, 196, 150);
  // throne backdrop: canopy + landscape screen
  landscapeScreen(b, 456, 108, 368, 150);
  canopy(b, 470, 88, 340, 190);
  // floor
  brickFloor(b, 0, 300, SW, SH, 40, 11);
  ditherBand(b, 0, 300, SW, 10, C.BLACK, 2);
  // dais + railings + throne couch
  dais(b, 640, 248, 520, 96);
  goulan(b, 380, 590, 226);
  goulan(b, 690, 900, 226);
  throneCouch(b, 640, 228);
  // carpet down the aisle
  carpet(b, 584, 344, 112, SH - 344);
  // light falling from the windows
  lightShaft(b, 60, 330, 160, 380, 0.55);
  lightShaft(b, 1060, 330, 160, 380, -0.55);
  // big columns (front pair reaches the bottom edge)
  column(b, 64, 92, SH + 10, 34, false);
  column(b, 1182, 92, SH + 10, 34, false);
  column(b, 300, 92, 500, 30);
  column(b, 950, 92, 500, 30);
  // lamp trees and incense burners by the dais
  lampTree(b, 372, 380);
  lampTree(b, 908, 380);
  boshanlu(b, 520, 372);
  boshanlu(b, 760, 372);
  return {
    bg: b,
    spots: {
      emperor: [320, 118],
      lamps: [...LAMP_CUPS(372, 380), ...LAMP_CUPS(908, 380)].map(([x, y]) => [x / 2, y / 2]),
      incense: [[260, 162], [380, 162]],
      lanterns: [[86, 4], [236, 4], [404, 4], [554, 4]],
      doors: { junjichu: [6, 200, 22, 90], liubu: [612, 200, 22, 90], chengtian: [270, 344, 100, 16] },
      desk: [320, 112],
    },
  };
}

// 军机处值房 (政事堂-style council room)
function junjichu() {
  const b = new Bitmap(SW, SH);
  // rafters + beam
  b.rect(0, 0, SW, 28, C.DEEP);
  for (let x = 6; x < SW; x += 24) { b.rect(x, 0, 10, 24, C.BROWN); b.vline(x, 0, 23, C.WOOD); b.ellipse(x + 5, 24, 5, 3, C.WOOD); }
  qizhuBeam(b, 0, SW, 22, 14);
  // wood panelled wall
  b.rect(0, 36, SW, 412, C.BROWN);
  for (let x = 0; x < SW; x += 80) { b.vline(x, 36, 447, C.DBROWN); b.vline(x + 1, 36, 447, C.WOOD); }
  b.hline(0, SW - 1, 446, C.DBROWN);
  // memorial board 折子墙: lacquer frame, gold corners, paper columns with red header bands
  b.rect(30, 44, 1220, 400, C.DEEP);
  b.rect(36, 50, 1208, 388, C.RED_D);
  b.rect(44, 56, 1192, 374, C.PAPER);
  noise(b, 44, 56, 1192, 374, [C.JADE, C.PLASTER_S], 0.03, 21);
  for (let k = 0; k < 8; k++) {
    const x = 48 + k * 148;
    b.rect(x, 60, 148, 32, k === 2 ? C.RED : C.CRIMSON);
    b.hline(x, x + 147, 60, C.RED_L);
    b.hline(x, x + 147, 91, C.GOLD_D);
    b.rect(x - 2, 60, 4, 368, C.WOOD);
    b.vline(x - 2, 60, 427, C.WOOD_L);
    // hooks for the slips
    for (let i = 0; i < 8; i++) b.set(x + 12, 106 + i * 40, C.BRONZE);
  }
  for (const [x, y] of [[30, 44], [1238, 44], [30, 432], [1238, 432]]) { b.rect(x, y, 12, 12, C.GOLD); b.rect(x + 2, y + 2, 8, 8, C.GOLD_D); b.set(x + 3, y + 3, C.GOLD_L); }
  b.rect(30, 432, 1220, 10, C.DBROWN);
  b.hline(30, 1249, 432, C.WOOD);
  // floor with mats
  woodFloor(b, 0, 448, SW, SH, 5);
  ditherBand(b, 0, 448, SW, 8, C.DEEP, 2);
  mat(b, 200, 590, 200, 60);
  mat(b, 560, 620, 200, 60);
  mat(b, 900, 590, 200, 60);
  // shelves of scrolls at the edges
  scrollShelf(b, 4, 470, 92, 180, 6);
  scrollShelf(b, 1184, 470, 92, 180, 8);
  pottedPlant(b, 1140, 700);
  boshanlu(b, 130, 700);
  return { bg: b, spots: { lanterns: [[90, 2], [550, 2]], incense: [[65, 340]], doors: { taihe: [280, 344, 80, 16] }, cat: [520, 336] } };
}

// 六部值房
function liubu() {
  const b = new Bitmap(SW, SH);
  b.rect(0, 0, SW, 24, C.DEEP);
  qizhuBeam(b, 0, SW, 14, 16);
  plaster(b, 0, 30, SW, 470);
  for (const x of [0, 352, 1264]) b.rect(x, 30, 16, 480, C.RED_D);
  b.rect(0, 480, SW, 30, C.RED_D);
  b.hline(0, SW - 1, 480, C.RED);
  valance(b, 0, SW, 30);
  zhilingWindow(b, 40, 130, 140, 300);
  // great frame around the live panel (DOM overlay sits at world 190,32 – 430×214)
  b.rect(366, 50, 880, 470, C.DEEP);
  b.rect(372, 56, 868, 456, C.GOLD_D);
  b.rect(376, 60, 860, 448, C.DBROWN);
  b.rect(380, 64, 860, 428, C.PAPER);
  for (let x = 372; x < 1240; x += 24) { b.set(x, 54, C.GOLD_L); b.set(x + 12, 514, C.GOLD_L); }
  b.rect(360, 44, 892, 10, C.GOLD);
  b.hline(360, 1251, 44, C.GOLD_L);
  b.rect(360, 512, 892, 10, C.GOLD);
  // plaque board above the official
  b.rect(60, 40, 240, 34, C.DEEP);
  b.rect(64, 44, 232, 26, C.BLU_D);
  frameRect(b, 66, 46, 228, 22, C.GOLD);
  // floor
  brickFloor(b, 0, 510, SW, SH, 36, 17);
  ditherBand(b, 0, 510, SW, 8, C.BLACK, 2);
  lightShaft(b, 60, 520, 120, 200, 0.5);
  scrollShelf(b, 18, 470, 74, 180, 9);
  return { bg: b, spots: { official: [130, 292], screen: [190, 32, 430, 214], plaque: [90, 31], doors: { taihe: [8, 300, 20, 56] }, deptProp: [250, 352] } };
}

// 承天门 (Tang palace gate)
function chengtian() {
  const b = new Bitmap(SW, SH);
  gradient(b, 0, 0, SW, 250, [C.SKY, C.SKY, C.SKY_L, C.JADE]);
  cloudBank(b, 40, 60, 160);
  cloudBank(b, 980, 44, 200);
  mountainsFar(b, 214, 31);
  // city walls stretching to both sides, with crenels
  for (const [x0, x1] of [[0, 300], [980, SW]]) {
    brickBase(b, x0, 252, x1 - x0, 230, x0 + 3);
    for (let x = x0; x < x1; x += 18) { b.rect(x, 240, 12, 14, C.FLOOR_L); b.hline(x, x + 11, 240, C.STONE_L); b.vline(x + 11, 240, 253, C.FLOOR); }
  }
  // que towers flanking the gate, standing on the wall line against the sky
  queTower(b, 186, 300, -1);
  queTower(b, 1094, 300, 1);
  // gate platform 城台
  brickBase(b, 290, 212, 700, 270, 41);
  b.rect(290, 206, 700, 8, C.STONE_L);
  // flat-lintel gate passages with wooden posts (排叉柱)
  for (const gx of [460, 640, 820]) {
    const w = gx === 640 ? 104 : 84, top = 330;
    b.poly([[gx - w / 2, 482], [gx - w / 2 + 6, top], [gx + w / 2 - 6, top], [gx + w / 2, 482]], C.DEEP);
    b.rect(gx - w / 2 + 10, top + 10, w - 20, 482 - top - 10, C.RED_D);
    b.rect(gx - w / 2 + 12, top + 12, (w - 24) / 2, 482 - top - 12, C.RED);
    b.vline(gx, top + 12, 481, C.DEEP);
    for (let y = top + 24; y < 476; y += 16) for (let x = gx - w / 2 + 18; x < gx + w / 2 - 14; x += 12) { b.set(x, y, C.GOLD); b.set(x + 1, y, C.GOLD_D); }
    for (const px of [gx - w / 2 + 2, gx + w / 2 - 8]) { b.rect(px, top, 6, 482 - top, C.WOOD); b.vline(px, top, 481, C.WOOD_L); }
    b.rect(gx - w / 2 - 2, top - 8, w + 4, 10, C.WOOD);
    b.hline(gx - w / 2 - 2, gx + w / 2 + 1, top - 8, C.WOOD_L);
  }
  // gate tower: platform rail, hall, double brackets, hip roof
  goulan(b, 300, 980, 188, 20);
  hallBody(b, 350, 930, 120, 210, 9);
  dougongRow(b, 330, 950, 92, 64);
  hipRoof(b, 640, 100, 360, 26, 190, { fin: 34, lift: 10 });
  // plaque 承天门 (text drawn at runtime)
  b.rect(596, 94, 88, 26, C.DEEP);
  b.rect(600, 98, 80, 18, C.BLU_D);
  frameRect(b, 600, 98, 80, 18, C.GOLD);
  // plaza: grey paving with the lighter imperial way
  b.rect(0, 482, SW, SH - 482, C.STONE_D);
  for (let y = 482; y < SH; y += 18) {
    b.hline(0, SW - 1, y, C.BLACK);
    for (let x = ((y / 18) % 2) * 24; x < SW; x += 48) b.vline(x, y, y + 17, C.BLACK);
  }
  noise(b, 0, 484, SW, SH - 484, [C.STONE, C.FLOOR_D], 0.06, 51);
  b.rect(572, 482, 136, SH - 482, C.STONE);
  for (let y = 482; y < SH; y += 18) b.hline(572, 707, y, C.STONE_D);
  b.vline(572, 482, SH - 1, C.STONE_L);
  b.vline(707, 482, SH - 1, C.STONE_L);
  ditherBand(b, 0, 482, SW, 10, C.BLACK, 2);
  // flag poles (cloth is animated at runtime)
  for (const fx of [300, 980]) { b.rect(fx - 2, 120, 4, 362, C.WOOD); b.vline(fx - 2, 120, 481, C.WOOD_L); b.rect(fx - 6, 470, 12, 12, C.STONE); b.ellipse(fx, 118, 4, 4, C.GOLD); }
  // trees at the edges
  tree(b, 24, 700, 1.2, 3);
  tree(b, 1262, 700, 1.2, 5);
  // notice pavilion 榜 (news text is drawn at runtime on the board: world 28,204 – 192×90)
  b.rect(48, 380, 400, 216, C.DBROWN);
  b.rect(56, 408, 384, 180, C.RED_D);
  b.rect(60, 412, 376, 172, C.CRIMSON);
  frameRect(b, 60, 412, 376, 172, C.GOLD_D);
  hipRoof(b, 248, 404, 230, 372, 170, { fin: 14, lift: 6 });
  for (const px of [68, 420]) { b.rect(px, 596, 12, 64, C.DBROWN); b.vline(px, 596, 659, C.BROWN); }
  // 登闻鼓 on its stand with a little roof
  b.rect(1078, 520, 10, 106, C.DBROWN);
  b.rect(1194, 520, 10, 106, C.DBROWN);
  hipRoof(b, 1141, 520, 92, 496, 48, { fin: 10, lift: 4 });
  b.ellipse(1136, 572, 38, 34, C.RED_D);
  b.ellipse(1136, 572, 34, 30, C.RED);
  b.ellipse(1136, 572, 26, 22, C.PAPER);
  b.ellipse(1136, 572, 24, 20, C.JADE);
  b.ellipse(1136, 572, 9, 8, C.RED_L);
  for (let a = 0; a < 16; a++) b.set(1136 + Math.round(Math.cos(a * 0.39) * 32), 572 + Math.round(Math.sin(a * 0.39) * 28), C.GOLD);
  b.line(1180, 548, 1200, 520, C.WOOD);
  b.ellipse(1201, 518, 4, 4, C.RED);
  return {
    bg: b,
    spots: {
      board: [28, 204, 192, 90],
      gate: [320, 236],
      drum: [568, 286],
      flags: [[151, 62], [491, 62]],
      wallTop: [[0, 119], [150, 119], [490, 119], [640, 119]],
      doors: { taihe: [298, 166, 44, 74] },
      lanterns: [],
    },
  };
}

// ───────────────────────── runtime props (separate images, 2× detail) ─────────────────────────
export function buildProps() {
  const props = {};
  // 折子 (folded memorial) — one per state colour
  const zhezi = (band) => {
    const b = new Bitmap(28, 36);
    b.rect(2, 2, 24, 32, C.PAPER);
    b.rect(2, 2, 24, 8, band);
    b.hline(2, 25, 2, C.JADE);
    b.hline(2, 25, 10, C.GOLD_D);
    b.hline(2, 25, 11, C.GOLD);
    for (let y = 16; y < 32; y += 4) b.hline(6, 21, y, C.STONE_L);
    b.vline(25, 2, 33, C.STONE_L);
    b.hline(2, 25, 33, C.STONE);
    b.outline(C.INK);
    return b;
  };
  const bands = { pending: C.STONE, taizi: C.GOLD, zhongshu: C.PUR, menxia: C.RED, assigned: C.BLU, doing: C.RED_L, review: C.TEAL, done: C.GRN, blocked: C.BLACK, cancelled: C.STONE_D };
  for (const [k, v] of Object.entries(bands)) props[`zhezi_${k}`] = zhezi(v);
  // presented memorial (奏折)
  {
    const b = new Bitmap(40, 20);
    b.rect(2, 4, 36, 12, C.PAPER);
    b.hline(2, 37, 15, C.STONE_L);
    b.rect(2, 2, 6, 16, C.GOLD);
    b.rect(32, 2, 6, 16, C.GOLD);
    b.vline(2, 2, 17, C.GOLD_L);
    b.hline(8, 31, 8, C.RED);
    b.hline(8, 31, 9, C.RED_D);
    b.outline(C.INK);
    props.scroll = b;
  }
  // 障扇 ceremonial fan on a pole
  {
    const b = new Bitmap(48, 120);
    b.rect(23, 40, 3, 80, C.WOOD);
    b.vline(23, 40, 119, C.WOOD_L);
    b.ellipse(24, 24, 22, 22, C.RED_D);
    b.ellipse(24, 24, 20, 20, C.RED);
    b.ellipse(24, 24, 15, 15, C.GOLD);
    b.ellipse(24, 24, 9, 9, C.RED);
    for (let a = 0; a < 12; a++) b.set(24 + Math.round(Math.cos(a * 0.52) * 12), 24 + Math.round(Math.sin(a * 0.52) * 12), C.GOLD_L);
    b.ellipse(24, 24, 3, 3, C.GOLD_L);
    b.outline(C.INK);
    props.fan = b;
  }
  // 朱印 seal mark
  {
    const b = new Bitmap(24, 24);
    b.rect(0, 0, 24, 24, C.RED);
    b.rect(3, 3, 18, 18, C.RED_L);
    b.rect(6, 6, 12, 12, C.RED);
    b.rect(9, 9, 6, 6, C.RED_L);
    props.seal = b;
  }
  // low desk 案 (drawn in front of seated clerks)
  {
    const b = new Bitmap(128, 52);
    lowDesk(b, 4, 18, 120);
    b.outline(C.INK);
    props.desk = b;
  }
  // clouds (drift at runtime)
  for (const [k, w] of [['cloud', 112], ['cloud2', 160]]) {
    const b = new Bitmap(w, 36);
    for (let i = 12; i < w - 12; i += 16) { b.ellipse(i, 22, 14, 8, C.SKY_L); b.ellipse(i + 8, 16, 10, 7, C.JADE); }
    b.hline(4, w - 5, 29, C.SKY);
    props[k] = b;
  }
  // selection ring
  {
    const b = new Bitmap(56, 20);
    for (let a = 0; a < 128; a++) b.set(28 + Math.round(Math.cos((a / 128) * Math.PI * 2) * 25), 10 + Math.round(Math.sin((a / 128) * Math.PI * 2) * 7), C.GOLD_L);
    props.ring = b;
  }
  // hanging silk lantern: frame 0 = unlit, 1 = lit (sheet 2 × 1)
  {
    const b = new Bitmap(64, 72);
    for (const [f, lit] of [[0, false], [1, true]]) {
      const ox = f * 32;
      b.vline(ox + 16, 0, 12, C.BLACK);
      b.rect(ox + 8, 12, 17, 4, C.GOLD_D);
      b.ellipse(ox + 16, 32, 12, 16, lit ? C.GLOW : C.RED_M);
      b.ellipse(ox + 16, 32, 10, 14, lit ? C.GOLD_L : C.RED);
      b.ellipse(ox + 14, 30, 5, 9, lit ? C.GLOW : C.RED_L);
      for (const dx of [-6, 0, 6]) b.vline(ox + 16 + dx, 18, 46, lit ? C.GOLD : C.RED_D);
      b.rect(ox + 8, 48, 17, 4, C.GOLD_D);
      b.vline(ox + 13, 52, 66, C.RED);
      b.vline(ox + 16, 52, 70, C.RED);
      b.vline(ox + 19, 52, 66, C.RED);
    }
    b.outline(C.INK);
    props.lantern = b;
  }
  // soft glow halo (drawn with additive blending)
  {
    const b = new Bitmap(96, 96);
    for (let y = 0; y < 96; y++) for (let x = 0; x < 96; x++) {
      const d = Math.hypot(x - 48, y - 48) / 48;
      if (d < 1 && (x + y) % 2 === 0 && d > 0.15 + ((x * 7 + y * 13) % 10) / 40) b.set(x, y, d < 0.5 ? C.GOLD : C.GOLD_D);
      else if (d <= 0.25) b.set(x, y, C.GLOW);
    }
    props.glow = b;
  }
  // lamp flame: 3 frames
  {
    const b = new Bitmap(24, 12);
    for (let f = 0; f < 3; f++) {
      const ox = f * 8;
      b.ellipse(ox + 4, 8, 2, 3, C.GOLD);
      b.set(ox + 4 + (f === 1 ? 1 : f === 2 ? -1 : 0), 4, C.GOLD_L);
      b.set(ox + 4, 5, C.GLOW);
      b.set(ox + 4, 7, C.GLOW);
      b.set(ox + 4 + (f - 1), 3, C.RED_L);
    }
    props.flame = b;
  }
  // incense smoke: 6 frames, 24×48 each
  {
    const b = new Bitmap(144, 48);
    for (let f = 0; f < 6; f++) {
      const ox = f * 24;
      for (let y = 46; y > 4; y--) {
        const t = (46 - y) / 42;
        const x = ox + 12 + Math.round(Math.sin(t * 6 + f * 1.05) * (2 + t * 5));
        const c = t < 0.5 ? C.STONE_L : t < 0.8 ? C.SKY_L : C.JADE;
        if ((y + f) % (t > 0.7 ? 3 : 1) === 0) b.set(x, y, c);
        if (t > 0.3 && (y + f) % 2 === 0) b.set(x + 1, y, c);
      }
    }
    props.smoke = b;
  }
  // banner (旌旗) waving: 4 frames 40×64
  {
    const b = new Bitmap(160, 64);
    for (let f = 0; f < 4; f++) {
      const ox = f * 40;
      for (let x = 0; x < 34; x++) {
        const wave = Math.round(Math.sin(x / 6 + f * 1.57) * (x / 10));
        const top = 4 + wave, bot = 48 + wave - Math.round(x / 8);
        b.vline(ox + 2 + x, top, bot, C.RED);
        b.set(ox + 2 + x, top, C.RED_L);
        b.set(ox + 2 + x, bot, C.RED_D);
        if (x > 6 && x < 26 && Math.abs(((top + bot) >> 1) - (26 + wave)) < 30) for (let y = top + 10; y < bot - 10; y++) if ((x + y) % 4 === 0) b.set(ox + 2 + x, y, C.GOLD);
        // tassels
        if (x % 6 === 0) b.vline(ox + 2 + x, bot + 1, bot + 5, C.GOLD);
      }
      b.rect(ox, 2, 3, 50, C.WOOD);
    }
    b.outline(C.INK);
    props.flag = b;
  }
  // cat: 8 frames 32×24 (walk ×4, sit ×2, jump ×2)
  {
    const b = new Bitmap(256, 24);
    const cat = (ox, pose, k) => {
      const body = C.WOOD_L, dark = C.BROWN, belly = C.PAPER;
      if (pose === 'sit') {
        b.ellipse(ox + 14, 16, 7, 6, body);
        b.ellipse(ox + 14, 18, 4, 4, belly);
        b.ellipse(ox + 16, 7, 5, 4, body);
        b.set(ox + 12, 3, body); b.set(ox + 13, 2, body); b.set(ox + 19, 3, body); b.set(ox + 20, 2, body);
        b.set(ox + 15, 7, k ? C.GOLD_D : C.BLACK); b.set(ox + 18, 7, k ? C.GOLD_D : C.BLACK);
        b.set(ox + 16, 9, C.PINK);
        b.line(ox + 7, 20, ox + 3, 14 + k, body);
        for (const x of [ox + 10, ox + 13, ox + 16]) b.set(x, 13, dark);
        return;
      }
      const lift = pose === 'jump' ? (k ? 6 : 2) : 0;
      b.ellipse(ox + 14, 14 - lift, 9, 4, body);
      b.ellipse(ox + 15, 16 - lift, 6, 2, belly);
      for (const x of [ox + 9, ox + 13, ox + 17]) b.vline(x, 11 - lift, 12 - lift, dark);
      b.ellipse(ox + 24, 10 - lift, 5, 4, body);
      b.set(ox + 21, 6 - lift, body); b.set(ox + 22, 5 - lift, body); b.set(ox + 26, 6 - lift, body); b.set(ox + 27, 5 - lift, body);
      b.set(ox + 25, 10 - lift, C.BLACK); b.set(ox + 28, 11 - lift, C.PINK);
      const legs = pose === 'jump' ? [[8, 19 - lift], [20, 19 - lift]] : k % 2 ? [[8, 21], [12, 20], [17, 21], [21, 20]] : [[9, 20], [11, 21], [18, 20], [20, 21]];
      for (const [x, y] of legs) b.vline(ox + x, 16 - lift, y, body);
      b.line(ox + 5, 13 - lift, ox + 1, 7 - lift + (k % 2), body);
    };
    for (let k = 0; k < 4; k++) cat(k * 32, 'walk', k);
    cat(128, 'sit', 0); cat(160, 'sit', 1);
    cat(192, 'jump', 0); cat(224, 'jump', 1);
    b.outline(C.INK);
    props.cat = b;
  }
  // bird: 3 frames 16×12
  {
    const b = new Bitmap(48, 12);
    for (let f = 0; f < 3; f++) {
      const ox = f * 16;
      b.ellipse(ox + 8, 6, 3, 2, C.DBROWN);
      b.set(ox + 11, 5, C.GOLD);
      const wy = f === 0 ? -4 : f === 1 ? 0 : 3;
      b.line(ox + 7, 5, ox + 2, 5 + wy, C.BLACK);
      b.line(ox + 8, 5, ox + 13, 5 + wy, C.BLACK);
    }
    props.bird = b;
  }
  // weather particles
  { const b = new Bitmap(2, 10); b.vline(1, 0, 9, C.SKY_L); b.vline(0, 3, 7, C.JADE); props.rain = b; }
  { const b = new Bitmap(4, 4); b.rect(1, 0, 2, 4, C.JADE); b.rect(0, 1, 4, 2, C.JADE); props.snow = b; }
  { const b = new Bitmap(6, 4); b.ellipse(3, 2, 2, 1, C.PINK); b.set(2, 2, C.JADE); props.petal = b; }
  // department furniture for 六部值房 (one per ministry)
  props.dept_hubu = deptProp('hubu');
  props.dept_libu = deptProp('libu');
  props.dept_bingbu = deptProp('bingbu');
  props.dept_xingbu = deptProp('xingbu');
  props.dept_gongbu = deptProp('gongbu');
  props.dept_libu_hr = deptProp('libu_hr');
  return props;
}

function deptProp(id) {
  const b = new Bitmap(220, 140);
  const table = (x, y, w) => { b.rect(x, y, w, 10, C.WOOD); b.hline(x, x + w - 1, y, C.WOOD_L); b.rect(x, y + 10, w, 4, C.BROWN); for (const lx of [x + 6, x + w - 14]) b.rect(lx, y + 14, 8, 22, C.DBROWN); };
  switch (id) {
    case 'hubu': {
      // ledgers, strings of cash, a big abacus on a stand
      table(10, 90, 140);
      for (let i = 0; i < 4; i++) { b.rect(20 + i * 4, 66 - i * 6, 40, 8, [C.BLU_D, C.BLU, C.PAPER, C.BLU_D][i]); b.hline(20 + i * 4, 59 + i * 4, 66 - i * 6, C.STONE_L); }
      for (let k = 0; k < 3; k++) for (let i = 0; i < 12; i++) { b.ellipse(80 + k * 18, 52 + i * 3, 4, 2, C.BRONZE); b.set(80 + k * 18, 52 + i * 3, C.DEEP); }
      b.rect(160, 40, 50, 60, C.DBROWN); b.rect(164, 44, 42, 52, C.WOOD_L);
      for (let i = 0; i < 6; i++) { b.vline(168 + i * 7, 44, 95, C.BROWN); for (let k = 0; k < 4; k++) b.rect(166 + i * 7, 60 + k * 7 + (i % 2) * 3, 5, 3, C.BLACK); }
      b.hline(164, 205, 56, C.DBROWN);
      b.rect(170, 100, 8, 36, C.DBROWN); b.rect(194, 100, 8, 36, C.DBROWN);
      break;
    }
    case 'libu': {
      // bronze bells (编钟) on a frame + a ritual 鼎
      b.rect(20, 20, 8, 116, C.DBROWN); b.rect(180, 20, 8, 116, C.DBROWN);
      b.rect(14, 16, 180, 8, C.RED); b.hline(14, 193, 16, C.RED_L);
      for (let i = 0; i < 6; i++) { const x = 40 + i * 24, h = 26 - i * 2; b.vline(x, 24, 30, C.BLACK); b.poly([[x - 7, 30], [x + 7, 30], [x + 9, 30 + h], [x - 9, 30 + h]], C.BRONZE); b.vline(x - 6, 31, 29 + h, C.GOLD); for (let y = 34; y < 28 + h; y += 5) b.hline(x - 5, x + 5, y, C.GOLD_D); }
      b.rect(14, 70, 180, 6, C.RED);
      b.ellipse(104, 118, 30, 14, C.BRONZE); b.rect(78, 100, 52, 18, C.BRONZE); b.hline(76, 131, 100, C.GOLD);
      for (const x of [84, 104, 124]) b.rect(x - 2, 128, 5, 10, C.GOLD_D);
      b.rect(80, 92, 6, 8, C.GOLD_D); b.rect(122, 92, 6, 8, C.GOLD_D);
      break;
    }
    case 'bingbu': {
      // sand table with flags + a weapon rack
      b.rect(10, 80, 140, 40, C.DBROWN); b.rect(14, 84, 132, 32, C.GOLD_L);
      noise(b, 14, 84, 132, 32, [C.GOLD, C.WOOD_L, C.GRN_L], 0.25, 61);
      b.poly([[40, 112], [60, 92], [80, 112]], C.GRN); b.poly([[90, 112], [104, 98], [120, 112]], C.GRN_D);
      for (const [x, y, c] of [[30, 96, C.RED], [70, 100, C.BLU], [112, 92, C.RED], [130, 106, C.BLU]]) { b.vline(x, y - 10, y, C.BLACK); b.rect(x + 1, y - 10, 6, 4, c); }
      for (const lx of [16, 138]) b.rect(lx, 120, 8, 16, C.DBROWN);
      b.rect(160, 20, 6, 116, C.DBROWN); b.rect(204, 20, 6, 116, C.DBROWN); b.rect(156, 60, 58, 5, C.WOOD); b.rect(156, 110, 58, 5, C.WOOD);
      for (let i = 0; i < 4; i++) { const x = 170 + i * 10; b.vline(x, 8, 134, C.WOOD_L); b.poly([[x, 0], [x + 3, 8], [x - 3, 8]], C.STONE_L); b.rect(x - 2, 10, 5, 3, C.RED); }
      break;
    }
    case 'xingbu': {
      // law scrolls + scales + a 獬豸 statue
      table(10, 92, 120);
      for (let i = 0; i < 5; i++) { b.ellipse(26 + i * 12, 84, 5, 5, C.PAPER); b.ellipse(26 + i * 12, 84, 2, 2, C.WOOD); b.vline(26 + i * 12, 89, 92, C.RED); }
      b.vline(96, 44, 92, C.GOLD_D); b.rect(90, 88, 13, 4, C.BRONZE);
      b.hline(78, 114, 46, C.GOLD_D);
      for (const x of [78, 114]) { b.line(x, 46, x - 6, 62, C.STONE); b.line(x, 46, x + 6, 62, C.STONE); b.hline(x - 7, x + 7, 63, C.BRONZE); }
      // 獬豸 (one-horned beast) on a plinth
      b.rect(150, 110, 60, 26, C.STONE); b.hline(150, 209, 110, C.STONE_L);
      b.ellipse(180, 92, 22, 14, C.TILE_D); b.ellipse(198, 72, 10, 10, C.TILE_D);
      b.line(200, 62, 208, 44, C.TILE_L); b.line(201, 62, 209, 44, C.TILE);
      b.set(202, 70, C.GOLD); for (const x of [164, 176, 188, 196]) b.rect(x, 100, 6, 10, C.TILE_D);
      b.line(158, 86, 150, 74, C.TILE_D);
      break;
    }
    case 'gongbu': {
      // drafting table with a building plan + a model pavilion
      b.poly([[10, 70], [150, 60], [154, 100], [14, 108]], C.WOOD);
      b.poly([[18, 72], [144, 64], [146, 96], [20, 102]], C.PAPER);
      for (let i = 0; i < 6; i++) b.line(30 + i * 18, 72 - i, 32 + i * 18, 98 - i, C.BLU);
      b.line(24, 86, 140, 78, C.BLU);
      b.rect(60, 78, 30, 14, C.BLU_D);
      for (const lx of [20, 140]) b.rect(lx, 104, 8, 32, C.DBROWN);
      b.rect(162, 104, 50, 32, C.STONE); b.hline(162, 211, 104, C.STONE_L);
      b.rect(170, 80, 34, 24, C.JADE); for (const x of [170, 186, 202]) b.rect(x, 80, 3, 24, C.RED);
      for (let y = 0; y < 18; y++) b.hline(160 + Math.round(y * 0.6), 214 - Math.round(y * 0.6), 80 - y, y % 3 ? C.TILE : C.TILE_D);
      b.hline(158, 216, 80, C.GRN);
      b.rect(176, 58, 22, 4, C.TILE_D);
      break;
    }
    case 'libu_hr': {
      // register cabinet with labelled drawers + a seal box
      b.rect(10, 20, 110, 116, C.DBROWN); b.rect(14, 24, 102, 108, C.WOOD);
      for (let r = 0; r < 5; r++) for (let c = 0; c < 3; c++) { const x = 18 + c * 33, y = 28 + r * 21; b.rect(x, y, 29, 17, C.BROWN); b.rect(x + 9, y + 3, 11, 6, C.PAPER); b.ellipse(x + 14, y + 13, 2, 1, C.GOLD); }
      table(130, 96, 84);
      for (let i = 0; i < 3; i++) { b.rect(140 + i * 22, 72 - i * 2, 18, 24 + i * 2, [C.BLU_D, C.RED_D, C.GRN_D][i]); b.rect(144 + i * 22, 76 - i * 2, 8, 12, C.PAPER); }
      b.rect(196, 82, 16, 14, C.RED_D); b.rect(198, 76, 12, 6, C.GOLD);
      break;
    }
  }
  b.outline(C.INK);
  return b;
}
