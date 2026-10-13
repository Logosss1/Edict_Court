// 太和殿广场 — the great paved court in front of 太和殿, top-down (3/4). Officials line up here before morning court.
import { Bitmap, C, W, H, dith, frame, shade, DARK, crane, glazedRoof, bracketBand, hallFront, marbleRail, marbleRailV, pavingTD } from './common.mjs';

// terrace tiers 三台 (pixels): x0..x1, front face from fy (height fh)
const TIERS = [
  { x0: 116, x1: 1164, fy: 312, fh: 22 },
  { x0: 160, x1: 1120, fy: 270, fh: 20 },
  { x0: 204, x1: 1076, fy: 226, fh: 22 },
];
const STAIR = { x0: 560, x1: 720, top: 226, bot: 334 };
const PATH = { x0: 576, x1: 704 };
const MARK_X = { west: [400, 504], east: [776, 880] };
const MARK_Y = [392, 448, 504, 560, 616, 672];

export function guangchang() {
  const b = new Bitmap(W, H);
  // ── 1. the square: big grey bricks ──
  pavingTD(b, 0, 0, W, H, { seed: 11, bw: 48, bh: 24 });

  // ── 2. the three white-marble terraces, lowest first; each casts a soft shadow to the lower right ──
  for (const [i, t] of TIERS.entries()) {
    const s = 14 - i * 2;
    shade(b, [[t.x1, 0], [t.x1 + s, 0], [t.x1 + s, t.fy + t.fh + s - 6], [t.x0 + s, t.fy + t.fh + s - 6], [t.x0 + s - 6, t.fy + t.fh], [t.x1, t.fy + t.fh]], DARK, 2);
    tier(b, t, i);
  }

  // the whole terrace grounds itself with a shadow along its foot, falling to the lower right
  shade(b, [[TIERS[0].x0 + 4, 334], [TIERS[0].x1, 334], [TIERS[0].x1 + 16, 350], [TIERS[0].x0 + 20, 350]], DARK, 2);

  // ── 3. 太和殿: eleven-bay front, bracket band, lower eave of the double hip roof ──
  const HX0 = 280, HX1 = 1000, HY0 = 76, HY1 = 156;
  // the hall's own base (台明) on the top terrace
  b.rect(258, HY1, 764, 8, C.STONE_L); b.hline(258, 1021, HY1, C.JADE); b.hline(258, 1021, HY1 + 7, C.STONE); b.vline(1021, HY1, HY1 + 7, C.STONE);
  dith(b, 258, HY1 + 8, 770, 3, C.PLASTER_S, 2);
  hallFront(b, HX0, HX1, HY0, HY1, 11, { doors: [2, 8], colW: 10 });
  shade(b, [[HX0, HY0], [HX1, HY0], [HX1, HY0 + 14], [HX0, HY0 + 22]], DARK, 2); // eave shadow on the front
  bracketBand(b, 244, 1036, 62, 14, 24);
  glazedRoof(b, 236, 1044, 58, 0, { lift: 12, hipK: 0.95 });
  // the upper storey of the double roof: where the lower roof meets it (围脊), its brackets, the upper eave
  {
    const x0 = 300, x1 = 980;
    b.rect(x0 - 10, 20, x1 - x0 + 20, 6, C.GOLD_D); b.hline(x0 - 10, x1 + 9, 20, C.GOLD_L); b.hline(x0 - 10, x1 + 9, 21, C.GOLD); b.hline(x0 - 10, x1 + 9, 25, C.BROWN);
    bracketBand(b, x0, x1, 6, 14, 20);
    b.rect(x0 - 24, 0, x1 - x0 + 48, 6, C.DEEP);
    for (let x = x0 - 22; x < x1 + 22; x += 10) { b.ellipse(x + 2, 1, 3, 3, C.GOLD); b.set(x + 1, 0, C.GOLD_L); b.hline(x, x + 4, 4, C.GOLD_D); }
    for (let x = x0 - 22; x < x1 + 22; x += 5) b.rect(x, 5, 2, 2, (x / 5) % 2 < 1 ? C.GRN : C.BLU);
    shade(b, [[x0 - 10, 26], [x1 + 10, 26], [x1 + 18, 34], [x0 - 2, 34]], DARK, 2);
  }
  // blank vertical name board hanging under the upper eave (the game writes names elsewhere)
  {
    const x = 620, y = 8, w = 40, h = 44;
    shade(b, [[x + w + 4, y + 6], [x + w + 10, y + 12], [x + w + 10, y + h + 10], [x + 6, y + h + 10], [x, y + h + 4], [x + w + 4, y + h + 4]], DARK, 2);
    b.rect(x - 5, y - 4, w + 10, h + 8, C.GOLD_D); b.rect(x - 4, y - 3, w + 8, h + 6, C.GOLD); b.hline(x - 4, x + w + 3, y - 3, C.GOLD_L); b.vline(x - 4, y - 3, y + h + 2, C.GOLD_L);
    for (let k = 0; k < 5; k++) { b.set(x - 2, y + 4 + k * 9, C.GOLD_D); b.set(x + w + 1, y + 6 + k * 9, C.GOLD_D); }
    for (let k = 0; k < 4; k++) { b.set(x + 6 + k * 10, y - 1, C.GOLD_D); b.set(x + 4 + k * 10, y + h + 1, C.GOLD_D); }
    b.rect(x, y, w, h, C.BLU_D); b.hline(x, x + w - 1, y, C.BLU); b.vline(x, y, y + h - 1, C.BLU);
  }

  // ── 4. the central stairs with the carved cloud-and-dragon slab (御路) ──
  {
    const { x0, x1, top, bot } = STAIR;
    shade(b, [[x1, top], [x1 + 10, top + 8], [x1 + 10, bot + 8], [x1, bot]], DARK, 2);
    for (let y = top, k = 0; y < bot; y += 6, k++) {
      b.rect(x0, y, x1 - x0, 6, C.JADE); b.hline(x0, x1 - 1, y + 4, C.STONE_L); b.hline(x0, x1 - 1, y + 5, C.STONE);
    }
    const sx0 = 610, sx1 = 670;
    b.rect(sx0, top - 2, sx1 - sx0, bot - top + 2, C.STONE_L); frame(b, sx0, top - 2, sx1 - sx0, bot - top + 2, C.STONE);
    b.vline(sx0 + 1, top - 1, bot - 2, C.JADE);
    for (let y = top + 8; y < bot - 6; y += 14) {
      const cx = 640 + (((y - top) / 14) % 2 < 1 ? -6 : 6);
      b.ellipse(cx, y, 14, 5, C.PLASTER_S); b.ellipse(cx - 2, y - 1, 9, 3, C.JADE); b.ellipse(cx + 6, y + 2, 4, 2, C.STONE_L);
      b.set(cx - 9, y + 2, C.STONE); b.set(cx + 10, y - 2, C.STONE);
    }
    for (let k = 0; k < 7; k++) { const y = top + 10 + k * 15, x = 626 + Math.round(Math.sin(k * 1.3) * 10); b.line(x, y, x + 12, y + 8, C.STONE); b.set(x + 1, y, C.GOLD_D); }
    marbleRailV(b, x0 - 4, top - 4, bot - 4, 22);
    marbleRailV(b, x1 + 3, top - 4, bot - 4, 22);
    // 抱鼓石 drum stones at the foot of the rails
    for (const x of [x0 - 4, x1 + 3]) { b.ellipse(x, bot - 2, 6, 5, C.JADE); b.ellipse(x + 1, bot - 1, 4, 3, C.STONE_L); b.set(x - 2, bot - 4, C.JADE); }
  }

  // ── 5. on the top terrace: 嘉量 (west), 日晷 (east), bronze cranes and turtles, tripod censers ──
  const SUN = { x: 968, y: 172, rx: 24, ry: 20 };
  jialiang(b, 312, 220);
  turtle(b, 410, 214, 1);
  turtle(b, 870, 214, -1);
  for (const [x, f] of [[492, -1], [788, 1]]) {
    shade(b, [[x - 6, 212], [x + 10, 210], [x + 22, 222], [x + 4, 224]], DARK, 2);
    b.rect(x - 12, 206, 24, 8, C.STONE_L); b.hline(x - 12, x + 11, 206, C.JADE); b.hline(x - 12, x + 11, 213, C.STONE);
    crane(b, x, 207, f);
  }
  sundial(b, SUN);
  for (const x of [236, 1044]) ding(b, x, 222);
  for (const x of [190, 1090]) ding(b, x, 266);
  for (const x of [146, 1134]) ding(b, x, 308);

  // ── 6. the stone bases of the east and west galleries just inside the frame edges ──
  for (const s of [1, -1]) {
    const x = s > 0 ? 0 : W - 30;
    if (s > 0) shade(b, [[30, 0], [44, 0], [44, H], [30, H]], DARK, 2);
    b.rect(x, 0, 30, H, C.STONE_L);
    b.rect(s > 0 ? x : x + 18, 0, 12, H, C.DEEP);
    for (let y = 20; y < H; y += 60) { const cx = s > 0 ? x + 2 : x + 20; b.rect(cx, y, 8, 34, C.RED_M); b.vline(cx + (s > 0 ? 7 : 0), y, y + 33, C.RED_D); b.vline(cx + (s > 0 ? 0 : 7), y, y + 33, C.RED); b.ellipse(cx + 4, y + 35, 6, 2, C.STONE); }
    const ex = s > 0 ? x + 29 : x;
    b.vline(ex, 0, H - 1, s > 0 ? C.STONE : C.JADE); b.vline(ex + (s > 0 ? -1 : 1), 0, H - 1, s > 0 ? C.STONE_L : C.PAPER);
    for (let y = 0; y < H; y += 40) b.hline(s > 0 ? x + 12 : x, s > 0 ? x + 29 : x + 17, y, C.PLASTER_S);
    // little flights of steps down to the court
    for (const sy of [200, 520]) {
      const sx = s > 0 ? x + 30 : x - 14;
      if (s > 0) shade(b, [[sx + 14, sy], [sx + 22, sy + 6], [sx + 22, sy + 60], [sx + 14, sy + 54]], DARK, 2);
      for (let k = 0; k < 3; k++) { const w = 14 - k * 4; b.rect(s > 0 ? sx : sx + 14 - w, sy, w, 54, k % 2 ? C.JADE : C.STONE_L); b.vline(s > 0 ? sx + w - 1 : sx + 14 - w, sy, sy + 53, C.STONE); }
      b.hline(sx, sx + 13, sy, C.STONE); b.hline(sx, sx + 13, sy + 53, C.STONE_D);
    }
  }

  // the side gates (中左门 / 中右门) in the far corners, leading north past the terrace
  for (const s of [1, -1]) cornerGate(b, s);

  // ── 7. the raised imperial path, rank markers, water vats ──
  {
    const { x0, x1 } = PATH, y0 = STAIR.bot;
    shade(b, [[x1, y0], [x1 + 4, y0 + 4], [x1 + 4, H], [x1, H]], DARK, 1);
    b.rect(x0, y0, x1 - x0, H - y0, C.STONE_L);
    for (let y = y0 + 2, k = 0; y < H; y += 26, k++) {
      b.hline(x0 + 16, x1 - 17, y, C.STONE); b.hline(x0 + 16, x1 - 17, y + 1, C.JADE);
      if (k % 2) b.vline(640, y, y + 25, C.STONE);
    }
    for (const [a, z] of [[x0, x0 + 15], [x1 - 16, x1 - 1]]) {
      b.rect(a, y0, z - a + 1, H - y0, C.PLASTER_S);
      for (let y = y0 + 12; y < H; y += 32) b.hline(a, z, y, C.STONE);
      b.vline(z, y0, H - 1, C.STONE);
    }
    b.vline(x0, y0, H - 1, C.JADE); b.vline(x1 - 1, y0, H - 1, C.STONE_D);
    dith(b, x0 + 16, y0, x1 - x0 - 32, H - y0, C.PLASTER_S, 11, 3);
  }
  for (const side of ['west', 'east']) for (const x of MARK_X[side]) for (const y of MARK_Y) rankMark(b, x, y);
  for (const [x, y, g] of [[118, 420, 1], [1162, 420, 1], [118, 650, 0], [1162, 650, 0]]) vat(b, x, y, g);

  // ── 8. the north edge of the 太和门 terrace along the bottom, open where the path leaves ──
  {
    const y = 704;
    b.rect(0, y, W, H - y, C.JADE);
    for (let x = 0; x < W; x += 40) b.vline(x, y + 1, H - 1, C.PLASTER_S);
    b.hline(0, W - 1, y, C.STONE_L);
    for (const [a, z] of [[70, STAIR.x0 - 10], [STAIR.x1 + 10, W - 70]]) marbleRail(b, a, z, y + 2, 26);
    for (let k = 0; k < 3; k++) { b.hline(STAIR.x0 - 6, STAIR.x1 + 5, y + 4 + k * 5, C.STONE_L); b.hline(STAIR.x0 - 6, STAIR.x1 + 5, y + 5 + k * 5, C.PLASTER_S); }
    for (const x of [STAIR.x0 - 10, STAIR.x1 + 10]) { b.ellipse(x, y - 2, 7, 6, C.JADE); b.ellipse(x + 1, y - 1, 5, 4, C.STONE_L); b.set(x - 2, y - 5, C.PAPER); }
  }

  const spots = {
    walk: [
      { x0: 30, x1: 610, y0: 172, y1: 352 }, // the square
      { x0: 282, x1: 358, y0: 82, y1: 172 }, // the central stairs
      { x0: 112, x1: 528, y0: 84, y1: 108 }, // the top terrace in front of the hall
    ],
    doors: { taihe: [298, 70, 44, 14], chengtian: [282, 350, 76, 10] },
    emperorStart: [320, 300],
    plaque: [320, 15], // the blank board under the eaves; the game writes the name on it
    title: [320, 346],
    birds: true,
    sundial: [SUN.x / 2, SUN.y / 2, 11],
    // 文东武西: civil officials east of the path, military west, each beside a rank marker, facing north to the hall
    ranks: {
      east: [[405, 226], [457, 226], [405, 282], [457, 282], [405, 338], [457, 338]],
      west: [[235, 226], [183, 226], [235, 282], [183, 282], [235, 338]],
    },
    guards: [[258, 176], [382, 176], [272, 106], [368, 106]],
    npcs: [
      { kind: 'eunuch', x: 96, y: 300, facing: 'right', act: 'sweep', route: [[80, 300], [150, 300], [150, 318], [80, 318]] },
      { kind: 'guard', x: 548, y: 250, facing: 'front', act: 'patrol', route: [[548, 196], [548, 330]] },
      { kind: 'eunuch', x: 200, y: 92, facing: 'right', act: 'tray', route: [[150, 92], [270, 92]] },
    ],
  };
  return { bg: b, spots };
}

