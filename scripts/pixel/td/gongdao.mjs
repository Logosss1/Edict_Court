// 宫道长街 — the long palace street, top-down 3/4 view. Purely decorative: a quiet street running left–right
// between two high red walls topped with yellow-glazed tiles; a gate at each end (御花园 to the left,
// 军机处 to the right), stone lantern posts along both walls, old trees leaning over the far wall.
import { Bitmap, C, rng, W, H, dith, shade, DARK, glazedRoof, redWall, copingTop } from './common.mjs';

/** stone lantern post (石灯): plinth, octagonal shaft, a lantern chamber with a paper window, a little roof; returns the flame point */
function stoneLantern(b, cx, base) {
  shade(b, [[cx - 12, base], [cx + 12, base - 4], [cx + 46, base + 14], [cx + 22, base + 20]], DARK, 2);
  b.rect(cx - 14, base - 10, 28, 10, C.STONE); b.hline(cx - 14, cx + 13, base - 10, C.STONE_L); b.vline(cx + 13, base - 10, base - 1, C.STONE_D); b.hline(cx - 14, cx + 13, base - 1, C.STONE_D);
  b.rect(cx - 10, base - 16, 20, 6, C.STONE_L); b.hline(cx - 10, cx + 9, base - 16, C.JADE); b.vline(cx + 9, base - 16, base - 11, C.STONE);
  b.rect(cx - 5, base - 58, 10, 42, C.STONE_L); b.vline(cx - 5, base - 58, base - 17, C.JADE); b.rect(cx + 2, base - 58, 3, 42, C.STONE); b.vline(cx + 4, base - 58, base - 17, C.STONE_D);
  for (const y of [base - 40, base - 26]) b.hline(cx - 5, cx + 4, y, C.STONE);
  b.rect(cx - 12, base - 64, 24, 6, C.STONE_L); b.hline(cx - 12, cx + 11, base - 64, C.JADE); b.vline(cx + 11, base - 64, base - 59, C.STONE);
  // the chamber: stone posts at the corners, a paper window in front
  b.rect(cx - 11, base - 86, 22, 22, C.STONE);
  b.rect(cx - 7, base - 83, 14, 16, C.PAPER); b.rect(cx - 7, base - 83, 14, 3, C.GOLD_L); b.vline(cx, base - 83, base - 68, C.WOOD); b.hline(cx - 7, cx + 6, base - 76, C.WOOD);
  b.vline(cx - 11, base - 86, base - 65, C.STONE_L); b.vline(cx + 10, base - 86, base - 65, C.STONE_D);
  // cap: a small hipped stone roof with a pearl finial
  b.poly([[cx - 17, base - 86], [cx + 16, base - 86], [cx + 8, base - 97], [cx - 9, base - 97]], C.STONE);
  b.line(cx - 17, base - 86, cx - 9, base - 97, C.STONE_L); b.hline(cx - 9, cx + 8, base - 97, C.STONE_L); b.hline(cx - 17, cx + 16, base - 86, C.STONE_D);
  b.set(cx - 18, base - 87, C.STONE_L); b.set(cx + 17, base - 87, C.STONE);
  b.ellipse(cx, base - 100, 4, 3, C.STONE_L); b.set(cx - 1, base - 102, C.JADE);
  return [cx, base - 76];
}

