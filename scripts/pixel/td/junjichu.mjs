// 军机处 — the council room, top-down (3/4). The back wall is the memorial wall (折子墙): eight paper columns
// with red header bands where the game hangs the edict slips; three officials' desks and two clerks' desks below.
import { Bitmap, C, rng, W, H, dith, frame, shade, DARK, LIGHT, doorway } from './common.mjs';
import { scrollShelf, boshanlu, pottedPlant, woodFloor, mat, lampTree, LAMP_CUPS } from '../scenes.mjs';

// the memorial wall, in pixels (world = /2): columns of 148 px from x 48, header band, eight slips per column
const BOARD = { x: 48, colW: 148, cols: 8, top: 56, bot: 432, headY: 64, headH: 34, slipY0: 104, slipDy: 40 };
const FLOOR_Y = 484;
const DESKS = [
  { key: 'menxia', cx: 400, top: 548, w: 150, lacquer: false },
  { key: 'zhongshu', cx: 640, top: 548, w: 164, lacquer: true },
  { key: 'shangshu', cx: 880, top: 548, w: 150, lacquer: false },
];
const CLERKS = [{ cx: 262, top: 668, w: 112 }, { cx: 1018, top: 668, w: 112 }];

export function junjichu() {
  const b = new Bitmap(W, H);
  const half = (p) => p.map(([x, y]) => [x / 2, y / 2]);

  // ── 1. ceiling: rafters and a painted beam (旋子彩画) ──
  b.rect(0, 0, W, 40, C.DEEP);
  for (let x = 4; x < W; x += 20) { b.rect(x, 0, 10, 12, C.BROWN); b.vline(x, 0, 11, C.WOOD); b.ellipse(x + 5, 12, 5, 3, C.WOOD); b.ellipse(x + 5, 12, 2, 1, C.GRN); }
  b.rect(0, 16, W, 20, C.BLU_D);
  for (let x = 0; x < W; x += 160) {
    b.rect(x + 4, 18, 40, 16, C.GRN); b.rect(x + 116, 18, 40, 16, C.GRN);
    b.rect(x + 48, 19, 64, 14, C.BLU); b.hline(x + 48, x + 111, 19, C.SKY);
    for (const cx of [x + 24, x + 136]) { b.ellipse(cx, 26, 7, 6, C.TEAL); b.ellipse(cx, 26, 4, 3, C.BLU_D); b.ellipse(cx, 26, 1, 1, C.GOLD); for (let a = 0; a < 6; a++) b.set(cx + Math.round(Math.cos(a * 1.05) * 6), 26 + Math.round(Math.sin(a * 1.05) * 5), C.JADE); }
    b.line(x + 44, 17, x + 48, 26, C.JADE); b.line(x + 48, 26, x + 44, 35, C.JADE); b.line(x + 116, 17, x + 112, 26, C.JADE); b.line(x + 112, 26, x + 116, 35, C.JADE);
  }
  b.hline(0, W - 1, 16, C.JADE); b.hline(0, W - 1, 35, C.BLACK); b.rect(0, 36, W, 4, C.DBROWN);

  // ── 2. back wall: plaster behind, then the memorial wall in its lacquered frame ──
  b.rect(0, 40, W, FLOOR_Y - 40, C.JADE);
  dith(b, 0, 40, W, 6, C.PLASTER_S, 2);
  memorialWall(b);
  // the dado under the board: a calm dark band (the game writes the selected edict's flow across it)
  {
    const y0 = 442, y1 = FLOOR_Y;
    b.rect(0, y0, W, y1 - y0, C.DBROWN);
    b.rect(0, y0, W, 4, C.WOOD); b.hline(0, W - 1, y0, C.WOOD_L); b.hline(0, W - 1, y0 + 4, C.DEEP);
    for (let x = BOARD.x; x <= BOARD.x + BOARD.cols * BOARD.colW; x += BOARD.colW) b.vline(x, y0 + 5, y1 - 5, C.BROWN);
    b.rect(0, y1 - 4, W, 4, C.DEEP); b.hline(0, W - 1, y1 - 4, C.BROWN);
  }

  // ── 3. wooden floor, a long rug under the officials' desks ──
  woodFloor(b, 0, FLOOR_Y, W, H, 7);
  dith(b, 0, FLOOR_Y, W, 8, C.DEEP, 2);
  {
    const x0 = 296, x1 = 984, y0 = 520, y1 = 610;
    b.rect(x0, y0, x1 - x0, y1 - y0, C.RED_M);
    b.rect(x0 + 6, y0 + 6, x1 - x0 - 12, y1 - y0 - 12, C.RED);
    frame(b, x0 + 3, y0 + 3, x1 - x0 - 6, y1 - y0 - 6, C.GOLD_D);
    for (let x = x0 + 14; x < x1 - 10; x += 16) { b.set(x, y0 + 3, C.GOLD); b.set(x + 8, y1 - 4, C.GOLD); }
    for (let x = x0 + 40; x < x1 - 30; x += 80) { b.ellipse(x, (y0 + y1) / 2 + 20, 9, 6, C.RED_M); b.ellipse(x, (y0 + y1) / 2 + 20, 3, 2, C.GOLD); }
    dith(b, x0 + 8, y0 + 8, x1 - x0 - 16, y1 - y0 - 16, C.RED_M, 7);
  }
  // soft daylight from the doorway on the left
  shade(b, [[18, 600], [18, 690], [190, 720], [330, 720], [120, 600]], LIGHT, 2);

  // ── 4. side walls with the doorways (left → 宫道, right → 太和殿) ──
  for (const [x, w] of [[0, 18], [W - 18, 18]]) { b.rect(x, 40, w, H - 40, C.RED_D); b.rect(x + (x ? 0 : w - 4), 40, 4, H - 40, C.RED); }
  doorway(b, 0, 600, 18, 90);
  doorway(b, W - 18, 600, 18, 90);
  b.rect(0, H - 8, W, 8, C.RED_D); b.hline(0, W - 1, H - 8, C.RED);

  // ── 5. shelves of scrolls at both ends, an incense burner, a plant ──
  for (const [x, seed] of [[24, 6], [1150, 8]]) {
    shade(b, [[x + 100, 500], [x + 116, 512], [x + 116, 612], [x + 10, 612], [x, 600]], DARK, 2);
    scrollShelf(b, x, 500, 106, 100, seed);
    b.rect(x - 2, 494, 110, 6, C.WOOD); b.hline(x - 2, x + 107, 494, C.WOOD_L);
    b.rect(x + 4, 600, 8, 4, C.DBROWN); b.rect(x + 94, 600, 8, 4, C.DBROWN);
  }
  { // a small stand with a 博山炉 by the right shelf
    const x = 1100, y = 596;
    shade(b, [[x - 10, y], [x + 18, y - 4], [x + 30, y + 8], [x - 2, y + 10]], DARK, 2);
    b.rect(x - 16, y - 12, 32, 6, C.WOOD); b.hline(x - 16, x + 15, y - 12, C.WOOD_L); b.rect(x - 14, y - 6, 4, 8, C.DBROWN); b.rect(x + 10, y - 6, 4, 8, C.DBROWN);
    boshanlu(b, x, y - 12);
  }
  pottedPlant(b, 160, 600);

  // ── 6. desks: 侍中 (left), 中书令 (centre), 尚书令 (right); the clerks' smaller desks in front ──
  const lamps = [];
  for (const d of DESKS) lamps.push(desk(b, d, true));
  for (const d of CLERKS) { mat(b, d.cx - 72, d.top - 22, 144, 64); desk(b, { ...d, lacquer: false }, false); }
  brazier(b, 640, 700);
  teaTable(b, 120, 684);
  chests(b, 1160, 700);

  // bronze lamp trees at both ends of the officials' row
  for (const x of [282, 998]) { shade(b, [[x - 12, 598], [x + 16, 594], [x + 40, 614], [x + 4, 618]], DARK, 2); lampTree(b, x, 600, 100); lamps.push(LAMP_CUPS(x, 600, 100)); }

  const seats = Object.fromEntries(DESKS.map((d) => [d.key, [d.cx / 2, d.top / 2]]));
  return {
    bg: b,
    spots: {
      walk: [
        { x0: 10, x1: 630, y0: 302, y1: 318 }, // the aisle between the desks and the clerks, door to door
        { x0: 150, x1: 490, y0: 262, y1: 280 }, // behind the officials' desks
        { x0: 150, x1: 160, y0: 278, y1: 304 }, { x0: 480, x1: 490, y0: 278, y1: 304 }, // round the ends of the row
        { x0: 248, x1: 272, y0: 278, y1: 304 }, { x0: 368, x1: 392, y0: 278, y1: 304 }, // between the desks
        { x0: 168, x1: 470, y0: 316, y1: 352 }, // the open floor at the front
        { x0: 116, x1: 146, y0: 316, y1: 336 }, { x0: 494, x1: 524, y0: 316, y1: 336 }, // the clerks' places
      ],
      doors: { gongdao: [0, 300, 12, 45], taihe: [628, 300, 12, 45] },
      emperorStart: [262, 332],
      title: [320, 352],
      board: { x: BOARD.x / 2, colW: BOARD.colW / 2, headerY: 35, slipY0: BOARD.slipY0 / 2, slipDy: BOARD.slipDy / 2 },
      seats,
      clerks: CLERKS.map((d) => [d.cx / 2, d.top / 2]),
      chain: [16, 226],
      lamps: half(lamps.flat()),
      incense: [[550, 270]],
      cat: [[300, 336], [420, 344], [200, 340], [560, 330]],
      npcs: [
        { kind: 'eunuch', x: 80, y: 310, facing: 'right', act: 'tray', route: [[40, 310], [600, 310]] },
        { kind: 'guard', x: 604, y: 340, facing: 'left' },
      ],
    },
  };
}

