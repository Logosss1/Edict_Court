// 承天门 — the palace gate seen from the south, top-down (3/4): the gate tower along the top, the great red wall
// with five arched passages, and the stone plaza in front with 华表, stone lions, the notice board and the 登闻鼓.
import { Bitmap, C, rng, W, H, dith, frame, shade, DARK, glazedRoof, bracketBand, hallFront, marbleRail, pavingTD } from './common.mjs';

const WALL = { top: 180, base: 400, foot: 428 }; // red wall face from top to base; the marble plinth ends at foot
const ARCHES = [
  { cx: 640, hw: 56, spring: 300 },
  { cx: 432, hw: 44, spring: 322 },
  { cx: 848, hw: 44, spring: 322 },
  { cx: 236, hw: 36, spring: 342 },
  { cx: 1044, hw: 36, spring: 342 },
];
const STREET = { y0: 616, y1: 680 }; // the east–west 天街 in front of the gate
const PATH = { x0: 588, x1: 692 };
const BOARD = { x: 104, y: 466, w: 192, h: 90 }; // paper area of the notice board
const DRUM = { x: 1096, y: 516, r: 40 };
const POLES = [140, 232, 1048, 1140];

export function chengtian() {
  const b = new Bitmap(W, H);

  // ── 1. the plaza: big stone slabs, the 天街 across, the imperial way up the middle ──
  pavingTD(b, 0, WALL.foot, W, H, { seed: 23, bw: 64, bh: 32 });
  {
    const { y0, y1 } = STREET;
    b.rect(0, y0, W, y1 - y0, C.STONE_L);
    for (let x = 0, k = 0; x < W; x += 40, k++) { b.vline(x, y0 + 8, y1 - 9, C.STONE); if (k % 2) b.hline(x, x + 39, (y0 + y1) / 2, C.STONE); }
    for (const y of [y0, y1 - 8]) { b.rect(0, y, W, 8, C.PLASTER_S); for (let x = 12; x < W; x += 32) b.vline(x, y, y + 7, C.STONE_L); }
    b.hline(0, W - 1, y0, C.JADE); b.hline(0, W - 1, y1 - 1, C.STONE);
    dith(b, 0, y1, W, 3, C.STONE_D, 2);
    const { x0, x1 } = PATH;
    shade(b, [[x1, WALL.foot], [x1 + 4, WALL.foot + 4], [x1 + 4, y0], [x1, y0]], DARK, 1);
    shade(b, [[x1, y1], [x1 + 4, y1 + 4], [x1 + 4, H], [x1, H]], DARK, 1);
    for (const [a, z] of [[WALL.foot, y0], [y1, H]]) {
      b.rect(x0, a, x1 - x0, z - a, C.STONE_L);
      for (let y = a + 26; y < z; y += 26) b.hline(x0 + 12, x1 - 13, y, C.STONE);
      for (const ex of [x0, x1 - 12]) { b.rect(ex, a, 12, z - a, C.PLASTER_S); for (let y = a + 10; y < z; y += 30) b.hline(ex, ex + 11, y, C.STONE_L); }
      b.vline(x0, a, z - 1, C.JADE); b.vline(x1 - 1, a, z - 1, C.STONE_D);
      dith(b, x0 + 12, a, x1 - x0 - 24, z - a, C.PLASTER_S, 11, 5);
    }
  }

  // ── 2. the gate platform (城台): red wall over a white marble plinth, five arched passages ──
  {
    const { top, base, foot } = WALL;
    b.rect(0, top, W, base - top, C.RED);
    const r = rng(31);
    for (let k = 0; k < 140; k++) { const x = Math.floor(r() * W), y = top + 14 + Math.floor(r() * (base - top - 20)), L = 6 + Math.floor(r() * 26); for (let j = 0; j < L; j += 2) b.set(x, y + j, C.RED_M); }
    for (let k = 0; k < 220; k++) b.set(Math.floor(r() * W), top + 10 + Math.floor(r() * (base - top - 12)), r() < 0.5 ? C.RED_L : C.RED_M);
    dith(b, 0, top, W, 10, C.RED_M, 2); dith(b, 0, top + 10, W, 6, C.RED_M, 4);
    dith(b, 0, base - 10, W, 10, C.RED_M, 3);
    // the marble plinth (须弥座)
    b.rect(0, base, W, foot - base, C.STONE_L);
    b.hline(0, W - 1, base, C.JADE); b.hline(0, W - 1, base + 1, C.PAPER); b.hline(0, W - 1, base + 4, C.STONE);
    b.rect(0, base + 8, W, 10, C.STONE); b.hline(0, W - 1, base + 8, C.STONE_D);
    for (let x = 6; x < W; x += 44) { b.rect(x, base + 10, 34, 7, C.STONE_L); b.hline(x, x + 33, base + 10, C.PLASTER_S); b.ellipse(x + 17, base + 13, 7, 1, C.PAPER); }
    b.hline(0, W - 1, base + 18, C.PLASTER_S); b.hline(0, W - 1, foot - 2, C.STONE); b.hline(0, W - 1, foot - 1, C.STONE_D);
    dith(b, 0, foot, W, 4, C.STONE_D, 2);
    for (const a of ARCHES) arch(b, a, a.cx === 640);
  }

  // ── 3. the top of the platform: parapet with yellow-glazed coping, brick walk, flag poles ──
  {
    const y0 = 26, y1 = 172;
    // beyond the platform's back parapet: the tops of the trees inside the palace
    b.rect(0, 0, W, y0, C.GRN_D);
    const tr = rng(77);
    for (let k = 0; k < 70; k++) { const x = Math.floor(tr() * W), y = Math.floor(tr() * 22), r = 6 + Math.floor(tr() * 8); b.ellipse(x, y, r, Math.round(r * 0.7), C.GRN); b.ellipse(x - 2, y - 2, Math.round(r / 2), Math.round(r / 3), C.GRN_L); }
    for (let k = 0; k < 300; k++) { const x = Math.floor(tr() * W), y = Math.floor(tr() * 24); if (b.get(x, y) === C.GRN) b.set(x, y, C.GRN_D); }
    pavingTD(b, 0, y0, W, y1, { seed: 41, bw: 32, bh: 12, odd: 0.1 });
    dith(b, 0, y1 - 8, W, 8, C.STONE_D, 2);
    // the back parapet's coping
    for (let x = 0; x < W; x++) for (let y = y0 - 6; y < y0; y++) { const k = x % 6; b.set(x, y, k === 0 ? C.GOLD_L : k < 4 ? C.GOLD : C.GOLD_D); }
    b.hline(0, W - 1, y0 - 7, C.GOLD_D); b.hline(0, W - 1, y0, C.RED_D); b.hline(0, W - 1, y0 + 1, C.RED_M); dith(b, 0, y0 + 2, W, 4, C.BLACK, 2);
    for (const x of POLES) {
      shade(b, [[x + 2, y1 - 2], [x + 8, y1 - 4], [x + 22, y1 + 4], [x + 16, y1 + 6]], DARK, 1);
      b.ellipse(x, y1 - 3, 7, 3, C.STONE); b.ellipse(x, y1 - 4, 5, 2, C.STONE_L);
      b.rect(x - 2, 38, 4, y1 - 42, C.RED); b.vline(x - 2, 38, y1 - 5, C.RED_L); b.vline(x + 1, 38, y1 - 5, C.RED_D);
      b.ellipse(x, 36, 3, 3, C.GOLD); b.set(x - 1, 35, C.GOLD_L); b.poly([[x - 2, 33], [x + 2, 33], [x, 26]], C.GOLD_D); b.set(x, 28, C.GOLD);
    }
    // parapet coping: glazed tiles seen from above, a row of tile ends along the front
    const cy = y1, ch = 10;
    for (let x = 0; x < W; x++) for (let y = cy; y < cy + ch; y++) {
      const k = x % 8; b.set(x, y, k === 0 ? C.GOLD_L : k < 4 ? C.GOLD : k === 4 ? C.GOLD_D : k === 5 ? C.BROWN : C.GOLD_D);
    }
    b.hline(0, W - 1, cy, C.GOLD_L); b.hline(0, W - 1, cy + 1, C.GOLD);
    for (let x = 2; x < W; x += 8) { b.ellipse(x + 1, cy + ch - 1, 2, 2, C.GOLD); b.set(x, cy + ch - 2, C.GOLD_L); }
    b.hline(0, W - 1, cy + ch + 1, C.BROWN); dith(b, 0, cy + ch + 2, W, 4, C.RED_D, 2);
  }

  // ── 4. the gate tower: marble base and balustrade, nine-bay front, double-eaved roof ──
  {
    const x0 = 360, x1 = 920;
    b.rect(332, 126, 616, 8, C.JADE); b.hline(332, 947, 126, C.PAPER);
    b.rect(332, 134, 616, 12, C.STONE_L); b.hline(332, 947, 134, C.JADE); b.hline(332, 947, 137, C.STONE); b.hline(332, 947, 145, C.STONE_D);
    for (let x = 340; x < 940; x += 30) { frame(b, x, 139, 22, 5, C.STONE); }
    b.vline(947, 126, 145, C.STONE);
    shade(b, [[948, 128], [958, 136], [958, 156], [342, 156], [332, 146], [948, 146]], DARK, 2);
    hallFront(b, x0, x1, 68, 126, 9, { doors: [1, 7], colW: 8 });
    shade(b, [[x0, 68], [x1, 68], [x1, 80], [x0, 86]], DARK, 2);
    marbleRail(b, 336, 944, 132, 24);
    bracketBand(b, 326, 954, 54, 14, 22);
    glazedRoof(b, 316, 964, 52, 0, { lift: 12, hipK: 0.95 });
    // upper storey of the double roof
    const u0 = 400, u1 = 880;
    b.rect(u0 - 10, 20, u1 - u0 + 20, 6, C.GOLD_D); b.hline(u0 - 10, u1 + 9, 20, C.GOLD_L); b.hline(u0 - 10, u1 + 9, 21, C.GOLD); b.hline(u0 - 10, u1 + 9, 25, C.BROWN);
    bracketBand(b, u0, u1, 6, 14, 20);
    b.rect(u0 - 24, 0, u1 - u0 + 48, 6, C.DEEP);
    for (let x = u0 - 22; x < u1 + 22; x += 10) { b.ellipse(x + 2, 1, 3, 3, C.GOLD); b.set(x + 1, 0, C.GOLD_L); b.hline(x, x + 4, 4, C.GOLD_D); }
    for (let x = u0 - 22; x < u1 + 22; x += 5) b.rect(x, 5, 2, 2, (x / 5) % 2 < 1 ? C.GRN : C.BLU);
    shade(b, [[u0 - 10, 26], [u1 + 10, 26], [u1 + 18, 34], [u0 - 2, 34]], DARK, 2);
    // blank name board
    const px = 620, py = 8, pw = 40, ph = 40;
    shade(b, [[px + pw + 4, py + 6], [px + pw + 10, py + 12], [px + pw + 10, py + ph + 10], [px + 6, py + ph + 10], [px, py + ph + 4], [px + pw + 4, py + ph + 4]], DARK, 2);
    b.rect(px - 5, py - 4, pw + 10, ph + 8, C.GOLD_D); b.rect(px - 4, py - 3, pw + 8, ph + 6, C.GOLD); b.hline(px - 4, px + pw + 3, py - 3, C.GOLD_L); b.vline(px - 4, py - 3, py + ph + 2, C.GOLD_L);
    b.rect(px, py, pw, ph, C.BLU_D); b.hline(px, px + pw - 1, py, C.BLU); b.vline(px, py, py + ph - 1, C.BLU);
  }

  // ── 5. the side gates of the 天街 (left: west toward the corner tower; right: east to the ministries) ──
  for (const s of [1, -1]) sideWall(b, s);

  // ── 6. stone lions by the central passage, the pair of 华表 ──
  lion(b, 530, 498, 1);
  lion(b, 750, 498, -1);
  huabiao(b, 452, 604);
  huabiao(b, 828, 604);

  // ── 7. the notice board (left) and the 登闻鼓 (right) ──
  noticeBoard(b);
  drum(b);

  const spots = {
    walk: [
      { x0: 16, x1: 624, y0: 300, y1: 352 }, // the 天街 and the plaza's south half
      { x0: 170, x1: 470, y0: 222, y1: 300 }, // between the notice board and the drum, up to the gate
      { x0: 302, x1: 338, y0: 200, y1: 222 }, // into the central passage
      { x0: 4, x1: 16, y0: 310, y1: 338 }, // west gate
      { x0: 624, x1: 636, y0: 310, y1: 338 }, // east gate
    ],
    doors: { guangchang: [300, 194, 40, 14], liubu: [628, 308, 12, 32], jiaolou: [0, 308, 12, 32] },
    emperorStart: [320, 326],
    plaque: [320, 15], // the blank board under the eaves; the game writes the name on it
    title: [320, 348],
    birds: true,
    board: [BOARD.x / 2, BOARD.y / 2, BOARD.w / 2, BOARD.h / 2],
    herald: [176, 306], // 鸿胪寺卿 stands beside the notice board
    drum: [DRUM.x / 2, DRUM.y / 2],
    flags: POLES.map((x) => [x / 2, 19]),
    wallTop: [[14, 87], [64, 87]],
    lanterns: [[202, 28], [262, 28], [378, 28], [438, 28]],
    guards: [[294, 224], [346, 224], [36, 304], [604, 304]],
    npcs: [
      { kind: 'guard', x: 120, y: 326, facing: 'right', act: 'patrol', route: [[60, 326], [580, 326]] },
      { kind: 'eunuch', x: 230, y: 318, facing: 'left', act: 'sweep', route: [[200, 318], [270, 318], [270, 334]] },
      { kind: 'eunuch', x: 92, y: 320, facing: 'back' }, // reading the notices
    ],
  };
  return { bg: b, spots };
}