/** one tier of the marble terrace: slab surface reaching up off the frame, carved front face, balustrades */
function tier(b, t, i) {
  const { x0, x1, fy, fh } = t;
  b.rect(x0, 0, x1 - x0, fy, C.JADE);
  for (let y = fy - 2; y > 0; y -= 22) { b.hline(x0 + 2, x1 - 3, y, C.PLASTER_S); }
  for (let y = fy - 2, row = 0; y > 0; y -= 22, row++) for (let x = x0 + (row % 2) * 30; x < x1; x += 60) b.vline(x, Math.max(0, y - 21), y, C.PLASTER_S);
  // the front face: a 须弥座 profile (lip, upper band, recessed waist with carved panels, lower band) with dragon-head spouts
  b.rect(x0, fy, x1 - x0, fh, C.STONE_L);
  b.hline(x0, x1 - 1, fy, C.JADE); b.hline(x0, x1 - 1, fy + 1, C.PAPER); b.hline(x0, x1 - 1, fy + 2, C.STONE);
  const wy = fy + 6, wh = fh - 12;
  b.rect(x0, wy, x1 - x0, wh, C.STONE); b.hline(x0, x1 - 1, wy, C.STONE_D);
  for (let x = x0 + 10; x < x1 - 30; x += 40) { b.rect(x, wy + 2, 30, wh - 3, C.STONE_L); b.hline(x, x + 29, wy + 2, C.PLASTER_S); b.ellipse(x + 15, wy + 1 + Math.ceil(wh / 2), 6, 1, C.PAPER); }
  b.hline(x0, x1 - 1, wy + wh, C.PLASTER_S); b.hline(x0, x1 - 1, fy + fh - 2, C.STONE); b.hline(x0, x1 - 1, fy + fh - 1, C.STONE_D);
  b.vline(x0, fy, fy + fh - 1, C.JADE); b.vline(x1 - 1, 0, fy + fh - 1, C.STONE);
  for (let x = x0 + 4; x <= x1 - 4; x += 26) {
    if (x > STAIR.x0 - 12 && x < STAIR.x1 + 12) continue;
    b.rect(x - 2, fy + 2, 6, 5, C.JADE); b.rect(x - 1, fy + 6, 4, 2, C.STONE_L); b.set(x, fy + 7, C.DEEP); b.set(x + 3, fy + 3, C.STONE); b.set(x + 4, fy + 8, C.STONE_D);
  }
  // balustrades: along the front (broken by the stairs) and back along both ends
  marbleRail(b, x0 + 4, STAIR.x0 - 8, fy, 26);
  marbleRail(b, STAIR.x1 + 8, x1 - 4, fy, 26);
  marbleRailV(b, x0 + 5, -8, fy - 14, 26);
  marbleRailV(b, x1 - 6, -8, fy - 14, 26);
}

