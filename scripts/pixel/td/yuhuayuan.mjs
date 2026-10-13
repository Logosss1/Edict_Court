// 御花园 — the imperial garden, top-down 3/4 view. Purely decorative: a calm place to wander.
// North wall along the top with the 堆秀山 rockery and its little pavilion (御景亭) rising over it; a spring
// runs from a grotto under a white marble arched bridge into a koi pond with lotus; 万春亭 on the right on its
// marble terrace; ancient cypresses, peony beds, pebble-mosaic paths. The gate to 宫道 is at the bottom.
import { Bitmap, C, rng, W, H, dith, frame, shade, DARK, glazedRoof, marbleRail, wallCoping, copingTop } from './common.mjs';

// ───────────── ground ─────────────
function lawn(b, x0, y0, x1, y1, seed = 5) {
  const r = rng(seed);
  b.rect(x0, y0, x1 - x0, y1 - y0, C.GRN);
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const v = r();
    if (v < 0.05) b.set(x, y, C.GRN_D);
    else if (v < 0.07) b.set(x, y, C.GRN_L);
  }
  // tufts: little V strokes, lit on the left
  for (let k = 0; k < ((x1 - x0) * (y1 - y0)) / 260; k++) {
    const x = x0 + Math.floor(r() * (x1 - x0)), y = y0 + Math.floor(r() * (y1 - y0));
    b.set(x, y, C.GRN_L); b.set(x - 1, y - 1, C.GRN_L); b.set(x + 1, y - 1, C.GRN_D); b.set(x + 1, y, C.GRN_D);
  }
}
/** tiny wild flowers scattered on the lawn inside a rect, only where the lawn still shows */
function wildFlowers(b, x0, y0, x1, y1, n, seed) {
  const r = rng(seed);
  for (let k = 0; k < n; k++) {
    const x = x0 + Math.floor(r() * (x1 - x0)), y = y0 + Math.floor(r() * (y1 - y0));
    if (b.get(x, y) !== C.GRN && b.get(x, y) !== C.GRN_D && b.get(x, y) !== C.GRN_L) continue;
    const c = [C.PINK, C.PAPER, C.GOLD_L, C.PUR_L][Math.floor(r() * 4)];
    b.set(x, y, c); b.set(x + 1, y, c); b.set(x, y + 1, C.GRN_D);
  }
}

/** pebble-mosaic path (石子路) between brick kerbs; panels with mosaic motifs */
function pebblePath(b, x0, y0, x1, y1, seed = 3, horizontal = true) {
  const r = rng(seed);
  // set pebbles: little rounded stones in staggered rows over a darker bed
  b.rect(x0, y0, x1 - x0, y1 - y0, C.STONE);
  for (let y = y0, row = 0; y < y1; y += 3, row++) for (let x = x0 + (row % 2) * 2; x < x1; x += 4) {
    const v = r(), c = v < 0.45 ? C.STONE_L : v < 0.75 ? C.PLASTER_S : v < 0.92 ? C.STONE : C.FLOOR_L;
    b.hline(x, Math.min(x1 - 1, x + 2), y, c); b.set(x + 1, y + 1, c === C.STONE ? C.STONE_D : c);
    if (c !== C.STONE && r() < 0.5) b.set(x, y, C.JADE);
  }
  // kerbs of grey brick along both long edges
  if (horizontal) {
    for (const yy of [y0, y1 - 5]) { b.rect(x0, yy, x1 - x0, 5, C.STONE); b.hline(x0, x1 - 1, yy, C.STONE_L); for (let x = x0 + ((yy - y0) % 2 ? 6 : 0); x < x1; x += 12) b.vline(x, yy, yy + 4, C.STONE_D); b.hline(x0, x1 - 1, yy + 4, C.STONE_D); }
  } else {
    for (const xx of [x0, x1 - 5]) { b.rect(xx, y0, 5, y1 - y0, C.STONE); b.vline(xx, y0, y1 - 1, C.STONE_L); for (let y = y0; y < y1; y += 12) b.hline(xx, xx + 4, y, C.STONE_D); b.vline(xx + 4, y0, y1 - 1, C.STONE_D); }
  }
  // mosaic panels
  const ia = horizontal ? x0 : y0, iz = horizontal ? x1 : y1, span = (horizontal ? y1 - y0 : x1 - x0) - 10;
  let k = 0;
  for (let p = ia + 8; p + span < iz - 4; p += span + 10, k++) {
    const px = horizontal ? p : x0 + 5, py = horizontal ? y0 + 5 : p, cx = px + span / 2, cy = py + span / 2;
    for (let i = 0; i < span; i++) { b.set(px + i, py, C.STONE_D); b.set(px + i, py + span - 1, C.STONE_D); b.set(px, py + i, C.STONE_D); b.set(px + span - 1, py + i, C.STONE_D); }
    const m = k % 4, R = Math.floor(span / 2) - 4;
    if (m === 0) { // coin: a circle with a square hole
      for (let a = 0; a < 40; a++) b.set(cx + Math.round(Math.cos(a * 0.157) * R), cy + Math.round(Math.sin(a * 0.157) * R), C.STONE_D);
      frame(b, cx - 4, cy - 4, 9, 9, C.STONE_D); b.rect(cx - 3, cy - 3, 7, 7, C.GOLD_D);
    } else if (m === 1) { // four-petal flower in brick-red and gold pebbles
      for (let a = 0; a < 4; a++) { const ex = cx + Math.round(Math.cos(a * 1.571 + 0.785) * R * 0.5), ey = cy + Math.round(Math.sin(a * 1.571 + 0.785) * R * 0.5); b.ellipse(ex, ey, 4, 4, C.RED_D); b.ellipse(ex, ey, 2, 2, C.RED_L); }
      b.ellipse(cx, cy, 3, 3, C.GOLD); b.set(cx, cy, C.GOLD_L);
    } else if (m === 2) { // diamond lattice
      for (let d = -R; d <= R; d += 6) { b.line(cx - R, cy + d, cx + d, cy - R, C.STONE_D); b.line(cx + d, cy + R, cx + R, cy + d, C.STONE_D); }
    } else { // a cloud scroll
      for (let a = 0; a < 26; a++) { const t = a / 26; b.set(cx - R + Math.round(t * 2 * R), cy + Math.round(Math.sin(t * 6.28) * R * 0.45), C.TILE_D); b.set(cx - R + Math.round(t * 2 * R), cy + 1 + Math.round(Math.sin(t * 6.28) * R * 0.45), C.TILE); }
      b.ellipse(cx - R + 3, cy + 1, 3, 3, C.TILE); b.ellipse(cx + R - 3, cy - 1, 3, 3, C.TILE);
    }
  }
}