/** one arched passage through the wall: dark vaulted interior, gate leaves folded back, the far end glimpsed */
function arch(b, a, centre) {
  const { cx, hw, spring } = a, bot = WALL.foot;
  const inside = (x, y) => (y >= spring ? Math.abs(x - cx) <= hw : (x - cx) ** 2 + (y - spring) ** 2 <= hw * hw);
  const top = spring - hw;
  // the stone ring around the opening, then the opening
  for (let y = top - 6; y < bot; y++) for (let x = cx - hw - 6; x <= cx + hw + 6; x++) {
    if (inside(x, y)) continue;
    const d = y >= spring ? Math.abs(x - cx) - hw : Math.hypot(x - cx, y - spring) - hw;
    if (d <= 5 && y < WALL.base) b.set(x, y, d <= 1 ? C.RED_D : x < cx ? C.RED_L : C.RED);
  }
  for (let y = top; y < bot; y++) for (let x = cx - hw; x <= cx + hw; x++) if (inside(x, y)) {
    const t = (y - top) / (bot - top);
    b.set(x, y, t < 0.55 ? C.DEEP : (x + y) % 2 && t < 0.7 ? C.DEEP : C.BLACK);
  }
  // the passage floor runs back into the dark
  const f0 = spring + 6;
  for (let y = f0; y < bot; y++) {
    const t = (y - f0) / (bot - f0);
    for (let x = cx - hw; x <= cx + hw; x++) {
      if (!inside(x, y)) continue;
      const c = t > 0.78 ? C.STONE_D : t > 0.5 ? ((x + y) % 2 ? C.STONE_D : C.BLACK) : t > 0.2 ? C.BLACK : (x + y) % 2 ? C.BLACK : C.DEEP;
      b.set(x, y, c);
    }
  }
  if (centre) { // daylight at the far end of the central passage
    const fx = cx, fy = spring + 8, fw = 18;
    const fy0 = f0 - 26;
    for (let y = fy0 - fw; y < f0 + 4; y++) for (let x = fx - fw; x <= fx + fw; x++) if (y >= fy0 ? Math.abs(x - fx) <= fw : (x - fx) ** 2 + (y - fy0) ** 2 <= fw * fw) b.set(x, y, y > f0 - 8 ? C.STONE : y > f0 - 16 ? C.RED_M : C.SKY_L);
    for (let x = fx - fw + 4; x < fx + fw - 2; x += 8) b.rect(x, f0 - 16, 3, 8, C.RED_D);
    dith(b, fx - fw - 2, fy0 - fw, 2 * fw + 5, f0 + 4 - (fy0 - fw), C.DEEP, 2);
  }
  // gate leaves folded back against the passage sides, studded with gilt nails
  for (const s of [-1, 1]) {
    const lx = s < 0 ? cx - hw : cx + hw - 9;
    const ly0 = spring - Math.round(hw * 0.35);
    b.rect(lx, ly0, 9, bot - ly0 - 2, C.RED_M); b.vline(s < 0 ? lx + 8 : lx, ly0, bot - 3, C.RED); b.vline(s < 0 ? lx : lx + 8, ly0, bot - 3, C.RED_D);
    for (let y = ly0 + 6; y < bot - 6; y += 9) b.set(lx + 4, y, C.GOLD);
  }
  // shadow inside the left edge of the opening (light from the top-left)
  for (let y = top + 4; y < bot - 2; y++) for (let x = cx - hw; x < cx - hw + 3; x++) if (inside(x, y) && y < spring) b.set(x, y, C.BLACK);
}

