// 角楼 — the palace corner tower, seen across the moat. Purely decorative: the famous many-gabled tower with
// its three tiers of yellow-glazed eaves stands on the corner of the palace wall in the upper part of the frame;
// the moat (护城河) runs across the middle and holds its reflection; a willow-lined bank and path along the bottom
// lead off to the right, back to 承天门.
import { Bitmap, C, rng, W, H, dith, frame, shade, DARK, eaveY, marbleRail } from './common.mjs';

const WATER_TOP = 384, WATER_BOT = 600;

const BAYER = [[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]];
/** ordered-dither blend from colour a (at y0) to colour b (at y1) */
function grad(b, x0, x1, y0, y1, ca, cb) {
  for (let y = y0; y < y1; y++) { const t = (y - y0) / (y1 - y0); for (let x = x0; x < x1; x++) b.set(x, y, t * 16 > BAYER[y & 3][x & 3] + 0.5 ? cb : ca); }
}
/** soft cumulus bank */
function cloud(b, x, y, w, seed) {
  const r = rng(seed);
  for (let i = 0; i < w; i += 12) { const h = 6 + Math.floor(r() * 9); b.ellipse(x + i, y - h / 2, 14, h, C.SKY_L); }
  for (let i = 6; i < w - 6; i += 16) { const h = 4 + Math.floor(r() * 6); b.ellipse(x + i - 3, y - h - 2, 9, h, C.JADE); }
  b.hline(x - 12, x + w + 8, y + 3, C.SKY_L); dith(b, x - 10, y + 4, w + 16, 2, C.SKY_L, 2);
}

/** 歇山 gable (山花) facing the viewer: red tympanum, gilt bargeboards with studs, a gilt 悬鱼 under the apex */
function pediment(b, cx, baseY, half, h) {
  const apex = baseY - h;
  for (let y = apex; y <= baseY; y++) { const t = (y - apex) / h, hw = Math.round(half * t); b.hline(cx - hw, cx + hw, y, (y - apex) % 6 === 5 ? C.RED_M : C.RED); }
  for (let y = apex + 6; y < baseY - 2; y += 7) { const t = (y - apex) / h, hw = Math.round(half * t) - 4; for (let x = cx - hw; x <= cx + hw; x += 7) b.set(x + ((y / 7) % 2 < 1 ? 0 : 3), y, C.GOLD_D); }
  // bargeboards (博风板) — thick gilt edges that flare out at the bottom
  for (let k = -1; k <= 3; k++) {
    b.line(cx, apex - 2 + k, cx - half - 4, baseY + k - 1, k < 1 ? C.GOLD_L : k < 3 ? C.GOLD : C.GOLD_D);
    b.line(cx, apex - 2 + k, cx + half + 4, baseY + k - 1, k < 1 ? C.GOLD : k < 3 ? C.GOLD_D : C.BROWN);
  }
  for (let t = 0.15; t < 1; t += 0.18) { b.set(Math.round(cx - (half + 4) * t), Math.round(apex + 1 + h * t), C.GOLD_L); b.set(Math.round(cx + (half + 4) * t), Math.round(apex + 1 + h * t), C.GOLD_L); }
  // 悬鱼
  b.vline(cx, apex + 2, apex + Math.round(h * 0.45), C.GOLD); b.ellipse(cx, apex + Math.round(h * 0.45) + 2, 2, 3, C.GOLD); b.set(cx - 1, apex + Math.round(h * 0.45), C.GOLD_L);
  // ridge-end ornament (吻) on the apex
  b.rect(cx - 2, apex - 8, 5, 6, C.GOLD_D); b.set(cx - 2, apex - 8, C.GOLD); b.set(cx + 3, apex - 9, C.GOLD); b.set(cx + 3, apex - 10, C.GOLD_L);
}

/** the tile surface behind a run of pediments: from y0 down to the eave skirt, x0..x1, tiles in vertical rows */
function tileField(b, x0, x1, y0, y1) {
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
    const k = (((x - x0) % 8) + 8) % 8, j = (y - y0) % 7;
    b.set(x, y, k === 0 ? C.GOLD_L : k < 4 ? (j === 0 ? C.GOLD_D : C.GOLD) : k < 6 ? C.GOLD_D : C.BROWN);
  }
}

/** a glazed eave skirt seen face-on: tiles from y = ey - h down to the eave, corners swept up by `lift`,
 *  hip ridges with little ridge beasts climbing from each lifted corner, tile ends and the shadow under the eave */
