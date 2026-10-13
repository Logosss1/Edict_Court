// Shared helpers for the top-down (3/4 RPG view) court scenes. Same rules as the rest of the pixel
// pipeline: 1280×720 at 2× detail over the 640×360 world, Tang48 palette only, light from top-left.
// Spots returned by each scene are in WORLD units (pixels / 2).
import { Bitmap, C, rng } from '../raster.mjs';

export const W = 1280;
export const H = 720;
export { Bitmap, C, rng };

export function dith(b, x, y, w, h, c, step = 2, ph = 0) {
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) if ((i + j + ph) % step === 0) b.set(x + i, y + j, c);
}
export function frame(b, x, y, w, h, c) {
  b.hline(x, x + w - 1, y, c); b.hline(x, x + w - 1, y + h - 1, c); b.vline(x, y, y + h - 1, c); b.vline(x + w - 1, y, y + h - 1, c);
}

/** colour remaps used to shade or light whatever is already drawn */
export const DARK = {
  [C.STONE_D]: C.BLACK, [C.STONE]: C.STONE_D, [C.STONE_L]: C.STONE, [C.JADE]: C.STONE_L, [C.PAPER]: C.PLASTER_S, [C.FLOOR]: C.FLOOR_D, [C.FLOOR_D]: C.DEEP, [C.FLOOR_L]: C.FLOOR,
  [C.RED]: C.RED_M, [C.RED_M]: C.RED_D, [C.RED_L]: C.RED, [C.GOLD]: C.GOLD_D, [C.GOLD_L]: C.GOLD, [C.GOLD_D]: C.BROWN, [C.RED_D]: C.DEEP, [C.BLACK]: C.DEEP,
  [C.PLASTER_S]: C.STONE_L, [C.TILE]: C.TILE_D, [C.TILE_L]: C.TILE, [C.BRONZE]: C.BROWN, [C.GRN]: C.GRN_D, [C.GRN_L]: C.GRN, [C.WOOD]: C.BROWN, [C.WOOD_L]: C.WOOD, [C.BROWN]: C.DBROWN,
  [C.SKY]: C.TEAL, [C.TEAL]: C.BLU_D, [C.BLU]: C.BLU_D,
};
export const LIGHT = {
  [C.STONE_D]: C.STONE, [C.BLACK]: C.STONE_D, [C.STONE]: C.STONE_L, [C.FLOOR_D]: C.FLOOR, [C.FLOOR]: C.FLOOR_L, [C.RED_M]: C.RED, [C.RED]: C.RED_L, [C.RED_D]: C.RED_M,
  [C.GOLD_D]: C.GOLD, [C.GOLD]: C.GOLD_L, [C.GRN_D]: C.GRN, [C.GRN]: C.GRN_L, [C.BROWN]: C.WOOD, [C.WOOD]: C.WOOD_L, [C.DBROWN]: C.BROWN, [C.TILE_D]: C.TILE, [C.TILE]: C.TILE_L,
};
/** remap the colours inside a polygon (dither = 2 → checkerboard, for soft shadows / light) */
export function shade(b, pts, map = DARK, dither = 1) {
  const m = new Bitmap(b.w, b.h);
  m.poly(pts, 1);
  for (let y = 0; y < b.h; y++) for (let x = 0; x < b.w; x++) if (m.get(x, y) && (dither === 1 || (x + y) % dither === 0)) {
    const v = b.get(x, y);
    if (map[v] !== undefined) b.set(x, y, map[v]);
  }
}