// ───────────── plants ─────────────
/** ancient cypress (古柏): twisted fissured trunk(s), a dark layered crown; shadow falls to the lower right.
 *  o.trunks: [[dx, lean], ...] — several trunks meeting in one crown (连理柏). */
function cypress(b, cx, base, s = 1, seed = 1, o = {}) {
  const r = rng(seed), sc = (v) => Math.round(v * s);
  const th = sc(o.trunk ?? 96), trunks = o.trunks ?? [[0, o.lean ?? 0]];
  shade(b, [[cx - sc(26), base], [cx + sc(30), base - sc(8)], [cx + sc(120), base + sc(28)], [cx + sc(44), base + sc(46)]], DARK, 2);
  let topX = 0, topY = base - 4 - th;
  for (const [dx, lean] of trunks) {
    const bx = cx + sc(dx);
    b.ellipse(bx, base - 2, sc(20), sc(5), C.DBROWN); b.ellipse(bx - 3, base - 3, sc(14), sc(3), C.FLOOR_D);
    for (let k = 0; k < th; k++) {
      const t = k / th, w = Math.max(3, sc(16 - 8 * t + (k < 8 ? (8 - k) * 0.8 : 0))), x = bx + Math.round(Math.sin(t * 3.1 + dx) * sc(5) + lean * t * t * sc(34)), y = base - 4 - k;
      for (let i = -w; i <= w; i++) {
        const u = (i + w) / (2 * w), g = (i * 0.9 + k * 0.45 + Math.sin(k * 0.21 + i) * 2 + 60) % 7;
        let c = u < 0.18 ? C.FLOOR_L : u < 0.55 ? C.FLOOR : u < 0.85 ? C.FLOOR_D : C.DBROWN;
        if (g < 1.1) c = u < 0.5 ? C.FLOOR_D : C.DBROWN; else if (g > 6.2 && u < 0.5) c = C.STONE_L;
        b.set(x + i, y, c);
      }
    }
    topX += bx + Math.round(Math.sin(3.1 + dx) * sc(5) + lean * sc(34));
  }
  topX = Math.round(topX / trunks.length);
  // big limbs reaching out of the crown
  for (const [dx, dy] of [[-sc(46), -sc(22)], [sc(50), -sc(30)], [sc(6), -sc(44)]]) for (let w = -3; w <= 3; w++) b.line(topX + w, topY + 8, topX + dx + w, topY + dy, w < -1 ? C.FLOOR : w < 2 ? C.FLOOR_D : C.DBROWN);
  // crown: flat plates of dense foliage, dark beneath, lit on the upper-left
  const clumps = [];
  const n = o.clumps ?? 15, spread = sc(o.spread ?? 62);
  for (let k = 0; k < n; k++) {
    const a = r() * Math.PI * 2, d = Math.sqrt(r()) * spread;
    clumps.push([topX + Math.round(Math.cos(a) * d * 1.2), topY - sc(24) + Math.round(Math.sin(a) * d * 0.55), sc(22 + r() * 12)]);
  }
  clumps.sort((p, q) => p[1] - q[1]);
  for (const [x, y, rr] of clumps) b.ellipse(x + 2, y + 5, rr, Math.round(rr * 0.62), C.DEEP);
  for (const [x, y, rr] of clumps) b.ellipse(x, y + 2, rr, Math.round(rr * 0.6), C.GRN_D);
  for (const [x, y, rr] of clumps) b.ellipse(x - Math.round(rr / 4), y - 1, Math.round(rr * 0.68), Math.round(rr * 0.38), C.GRN);
  for (const [x, y, rr] of clumps) b.ellipse(x - Math.round(rr / 3), y - Math.round(rr / 5), Math.round(rr * 0.3), Math.round(rr * 0.16), C.GRN_L);
  // scale-leaf texture
  for (let k = 0; k < 1400 * s; k++) {
    const [x, y, rr] = clumps[Math.floor(r() * clumps.length)];
    const px = x + Math.round((r() - 0.5) * rr * 2), py = y + Math.round((r() - 0.5) * rr * 1.2), v = b.get(px, py);
    if (v === C.GRN) b.set(px, py, r() < 0.45 ? C.GRN_D : r() < 0.6 ? C.TEAL : C.GRN_L);
    else if (v === C.GRN_D && r() < 0.35) b.set(px, py, r() < 0.5 ? C.DEEP : C.GRN);
    else if (v === C.GRN_L && r() < 0.4) b.set(px, py, C.GRN);
  }
}

/** a flowering crabapple (海棠): slim trunk, a soft rounded crown dotted with pink and white blossom */
function crabapple(b, cx, base, s = 1, seed = 1) {
  const r = rng(seed), sc = (v) => Math.round(v * s);
  shade(b, [[cx - sc(20), base], [cx + sc(24), base - sc(6)], [cx + sc(90), base + sc(24)], [cx + sc(30), base + sc(36)]], DARK, 2);
  b.rect(cx - sc(4), base - sc(56), sc(8), sc(56), C.BROWN); b.vline(cx - sc(4), base - sc(56), base - 1, C.WOOD); b.vline(cx + sc(3), base - sc(56), base - 1, C.DBROWN);
  b.line(cx, base - sc(40), cx - sc(24), base - sc(70), C.BROWN); b.line(cx, base - sc(46), cx + sc(22), base - sc(76), C.BROWN);
  const clumps = [];
  for (let k = 0; k < 10; k++) { const a = r() * Math.PI * 2, d = Math.sqrt(r()) * sc(36); clumps.push([cx + Math.round(Math.cos(a) * d * 1.2), base - sc(84) + Math.round(Math.sin(a) * d * 0.6), sc(16 + r() * 8)]); }
  clumps.sort((p, q) => p[1] - q[1]);
  for (const [x, y, rr] of clumps) b.ellipse(x + 1, y + 3, rr, Math.round(rr * 0.7), C.GRN_D);
  for (const [x, y, rr] of clumps) b.ellipse(x - 1, y, rr - 2, Math.round(rr * 0.7) - 2, C.GRN);
  for (const [x, y, rr] of clumps) b.ellipse(x - Math.round(rr / 3), y - Math.round(rr / 4), Math.round(rr / 2), Math.round(rr / 3), C.GRN_L);
  for (let k = 0; k < 700 * s; k++) {
    const [x, y, rr] = clumps[Math.floor(r() * clumps.length)];
    const px = x + Math.round((r() - 0.5) * rr * 2), py = y + Math.round((r() - 0.5) * rr * 1.3), v = b.get(px, py);
    if (v === C.GRN || v === C.GRN_L) { const c = py < y ? (r() < 0.6 ? C.PINK : C.PAPER) : (r() < 0.6 ? C.PINK : C.RED_L); b.set(px, py, c); if (r() < 0.4) b.set(px + 1, py, c); }
  }
  // a few fallen petals under the tree
  for (let k = 0; k < 40; k++) { const px = cx - sc(40) + Math.floor(r() * sc(110)), py = base - sc(6) + Math.floor(r() * sc(26)); const v = b.get(px, py); if (v === C.GRN || v === C.GRN_D || v === C.GRN_L) b.set(px, py, C.PINK); }
}