/** a gentle shade remap that never pushes a colour to black (for leaf shadows) */
const SOFT = { [C.STONE_L]: C.STONE, [C.STONE]: C.STONE_D, [C.PLASTER_S]: C.STONE_L, [C.JADE]: C.STONE_L, [C.FLOOR]: C.FLOOR_D, [C.RED]: C.RED_M, [C.RED_L]: C.RED, [C.GOLD]: C.GOLD_D, [C.GRN_L]: C.GRN };
/** dappled shade: a cloud of small soft blobs remapping the colours underneath (leaf shadows) */
function dapple(b, cx, cy, rx, ry, seed, map = SOFT, n = 40, clip = [0, 0, W, H]) {
  const r = rng(seed);
  for (let k = 0; k < n; k++) {
    const a = r() * Math.PI * 2, d = Math.sqrt(r()), x0 = Math.round(cx + Math.cos(a) * d * rx), y0 = Math.round(cy + Math.sin(a) * d * ry), q = 5 + Math.floor(r() * 9), qy = Math.max(2, Math.round(q * 0.45));
    for (let y = y0 - qy; y <= y0 + qy; y++) for (let x = x0 - q; x <= x0 + q; x++) {
      if (x < clip[0] || y < clip[1] || x >= clip[2] || y >= clip[3]) continue;
      const e = ((x - x0) / q) ** 2 + ((y - y0) / qy) ** 2;
      if (e > 1 || (x + y) % 2 || (e > 0.6 && (x + y) % 4)) continue;
      const v = b.get(x, y); if (map[v] !== undefined) b.set(x, y, map[v]);
    }
  }
}
/** bronze water vat (铜缸) on a stone base, seen from above in 3/4 */
function bronzeVat(b, cx, base) {
  shade(b, [[cx - 26, base - 2], [cx + 26, base - 8], [cx + 54, base + 12], [cx + 4, base + 18]], DARK, 2);
  b.rect(cx - 28, base - 10, 56, 10, C.STONE); b.hline(cx - 28, cx + 27, base - 10, C.STONE_L); b.vline(cx + 27, base - 10, base - 1, C.STONE_D);
  b.ellipse(cx, base - 30, 28, 22, C.BRONZE); b.rect(cx - 28, base - 46, 57, 14, C.BRONZE);
  b.ellipse(cx - 9, base - 30, 9, 16, C.GOLD_D); b.ellipse(cx - 12, base - 32, 4, 11, C.GOLD); b.vline(cx + 22, base - 44, base - 20, C.BROWN); b.vline(cx + 25, base - 40, base - 26, C.BROWN);
  for (const dx of [-24, 20]) { b.ellipse(cx + dx, base - 34, 4, 5, C.BROWN); b.ellipse(cx + dx, base - 34, 2, 3, C.BRONZE); b.set(cx + dx - 1, base - 36, C.GOLD); } // ring handles
  b.hline(cx - 26, cx + 26, base - 44, C.GOLD_D);
  b.ellipse(cx, base - 48, 29, 9, C.GOLD_D); b.ellipse(cx, base - 48, 26, 7, C.TEAL); b.ellipse(cx, base - 49, 24, 5, C.BLU); b.hline(cx - 14, cx - 4, base - 50, C.SKY); b.hline(cx - 26, cx + 26, base - 41, C.BROWN);
  b.hline(cx - 22, cx - 4, base - 56, C.GOLD); b.set(cx - 23, base - 55, C.GOLD_L);
}

/** an old pagoda tree (槐) standing behind the far wall: only its crown spills over the coping */
function treeOverWall(b, cx, wallTop, seed, w = 1) {
  const r = rng(seed);
  b.rect(cx - 8, wallTop - 40, 16, 40, C.DBROWN); b.vline(cx - 8, wallTop - 40, wallTop, C.BROWN);
  b.line(cx, wallTop - 30, cx - 40 * w, wallTop - 58, C.DBROWN); b.line(cx, wallTop - 34, cx + 46 * w, wallTop - 62, C.DBROWN);
  const clumps = [];
  for (let k = 0; k < 14; k++) { const a = r() * Math.PI * 2, d = Math.sqrt(r()) * 70 * w; clumps.push([cx + Math.round(Math.cos(a) * d * 1.3), wallTop - 46 + Math.round(Math.sin(a) * d * 0.5), Math.round(22 + r() * 14)]); }
  clumps.sort((p, q) => p[1] - q[1]);
  for (const [x, y, rr] of clumps) b.ellipse(x + 2, y + 4, rr, Math.round(rr * 0.65), C.GRN_D);
  for (const [x, y, rr] of clumps) b.ellipse(x - 1, y, rr - 3, Math.round(rr * 0.6) - 2, C.GRN);
  for (const [x, y, rr] of clumps) b.ellipse(x - Math.round(rr / 3), y - Math.round(rr / 4), Math.round(rr / 2), Math.round(rr / 4), C.GRN_L);
  for (let k = 0; k < 900; k++) {
    const [x, y, rr] = clumps[Math.floor(r() * clumps.length)];
    const px = x + Math.round((r() - 0.5) * rr * 2), py = y + Math.round((r() - 0.5) * rr * 1.2), v = b.get(px, py);
    if (v === C.GRN || v === C.GRN_L) b.set(px, py, r() < 0.5 ? C.GRN_D : r() < 0.5 ? C.GRN_L : C.GRN);
  }
}

/** a gate passage through the cross wall at the end of the street, seen in the 3/4 view as a thick side wall
 *  (like the side doors of the halls). side = -1 (left edge) or 1 (right edge); the opening spans y0..y1 */