function eaveSkirt(b, x0, x1, ey, h, lift) {
  const yt = ey - h, P = 8, k = 0.9;
  const hipL = (y) => x0 + 4 + (ey - lift - y) * k, hipR = (y) => x1 - 4 - (ey - lift - y) * k;
  for (let x = x0; x <= x1; x++) {
    const e = eaveY(x, x0, x1, ey, lift);
    for (let y = yt; y <= e; y++) {
      if (y < ey - lift && (x < x0 + (ey - lift - y) * 0.25 || x > x1 - (ey - lift - y) * 0.25)) continue;
      let c;
      if (y < ey - lift && x < hipL(y)) { const r = (((y + x * 0.4) | 0) % 7 + 7) % 7; c = r === 0 ? C.GOLD_L : r < 4 ? C.GOLD : C.GOLD_D; }
      else if (y < ey - lift && x > hipR(y)) { const r = (((y - x * 0.4) | 0) % 7 + 7) % 7; c = r === 0 ? C.GOLD : r < 4 ? C.GOLD_D : C.BROWN; }
      else { const q = (((x - x0) % P) + P) % P, j = (y - yt) % 7; c = q === 0 ? C.GOLD_L : q < 4 ? (j === 0 ? C.GOLD_D : C.GOLD) : q < 6 ? C.GOLD_D : C.BROWN; if (x > (x0 + x1) / 2 + 20 && q > 1 && (x + y) % 3 === 0) c = c === C.GOLD ? C.GOLD_D : c; }
      b.set(x, y, c);
    }
  }
  // hips + beasts
  for (const s of [-1, 1]) {
    const hx = s < 0 ? hipL : hipR;
    for (let y = yt; y <= ey - lift; y++) { const cx = Math.round(hx(y)); b.rect(cx - 2, y, 5, 1, C.GOLD); b.set(cx - 2, y, C.GOLD_L); b.set(cx + 2, y, C.BROWN); }
    for (let n = 0; n < 4; n++) { const y = ey - lift - 6 - n * 6; if (y < yt + 3) break; const cx = Math.round(hx(y)); b.ellipse(cx, y - 2, 2, 2, C.GOLD_D); b.set(cx - 1, y - 3, C.GOLD); }
    const cy = ey - lift, cx = s < 0 ? x0 + 4 : x1 - 4;
    b.ellipse(cx, cy, 3, 3, C.GOLD_D); b.set(cx - s, cy - 2, C.GOLD_L); b.set(cx + s * 3, cy - 4, C.GOLD); b.set(cx + s * 4, cy - 5, C.GOLD_L); // the swept-up corner
  }
  // tile ends along the eave, painted rafter ends and the dark gap under the eave
  for (let x = x0; x <= x1; x++) {
    const e = eaveY(x, x0, x1, ey, lift);
    b.set(x, e + 1, C.GOLD_D); b.vline(x, e + 2, e + 7, C.DEEP);
    if ((x - x0) % 5 === 1) { b.rect(x, e + 4, 2, 2, ((x - x0) / 5) % 2 < 1 ? C.GRN : C.BLU); }
  }
  for (let x = x0 + 3; x <= x1 - 3; x += P) { const e = eaveY(x, x0, x1, ey, lift); b.ellipse(x + 1, e, 2, 2, C.GOLD); b.set(x, e - 1, C.GOLD_L); }
}

/** one tier of the tower: the eave skirt with lifted corners and gables standing on it.
 *  gables: [[dx, h, half], ...]; skirt = height of the visible tile slope under the gables */
