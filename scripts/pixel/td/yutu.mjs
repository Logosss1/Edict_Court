// 宫城舆图 — the palace map: a flat top-down overview painted on aged paper and mounted in brocade.
// North is up. The moat rings the palace wall with a corner tower at each corner; the central axis runs from
// the garden in the north through the back palaces, the three great halls on their marble terrace and the
// square, down through 太和门 and 午门 to 端门 and 承天门 on the imperial city wall in the south. West lie the
// imperial lakes. Every scene of the game is one place on the map, painted in full colour; everything else
// is painted paler so the places read at a glance. Blank label slips sit beside each place for the game to
// write the names on.
import { Bitmap, C, rng, W, H, frame, shade, DARK } from './common.mjs';

const BAYER = [[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]];

// roof palettes for buildings seen from above: slopes facing n / w / s / e, ridges, tile channels, outline
const YEL = { n: C.GOLD_L, w: C.GOLD_L, s: C.GOLD, e: C.GOLD_D, rid: C.GOLD_D, str: C.GOLD, str2: C.GOLD_D, line: C.DBROWN };
const PALE = { n: C.GOLD_L, w: C.PAPER, s: C.GOLD, e: C.GOLD, rid: C.PAPER, str: C.GOLD, str2: C.GOLD_D, line: C.WOOD };
const GRNR = { n: C.GRN_L, w: C.GRN_L, s: C.GRN, e: C.GRN_D, rid: C.GRN_D, str: C.GRN, str2: C.GRN_D, line: C.DBROWN };
const GREY = { n: C.STONE_L, w: C.STONE_L, s: C.TILE_L, e: C.TILE, rid: C.TILE, str: C.TILE_L, str2: C.TILE, line: C.TILE_D };

/** a soft drop shadow to the lower right of a rectangle */
function drop(b, x, y, w, h, d = 3) {
  shade(b, [[x + w, y + d], [x + w + d, y + d], [x + w + d, y + h + d], [x + d, y + h + d], [x + d, y + h], [x + w, y + h]], DARK, 1);
}

/** a hip roof seen from straight above: four slopes meeting in hips and a ridge, lit from the top left */
function roof(b, x, y, w, h, P = YEL, o = {}) {
  if (o.shadow !== false) drop(b, x, y, w, h, o.d ?? 3);
  const tex = o.tex ?? w * h > 500;
  for (let py = y; py < y + h; py++) for (let px = x; px < x + w; px++) {
    const dl = px - x, dr = x + w - 1 - px, dt = py - y, db = y + h - 1 - py, m = Math.min(dl, dr, dt, db);
    const hits = (dl === m) + (dr === m) + (dt === m) + (db === m);
    let c;
    if (hits > 1) c = P.rid;
    else if (m === dt || m === db) { c = m === dt ? P.n : P.s; if (tex && m > 0 && (px - x) % 3 === 2) c = m === dt ? P.str : P.str2; }
    else { c = m === dl ? P.w : P.e; if (tex && m > 0 && (py - y) % 3 === 2) c = m === dl ? P.str : P.str2; }
    b.set(px, py, c);
  }
  frame(b, x, y, w, h, P.line);
  if (o.double) {
    const k = o.k ?? Math.max(3, Math.round(Math.min(w, h) * 0.2));
    roof(b, x + k, y + k, w - 2 * k, h - 2 * k, P, { shadow: false, tex });
    b.hline(x + k + 1, x + w - k, y + h - k, P.line === C.WOOD ? C.GOLD_D : C.BROWN); b.vline(x + w - k, y + k + 1, y + h - k, P.line === C.WOOD ? C.GOLD_D : C.BROWN);
  }
}

/** a courtyard: a paved or open floor inside a thin red wall, with optional gaps (gates) */
function court(b, x, y, w, h, fill, o = {}) {
  if (fill !== null) b.rect(x, y, w, h, fill);
  const wc = o.wall ?? C.RED, wd = o.wallD ?? C.RED_M;
  b.hline(x, x + w - 1, y, wc); b.hline(x, x + w - 1, y + 1, wd);
  b.vline(x, y, y + h - 1, wc); b.vline(x + 1, y, y + h - 1, wd);
  b.hline(x, x + w - 1, y + h - 2, wc); b.hline(x, x + w - 1, y + h - 1, wd);
  b.vline(x + w - 2, y, y + h - 1, wc); b.vline(x + w - 1, y, y + h - 1, wd);
  for (const [gx, gy, gw, gh] of o.gaps ?? []) b.rect(gx, gy, gw, gh, o.gapFill ?? C.PAPER);
}

/** a round tree crown seen from above */
function tree(b, x, y, r, dark = false) {
  b.ellipse(x + 2, y + 2, r, r, C.PLASTER_S);
  b.ellipse(x, y, r, r, dark ? C.GRN_D : C.GRN);
  if (r > 2) { b.ellipse(x - 1, y - 1, r - 2, r - 2, dark ? C.GRN : C.GRN_L); b.set(x + Math.round(r * 0.5), y + Math.round(r * 0.5), C.GRN_D); }
}
/** a willow seen from above: a softer, paler crown with drooping fringe */
function willowTop(b, x, y, r) {
  b.ellipse(x + 2, y + 2, r, r, C.PLASTER_S);
  for (let a = 0; a < 6.28; a += 0.5) b.set(Math.round(x + Math.cos(a) * (r + 1)), Math.round(y + Math.sin(a) * (r + 1)), C.GRN);
  b.ellipse(x, y, r, r, C.GRN); b.ellipse(x - 1, y - 1, r - 2, r - 2, C.GRN_L);
  for (let i = -r + 2; i < r - 1; i += 2) b.vline(x + i, y - 1, y + 1, C.GRN);
}