/** big square floor bricks (金砖) seen from straight above, with a few lotus tiles */
export function brickFloorTD(b, x0, y0, x1, y1, { size = 40, seed = 21, lotus = true } = {}) {
  const r = rng(seed), S = size;
  b.rect(x0, y0, x1 - x0, y1 - y0, C.STONE_D);
  for (let y = y0, row = 0; y < y1; y += S, row++)
    for (let x = x0, col = 0; x < x1; x += S, col++) {
      const v = r();
      const c = v < 0.08 ? C.FLOOR_D : v < 0.93 ? C.STONE_D : C.FLOOR;
      b.rect(x + 1, y + 1, S - 2, S - 2, c);
      b.hline(x + 2, x + S - 4, y + 2, c === C.FLOOR ? C.FLOOR_L : C.STONE);
      b.vline(x + 2, y + 2, y + 6, c === C.FLOOR ? C.FLOOR_L : C.STONE);
      b.hline(x, x + S - 1, y + S - 1, C.BLACK); b.vline(x + S - 1, y, y + S - 1, C.BLACK);
      if (r() < 0.12) for (let k = 0; k < 6; k++) b.set(x + 8 + k, y + 14 + k, C.STONE);
      if (lotus && row % 3 === 1 && col % 4 === 2 && c === C.STONE_D) {
        const cx = x + S / 2, cy = y + S / 2;
        for (let a = 0; a < 8; a++) { const px = cx + Math.round(Math.cos(a * 0.785) * 10), py = cy + Math.round(Math.sin(a * 0.785) * 10); b.ellipse(px, py, 3, 3, C.STONE); b.set(px, py, C.STONE_D); }
        b.ellipse(cx, cy, 4, 4, C.STONE); b.set(cx, cy, C.STONE_L);
      }
    }
}

/** round vermilion column standing on the floor, its beams off-screen; casts a shadow to the lower right */
export function pillar(b, cx, base, h = 150, w = 30) {
  const x = cx - w / 2, top = base - h;
  shade(b, [[cx - w / 2 + 4, base], [cx + w / 2, base - 6], [cx + w / 2 + 34, base + 30], [cx - w / 2 + 34, base + 36]], DARK, 1);
  b.ellipse(cx, base - 2, w / 2 + 9, 8, C.STONE);
  b.ellipse(cx, base - 4, w / 2 + 7, 6, C.STONE_L);
  for (let a = 0; a < 10; a++) { const px = cx + Math.round(Math.cos(a * 0.628) * (w / 2 + 5)), py = base - 4 + Math.round(Math.sin(a * 0.628) * 4); b.ellipse(px, py, 3, 2, C.JADE); }
  b.rect(x, top, w, h - 4, C.RED);
  b.rect(x + 3, top, 4, h - 4, C.RED_L);
  b.rect(x + w - 9, top, 5, h - 4, C.RED_M);
  b.rect(x + w - 4, top, 4, h - 4, C.RED_D);
  b.vline(x, top, base - 5, C.RED_D);
  for (let y = top + 20; y < base - 30; y += 46) { b.rect(x, y, w, 5, C.GOLD); b.hline(x, x + w - 1, y, C.GOLD_L); b.hline(x, x + w - 1, y + 4, C.GOLD_D); }
  b.rect(x - 6, top - 12, w + 12, 12, C.WOOD); b.hline(x - 6, x + w + 5, top - 12, C.WOOD_L); b.rect(x - 6, top - 3, w + 12, 3, C.BROWN);
  b.rect(x - 2, top - 20, w + 4, 8, C.TEAL); b.hline(x - 2, x + w + 1, top - 20, C.SKY); b.hline(x - 2, x + w + 1, top - 13, C.BLU_D);
}

/** a doorway in a side wall / bottom edge: dark opening with a gold jamb (x,y,w,h in pixels) */
export function doorway(b, x, y, w, h) {
  b.rect(x, y, w, h, C.DEEP);
  if (w < h) { b.vline(x + (x < W / 2 ? w - 1 : 0), y, y + h - 1, C.GOLD_D); b.hline(x, x + w - 1, y, C.GOLD_D); b.hline(x, x + w - 1, y + h - 1, C.GOLD_D); }
  else { b.hline(x, x + w - 1, y, C.GOLD_D); b.vline(x, y, y + h - 1, C.GOLD_D); b.vline(x + w - 1, y, y + h - 1, C.GOLD_D); }
}