function tier(b, cx, ey, half, gables, skirt = 26) {
  const base = ey - skirt + 8;
  tileField(b, cx - half + 30, cx + half - 30, base - 14, base);
  b.rect(cx - half + 30, base - 17, 2 * half - 60, 4, C.GOLD_D); b.hline(cx - half + 30, cx + half - 31, base - 17, C.GOLD_L); b.hline(cx - half + 30, cx + half - 31, base - 14, C.BROWN); // ridge
  for (const [gx, gh, gw] of gables) {
    // the roof's two slopes running back from the gable, seen from above as a hood of tiles around it
    const hx = cx + gx, ap = base - gh - 8, hw = gw + 16;
    for (let y = ap; y <= base; y++) {
      const t = (y - ap) / (base - ap), w = Math.round(hw * t + 6 * (1 - t));
      for (let x = hx - w; x <= hx + w; x++) { const r = ((((y + (x < hx ? x : -x) * 0.5) | 0) % 6) + 6) % 6; b.set(x, y, x < hx ? (r === 0 ? C.GOLD_L : r < 4 ? C.GOLD : C.GOLD_D) : (r === 0 ? C.GOLD : r < 4 ? C.GOLD_D : C.BROWN)); }
    }
    b.rect(hx - 3, ap - 2, 7, 4, C.GOLD_D); b.hline(hx - 3, hx + 3, ap - 2, C.GOLD_L);
    pediment(b, hx, base, gw, gh);
  }
  eaveSkirt(b, cx - half, cx + half, ey + 2, skirt, 18);
}
/** a band of wall between two tiers: red columns, lattice, a painted beam, in the shade of the eave above */
function storeyBand(b, x0, x1, y0, y1) {
  b.rect(x0, y0, x1 - x0, y1 - y0, C.RED_D);
  for (let x = x0 + 3; x < x1 - 3; x += 4) b.vline(x, y0 + 2, y1 - 3, (x / 4) % 2 < 1 ? C.RED_M : C.DEEP);
  const n = Math.max(2, Math.round((x1 - x0) / 46));
  for (let k = 0; k <= n; k++) { const x = Math.round(x0 + ((x1 - x0 - 5) * k) / n); b.rect(x, y0, 5, y1 - y0, C.RED); b.vline(x, y0, y1 - 1, C.RED_L); }
  b.rect(x0 - 4, y1 - 5, x1 - x0 + 8, 5, C.BLU); b.hline(x0 - 4, x1 + 3, y1 - 5, C.SKY); b.hline(x0 - 4, x1 + 3, y1 - 1, C.GOLD_D);
}

/** the corner tower standing on the wall top at `base` (front elevation, drawn back to front) */
function cornerTower(b, cx, base) {
  const e1 = base - 70, e2 = e1 - 62, e3 = e2 - 46;
  // top tier with its cross ridge, then the gilt 宝顶
  storeyBand(b, cx - 70, cx + 70, e3, e2 - 22);
  tier(b, cx, e3, 96, [[0, 44, 54]], 22);
  const apex = e3 - 22 + 8 - 44;
  b.rect(cx - 3, apex - 14, 7, 10, C.GOLD_D);
  b.ellipse(cx, apex - 20, 8, 8, C.GOLD); b.ellipse(cx - 3, apex - 22, 3, 3, C.GOLD_L); b.vline(cx + 6, apex - 24, apex - 16, C.GOLD_D);
  b.rect(cx - 1, apex - 34, 3, 8, C.GOLD); b.set(cx, apex - 35, C.GOLD_L);
  // middle tier: two gables over the side porches
  storeyBand(b, cx - 130, cx + 130, e2, e1 - 26);
  tier(b, cx, e2, 166, [[-96, 30, 40], [96, 30, 40]], 24);
  // the lowest, widest tier: a big gable over the front porch, smaller ones over the corner porches
  // ground storey: red columns, lattice doors and windows
  const y0 = e1, x0 = cx - 170, x1 = cx + 170;
  b.rect(x0, y0, x1 - x0, base - 16 - y0, C.RED_D);
  for (let k = 0; k < 7; k++) {
    const bx = x0 + 6 + k * 48, bw = 40;
    b.rect(bx, y0 + 10, bw, base - 30 - y0, C.RED);
    b.rect(bx + 3, y0 + 13, bw - 6, 22, C.RED_D);
    for (let yy = y0 + 13; yy < y0 + 35; yy++) for (let xx = bx + 3; xx < bx + bw - 3; xx++) if ((xx + yy) % 4 === 0 || (xx - yy + 400) % 4 === 0) b.set(xx, yy, C.RED_M);
    for (let yy = y0 + 15; yy < y0 + 35; yy += 4) for (let xx = bx + 4 + ((yy / 4) % 2 < 1 ? 0 : 2); xx < bx + bw - 3; xx += 4) b.set(xx, yy, C.GOLD_D);
    b.rect(bx + 3, y0 + 38, bw - 6, base - 34 - y0 - 38, C.RED_M); b.hline(bx + 3, bx + bw - 4, y0 + 38, C.RED_D);
  }
  for (let k = 0; k <= 7; k++) { const x = x0 + 2 + k * 48; b.rect(x, y0 + 6, 6, base - 22 - y0, C.RED); b.vline(x, y0 + 6, base - 17, C.RED_L); b.vline(x + 5, y0 + 6, base - 17, C.RED_D); }
  // white marble terrace and balustrade on the wall top
  b.rect(cx - 230, base - 16, 460, 16, C.STONE_L); b.hline(cx - 230, cx + 229, base - 16, C.PAPER); b.hline(cx - 230, cx + 229, base - 1, C.STONE);
  for (let x = cx - 224; x < cx + 220; x += 30) frame(b, x, base - 12, 24, 8, C.STONE);
  marbleRail(b, cx - 226, cx + 226, base - 14);
  tier(b, cx, e1, 246, [[-176, 30, 40], [0, 54, 84], [176, 30, 40]], 30);
  return { apex };
}