/** fill a mask with water: pale wash, a teal shore line, and rows of little wave crests */
function water(b, mask, seed = 1) {
  const r = rng(seed), inside = (x, y) => x >= 0 && y >= 0 && x < W && y < H && mask.get(x, y) === 1;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (inside(x, y)) {
    const edge = !inside(x - 1, y) || !inside(x + 1, y) || !inside(x, y - 1) || !inside(x, y + 1);
    b.set(x, y, edge ? C.TEAL : C.SKY_L);
  }
  // a second shore line just inside, broken, like a brush going round twice
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (inside(x, y) && b.get(x, y) === C.SKY_L) {
    const near = !inside(x - 2, y) || !inside(x + 2, y) || !inside(x, y - 2) || !inside(x, y + 2);
    if (near && (x + y) % 3) b.set(x, y, C.SKY);
  }
  const crest = [1, 0, 0, 0, 1];
  for (let y0 = 3; y0 < H; y0 += 7) for (let x0 = ((y0 / 7) % 2 < 1 ? 0 : 6) + Math.floor(r() * 2); x0 < W; x0 += 12) {
    let ok = true;
    for (let i = -2; i < 7 && ok; i++) for (let j = -2; j < 4; j++) if (!inside(x0 + i, y0 + j)) { ok = false; break; }
    if (!ok) continue;
    for (let i = 0; i < 5; i++) b.set(x0 + i, y0 + crest[i], C.SKY);
  }
}

/** the palace wall seen from above: red faces either side of a yellow-tiled coping */
function palaceWall(b, x, y, w, h, t = 8) {
  const band = (k, c) => { b.hline(x + k, x + w - 1 - k, y + k, c); b.hline(x + k, x + w - 1 - k, y + h - 1 - k, c); b.vline(x + k, y + k, y + h - 1 - k, c); b.vline(x + w - 1 - k, y + k, y + h - 1 - k, c); };
  const cols = [C.DBROWN, C.RED, C.RED, C.GOLD_L, C.GOLD, C.RED_M, C.RED_M, C.DBROWN];
  for (let k = 0; k < t; k++) band(k, cols[k]);
  // crenels along the outer face
  for (let xx = x + 4; xx < x + w - 4; xx += 6) { b.set(xx, y + 1, C.RED_D); b.set(xx, y + h - 2, C.RED_D); }
  for (let yy = y + 4; yy < y + h - 4; yy += 6) { b.set(x + 1, yy, C.RED_D); b.set(x + w - 2, yy, C.RED_D); }
}

/** the cross-shaped corner tower (角楼) seen from above, on its bastion at a corner of the wall */
function cornerTower(b, cx, cy, s = 1, P = YEL) {
  const a = Math.round(18 * s), n = Math.round(9 * s), c = Math.round(7 * s);
  b.rect(cx - a - 3, cy - a - 3, 2 * a + 6, 2 * a + 6, C.STONE_L); frame(b, cx - a - 3, cy - a - 3, 2 * a + 6, 2 * a + 6, C.STONE);
  drop(b, cx - a - 3, cy - a - 3, 2 * a + 6, 2 * a + 6, 2);
  roof(b, cx - a, cy - n, 2 * a, 2 * n, P, { tex: true });
  roof(b, cx - n, cy - a, 2 * n, 2 * a, P, { tex: true, shadow: false });
  roof(b, cx - c - 2, cy - c - 2, 2 * c + 4, 2 * c + 4, P, { shadow: false, tex: false });
  roof(b, cx - c + 2, cy - c + 2, 2 * c - 4, 2 * c - 4, P, { shadow: false, tex: false });
  b.rect(cx - 1, cy - 1, 2, 2, C.GOLD_L);
}

/** a blank paper label slip (签条) centred on (x, y) for `n` characters */
function slip(b, x, y, n) {
  const w = n * 12 + 12, h = 18, x0 = Math.round(x - w / 2), y0 = Math.round(y - h / 2);
  b.rect(x0 + 2, y0 + 2, w, h, C.PLASTER_S);
  b.rect(x0, y0, w, h, C.JADE); b.hline(x0, x0 + w - 1, y0, C.WOOD); b.hline(x0, x0 + w - 1, y0 + h - 1, C.WOOD);
  b.hline(x0 + 3, x0 + w - 4, y0 + 2, C.PAPER); b.hline(x0 + 3, x0 + w - 4, y0 + h - 3, C.PAPER);
  for (const ex of [x0, x0 + w - 3]) { b.rect(ex, y0 - 1, 3, h + 2, C.GOLD); b.vline(ex, y0 - 1, y0 + h, C.GOLD_L); b.vline(ex + 2, y0 - 1, y0 + h, C.GOLD_D); b.set(ex + 1, y0 - 1, C.BROWN); b.set(ex + 1, y0 + h, C.BROWN); }
}