/** bronze crane (铜鹤) standing, seen in 3/4 view */
export function crane(b, cx, bottom, flip = 1) {
  b.ellipse(cx, bottom - 2, 10, 3, C.BROWN);
  b.vline(cx - 2, bottom - 14, bottom - 2, C.BRONZE); b.vline(cx + 2, bottom - 14, bottom - 2, C.BRONZE);
  b.ellipse(cx, bottom - 20, 9, 7, C.BRONZE); b.ellipse(cx - 2 * flip, bottom - 22, 6, 4, C.GOLD_D);
  b.line(cx + 6 * flip, bottom - 24, cx + 8 * flip, bottom - 40, C.BRONZE); b.line(cx + 7 * flip, bottom - 24, cx + 9 * flip, bottom - 40, C.GOLD_D);
  b.ellipse(cx + 9 * flip, bottom - 42, 3, 2, C.BRONZE); b.line(cx + 11 * flip, bottom - 42, cx + 17 * flip, bottom - 40, C.GOLD);
  b.set(cx + 9 * flip, bottom - 44, C.RED);
}

// ───────── exterior architecture (shared by guangchang + chengtian): yellow-glazed roofs, hall fronts, white marble ─────────

/** eave line y at x for an eave from x0 to x1 whose corners turn up (翼角) */
export function eaveY(x, x0, x1, y, lift = 10) {
  const L = Math.max(24, Math.min(90, (x1 - x0) / 5));
  const d = Math.max(0, x0 + L - x, x - (x1 - L)) / L;
  return y - Math.round(lift * d * d);
}

/** front slope of a yellow-glazed hip roof seen from above (3/4 view), cut by the line y = top.
 *  Eave from x0 to x1 at y = ey; hips run up and inward from the lifted corners. o.hip=false: no hips (cut by the frame). */
export function glazedRoof(b, x0, x1, ey, top = 0, o = {}) {
  const lift = o.lift ?? 10, hk = o.hipK ?? 0.85, sk = 0.22, hip = o.hip ?? true, P = 10;
  const ys = Math.min(ey - lift, ey);
  const hipL = (y) => x0 + 3 + (ey - lift - y) * hk, hipR = (y) => x1 - 3 - (ey - lift - y) * hk;
  const sideL = (y) => x0 + (ey - lift - y) * sk, sideR = (y) => x1 - (ey - lift - y) * sk;
  for (let x = x0; x <= x1; x++) {
    const e = eaveY(x, x0, x1, ey, lift);
    for (let y = top; y <= e; y++) {
      let part = 1; // 0 = left end slope, 1 = front slope, 2 = right end slope
      if (hip && y < ey - lift) {
        if (x < sideL(y) || x > sideR(y)) continue;
        if (x < hipL(y)) part = 0; else if (x > hipR(y)) part = 2;
      }
      let c;
      if (part === 1) {
        const k = (((x - x0) % P) + P) % P, j = (y - top) % 9;
        c = k === 0 ? C.GOLD_L : k < 5 ? C.GOLD : k === 5 ? C.GOLD_D : k === 6 ? C.BROWN : C.GOLD_D;
        if (k < 5 && j === 0) c = C.GOLD_D;
        if (k > 0 && k < 3 && j === 1) c = C.GOLD_L;
        if (k > 6 && j === 4) c = C.BROWN;
      } else {
        const j = (y + (part === 0 ? x : -x) * 0.35) | 0, r = ((j % 8) + 8) % 8;
        c = part === 0 ? (r === 0 ? C.GOLD_L : r < 5 ? C.GOLD : C.GOLD_D) : (r === 0 ? C.GOLD : r < 5 ? C.GOLD_D : C.BROWN);
      }
      b.set(x, y, c);
    }
  }
  // eave: round tile ends (勾头) on every row, drip tiles (滴水) between, painted rafter ends, the bracket shadow
  for (let x = x0; x <= x1; x++) {
    const e = eaveY(x, x0, x1, ey, lift);
    b.set(x, e + 1, C.GOLD_D); b.set(x, e + 2, C.BROWN);
    b.vline(x, e + 3, e + 9, C.DEEP);
    const k = (((x - x0) % P) + P) % P;
    if (k === 7) { b.set(x, e + 3, C.GOLD_D); b.set(x, e + 4, C.GOLD_D); b.set(x, e + 5, C.BROWN); }
    if ((x - x0) % 5 === 1) { b.rect(x, e + 5, 2, 2, ((x - x0) / 5) % 2 < 1 ? C.GRN : C.BLU); b.set(x, e + 5, ((x - x0) / 5) % 2 < 1 ? C.GRN_L : C.SKY); }
  }
  for (let x = x0 + 2; x <= x1 - 2; x += P) {
    const e = eaveY(x, x0, x1, ey, lift);
    b.ellipse(x + 2, e, 3, 3, C.GOLD); b.set(x + 1, e - 2, C.GOLD_L); b.set(x, e - 1, C.GOLD_L); b.hline(x, x + 4, e + 3, C.GOLD_D);
    b.set(x + 2, e, C.GOLD_D);
  }
  if (hip) {
    // hip ridges with the row of little ridge beasts (走兽) near the corners
    for (const s of [-1, 1]) {
      const hx = s < 0 ? hipL : hipR;
      for (let y = top; y <= ey - lift; y++) {
        const cx = Math.round(hx(y));
        b.rect(cx - 3, y, 7, 1, C.GOLD); b.set(cx - 3, y, C.GOLD_L); b.set(cx - 2, y, C.GOLD_L); b.set(cx + 3, y, C.BROWN); b.set(cx + 2, y, C.GOLD_D);
      }
      for (let k = 0; k < 5; k++) {
        const y = ey - lift - 8 - k * 7, cx = Math.round(hx(y));
        b.ellipse(cx, y - 2, 2, 3, C.GOLD_D); b.set(cx - 1, y - 4, C.GOLD); b.set(cx + 1, y - 1, C.BROWN);
      }
      const cy = ey - lift, cx = s < 0 ? x0 + 3 : x1 - 3;
      b.ellipse(cx, cy, 4, 3, C.GOLD_D); b.set(cx - s * 1, cy - 2, C.GOLD_L); b.rect(cx - 1 + s * 2, cy + 1, 3, 3, C.TEAL);
      // side eave edge
      for (let y = top; y < ey - lift; y++) b.set(Math.round(s < 0 ? sideL(y) : sideR(y)), y, s < 0 ? C.GOLD_L : C.BROWN);
    }
  }
}