/** the 折子墙: lacquer frame, gilt corners, eight paper columns with red header bands, pegs for the slips */
function memorialWall(b) {
  const { x, colW, cols, top, bot, headY, headH, slipY0, slipDy } = BOARD, x1 = x + cols * colW;
  shade(b, [[x1 + 8, top - 8], [x1 + 18, top], [x1 + 18, bot + 14], [x - 4, bot + 14], [x - 8, bot + 8], [x1 + 8, bot + 8]], DARK, 2);
  b.rect(x - 12, top - 16, x1 - x + 24, bot - top + 26, C.DEEP);
  b.rect(x - 9, top - 13, x1 - x + 18, bot - top + 20, C.RED_D);
  b.hline(x - 9, x1 + 8, top - 13, C.RED_M); b.vline(x - 9, top - 13, bot + 6, C.RED_M);
  b.rect(x - 2, top - 2, x1 - x + 4, bot - top + 4, C.GOLD_D); b.hline(x - 2, x1 + 1, top - 2, C.GOLD);
  b.rect(x, top, x1 - x, bot - top, C.PAPER);
  const r = rng(21);
  for (let k = 0; k < 900; k++) b.set(x + Math.floor(r() * (x1 - x)), top + Math.floor(r() * (bot - top)), r() < 0.6 ? C.JADE : C.PLASTER_S);
  for (let k = 0; k < cols; k++) {
    const cx = x + k * colW;
    // header band
    b.rect(cx + 5, headY, colW - 10, headH, C.CRIMSON);
    b.rect(cx + 5, headY, colW - 10, 3, C.RED); b.hline(cx + 5, cx + colW - 6, headY, C.RED_L);
    b.hline(cx + 5, cx + colW - 6, headY + headH - 2, C.RED_D); b.hline(cx + 5, cx + colW - 6, headY + headH - 1, C.GOLD_D);
    for (const ex of [cx + 7, cx + colW - 8]) { b.ellipse(ex, headY + headH / 2, 1, 1, C.GOLD); }
    // ruled slots: a peg for each slip and a faint line under its label
    for (let i = 0; i < 8; i++) {
      const sy = slipY0 + i * slipDy;
      b.rect(cx + 24, sy - 4, 4, 3, C.BRONZE); b.set(cx + 24, sy - 4, C.GOLD);
      for (let xx = cx + 46; xx < cx + colW - 8; xx += 3) b.set(xx, sy + 30, C.PLASTER_S);
    }
    // the paper darkens a little toward each slat and under the header
    dith(b, cx + 3, top, 4, bot - top - 6, C.PLASTER_S, 2);
    dith(b, cx + 5, headY + headH, colW - 10, 3, C.PLASTER_S, 2);
    // wooden slat between columns
    if (k > 0) { b.rect(cx - 2, top, 4, bot - top, C.WOOD); b.vline(cx - 2, top, bot - 1, C.WOOD_L); b.vline(cx + 1, top, bot - 1, C.BROWN); }
  }
  // a narrow ledge at the foot of the paper, gilt corner pieces
  b.rect(x, bot - 6, x1 - x, 6, C.WOOD); b.hline(x, x1 - 1, bot - 6, C.WOOD_L); b.hline(x, x1 - 1, bot - 1, C.BROWN);
  for (const [px, py] of [[x - 12, top - 16], [x1 - 2, top - 16], [x - 12, bot - 4], [x1 - 2, bot - 4]]) { b.rect(px, py, 14, 14, C.GOLD); b.rect(px + 2, py + 2, 10, 10, C.GOLD_D); b.set(px + 3, py + 3, C.GOLD_L); b.ellipse(px + 7, py + 7, 2, 2, C.GOLD); }
}