/** an eight-point compass rose; the north point in red */
function compass(b, cx, cy, R) {
  b.ellipse(cx + 2, cy + 2, R - 8, R - 8, C.PLASTER_S);
  for (let a = 0; a < 6.283; a += 0.01) { b.set(Math.round(cx + Math.cos(a) * (R - 8)), Math.round(cy + Math.sin(a) * (R - 8)), C.BROWN); b.set(Math.round(cx + Math.cos(a) * (R - 12)), Math.round(cy + Math.sin(a) * (R - 12)), C.WOOD_L); }
  for (let k = 0; k < 16; k++) { const a = (k * Math.PI) / 8; b.line(Math.round(cx + Math.cos(a) * (R - 12)), Math.round(cy + Math.sin(a) * (R - 12)), Math.round(cx + Math.cos(a) * (R - 8)), Math.round(cy + Math.sin(a) * (R - 8)), C.BROWN); }
  const point = (ang, len, wd, light, dark) => {
    const tx = cx + Math.cos(ang) * len, ty = cy + Math.sin(ang) * len, px = Math.cos(ang + Math.PI / 2) * wd, py = Math.sin(ang + Math.PI / 2) * wd;
    b.poly([[cx, cy], [Math.round(tx), Math.round(ty)], [Math.round(cx + px), Math.round(cy + py)]], light);
    b.poly([[cx, cy], [Math.round(tx), Math.round(ty)], [Math.round(cx - px), Math.round(cy - py)]], dark);
    b.line(cx, cy, Math.round(tx), Math.round(ty), dark);
  };
  for (let k = 0; k < 4; k++) point(Math.PI / 4 + (k * Math.PI) / 2, R * 0.55, 5, C.PAPER, C.WOOD);
  point(-Math.PI / 2, R, 8, C.RED_L, C.RED_D);
  point(Math.PI / 2, R - 6, 8, C.PAPER, C.DBROWN);
  point(0, R - 6, 8, C.PAPER, C.DBROWN);
  point(Math.PI, R - 6, 8, C.PAPER, C.DBROWN);
  b.ellipse(cx, cy, 4, 4, C.GOLD); b.ellipse(cx - 1, cy - 1, 2, 2, C.GOLD_L); b.set(cx + 2, cy + 2, C.GOLD_D);
}

