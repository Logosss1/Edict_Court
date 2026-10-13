// 六部院 — the six ministries round one courtyard, top-down (3/4) with the roofs cut away: three offices along the
// top (户部 礼部 兵部), three along the bottom (刑部 工部 吏部), a paved courtyard strip between them.
import { Bitmap, C, rng, W, H, dith, frame, shade, DARK, pavingTD } from './common.mjs';
import { scrollShelf, zhilingWindow, pottedPlant, tree } from '../scenes.mjs';

const COLS = [[16, 420], [436, 844], [860, 1264]];
const ROOMS = [
  { key: 'hubu', row: 0, col: 0 }, { key: 'libu', row: 0, col: 1 }, { key: 'bingbu', row: 0, col: 2 },
  { key: 'xingbu', row: 1, col: 0 }, { key: 'gongbu', row: 1, col: 1 }, { key: 'libu_hr', row: 1, col: 2 },
];
// rows (pixels): top offices: back wall 8..92, floor 92..258, low front wall 258..284; courtyard 284..398;
// bottom offices: back wall (with the doorway) 404..484, floor 484..712
const T = { wall0: 8, floor0: 92, front0: 258, front1: 284, deskTop: 156 };
const Y = { y0: 284, y1: 398 };
const B = { wall0: 404, floor0: 484, floor1: 712, deskTop: 602 };
const DOOR_HW = 34;

export function liubu() {
  const b = new Bitmap(W, H);
  const half = (p) => p.map(([x, y]) => [x / 2, y / 2]);
  b.rect(0, 0, W, H, C.TILE_D);

  // ── 1. the courtyard ──
  pavingTD(b, 0, Y.y0, W, Y.y1, { seed: 5, bw: 40, bh: 20 });
  { // a lighter flagstone walk along the middle
    const y0 = 326, y1 = 358;
    b.rect(0, y0, W, y1 - y0, C.STONE_L);
    for (let x = 0, k = 0; x < W; x += 36, k++) { b.vline(x, y0, y1 - 1, C.STONE); if (k % 2) b.hline(x, x + 35, y0 + 16, C.STONE); }
    b.hline(0, W - 1, y0, C.JADE); b.hline(0, W - 1, y1 - 1, C.STONE);
  }

  // ── 2. floors of the six offices (warm square bricks), back walls, then the cut walls ──
  for (const r of ROOMS) {
    const [x0, x1] = COLS[r.col];
    if (r.row === 0) pavingTD(b, x0, T.floor0, x1, T.front0, { seed: 11 + r.col, bw: 32, bh: 32, base: C.FLOOR, joint: C.FLOOR_D, hi: C.FLOOR_L, alt: [C.FLOOR_L, C.FLOOR_D], odd: 0.12 });
    else pavingTD(b, x0, B.floor0, x1, B.floor1, { seed: 17 + r.col, bw: 32, bh: 32, base: C.FLOOR, joint: C.FLOOR_D, hi: C.FLOOR_L, alt: [C.FLOOR_L, C.FLOOR_D], odd: 0.12 });
  }
  for (const r of ROOMS) backWall(b, r);
  // shadows the walls throw into the rooms (light from the top-left)
  for (const [x0, x1] of COLS) {
    dith(b, x0, T.floor0, x1 - x0, 8, C.FLOOR_D, 2);
    dith(b, x0, B.floor0, x1 - x0, 8, C.FLOOR_D, 2);
    if (x0 > 16) { shade(b, [[x0, T.floor0], [x0 + 12, T.floor0 + 8], [x0 + 12, T.front0], [x0, T.front0]], DARK, 2); shade(b, [[x0, B.floor0], [x0 + 12, B.floor0 + 8], [x0 + 12, B.floor1], [x0, B.floor1]], DARK, 2); }
  }
  shade(b, [[16, Y.y0], [W - 16, Y.y0], [W - 16, Y.y0 + 8], [24, Y.y0 + 8]], DARK, 2);

  // ── 3. the courtyard: west gate, well, an old tree, potted plants ──
  well(b, 760, 380);
  for (const [x, y] of [[300, 312], [534, 312], [976, 312], [1196, 312], [260, 396], [1060, 396]]) { shade(b, [[x + 4, y - 4], [x + 14, y - 8], [x + 26, y + 2], [x + 10, y + 6]], DARK, 2); pottedPlant(b, x, y); }
  stoneBench(b, 420, 392);
  vatSmall(b, 1196, 394);
  { const r = rng(4); for (let k = 0; k < 26; k++) { const x = 790 + Math.floor(r() * 150), y = 300 + Math.floor(r() * 90); if (b.get(x, y) === C.STONE || b.get(x, y) === C.STONE_L) { b.set(x, y, r() < 0.5 ? C.GRN : C.GOLD_D); b.set(x + 1, y, C.GRN_D); } } }

  // ── 4. furniture of each office ──
  const lamps = [], incense = [];
  const rooms = {};
  for (const r of ROOMS) {
    const [x0, x1] = COLS[r.col], cx = (x0 + x1) / 2;
    const top = r.row === 0;
    const deskY = top ? T.deskTop : B.deskTop;
    const clerkX = top ? cx + 120 : cx - 120, clerkY = top ? 238 : 692;
    FURNISH[r.key](b, x0, x1, cx, top, incense);
    lamps.push(desk(b, cx, deskY, r.key));
    stool(b, clerkX, clerkY, top ? -1 : 1);
    const ry0 = top ? 0 : 398, ry1 = top ? T.front1 : 720;
    rooms[r.key] = {
      rect: [x0 / 2, ry0 / 2, (x1 - x0) / 2, (ry1 - ry0) / 2],
      seat: [cx / 2, deskY / 2],
      clerk: [clerkX / 2, clerkY / 2],
      plaque: [cx / 2, top ? 104 : 208.5],
      door: top ? [(cx - DOOR_HW) / 2, T.front0 / 2, DOOR_HW, (T.front1 - T.front0) / 2] : [(cx - DOOR_HW) / 2, 436 / 2, DOOR_HW, (B.floor0 - 436) / 2],
    };
  }

  // ── 5. the cut walls: partitions, the low front walls of the top offices with their door frames ──
  for (const r of ROOMS) if (r.row === 0) frontWall(b, r);
  for (const x of [420, 844]) { vWall(b, x, 0, T.front1); vWall(b, x, 398, H); }
  vWall(b, 0, 0, Y.y0 + 14); vWall(b, 0, Y.y1 - 10, H);
  vWall(b, W - 16, 0, H);
  hCap(b, 0, W, 0, 8);
  hCap(b, 0, W, B.floor1, H - B.floor1);
  westGate(b);
  // the old tree throws its canopy over the wall between 礼部 and 兵部
  shade(b, [[846, 396], [880, 380], [930, 404], [890, 420]], DARK, 2);
  tree(b, 852, 396, 0.9, 12);

  return {
    bg: b,
    spots: {
      walk: [
        { x0: 8, x1: 630, y0: 146, y1: 198 }, // the courtyard
        { x0: 0, x1: 8, y0: 152, y1: 192 }, // west gate
        ...ROOMS.flatMap((r) => {
          const [x0, x1] = COLS[r.col], cx = (x0 + x1) / 2;
          const a = (x0 + 20) / 2, z = (x1 - 20) / 2;
          // top offices: the desk stands between the doorway and the seat, so the way in goes round its ends
          return r.row === 0
            ? [{ x0: a, x1: z, y0: 58, y1: 80 }, { x0: a, x1: a + 40, y0: 78, y1: 102 }, { x0: z - 40, x1: z, y0: 78, y1: 102 }, { x0: a, x1: z, y0: 100, y1: 121 }, { x0: (cx - 26) / 2, x1: (cx + 26) / 2, y0: 120, y1: 147 }]
            : [{ x0: (x0 + 20) / 2, x1: (x1 - 20) / 2, y0: 248, y1: 350 }, { x0: (cx - 24) / 2, x1: (cx + 24) / 2, y0: 197, y1: 249 }];
        }),
      ],
      doors: { chengtian: [0, 150, 12, 44] },
      emperorStart: [72, 170],
      title: [320, 356],
      rooms,
      lamps: half(lamps.flat()),
      incense: half(incense),
      cat: [[150, 176], [300, 190], [520, 168], [600, 186]],
      guards: [[28, 196]],
      npcs: [
        { kind: 'eunuch', x: 200, y: 186, facing: 'right', act: 'sweep', route: [[160, 186], [260, 186], [260, 194], [160, 194]] },
        { kind: 'clerk', x: 120, y: 166, facing: 'right', route: [[110, 166], [320, 166], [530, 166], [320, 166]] },
      ],
    },
  };
}