/** a low writing desk seen from above: lacquered or plain top, front apron, legs; papers, ink and brushes at the ends */
function desk(b, d, big) {
  const { cx, top, w } = d, x0 = cx - w / 2, x1 = cx + w / 2, depth = big ? 24 : 18, apron = big ? 12 : 10;
  const [tc, tl, ad, ed] = d.lacquer ? [C.RED, C.RED_L, C.RED_M, C.RED_D] : [C.WOOD, C.WOOD_L, C.BROWN, C.DBROWN];
  shade(b, [[x1, top + 4], [x1 + 14, top + 12], [x1 + 14, top + depth + apron + 16], [x0 + 12, top + depth + apron + 16], [x0 + 4, top + depth + apron + 8], [x1, top + depth + apron + 8]], DARK, 2);
  // seat cushion behind the desk
  b.ellipse(cx, top - 4, big ? 40 : 30, 8, C.GOLD_D); b.ellipse(cx, top - 5, big ? 38 : 28, 6, d.lacquer ? C.GOLD : C.TEAL); b.hline(cx - (big ? 30 : 22), cx + (big ? 30 : 22), top - 9, d.lacquer ? C.GOLD_L : C.SKY);
  // legs
  for (const lx of [x0 + 4, x1 - 12]) { b.rect(lx, top + depth + apron - 2, 8, 10, ed); b.rect(lx - 2, top + depth + apron + 6, 12, 3, ed); }
  // top and apron
  b.rect(x0, top, w, depth, tc); b.hline(x0, x1 - 1, top, tl); b.vline(x0, top, top + depth - 1, tl);
  b.rect(x0, top + depth, w, apron, ad); b.hline(x0, x1 - 1, top + depth, ed); b.hline(x0, x1 - 1, top + depth + apron - 1, ed);
  if (d.lacquer) { frame(b, x0 + 4, top + depth + 3, w - 8, apron - 5, C.GOLD_D); for (let x = x0 + 20; x < x1 - 16; x += 30) b.ellipse(x, top + depth + apron / 2, 3, 1, C.GOLD); }
  else for (let x = x0 + 10; x < x1 - 8; x += 26) b.hline(x, x + 14, top + depth + apron / 2, ed);
  b.hline(x0, x1 - 1, top + depth - 1, ed);
  // things on the desk, kept to the ends so the seated official stays clear
  const lamp = [];
  // left end: a stack of memorials in folders
  for (let k = 0; k < (big ? 4 : 2); k++) { b.rect(x0 + 8, top + 8 - k * 3, 26, 5, k % 2 ? C.PAPER : big ? C.GOLD_L : C.JADE); b.hline(x0 + 8, x0 + 33, top + 12 - k * 3, C.PLASTER_S); b.vline(x0 + 8, top + 8 - k * 3, top + 12 - k * 3, C.GOLD_D); }
  // an open memorial in front of the official
  b.rect(cx - 18, top + 6, 36, 12, C.PAPER); b.vline(cx, top + 6, top + 17, C.PLASTER_S); for (let y = top + 9; y < top + 16; y += 3) { b.hline(cx - 14, cx - 4, y, C.STONE_L); b.hline(cx + 4, cx + 14, y, C.STONE_L); }
  // right end: inkstone, brush holder, (officials) a candlestick
  b.rect(x1 - 36, top + 9, 14, 9, C.BLACK); b.rect(x1 - 34, top + 10, 6, 4, C.STONE_D); b.set(x1 - 25, top + 15, C.DEEP);
  b.rect(x1 - 18, top + 2, 8, 12, C.TEAL); b.hline(x1 - 18, x1 - 11, top + 2, C.SKY); for (let i = 0; i < 3; i++) b.vline(x1 - 17 + i * 3, top - 6, top + 1, i === 1 ? C.WOOD : C.BROWN);
  if (big) {
    const lx = x1 - 50;
    b.ellipse(lx, top + 12, 5, 2, C.BRONZE); b.rect(lx - 1, top - 6, 3, 18, C.BRONZE); b.set(lx - 1, top - 6, C.GOLD);
    b.ellipse(lx, top - 7, 4, 2, C.GOLD_D); b.rect(lx - 1, top - 14, 3, 7, C.PAPER); b.set(lx - 1, top - 14, C.JADE);
    lamp.push([lx, top - 15]);
    if (d.lacquer) { b.rect(x0 + 40, top + 4, 10, 10, C.GOLD); b.rect(x0 + 41, top + 5, 8, 4, C.GOLD_L); b.rect(x0 + 42, top + 12, 6, 2, C.RED); } // the seal box
  }
  return lamp;
}