/** the city wall face: big grey bricks, weathered, crenellated parapet on top */
function cityWall(b, top, base) {
  const r = rng(17);
  // parapet with crenels (垛口) along the top
  b.rect(0, top, W, 22, C.FLOOR_L);
  for (let x = 0; x < W; x += 40) { b.rect(x + 26, top, 14, 12, C.SKY_L); b.vline(x + 25, top, top + 11, C.FLOOR_D); b.hline(x + 26, x + 39, top + 12, C.FLOOR); b.set(x + 31, top + 16, C.DEEP); b.set(x + 32, top + 16, C.DEEP); }
  b.hline(0, W - 1, top + 22, C.FLOOR_D);
  // brick face
  for (let y = top + 23, row = 0; y < base; y += 8, row++) {
    b.rect(0, y, W, 8, C.FLOOR);
    b.hline(0, W - 1, y + 7, C.FLOOR_D);
    for (let x = (row % 2) * 16; x < W; x += 32) { b.vline(x, y, y + 6, C.FLOOR_D); if (r() < 0.45 - row * 0.03) b.hline(x + 1, x + 30, y, C.FLOOR_L); if (r() < 0.12) dith(b, x + 1, y, 30, 7, C.STONE, 2); }
  }
  // weathered patches: darker where the rain runs, a lighter run of newer bricks where the wall was mended
  for (const [x, y, w, h, c] of [[120, top + 50, 70, 30, C.FLOOR_D], [470, top + 40, 40, 24, C.FLOOR_L], [930, top + 56, 90, 26, C.FLOOR_D], [1150, top + 36, 50, 20, C.FLOOR_L]]) {
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) {
      const d = ((xx - x - w / 2) / (w / 2)) ** 2 + ((yy - y - h / 2) / (h / 2)) ** 2;
      if (d < 1 && (xx + yy) % 2 === 0 && b.get(xx, yy) === C.FLOOR && (1 - d) * 16 > BAYER[yy & 3][xx & 3]) b.set(xx, yy, c);
    }
  }
  // grass tufts along the parapet top
  for (let x = 4; x < W; x += 7 + Math.floor(r() * 30)) { if (b.get(x, top - 1) === C.FLOOR_L || b.get(x, top) === C.SKY_L) continue; b.set(x, top - 1, C.GRN); b.set(x + 1, top - 2, C.GRN_L); b.set(x + 2, top - 1, C.GRN_D); }
  // rain streaks running down from the drains, damp darker band at the waterline
  for (let x = 30; x < W; x += 90) { b.rect(x, top + 24, 6, 4, C.STONE); for (let y = top + 28; y < base - 10; y++) if ((y + x) % 3) b.set(x + 2 + ((y / 9) | 0) % 2, y, C.FLOOR_D); }
  dith(b, 0, base - 18, W, 18, C.FLOOR_D, 2);
  for (let k = 0; k < 260; k++) { const x = Math.floor(r() * W), y = base - 8 - Math.floor(r() ** 2 * 14); b.set(x, y, r() < 0.6 ? C.GRN_D : C.TEAL); }
  b.rect(0, base - 6, W, 6, C.STONE); b.hline(0, W - 1, base - 6, C.STONE_L);
  for (let x = 0; x < W; x += 36) b.vline(x, base - 5, base - 1, C.STONE_D);
}

/** weeping willow (垂柳): a gnarled trunk splitting into limbs, a domed crown made of thousands of hanging
 *  twigs that thins into a curtain of long fronds; lit from the upper left */