/** the red wall running back along a side edge of the plaza, broken by a gate on the 天街 */
function sideWall(b, s) {
  const w = 26, x = s > 0 ? 0 : W - w, g0 = STREET.y0 - 2, g1 = STREET.y1 + 2;
  if (s > 0) for (const [a, z] of [[WALL.foot, g0], [g1, H]]) shade(b, [[w, a], [w + 12, a + 8], [w + 12, z], [w, z]], DARK, 2);
  for (const [a, z] of [[WALL.foot - 4, g0], [g1, H]]) {
    b.rect(x, a, w, z - a, C.RED_D);
    const cx = s > 0 ? x + 4 : x + 6;
    // yellow-tiled coping along the wall top
    for (let y = a; y < z; y++) for (let i = 0; i < 16; i++) { const k = (y + 400) % 5, lit = s > 0 ? i < 7 : i > 8; b.set(cx + i, y, k === 0 ? (lit ? C.GOLD : C.GOLD_D) : lit ? C.GOLD_L : C.GOLD); }
    b.vline(cx + 7, a, z - 1, C.GOLD_D); b.vline(cx + 8, a, z - 1, C.GOLD_L);
    b.vline(s > 0 ? cx + 16 : cx - 1, a, z - 1, C.GOLD_D);
    b.vline(s > 0 ? x + w - 1 : x, a, z - 1, s > 0 ? C.RED : C.RED_M);
    b.rect(x, z - 6, w, 6, C.RED_M); b.hline(x, x + w - 1, z - 6, C.RED_L); b.hline(x, x + w - 1, z - 1, C.RED_D);
  }
  // the gateway: stone threshold, door leaves standing open against the jambs
  b.rect(x, g0, w, g1 - g0, C.STONE_L);
  for (let y = g0 + 6; y < g1; y += 12) b.hline(x, x + w - 1, y, C.STONE);
  b.vline(s > 0 ? x : x + w - 1, g0, g1 - 1, C.DEEP);
  for (const y of [g0, g1 - 8]) { b.rect(x + 2, y, w - 4, 8, C.RED); b.hline(x + 2, x + w - 3, y, C.RED_L); for (let i = x + 5; i < x + w - 4; i += 6) b.set(i, y + 4, C.GOLD); }
}