/** the shaded band under an eave: bracket sets (斗拱) painted blue-green, seen in the eave shadow */
export function bracketBand(b, x0, x1, y, h = 14, step = 22) {
  b.rect(x0, y, x1 - x0, h, C.DEEP);
  for (let x = x0 + step / 2; x < x1 - 4; x += step) {
    const cx = Math.round(x);
    b.rect(cx - 6, y + h - 6, 12, 4, C.BLU_D); b.hline(cx - 6, cx + 5, y + h - 6, C.TEAL);
    b.rect(cx - 9, y + h - 10, 18, 3, C.GRN_D); b.hline(cx - 9, cx + 8, y + h - 10, C.GRN);
    b.rect(cx - 3, y + 2, 6, h - 8, C.BLU_D); b.set(cx - 3, y + 2, C.TEAL);
    b.set(cx, y + h - 3, C.GOLD_D);
  }
  b.hline(x0, x1 - 1, y + h - 1, C.GOLD_D);
}

/** front of a hall seen face-on: painted beam, red columns, lattice doors (隔扇) and windows (槛窗) over a low wall.
 *  doors: [first, last] bay index that has doors (the rest get windows). */
export function hallFront(b, x0, x1, y0, y1, bays, o = {}) {
  const bw = (x1 - x0) / bays, [d0, d1] = o.doors ?? [1, bays - 2], cw = o.colW ?? 8, beam = 12;
  b.rect(x0, y0, x1 - x0, y1 - y0, C.RED_D);
  // 额枋 with 和玺-style painting: green ends, blue centre panel, gold lines
  b.rect(x0, y0, x1 - x0, beam, C.BLU_D);
  for (let k = 0; k < bays; k++) {
    const bx = Math.round(x0 + k * bw), ex = Math.round(x0 + (k + 1) * bw);
    b.rect(bx + 2, y0 + 2, 10, beam - 4, C.GRN); b.rect(ex - 12, y0 + 2, 10, beam - 4, C.GRN);
    b.rect(bx + 16, y0 + 3, ex - bx - 32, beam - 6, C.BLU); b.hline(bx + 16, ex - 17, y0 + 3, C.SKY);
    b.line(bx + 12, y0 + 1, bx + 16, y0 + beam / 2, C.GOLD); b.line(bx + 16, y0 + beam / 2, bx + 12, y0 + beam - 2, C.GOLD);
    b.line(ex - 12, y0 + 1, ex - 16, y0 + beam / 2, C.GOLD); b.line(ex - 16, y0 + beam / 2, ex - 12, y0 + beam - 2, C.GOLD);
    for (let x = bx + 22; x < ex - 22; x += 7) b.set(x, y0 + beam / 2 - ((x / 7) % 2 < 1 ? 1 : 0), C.GOLD_L);
  }
  b.hline(x0, x1 - 1, y0, C.GOLD_D); b.hline(x0, x1 - 1, y0 + beam - 1, C.GOLD_D);
  b.rect(x0, y0 + beam, x1 - x0, 3, C.RED_M);
  const top = y0 + beam + 3;
  // bays
  for (let k = 0; k < bays; k++) {
    const bx = Math.round(x0 + k * bw) + cw / 2, ex = Math.round(x0 + (k + 1) * bw) - cw / 2, door = k >= d0 && k <= d1;
    const leaves = 4, lw = (ex - bx) / leaves;
    const wallTop = door ? y1 : Math.round(top + (y1 - top) * 0.62);
    for (let i = 0; i < leaves; i++) {
      const lx = Math.round(bx + i * lw), lx1 = Math.round(bx + (i + 1) * lw) - 1;
      const ly1 = wallTop - 1;
      b.rect(lx, top, lx1 - lx + 1, ly1 - top + 1, C.RED);
      b.vline(lx, top, ly1, C.RED_L); b.vline(lx1, top, ly1, C.RED_D);
      const lat0 = top + 3, lat1 = door ? Math.round(top + (y1 - top) * 0.58) : ly1 - 3;
      // 菱花 lattice: dark panel with a light diagonal grid
      b.rect(lx + 2, lat0, lx1 - lx - 3, lat1 - lat0, C.RED_D);
      for (let y = lat0; y < lat1; y++) for (let x = lx + 2; x < lx1 - 1; x++) if ((x + y) % 4 === 0 || (x - y + 400) % 4 === 0) b.set(x, y, C.RED_M);
      for (let y = lat0 + 2; y < lat1; y += 4) for (let x = lx + 3 + ((y / 4) % 2 < 1 ? 0 : 2); x < lx1 - 1; x += 4) b.set(x, y, C.GOLD_D);
      if (door) {
        b.rect(lx + 2, lat1 + 2, lx1 - lx - 3, 4, C.RED_M); b.hline(lx + 2, lx1 - 2, lat1 + 2, C.GOLD_D);
        b.rect(lx + 3, lat1 + 9, lx1 - lx - 5, y1 - lat1 - 13, C.RED_M); b.hline(lx + 3, lx1 - 3, lat1 + 9, C.RED_D);
        b.ellipse(Math.round((lx + lx1) / 2), Math.round((lat1 + 9 + y1 - 4) / 2), 2, 2, C.GOLD_D);
        b.set(lx + 1, lat1 + 1, C.GOLD); b.set(lx1 - 1, lat1 + 1, C.GOLD); b.set(lx + 1, top + 1, C.GOLD); b.set(lx1 - 1, top + 1, C.GOLD);
      }
    }
    if (!door) { // 槛墙: low wall under the windows
      b.rect(bx, wallTop, ex - bx, y1 - wallTop, C.RED_M); b.rect(bx, wallTop, ex - bx, 3, C.STONE_L); b.hline(bx, ex - 1, wallTop, C.JADE);
      for (let y = wallTop + 7; y < y1 - 1; y += 4) { b.hline(bx, ex - 1, y, C.RED_D); for (let x = bx + ((y / 4) % 2 < 1 ? 3 : 9); x < ex; x += 12) b.vline(x, y - 3, y, C.RED_D); }
    }
  }
  // round columns
  for (let k = 0; k <= bays; k++) {
    const cx = Math.round(x0 + k * bw), x = cx - cw / 2;
    b.rect(x, y0 + beam, cw, y1 - y0 - beam, C.RED); b.vline(x + 1, y0 + beam, y1 - 1, C.RED_L); b.vline(x + cw - 2, y0 + beam, y1 - 1, C.RED_M); b.vline(x + cw - 1, y0 + beam, y1 - 1, C.RED_D);
  }
  b.hline(x0, x1 - 1, y1 - 1, C.RED_D);
}