/** peony bed: a raised bed with a white marble kerb, peony bushes in bloom */
function peonyBed(b, x, y, w, h, seed) {
  const r = rng(seed);
  shade(b, [[x + w, y + 4], [x + w + 14, y + 14], [x + w + 14, y + h + 12], [x + 12, y + h + 12], [x, y + h]], DARK, 2);
  b.rect(x, y, w, h, C.JADE); // kerb top
  b.rect(x + 5, y + 5, w - 10, h - 15, C.DBROWN); // soil
  dith(b, x + 5, y + 5, w - 10, h - 15, C.BROWN, 3);
  b.rect(x, y + h - 10, w, 10, C.STONE_L); b.hline(x, x + w - 1, y + h - 10, C.PAPER); b.hline(x, x + w - 1, y + h - 1, C.STONE);
  for (let i = x + 8; i < x + w - 8; i += 24) frame(b, i, y + h - 8, 18, 6, C.STONE);
  b.vline(x + w - 1, y, y + h - 1, C.STONE);
  // bushes
  const n = Math.max(2, Math.floor((w - 10) / 30));
  for (let k = 0; k < n; k++) {
    const bx = x + 18 + k * ((w - 36) / Math.max(1, n - 1)), by = y + Math.round(h * 0.4);
    b.ellipse(bx, by + 2, 16, 10, C.GRN_D); b.ellipse(bx - 2, by, 14, 8, C.GRN); b.ellipse(bx - 5, by - 3, 6, 3, C.GRN_L);
    for (let j = 0; j < 3; j++) {
      const fx = bx - 9 + Math.floor(r() * 18), fy = by - 6 + Math.floor(r() * 10);
      const [c0, c1] = [[C.PINK, C.PAPER], [C.RED_L, C.PINK], [C.CRIMSON, C.RED_L], [C.PAPER, C.JADE], [C.PUR_L, C.PINK]][Math.floor(r() * 5)];
      b.ellipse(fx, fy, 4, 3, c0); b.ellipse(fx - 1, fy - 1, 2, 1, c1); b.set(fx, fy, C.GOLD);
    }
  }
}

/** a potted pomegranate in a big blue-and-white pot on a little stand */
function pottedTree(b, cx, base, seed) {
  const r = rng(seed);
  shade(b, [[cx - 14, base], [cx + 14, base - 4], [cx + 38, base + 12], [cx + 8, base + 16]], DARK, 2);
  b.rect(cx - 16, base - 6, 32, 6, C.STONE); b.hline(cx - 16, cx + 15, base - 6, C.STONE_L);
  b.poly([[cx - 18, base - 32], [cx + 18, base - 32], [cx + 13, base - 6], [cx - 13, base - 6]], C.JADE);
  b.vline(cx + 12, base - 31, base - 7, C.STONE_L); b.vline(cx + 15, base - 31, base - 20, C.STONE_L);
  b.hline(cx - 18, cx + 18, base - 32, C.PAPER); b.hline(cx - 17, cx + 17, base - 29, C.BLU); b.hline(cx - 14, cx + 14, base - 10, C.BLU);
  for (let x = cx - 12; x < cx + 12; x += 6) { b.ellipse(x, base - 20, 2, 3, C.BLU); b.set(x, base - 20, C.JADE); }
  b.ellipse(cx, base - 32, 17, 3, C.DBROWN);
  b.line(cx, base - 32, cx - 2, base - 50, C.BROWN); b.line(cx - 1, base - 44, cx - 12, base - 56, C.BROWN); b.line(cx, base - 46, cx + 10, base - 58, C.BROWN);
  for (const [x, y, rr] of [[cx - 12, base - 60, 11], [cx + 10, base - 62, 12], [cx - 1, base - 70, 12]]) { b.ellipse(x + 1, y + 2, rr, Math.round(rr * 0.7), C.GRN_D); b.ellipse(x - 1, y, rr - 2, Math.round(rr * 0.6), C.GRN); b.ellipse(x - 4, y - 3, Math.round(rr / 3), 2, C.GRN_L); }
  for (let k = 0; k < 9; k++) { const x = cx - 18 + Math.floor(r() * 36), y = base - 76 + Math.floor(r() * 24); if (b.get(x, y) === C.GRN || b.get(x, y) === C.GRN_D) { b.rect(x, y, 2, 2, C.RED_L); b.set(x, y, C.RED); } }
}
/** a clump of bamboo against a wall: base line `base`, stems to `top` */
function bamboo(b, x0, x1, base, top, seed) {
  const r = rng(seed);
  shade(b, [[x0, base], [x1, base - 4], [x1 + 40, base + 16], [x0 + 30, base + 20]], DARK, 2);
  for (let x = x0; x < x1; x += 7 + Math.floor(r() * 6)) {
    const lean = (r() - 0.5) * 0.2, t = top + Math.floor(r() * 30), tone = r() < 0.3 ? [C.GRN_D, C.GRN] : [C.GRN, C.GRN_L];
    for (let y = base; y > t; y--) { const xx = Math.round(x + (base - y) * lean); b.set(xx, y, tone[1]); b.set(xx + 1, y, tone[0]); b.set(xx + 2, y, C.GRN_D); if ((y + x) % 19 === 0) b.hline(xx - 1, xx + 3, y, C.GRN_D); }
  }
  for (let k = 0; k < (x1 - x0) * 3; k++) {
    const lx = x0 - 10 + Math.floor(r() * (x1 - x0 + 20)), ly = top + Math.floor(r() * (base - top - 20)), sd = r() < 0.5 ? -1 : 1;
    const c = ly < top + (base - top) / 3 ? (r() < 0.5 ? C.GRN_L : C.GRN) : r() < 0.6 ? C.GRN : C.GRN_D;
    b.line(lx, ly, lx + sd * 8, ly + 3, c); b.line(lx, ly + 1, lx + sd * 7, ly + 3, c === C.GRN_L ? C.GRN : C.GRN_D);
  }
}