// ───────────────────────── walls ─────────────────────────
/** the back wall of an office seen face-on: white plaster, red posts, a red dado; the bottom offices' has the doorway */
function backWall(b, r) {
  const [x0, x1] = COLS[r.col], cx = (x0 + x1) / 2;
  const y0 = r.row === 0 ? T.wall0 : B.wall0, y1 = r.row === 0 ? T.floor0 : B.floor0;
  b.rect(x0, y0, x1 - x0, y1 - y0, C.JADE);
  dith(b, x0, y0, x1 - x0, 6, C.PLASTER_S, 2);
  b.rect(x0, y1 - 14, x1 - x0, 14, C.RED_M); b.hline(x0, x1 - 1, y1 - 14, C.RED); b.hline(x0, x1 - 1, y1 - 1, C.RED_D);
  for (const px of [x0, x1 - 10]) { b.rect(px, y0, 10, y1 - y0, C.RED); b.vline(px + 1, y0, y1 - 1, C.RED_L); b.vline(px + 9, y0, y1 - 1, C.RED_D); }
  b.rect(x0, y0, x1 - x0, 5, C.RED_D); b.hline(x0, x1 - 1, y0 + 4, C.RED_M);
  if (r.row === 1) {
    // the doorway through to the courtyard, with the door leaves folded back
    const d0 = cx - DOOR_HW, d1 = cx + DOOR_HW, top = 436;
    b.rect(d0 - 6, top - 6, d1 - d0 + 12, y1 - top + 6, C.RED); b.vline(d0 - 6, top - 6, y1 - 1, C.RED_L); b.vline(d1 + 5, top - 6, y1 - 1, C.RED_D);
    b.rect(d0 - 8, top - 8, d1 - d0 + 16, 4, C.RED_M); b.hline(d0 - 8, d1 + 7, top - 8, C.RED_L);
    pavingTD(b, d0, top, d1, y1, { seed: 3, bw: 40, bh: 20 });
    dith(b, d0, top, d1 - d0, 10, C.STONE_D, 2);
    b.rect(d0, y1 - 6, d1 - d0, 6, C.STONE_L); b.hline(d0, d1 - 1, y1 - 6, C.JADE); b.hline(d0, d1 - 1, y1 - 1, C.STONE);
    for (const lx of [d0, d1 - 7]) { b.rect(lx, top, 7, y1 - top - 6, C.RED_M); b.vline(lx + (lx === d0 ? 6 : 0), top, y1 - 7, C.RED); for (let y = top + 6; y < y1 - 8; y += 8) b.set(lx + 3, y, C.GOLD); }
    plaque(b, cx, 417);
  }
}
/** the low cut front wall of a top office: wall cap, grey brick face, the doorway and its frame with the plaque */
function frontWall(b, r) {
  const [x0, x1] = COLS[r.col], cx = (x0 + x1) / 2, d0 = cx - DOOR_HW, d1 = cx + DOOR_HW;
  for (const [a, z] of [[x0, d0 - 6], [d1 + 6, x1]]) {
    b.rect(a, T.front0 + 8, z - a, T.front1 - T.front0 - 8, C.STONE);
    for (let y = T.front0 + 8; y < T.front1; y += 6) { b.hline(a, z - 1, y, C.STONE_D); for (let x = a + ((y / 6) % 2 < 1 ? 0 : 8); x < z; x += 16) b.vline(x, y, y + 5, C.STONE_D); b.hline(a, z - 1, y + 1, C.STONE_L); }
    hCap(b, a, z, T.front0, 8);
  }
  // the floor runs out through the doorway to a stone threshold
  pavingTD(b, d0 - 6, T.front0, d1 + 6, T.front1 - 8, { seed: 13, bw: 32, bh: 32, base: C.FLOOR, joint: C.FLOOR_D, hi: C.FLOOR_L, odd: 0 });
  b.hline(d0 - 6, d1 + 5, T.front0, C.FLOOR_D);
  b.rect(d0 - 6, T.front1 - 8, d1 - d0 + 12, 8, C.STONE_L); b.hline(d0 - 6, d1 + 5, T.front1 - 8, C.JADE); b.hline(d0 - 6, d1 + 5, T.front1 - 1, C.STONE);
  // door frame rising from the cut wall, lintel and plaque
  shade(b, [[d1 + 6, 230], [d1 + 16, 238], [d1 + 16, T.front1 + 8], [d1 + 6, T.front1]], DARK, 2);
  for (const px of [d0 - 8, d1 + 1]) { b.rect(px, 228, 7, T.front1 - 228, C.RED); b.vline(px, 228, T.front1 - 1, C.RED_L); b.vline(px + 6, 228, T.front1 - 1, C.RED_D); b.rect(px - 2, T.front1 - 6, 11, 6, C.STONE_L); b.hline(px - 2, px + 8, T.front1 - 6, C.JADE); }
  b.rect(d0 - 12, 222, d1 - d0 + 24, 8, C.RED); b.hline(d0 - 12, d1 + 11, 222, C.RED_L); b.hline(d0 - 12, d1 + 11, 229, C.RED_D);
  for (let x = d0 - 8; x < d1 + 8; x += 10) b.rect(x, 224, 5, 4, C.GRN);
  plaque(b, cx, 209);
}
/** blank name board: deep blue with a gilt frame (the game writes the ministry's name on it) */
function plaque(b, cx, cy) {
  const w = 76, h = 24, x = cx - w / 2, y = cy - h / 2;
  b.rect(x - 4, y - 4, w + 8, h + 8, C.GOLD_D); b.rect(x - 3, y - 3, w + 6, h + 6, C.GOLD); b.hline(x - 3, x + w + 2, y - 3, C.GOLD_L); b.vline(x - 3, y - 3, y + h + 2, C.GOLD_L);
  for (const [px, py] of [[x - 2, y - 2], [x + w + 1, y - 2], [x - 2, y + h + 1], [x + w + 1, y + h + 1]]) b.set(px, py, C.GOLD_D);
  b.rect(x, y, w, h, C.BLU_D); b.hline(x, x + w - 1, y, C.BLU); b.vline(x, y, y + h - 1, C.BLU);
}
/** a cut wall running back (partition), seen from above: slate cap with a lit edge */
function vWall(b, x, y0, y1) {
  b.rect(x, y0, 16, y1 - y0, C.TILE_D);
  b.vline(x, y0, y1 - 1, C.TILE_L); b.vline(x + 1, y0, y1 - 1, C.TILE); b.vline(x + 15, y0, y1 - 1, C.BLACK);
  for (let y = y0 + 6; y < y1; y += 12) b.hline(x + 2, x + 14, y, C.TILE);
}
function hCap(b, x0, x1, y, h) {
  b.rect(x0, y, x1 - x0, h, C.TILE_D); b.hline(x0, x1 - 1, y, C.TILE_L); b.hline(x0, x1 - 1, y + 1, C.TILE); if (h > 4) b.hline(x0, x1 - 1, y + h - 1, C.BLACK);
  for (let x = x0 + 6; x < x1; x += 12) b.vline(x, y + 2, y + h - 2, C.TILE);
}
/** the west gate of the courtyard (to 承天门): a gap in the outer wall, gate posts, the leaves swung open */
function westGate(b) {
  const g0 = Y.y0 + 14, g1 = Y.y1 - 10;
  pavingTD(b, 0, g0, 16, g1, { seed: 9, bw: 40, bh: 20 });
  dith(b, 0, g0, 6, g1 - g0, C.STONE_D, 2);
  b.rect(0, g0 + 6, 18, g1 - g0 - 12, C.STONE_L); for (let y = g0 + 14; y < g1 - 6; y += 12) b.hline(0, 17, y, C.STONE); b.vline(17, g0 + 6, g1 - 7, C.STONE); b.vline(0, g0 + 6, g1 - 7, C.STONE_D);
  // leaves standing open into the courtyard, seen from above
  for (const [y, s] of [[g0 + 2, 1], [g1 - 10, -1]]) {
    shade(b, [[18, y + 8], [56, y + 8], [62, y + 14], [24, y + 14]], DARK, 2);
    b.rect(18, y, 38, 8, C.RED); b.hline(18, 55, y, C.RED_L); b.hline(18, 55, y + 7, C.RED_D); b.vline(55, y, y + 7, C.RED_D);
    for (let x = 22; x < 54; x += 6) b.set(x, y + 4, C.GOLD);
    b.rect(14, y - 2, 6, 12, C.RED_M); b.set(14, y - 2, C.RED);
  }
  // the gate posts at the ends of the wall
  for (const y of [g0 - 8, g1 - 2]) { b.rect(0, y, 18, 10, C.RED); b.hline(0, 17, y, C.RED_L); b.hline(0, 17, y + 9, C.RED_D); b.rect(2, y + 2, 4, 6, C.GOLD_D); }
}