/** 品级山: a small bronze rank marker */
function rankMark(b, x, y) {
  shade(b, [[x + 1, y - 4], [x + 8, y - 6], [x + 16, y + 4], [x + 6, y + 6]], DARK, 2);
  b.ellipse(x, y - 1, 8, 3, C.STONE_L); b.hline(x - 7, x + 7, y + 1, C.STONE);
  b.poly([[x - 6, y - 2], [x + 6, y - 2], [x + 4, y - 12], [x + 1, y - 18], [x - 1, y - 18], [x - 4, y - 12]], C.BRONZE);
  b.line(x - 6, y - 2, x - 1, y - 18, C.GOLD); b.line(x - 5, y - 2, x - 3, y - 12, C.GOLD);
  b.line(x + 6, y - 2, x + 1, y - 18, C.BROWN); b.vline(x + 5, y - 6, y - 2, C.BROWN);
  b.rect(x - 2, y - 11, 4, 6, C.GOLD_D); b.set(x - 1, y - 10, C.GOLD);
  b.hline(x - 6, x + 6, y - 2, C.DBROWN);
}

/** 吉祥缸: big water vat (gilt or bronze) on a stone stand */
function vat(b, cx, by, gilt) {
  const r = 30, top = by - 44;
  const [lo, mid, hi, dk] = gilt ? [C.GOLD_D, C.GOLD, C.GOLD_L, C.BRONZE] : [C.BROWN, C.BRONZE, C.GOLD, C.DBROWN];
  shade(b, [[cx - 10, by], [cx + r, by - 30], [cx + r + 24, by - 10], [cx + r + 20, by + 16], [cx, by + 14]], DARK, 2);
  b.rect(cx - r + 2, by - 8, 2 * r - 4, 10, C.STONE); b.hline(cx - r + 2, cx + r - 3, by - 8, C.STONE_L); b.hline(cx - r + 2, cx + r - 3, by + 1, C.STONE_D);
  for (const dx of [-r + 6, r - 10]) b.rect(cx + dx, by - 12, 5, 6, C.STONE_D);
  b.ellipse(cx, by - 26, r, 18, dk);
  b.ellipse(cx - 1, by - 27, r - 2, 16, mid);
  b.ellipse(cx - 9, by - 30, 10, 10, hi); b.ellipse(cx - 6, by - 28, 10, 10, mid);
  for (let y = by - 40; y < by - 12; y++) { const w = Math.round(Math.sqrt(Math.max(0, 1 - ((y - (by - 27)) / 18) ** 2)) * (r - 2)); b.set(cx + w - 1, y, lo); b.set(cx + w - 2, y, lo); }
  b.hline(cx - r + 4, cx + r - 5, by - 22, lo);
  // lion-mask ring handles
  for (const s of [-1, 1]) { const hx = cx + s * (r - 2); b.ellipse(hx, by - 30, 4, 4, lo); b.ellipse(hx, by - 30, 2, 2, mid); b.set(hx - 1, by - 32, hi); }
  // rim and the water inside
  b.ellipse(cx, top, r, 9, lo); b.ellipse(cx, top - 1, r - 1, 8, hi); b.ellipse(cx, top, r - 4, 6, C.BLU_D); b.ellipse(cx + 1, top + 1, r - 7, 4, C.TEAL);
  b.hline(cx - 8, cx - 2, top - 2, C.SKY); b.set(cx + 6, top + 2, C.SKY);
}