/** white-marble balustrade along a front edge (posts with round caps over carved panels); y = where it stands */
export function marbleRail(b, x0, x1, y, step = 24) {
  b.rect(x0, y - 9, x1 - x0, 9, C.PAPER);
  b.hline(x0, x1 - 1, y - 9, C.JADE); b.hline(x0, x1 - 1, y - 6, C.PLASTER_S); b.hline(x0, x1 - 1, y - 1, C.STONE_L); b.hline(x0, x1 - 1, y, C.STONE);
  for (let x = x0 + step / 2; x < x1 - 6; x += step) { b.rect(Math.round(x) - 4, y - 5, 9, 3, C.PLASTER_S); b.hline(Math.round(x) - 4, Math.round(x) + 4, y - 5, C.STONE_L); }
  for (let x = x0; x <= x1; x += step) {
    const px = Math.min(Math.round(x), x1 - 3);
    b.rect(px - 3, y - 15, 7, 15, C.JADE); b.vline(px + 3, y - 15, y, C.STONE_L); b.vline(px - 3, y - 15, y, C.JADE);
    b.ellipse(px, y - 16, 3, 3, C.PAPER); b.set(px - 1, y - 18, C.JADE); b.set(px + 2, y - 15, C.STONE_L);
    b.set(px + 4, y, C.STONE); b.set(px + 5, y + 1, C.STONE);
  }
}
/** a balustrade running away from the viewer (stair sides, terrace ends), seen from above: rail top + post caps */
export function marbleRailV(b, x, y0, y1, step = 22) {
  b.rect(x - 2, y0, 5, y1 - y0, C.PAPER); b.vline(x - 2, y0, y1, C.JADE); b.vline(x + 2, y0, y1, C.STONE_L); b.vline(x + 3, y0, y1, C.STONE);
  for (let y = y0; y <= y1; y += step) { b.rect(x - 3, y - 8, 7, 10, C.JADE); b.vline(x + 3, y - 8, y + 1, C.STONE_L); b.ellipse(x, y - 9, 3, 3, C.PAPER); b.set(x - 1, y - 11, C.JADE); b.set(x + 4, y + 2, C.STONE); }
}