// ───────────────────────── shared furniture ─────────────────────────
/** the minister's desk (seen from above, the seat behind it); returns the candle flame point */
function desk(b, cx, top, key) {
  const w = 128, x0 = cx - w / 2, x1 = cx + w / 2, depth = 22, apron = 10;
  shade(b, [[x1, top + 4], [x1 + 12, top + 12], [x1 + 12, top + depth + apron + 14], [x0 + 12, top + depth + apron + 14], [x0 + 4, top + depth + apron + 6], [x1, top + depth + apron + 6]], DARK, 2);
  b.ellipse(cx, top - 4, 34, 7, C.GOLD_D); b.ellipse(cx, top - 5, 32, 5, C.CRIMSON); b.hline(cx - 26, cx + 26, top - 9, C.RED_L);
  for (const lx of [x0 + 4, x1 - 12]) { b.rect(lx, top + depth + apron - 2, 8, 9, C.DBROWN); b.rect(lx - 2, top + depth + apron + 5, 12, 3, C.DBROWN); }
  b.rect(x0, top, w, depth, C.WOOD); b.hline(x0, x1 - 1, top, C.WOOD_L); b.vline(x0, top, top + depth - 1, C.WOOD_L); b.hline(x0, x1 - 1, top + depth - 1, C.DBROWN);
  b.rect(x0, top + depth, w, apron, C.BROWN); b.hline(x0, x1 - 1, top + depth, C.DBROWN); b.hline(x0, x1 - 1, top + depth + apron - 1, C.DBROWN);
  for (let x = x0 + 10; x < x1 - 8; x += 26) b.hline(x, x + 14, top + depth + apron / 2, C.DBROWN);
  // open document in front of the minister; inkstone and brushes at the right
  b.rect(cx - 16, top + 6, 32, 11, C.PAPER); b.vline(cx, top + 6, top + 16, C.PLASTER_S); for (let y = top + 9; y < top + 16; y += 3) { b.hline(cx - 13, cx - 4, y, C.STONE_L); b.hline(cx + 4, cx + 13, y, C.STONE_L); }
  b.rect(x1 - 34, top + 9, 13, 8, C.BLACK); b.rect(x1 - 32, top + 10, 5, 3, C.STONE_D);
  b.rect(x1 - 17, top + 3, 7, 11, C.TEAL); b.hline(x1 - 17, x1 - 11, top + 3, C.SKY); for (let i = 0; i < 3; i++) b.vline(x1 - 16 + i * 2, top - 5, top + 2, i === 1 ? C.WOOD : C.BROWN);
  const lx = x1 - 46;
  b.ellipse(lx, top + 12, 5, 2, C.BRONZE); b.rect(lx - 1, top - 6, 3, 18, C.BRONZE); b.set(lx - 1, top - 6, C.GOLD); b.ellipse(lx, top - 7, 4, 2, C.GOLD_D); b.rect(lx - 1, top - 14, 3, 7, C.PAPER); b.set(lx - 1, top - 14, C.JADE);
  DESK_ITEM[key](b, x0, top);
  return [[lx, top - 15]];
}
/** the clerk's stool and his small writing table in front */
function stool(b, cx, y, s) {
  shade(b, [[cx + 30, y - 2], [cx + 40, y + 4], [cx + 40, y + 22], [cx - 24, y + 22], [cx - 32, y + 16], [cx + 30, y + 16]], DARK, 2);
  b.ellipse(cx, y - 4, 20, 5, C.DBROWN); b.ellipse(cx, y - 5, 18, 4, C.WOOD);
  const x0 = cx - 34, w = 68;
  for (const lx of [x0 + 3, x0 + w - 9]) b.rect(lx, y + 10, 6, 8, C.DBROWN);
  b.rect(x0, y, w, 12, C.WOOD); b.hline(x0, x0 + w - 1, y, C.WOOD_L); b.rect(x0, y + 10, w, 4, C.BROWN); b.hline(x0, x0 + w - 1, y + 13, C.DBROWN);
  b.rect(cx - 10, y + 2, 20, 7, C.PAPER); b.hline(cx - 8, cx + 6, y + 5, C.STONE_L);
  b.rect(cx + 16 * s, y + 3, 8, 6, C.BLACK); b.set(cx + 17 * s, y + 4, C.STONE_D);
}
function shelfOfBooks(b, x, y, w, h, seed, cols = [C.BLU_D, C.BLU, C.TEAL, C.PAPER]) {
  const r = rng(seed);
  shade(b, [[x + w, y + 6], [x + w + 12, y + 14], [x + w + 12, y + h + 10], [x + 8, y + h + 10], [x, y + h]], DARK, 2);
  b.rect(x, y, w, h, C.DBROWN); b.rect(x + 3, y + 3, w - 6, h - 6, C.DEEP);
  const rows = Math.floor((h - 6) / 22);
  for (let k = 0; k < rows; k++) {
    const yy = y + 3 + k * 22;
    b.rect(x + 3, yy + 19, w - 6, 3, C.WOOD); b.hline(x + 3, x + w - 4, yy + 19, C.WOOD_L);
    for (let i = x + 5; i < x + w - 8;) {
      const bw = 5 + Math.floor(r() * 4), bh = 12 + Math.floor(r() * 6), c = cols[Math.floor(r() * cols.length)];
      if (r() < 0.12) { i += bw; continue; }
      b.rect(i, yy + 19 - bh, bw, bh, c); b.vline(i, yy + 19 - bh, yy + 18, c === C.PAPER ? C.JADE : C.SKY); b.rect(i + 1, yy + 19 - bh + 3, bw - 2, 3, C.PAPER);
      i += bw + 1;
    }
  }
  b.vline(x, y, y + h - 1, C.WOOD); b.hline(x, x + w - 1, y, C.WOOD_L);
}
function lowTable(b, x, top, w, depth = 14, legs = 12) {
  shade(b, [[x + w, top + 2], [x + w + 10, top + 8], [x + w + 10, top + depth + legs + 8], [x + 8, top + depth + legs + 8], [x, top + depth + legs]], DARK, 2);
  for (const lx of [x + 3, x + w - 9]) b.rect(lx, top + depth, 6, legs, C.DBROWN);
  b.rect(x, top, w, depth, C.WOOD); b.hline(x, x + w - 1, top, C.WOOD_L); b.rect(x, top + depth - 4, w, 4, C.BROWN); b.hline(x, x + w - 1, top + depth - 1, C.DBROWN);
}