/** stone lion on a marble pedestal, seated, head turned toward the path; dir 1 = the west lion (faces right) */
function lion(b, cx, by, dir) {
  const L = C.STONE_L, M = C.STONE, D = C.STONE_D, Hh = C.JADE;
  shade(b, [[cx - 14, by], [cx + 30, by - 40], [cx + 56, by - 20], [cx + 46, by + 14], [cx, by + 14]], DARK, 2);
  // two-step pedestal (须弥座)
  b.rect(cx - 32, by - 14, 64, 14, L); b.hline(cx - 32, cx + 31, by - 14, Hh); b.hline(cx - 32, cx + 31, by - 11, M);
  b.rect(cx - 28, by - 9, 56, 5, M); b.rect(cx - 24, by - 8, 48, 3, L); b.hline(cx - 32, cx + 31, by - 2, M); b.hline(cx - 32, cx + 31, by - 1, D); b.vline(cx + 31, by - 14, by - 1, M);
  b.rect(cx - 28, by - 24, 56, 10, Hh); b.hline(cx - 28, cx + 27, by - 24, C.PAPER); b.hline(cx - 28, cx + 27, by - 17, L); b.hline(cx - 28, cx + 27, by - 15, M); b.vline(cx + 27, by - 24, by - 15, L);
  b.rect(cx - 30, by - 30, 60, 7, L); b.hline(cx - 30, cx + 29, by - 30, Hh); b.hline(cx - 30, cx + 29, by - 24, M);
  const ty = by - 30; // top of the pedestal
  // folded hind leg and the flame-like tail behind
  b.ellipse(cx - dir * 13, ty - 12, 13, 11, D); b.ellipse(cx - dir * 13, ty - 13, 12, 10, M); b.ellipse(cx - dir * 15, ty - 16, 7, 5, L);
  for (let k = 0; k < 3; k++) { const tx = cx - dir * (24 + k), tyy = ty - 22 - k * 7; b.ellipse(tx, tyy, 5, 4, M); b.ellipse(tx - 1, tyy - 1, 3, 2, L); b.set(tx + dir * 2, tyy + 2, D); }
  // broad chest, front legs, paws
  b.rect(cx - 15, ty - 42, 30, 40, M); b.ellipse(cx, ty - 30, 15, 14, M);
  b.rect(cx - 13, ty - 40, 24, 36, L); b.vline(cx + 13, ty - 40, ty - 2, D);
  for (const fx of [cx - 12, cx + 2]) { b.rect(fx, ty - 26, 9, 24, L); b.vline(fx + 8, ty - 26, ty - 3, M); b.vline(fx, ty - 26, ty - 3, Hh); b.rect(fx - 1, ty - 6, 11, 6, L); b.hline(fx - 1, fx + 9, ty - 1, D); for (const c of [1, 4, 7]) b.set(fx + c, ty - 2, D); }
  // collar with a bell
  b.rect(cx - 14, ty - 38, 28, 3, D); b.ellipse(cx + dir * 2, ty - 33, 3, 3, M); b.set(cx + dir * 2 - 1, ty - 34, Hh);
  // under the paw: the cub (west, mother) or the embroidered ball (east, father)
  const px = cx + dir * 20;
  if (dir > 0) { b.ellipse(px, ty - 7, 8, 7, D); b.ellipse(px - 1, ty - 8, 7, 6, M); b.ellipse(px - 2, ty - 10, 4, 3, L); b.ellipse(px + 3, ty - 12, 4, 4, M); b.set(px + 4, ty - 13, D); b.set(px + 2, ty - 14, L); }
  else { b.ellipse(px, ty - 8, 8, 8, D); b.ellipse(px - 1, ty - 9, 7, 7, M); b.ellipse(px - 3, ty - 11, 3, 3, L); for (let a = 0; a < 8; a++) b.set(px + Math.round(Math.cos(a * 0.8) * 5), ty - 9 + Math.round(Math.sin(a * 0.8) * 5), D); }
  b.rect(px - 5, ty - 20, 10, 7, L); b.hline(px - 5, px + 4, ty - 14, M); b.vline(px - 5, ty - 20, ty - 14, Hh);
  b.line(cx + dir * 12, ty - 30, px, ty - 19, L); b.line(cx + dir * 12, ty - 29, px, ty - 18, M);
  // the mane: rows of tight curls framing a big face turned toward the path
  const hx = cx + dir * 3, hy = ty - 50;
  b.ellipse(hx, hy + 2, 20, 18, D); b.ellipse(hx - 1, hy + 1, 19, 17, M);
  for (let row = 0; row < 3; row++) for (let k = 0; k < 9; k++) {
    const a = Math.PI * (0.95 + row * 0.04) + (k / 8) * Math.PI * (1.1 - row * 0.08), rr = 16 - row * 1;
    const qx = hx + Math.round(Math.cos(a) * rr), qy = hy + 2 + Math.round(Math.sin(a) * (rr - 1)) + row * 3;
    if (row === 0 || qy < hy + 14) { b.ellipse(qx, qy, 2, 2, L); b.set(qx + 1, qy + 1, D); b.set(qx - 1, qy - 1, Hh); }
  }
  for (const s of [-1, 1]) for (let k = 0; k < 3; k++) { const qx = hx + s * 15, qy = hy + 8 + k * 5; b.ellipse(qx, qy, 3, 2, L); b.set(qx, qy + 1, D); }
  b.ellipse(hx + dir * 2, hy + 4, 11, 10, L);
  b.hline(hx + dir * 2 - 8, hx + dir * 2 + 8, hy - 2, D); b.hline(hx + dir * 2 - 7, hx + dir * 2 + 7, hy - 3, Hh);
  b.rect(hx + dir * 2 - 6, hy, 3, 3, C.BLACK); b.rect(hx + dir * 2 + 3, hy, 3, 3, C.BLACK); b.set(hx + dir * 2 - 6, hy, Hh); b.set(hx + dir * 2 + 3, hy, Hh);
  b.ellipse(hx + dir * 2, hy + 6, 4, 3, M); b.hline(hx + dir * 2 - 2, hx + dir * 2 + 2, hy + 5, Hh);
  b.rect(hx + dir * 2 - 6, hy + 10, 13, 4, D); b.hline(hx + dir * 2 - 5, hx + dir * 2 + 5, hy + 10, Hh); b.set(hx + dir * 2 - 5, hy + 13, Hh); b.set(hx + dir * 2 + 5, hy + 13, Hh);
}