// ───────────── water, rocks ─────────────
function boulder(b, cx, cy, rx, ry, seed, tones = [C.STONE_L, C.STONE, C.STONE_D, C.TILE_D]) {
  const r = rng(seed), n = 9, pts = [];
  for (let k = 0; k < n; k++) { const a = (k / n) * Math.PI * 2, f = 0.75 + r() * 0.35; pts.push([cx + Math.cos(a) * rx * f, cy + Math.sin(a) * ry * f]); }
  b.poly(pts, tones[1]);
  // light from the top-left: lit rim on the upper-left edges, dark lower-right
  for (let k = 0; k < n; k++) {
    const [x0, y0] = pts[k], [x1, y1] = pts[(k + 1) % n], a = ((k + 0.5) / n) * Math.PI * 2;
    const lit = Math.cos(a - 3.93) > 0.2, dark = Math.cos(a - 0.79) > 0.3;
    b.line(x0, y0, x1, y1, lit ? tones[0] : dark ? tones[2] : tones[1]);
    if (dark) b.line(x0, y0 - 1, x1, y1 - 1, tones[2]);
  }
  b.ellipse(Math.round(cx - rx * 0.3), Math.round(cy - ry * 0.35), Math.max(1, Math.round(rx * 0.3)), Math.max(1, Math.round(ry * 0.2)), tones[0]);
  return pts;
}

/** 太湖石 rockery mound: big pierced boulders over deep crevices, between x0..x1, rising from `base` to `peakY` */
function rockery(b, x0, x1, base, peakY, seed = 4) {
  const r = rng(seed), cx = (x0 + x1) / 2, hw = (x1 - x0) / 2;
  const top = (x) => base - (base - peakY) * Math.pow(Math.max(0, 1 - ((x - cx) / hw) ** 2), 0.7) - Math.sin(x / 23) * 6;
  // the mound's dark mass first: everything between the boulders reads as deep crevice
  const m = new Bitmap(W, H);
  const outline = [];
  for (let x = x0; x <= x1; x += 4) outline.push([x, top(x) + 8]);
  outline.push([x1, base], [x0, base]);
  m.poly(outline, 1);
  for (let y = 0; y < H; y++) for (let x = x0 - 10; x < x1 + 10; x++) if (m.get(x, y)) b.set(x, y, y > base - 30 || x > cx + hw * 0.35 ? C.TILE_D : C.STONE_D);
  const rocks = [];
  for (let k = 0; k < 70; k++) {
    const x = x0 + 22 + r() * (x1 - x0 - 44), t = top(x), y = t + 16 + r() * (base - t - 18);
    const tall = r() < 0.35;
    rocks.push([x, y, tall ? 12 + r() * 10 : 18 + r() * 20, tall ? 22 + r() * 14 : 12 + r() * 12, Math.floor(r() * 1e6)]);
  }
  rocks.sort((p, q) => p[1] - q[1]);
  for (const [x, y, rx, ry, sd] of rocks) {
    const right = x > cx + hw * 0.2; // the right flank is in shadow
    boulder(b, Math.round(x), Math.round(y), Math.round(rx), Math.round(ry), sd, right ? [C.STONE, C.STONE_D, C.TILE_D, C.TILE_D] : [C.STONE_L, C.STONE, C.STONE_D, C.TILE_D]);
    const rr = rng(sd);
    for (let h = 0; h < 2; h++) if (rr() < 0.55) { const hx = Math.round(x + (rr() - 0.5) * rx), hy = Math.round(y + (rr() - 0.4) * ry * 0.7), a = 2 + Math.floor(rr() * 4), c = 2 + Math.floor(rr() * 4); b.ellipse(hx, hy, a, c, C.TILE_D); b.ellipse(hx - 1, hy - 1, Math.max(1, a - 1), Math.max(1, c - 1), C.DEEP); b.set(hx + a, hy + 1, C.STONE_L); }
    if (rr() < 0.3) { const mx = Math.round(x - rx * 0.3), my = Math.round(y - ry * 0.7); b.ellipse(mx, my, 7, 2, C.GRN_D); b.hline(mx - 5, mx + 2, my - 1, C.GRN); }
  }
  // shrubs and little pines rooted in the crevices
  for (let k = 0; k < 14; k++) {
    const x = Math.round(x0 + 30 + r() * (x1 - x0 - 60)), y = Math.round(top(x) + 20 + r() * (base - top(x) - 40)), rr = 6 + Math.floor(r() * 8);
    for (let j = 0; j < 4; j++) { const jx = x + Math.round((r() - 0.5) * rr * 1.6), jy = y + Math.round((r() - 0.5) * rr * 0.6), q = Math.max(3, Math.round(rr * (0.5 + r() * 0.4))); b.ellipse(jx + 1, jy + 2, q, Math.round(q * 0.55), C.DEEP); b.ellipse(jx, jy, q, Math.round(q * 0.55), C.GRN_D); b.hline(jx - q + 2, jx, jy - Math.round(q * 0.4), C.GRN); b.set(jx - q + 3, jy - Math.round(q * 0.4) - 1, C.GRN_L); }
  }
  return top;
}