/** big outdoor bricks in running bond seen from above (grey court paving); o.alt: occasional odd bricks */
export function pavingTD(b, x0, y0, x1, y1, o = {}) {
  const bw = o.bw ?? 48, bh = o.bh ?? 24, r = rng(o.seed ?? 7), base = o.base ?? C.STONE, joint = o.joint ?? C.STONE_D, hi = o.hi ?? C.STONE_L;
  const alt = o.alt ?? [C.FLOOR_L, C.FLOOR_L, joint, hi];
  b.rect(x0, y0, x1 - x0, y1 - y0, base);
  for (let y = y0, row = 0; y < y1; y += bh, row++)
    for (let x = x0 - ((row % 2) * bw) / 2; x < x1; x += bw) {
      const v = r(), cx0 = Math.max(x0, x), cx1 = Math.min(x1 - 1, x + bw - 2), cy1 = Math.min(y1 - 1, y + bh - 2);
      if (v < (o.odd ?? 0.14)) dith(b, cx0, y, cx1 - cx0 + 1, cy1 - y + 1, alt[Math.floor(r() * alt.length)], 2, row);
      b.hline(cx0, cx1 + 1, y + bh - 1, joint);
      if (x + bw - 1 < x1 && x + bw - 1 >= x0) b.vline(x + bw - 1, y, Math.min(y1 - 1, y + bh - 1), joint);
      if (x + 1 >= x0) { b.hline(x + 1, Math.min(x1 - 1, x + 6), y, hi); b.set(x + 1, y + 1, hi); }
      if (r() < 0.06) { const cx = x + 8 + Math.floor(r() * (bw - 20)); b.line(cx, y + 5, cx + 5, y + 9, joint); }
    }
}