// ───────────────────────── each ministry's things ─────────────────────────
const DESK_ITEM = {
  hubu(b, x0, top) { // abacus
    b.rect(x0 + 6, top + 3, 34, 15, C.DBROWN); b.rect(x0 + 8, top + 5, 30, 11, C.WOOD_L);
    b.hline(x0 + 8, x0 + 37, top + 8, C.DBROWN);
    for (let i = 0; i < 7; i++) { b.vline(x0 + 10 + i * 4, top + 5, top + 15, C.BROWN); b.rect(x0 + 9 + i * 4, top + 6, 3, 2, C.BLACK); b.rect(x0 + 9 + i * 4, top + 10 + (i % 3), 3, 2, C.BLACK); b.rect(x0 + 9 + i * 4, top + 13, 3, 2, C.BLACK); }
  },
  libu(b, x0, top) { // a small bronze 爵 and a book
    b.rect(x0 + 8, top + 6, 22, 10, C.BLU_D); b.hline(x0 + 8, x0 + 29, top + 6, C.BLU); b.rect(x0 + 12, top + 8, 6, 6, C.PAPER);
    b.ellipse(x0 + 38, top + 6, 5, 3, C.BRONZE); b.vline(x0 + 36, top + 8, top + 14, C.BROWN); b.vline(x0 + 40, top + 8, top + 14, C.BROWN); b.set(x0 + 35, top + 4, C.GOLD);
  },
  bingbu(b, x0, top) { // tiger tally and a rolled map
    b.ellipse(x0 + 16, top + 10, 9, 5, C.GOLD_D); b.ellipse(x0 + 15, top + 9, 7, 3, C.GOLD); b.set(x0 + 22, top + 7, C.GOLD_L); for (const dx of [8, 12, 16, 20]) b.set(x0 + dx, top + 10, C.BROWN);
    b.rect(x0 + 28, top + 5, 6, 14, C.PAPER); b.ellipse(x0 + 31, top + 5, 3, 2, C.GOLD_D); b.ellipse(x0 + 31, top + 18, 3, 2, C.GOLD_D);
  },
  xingbu(b, x0, top) { // tally-stick holder and the gavel block
    b.rect(x0 + 10, top + 4, 12, 14, C.BLACK); b.hline(x0 + 10, x0 + 21, top + 4, C.STONE_D);
    for (let i = 0; i < 5; i++) b.vline(x0 + 11 + i * 2, top - 8 + (i % 2) * 3, top + 3, i % 2 ? C.GRN : C.RED);
    b.rect(x0 + 28, top + 8, 16, 8, C.DBROWN); b.hline(x0 + 28, x0 + 43, top + 8, C.BROWN);
  },
  gongbu(b, x0, top) { // L-square and rolled drawings
    b.rect(x0 + 6, top + 4, 26, 3, C.WOOD_L); b.rect(x0 + 6, top + 4, 3, 14, C.WOOD_L); for (let i = 0; i < 6; i++) b.set(x0 + 10 + i * 4, top + 5, C.BROWN);
    for (let i = 0; i < 3; i++) { b.rect(x0 + 14 + i * 2, top + 9 + i * 3, 26, 3, C.PAPER); b.ellipse(x0 + 14 + i * 2, top + 10 + i * 3, 2, 1, C.BLU); }
  },
  libu_hr(b, x0, top) { // seal box and name registers
    b.rect(x0 + 8, top + 3, 14, 13, C.RED_D); b.rect(x0 + 9, top + 3, 12, 5, C.GOLD); b.hline(x0 + 9, x0 + 20, top + 3, C.GOLD_L);
    for (let k = 0; k < 3; k++) { b.rect(x0 + 26, top + 6 - k * 3, 18, 5, [C.BLU_D, C.GRN_D, C.RED_D][k]); b.rect(x0 + 30, top + 7 - k * 3, 6, 3, C.PAPER); }
  },
};