// ───────────── buildings ─────────────
/** a red column with a stone base, from `top` to `base` */
function col(b, x, top, base, w = 8) {
  b.rect(x, top, w, base - top, C.RED); b.vline(x + 1, top, base - 1, C.RED_L); b.vline(x + w - 2, top, base - 1, C.RED_M); b.vline(x + w - 1, top, base - 1, C.RED_D);
  b.rect(x - 2, base - 3, w + 4, 4, C.STONE_L); b.hline(x - 2, x + w + 1, base, C.STONE);
}
/** painted beam band under an eave: green ends, blue middle, gold lines */
function paintedBeam(b, x0, x1, y, h = 10) {
  b.rect(x0, y, x1 - x0, h, C.BLU_D);
  b.rect(x0 + 2, y + 2, x1 - x0 - 4, h - 4, C.BLU); b.hline(x0 + 2, x1 - 3, y + 2, C.SKY);
  for (const ex of [x0 + 2, x1 - 22]) { b.rect(ex, y + 2, 20, h - 4, C.GRN); b.hline(ex, ex + 19, y + 2, C.GRN_L); }
  b.hline(x0, x1 - 1, y, C.GOLD_D); b.hline(x0, x1 - 1, y + h - 1, C.GOLD_D);
  for (let x = x0 + 30; x < x1 - 30; x += 8) b.set(x, y + Math.floor(h / 2), C.GOLD_L);
}
/** square pavilion roof: a glazed pyramid with a gilt finial */
function pyramidRoof(b, x0, x1, ey, lift = 8, hipK = 0.9) {
  const apex = Math.round(ey - lift - (x1 - x0 - 6) / (2 * hipK));
  glazedRoof(b, x0, x1, ey, apex + 3, { lift, hipK });
  const cx = Math.round((x0 + x1) / 2);
  b.rect(cx - 3, apex - 6, 7, 10, C.GOLD_D); b.ellipse(cx, apex - 10, 7, 7, C.GOLD); b.ellipse(cx - 2, apex - 12, 3, 3, C.GOLD_L); b.vline(cx + 5, apex - 13, apex - 7, C.GOLD_D);
  b.rect(cx - 1, apex - 22, 3, 6, C.GOLD); b.set(cx, apex - 23, C.GOLD_L);
  return apex;
}

/** 万春亭: double-eaved square pavilion on a white marble terrace with a front stair; cx = centre, fy = terrace front edge */
function wanchunting(b, cx, fy) {
  const tw = 136, ty = fy - 84; // terrace half-width, top of the terrace surface
  shade(b, [[cx + tw, ty + 6], [cx + tw + 26, ty + 24], [cx + tw + 26, fy + 40], [cx - tw + 26, fy + 40], [cx - tw, fy + 22]], DARK, 2);
  // terrace surface (marble slabs) and its front face
  b.rect(cx - tw, ty, 2 * tw, fy - ty, C.JADE);
  for (let x = cx - tw + 4; x < cx + tw - 6; x += 30) for (let y = ty + 4; y < fy - 4; y += 26) { b.hline(x, x + 28, Math.min(fy - 2, y + 24), C.PLASTER_S); b.vline(x + 28, y, Math.min(fy - 2, y + 24), C.PLASTER_S); }
  b.rect(cx - tw, fy, 2 * tw, 22, C.STONE_L); b.hline(cx - tw, cx + tw - 1, fy, C.PAPER); b.hline(cx - tw, cx + tw - 1, fy + 3, C.STONE); b.hline(cx - tw, cx + tw - 1, fy + 21, C.STONE);
  for (let x = cx - tw + 8; x < cx + tw - 30; x += 34) { frame(b, x, fy + 7, 28, 11, C.STONE); b.ellipse(x + 14, fy + 12, 6, 2, C.STONE); }
  b.vline(cx - tw, ty, fy + 21, C.STONE_L); b.vline(cx + tw - 1, ty, fy + 21, C.STONE);
  // the pavilion floor in the shade of the roof
  const pw = 104, bx0 = cx - pw, bx1 = cx + pw, backY = ty + 14, frontY = fy - 14;
  shade(b, [[bx0, backY], [bx1, backY], [bx1 + 10, frontY], [bx0, frontY]], DARK, 2);
  // back row of columns (seen between the front ones), a round stone table with drums
  for (const x of [bx0 + 34, bx1 - 42]) { b.rect(x, backY - 40, 8, 46, C.RED_M); b.vline(x + 7, backY - 40, backY + 5, C.RED_D); }
  b.rect(bx0, backY - 44, 2 * pw, 6, C.RED_D);
  b.ellipse(cx, frontY - 26, 26, 9, C.STONE); b.ellipse(cx, frontY - 28, 25, 8, C.STONE_L); b.ellipse(cx - 6, frontY - 30, 10, 3, C.JADE); b.rect(cx - 6, frontY - 22, 12, 10, C.STONE);
  for (const dx of [-40, 40]) { b.ellipse(cx + dx, frontY - 12, 9, 5, C.STONE); b.ellipse(cx + dx, frontY - 14, 8, 4, C.STONE_L); }
  // front columns + low railings between the outer bays
  const cols = [bx0, cx - 36, cx + 28, bx1 - 8];
  for (const x of cols) col(b, x, frontY - 74, frontY, 8);
  for (const [a, z] of [[bx0 + 8, cx - 36], [cx + 36, bx1 - 8]]) { b.rect(a, frontY - 18, z - a, 3, C.RED); b.hline(a, z - 1, frontY - 18, C.RED_L); for (let x = a + 6; x < z - 2; x += 7) b.vline(x, frontY - 15, frontY - 3, C.RED_M); b.rect(a, frontY - 4, z - a, 3, C.RED_D); }
  // beam and brackets under the lower eave
  paintedBeam(b, bx0 - 6, bx1 + 6, frontY - 86, 12);
  b.rect(bx0 - 10, frontY - 94, 2 * pw + 20, 8, C.DEEP);
  for (let x = bx0 - 4; x < bx1 + 4; x += 16) { b.rect(x, frontY - 93, 8, 5, C.BLU_D); b.hline(x, x + 7, frontY - 93, C.TEAL); }
  // lower eave, the upper storey band, the upper eave and the finial
  glazedRoof(b, cx - 160, cx + 160, frontY - 98, frontY - 150, { lift: 12, hipK: 1.1 });
  b.rect(cx - 86, frontY - 168, 172, 18, C.RED_D); paintedBeam(b, cx - 86, cx + 86, frontY - 168, 9);
  for (let x = cx - 80; x < cx + 80; x += 14) { b.rect(x, frontY - 158, 6, 7, C.RED); b.vline(x, frontY - 158, frontY - 152, C.RED_L); }
  const apex = pyramidRoof(b, cx - 118, cx + 118, frontY - 150, 10, 1.35);
  // front stair down to the court
  const sw = 30;
  for (let y = fy, k = 0; y < fy + 40; y += 6, k++) { b.rect(cx - sw, y, 2 * sw, 6, k % 2 ? C.STONE_L : C.JADE); b.hline(cx - sw, cx + sw - 1, y + 5, C.STONE); }
  for (const x of [cx - sw - 5, cx + sw]) { b.rect(x, fy - 4, 5, 44, C.STONE_L); b.vline(x + 4, fy - 4, fy + 39, C.STONE); b.ellipse(x + 2, fy - 6, 3, 3, C.PAPER); }
  marbleRail(b, cx - tw + 2, cx - sw - 6, fy);
  marbleRail(b, cx + sw + 6, cx + tw - 2, fy);
  return { apex, top: ty };
}