/** 嘉量: the bronze standard measure in its small stone pavilion */
function jialiang(b, cx, by) {
  shade(b, [[cx + 22, by - 30], [cx + 36, by - 24], [cx + 40, by + 6], [cx - 16, by + 6], [cx - 20, by]], DARK, 2);
  // pedestal (须弥座)
  b.rect(cx - 24, by - 10, 48, 10, C.STONE_L); b.hline(cx - 24, cx + 23, by - 10, C.JADE); b.hline(cx - 24, cx + 23, by - 1, C.STONE); b.rect(cx - 20, by - 7, 40, 3, C.PAPER);
  // pavilion body with an arched opening showing the vessel
  b.rect(cx - 18, by - 40, 36, 30, C.JADE); b.vline(cx + 17, by - 40, by - 11, C.STONE_L); b.vline(cx - 18, by - 40, by - 11, C.PAPER);
  b.rect(cx - 9, by - 32, 18, 20, C.DEEP); b.ellipse(cx, by - 32, 9, 5, C.DEEP);
  b.rect(cx - 6, by - 26, 12, 12, C.BRONZE); b.vline(cx - 6, by - 26, by - 15, C.GOLD); b.ellipse(cx, by - 26, 6, 2, C.GOLD_D); b.hline(cx - 6, cx + 5, by - 20, C.GOLD_D);
  // pyramid roof seen from above
  b.poly([[cx - 24, by - 40], [cx + 24, by - 40], [cx + 6, by - 58], [cx - 6, by - 58]], C.STONE_L);
  b.poly([[cx - 24, by - 40], [cx - 6, by - 58], [cx - 2, by - 58], [cx - 16, by - 40]], C.JADE);
  b.line(cx - 24, by - 40, cx - 6, by - 58, C.PAPER); b.line(cx + 24, by - 40, cx + 6, by - 58, C.STONE);
  b.hline(cx - 26, cx + 25, by - 40, C.STONE); b.hline(cx - 26, cx + 25, by - 39, C.STONE_D);
  b.ellipse(cx, by - 60, 4, 3, C.JADE); b.set(cx + 2, by - 59, C.STONE);
}