const FURNISH = {
  // 户部: ledgers on shelves, the iron-bound strongbox, strings of copper cash, silver ingots, scales
  hubu(b, x0, x1, cx) {
    zhilingWindow(b, x0 + 30, 22, 100, 46, true);
    shelfOfBooks(b, x1 - 112, 28, 92, 82, 41, [C.BLU_D, C.BLU, C.BLU_D, C.PAPER]);
    { // strongbox
      const x = x0 + 26, y = 162, w = 72, h = 36;
      shade(b, [[x + w, y - 10], [x + w + 14, y - 2], [x + w + 14, y + h + 10], [x + 10, y + h + 10], [x, y + h]], DARK, 2);
      b.rect(x, y - 14, w, 14, C.BROWN); b.hline(x, x + w - 1, y - 14, C.WOOD); b.rect(x, y, w, h, C.DBROWN); b.hline(x, x + w - 1, y, C.BROWN);
      for (const bx of [x + 8, x + w - 14]) { b.rect(bx, y - 14, 6, h + 14, C.BLACK); b.vline(bx, y - 14, y + h - 1, C.STONE_D); for (let yy = y - 10; yy < y + h; yy += 8) b.set(bx + 3, yy, C.STONE); }
      b.rect(x + w / 2 - 6, y + 6, 12, 12, C.GOLD_D); b.rect(x + w / 2 - 4, y + 8, 8, 6, C.GOLD); b.rect(x + w / 2 - 1, y + 10, 2, 3, C.BLACK);
      // silver ingots on the lid
      for (const [dx, dy] of [[14, -20], [26, -20], [20, -24]]) { b.ellipse(x + dx + 6, y + dy, 6, 3, C.STONE_L); b.ellipse(x + dx + 6, y + dy - 2, 3, 2, C.JADE); b.set(x + dx + 9, y + dy + 1, C.STONE); }
    }
    { // strings of cash heaped by the box, a stack of ledgers
      for (let k = 0; k < 5; k++) for (let i = 0; i < 9; i++) { const px = x0 + 30 + i * 6 + (k % 2) * 3, py = 230 - k * 5; b.ellipse(px, py, 3, 2, C.BRONZE); b.set(px, py, C.DEEP); b.set(px - 1, py - 1, C.GOLD); }
      b.line(x0 + 28, 234, x0 + 88, 234, C.RED);
      for (let k = 0; k < 5; k++) { b.rect(x0 + 100, 226 - k * 5, 40, 6, k % 2 ? C.BLU : C.BLU_D); b.hline(x0 + 100, x0 + 139, 226 - k * 5, C.SKY); b.rect(x0 + 104, 227 - k * 5, 8, 3, C.PAPER); }
      shade(b, [[x0 + 140, 210], [x0 + 150, 216], [x0 + 150, 240], [x0 + 104, 240], [x0 + 100, 234]], DARK, 2);
    }
  },
  // 礼部: an altar table with ritual bronzes, a hanging scroll, a set of bells, ritual books
  libu(b, x0, x1, cx, top, incense) {
    { // hanging scroll painting behind the minister
      const x = cx - 30, y = 14;
      b.rect(x - 3, y, 66, 4, C.WOOD); b.rect(x, y + 4, 60, 60, C.GOLD_D); b.rect(x + 4, y + 8, 52, 50, C.PAPER);
      b.ellipse(x + 30, y + 34, 18, 12, C.PLASTER_S); b.poly([[x + 8, y + 54], [x + 22, y + 30], [x + 34, y + 54]], C.GRN); b.poly([[x + 24, y + 54], [x + 40, y + 24], [x + 54, y + 54]], C.TEAL); b.ellipse(x + 44, y + 16, 4, 4, C.RED);
      b.rect(x - 3, y + 64, 66, 5, C.WOOD); b.ellipse(x - 4, y + 66, 3, 3, C.DBROWN); b.ellipse(x + 63, y + 66, 3, 3, C.DBROWN);
    }
    { // altar table with bronzes against the back wall, left
      const x = x0 + 24, top2 = 96, w = 120;
      lowTable(b, x, top2, w, 16, 14);
      b.rect(x + 4, top2 + 2, w - 8, 10, C.RED); b.hline(x + 4, x + w - 5, top2 + 2, C.RED_L); b.rect(x + 4, top2 + 12, w - 8, 6, C.GOLD_D);
      // 鼎 in the middle (incense rises from it), 簋 and a pair of candlesticks
      const dx = x + w / 2;
      for (const lx of [-8, 0, 8]) b.vline(dx + lx, top2 - 4, top2 + 2, C.BROWN);
      b.ellipse(dx, top2 - 10, 13, 9, C.BRONZE); b.ellipse(dx - 4, top2 - 12, 5, 4, C.GOLD); b.hline(dx - 12, dx + 12, top2 - 16, C.GOLD_D); b.ellipse(dx, top2 - 17, 11, 3, C.DBROWN);
      for (const ex of [-10, 8]) { b.rect(dx + ex, top2 - 25, 3, 8, C.BRONZE); b.set(dx + ex, top2 - 25, C.GOLD); }
      incense.push([dx, top2 - 20]);
      b.ellipse(x + 22, top2 - 6, 9, 6, C.BRONZE); b.ellipse(x + 20, top2 - 7, 4, 3, C.GOLD); b.ellipse(x + 22, top2 - 11, 9, 3, C.GOLD_D); b.rect(x + 18, top2 - 2, 9, 4, C.BROWN);
      b.ellipse(x + w - 22, top2 - 6, 7, 7, C.BRONZE); b.ellipse(x + w - 24, top2 - 8, 3, 3, C.GOLD); b.rect(x + w - 25, top2 - 16, 7, 4, C.BRONZE); b.line(x + w - 28, top2 - 16, x + w - 32, top2 - 20, C.BRONZE);
      for (const ex of [x + 6, x + w - 8]) { b.rect(ex, top2 - 14, 3, 14, C.BRONZE); b.rect(ex - 1, top2 - 20, 5, 6, C.RED); b.set(ex, top2 - 20, C.RED_L); }
    }
    { // a set of bells (编钟) on its frame
      const x = x0 + 30, y = 168, w = 116, h = 74;
      shade(b, [[x + w, y], [x + w + 12, y + 8], [x + w + 12, y + h + 8], [x + 8, y + h + 8], [x, y + h]], DARK, 2);
      for (const px of [x, x + w - 8]) { b.rect(px, y, 8, h, C.RED_M); b.vline(px, y, y + h - 1, C.RED); b.rect(px - 3, y + h - 6, 14, 6, C.DBROWN); }
      b.rect(x - 4, y - 6, w + 8, 8, C.RED); b.hline(x - 4, x + w + 3, y - 6, C.RED_L); b.rect(x - 4, y + 34, w + 8, 6, C.RED); b.hline(x - 4, x + w + 3, y + 34, C.RED_L);
      for (const [ry, n, s] of [[y + 2, 6, 15], [y + 40, 5, 18]]) for (let i = 0; i < n; i++) { const bx = x + 18 + i * s, bh = 22 - i * 2 - (ry > y ? 6 : 0); b.vline(bx, ry, ry + 3, C.BLACK); b.poly([[bx - 5, ry + 4], [bx + 5, ry + 4], [bx + 7, ry + 4 + bh], [bx - 7, ry + 4 + bh]], C.BRONZE); b.vline(bx - 4, ry + 5, ry + 3 + bh, C.GOLD); for (let yy = ry + 8; yy < ry + 2 + bh; yy += 4) b.hline(bx - 3, bx + 3, yy, C.GOLD_D); }
    }
    shelfOfBooks(b, x1 - 110, 28, 90, 82, 52, [C.GRN_D, C.BLU_D, C.PAPER, C.GOLD_L]);
  },
  // 兵部: the great map on the wall, the sand table, a rack of weapons
  bingbu(b, x0, x1, cx) {
    { // 舆图 hanging on the back wall
      const x = x0 + 26, y = 16, w = 130, h = 62;
      b.rect(x - 3, y - 2, w + 6, 4, C.WOOD); b.rect(x, y, w, h, C.PAPER); frame(b, x, y, w, h, C.GOLD_D);
      const r = rng(8);
      for (let k = 0; k < 14; k++) { const px = x + 10 + Math.floor(r() * (w - 20)), py = y + 8 + Math.floor(r() * (h - 16)); b.ellipse(px, py, 4 + Math.floor(r() * 6), 2 + Math.floor(r() * 3), r() < 0.5 ? C.GRN_L : C.GOLD_L); }
      b.line(x + 8, y + 40, x + 50, y + 30, C.BLU); b.line(x + 50, y + 30, x + 120, y + 44, C.BLU); b.line(x + 20, y + 14, x + 26, y + 50, C.TEAL);
      for (let xx = x + 60; xx < x + 124; xx += 6) b.set(xx, y + 12 + ((xx / 6) % 2 < 1 ? 0 : 1), C.RED_D);
      for (const [px, py] of [[x + 40, y + 24], [x + 88, y + 36], [x + 104, y + 18]]) { b.rect(px, py, 3, 3, C.RED); }
      b.rect(x - 3, y + h, w + 6, 4, C.WOOD); b.ellipse(x - 4, y + h + 2, 3, 3, C.DBROWN); b.ellipse(x + w + 3, y + h + 2, 3, 3, C.DBROWN);
    }
    { // weapon rack against the back wall, right
      const x = x1 - 120, y = 22, w = 100, h = 92;
      shade(b, [[x + w, y + 70], [x + w + 12, y + 78], [x + w + 12, y + h + 8], [x + 8, y + h + 8], [x, y + h]], DARK, 2);
      for (const px of [x, x + w - 8]) { b.rect(px, y + 20, 8, h - 20, C.DBROWN); b.vline(px, y + 20, y + h - 1, C.BROWN); }
      b.rect(x - 2, y + 40, w + 4, 6, C.BROWN); b.hline(x - 2, x + w + 1, y + 40, C.WOOD); b.rect(x - 2, y + h - 18, w + 4, 6, C.BROWN); b.hline(x - 2, x + w + 1, y + h - 18, C.WOOD);
      for (let i = 0; i < 6; i++) {
        const sx = x + 12 + i * 15;
        b.vline(sx, y, y + h - 4, C.WOOD_L); b.vline(sx + 1, y, y + h - 4, C.BROWN);
        if (i % 3 === 1) { b.poly([[sx - 6, y + 2], [sx + 1, y - 6], [sx + 1, y + 10]], C.STONE_L); b.line(sx - 6, y + 2, sx, y - 5, C.JADE); } // halberd blade
        else { b.poly([[sx - 2, y + 4], [sx + 3, y + 4], [sx + 1, y - 8]], C.STONE_L); b.set(sx, y - 6, C.JADE); }
        b.rect(sx - 2, y + 6, 6, 5, C.RED); b.set(sx - 2, y + 6, C.RED_L);
      }
      // a bow and a quiver hung on the end post
      b.line(x + w + 4, y + 30, x + w + 10, y + 50, C.WOOD); b.line(x + w + 10, y + 50, x + w + 4, y + 70, C.WOOD); b.line(x + w + 4, y + 30, x + w + 4, y + 70, C.PAPER);
    }
    { // sand table: a relief map with rivers and little flags
      const x = x0 + 22, top2 = 168, w = 132, d = 50;
      shade(b, [[x + w, top2 + 2], [x + w + 12, top2 + 10], [x + w + 12, top2 + d + 24], [x + 10, top2 + d + 24], [x, top2 + d + 16]], DARK, 2);
      for (const lx of [x + 4, x + w - 12]) b.rect(lx, top2 + d + 8, 8, 14, C.DBROWN);
      b.rect(x, top2, w, d + 8, C.DBROWN); b.rect(x, top2 + d, w, 10, C.BROWN); b.hline(x, x + w - 1, top2 + d, C.WOOD);
      b.rect(x + 4, top2 + 4, w - 8, d - 6, C.GOLD_L);
      const r = rng(61);
      for (let k = 0; k < 90; k++) b.set(x + 5 + Math.floor(r() * (w - 10)), top2 + 5 + Math.floor(r() * (d - 8)), r() < 0.5 ? C.GOLD : C.WOOD_L);
      for (const [px, py, rx, ry, c, hi] of [[x + 30, top2 + 22, 18, 9, C.GRN, C.GRN_L], [x + 74, top2 + 16, 14, 7, C.GRN_D, C.GRN], [x + 100, top2 + 30, 16, 8, C.GRN, C.GRN_L]]) { b.ellipse(px, py, rx, ry, c); b.ellipse(px - 4, py - 2, Math.round(rx / 2), Math.round(ry / 2), hi); }
      b.line(x + 6, top2 + 38, x + 60, top2 + 30, C.BLU); b.line(x + 60, top2 + 30, x + w - 6, top2 + 40, C.BLU); b.line(x + 6, top2 + 39, x + 60, top2 + 31, C.SKY);
      for (const [px, py, c] of [[x + 24, top2 + 14, C.RED], [x + 52, top2 + 26, C.RED], [x + 86, top2 + 10, C.BLU], [x + 110, top2 + 24, C.BLU], [x + 70, top2 + 38, C.RED]]) { b.vline(px, py - 10, py, C.BLACK); b.rect(px + 1, py - 10, 6, 4, c); b.set(px + 1, py - 10, c === C.RED ? C.RED_L : C.SKY); }
    }
  },
  // 刑部: shelves of the law, hanging scrolls of the statutes, the 獬豸 that butts the guilty
  xingbu(b, x0, x1, cx) {
    for (const x of [x0 + 26, x0 + 70, cx + 62, cx + 106]) { b.rect(x - 2, 412, 30, 3, C.WOOD); b.rect(x, 415, 26, 50, C.PAPER); b.rect(x, 415, 26, 6, C.GOLD_D); for (let y = 426; y < 460; y += 5) b.hline(x + 4, x + 21, y, (y / 5) % 3 < 1 ? C.STONE : C.STONE_L); b.rect(x - 2, 465, 30, 3, C.WOOD); }
    scrollShelf(b, x0 + 20, 490, 110, 70, 14);
    { // 獬豸 on its plinth, front right
      const x = x1 - 70, by = 676;
      shade(b, [[x - 18, by], [x + 30, by - 36], [x + 54, by - 20], [x + 44, by + 12], [x, by + 12]], DARK, 2);
      b.rect(x - 30, by - 18, 60, 18, C.STONE_L); b.hline(x - 30, x + 29, by - 18, C.JADE); b.hline(x - 30, x + 29, by - 14, C.STONE); b.rect(x - 26, by - 11, 52, 5, C.STONE); b.hline(x - 30, x + 29, by - 1, C.STONE_D);
      const ty = by - 18;
      b.ellipse(x - 2, ty - 16, 22, 12, C.TILE); b.ellipse(x - 4, ty - 18, 19, 9, C.TILE_L);
      for (const lx of [x - 18, x - 8, x + 6, x + 14]) { b.rect(lx, ty - 10, 6, 10, C.TILE); b.vline(lx, ty - 10, ty - 1, C.TILE_L); b.hline(lx, lx + 5, ty - 1, C.TILE_D); }
      b.ellipse(x + 18, ty - 30, 10, 9, C.TILE); b.ellipse(x + 16, ty - 32, 7, 6, C.TILE_L);
      b.line(x + 20, ty - 38, x + 26, ty - 56, C.STONE_L); b.line(x + 21, ty - 38, x + 27, ty - 56, C.STONE); b.set(x + 26, ty - 57, C.JADE);
      b.set(x + 22, ty - 32, C.GOLD); b.hline(x + 20, x + 27, ty - 25, C.TILE_D);
      b.line(x - 22, ty - 20, x - 32, ty - 30, C.TILE); b.ellipse(x - 33, ty - 31, 3, 3, C.TILE_L);
      for (let k = 0; k < 5; k++) b.set(x - 14 + k * 6, ty - 22, C.TILE_D);
    }
    lowTable(b, x0 + 150, 500, 50, 12, 10);
    for (let k = 0; k < 3; k++) { b.rect(x0 + 156, 496 - k * 4, 38, 5, [C.BLACK, C.RED_D, C.BLACK][k]); b.rect(x0 + 160, 497 - k * 4, 10, 3, C.PAPER); }
  },
  // 工部: drawings pinned to the wall, the drafting table with rulers, a model of a pavilion
  gongbu(b, x0, x1, cx) {
    for (const [x, y, w, h] of [[x0 + 26, 416, 70, 52], [x0 + 104, 422, 56, 44], [cx + 54, 414, 64, 54], [cx + 126, 420, 64, 48]]) {
      b.rect(x, y, w, h, C.PAPER); b.hline(x, x + w - 1, y, C.JADE); b.vline(x + w - 1, y, y + h - 1, C.PLASTER_S);
      for (const [px, py] of [[x + 2, y + 2], [x + w - 3, y + 2]]) b.set(px, py, C.RED);
      const mx = x + w / 2;
      b.hline(x + 8, x + w - 9, y + h - 10, C.BLU); for (let k = 0; k < 4; k++) b.vline(x + 10 + k * Math.floor((w - 20) / 3), y + h * 0.45, y + h - 10, C.BLU);
      b.line(x + 4, y + h * 0.45, mx, y + 8, C.BLU); b.line(mx, y + 8, x + w - 5, y + h * 0.45, C.BLU); b.hline(x + 4, x + w - 5, Math.round(y + h * 0.45), C.BLU_D);
    }
    { // drafting table with a plan, an L-square and a plumb line
      const x = x0 + 24, top2 = 504, w = 120, d = 46;
      shade(b, [[x + w, top2 + 2], [x + w + 12, top2 + 10], [x + w + 12, top2 + d + 22], [x + 10, top2 + d + 22], [x, top2 + d + 14]], DARK, 2);
      for (const lx of [x + 4, x + w - 12]) b.rect(lx, top2 + d + 6, 8, 14, C.DBROWN);
      b.rect(x, top2, w, d + 6, C.WOOD); b.hline(x, x + w - 1, top2, C.WOOD_L); b.rect(x, top2 + d, w, 8, C.BROWN);
      b.rect(x + 8, top2 + 5, w - 30, d - 9, C.PAPER); b.hline(x + 8, x + w - 23, top2 + 5, C.JADE);
      for (let i = 0; i < 5; i++) b.vline(x + 16 + i * 18, top2 + 10, top2 + d - 8, C.BLU); b.hline(x + 12, x + w - 28, top2 + 14, C.BLU); b.hline(x + 12, x + w - 28, top2 + d - 10, C.BLU); b.rect(x + 40, top2 + 18, 24, 10, C.BLU_D);
      b.rect(x + w - 20, top2 + 4, 4, 40, C.WOOD_L); b.rect(x + w - 20, top2 + 40, 16, 4, C.WOOD_L); for (let y = top2 + 8; y < top2 + 40; y += 5) b.set(x + w - 18, y, C.BROWN);
    }
    { // timber offcuts
      for (let k = 0; k < 3; k++) { b.rect(x0 + 30 + k * 6, 600 - k * 7, 50, 7, k % 2 ? C.WOOD_L : C.WOOD); b.hline(x0 + 30 + k * 6, x0 + 79 + k * 6, 600 - k * 7, C.GOLD_L); b.ellipse(x0 + 79 + k * 6, 603 - k * 7, 3, 3, C.GOLD_L); b.set(x0 + 79 + k * 6, 603 - k * 7, C.BROWN); }
    }
    { // a model pavilion on its stand, front right
      const x = x1 - 72, by = 680;
      shade(b, [[x + 30, by - 70], [x + 46, by - 60], [x + 46, by + 10], [x - 20, by + 10], [x - 30, by]], DARK, 2);
      b.rect(x - 32, by - 22, 64, 22, C.DBROWN); b.rect(x - 32, by - 22, 64, 6, C.WOOD); b.hline(x - 32, x + 31, by - 22, C.WOOD_L);
      b.rect(x - 24, by - 30, 48, 8, C.JADE); b.hline(x - 24, x + 23, by - 30, C.PAPER); b.hline(x - 24, x + 23, by - 23, C.STONE_L);
      b.rect(x - 18, by - 52, 36, 22, C.RED_D); for (const px of [x - 18, x - 6, x + 6, x + 15]) { b.rect(px, by - 52, 3, 22, C.RED); }
      b.rect(x - 14, by - 46, 6, 12, C.RED_M); b.rect(x + 8, by - 46, 6, 12, C.RED_M);
      glazedMini(b, x, by - 52, 32, 20);
    }
  },
  // 吏部: cabinets of name registers with labelled drawers, the rank books, the seal chest
  libu_hr(b, x0, x1, cx) {
    for (const x of [x0 + 22, cx + 46]) {
      const y = 424, w = 112, h = 104;
      shade(b, [[x + w, y + 60], [x + w + 12, y + 68], [x + w + 12, y + h + 8], [x + 8, y + h + 8], [x, y + h]], DARK, 2);
      b.rect(x, y, w, h, C.DBROWN); b.rect(x + 3, y + 3, w - 6, h - 6, C.WOOD); b.hline(x, x + w - 1, y, C.WOOD_L);
      for (let rr = 0; rr < 5; rr++) for (let c = 0; c < 4; c++) { const dx = x + 6 + c * 26, dy = y + 6 + rr * 19; b.rect(dx, dy, 23, 16, C.BROWN); b.hline(dx, dx + 22, dy, C.WOOD); b.rect(dx + 7, dy + 3, 9, 5, C.PAPER); b.ellipse(dx + 11, dy + 12, 2, 1, C.GOLD); }
      b.rect(x + 2, y + h, 8, 4, C.DBROWN); b.rect(x + w - 10, y + h, 8, 4, C.DBROWN);
    }
    shelfOfBooks(b, x1 - 100, 560, 82, 92, 77, [C.BLU_D, C.GRN_D, C.RED_D, C.PAPER, C.BLU]);
    { // the seal chest
      const x = x0 + 158, y = 540;
      shade(b, [[x + 36, y - 10], [x + 48, y - 2], [x + 48, y + 26], [x + 6, y + 26], [x, y + 20]], DARK, 2);
      b.rect(x, y - 12, 36, 12, C.RED_M); b.hline(x, x + 35, y - 12, C.RED); b.rect(x, y, 36, 20, C.RED_D); b.rect(x + 14, y + 4, 8, 8, C.GOLD); b.set(x + 15, y + 5, C.GOLD_L);
      b.rect(x + 8, y - 18, 20, 6, C.GOLD_D); b.hline(x + 8, x + 27, y - 18, C.GOLD);
    }
  },
};