// ───────── red palace walls with yellow-glazed coping (shared by yuhuayuan + gongdao) ─────────
/** yellow-glazed wall coping seen face-on (ridge, tile rows, drip edge): x0..x1, top at y, 19 px tall */
export function wallCoping(b, x0, x1, y) {
  b.rect(x0, y, x1 - x0, 5, C.GOLD_D); b.hline(x0, x1 - 1, y, C.GOLD_L); b.hline(x0, x1 - 1, y + 1, C.GOLD);
  for (let x = x0; x < x1; x++) {
    const k = (((x - x0) % 8) + 8) % 8;
    b.vline(x, y + 5, y + 13, k === 0 ? C.GOLD_L : k < 4 ? C.GOLD : k < 6 ? C.GOLD_D : C.BROWN);
    if (k === 2) b.set(x, y + 13, C.GOLD_L);
  }
  for (let x = x0 + 2; x < x1; x += 8) { b.ellipse(x + 1, y + 15, 3, 2, C.GOLD); b.set(x, y + 14, C.GOLD_L); }
  b.hline(x0, x1 - 1, y + 18, C.BROWN);
}
/** a red palace wall seen face-on: coping at `top`, weathered red plaster, a grey stone base ending at `base` */
export function redWall(b, x0, x1, top, base, seed = 9) {
  wallCoping(b, x0, x1, top);
  const f = top + 19, sb = base - 14;
  b.rect(x0, f, x1 - x0, sb - f, C.RED);
  dith(b, x0, f, x1 - x0, 8, C.RED_D, 2); b.hline(x0, x1 - 1, f, C.RED_D);
  const r = rng(seed);
  for (let k = 0; k < ((x1 - x0) * (sb - f)) / 900; k++) { const x = x0 + Math.floor(r() * (x1 - x0)), y = f + 10 + Math.floor(r() * (sb - f - 20)); b.vline(x, y, Math.min(sb - 1, y + 6 + Math.floor(r() * 14)), C.RED_M); }
  dith(b, x0, sb - 10, x1 - x0, 10, C.RED_M, 3);
  b.rect(x0, sb, x1 - x0, 14, C.STONE); b.hline(x0, x1 - 1, sb, C.STONE_L);
  for (let x = x0; x < x1; x += 32) b.vline(x, sb + 1, base - 1, C.STONE_D);
  b.hline(x0, x1 - 1, base - 1, C.STONE_D);
}
/** the top of a near wall seen from above (yellow tiles running across, a ridge), y0..y1 */
export function copingTop(b, x0, x1, y0, y1) {
  b.rect(x0, y0, x1 - x0, y1 - y0, C.GOLD_D);
  for (let x = x0; x < x1; x += 8) { b.vline(x, y0 + 1, y1 - 1, C.GOLD); b.vline(x + 1, y0 + 1, y1 - 1, C.GOLD_L); b.vline(x + 6, y0 + 1, y1 - 1, C.BROWN); }
  const ry = y0 + Math.round((y1 - y0) * 0.4);
  b.rect(x0, ry, x1 - x0, 3, C.GOLD); b.hline(x0, x1 - 1, ry, C.GOLD_L); b.hline(x0, x1 - 1, ry + 3, C.BROWN);
  b.hline(x0, x1 - 1, y0, C.BROWN);
}