/** the little square pavilion (御景亭) on the summit of the rockery; base = its platform's front edge */
function summitPavilion(b, cx, base) {
  b.rect(cx - 50, base - 12, 100, 12, C.STONE_L); b.hline(cx - 50, cx + 49, base - 12, C.PAPER); b.hline(cx - 50, cx + 49, base - 1, C.STONE);
  b.rect(cx - 44, base - 40, 88, 28, C.DEEP);
  for (const x of [cx - 42, cx - 14, cx + 8, cx + 34]) col(b, x, base - 44, base - 12, 7);
  b.rect(cx - 36, base - 22, 72, 2, C.RED); for (let x = cx - 34; x < cx + 34; x += 6) b.vline(x, base - 20, base - 14, C.RED_M);
  paintedBeam(b, cx - 48, cx + 48, base - 52, 8);
  return pyramidRoof(b, cx - 60, cx + 60, base - 54, 7, 1.6);
}

export function yuhuayuan() {
  const b = new Bitmap(W, H);
  // ── 1. sky, and beyond the north wall the roofs of the halls further north between old trees ──
  b.rect(0, 0, W, 60, C.SKY);
  b.rect(0, 22, W, 38, C.SKY_L); dith(b, 0, 16, W, 6, C.SKY_L, 2);
  {
    const r = rng(77);
    for (let x = -20; x < W + 20; x += 30) { const h = 10 + Math.floor(r() * 18), rr = 20 + Math.floor(r() * 10); b.ellipse(x, 60 - h + rr / 2, rr, Math.round(rr * 0.7), r() < 0.5 ? C.HILL : C.HILL_L); }
    for (const [a, z, t] of [[600, 920, 30], [980, 1210, 38]]) { glazedRoof(b, a, z, 52, t, { hip: false, lift: 4 }); b.rect(a + 20, t - 5, z - a - 40, 6, C.GOLD_D); b.hline(a + 20, z - 21, t - 5, C.GOLD_L); }
    for (let x = -10; x < W + 20; x += 22) { if (x > 650 && x < 890) continue; const rr = 12 + Math.floor(r() * 10); b.ellipse(x, 54, rr, Math.round(rr * 0.6), C.GRN_D); b.ellipse(x - 4, 50, Math.round(rr * 0.6), Math.round(rr * 0.3), C.GRN); }
  }
  // ── 2. the north wall: yellow coping, red face, grey stone base ──
  wallCoping(b, 0, W, 50);
  b.rect(0, 69, W, 79, C.RED);
  dith(b, 0, 69, W, 8, C.RED_D, 2); b.hline(0, W - 1, 69, C.RED_D);
  { const r = rng(9); for (let k = 0; k < 60; k++) { const x = Math.floor(r() * W), y = 80 + Math.floor(r() * 50); b.vline(x, y, y + 6 + Math.floor(r() * 12), C.RED_M); } }
  b.rect(0, 134, W, 14, C.STONE); b.hline(0, W - 1, 134, C.STONE_L); for (let x = 0; x < W; x += 32) b.vline(x, 135, 147, C.STONE_D); b.hline(0, W - 1, 147, C.STONE_D);
  { // 承光门-style gate set in the wall: glazed tile frame, open red leaves, a little roof above the coping
    const gx = 704, gw = 76;
    b.rect(gx - 20, 62, gw + 40, 86, C.GOLD_D); b.rect(gx - 16, 66, gw + 32, 82, C.GRN);
    for (let y = 70; y < 146; y += 6) for (let x = gx - 14 + ((y / 6) % 2 < 1 ? 0 : 4); x < gx + gw + 14; x += 8) b.rect(x, y, 3, 3, C.GRN_L);
    b.rect(gx, 82, gw, 66, C.DEEP);
    b.rect(gx + 2, 90, 14, 58, C.RED); b.rect(gx + gw - 16, 90, 14, 58, C.RED_M);
    for (let y = 96; y < 146; y += 8) { b.set(gx + 8, y, C.GOLD); b.set(gx + gw - 9, y, C.GOLD); }
    b.rect(gx + 18, 112, gw - 36, 36, C.GRN_D); dith(b, gx + 18, 112, gw - 36, 36, C.TEAL, 3); // a glimpse of the court beyond
    b.rect(gx - 4, 76, gw + 8, 6, C.RED_D); b.hline(gx - 4, gx + gw + 3, 76, C.GOLD);
    glazedRoof(b, gx - 30, gx + gw + 30, 56, 34, { lift: 6, hipK: 1.2 });
  }

  // ── 3. ground: lawns everywhere, paths laid over them ──
  lawn(b, 0, 148, W, H, 5);
  { // dappled light and shade across the lawn (soft blobs), and the wall's shadow along its foot
    const r = rng(6);
    for (let k = 0; k < 14; k++) {
      const cx = Math.floor(r() * W), cy = 160 + Math.floor(r() * 540), rx = 40 + Math.floor(r() * 90), ry = 16 + Math.floor(r() * 30), dark = r() < 0.55;
      for (let y = cy - ry; y <= cy + ry; y++) for (let x = cx - rx; x <= cx + rx; x++) {
        const d = ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2;
        if (d > 1 || y < 150) continue;
        const v = b.get(x, y);
        if (dark && v === C.GRN && (x + y) % (d < 0.5 ? 2 : 4) === 0) b.set(x, y, C.GRN_D);
        if (!dark && v === C.GRN && (x * 3 + y) % (d < 0.5 ? 5 : 9) === 0) b.set(x, y, C.GRN_L);
      }
    }
    shade(b, [[0, 148], [W, 148], [W, 160], [0, 172]], DARK, 2);
  }

  // pond mask (an organic shape) — dug before the paths so the kerbs can sit around it
  const pond = new Bitmap(W, H);
  pond.ellipse(250, 492, 220, 96, 1); pond.ellipse(120, 540, 110, 70, 1); pond.ellipse(400, 440, 100, 50, 1); pond.ellipse(470, 520, 70, 60, 1);
  pond.rect(318, 300, 56, 140, 1); // the spring channel from the grotto, under the bridge
  pond.ellipse(346, 296, 36, 22, 1);
  const inPond = (x, y) => pond.get(x, y) === 1;

  // ── 4. paths ──
  pebblePath(b, 596, 346, 684, 700, 11, false);   // the axis from the south gate
  pebblePath(b, 0, 300, 690, 352, 12, true);      // the promenade along the foot of the rockery
  pebblePath(b, 684, 452, W, 504, 13, true);      // the court in front of 万春亭

  // ── 5. water ──
  {
    const r = rng(41);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      if (!inPond(x, y)) continue;
      // distance to the north shore → shadow band under the bank (light from the top-left)
      let d = 0; while (d < 14 && inPond(x, y - d - 1)) d++;
      let c = C.TEAL;
      if (d < 5) c = C.BLU_D; else if (d < 9) c = (x + y) % 2 ? C.BLU_D : C.BLU; else if (d < 14) c = (x + y) % 2 ? C.BLU : C.TEAL;
      b.set(x, y, c);
    }
    // ripples and sky glints
    for (let k = 0; k < 220; k++) { const x = Math.floor(r() * W), y = 300 + Math.floor(r() * 320), L = 3 + Math.floor(r() * 8); if (inPond(x, y) && inPond(x + L, y) && b.get(x, y) === C.TEAL) b.hline(x, x + L, y, r() < 0.7 ? C.SKY : C.SKY_L); }
    // the sky's reflection: a pale band across the open water
    for (let y = 440; y < 600; y++) for (let x = 60; x < 520; x++) { const u = (x - 290) / 200, v = (y - 500) / 34 + Math.sin(x / 40) * 0.4; if (u * u + v * v < 1 && inPond(x, y) && b.get(x, y) === C.TEAL && (x + y) % 3 === 0) b.set(x, y, C.SKY); }
  }
  // shore stones all around the pond
  {
    const r = rng(52), edge = [];
    for (let y = 1; y < H - 1; y += 2) for (let x = 1; x < W - 1; x += 2) if (inPond(x, y) && (!inPond(x - 3, y) || !inPond(x + 3, y) || !inPond(x, y - 3) || !inPond(x, y + 3))) edge.push([x, y]);
    edge.sort((p, q) => p[1] - q[1]);
    for (let i = 0; i < edge.length; i += 5) {
      const [x, y] = edge[i];
      if (y > 296 && y < 360 && x > 300 && x < 392) continue; // under the bridge
      if (r() < 0.82) boulder(b, x, y, 8 + Math.floor(r() * 8), 5 + Math.floor(r() * 4), Math.floor(r() * 1e6));
    }
  }
  // lotus in the western bay
  {
    const r = rng(63);
    for (let k = 0; k < 30; k++) {
      const x = 60 + Math.floor(r() * 230), y = 470 + Math.floor(r() * 120);
      if (!inPond(x - 10, y) || !inPond(x + 10, y) || !inPond(x, y + 8)) continue;
      const rx = 7 + Math.floor(r() * 5), ry = Math.round(rx * 0.6);
      b.ellipse(x + 1, y + 2, rx, ry, C.BLU_D);
      b.ellipse(x, y, rx, ry, C.GRN); b.ellipse(x - 2, y - 1, Math.round(rx * 0.5), Math.round(ry * 0.5), C.GRN_L);
      b.line(x, y, x + rx, y - 1, C.TEAL); b.set(x, y, C.GRN_D);
      if (r() < 0.22) { b.ellipse(x + 3, y - 5, 3, 3, C.PINK); b.set(x + 2, y - 7, C.PAPER); b.set(x + 3, y - 4, C.RED_L); b.set(x + 3, y - 2, C.GRN_D); }
    }
  }

  // ── 6. the rockery 堆秀山 with its grotto spring, the summit pavilion and a stair ──
  rockery(b, 150, 620, 292, 112, 4);
  // stepping-stone stair climbing the front of the rockery
  {
    const steps = [[556, 284], [546, 274], [532, 266], [518, 258], [506, 248], [498, 236], [504, 224], [514, 212], [518, 198], [508, 186], [494, 178], [480, 170], [466, 162], [452, 154], [440, 146], [432, 136]];
    for (const [x, y] of steps) { b.rect(x - 11, y - 2, 22, 6, C.TILE_D); b.rect(x - 11, y - 4, 22, 4, C.STONE_L); b.hline(x - 11, x + 10, y - 4, C.PLASTER_S); b.vline(x + 10, y - 4, y + 3, C.STONE_D); }
  }
  // the grotto mouth and the spring pool at its foot
  b.ellipse(346, 262, 30, 26, C.STONE_D); b.ellipse(346, 266, 24, 22, C.DEEP); b.ellipse(342, 262, 14, 14, C.BLACK);
  for (let y = 274; y < 300; y++) for (let x = 318; x < 376; x++) if (inPond(x, y)) b.set(x, y, (x + y) % 3 ? C.TEAL : C.BLU);
  for (let k = 0; k < 6; k++) b.hline(326 + k * 6, 330 + k * 6, 286 + (k % 2) * 4, C.SKY_L); // the spring's foam
  for (let x = 326; x < 368; x += 3) b.vline(x, 276, 280 + (x % 2), C.SKY);
  summitPavilion(b, 392, 132);

  // ── 7. the arched marble bridge over the spring channel ──
  {
    const x0 = 286, x1 = 406, cx = 346, wl = 372; // waterline at the front face
    const hump = (x) => Math.round(10 * Math.cos(((x - cx) / (x1 - x0)) * Math.PI));
    // reflection of the arch and the front face in the water below
    for (let x = x0 + 8; x < x1 - 8; x++) for (let y = wl; y < wl + 28; y++) if (inPond(x, y) && (x + y) % 2 === 0) b.set(x, y, C.SKY);
    for (let i = -26; i <= 26; i++) { const d = Math.round(Math.sqrt(26 * 26 - i * i)); for (let y = wl; y < wl + d * 0.8; y++) if ((cx + i + y) % 2 === 0) b.set(cx + i, y, C.BLU_D); }
    // front face (spandrel) with the arch opening
    for (let x = x0; x < x1; x++) { const top = 340 - hump(x); b.vline(x, top, wl - 1, C.STONE_L); b.set(x, top, C.PAPER); }
    for (let i = -28; i <= 28; i++) { const d = Math.round(Math.sqrt(28 * 28 - i * i) * 0.9); b.vline(cx + i, wl - d, wl - 1, C.DEEP); if (Math.abs(i) < 26) b.vline(cx + i, wl - d + 2, wl - 1, i < 0 ? C.BLU_D : C.BLACK); }
    for (let a = 0; a <= 16; a++) { const t = Math.PI * (a / 16); const px = cx - Math.round(Math.cos(t) * 31), py = wl - Math.round(Math.sin(t) * 28); b.rect(px - 1, py - 1, 3, 3, C.STONE); b.set(px - 1, py - 1, C.JADE); }
    b.rect(cx - 3, wl - 34, 7, 6, C.JADE); b.set(cx + 3, wl - 30, C.STONE); // keystone
    b.vline(x0, 340 - hump(x0), wl - 1, C.STONE); b.vline(x1 - 1, 340 - hump(x1 - 1), wl - 1, C.STONE);
    // deck seen from above between the rails
    for (let x = x0 - 4; x < x1 + 4; x++) { const h = hump(Math.max(x0, Math.min(x1 - 1, x))); b.vline(x, 300 - h, 338 - h, C.JADE); if (x % 10 === 0) b.vline(x, 300 - h, 338 - h, C.PLASTER_S); }
    // back rail and front rail (white marble, posts with round caps)
    for (let x = x0 - 4; x < x1 + 4; x++) { const h = hump(Math.max(x0, Math.min(x1 - 1, x))); b.vline(x, 292 - h, 299 - h, C.PAPER); b.set(x, 299 - h, C.STONE_L); b.vline(x, 330 - h, 338 - h, C.PAPER); b.set(x, 338 - h, C.STONE); b.set(x, 333 - h, C.PLASTER_S); }
    for (let x = x0 - 2; x <= x1 + 2; x += 20) { const h = hump(Math.max(x0, Math.min(x1 - 1, x))); for (const yy of [290, 328]) { b.rect(x - 3, yy - 6 - h, 7, 12, C.JADE); b.vline(x + 3, yy - 6 - h, yy + 5 - h, C.STONE_L); b.ellipse(x, yy - 8 - h, 3, 3, C.PAPER); } }
  }

  // ── 8. 万春亭 on the right ──
  wanchunting(b, 1010, 412);

  // ── 9. peony beds, cypresses, stones ──
  peonyBed(b, 744, 540, 200, 70, 21);
  peonyBed(b, 1016, 540, 200, 70, 22);
  peonyBed(b, 430, 240, 120, 52, 23);
  // a 石笋 (stone shoot) on a carved pedestal at the corner of the court
  {
    const cx = 980, base = 612;
    shade(b, [[cx - 14, base], [cx + 14, base - 4], [cx + 40, base + 12], [cx + 6, base + 16]], DARK, 2);
    b.rect(cx - 16, base - 14, 32, 14, C.STONE_L); b.hline(cx - 16, cx + 15, base - 14, C.PAPER); b.vline(cx + 15, base - 14, base - 1, C.STONE); frame(b, cx - 12, base - 10, 24, 7, C.STONE);
    b.poly([[cx - 8, base - 14], [cx - 6, base - 60], [cx - 1, base - 84], [cx + 4, base - 62], [cx + 8, base - 14]], C.STONE);
    b.line(cx - 6, base - 60, cx - 1, base - 84, C.STONE_L); b.line(cx - 7, base - 20, cx - 6, base - 60, C.STONE_L); b.line(cx + 4, base - 62, cx + 7, base - 16, C.STONE_D);
    for (let y = base - 76; y < base - 18; y += 9) b.hline(cx - 4, cx + 3, y, C.STONE_D);
  }
  cypress(b, 80, 292, 1.05, 3, { lean: 0.3 });
  cypress(b, 1216, 300, 1.0, 5, { lean: -0.4 });
  bamboo(b, 612, 690, 150, 70, 41);
  crabapple(b, 808, 420, 1.0, 7);
  for (const [x, y, sd] of [[566, 440, 1], [714, 440, 2], [714, 640, 4]]) pottedTree(b, x, y, sd);
  crabapple(b, 520, 640, 0.9, 9);
  // the 连理柏: two old trunks leaning together and grown into one crown, by the pond
  cypress(b, 104, 700, 1.0, 11, { trunks: [[-34, 0.9], [34, -0.9]], trunk: 112, spread: 70, clumps: 18 });

  // ── 10. the south wall (seen from above) with the gate to 宫道 ──
  copingTop(b, 0, W, 700, H);
  dith(b, 0, 692, W, 8, C.GRN_D, 2);
  // the gate: an opening in the wall with two red leaves folded back
  b.rect(592, 696, 96, 24, C.DEEP);
  b.rect(588, 692, 6, 28, C.RED_D); b.rect(686, 692, 6, 28, C.RED_D);
  b.rect(596, 700, 10, 20, C.RED); b.rect(674, 700, 10, 20, C.RED); for (const x of [598, 676]) for (let y = 703; y < 720; y += 5) b.set(x + 3, y, C.GOLD);
  b.hline(588, 691, 692, C.GOLD);

  // ── 11. flowers on the lawns ──
  wildFlowers(b, 0, 360, W, 700, 520, 31);
  wildFlowers(b, 600, 150, W, 300, 160, 32);

  return {
    bg: b,
    spots: {
      walk: [
        { x0: 4, x1: 342, y0: 152, y1: 175 },    // the promenade and the bridge
        { x0: 300, x1: 340, y0: 152, y1: 356 },  // the axis path down to the south gate
        { x0: 300, x1: 636, y0: 228, y1: 250 },  // the court in front of 万春亭
        { x0: 490, x1: 520, y0: 204, y1: 228 },  // the stair up to the pavilion
      ],
      doors: { gongdao: [296, 348, 48, 12] },
      emperorStart: [320, 300],
      title: [320, 352],
      water: [24, 196, 248, 108],
      fish: [[100, 236], [150, 252], [200, 240], [230, 262], [120, 280], [210, 280]],
      fireflies: [20, 150, 600, 190],
      lanterns: [],
      birds: true,
      npcs: [
        { kind: 'lady', x: 560, y: 240, facing: 'left', act: 'idle', route: [[560, 240], [420, 240], [330, 240]] },
        { kind: 'eunuch', x: 120, y: 164, facing: 'right', act: 'sweep', route: [[40, 164], [280, 164]] },
      ],
      cat: [[260, 166], [330, 210], [600, 240]],
    },
  };
}