function endGate(b, side, y0, y1, top, bottom) {
  const ww = 52, x = side < 0 ? 0 : W - ww, cop = 14;
  const fx = side < 0 ? x + cop : x, fw = ww - cop; // the red face
  const cx = side < 0 ? x : x + ww - cop;            // the coping strip on the outer edge
  b.rect(fx, top, fw, bottom - top, C.RED);
  for (let y = top; y < bottom; y++) if ((y * 7) % 31 < 2) b.hline(fx + 6, fx + fw - 6, y, C.RED_M);
  b.vline(side < 0 ? fx + fw - 1 : fx, top, bottom - 1, side < 0 ? C.RED_D : C.RED_L);
  b.rect(cx, top, cop, bottom - top, C.GOLD_D);
  for (let y = top; y < bottom; y += 8) { b.hline(cx, cx + cop - 1, y, C.GOLD); b.hline(cx, cx + cop - 1, y + 1, C.GOLD_L); b.hline(cx, cx + cop - 1, y + 6, C.BROWN); }
  b.vline(side < 0 ? cx + cop - 1 : cx, top, bottom - 1, C.BROWN);
  // the passage: lintel and sill of white stone, the paving running on through it into daylight beyond
  b.rect(x, y0 - 12, ww, 12, C.STONE_L); b.hline(x, x + ww - 1, y0 - 12, C.JADE); b.hline(x, x + ww - 1, y0 - 1, C.STONE);
  b.rect(x, y0, ww, y1 - y0, C.STONE);
  for (let y = y0; y < y1; y += 20) { b.hline(x, x + ww - 1, y, C.STONE_D); for (let i = x + ((y / 20) % 2 < 1 ? 0 : 20); i < x + ww; i += 40) b.vline(i, y, y + 19, C.STONE_D); }
  const dark = side < 0 ? [x + 20, ww - 20] : [x, ww - 20];
  dith(b, dark[0], y0, dark[1], y1 - y0, C.DEEP, 2); dith(b, dark[0], y0 + 1, dark[1], y1 - y0 - 1, C.STONE_D, 2);
  dith(b, side < 0 ? x : x + ww - 20, y0, 20, y1 - y0, C.STONE_L, 3);
  // the studded leaves folded back against the jambs
  for (const ly of [y0, y1 - 8]) { b.rect(fx, ly, fw, 8, C.RED); b.hline(fx, fx + fw - 1, ly, C.RED_L); b.hline(fx, fx + fw - 1, ly + 7, C.RED_D); for (let i = fx + 3; i < fx + fw - 2; i += 6) b.set(i, ly + 4, C.GOLD); }
  b.rect(x, y1, ww, 8, C.STONE_L); b.hline(x, x + ww - 1, y1 + 7, C.STONE); b.hline(x, x + ww - 1, y1, C.JADE);
  // the gate tower's roof rising above the far wall at the corner
  glazedRoof(b, side < 0 ? -60 : W - 196, side < 0 ? 196 : W + 60, top - 6, 0, { lift: 10, hipK: 1.1 });
}