/** 日晷: tilted stone dial on a marble pedestal; the game draws the gnomon's shadow */
function sundial(b, s) {
  const { x, y, rx, ry } = s, by = 220;
  shade(b, [[x + rx, y - 6], [x + rx + 14, y + 4], [x + rx + 16, by + 6], [x - 10, by + 6], [x - 18, by]], DARK, 2);
  b.rect(x - 26, by - 10, 52, 10, C.STONE_L); b.hline(x - 26, x + 25, by - 10, C.JADE); b.hline(x - 26, x + 25, by - 1, C.STONE); b.rect(x - 22, by - 7, 44, 3, C.PAPER);
  b.rect(x - 10, y + ry - 4, 20, by - 10 - (y + ry - 4), C.STONE_L); b.vline(x - 10, y + ry - 4, by - 11, C.JADE); b.vline(x + 9, y + ry - 4, by - 11, C.STONE);
  b.ellipse(x, y + 3, rx + 2, ry + 2, C.STONE);
  b.ellipse(x, y, rx + 1, ry + 1, C.STONE_L);
  b.ellipse(x - 1, y - 1, rx - 1, ry - 1, C.JADE);
  b.ellipse(x, y, rx - 4, ry - 4, C.PAPER);
  for (let a = 0; a < 24; a++) {
    const px = x + Math.round(Math.cos(a * 0.2618) * (rx - 2)), py = y + Math.round(Math.sin(a * 0.2618) * (ry - 2));
    b.set(px, py, a % 2 ? C.STONE_L : C.STONE);
  }
  b.ellipse(x, y, 2, 2, C.BRONZE); b.set(x - 1, y - 1, C.GOLD);
}