/** a small yellow-glazed hip roof for the model pavilion (top-down 3/4) */
function glazedMini(b, cx, eave, half, h) {
  for (let y = eave - h; y <= eave; y++) {
    const t = (y - (eave - h)) / h, hw = Math.round(6 + (half - 6) * t);
    for (let x = cx - hw; x <= cx + hw; x++) { const k = (x - cx + 64) % 5; b.set(x, y, k === 0 ? C.GOLD_L : k < 3 ? C.GOLD : C.GOLD_D); }
  }
  b.line(cx - 6, eave - h, cx - half, eave, C.GOLD_D); b.line(cx + 6, eave - h, cx + half, eave, C.BROWN);
  b.hline(cx - half - 2, cx + half + 2, eave, C.GOLD_D); b.hline(cx - 6, cx + 6, eave - h, C.GOLD_L); b.set(cx - half - 2, eave - 2, C.GOLD); b.set(cx + half + 2, eave - 2, C.GOLD);
}

/** the courtyard well: stone rim, wooden windlass frame */
function well(b, cx, by) {
  shade(b, [[cx - 8, by - 6], [cx + 30, by - 30], [cx + 52, by - 14], [cx + 30, by + 10], [cx, by + 10]], DARK, 2);
  b.ellipse(cx, by - 14, 30, 16, C.STONE); b.ellipse(cx, by - 16, 28, 14, C.STONE_L); b.ellipse(cx - 6, by - 20, 14, 5, C.JADE);
  b.ellipse(cx, by - 18, 18, 8, C.STONE); b.ellipse(cx, by - 17, 15, 6, C.BLU_D); b.ellipse(cx + 2, by - 16, 9, 3, C.TEAL); b.set(cx - 4, by - 19, C.SKY);
  for (const px of [cx - 26, cx + 22]) { b.rect(px, by - 54, 5, 40, C.WOOD); b.vline(px, by - 54, by - 15, C.WOOD_L); b.vline(px + 4, by - 54, by - 15, C.BROWN); }
  b.rect(cx - 24, by - 48, 48, 6, C.BROWN); b.hline(cx - 24, cx + 23, by - 48, C.WOOD); b.ellipse(cx - 8, by - 45, 4, 5, C.WOOD_L);
  b.line(cx + 10, by - 44, cx + 16, by - 36, C.WOOD); b.rect(cx + 14, by - 37, 7, 3, C.WOOD_L);
  b.vline(cx - 2, by - 42, by - 22, C.PLASTER_S);
  // a wooden bucket beside it
  b.rect(cx + 34, by - 14, 14, 12, C.WOOD); b.hline(cx + 34, cx + 47, by - 14, C.WOOD_L); b.hline(cx + 34, cx + 47, by - 9, C.BLACK); b.ellipse(cx + 41, by - 14, 7, 2, C.BROWN);
}
function stoneBench(b, cx, by) {
  shade(b, [[cx + 30, by - 14], [cx + 42, by - 6], [cx + 42, by + 6], [cx - 24, by + 6], [cx - 30, by]], DARK, 2);
  for (const px of [cx - 24, cx + 16]) b.rect(px, by - 10, 8, 10, C.STONE);
  b.rect(cx - 32, by - 18, 64, 9, C.STONE_L); b.hline(cx - 32, cx + 31, by - 18, C.JADE); b.hline(cx - 32, cx + 31, by - 10, C.STONE);
}

/** a bronze water vat (太平缸) against fire */
function vatSmall(b, cx, by) {
  shade(b, [[cx - 6, by], [cx + 20, by - 20], [cx + 40, by - 6], [cx + 30, by + 10], [cx, by + 10]], DARK, 2);
  b.rect(cx - 18, by - 6, 36, 6, C.STONE); b.hline(cx - 18, cx + 17, by - 6, C.STONE_L);
  b.ellipse(cx, by - 18, 22, 13, C.BROWN); b.ellipse(cx - 1, by - 19, 20, 11, C.BRONZE); b.ellipse(cx - 8, by - 22, 7, 6, C.GOLD);
  for (const s of [-1, 1]) { b.ellipse(cx + s * 20, by - 20, 3, 3, C.GOLD_D); b.set(cx + s * 20, by - 20, C.BROWN); }
  b.ellipse(cx, by - 30, 21, 7, C.GOLD_D); b.ellipse(cx, by - 31, 20, 6, C.GOLD); b.ellipse(cx, by - 30, 17, 4, C.BLU_D); b.ellipse(cx + 1, by - 29, 12, 2, C.TEAL); b.hline(cx - 8, cx - 3, by - 32, C.SKY);
}