/** 华表: carved marble column with a cloud plate, a round cap and a crouching beast, inside a little balustrade */
function huabiao(b, cx, by) {
  const top = by - 186;
  shade(b, [[cx - 4, by - 2], [cx + 10, by - 12], [cx + 74, by + 26], [cx + 60, by + 34]], DARK, 2);
  // the railing square around the base, seen from above
  const rx = 34, ry = 16;
  b.rect(cx - rx, by - ry - 4, 2 * rx, 2 * ry + 4, C.PAPER); b.rect(cx - rx + 4, by - ry, 2 * rx - 8, 2 * ry - 4, C.JADE);
  for (const [x, y] of [[cx - rx, by - ry - 4], [cx + rx - 5, by - ry - 4], [cx - rx, by + ry - 6], [cx + rx - 5, by + ry - 6], [cx - 2, by + ry - 6]]) { b.rect(x, y - 6, 5, 10, C.JADE); b.ellipse(x + 2, y - 7, 3, 3, C.PAPER); b.vline(x + 4, y - 6, y + 3, C.STONE_L); }
  b.hline(cx - rx, cx + rx - 1, by + ry, C.STONE); b.vline(cx + rx - 1, by - ry - 4, by + ry, C.STONE);
  // octagonal base
  b.rect(cx - 16, by - 10, 32, 12, C.STONE_L); b.hline(cx - 16, cx + 15, by - 10, C.JADE); b.hline(cx - 16, cx + 15, by + 1, C.STONE); b.vline(cx + 15, by - 10, by + 1, C.STONE);
  // shaft with a dragon coiling up
  b.rect(cx - 9, top + 30, 18, by - 10 - top - 30, C.JADE);
  b.vline(cx - 9, top + 30, by - 11, C.PAPER); b.vline(cx + 5, top + 30, by - 11, C.STONE_L); b.vline(cx + 8, top + 30, by - 11, C.STONE);
  for (let y = top + 40; y < by - 16; y += 2) { const dx = Math.round(Math.sin((y - top) / 9) * 6); b.set(cx + dx, y, C.STONE_L); b.set(cx + dx + 1, y + 1, C.STONE); if (y % 14 === 0) b.set(cx + dx - 2, y, C.STONE); }
  // cloud plate (云板) crossing the shaft
  const cy = top + 50;
  b.poly([[cx - 26, cy - 4], [cx - 8, cy - 8], [cx + 8, cy - 8], [cx + 28, cy - 2], [cx + 24, cy + 4], [cx - 22, cy + 2]], C.PAPER);
  b.line(cx - 26, cy - 4, cx - 8, cy - 8, C.JADE); b.line(cx + 24, cy + 4, cx - 22, cy + 2, C.STONE);
  for (const dx of [-18, -6, 10, 20]) b.ellipse(cx + dx, cy - 1, 3, 2, C.STONE_L);
  // round cap (承露盘) and the crouching 犼 on top
  b.ellipse(cx, top + 28, 14, 5, C.STONE_L); b.ellipse(cx, top + 26, 13, 4, C.JADE); b.hline(cx - 13, cx + 13, top + 31, C.STONE);
  b.ellipse(cx, top + 18, 8, 7, C.STONE_L); b.ellipse(cx - 1, top + 17, 6, 5, C.JADE);
  b.ellipse(cx + 4, top + 10, 5, 5, C.STONE_L); b.set(cx + 6, top + 9, C.STONE_D); b.set(cx + 3, top + 6, C.JADE); b.line(cx - 6, top + 16, cx - 9, top + 9, C.STONE);
}

