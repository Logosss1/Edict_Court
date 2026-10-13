// 太和殿 — top-down throne hall. Court sessions, 御批 and 请旨 happen here.
import { Bitmap, C, rng, W, H, dith, frame, shade, DARK, LIGHT, pillar, crane, doorway } from './common.mjs';
import { coffers, dougongRow, qizhuBeam, plaster, zhilingWindow, landscapeScreen, canopy, throneCouch, lampTree, boshanlu, LAMP_CUPS } from '../scenes.mjs';

export function taihe() {
  const NIGHT = false;
  const b = new Bitmap(W, H);
  // ── 1. back wall (seen face-on at the top of a 3/4 view) ──
  coffers(b, 0, W, 0, 30);
  dougongRow(b, 0, W, 30, 80);
  qizhuBeam(b, 0, W, 62, 14);
  plaster(b, 0, 76, W, 120);
  for (const x of [24, 300, 964, 1240]) { b.rect(x, 76, 16, 120, C.RED); b.vline(x + 2, 76, 195, C.RED_L); b.rect(x + 12, 76, 4, 120, C.RED_D); }
  zhilingWindow(b, 70, 96, 190, 82, !NIGHT);
  zhilingWindow(b, 1020, 96, 190, 82, !NIGHT);
  if (NIGHT) for (const x of [70, 1020]) { b.rect(x, 96, 190, 82, C.BLU_D); for (let i = 0; i < 190; i += 8) { b.rect(x + i, 96, 4, 82, C.BROWN); b.vline(x + i + 3, 96, 177, C.DBROWN); } b.rect(x, 123, 190, 3, C.BROWN); b.rect(x, 150, 190, 3, C.BROWN); }
  b.rect(0, 192, W, 8, C.RED_D); b.hline(0, W - 1, 192, C.RED); // skirting

  // ── 2. floor: big dark 金砖 seen from straight above ──
  {
    const r = rng(21), S = 40, y0 = 200;
    b.rect(0, y0, W, H - y0, C.STONE_D);
    for (let y = y0, row = 0; y < H; y += S, row++)
      for (let x = 0, col = 0; x < W; x += S, col++) {
        const v = r();
        const c = v < 0.08 ? C.FLOOR_D : v < 0.93 ? C.STONE_D : C.FLOOR;
        b.rect(x + 1, y + 1, S - 2, S - 2, c);
        b.hline(x + 2, x + S - 4, y + 2, c === C.FLOOR ? C.FLOOR_L : C.STONE);
        b.vline(x + 2, y + 2, y + 6, c === C.FLOOR ? C.FLOOR_L : C.STONE);
        b.hline(x, x + S - 1, y + S - 1, C.BLACK); b.vline(x + S - 1, y, y + S - 1, C.BLACK);
        // polished sheen: a few diagonal glints
        if (r() < 0.12) for (let k = 0; k < 6; k++) b.set(x + 8 + k, y + 14 + k, C.STONE);
        // lotus tiles on a sparse grid
        if (row % 3 === 1 && col % 4 === 2 && c === C.STONE_D) {
          const cx = x + S / 2, cy = y + S / 2;
          for (let a = 0; a < 8; a++) { const px = cx + Math.round(Math.cos(a * 0.785) * 10), py = cy + Math.round(Math.sin(a * 0.785) * 10); b.ellipse(px, py, 3, 3, C.STONE); b.set(px, py, C.STONE_D); }
          b.ellipse(cx, cy, 4, 4, C.STONE); b.set(cx, cy, C.STONE_L);
        }
      }
    dith(b, 0, y0, W, 8, C.BLACK, 2); // contact shadow under the wall
  }

  // ── 3. the screen + canopy behind the throne (against the back wall) ──
  landscapeScreen(b, 500, 84, 280, 70);
  canopy(b, 500, 64, 280, 96);
  { // 匾额 above the throne: blue board, gold frame, four gold characters (abstracted strokes)
    const x = 560, y = 40, w = 160, h = 22;
    b.rect(x - 4, y - 4, w + 8, h + 8, C.GOLD_D); b.rect(x - 2, y - 2, w + 4, h + 4, C.GOLD); b.hline(x - 2, x + w + 1, y - 2, C.GOLD_L);
    b.rect(x, y, w, h, C.BLU_D); b.hline(x, x + w - 1, y, C.BLU);
    const r = rng(5);
    for (let k = 0; k < 4; k++) { const cx = x + 20 + k * 40; for (let s = 0; s < 6; s++) { const a = r() * 6.28, L = 4 + r() * 6; b.line(cx + Math.round(Math.cos(a) * 2), y + 11 + Math.round(Math.sin(a) * 2), cx + Math.round(Math.cos(a) * L), y + 11 + Math.round(Math.sin(a) * L * 0.8), C.GOLD_L); } }
  }

  // ── 4. three-step white-marble dais (须弥座): a wide platform for the throne, two lower steps in front ──
  const tiers = [
    { x0: 352, x1: 928, ty: 176, fy: 286, fh: 18 },
    { x0: 400, x1: 880, ty: 176, fy: 264, fh: 18 },
    { x0: 448, x1: 832, ty: 176, fy: 242, fh: 18 },
  ];
  // one shadow for the whole dais, falling to the lower right
  shade(b, [[928, 190], [946, 206], [946, 318], [372, 318], [352, 304]], DARK, 2);
  for (const t of tiers) {
    b.rect(t.x0, t.ty, t.x1 - t.x0, t.fy - t.ty, C.JADE);
    for (let x = t.x0 + 4; x < t.x1 - 6; x += 32) for (let y = t.ty + 4; y < t.fy - 6; y += 32) { b.hline(x, x + 30, Math.min(t.fy - 2, y + 30), C.PLASTER_S); b.vline(x + 30, y, Math.min(t.fy - 2, y + 30), C.PLASTER_S); }
    b.rect(t.x0, t.fy, t.x1 - t.x0, t.fh, C.STONE_L);
    b.hline(t.x0, t.x1 - 1, t.fy, C.PAPER);
    b.hline(t.x0, t.x1 - 1, t.fy + 3, C.STONE);
    b.hline(t.x0, t.x1 - 1, t.fy + t.fh - 1, C.STONE);
    for (let x = t.x0 + 10; x < t.x1 - 36; x += 40) { frame(b, x, t.fy + 6, 32, t.fh - 9, C.STONE); b.ellipse(x + 16, t.fy + 10, 7, 2, C.STONE); b.set(x + 16, t.fy + 10, C.JADE); }
    b.vline(t.x0, t.ty, t.fy + t.fh - 1, C.STONE_L); b.vline(t.x1 - 1, t.ty, t.fy + t.fh - 1, C.STONE);
  }
  // carved balustrades (望柱 + 栏板) along the front edge of each step, and back along the sides
  for (const t of tiers) {
    const y = t.fy - 3;
    for (const [a, z] of [[t.x0 + 3, 598], [682, t.x1 - 4]]) {
      b.rect(a, y - 7, z - a, 7, C.PAPER); b.hline(a, z - 1, y, C.STONE); b.hline(a, z - 1, y - 3, C.PLASTER_S);
      for (let x = a; x <= z; x += 24) { b.rect(x - 3, y - 13, 7, 14, C.JADE); b.vline(x + 3, y - 13, y, C.STONE_L); b.ellipse(x, y - 14, 4, 3, C.PAPER); b.set(x + 2, y - 13, C.STONE_L); }
    }
    for (const x of [t.x0 + 3, t.x1 - 4]) { b.rect(x - 2, t.ty + 2, 5, t.fy - t.ty - 5, C.PAPER); b.vline(x + 2, t.ty + 2, t.fy - 4, C.STONE_L); for (let y = t.ty + 8; y < t.fy - 6; y += 24) { b.ellipse(x, y, 4, 3, C.JADE); b.set(x + 1, y + 1, C.STONE_L); } }
  }
  // central staircase with the carved 御路 slab
  for (let y = 242, k = 0; y < 304; y += 6, k++) { b.rect(600, y, 80, 6, k % 2 ? C.STONE_L : C.JADE); b.hline(600, 679, y + 5, C.STONE); }
  b.rect(620, 242, 40, 62, C.STONE_L); frame(b, 620, 242, 40, 62, C.STONE);
  for (let y = 250; y < 300; y += 12) { b.ellipse(640, y, 12, 4, C.JADE); b.ellipse(640, y, 7, 2, C.PLASTER_S); b.set(634 + ((y / 12) % 2) * 12, y - 1, C.GOLD_D); }
  for (const x of [596, 680]) { b.rect(x, 238, 4, 66, C.STONE); b.ellipse(x + 2, 237, 4, 3, C.PAPER); }

  // gilded dragon columns flanking the throne
  function dragonPillar(cx, base, h = 120) {
    const x = cx - 9, top = base - h;
    b.ellipse(cx + 8, base + 2, 14, 4, C.STONE_L);
    b.rect(x, top, 18, h, C.GOLD); b.rect(x + 2, top, 3, h, C.GOLD_L); b.rect(x + 13, top, 5, h, C.GOLD_D);
    for (let y = top + 6; y < base - 8; y += 3) { const dx = Math.round(Math.sin((y - top) / 10) * 7); b.ellipse(cx + dx, y, 4, 2, C.RED); b.set(cx + dx - 1, y - 1, C.RED_L); }
    b.ellipse(cx, base - 2, 14, 5, C.STONE); b.ellipse(cx, base - 3, 12, 4, C.JADE);
    b.rect(x - 4, top - 8, 26, 8, C.GOLD_D); b.hline(x - 4, x + 21, top - 8, C.GOLD);
  }
  // ── 5. throne, desk with memorials ──
  dragonPillar(530, 232);
  dragonPillar(750, 232);
  throneCouch(b, 640, 200);
  { // 御案: low desk seen from above, with stacks of memorials, inkstone, brush and seal
    const x = 584, y = 226, w = 112, h = 14;
    b.rect(x, y, w, h, C.RED_D); b.rect(x + 2, y + 1, w - 4, h - 5, C.RED); b.hline(x + 2, x + w - 3, y + 1, C.RED_L);
    b.rect(x, y + h - 3, w, 3, C.DBROWN);
    for (const sx of [x + 8, x + 22]) for (let k = 0; k < 4; k++) { b.rect(sx, y - 2 - k * 2, 11, 3, k % 2 ? C.PAPER : C.GOLD_L); b.hline(sx, sx + 10, y - k * 2, C.PLASTER_S); }
    b.rect(x + 82, y + 3, 18, 6, C.BLACK); b.rect(x + 84, y + 4, 6, 4, C.DEEP);
    b.line(x + 60, y + 4, x + 74, y + 8, C.BROWN); b.set(x + 74, y + 8, C.BLACK);
    b.rect(x + 46, y + 2, 8, 7, C.GOLD); b.set(x + 47, y + 2, C.GOLD_L);
  }

  // ── 6. the imperial path carpet ──
  {
    const x = 592, w = 96, y = 304;
    b.rect(x, y, w, H - y, C.RED);
    b.rect(x, y, 5, H - y, C.GOLD_D); b.rect(x + w - 5, y, 5, H - y, C.GOLD_D);
    b.vline(x + 6, y, H - 1, C.GOLD); b.vline(x + w - 7, y, H - 1, C.GOLD);
    for (let yy = y + 26; yy < H; yy += 52) {
      const cx = x + w / 2;
      b.ellipse(cx, yy, 14, 12, C.RED_M);
      for (let a = 0; a < 6; a++) b.ellipse(cx + Math.round(Math.cos(a * 1.047) * 10), yy + Math.round(Math.sin(a * 1.047) * 9), 3, 3, C.GOLD);
      b.ellipse(cx, yy, 4, 4, C.GOLD_L); b.set(cx, yy, C.RED);
    }
    dith(b, x + 8, y, w - 16, H - y, C.RED_M, 9);
  }

  // ── 7. light falling through the back windows onto the floor ──
  if (!NIGHT) {
    shade(b, [[70, 200], [260, 200], [420, 560], [230, 560]], LIGHT, 2);
    shade(b, [[1020, 200], [1210, 200], [1050, 560], [860, 560]], LIGHT, 2);
  }

  // ── 8. round vermilion columns (two rows down each side), with shadows ──

  for (const [cx, base] of [[150, 380], [1130, 380], [150, 620], [1130, 620]]) pillar(b, cx, base);

  // ── 9. bronze lamp trees, incense burners, cranes on the dais ──
  lampTree(b, 340, 330);
  lampTree(b, 940, 330);
  for (const cx of [340, 940]) shade(b, [[cx - 14, 330], [cx + 16, 326], [cx + 40, 346], [cx + 4, 350]], DARK, 2);
  boshanlu(b, 424, 258);
  boshanlu(b, 856, 258);

  crane(b, 476, 236, -1);
  crane(b, 804, 236, 1);
  for (const cx of [540, 740]) { b.ellipse(cx, 196, 10, 4, C.BROWN); b.ellipse(cx, 188, 9, 7, C.BRONZE); b.ellipse(cx - 2, 186, 5, 3, C.GOLD_D); b.ellipse(cx + 4, 180, 4, 4, C.BRONZE); b.set(cx + 5, 178, C.GOLD); }

  // ── 10. side walls and the front threshold (3/4 view: thin dark rims) ──
  for (const [x, w] of [[0, 18], [W - 18, 18]]) { b.rect(x, 76, w, H - 76, C.RED_D); b.rect(x + (x ? 0 : w - 4), 76, 4, H - 76, C.RED); }
  b.rect(0, H - 10, W, 10, C.RED_D); b.hline(0, W - 1, H - 10, C.RED);
  b.rect(584, H - 10, 112, 10, C.DEEP); // the open front doors (to 太和殿广场)
  // side door to 军机处 on the left wall
  b.rect(0, 420, 18, 90, C.DEEP); b.rect(14, 420, 4, 90, C.GOLD_D);


  // door to 东宫 on the right wall
  doorway(b, W - 18, 420, 18, 90);
  const half = (p) => p.map(([x, y]) => [x / 2, y / 2]);
  return {
    bg: b,
    spots: {
      walk: { x0: 14, x1: 626, y0: 156, y1: 352 },
      throne: { x: 320, y: 114, foot: 156 },
      desk: [320, 116],
      emperorStart: [320, 300],
      lamps: half([...LAMP_CUPS(340, 330), ...LAMP_CUPS(940, 330)]),
      incense: [[212, 105], [428, 105]],
      lanterns: [[86, 4], [236, 4], [404, 4], [554, 4]],
      doors: { guangchang: [292, 350, 56, 10], junjichu: [0, 210, 12, 45], donggong: [628, 210, 12, 45] },
      // court ranks: 文东 (east, facing left) and 武西 (west, facing right)
      east: [[390, 226], [444, 226], [390, 280], [444, 280], [390, 334], [444, 334]],
      west: [[250, 226], [196, 226], [250, 280], [196, 280], [250, 334]],
      prince: [278, 141],
      fans: [[283, 98], [357, 98]],
      guards: [[150, 168], [490, 168], [130, 350], [510, 350]],
      // where a memorial is presented (the kneeling spot at the foot of the steps) and where the eunuch waits
      kneel: [320, 176],
      eunuch: [362, 141],
      // queue for officials waiting to be received (outside the doors)
      queue: [[300, 352], [340, 352]],
      // when court is not sitting: a eunuch sweeps the floor by day, maids light the lamp trees at dusk,
      // and a night watchman walks the hall with a lantern
      npcs: [
        { kind: 'eunuch', x: 96, y: 300, facing: 'right', act: 'sweep', route: [[96, 300], [176, 304], [176, 334], [96, 330]] },
        { kind: 'lady', x: 196, y: 172, facing: 'left', act: 'lamp' },
        { kind: 'lady', x: 444, y: 172, facing: 'right', act: 'lamp' },
        { kind: 'eunuch', x: 560, y: 330, facing: 'left', act: 'patrol', route: [[560, 330], [560, 200], [80, 200], [80, 330]] },
      ],
    },
  };
}