function willow(b, cx, base, seed, s = 1) {
  const r = rng(seed), sc = (v) => Math.round(v * s);
  shade(b, [[cx - sc(16), base + 1], [cx + sc(60), base - sc(3)], [cx + sc(116), base + sc(12)], [cx + sc(8), base + sc(16)]], DARK, 2);
  // trunk: root flare, a slight lean, bark furrows in short vertical runs
  const th = sc(78), lean = (r() - 0.5) * 0.3;
  const tX = (k) => cx + Math.round(lean * k + Math.sin(k / sc(26)) * 2);
  for (let k = 0; k < th; k++) {
    const t = k / th, w = Math.max(3, Math.round(sc(7) * (1 - 0.35 * t) + Math.max(0, 6 - k * 0.7)));
    const x = tX(k), y = base - k;
    for (let i = -w; i <= w; i++) {
      let c = i <= -w + 1 ? C.WOOD : i >= w - 1 ? C.DBROWN : C.BROWN;
      if (c === C.BROWN && (i * 5 + Math.floor((k + i * 3) / 6) * 7) % 9 === 0) c = C.DBROWN;
      if (i === -w + 2 && (k >> 2) % 3 === 0) c = C.WOOD_L;
      b.set(x + i, y, c);
    }
  }
  const tx = tX(th), ty = base - th;
  for (const [dx, dy, w] of [[-sc(54), -sc(40), 2], [sc(50), -sc(34), 2], [-sc(14), -sc(62), 3], [sc(22), -sc(56), 2]]) {
    for (let i = -w; i <= w; i++) b.line(tx + i, ty + 2, tx + dx + Math.round(i / 2), ty + dy, i < 0 ? C.BROWN : C.DBROWN);
  }
  // crown: twigs hang from points across a dome; long at the rim, short on top
  const ccx = tx + sc(2), ccy = ty - sc(36), rx = sc(92), ry = sc(46);
  const tw = [];
  const skew = (r() - 0.5) * 0.3;
  for (let n = 0; n < sc(760); n++) {
    const a = r() * 2 - 1, x0 = Math.round(ccx + a * rx * (a < 0 ? 1 - skew : 1 + skew) * (0.9 + r() * 0.12));
    const top = ccy - Math.round(ry * Math.sqrt(Math.max(0, 1 - a * a)) * (0.85 + 0.15 * Math.sin(a * 9 + seed)));
    const dep = r() ** 1.8, y0 = top + Math.round(dep * ry * 1.1);
    const rim = Math.abs(a) ** 1.6, len = sc(8 + rim * 54 + dep * 18 + r() ** 2 * (20 + rim * 40));
    const lit = -a * 0.55 + (1 - dep) * 0.75 + (r() - 0.5) * 0.6;
    tw.push([x0, y0, len, a, lit]);
  }
  tw.sort((p, q) => p[4] - q[4]);
  for (const [x0, y0, len, a, lit] of tw) {
    const col = lit > 0.85 ? C.GRN_L : lit > 0.2 ? C.GRN : C.GRN_D, leaf = lit > 0.85 ? C.GRN : lit > 0.2 ? C.GRN_D : C.TEAL;
    const out = a < 0 ? -1 : 1;
    b.set(x0 - out, y0 - 1, col); b.set(x0 - out * 2, y0, col); // the little arch where the twig leaves its branch
    for (let j = 0; j < len; j++) {
      const x = Math.round(x0 + Math.sin((j + x0 * 3) / 11) * 0.7 + a * 3 * (j / len) ** 2), y = y0 + j;
      if (y > base - 6 - Math.abs(x - cx) * 0.15) break; // the fronds stop short of the grass
      b.set(x, y, col);
      if (j % 4 === 1) b.set(x + ((j >> 2) % 2 ? 1 : -1), y, leaf);
    }
  }
}