function noticeBoard(b) {
  const { x, y, w, h } = BOARD;
  const fx0 = x - 14, fx1 = x + w + 14, py = 604;
  shade(b, [[fx1, y - 30], [fx1 + 16, y - 20], [fx1 + 22, py + 6], [fx0 + 20, py + 8], [fx0 + 12, py]], DARK, 2);
  // posts on stone blocks
  for (const px of [fx0 + 2, fx1 - 10]) { b.rect(px - 3, py - 8, 14, 10, C.STONE_L); b.hline(px - 3, px + 10, py - 8, C.JADE); b.hline(px - 3, px + 10, py + 1, C.STONE); b.rect(px, y - 22, 8, py - 8 - (y - 22), C.DBROWN); b.vline(px, y - 22, py - 9, C.BROWN); }
  // the board: lacquered frame, paper area for the headlines
  b.rect(fx0 + 4, y - 12, fx1 - fx0 - 8, h + 26, C.RED_D);
  b.rect(fx0 + 6, y - 10, fx1 - fx0 - 12, h + 22, C.RED_M); b.hline(fx0 + 6, fx1 - 7, y - 10, C.RED);
  b.rect(x - 2, y - 2, w + 4, h + 4, C.DBROWN);
  b.rect(x, y, w, h, C.PAPER);
  b.hline(x, x + w - 1, y, C.JADE); b.vline(x + w - 1, y, y + h - 1, C.PLASTER_S); b.hline(x, x + w - 1, y + h - 1, C.PLASTER_S);
  // edges of older sheets pasted over each other, a red seal on one
  for (const [sx, sy, sw, sh] of [[x + 6, y + 6, 58, 78], [x + 70, y + 4, 56, 82], [x + 132, y + 8, 54, 76]]) { frame(b, sx, sy, sw, sh, C.PLASTER_S); b.hline(sx, sx + sw - 1, sy, C.JADE); }
  b.rect(x + 172, y + 66, 8, 8, C.RED); b.set(x + 173, y + 67, C.RED_L);
  for (const [cx, cy] of [[x + 4, y + 3], [x + w - 5, y + 3], [x + 4, y + h - 4], [x + w - 5, y + h - 4]]) b.set(cx, cy, C.BRONZE);
  // a little tiled roof keeps the rain off
  const ry = y - 14;
  for (let yy = ry - 22; yy < ry; yy++) { const t = (yy - (ry - 22)) / 22, half = Math.round((fx1 - fx0) / 2 + 4 + t * 12), mid = (fx0 + fx1) / 2; for (let xx = mid - half; xx <= mid + half; xx++) { const k = (xx + 400) % 8; b.set(xx, yy, k === 0 ? C.TILE_L : k < 5 ? C.TILE : C.TILE_D); } }
  b.rect(fx0 - 12, ry - 26, fx1 - fx0 + 24, 5, C.TILE_D); b.hline(fx0 - 12, fx1 + 11, ry - 26, C.TILE_L);
  for (let xx = fx0 - 14; xx < fx1 + 16; xx += 8) { b.ellipse(xx + 2, ry, 2, 2, C.TILE_L); b.set(xx + 2, ry, C.TILE_D); }
  b.hline(fx0 - 14, fx1 + 15, ry + 2, C.DEEP);
}