/** bronze turtle (铜龟) with a dragon head, on a low stone base */
function turtle(b, cx, by, f) {
  shade(b, [[cx - 8, by - 4], [cx + 18, by - 12], [cx + 30, by + 2], [cx + 10, by + 8]], DARK, 2);
  b.rect(cx - 18, by - 8, 36, 8, C.STONE_L); b.hline(cx - 18, cx + 17, by - 8, C.JADE); b.hline(cx - 18, cx + 17, by - 1, C.STONE);
  for (const dx of [-12, -4, 4, 10]) { b.rect(cx + dx, by - 12, 4, 5, C.BROWN); b.set(cx + dx, by - 12, C.BRONZE); }
  b.ellipse(cx, by - 15, 15, 7, C.BROWN);
  b.ellipse(cx - 1, by - 17, 13, 7, C.BRONZE);
  b.ellipse(cx - 4, by - 20, 7, 3, C.GOLD); b.set(cx - 7, by - 21, C.GOLD_L); b.set(cx - 6, by - 22, C.GOLD_L);
  for (const [dx, dy] of [[-8, -16], [0, -15], [7, -17], [3, -21]]) { b.set(cx + dx, by + dy, C.GOLD_D); b.set(cx + dx + 1, by + dy, C.GOLD_D); }
  b.hline(cx - 12, cx + 12, by - 11, C.DBROWN);
  // neck and dragon head, raised
  b.line(cx + f * 11, by - 16, cx + f * 15, by - 27, C.BRONZE); b.line(cx + f * 12, by - 15, cx + f * 16, by - 27, C.BRONZE); b.line(cx + f * 13, by - 15, cx + f * 17, by - 26, C.BROWN);
  b.ellipse(cx + f * 17, by - 30, 4, 3, C.BRONZE); b.line(cx + f * 19, by - 30, cx + f * 22, by - 29, C.BRONZE);
  b.set(cx + f * 15, by - 32, C.GOLD); b.set(cx + f * 17, by - 31, C.DEEP); b.line(cx + f * 15, by - 33, cx + f * 13, by - 37, C.GOLD_D);
  b.line(cx - f * 14, by - 14, cx - f * 19, by - 12, C.BROWN);
}