export function jiaolou() {
  const b = new Bitmap(W, H);
  // ── 1. sky, clouds, far western hills ──
  b.rect(0, 0, W, WATER_TOP, C.SKY);
  grad(b, 0, W, 90, 190, C.SKY, C.SKY_L);
  b.rect(0, 190, W, 50, C.SKY_L);
  grad(b, 0, W, 240, 280, C.SKY_L, C.JADE);
  cloud(b, 70, 70, 190, 1); cloud(b, 880, 46, 240, 2); cloud(b, 1060, 120, 150, 3);
  {
    let h1 = 30, h2 = 16; const r = rng(31);
    for (let x = 0; x < W; x++) {
      if (x % 3 === 0) { h1 = Math.max(10, Math.min(56, h1 + (r() - 0.5) * 5 + Math.sin(x / 70) * 1.2)); h2 = Math.max(6, Math.min(30, h2 + (r() - 0.5) * 4)); }
      b.vline(x, Math.round(272 - h1), 290, C.HILL_L);
      b.vline(x, Math.round(284 - h2), 290, C.HILL);
    }
    // a line of trees on the far side of the wall
    for (let x = -10; x < W + 10; x += 18) { const rr = 10 + Math.floor(r() * 8); b.ellipse(x, 286, rr, Math.round(rr * 0.6), C.TEAL); b.ellipse(x - 3, 283, Math.round(rr * 0.5), Math.round(rr * 0.3), C.GRN_L); }
  }
  // ── 2. the wall and the tower on its corner ──
  cityWall(b, 280, WATER_TOP);
  cornerTower(b, 560, 290);
  // the wall walk's parapet in front of the tower base, so the tower stands on the wall
  // ── 3. the moat and its reflection ──
  {
    // everything seen in the water is darker and bluer than the thing itself
    const REF = {
      [C.SKY]: C.SKY, [C.SKY_L]: C.HILL_L, [C.JADE]: C.HILL_L, [C.PAPER]: C.HILL_L, [C.HILL_L]: C.SKY, [C.HILL]: C.HILL,
      [C.TEAL]: C.TEAL, [C.GRN_L]: C.TEAL, [C.GRN]: C.TEAL, [C.GRN_D]: C.TILE_D,
      [C.FLOOR_L]: C.HILL, [C.FLOOR]: C.TILE_L, [C.FLOOR_D]: C.TILE, [C.STONE]: C.HILL, [C.STONE_L]: C.HILL_L, [C.PLASTER_S]: C.HILL_L,
      [C.WOOD_L]: C.TILE_L, [C.STONE_D]: C.TILE_D, [C.DEEP]: C.TILE_D, [C.BLACK]: C.TILE_D, [C.BLU_D]: C.TILE_D, [C.BLU]: C.TILE,
      [C.RED]: C.RED_M, [C.RED_L]: C.RED_M, [C.RED_M]: C.RED_D, [C.RED_D]: C.RED_D, [C.CRIMSON]: C.RED_D,
      [C.GOLD_L]: C.GOLD, [C.GOLD]: C.GOLD_D, [C.GOLD_D]: C.GOLD_D, [C.BROWN]: C.BROWN, [C.DBROWN]: C.BROWN, [C.WOOD]: C.GOLD_D,
    };
    const DARKS = new Set([C.TILE_D, C.TILE, C.TILE_L, C.RED_D, C.BROWN]);
    const r = rng(8), WH = WATER_BOT - WATER_TOP;
    const rows = [];
    for (let y = WATER_TOP; y < WATER_BOT; y++) {
      const d = y - WATER_TOP, src = WATER_TOP - 1 - Math.floor(d * 0.97);
      const amp = d < 5 ? 0 : 1 + d / 80, wob = Math.round(Math.sin(d * 0.9 + Math.sin(d * 0.21) * 2) * amp);
      const raw = new Array(W);
      for (let x = 0; x < W; x++) raw[x] = src >= 0 ? REF[b.get(Math.max(0, Math.min(W - 1, x + wob)), src)] ?? C.SKY : C.SKY;
      // soften: each pixel takes the commonest colour of its 5-pixel neighbourhood (tile stripes melt into paint)
      const row = new Array(W);
      for (let x = 0; x < W; x++) {
        const cnt = new Map(); let best = raw[x], bn = 0;
        for (let i = -2; i <= 2; i++) { const c = raw[Math.max(0, Math.min(W - 1, x + i))], n = (cnt.get(c) ?? 0) + 1; cnt.set(c, n); if (n > bn || (n === bn && c === raw[x])) { bn = n; best = c; } }
        row[x] = best;
      }
      rows.push(row);
    }
    for (let d = 0; d < WH; d++) {
      const y = WATER_TOP + d, row = rows[d], t = d / WH;
      // the water's own colour breaks the mirror in long dashes, more of them nearer the viewer
      if (d > 3) for (let x = 0; x < W;) {
        const L = 6 + Math.floor(r() * (10 + t * 40));
        if (r() < 0.06 + t * 0.32) for (let i = x; i < Math.min(W, x + L); i++) { const c = row[i]; row[i] = DARKS.has(c) ? (c === C.RED_D ? C.RED_M : c === C.BROWN ? C.GOLD_D : c === C.TILE_L ? C.HILL : c === C.TILE ? C.TILE_L : C.TILE) : c === C.SKY || c === C.HILL_L ? (t > 0.55 ? C.TEAL : C.HILL) : c; }
        x += L + Math.floor(r() * 30);
      }
      // nearer the bank the eye looks down into the water: sky reflections deepen to teal
      for (let x = 0; x < W; x++) {
        let c = row[x];
        if (t > 0.6 && (c === C.SKY || c === C.HILL_L) && (t - 0.6) * 2.4 * 16 > BAYER[y & 3][x & 3] + 0.5) c = c === C.SKY ? C.HILL : C.SKY;
        b.set(x, y, c);
      }
    }
    // sun glints: a few bright flecks on the open water
    for (let k = 0; k < 160; k++) {
      const x = Math.floor(r() * W), y = WATER_TOP + 6 + Math.floor(r() * (WH - 10)), L = 2 + Math.floor(r() * 6), v = b.get(x, y);
      if (v === C.SKY || v === C.HILL_L || v === C.HILL) b.hline(x, x + L, y, r() < 0.6 ? C.SKY_L : C.JADE);
    }
    // the dark waterline along the wall foot
    b.hline(0, W - 1, WATER_TOP, C.TILE_D); dith(b, 0, WATER_TOP + 1, W, 2, C.TILE_D, 2);
  }
  // ── a little moored punt on the open water, and lotus pads along the near edge ──
  {
    const bx = 808, bw = 128, wl = 570; // a punt with a woven awning (乌篷船), bow on the left, waterline y
    // its reflection first: a dark, broken smear under the hull and the awning
    for (let x = bx + 6; x < bx + bw - 10; x++) for (let y = wl + 1; y < wl + 12; y++) if ((y + (x >> 3)) % 4) b.set(x, y, (y - wl) % 4 === 1 ? C.TILE : C.TILE_D);
    for (let x = bx + 44; x < bx + 86; x++) for (let y = wl + 12; y < wl + 12 + 14 * Math.sqrt(Math.max(0, 1 - ((x - bx - 65) / 21) ** 2)); y++) if ((y + (x >> 2)) % 3) b.set(x, y, C.TILE_D);
    const hull = [[bx, wl - 14], [bx + 10, wl - 9], [bx + bw - 14, wl - 10], [bx + bw, wl - 18], [bx + bw - 6, wl - 6], [bx + bw - 22, wl + 2], [bx + 18, wl + 2], [bx + 4, wl - 5]];
    b.poly(hull, C.BROWN);
    b.line(bx, wl - 14, bx + 10, wl - 9, C.WOOD_L); b.line(bx + 10, wl - 9, bx + bw - 14, wl - 10, C.WOOD_L); b.line(bx + bw - 14, wl - 10, bx + bw, wl - 18, C.WOOD_L);
    b.line(bx + 1, wl - 13, bx + 10, wl - 8, C.WOOD); b.line(bx + 10, wl - 8, bx + bw - 14, wl - 9, C.WOOD); b.line(bx + bw - 14, wl - 9, bx + bw - 1, wl - 17, C.WOOD);
    b.line(bx + 8, wl - 3, bx + bw - 12, wl - 4, C.DBROWN); b.hline(bx + 18, bx + bw - 22, wl + 1, C.DBROWN); b.hline(bx + 16, bx + bw - 20, wl + 2, C.DBROWN);
    // the awning: a half-barrel of woven bamboo, open at the front
    const ac = bx + 64, ar = 22, ah = 18;
    for (let x = ac - ar; x <= ac + ar; x++) {
      const top = Math.round(wl - 10 - ah * Math.sqrt(Math.max(0, 1 - ((x - ac) / ar) ** 2)));
      for (let y = top; y < wl - 9; y++) b.set(x, y, (x + y) % 3 === 0 ? C.BROWN : C.DBROWN);
      b.set(x, top, x < ac ? C.WOOD_L : C.WOOD);
      if ((x - ac + ar) % 8 === 4) b.vline(x, top + 1, wl - 10, C.WOOD);
    }
    for (let y = wl - 22; y < wl - 9; y++) { b.set(ac - ar + 1, y, C.DEEP); b.set(ac - ar + 2, y, C.DEEP); }
    // the punting pole, leaning from the stern
    b.line(bx + bw - 26, wl - 10, bx + bw - 2, wl - 60, C.WOOD); b.line(bx + bw - 25, wl - 10, bx + bw - 1, wl - 60, C.DBROWN);
    b.hline(bx - 6, bx + bw + 4, wl + 2, C.SKY_L); b.hline(bx + 12, bx + bw - 18, wl + 13, C.SKY);
    // mooring post at the bank, the rope slack between
    b.rect(bx + bw + 26, wl + 4, 5, 26, C.BROWN); b.vline(bx + bw + 26, wl + 4, wl + 29, C.WOOD); b.hline(bx + bw + 26, bx + bw + 30, wl + 4, C.WOOD_L);
    for (let x = bx + bw - 2; x < bx + bw + 26; x++) { const t = (x - bx - bw + 2) / 28; b.set(x, Math.round(wl - 14 + t * 22 + Math.sin(t * Math.PI) * 6), C.DBROWN); }
    // lotus pads
    const r = rng(61);
    for (const [cx, cy, n] of [[560, 588, 9], [690, 590, 7], [1080, 586, 8]]) for (let i = 0; i < n; i++) {
      const x = cx + Math.round((r() - 0.5) * 90), y = cy + Math.round((r() - 0.5) * 12), rr = 5 + Math.floor(r() * 5);
      b.ellipse(x + 1, y + 1, rr, Math.max(2, rr >> 1), C.TILE_D); b.ellipse(x, y, rr, Math.max(2, rr >> 1), C.GRN); b.hline(x - rr + 2, x - 1, y - 1, C.GRN_L); b.set(x, y, C.GRN_D);
      if (i % 4 === 1) { b.vline(x + 2, y - 10, y - 1, C.GRN_D); b.ellipse(x + 2, y - 12, 2, 3, C.PINK); b.set(x + 1, y - 13, C.PAPER); }
    }
  }
  // ── 4. the near bank: a white stone kerb, a grass verge with willows, a paved walk, grass ──
  {
    const r = rng(44), k0 = WATER_BOT, v0 = WATER_BOT + 14, p0 = 634, p1 = 690;
    dith(b, 0, k0 - 3, W, 3, C.BLU_D, 2);
    b.rect(0, k0, W, 14, C.STONE_L); b.hline(0, W - 1, k0, C.PAPER); b.hline(0, W - 1, k0 + 1, C.JADE); b.hline(0, W - 1, k0 + 13, C.STONE);
    for (let x = 0; x < W; x += 52) { b.vline(x, k0 + 2, k0 + 12, C.STONE); b.vline(x + 1, k0 + 2, k0 + 12, C.PAPER); }
    b.rect(0, v0, W, H - v0, C.GRN);
    for (let y = v0; y < H; y++) for (let x = 0; x < W; x++) { const v = r(); if (v < 0.06) b.set(x, y, C.GRN_D); else if (v < 0.09) b.set(x, y, C.GRN_L); }
    // the walk: square stone flags, worn, edged with a kerb of narrow stones
    b.rect(0, p0, W, p1 - p0, C.STONE);
    for (let y = p0 + 3, row = 0; y < p1 - 3; y += 17, row++) for (let x = -(row % 2) * 18; x < W; x += 36) {
      const v = r(), c = v < 0.6 ? C.STONE_L : v < 0.85 ? C.PLASTER_S : C.STONE;
      b.rect(x + 1, y + 1, 34, 15, c); b.hline(x + 1, x + 34, y + 1, c === C.STONE ? C.STONE_L : C.JADE); b.vline(x + 34, y + 1, y + 15, C.STONE);
    }
    for (const yy of [p0, p1 - 3]) { b.rect(0, yy, W, 3, C.STONE_D); b.hline(0, W - 1, yy, C.STONE); }
    for (let k = 0; k < 160; k++) { const x = Math.floor(r() * W), y = v0 + 2 + Math.floor(r() * (p0 - v0 - 4)); b.set(x, y, C.GRN_L); b.set(x, y - 1, C.GRN); }
    for (let k = 0; k < 220; k++) { const x = Math.floor(r() * W), y = p1 + 4 + Math.floor(r() * (H - p1 - 6)); const c = [C.PAPER, C.GOLD_L, C.PUR_L, C.PINK][Math.floor(r() * 4)]; if (b.get(x, y) === C.GRN) { b.set(x, y, c); b.set(x + 1, y, c); b.set(x, y + 1, C.GRN_D); } }
  }
  for (const [x, sd, s] of [[84, 1, 1.0], [262, 2, 0.86], [1020, 3, 0.9], [1196, 4, 1.05]]) willow(b, x, WATER_BOT + 30, sd, s);

  return {
    bg: b,
    spots: {
      walk: [{ x0: 4, x1: 638, y0: 322, y1: 343 }],
      doors: { chengtian: [628, 317, 12, 28] },
      emperorStart: [300, 334],
      title: [320, 356],
      water: [0, WATER_TOP / 2 + 2, 640, (WATER_BOT - WATER_TOP) / 2 - 4],
      moon: [436, 254],
      lanterns: [],
      birds: true,
      npcs: [
        { kind: 'guard', x: 470, y: 330, facing: 'left', act: 'patrol', route: [[600, 330], [80, 330]] },
      ],
      cat: [[150, 340], [520, 338]],
    },
  };
}