export function gongdao() {
  const b = new Bitmap(W, H);
  const wallTop = 52, wallBase = 212, streetBot = 646;
  // ── 1. sky, distant roofs and treetops beyond the far wall ──
  b.rect(0, 0, W, wallTop + 4, C.SKY);
  b.rect(0, 24, W, wallTop - 20, C.SKY_L); dith(b, 0, 18, W, 6, C.SKY_L, 2);
  {
    const r = rng(12);
    for (let x = 160; x < W - 160; x += 26) { const rr = 12 + Math.floor(r() * 10); b.ellipse(x, wallTop - 2, rr, Math.round(rr * 0.6), r() < 0.5 ? C.HILL : C.HILL_L); }
    for (const [a, z, t] of [[380, 600, 26], [700, 900, 30]]) { glazedRoof(b, a, z, wallTop - 2, t, { hip: false, lift: 4 }); b.rect(a + 18, t - 5, z - a - 36, 6, C.GOLD_D); b.hline(a + 18, z - 19, t - 5, C.GOLD_L); }
  }
  // ── 2. the far (north) wall, with a closed side gate set in it ──
  redWall(b, 0, W, wallTop, wallBase, 7);
  {
    const gx = 600, gw = 80, gt = 100, gb = wallBase - 14;
    b.rect(gx - 22, gt - 16, gw + 44, gb - gt + 16, C.GOLD_D); b.rect(gx - 18, gt - 12, gw + 36, gb - gt + 12, C.GRN);
    for (let y = gt - 8; y < gb - 2; y += 6) for (let x = gx - 16 + ((y / 6) % 2 < 1 ? 0 : 4); x < gx + gw + 16; x += 8) b.rect(x, y, 3, 3, C.GRN_L);
    b.rect(gx, gt, gw, gb - gt, C.RED_D);
    b.rect(gx + 2, gt + 2, gw / 2 - 3, gb - gt - 2, C.RED); b.rect(gx + gw / 2 + 1, gt + 2, gw / 2 - 3, gb - gt - 2, C.RED_M);
    b.vline(gx + 2, gt + 2, gb - 1, C.RED_L);
    for (let y = gt + 9; y < gb - 4; y += 11) for (let x = gx + 8; x < gx + gw - 4; x += 12) { b.ellipse(x, y, 2, 2, C.GOLD); b.set(x - 1, y - 1, C.GOLD_L); }
    for (const x of [gx + gw / 2 - 6, gx + gw / 2 + 3]) { b.ellipse(x + 1, gt + 54, 3, 3, C.GOLD_D); b.ellipse(x + 1, gt + 54, 2, 2, C.GOLD); }
    b.rect(gx - 6, gt - 8, gw + 12, 8, C.RED_D); b.hline(gx - 6, gx + gw + 5, gt - 8, C.GOLD);
    glazedRoof(b, gx - 40, gx + gw + 40, gt - 20, wallTop - 6, { lift: 8, hipK: 1.1 });
    b.rect(gx - 4, gb, gw + 8, 14, C.STONE_L); b.hline(gx - 4, gx + gw + 3, gb, C.JADE);
  }
  // old trees behind the far wall, their crowns hanging over the coping and dappling the wall below
  treeOverWall(b, 250, wallTop + 26, 3, 1);
  treeOverWall(b, 1030, wallTop + 26, 5, 0.9);
  dapple(b, 250, wallTop + 64, 130, 36, 31, SOFT, 30, [0, wallTop + 20, W, wallBase - 14]);
  dapple(b, 1030, wallTop + 64, 120, 36, 32, SOFT, 26, [0, wallTop + 20, W, wallBase - 14]);

  // ── 3. the street: grey brick in running bond, a lane of long stone slabs down the middle, gutters ──
  const ly0 = 400, ly1 = 462;
  {
    const r = rng(21);
    b.rect(0, wallBase, W, streetBot - wallBase, C.STONE);
    for (let y = wallBase, row = 0; y < streetBot; y += 20, row++)
      for (let x = -((row % 2) * 20); x < W; x += 40) {
        const v = r();
        if (v < 0.12) dith(b, x + 1, y + 1, 38, 18, C.STONE_D, 2); else if (v < 0.2) dith(b, x + 1, y + 1, 38, 18, C.STONE_L, 4); else if (v < 0.24) dith(b, x + 1, y + 1, 38, 18, C.FLOOR, 3);
        b.hline(x, x + 39, y + 19, C.STONE_D); b.vline(x + 39, y, y + 19, C.STONE_D); b.hline(x + 1, x + 6, y, C.STONE_L);
      }
    // the central lane of long slabs, worn smooth
    b.rect(0, ly0, W, ly1 - ly0, C.STONE_L);
    dith(b, 0, ly0, W, ly1 - ly0, C.STONE, 3);
    for (let x = 0, k = 0; x < W + 120; x += 120, k++) {
      b.vline(x, ly0, ly0 + 30, C.STONE); b.vline(x - 60, ly0 + 31, ly1 - 1, C.STONE);
      if (r() < 0.35) dith(b, x + 1, ly0 + 1, 118, 29, C.PLASTER_S, 3);
      if (r() < 0.35) dith(b, x - 59, ly0 + 32, 118, 29, C.PLASTER_S, 3);
      if (r() < 0.25) { const cx = x + 20 + Math.floor(r() * 70); b.line(cx, ly0 + 4, cx + 9, ly0 + 14, C.STONE); }
    }
    b.hline(0, W - 1, ly0 + 31, C.STONE); b.hline(0, W - 1, ly0, C.JADE); b.hline(0, W - 1, ly1 - 1, C.STONE);
    b.hline(0, W - 1, ly0 - 1, C.STONE_D); b.hline(0, W - 1, ly1, C.STONE_D);
    // stone gutters along both wall feet, with drain covers
    for (const gy of [wallBase, streetBot - 14]) {
      b.rect(0, gy, W, 14, C.STONE_D); b.hline(0, W - 1, gy, C.STONE); b.rect(0, gy + 4, W, 6, C.TILE_D);
      for (let x = 70; x < W; x += 160) { b.rect(x, gy + 2, 26, 10, C.STONE); for (let i = 3; i < 24; i += 4) b.vline(x + i, gy + 3, gy + 10, C.BLACK); }
    }
    // moss and little weeds in the joints near the walls
    for (let k = 0; k < 400; k++) { const x = Math.floor(r() * W), y = r() < 0.5 ? wallBase + 14 + Math.floor(r() * 34) : streetBot - 46 + Math.floor(r() * 32); if (b.get(x, y) === C.STONE_D) { b.set(x, y, C.GRN_D); if (r() < 0.4) b.set(x, y - 1, C.GRN); } }
    // fallen pagoda-tree leaves under the old trees
    for (let k = 0; k < 160; k++) { const tx = r() < 0.5 ? 250 : 1030, x = tx + Math.round((r() - 0.5) * 360), y = wallBase + 16 + Math.floor(r() * 170); b.set(x, y, r() < 0.5 ? C.GOLD : C.GRN_L); if (r() < 0.6) b.set(x + 1, y, C.GOLD_D); }
  }
  // the far wall's shadow across the near edge of the street, and the trees' dappled shade
  { // a long soft-edged shadow band, the coping's drip edge printed along its border
    const m = new Bitmap(W, H);
    for (let x = 0; x < W; x++) { const e = wallBase + 64 + ((x % 8) < 4 ? 0 : 2); for (let y = wallBase + 14; y < e; y++) m.set(x, y, 1); }
    for (let y = wallBase + 14; y < wallBase + 72; y++) for (let x = 0; x < W; x++) {
      if (!m.get(x, y)) continue;
      const edge = y > wallBase + 56;
      if (edge && (x + y) % 2) continue;
      const v = b.get(x, y); if (SOFT[v] !== undefined) b.set(x, y, SOFT[v]);
    }
  }
  dapple(b, 300, wallBase + 96, 170, 40, 33, SOFT, 40, [0, wallBase + 14, W, streetBot]);
  dapple(b, 1080, wallBase + 96, 160, 40, 34, SOFT, 36, [0, wallBase + 14, W, streetBot]);

  // ── 4. lantern posts and bronze water vats along both walls ──
  const lamps = [];
  for (const x of [160, 440, 840, 1120]) lamps.push(stoneLantern(b, x, wallBase + 38));
  bronzeVat(b, 300, wallBase + 46);
  bronzeVat(b, 980, wallBase + 46);
  for (const x of [300, 640, 980]) lamps.push(stoneLantern(b, x, streetBot - 6));

  // ── 5. the near (south) wall: its coping seen from above, then the top of its outer face ──
  dith(b, 0, streetBot - 4, W, 4, C.DEEP, 2);
  copingTop(b, 0, W, streetBot, streetBot + 28);
  b.rect(0, streetBot + 28, W, H - streetBot - 28, C.RED);
  b.hline(0, W - 1, streetBot + 28, C.DEEP); dith(b, 0, streetBot + 29, W, 8, C.RED_D, 2);
  { const r = rng(5); for (let k = 0; k < 40; k++) { const x = Math.floor(r() * W), y = streetBot + 40 + Math.floor(r() * 30); b.vline(x, y, Math.min(H - 1, y + 4 + Math.floor(r() * 8)), C.RED_M); } }

  // ── 6. the gates at both ends ──
  endGate(b, -1, 300, 560, wallTop + 4, streetBot + 28);
  endGate(b, 1, 300, 560, wallTop + 4, streetBot + 28);
  shade(b, [[52, wallBase], [80, wallBase], [130, streetBot - 14], [52, streetBot - 14]], DARK, 2); // the left gate wall's shadow on the street

  const half = (p) => [p[0] / 2, p[1] / 2];
  return {
    bg: b,
    spots: {
      walk: [
        { x0: 28, x1: 612, y0: 134, y1: 300 }, // the street between the walls
        { x0: 2, x1: 638, y0: 156, y1: 276 },  // through the gate passages at both ends
      ],
      // 军机处 lies east of the street (you leave it westward), the garden at its west end where the street turns north
      doors: { junjichu: [628, 152, 12, 128], yuhuayuan: [0, 152, 12, 128] },
      emperorStart: [320, 226],
      title: [320, 352],
      lamps: lamps.map(half),
      lanterns: [],
      birds: true,
      npcs: [
        { kind: 'eunuch', x: 120, y: 214, facing: 'right', act: 'tray', route: [[40, 214], [600, 214]] },
        { kind: 'lady', x: 520, y: 246, facing: 'left', act: 'idle', route: [[600, 246], [40, 246]] },
        { kind: 'eunuch', x: 380, y: 150, facing: 'left', act: 'sweep', route: [[400, 150], [210, 150]] },
        { kind: 'guard', x: 70, y: 180, facing: 'right', act: 'patrol', route: [[60, 180], [580, 180]] },
      ],
      cat: [[178, 27], [222, 27], [262, 27]], // the game keeps this cat at depth 200: it walks along the far wall's coping
    },
  };
}