/** small bronze tripod censer (鼎) on the balustrade line */
function ding(b, cx, by) {
  b.ellipse(cx + 5, by + 1, 9, 3, C.STONE);
  for (const dx of [-6, 0, 6]) b.vline(cx + dx, by - 6, by, C.BROWN);
  b.ellipse(cx, by - 10, 9, 6, C.BRONZE); b.ellipse(cx - 3, by - 11, 4, 3, C.GOLD); b.hline(cx - 8, cx + 8, by - 14, C.GOLD_D);
  b.ellipse(cx, by - 15, 8, 2, C.DBROWN);
  for (const dx of [-6, 5]) { b.rect(cx + dx, by - 21, 2, 6, C.BRONZE); b.set(cx + dx, by - 21, C.GOLD); }
}

/** a small gate hall in a far corner of the court: yellow roof, red front with an open passage, steps */
function cornerGate(b, s) {
  const x0 = s > 0 ? -34 : W - 104, x1 = s > 0 ? 104 : W + 34, cx = s > 0 ? 40 : W - 40;
  shade(b, [[x1, 40], [x1 + 14, 52], [x1 + 14, 150], [x0 + 14, 150], [x0, 140], [x1, 140]], DARK, 2);
  // base and steps
  b.rect(x0 + 8, 116, x1 - x0 - 16, 10, C.STONE_L); b.hline(x0 + 8, x1 - 9, 116, C.JADE); b.hline(x0 + 8, x1 - 9, 125, C.STONE);
  for (let k = 0; k < 3; k++) { const y = 126 + k * 5, w = 40 + k * 6; b.rect(cx - w / 2, y, w, 5, k % 2 ? C.STONE_L : C.JADE); b.hline(cx - w / 2, cx + w / 2 - 1, y + 4, C.STONE); }
  hallFront(b, x0 + 14, x1 - 14, 66, 116, 3, { doors: [1, 1], colW: 8 });
  // the open passage in the middle bay
  const bw = (x1 - x0 - 28) / 3, p0 = Math.round(x0 + 14 + bw) + 5, p1 = Math.round(x0 + 14 + 2 * bw) - 5;
  b.rect(p0, 82, p1 - p0, 34, C.DEEP);
  pavingTD(b, p0, 100, p1, 116, { seed: 2, bw: 24, bh: 8 }); dith(b, p0, 100, p1 - p0, 8, C.DEEP, 2);
  for (const lx of [p0, p1 - 6]) { b.rect(lx, 82, 6, 34, C.RED_M); b.vline(lx + (lx === p0 ? 5 : 0), 82, 115, C.RED); for (let y = 86; y < 114; y += 6) b.set(lx + 3, y, C.GOLD); }
  shade(b, [[x0 + 14, 66], [x1 - 14, 66], [x1 - 14, 76], [x0 + 14, 80]], DARK, 2);
  bracketBand(b, x0 + 8, x1 - 8, 54, 12, 18);
  glazedRoof(b, x0, x1, 52, 0, { lift: 8, hipK: 0.9 });
}