export function yutu() {
  const b = new Bitmap(W, H);
  const r = rng(5);

  // ── aged paper: a warm sheet, mottled, browner toward the edges, the faint survey grid (计里画方) ──
  b.rect(0, 0, W, H, C.PAPER);
  for (let k = 0; k < 26; k++) {
    const cx = Math.floor(r() * W), cy = Math.floor(r() * H), rx = 30 + Math.floor(r() * 90), ry = 20 + Math.floor(r() * 50);
    for (let y = cy - ry; y <= cy + ry; y++) for (let x = cx - rx; x <= cx + rx; x++) {
      const d = ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2;
      if (d < 1 && x >= 0 && y >= 0 && x < W && y < H && (1 - d) * 5 > BAYER[y & 3][x & 3] + 0.5 && (x * 3 + y * 7) % 5 === 0) b.set(x, y, C.PLASTER_S);
    }
  }
  for (let x = 40; x < W; x += 80) for (let y = 16; y < H; y += 2) b.set(x, y, C.PLASTER_S);
  for (let y = 40; y < H; y += 80) for (let x = 16; x < W; x += 2) b.set(x, y, C.PLASTER_S);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const e = Math.min(x, y, W - 1 - x, H - 1 - y);
    if (e < 44 && (44 - e) / 2.4 > BAYER[y & 3][x & 3] + 0.5) b.set(x, y, e < 20 && (44 - e) / 2.4 > BAYER[y & 3][x & 3] + 9 && (x * 5 + y * 3) % 7 === 0 ? C.WOOD_L : C.PLASTER_S);
  }
  for (let k = 0; k < 18; k++) { // foxing
    const x = Math.floor(r() * W), y = Math.floor(r() * H), n = 2 + Math.floor(r() * 5);
    for (let i = 0; i < n; i++) b.set(x + Math.floor(r() * 5), y + Math.floor(r() * 4), r() < 0.5 ? C.WOOD_L : C.GOLD_L);
  }

  // ── the imperial city wall (皇城): a thin red line round the whole sheet, the south side carries 承天门 ──
  const IW = { x0: 30, x1: 1250, y0: 28, y1: 652 };
  for (const k of [0, 1]) { b.hline(IW.x0 + k, IW.x1 - k, IW.y0 + k, k ? C.RED_M : C.RED); b.vline(IW.x0 + k, IW.y0, IW.y1, k ? C.RED_M : C.RED); b.vline(IW.x1 - k, IW.y0, IW.y1, k ? C.RED_M : C.RED); }

  // ── the western lakes (三海) with their islands, the white dagoba on 琼华岛 ──
  {
    const m = new Bitmap(W, H);
    const balls = [[150, 120, 62], [210, 150, 56], [120, 180, 40], [196, 214, 44], [96, 96, 34], [240, 96, 30], [176, 252, 16], [174, 276, 15],
      [186, 312, 36], [160, 350, 34], [200, 380, 30], [176, 420, 30], [184, 452, 14], [176, 476, 16], [150, 516, 44], [206, 520, 40], [178, 568, 38], [118, 552, 26]];
    for (let y = 30; y < 640; y++) for (let x = 30; x < 300; x++) {
      let f = 0; for (const [bx, by, br] of balls) f += (br * br) / ((x - bx) ** 2 + (y - by) ** 2 + 1);
      if (f > 1.6 + 0.14 * Math.sin(x / 7 + y / 11) * Math.sin(y / 5 - x / 13)) m.set(x, y, 1);
    }
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const d1 = ((x - 172) / 40) ** 2 + ((y - 134) / 34) ** 2, d2 = ((x - 178) / 30) ** 2 + ((y - 524) / 17) ** 2;
      if (d1 < 1 + 0.15 * Math.sin(x / 4 + y / 6) || d2 < 1) m.set(x, y, 0); // islands
    }
    water(b, m, 3);
    // 琼华岛: wooded island, the white dagoba on its crown, a bridge to the south shore
    for (const [x, y, rr] of [[150, 118, 7], [196, 120, 8], [140, 146, 7], [204, 150, 7], [166, 162, 8], [186, 160, 6]]) tree(b, x, y, rr);
    b.ellipse(175, 132, 9, 9, C.JADE); b.ellipse(175, 132, 9, 9, C.JADE); frame(b, 166, 141, 19, 3, C.STONE);
    b.ellipse(176, 133, 8, 8, C.STONE_L); b.ellipse(174, 131, 6, 6, C.JADE); b.vline(175, 116, 124, C.GOLD_D); b.set(175, 115, C.GOLD); b.rect(173, 124, 5, 2, C.STONE);
    b.rect(170, 168, 10, 22, C.STONE_L); frame(b, 170, 168, 10, 22, C.STONE); for (let y = 171; y < 188; y += 3) b.hline(171, 178, y, C.PAPER);
    b.rect(160, 262, 32, 8, C.STONE_L); frame(b, 160, 262, 32, 8, C.STONE); for (let x = 163; x < 190; x += 3) b.set(x, 265, C.PAPER); // 金鳌玉蝀桥
    // 瀛台 on the southern island: a small pale pavilion court
    roof(b, 166, 512, 28, 14, PALE); tree(b, 158, 526, 4); tree(b, 202, 524, 4);
    // lotus beds
    for (const [x, y] of [[240, 200], [96, 214], [205, 310], [212, 430], [118, 548]]) for (let i = 0; i < 7; i++) { const a = r() * 6.28, d = r() * 9; b.ellipse(Math.round(x + Math.cos(a) * d), Math.round(y + Math.sin(a) * d * 0.6), 2, 2, i % 2 ? C.GRN_L : C.GRN); }
    // willows round the shores, pale pavilions
    for (const [x, y] of [[60, 60], [280, 64], [56, 200], [276, 230], [134, 262], [236, 296], [118, 326], [246, 420], [130, 420], [262, 500], [86, 490], [250, 600], [80, 612]]) willowTop(b, x, y, 6);
    roof(b, 226, 40, 26, 12, PALE); roof(b, 60, 340, 14, 22, PALE); roof(b, 262, 452, 14, 20, PALE); roof(b, 72, 230, 22, 12, PALE);
  }

  // ── the moat (筒子河) ring, open in front of 午门 ──
  const MO = { x0: 316, y0: 34, x1: 964, y1: 546 }, WA = { x0: 338, y0: 56, x1: 942, y1: 524 };
  {
    const m = new Bitmap(W, H);
    m.rect(MO.x0, MO.y0, MO.x1 - MO.x0, MO.y1 - MO.y0, 1);
    m.rect(WA.x0, WA.y0, WA.x1 - WA.x0, WA.y1 - WA.y0, 0);
    m.rect(566, WA.y1, 148, MO.y1 - WA.y1, 0);
    water(b, m, 7);
    // stone bridges: north (神武门), west (西华门), east (东华门)
    for (const [x, y, w, h] of [[624, MO.y0 - 2, 32, 26], [MO.x0 - 2, 318, 26, 24], [WA.x1 - 2, 318, 26, 24]]) { b.rect(x, y, w, h, C.STONE_L); frame(b, x, y, w, h, C.STONE); drop(b, x, y, w, h, 2); }
    // willows along the outer banks, thickest along the south bank by the western corner (the 角楼 walk)
    for (let x = 334; x < 560; x += 26) willowTop(b, x, 556, 6);
    for (let x = 980; x < 1240; x += 34) willowTop(b, x, 40, 5);
    for (let y = 60; y < 520; y += 40) willowTop(b, 302, y, 5);
  }

  // ── inside the wall: the ground of the palace city, then the wall itself with gate towers ──
  b.rect(WA.x0 + 8, WA.y0 + 8, WA.x1 - WA.x0 - 16, WA.y1 - WA.y0 - 16, C.PAPER);
  for (let y = WA.y0 + 8; y < WA.y1 - 8; y++) for (let x = WA.x0 + 8; x < WA.x1 - 8; x++) if ((x + 2 * y) % 7 === 0 && (x * y) % 3 === 0) b.set(x, y, C.PLASTER_S);
  palaceWall(b, WA.x0, WA.y0, WA.x1 - WA.x0, WA.y1 - WA.y0);
  // the 午门 forecourt between its wings, paved
  b.rect(566, WA.y1, 148, 38, C.STONE_L);
  for (let y = WA.y1 + 4; y < WA.y1 + 38; y += 6) for (let x = 568; x < 712; x += 2) b.set(x, y, C.PLASTER_S);

  // ── the north: 神武门 and the imperial garden (御花园) ──
  roof(b, 604, 46, 72, 26, PALE, { double: true });
  const G = { x: 536, y: 74, w: 208, h: 90 };
  {
    court(b, G.x, G.y, G.w, G.h, C.GRN_L, { gaps: [[630, G.y + G.h - 2, 20, 2], [G.x, 102, 2, 12]] });
    for (let y = G.y + 2; y < G.y + G.h - 2; y++) for (let x = G.x + 2; x < G.x + G.w - 2; x++) if ((x + y) % 2 === 0 && (x * 7 + y * 3) % 5 < 2) b.set(x, y, C.GRN);
    // paths: the axis and a cross walk, pebble-paved
    b.rect(634, G.y + 2, 12, G.h - 4, C.PLASTER_S); b.rect(G.x + 2, 104, G.w - 4, 8, C.PLASTER_S);
    for (let y = G.y + 3; y < G.y + G.h - 3; y += 3) b.set(639 + ((y / 3) % 2 < 1 ? 0 : 2), y, C.STONE_L);
    // 钦安殿 in the middle on its terrace
    b.rect(612, 82, 56, 30, C.JADE); frame(b, 612, 82, 56, 30, C.STONE);
    roof(b, 616, 86, 48, 20, YEL, { double: true, k: 4 });
    // 堆秀山 rockery against the north wall, the little 御景亭 on its top
    const rk = [[682, 78], [700, 76], [722, 80], [734, 92], [728, 104], [708, 108], [690, 102], [680, 90]];
    shade(b, rk.map(([x, y]) => [x + 3, y + 3]), DARK, 1);
    b.poly(rk, C.STONE); b.poly(rk.map(([x, y]) => [Math.round(700 + (x - 704) * 0.8), Math.round(88 + (y - 92) * 0.8)]), C.STONE_L);
    for (const [x, y] of [[690, 86], [718, 88], [712, 100], [694, 96]]) { b.set(x, y, C.STONE_D); b.set(x + 1, y, C.STONE_D); b.set(x, y - 1, C.JADE); }
    roof(b, 701, 84, 12, 12, YEL, { tex: false });
    // 万春亭 (east) and 千秋亭 (west): cross-shaped pavilions
    for (const px of [578, 702]) { roof(b, px - 10, 126, 20, 12, YEL, { tex: false }); roof(b, px - 6, 122, 12, 20, YEL, { tex: false, shadow: false }); roof(b, px - 4, 128, 8, 8, YEL, { tex: false, shadow: false }); }
    // a pond with a pavilion across it (浮碧亭) in the north-west
    const pm = new Bitmap(W, H); pm.rect(546, 80, 44, 18, 1); water(b, pm, 11);
    roof(b, 560, 82, 16, 14, YEL, { tex: false });
    // ancient cypresses
    for (const [x, y] of [[552, 116], [566, 150], [596, 112], [606, 148], [676, 150], [690, 118], [716, 148], [734, 120], [556, 134], [622, 128], [660, 128], [728, 134]]) tree(b, x, y, 5, true);
    for (const [x, y] of [[588, 146], [656, 146], [700, 146]]) tree(b, x, y, 3);
  }

  // ── the back palaces (后三宫) and the six eastern and western palaces, painted pale ──
  {
    court(b, 580, 168, 120, 78, C.PLASTER_S, { gaps: [[630, 244, 20, 2]], gapFill: C.PLASTER_S });
    roof(b, 594, 172, 92, 18, PALE, { double: true });
    roof(b, 626, 196, 28, 16, PALE);
    roof(b, 590, 218, 100, 24, PALE, { double: true });
    roof(b, 612, 244, 56, 12, PALE);
    for (const side of [-1, 1]) for (let i = 0; i < 3; i++) for (let j = 0; j < 2; j++) {
      const x = side < 0 ? 408 + i * 56 : 708 + i * 56, y = 170 + j * 38;
      court(b, x, y, 52, 34, C.PLASTER_S, { wall: C.RED_L, wallD: C.RED, gaps: [[x + 22, y + 32, 8, 2]], gapFill: C.PAPER });
      roof(b, x + 8, y + 6, 36, 12, PALE);
      tree(b, x + 12, y + 25, 3); tree(b, x + 40, y + 25, 3);
    }
    // the cross street (横街) between the back palaces and the front court
    b.rect(WA.x0 + 8, 256, WA.x1 - WA.x0 - 16, 8, C.STONE_L);
    b.hline(WA.x0 + 8, WA.x1 - 9, 256, C.STONE); b.hline(WA.x0 + 8, WA.x1 - 9, 263, C.PLASTER_S);
  }

  // ── 宫道长街: the long street on the west, between red walls, from the garden down to 军机处 ──
  const GD = { x: 370, y: 96, w: 24, h: 224 };
  {
    b.rect(GD.x, GD.y, GD.w, GD.h, C.STONE_L);
    b.rect(GD.x, GD.y, 166, 18, C.STONE_L); // the turn east into the garden's west gate
    b.rect(GD.x, GD.y + GD.h - 18, 34, 18, C.STONE_L); // and the turn into 军机处 at the south end
    for (let y = GD.y + 2; y < GD.y + GD.h; y += 4) b.hline(GD.x + 3, GD.x + GD.w - 4, y, C.PLASTER_S);
    for (let x = GD.x + 26; x < 534; x += 4) b.vline(x, GD.y + 3, GD.y + 14, C.PLASTER_S);
    b.rect(GD.x + 10, GD.y, 4, GD.h, C.PAPER); b.rect(GD.x + 10, GD.y + 7, 160, 4, C.PAPER);
    // red walls both sides with yellow coping
    const wallV = (x, y0, y1) => { b.vline(x, y0, y1, C.RED); b.vline(x + 1, y0, y1, C.GOLD); b.vline(x + 2, y0, y1, C.RED_M); };
    const wallH = (x0, x1, y) => { b.hline(x0, x1, y, C.RED); b.hline(x0, x1, y + 1, C.GOLD); b.hline(x0, x1, y + 2, C.RED_M); };
    wallV(GD.x - 3, GD.y - 3, GD.y + GD.h + 2); wallV(GD.x + GD.w, GD.y + 18, GD.y + GD.h - 21);
    wallH(GD.x - 3, 534, GD.y - 3); wallH(GD.x + GD.w, 534, GD.y + 18);
    wallH(GD.x - 3, GD.x + 33, GD.y + GD.h); wallH(GD.x + GD.w, GD.x + 33, GD.y + GD.h - 21);
    // stone lanterns along it
    for (let y = GD.y + 24; y < GD.y + GD.h - 20; y += 28) { b.rect(GD.x + 3, y, 3, 3, C.STONE); b.set(GD.x + 3, y, C.JADE); b.rect(GD.x + 18, y + 14, 3, 3, C.STONE); b.set(GD.x + 18, y + 14, C.JADE); }
    // the end gates
    roof(b, GD.x - 4, GD.y + GD.h - 6, 32, 10, YEL, { tex: false });
    roof(b, 524, GD.y - 2, 12, 22, YEL, { tex: false });
  }

  // ── 军机处: a plain row of grey-roofed rooms in a small court, west of the great halls ──
  const JJ = { x: 404, y: 300, w: 96, h: 50 };
  {
    court(b, JJ.x, JJ.y, JJ.w, JJ.h, C.STONE_L, { gaps: [[JJ.x, JJ.y + 22, 2, 12], [JJ.x + JJ.w - 2, JJ.y + 22, 2, 12]], gapFill: C.STONE_L });
    roof(b, JJ.x + 6, JJ.y + 5, 84, 18, GREY);
    roof(b, JJ.x + 8, JJ.y + 32, 30, 12, GREY, { tex: false }); roof(b, JJ.x + 58, JJ.y + 32, 30, 12, GREY, { tex: false });
    tree(b, JJ.x + 48, JJ.y + 40, 4);
  }

  // ── the front court: the three great halls on the marble terrace, the square, 太和门 ──
  {
    // corridor ranges (廊庑) enclosing the court of 太和殿
    roof(b, 510, 266, 10, 196, PALE, { tex: false }); roof(b, 760, 266, 10, 196, PALE, { tex: false });
    roof(b, 520, 266, 40, 10, PALE, { tex: false, shadow: false }); roof(b, 720, 266, 40, 10, PALE, { tex: false, shadow: false });
    // 三台: the three-tier white marble terrace, 土-shaped, with balustrade dots and stairs
    const tr = [[572, 266], [708, 266], [708, 310], [718, 310], [718, 386], [562, 386], [562, 310], [572, 310]];
    shade(b, tr.map(([x, y]) => [x + 4, y + 4]), DARK, 1);
    b.poly(tr, C.STONE_L); b.poly([[576, 270], [704, 270], [704, 314], [714, 314], [714, 382], [566, 382], [566, 314], [576, 314]], C.JADE);
    for (let x = 568; x < 714; x += 3) { b.set(x, 383, C.STONE); b.set(x, 313, C.STONE_L); }
    for (let y = 270; y < 383; y += 3) { b.set(563, y, C.STONE); b.set(716, y, C.STONE); }
    b.rect(630, 386, 20, 8, C.STONE_L); for (let y = 387; y < 394; y += 2) b.hline(631, 648, y, C.STONE); b.rect(636, 386, 8, 8, C.JADE);
    // bronze cranes and turtles, incense burners on the moon platform
    for (const x of [580, 592, 688, 700]) { b.rect(x, 374, 3, 4, C.BRONZE); b.set(x, 374, C.GOLD); }
    // 保和殿 and 中和殿 behind, pale; 太和殿 in front, the biggest roof on the map, double eaves
    roof(b, 590, 274, 100, 22, PALE, { double: true });
    roof(b, 626, 300, 28, 22, PALE, { double: true });
    roof(b, 578, 328, 124, 38, YEL, { double: true, k: 8, d: 4 });
    // the square (太和殿广场): big paving, the raised imperial way, the two pavilions at the sides
    b.rect(520, 394, 240, 62, C.STONE_L);
    for (let y = 396; y < 456; y += 6) for (let x = 520 + ((y / 6) % 2 < 1 ? 0 : 6); x < 760; x += 12) { b.set(x, y, C.STONE); }
    for (let x = 520; x < 760; x += 2) b.set(x, 394, C.STONE);
    b.rect(634, 394, 12, 62, C.JADE); b.vline(633, 394, 455, C.STONE); b.vline(646, 394, 455, C.STONE);
    roof(b, 524, 404, 18, 30, YEL, { tex: false }); roof(b, 738, 404, 18, 30, YEL, { tex: false });
    // bronze vats and the rank markers in two files
    for (const x of [600, 680]) for (let y = 402; y < 452; y += 9) { b.rect(x, y, 2, 3, C.BRONZE); b.set(x, y, C.GOLD); }
    for (const [x, y] of [[552, 402], [728, 402], [552, 446], [728, 446]]) { b.ellipse(x, y, 3, 3, C.BRONZE); b.set(x - 1, y - 1, C.GOLD); }
    // 太和门 closing the square, its side gates
    roof(b, 520, 456, 250, 8, PALE, { tex: false });
    roof(b, 594, 452, 92, 22, PALE, { double: true });
    roof(b, 540, 456, 26, 12, PALE, { tex: false, shadow: false }); roof(b, 714, 456, 26, 12, PALE, { tex: false, shadow: false });
    // 内金水河: the bow-shaped stream in front of 太和门 with its five bridges
    const m = new Bitmap(W, H);
    for (let x = 520; x <= 760; x++) { const t = (x - 640) / 120, y = Math.round(500 - 12 * (1 - t * t)); m.rect(x, y - 3, 1, 7, 1); }
    water(b, m, 13);
    for (const x of [606, 622, 634, 646, 658]) { const w = x === 634 ? 12 : 8, y = Math.round(500 - 12 * (1 - ((x - 640) / 120) ** 2)); b.rect(x, y - 6, w, 12, C.STONE_L); frame(b, x, y - 6, w, 12, C.STONE); }
  }

  // ── 东宫: the crown prince's palace east of the great halls, green-glazed roofs and a bamboo garden ──
  const DG = { x: 782, y: 292, w: 124, h: 80 };
  {
    court(b, DG.x, DG.y, DG.w, DG.h, C.PLASTER_S, { gaps: [[DG.x + 54, DG.y + DG.h - 2, 16, 2]], gapFill: C.PAPER });
    b.rect(DG.x + 2, DG.y + 2, DG.w - 4, DG.h - 4, C.PLASTER_S);
    roof(b, DG.x + 18, DG.y + 8, 88, 22, GRNR, { double: true });
    roof(b, DG.x + 10, DG.y + 40, 14, 30, GRNR, { tex: false }); roof(b, DG.x + 100, DG.y + 40, 14, 30, GRNR, { tex: false });
    roof(b, DG.x + 48, DG.y + DG.h - 8, 28, 12, GRNR, { tex: false });
    // bamboo along the inner court
    for (let i = 0; i < 9; i++) { const x = DG.x + 32 + i * 7, y = DG.y + 44 + (i % 2) * 6; b.ellipse(x, y, 3, 2, C.GRN); b.set(x - 1, y - 1, C.GRN_L); b.set(x + 1, y + 1, C.GRN_D); }
    for (const [x, y] of [[DG.x + 44, DG.y + 62], [DG.x + 80, DG.y + 62]]) tree(b, x, y, 4);
  }

  // ── the rest of the palace ground, pale: 武英殿 west, 文华殿's grounds east, trees ──
  roof(b, 410, 396, 72, 20, PALE, { double: true }); court(b, 400, 384, 92, 66, null, { wall: C.RED_L, wallD: C.RED, gaps: [[440, 448, 12, 2]] });
  roof(b, 420, 428, 52, 12, PALE);
  for (const [x, y] of [[372, 360], [372, 410], [372, 470], [508, 486], [430, 482], [470, 496], [790, 400], [830, 410], [880, 400], [910, 440], [800, 480], [860, 488], [912, 300], [912, 350], [796, 470], [370, 500]]) tree(b, x, y, 5);
  roof(b, 790, 420, 90, 18, PALE); roof(b, 840, 448, 50, 14, PALE);
  // the four corner towers, the SW one is the 角楼 of the game
  for (const [x, y, P] of [[WA.x0 + 4, WA.y0 + 4, PALE], [WA.x1 - 4, WA.y0 + 4, PALE], [WA.x1 - 4, WA.y1 - 4, PALE], [WA.x0 + 4, WA.y1 - 4, YEL]]) cornerTower(b, x, y, 1, P);
  // the side gates on the east and west walls
  roof(b, WA.x0 - 4, 312, 16, 36, PALE, { double: true, k: 3 }); roof(b, WA.x1 - 12, 312, 16, 36, PALE, { double: true, k: 3 });

  // ── 午门: the U-shaped meridian gate with its two wings and corner pavilions ──
  roof(b, 590, 506, 100, 26, PALE, { double: true });
  roof(b, 566, 512, 18, 50, PALE, { tex: false }); roof(b, 696, 512, 18, 50, PALE, { tex: false });
  for (const [x, y] of [[562, 506], [692, 506], [562, 552], [692, 552]]) roof(b, x, y, 26, 14, PALE, { tex: false, shadow: false });

  // ── south of the palace: the avenue, 端门, the 社稷坛 altar, the six ministries, 承天门 ──
  b.rect(634, 562, 12, 84, C.STONE_L); b.vline(633, 562, 645, C.STONE); b.vline(646, 562, 645, C.STONE);
  b.hline(520, 760, 588, C.RED); b.hline(520, 760, 589, C.GOLD); b.hline(520, 760, 590, C.RED_M);
  roof(b, 600, 576, 80, 24, PALE, { double: true });
  {
    // 社稷坛: a square walled altar of five coloured earths in a grove
    court(b, 430, 566, 92, 74, C.PAPER, { wall: C.RED_L, wallD: C.RED });
    b.rect(458, 586, 36, 36, C.JADE); frame(b, 458, 586, 36, 36, C.STONE);
    b.rect(464, 592, 24, 24, C.GOLD_L); b.rect(470, 598, 12, 12, C.GOLD);
    b.hline(464, 487, 592, C.STONE_D); b.hline(464, 487, 615, C.RED); b.vline(464, 592, 615, C.PAPER); b.vline(487, 592, 615, C.GRN);
    for (const [x, y] of [[440, 578], [512, 578], [440, 630], [512, 630], [476, 572]]) tree(b, x, y, 4, true);
    for (const [x, y] of [[360, 584], [394, 604], [356, 628], [544, 610], [404, 572], [560, 636]]) tree(b, x, y, 5);
  }
  // 六部院: six offices in two rows of three across a courtyard strip, grey roofs, in their own wall
  const LB = { x: 744, y: 562, w: 256, h: 82 };
  {
    court(b, LB.x, LB.y, LB.w, LB.h, C.PLASTER_S, { gaps: [[LB.x, LB.y + 32, 2, 18]], gapFill: C.STONE_L });
    b.rect(LB.x + 2, LB.y + 32, LB.w - 4, 18, C.STONE_L);
    for (let x = LB.x + 4; x < LB.x + LB.w - 4; x += 6) b.set(x, LB.y + 41, C.STONE);
    for (let i = 0; i < 3; i++) {
      const x = LB.x + 6 + i * 84;
      roof(b, x, LB.y + 6, 74, 22, GREY); b.rect(x + 33, LB.y + 28, 8, 4, C.DBROWN);
      roof(b, x, LB.y + 54, 74, 22, GREY); b.rect(x + 33, LB.y + 50, 8, 4, C.DBROWN);
    }
    b.ellipse(LB.x + 214, LB.y + 41, 3, 3, C.STONE); b.set(LB.x + 214, LB.y + 41, C.TILE_D); tree(b, LB.x + 40, LB.y + 41, 5);
  }
  // 承天门: the gate tower on the imperial city wall, the outer golden-water stream and its five bridges
  {
    const y0 = IW.y1 - 4;
    for (let k = 0; k < 10; k++) b.hline(IW.x0, IW.x1, y0 + k, [C.DBROWN, C.RED, C.RED, C.GOLD_L, C.GOLD, C.GOLD, C.RED_M, C.RED_M, C.RED_D, C.DBROWN][k]);
    b.rect(568, y0 - 14, 144, 32, C.RED); frame(b, 568, y0 - 14, 144, 32, C.DBROWN); b.hline(569, 710, y0 + 16, C.RED_D);
    drop(b, 568, y0 - 14, 144, 32, 3);
    roof(b, 578, y0 - 24, 124, 36, YEL, { double: true, k: 8, d: 4 });
    const m = new Bitmap(W, H);
    for (let x = 540; x <= 740; x++) { const t = (x - 640) / 100, y = Math.round(y0 + 30 + 5 * t * t); m.rect(x, y - 3, 1, 7, 1); }
    water(b, m, 17);
    for (const x of [592, 610, 634, 658, 676]) { const w = x === 634 ? 12 : 8; b.rect(x, y0 + 22, w, 16, C.STONE_L); frame(b, x, y0 + 22, w, 16, C.STONE); }
    for (const x of [574, 700]) { b.rect(x, y0 + 40, 5, 8, C.JADE); b.rect(x - 2, y0 + 40, 9, 2, C.STONE_L); frame(b, x, y0 + 40, 5, 8, C.STONE); }
    b.rect(634, y0 + 38, 12, H - y0 - 38, C.STONE_L);
  }

  // ── the east margin: a compass rose, the city east of the palace in pale courtyards ──
  compass(b, 1150, 126, 58);
  {
    // courtyard houses (四合院) of the city east of the palace: a main hall on the north, wings east and west, a gate south
    const PG = { n: C.STONE_L, w: C.JADE, s: C.STONE, e: C.STONE, rid: C.JADE, str: C.STONE, str2: C.STONE, line: C.STONE };
    for (const [x, y, w, h] of [[996, 236, 96, 70], [1108, 236, 118, 70], [996, 350, 76, 72], [1086, 350, 140, 72], [1010, 440, 100, 66], [1124, 440, 100, 66]]) {
      court(b, x, y, w, h, C.PLASTER_S, { wall: C.STONE, wallD: C.STONE_L, gaps: [[x + Math.round(w / 2) - 5, y + h - 2, 10, 2]] });
      roof(b, x + 8, y + 6, w - 16, 16, PG, { tex: false });
      roof(b, x + 6, y + 26, 12, h - 40, PG, { tex: false }); roof(b, x + w - 18, y + 26, 12, h - 40, PG, { tex: false });
      roof(b, x + Math.round(w / 2) - 8, y + h - 10, 16, 8, PG, { tex: false });
      tree(b, x + 28, y + h - 18, 4);
    }
  }
  b.rect(964, 322, IW.x1 - 964, 14, C.PLASTER_S); for (let x = 966; x < IW.x1; x += 4) b.set(x, 328, C.STONE_L);
  for (const [x, y] of [[990, 210], [1060, 216], [1230, 230], [990, 520], [1060, 540], [1150, 520], [1220, 560], [1010, 600], [1100, 604]]) tree(b, x, y, 6);

  // ── label slips for the game to write on, each beside its place ──
  const LBL = {
    taihe: [320, 188], guangchang: [320, 214], chengtian: [268, 327], junjichu: [226, 183], liubu: [436, 301],
    donggong: [422, 193], yuhuayuan: [320, 74], gongdao: [226, 53], jiaolou: [150, 278],
  };
  const LEN = { taihe: 3, guangchang: 5, chengtian: 3, junjichu: 3, liubu: 3, donggong: 2, yuhuayuan: 3, gongdao: 4, jiaolou: 2 };
  for (const [k, [x, y]] of Object.entries(LBL)) slip(b, x * 2, y * 2, LEN[k]);

  // ── the brocade mount: a deep blue damask with gold lozenges, a gilt inner rule ──
  {
    const T = 14;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      if (x >= T && y >= T && x < W - T && y < H - T) continue;
      const u = (x + y) % 10, v = (x - y + 1000) % 10;
      b.set(x, y, u === 0 || v === 0 ? C.GOLD_D : (u === 5 && v === 5) ? C.GOLD : C.BLU_D);
    }
    frame(b, T, T, W - 2 * T, H - 2 * T, C.GOLD); frame(b, T - 1, T - 1, W - 2 * T + 2, H - 2 * T + 2, C.GOLD_D);
    frame(b, T + 1, T + 1, W - 2 * T - 2, H - 2 * T - 2, C.WOOD);
    frame(b, 0, 0, W, H, C.INK);
  }

  const place = (x, y, w, h) => [Math.round(x / 2), Math.round(y / 2), Math.round(w / 2), Math.round(h / 2)];
  return {
    bg: b,
    spots: {
      places: {
        taihe: place(562, 322, 156, 64),
        guangchang: place(520, 394, 240, 60),
        chengtian: place(566, IW.y1 - 30, 148, 56),
        junjichu: place(JJ.x, JJ.y, JJ.w, JJ.h),
        liubu: place(LB.x, LB.y, LB.w, LB.h),
        donggong: place(DG.x, DG.y, DG.w, DG.h),
        yuhuayuan: place(G.x, G.y, G.w, G.h),
        gongdao: place(GD.x - 4, GD.y - 4, GD.w + 8, GD.h + 8),
        jiaolou: place(WA.x0 - 22, WA.y1 - 26, 44, 44),
      },
      label: LBL,
    },
  };
}