/** bronze brazier (火盆) on three legs, with glowing coals */
function brazier(b, cx, by) {
  shade(b, [[cx - 10, by], [cx + 20, by - 8], [cx + 40, by + 6], [cx + 12, by + 14]], DARK, 2);
  for (const dx of [-16, 0, 16]) { b.rect(cx + dx - 2, by - 10, 4, 10, C.BROWN); b.set(cx + dx - 2, by - 10, C.BRONZE); b.ellipse(cx + dx, by, 3, 1, C.DBROWN); }
  b.ellipse(cx, by - 16, 24, 9, C.BROWN);
  b.ellipse(cx - 1, by - 17, 23, 8, C.BRONZE);
  b.ellipse(cx - 8, by - 19, 8, 3, C.GOLD);
  b.ellipse(cx, by - 22, 22, 6, C.GOLD_D); b.ellipse(cx, by - 22, 19, 4, C.DEEP);
  const r = rng(3);
  for (let k = 0; k < 40; k++) { const a = r() * 6.28, d = Math.sqrt(r()); b.set(cx + Math.round(Math.cos(a) * d * 17), by - 22 + Math.round(Math.sin(a) * d * 3), r() < 0.4 ? C.RED_L : r() < 0.6 ? C.RED : C.GLOW); }
  for (const s of [-1, 1]) { b.ellipse(cx + s * 24, by - 18, 3, 3, C.GOLD_D); b.set(cx + s * 24, by - 18, C.BROWN); }
}