function drum(b) {
  const { x, y, r } = DRUM, fx0 = x - r - 26, fx1 = x + r + 26, py = 604;
  shade(b, [[fx1, y - 64], [fx1 + 16, y - 52], [fx1 + 22, py + 6], [fx0 + 22, py + 8], [fx0 + 12, py]], DARK, 2);
  // frame: two posts, cross beam, a little roof
  for (const px of [fx0, fx1 - 10]) { b.rect(px - 3, py - 8, 16, 10, C.STONE_L); b.hline(px - 3, px + 12, py - 8, C.JADE); b.hline(px - 3, px + 12, py + 1, C.STONE); b.rect(px, y - 70, 10, py - 8 - (y - 70), C.RED_M); b.vline(px, y - 70, py - 9, C.RED); b.vline(px + 9, y - 70, py - 9, C.RED_D); }
  b.rect(fx0 - 6, y - 72, fx1 - fx0 + 12, 10, C.RED_M); b.hline(fx0 - 6, fx1 + 5, y - 72, C.RED); b.hline(fx0 - 6, fx1 + 5, y - 63, C.RED_D);
  for (let xx = fx0; xx < fx1; xx += 14) b.rect(xx, y - 70, 8, 6, C.GRN);
  const ry = y - 74;
  for (let yy = ry - 20; yy < ry; yy++) { const t = (yy - (ry - 20)) / 20, half = Math.round((fx1 - fx0) / 2 + 6 + t * 12), mid = (fx0 + fx1) / 2; for (let xx = mid - half; xx <= mid + half; xx++) { const k = (xx + 400) % 8; b.set(xx, yy, k === 0 ? C.GOLD_L : k < 5 ? C.GOLD : C.GOLD_D); } }
  b.rect(fx0 - 4, ry - 24, fx1 - fx0 + 8, 5, C.GOLD_D); b.hline(fx0 - 4, fx1 + 3, ry - 24, C.GOLD_L);
  for (let xx = fx0 - 16; xx < fx1 + 18; xx += 8) { b.ellipse(xx + 2, ry, 2, 2, C.GOLD); b.set(xx + 2, ry, C.GOLD_D); }
  b.hline(fx0 - 16, fx1 + 17, ry + 2, C.DEEP);
  // the drum hangs from the beam on two rings: the barrel's top shows above its skin
  for (const dx of [-r + 10, r - 10]) { b.vline(x + dx, y - 62, y - r - 6, C.BLACK); b.ellipse(x + dx, y - r - 6, 3, 2, C.GOLD_D); }
  b.ellipse(x + 4, y - 4, r + 3, r + 4, C.RED_D);
  b.ellipse(x, y - 9, r + 1, r, C.RED);
  b.ellipse(x - 6, y - 14, r - 10, r - 12, C.RED_L); b.ellipse(x - 2, y - 10, r - 6, r - 8, C.RED);
  for (let a = 0; a < 26; a++) { const t = Math.PI + (a / 25) * Math.PI; b.set(x + Math.round(Math.cos(t) * (r - 2)), y - 9 + Math.round(Math.sin(t) * (r - 3)), C.GOLD); }
  for (let a = 0; a < 26; a++) { const t = Math.PI * 1.08 + (a / 25) * Math.PI * 0.84; b.set(x + Math.round(Math.cos(t) * (r - 9)), y - 9 + Math.round(Math.sin(t) * (r - 10)), C.GOLD_D); }
  // the skin (face toward us), with its rim of gilt nails
  b.ellipse(x, y + 2, r - 2, r - 6, C.RED_M);
  b.ellipse(x, y + 2, r - 6, r - 10, C.PLASTER_S);
  b.ellipse(x - 3, y, r - 10, r - 14, C.PAPER);
  b.ellipse(x - 7, y - 5, r - 22, r - 26, C.JADE);
  for (let a = 0; a < 28; a++) b.set(x + Math.round(Math.cos(a * 0.2244) * (r - 4)), y + 2 + Math.round(Math.sin(a * 0.2244) * (r - 8)), C.GOLD);
  b.ellipse(x + 8, y + 10, 6, 4, C.PLASTER_S);
  // the drumsticks resting on the post
  b.line(fx1 - 14, y + 20, fx1 + 2, y - 10, C.WOOD); b.line(fx1 - 12, y + 22, fx1 + 4, y - 8, C.BROWN); b.ellipse(fx1 + 3, y - 11, 3, 3, C.RED);
  b.line(fx1 - 10, y + 26, fx1 + 8, y - 2, C.WOOD); b.ellipse(fx1 + 9, y - 3, 3, 3, C.RED);
}