/** a low tea table with a pot and two cups */
function teaTable(b, cx, by) {
  shade(b, [[cx + 30, by - 18], [cx + 42, by - 10], [cx + 42, by + 8], [cx - 20, by + 8], [cx - 28, by]], DARK, 2);
  for (const lx of [cx - 26, cx + 20]) b.rect(lx, by - 10, 6, 10, C.DBROWN);
  b.rect(cx - 30, by - 22, 60, 12, C.WOOD); b.hline(cx - 30, cx + 29, by - 22, C.WOOD_L); b.rect(cx - 30, by - 12, 60, 4, C.BROWN);
  b.ellipse(cx - 6, by - 22, 9, 6, C.TEAL); b.ellipse(cx - 8, by - 24, 4, 2, C.SKY); b.ellipse(cx - 6, by - 28, 3, 1, C.BLU_D); b.line(cx + 3, by - 22, cx + 9, by - 26, C.TEAL);
  for (const dx of [12, 20]) { b.ellipse(cx + dx, by - 18, 3, 2, C.JADE); b.set(cx + dx, by - 18, C.GRN); }
}
/** document chests stacked on the floor */
function chests(b, cx, by) {
  shade(b, [[cx + 40, by - 52], [cx + 54, by - 42], [cx + 54, by + 8], [cx - 30, by + 8], [cx - 40, by]], DARK, 2);
  const box = (x, y, w, h, c, d) => { b.rect(x, y, w, h, c); b.hline(x, x + w - 1, y, C.WOOD_L); b.vline(x + w - 1, y, y + h - 1, d); b.hline(x, x + w - 1, y + h - 1, d); b.rect(x + w / 2 - 4, y + h / 2 - 2, 8, 5, C.GOLD); b.set(x + w / 2 - 3, y + h / 2 - 2, C.GOLD_L); for (const ex of [x + 2, x + w - 5]) b.rect(ex, y + 1, 3, h - 2, C.BRONZE); };
  box(cx - 40, by - 26, 80, 26, C.RED_M, C.RED_D);
  box(cx - 32, by - 48, 64, 22, C.BROWN, C.DBROWN);
  b.rect(cx - 26, by - 58, 30, 10, C.BLU_D); b.hline(cx - 26, cx + 3, by - 58, C.BLU); b.rect(cx - 22, by - 56, 8, 6, C.PAPER);
  b.rect(cx + 6, by - 56, 22, 8, C.PAPER); b.hline(cx + 6, cx + 27, by - 52, C.PLASTER_S); b.vline(cx + 6, by - 56, by - 49, C.GOLD_D);
}
