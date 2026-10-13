// 东宫 — the crown prince's study, top-down 3/4 view. Bookcase wall on the left, a folding screen behind
// the prince's desk, a lattice window onto a small bamboo garden on the right, a qin table under it,
// a tea table, an incense stand and candle stands. Door to 太和殿 on the left wall.
import { Bitmap, C, rng, W, H, dith, frame, shade, DARK, LIGHT, doorway } from './common.mjs';
import { plaster, coffers } from '../scenes.mjs';

/** plank floor seen from above: long warm boards running left–right, staggered butt joints, faint grain */
function plankFloor(b, x0, y0, x1, y1, seed = 9) {
  const r = rng(seed), PH = 24;
  b.rect(x0, y0, x1 - x0, y1 - y0, C.BROWN);
  for (let y = y0, row = 0; y < y1; y += PH, row++) {
    b.hline(x0, x1 - 1, y, C.DBROWN);
    b.hline(x0, x1 - 1, y + 1, C.WOOD);
    let x = x0 - Math.floor(r() * 200);
    while (x < x1) {
      const L = 180 + Math.floor(r() * 140);
      b.vline(x, y + 1, y + PH - 1, C.DBROWN);
      if (r() < 0.22) dith(b, x + 1, y + 2, L - 2, PH - 3, C.DBROWN, 4, row); // a darker board now and then
      for (let k = 0; k < 2; k++) { const gy = y + 6 + Math.floor(r() * (PH - 10)), gx = x + 10 + Math.floor(r() * (L - 70)); b.hline(gx, gx + 24 + Math.floor(r() * 30), gy, C.DBROWN); }
      x += L;
    }
  }
}

/** 落地宫灯: a hexagonal palace lantern on a carved stand; returns the flame point */
function floorLantern(b, cx, base) {
  b.ellipse(cx, base - 3, 14, 4, C.DBROWN); b.ellipse(cx, base - 4, 10, 2, C.BROWN);
  for (const dx of [-12, 12]) b.line(cx + dx, base - 2, cx, base - 18, C.DBROWN);
  b.rect(cx - 2, base - 96, 4, 92, C.DBROWN); b.vline(cx - 2, base - 96, base - 5, C.WOOD);
  b.line(cx, base - 96, cx + 14, base - 104, C.DBROWN); b.line(cx, base - 96, cx - 14, base - 104, C.DBROWN);
  const ly = base - 150, w = 16;
  b.rect(cx - w - 2, ly - 4, 2 * w + 5, 5, C.DBROWN); b.hline(cx - w - 2, cx + w + 2, ly - 4, C.WOOD);
  b.rect(cx - w, ly + 1, 2 * w + 1, 40, C.RED); b.rect(cx - w + 4, ly + 4, 9, 34, C.GLOW); b.rect(cx + 3, ly + 4, 9, 34, C.GOLD_L);
  b.vline(cx - w + 4, ly + 4, ly + 37, C.PAPER);
  for (const vx of [cx - w, cx - 2, cx + w - 3]) b.rect(vx, ly + 1, 3, 40, C.DBROWN);
  b.rect(cx + w - 6, ly + 4, 3, 34, C.RED_M);
  b.rect(cx - w - 2, ly + 41, 2 * w + 5, 5, C.DBROWN); b.hline(cx - w - 2, cx + w + 2, ly + 41, C.WOOD);
  for (const tx of [cx - w, cx, cx + w]) { b.vline(tx, ly + 46, ly + 58, C.RED); b.set(tx, ly + 59, C.GOLD); }
  b.rect(cx - 3, ly - 10, 7, 6, C.GOLD_D); b.set(cx - 2, ly - 10, C.GOLD);
  b.vline(cx, ly + 46, base - 96, C.DBROWN);
  return [cx, ly + 20];
}

/** 多宝格 bookcase against the back wall: irregular compartments with thread-bound books, cases, scrolls and curios */
function bookcase(b, x, y, w, h, seed = 3) {
  const r = rng(seed);
  b.rect(x - 4, y - 6, w + 8, 6, C.WOOD); b.hline(x - 4, x + w + 3, y - 6, C.WOOD_L); // top board seen from above
  b.rect(x, y, w, h, C.DBROWN);
  b.vline(x, y, y + h - 1, C.WOOD); b.vline(x + w - 1, y, y + h - 1, C.DEEP);
  const rows = 4, rh = Math.floor((h - 8) / rows);
  for (let k = 0; k < rows; k++) {
    const ry = y + 4 + k * rh;
    // compartment widths vary per row
    let cx = x + 4;
    const cells = [];
    while (cx < x + w - 30) { const cw = Math.min(x + w - 4 - cx, 50 + Math.floor(r() * 50)); cells.push([cx, cw]); cx += cw; }
    if (cx < x + w - 4) cells[cells.length - 1][1] += x + w - 4 - cx;
    for (const [px, pw] of cells) {
      b.rect(px + 3, ry + 3, pw - 6, rh - 6, C.DEEP);
      b.hline(px + 3, px + pw - 4, ry + 3, C.BLACK);
      const iy = ry + rh - 4; // shelf surface
      const kind = Math.floor(r() * 6);
      if (kind <= 1) { // stacks of thread-bound books lying flat
        let sx = px + 6;
        while (sx < px + pw - 26) {
          const bw = 18 + Math.floor(r() * 6), n = 2 + Math.floor(r() * 4);
          for (let i = 0; i < n; i++) { const by = iy - 4 - i * 4; const cv = r() < 0.7 ? C.BLU_D : C.TILE; b.rect(sx, by, bw, 4, C.PAPER); b.hline(sx, sx + bw - 1, by, cv); b.hline(sx, sx + bw - 1, by + 3, cv); b.set(sx + bw - 1, by + 1, C.STONE_L); }
          sx += bw + 4;
        }
      } else if (kind <= 3) { // books upright in blue cloth cases 函套 with bone clasps
        let sx = px + 6;
        while (sx < px + pw - 10) {
          const bw = 6 + Math.floor(r() * 4), bh = rh - 12 - Math.floor(r() * 6);
          const c = [C.BLU_D, C.BLU, C.TILE_D, C.GOLD_D, C.BLU_D][Math.floor(r() * 5)];
          b.rect(sx, iy - bh, bw, bh, c); b.vline(sx, iy - bh, iy - 1, c === C.GOLD_D ? C.GOLD : C.BLU);
          b.set(sx + bw - 2, iy - bh + 4, C.JADE); b.set(sx + bw - 2, iy - 6, C.JADE);
          if (r() < 0.3) { b.rect(sx + 2, iy - bh + 3, 2, 6, C.PAPER); }
          sx += bw + 1;
        }
      } else if (kind === 4) { // rolled scrolls stacked, seen end-on
        for (let i = 0; i < 2; i++) for (let sx = px + 9 + i * 5; sx < px + pw - 8; sx += 10) { const yy = iy - 5 - i * 8; b.ellipse(sx, yy, 4, 4, C.DBROWN); b.ellipse(sx, yy, 3, 3, [C.PAPER, C.GOLD_L, C.JADE][Math.floor(r() * 3)]); b.set(sx, yy, C.RED_D); }
      } else { // a curio: celadon vase or bronze vessel
        const vx = px + Math.floor(pw / 2);
        if (r() < 0.5) {
          b.ellipse(vx, iy - 10, 8, 9, C.TEAL); b.rect(vx - 3, iy - 24, 7, 8, C.TEAL); b.ellipse(vx, iy - 24, 5, 2, C.SKY);
          b.ellipse(vx - 3, iy - 12, 2, 4, C.SKY); b.vline(vx + 6, iy - 14, iy - 6, C.BLU_D); b.rect(vx - 6, iy - 2, 13, 2, C.DBROWN);
        } else {
          b.rect(vx - 9, iy - 14, 19, 11, C.BRONZE); b.hline(vx - 10, vx + 10, iy - 14, C.GOLD); b.rect(vx - 7, iy - 3, 3, 3, C.GOLD_D); b.rect(vx + 5, iy - 3, 3, 3, C.GOLD_D);
          b.rect(vx - 8, iy - 18, 3, 4, C.GOLD_D); b.rect(vx + 6, iy - 18, 3, 4, C.GOLD_D); b.hline(vx - 7, vx + 7, iy - 9, C.GOLD_D); b.vline(vx + 9, iy - 13, iy - 4, C.BROWN);
        }
      }
      b.vline(px + pw - 1, ry, ry + rh, C.WOOD); b.vline(px + pw, ry, ry + rh, C.DBROWN);
    }
    b.rect(x + 2, ry + rh - 4, w - 4, 4, C.WOOD); b.hline(x + 2, x + w - 3, ry + rh - 4, C.WOOD_L);
  }
  b.rect(x, y + h - 6, w, 6, C.DBROWN); b.hline(x, x + w - 1, y + h - 6, C.BROWN);
}

/** five-panel lacquer folding screen 围屏 painted with plum blossom and bamboo; feet stand at `base` */
function screen(b, x, y, w, base) {
  const h = base - y - 8, n = 5, pw = Math.floor(w / n);
  b.rect(x - 4, y - 4, w + 8, h + 8, C.RED_D);
  for (let k = 0; k < n; k++) {
    const px = x + k * pw;
    b.rect(px + 3, y + 2, pw - 6, h - 4, C.PAPER);
    b.rect(px + 3, y + h - 22, pw - 6, 16, C.PLASTER_S); // lower apron panel
    for (let i = px + 7; i < px + pw - 7; i += 8) b.ellipse(i, y + h - 14, 2, 3, C.GOLD_D);
    b.hline(px + 3, px + pw - 4, y + h - 23, C.GOLD);
    if (k % 2) dith(b, px + 3, y + 2, pw - 6, h - 26, C.PLASTER_S, 3); // panels folded away from the light
    b.rect(px, y - 2, 3, h + 4, C.GOLD_D); b.vline(px + 1, y - 2, y + h + 1, C.GOLD);
  }
  b.rect(x + w - 1, y - 2, 3, h + 4, C.GOLD_D);
  b.hline(x - 4, x + w + 3, y - 4, C.RED); b.hline(x - 4, x + w + 3, y - 2, C.GOLD);
  // painting: a plum branch sweeping across, bamboo on the right, a pale moon
  b.ellipse(x + 58, y + 30, 16, 16, C.SKY_L); b.ellipse(x + 55, y + 27, 13, 13, C.JADE);
  const top = y + 8, bot = y + h - 26;
  const branch = [[x + 6, bot - 10], [x + 60, bot - 30], [x + 110, bot - 52], [x + 150, top + 30], [x + 210, top + 18]];
  for (let i = 0; i + 1 < branch.length; i++) { const [a, c] = [branch[i], branch[i + 1]]; b.line(a[0], a[1], c[0], c[1], C.DBROWN); b.line(a[0], a[1] + 1, c[0], c[1] + 1, C.BROWN); }
  b.line(x + 110, bot - 52, x + 130, bot - 18, C.DBROWN); b.line(x + 60, bot - 30, x + 70, top + 30, C.DBROWN);
  const r = rng(12);
  for (let k = 0; k < 26; k++) {
    const s = branch[1 + Math.floor(r() * 3)], t = branch[2 + Math.floor(r() * 2)], u = r();
    const px = Math.round(s[0] + (t[0] - s[0]) * u + (r() - 0.5) * 14), py = Math.round(s[1] + (t[1] - s[1]) * u + (r() - 0.5) * 12);
    if (px % pw < 6 || (px - x) % pw > pw - 6) continue;
    b.ellipse(px, py, 2, 2, C.PINK); b.set(px, py, C.RED); b.set(px - 1, py - 1, C.JADE);
  }
  for (const [bx, lean] of [[x + w - 56, 0.08], [x + w - 40, -0.05], [x + w - 26, 0.1]]) {
    for (let yy = top; yy < bot; yy++) { const xx = Math.round(bx + (yy - top) * lean); b.set(xx, yy, C.GRN); b.set(xx + 1, yy, C.GRN_D); if ((yy - top) % 18 === 0) b.hline(xx - 1, xx + 2, yy, C.GRN_D); }
    for (let k = 0; k < 7; k++) { const ly = top + 6 + k * 13, lx = Math.round(bx + (ly - top) * lean); b.line(lx, ly, lx - 9, ly + 4, C.GRN_D); b.line(lx + 1, ly + 2, lx + 10, ly + 6, C.GRN); }
  }
  // stand and feet
  b.rect(x - 6, base - 8, w + 12, 6, C.DBROWN); b.hline(x - 6, x + w + 5, base - 8, C.RED_D);
  for (let k = 0; k <= n; k++) { const fx = x + k * pw; b.rect(fx - 6, base - 4, 13, 4, C.DBROWN); b.hline(fx - 6, fx + 6, base - 4, C.BROWN); }
}

/** the window bay: a carved lattice frame opening onto a bamboo garden */
function gardenWindow(b, x, y, w, h) {
  // outside: sky, white garden wall with grey tile coping, a Taihu rock, bamboo
  b.rect(x, y, w, h, C.SKY_L);
  b.rect(x, y + 22, w, h - 22, C.JADE);
  b.rect(x, y + 16, w, 7, C.TILE); for (let i = x; i < x + w; i += 6) { b.vline(i, y + 16, y + 22, C.TILE_D); b.set(i + 3, y + 16, C.TILE_L); }
  b.hline(x, x + w - 1, y + 23, C.STONE);
  b.rect(x, y + h - 18, w, 18, C.GRN_D); dith(b, x, y + h - 22, w, 4, C.GRN_D, 2);
  for (let i = x; i < x + w; i += 3) if ((i * 7) % 5 < 2) b.set(i, y + h - 18, C.GRN);
  // Taihu rock
  b.poly([[x + 30, y + h - 6], [x + 22, y + h - 40], [x + 38, y + h - 62], [x + 52, y + h - 54], [x + 64, y + h - 70], [x + 76, y + h - 46], [x + 70, y + h - 6]], C.STONE);
  b.line(x + 22, y + h - 40, x + 38, y + h - 62, C.STONE_L); b.line(x + 38, y + h - 62, x + 52, y + h - 54, C.STONE_L);
  for (const [hx, hy, rx, ry] of [[x + 44, y + h - 40, 5, 4], [x + 60, y + h - 26, 4, 6], [x + 36, y + h - 20, 3, 3]]) { b.ellipse(hx, hy, rx, ry, C.STONE_D); b.ellipse(hx - 1, hy - 1, rx - 1, ry - 1, C.TILE_D); }
  b.vline(x + 72, y + h - 44, y + h - 8, C.STONE_D);
  // bamboo grove: stems with nodes, leaves in fans
  const r = rng(31);
  for (let k = 0; k < 12; k++) {
    const bx = x + 90 + k * 20 + Math.floor(r() * 10), lean = (r() - 0.5) * 0.12, tone = k % 3 === 0 ? [C.GRN_D, C.GRN_D] : [C.GRN, C.GRN_L];
    for (let yy = y + h - 10; yy > y + 4; yy--) { const xx = Math.round(bx + (y + h - yy) * lean); b.set(xx, yy, tone[0]); b.set(xx + 1, yy, tone[1]); b.set(xx + 2, yy, tone[0]); if ((yy + k * 5) % 22 === 0) b.hline(xx - 1, xx + 3, yy, C.GRN_D); }
  }
  for (let k = 0; k < 90; k++) {
    const lx = x + 70 + Math.floor(r() * (w - 70)), ly = y + 4 + Math.floor(r() * (h - 40)), s = r() < 0.5 ? -1 : 1;
    const c = r() < 0.4 ? C.GRN_D : r() < 0.7 ? C.GRN : C.GRN_L;
    b.line(lx, ly, lx + s * 7, ly + 3, c); b.line(lx, ly + 1, lx + s * 6, ly + 3, c);
  }
  // window frame + side lattice leaves (步步锦), the centre left open
  b.rect(x - 10, y - 10, w + 20, 10, C.RED_D); b.rect(x - 10, y + h, w + 20, 12, C.RED_D);
  b.rect(x - 10, y - 10, 10, h + 22, C.RED_D); b.rect(x + w, y - 10, 10, h + 22, C.RED_D);
  b.hline(x - 10, x + w + 9, y - 10, C.RED); b.vline(x - 10, y - 10, y + h + 11, C.RED); b.hline(x - 8, x + w + 8, y + h + 2, C.RED);
  const leaf = (lx, lw) => {
    b.rect(lx, y, lw, h, C.PAPER);
    for (let i = lx + 2; i < lx + lw - 1; i += 9) b.vline(i, y, y + h - 1, C.BROWN);
    for (let j = y + 6; j < y + h; j += 12) for (let i = lx + (((j - y) / 12) % 2 ? 2 : 6); i < lx + lw - 2; i += 9) b.hline(i, i + 4, j, C.BROWN);
    frame(b, lx, y, lw, h, C.RED_M); frame(b, lx + 1, y + 1, lw - 2, h - 2, C.RED);
    b.hline(lx + 1, lx + lw - 2, y + Math.floor(h / 2), C.RED);
  };
  leaf(x, 52); leaf(x + w - 52, 52);
  b.rect(x + 52, y, 3, h, C.RED_M); b.rect(x + w - 55, y, 3, h, C.RED_M);
}

/** a tall bronze pricket candle stand; returns the candle tip (bg px) */
function candleStand(b, cx, base, h = 74) {
  b.ellipse(cx, base - 3, 12, 4, C.BRONZE); b.ellipse(cx, base - 4, 9, 2, C.GOLD_D);
  for (const dx of [-9, 0, 9]) b.rect(cx + dx - 1, base - 3, 3, 3, C.BROWN);
  b.rect(cx - 2, base - h, 4, h - 4, C.BRONZE); b.vline(cx - 2, base - h, base - 5, C.GOLD);
  b.ellipse(cx, base - 40, 4, 2, C.GOLD_D);
  b.ellipse(cx, base - h, 10, 3, C.BRONZE); b.hline(cx - 9, cx + 9, base - h - 1, C.GOLD);
  b.rect(cx - 3, base - h - 18, 6, 17, C.RED); b.vline(cx - 3, base - h - 18, base - h - 2, C.RED_L); b.vline(cx + 2, base - h - 18, base - h - 2, C.RED_M);
  b.set(cx, base - h - 19, C.BLACK);
  return [cx, base - h - 20];
}

/** 香几 incense stand with a tripod censer on top; returns the smoke point */
function censerStand(b, cx, base) {
  // three curved legs on a ring foot, round top
  b.ellipse(cx, base - 2, 16, 4, C.DBROWN); b.ellipse(cx, base - 3, 13, 2, C.BROWN);
  for (const dx of [-13, 0, 13]) { b.line(cx + dx, base - 4, cx + Math.round(dx * 0.8), base - 62, C.DBROWN); b.line(cx + dx + 1, base - 4, cx + Math.round(dx * 0.8) + 1, base - 62, dx < 0 ? C.WOOD : C.BROWN); b.line(cx + dx + 2, base - 4, cx + Math.round(dx * 0.8) + 2, base - 62, C.DBROWN); }
  b.ellipse(cx, base - 34, 13, 3, C.DBROWN); b.hline(cx - 12, cx + 2, base - 35, C.WOOD);
  b.ellipse(cx, base - 64, 22, 7, C.DBROWN); b.ellipse(cx, base - 66, 22, 6, C.WOOD); b.ellipse(cx - 4, base - 67, 12, 3, C.WOOD_L);
  // censer 鼎: round belly, two upright handles, three feet, pierced lid with a knob
  const t = base - 68;
  for (const dx of [-9, 0, 9]) b.rect(cx + dx - 1, t - 5, 3, 5, C.BROWN);
  b.ellipse(cx, t - 13, 14, 10, C.BRONZE); b.ellipse(cx - 5, t - 16, 5, 4, C.GOLD); b.hline(cx - 13, cx + 13, t - 12, C.GOLD_D);
  b.vline(cx + 12, t - 18, t - 6, C.BROWN); b.vline(cx + 13, t - 16, t - 8, C.BROWN);
  for (const dx of [-14, 12]) { b.rect(cx + dx, t - 31, 3, 10, C.BRONZE); b.set(cx + dx, t - 31, C.GOLD); b.set(cx + dx + 2, t - 28, C.BROWN); }
  b.ellipse(cx, t - 22, 13, 4, C.GOLD_D); b.ellipse(cx, t - 25, 9, 4, C.BRONZE); b.ellipse(cx - 2, t - 26, 4, 2, C.GOLD);
  for (const dx of [-5, 0, 5]) b.set(cx + dx, t - 24, C.DEEP);
  b.ellipse(cx, t - 30, 3, 3, C.GOLD); b.set(cx - 1, t - 31, C.GOLD_L);
  return [cx, t - 33];
}

export function donggong() {
  const b = new Bitmap(W, H);
  // ── 1. coffered ceiling and a painted beam (苏式彩画) with a small 包袱 landscape panel over the seat ──
  coffers(b, 0, W, 0, 24, 24);
  b.rect(0, 22, W, 22, C.BLU_D);
  b.rect(0, 24, W, 17, C.BLU); b.hline(0, W - 1, 24, C.SKY); b.hline(0, W - 1, 41, C.BLU_D); b.hline(0, W - 1, 43, C.GOLD_D);
  for (const [a, z] of [[0, 404], [420, 860], [876, W]]) {
    for (const ex of [a + 4, z - 40]) { b.rect(ex, 25, 36, 16, C.GRN); b.hline(ex, ex + 35, 25, C.GRN_L); for (let k = 0; k < 3; k++) b.ellipse(ex + 6 + k * 12, 33, 4, 4, C.TEAL); for (let k = 0; k < 3; k++) b.set(ex + 6 + k * 12, 33, C.GOLD_L); }
    b.vline(a + 41, 24, 41, C.GOLD); b.vline(z - 45, 24, 41, C.GOLD);
    for (let x = a + 52; x < z - 52; x += 14) b.set(x, 32 + ((x / 14) % 2 < 1 ? 0 : 1), C.GOLD);
  }
  {
    const cx = 640, hw = 84, d = 26;
    for (let i = -hw; i <= hw; i++) { const dy = Math.round(Math.sqrt(Math.max(0, 1 - (i / hw) ** 2)) * d); b.vline(cx + i, 24, 24 + dy, C.SKY_L); b.set(cx + i, 25 + dy, C.GOLD); b.set(cx + i, 26 + dy, C.GOLD_D); }
    for (let i = -60; i <= 60; i++) { const t = Math.abs(Math.sin(i / 11)) * 7 + Math.abs(Math.sin(i / 5)) * 2; for (let y = Math.round(40 - t); y < 44 - Math.abs(i) / 14; y++) b.set(cx + i, y, y < 38 - t / 2 ? C.TEAL : C.GRN); }
    b.ellipse(cx + 40, 31, 3, 3, C.RED_L);
  }
  // ── 2. back wall: plaster between red posts ──
  plaster(b, 0, 44, W, 152);
  for (const x of [18, 404, 860, 1246]) { b.rect(x, 44, 16, 152, C.RED); b.vline(x + 2, 44, 195, C.RED_L); b.rect(x + 12, 44, 4, 152, C.RED_D); }
  b.rect(0, 190, W, 10, C.RED_D); b.hline(0, W - 1, 190, C.RED); // skirting

  // ── 3. floor: warm wooden boards ──
  plankFloor(b, 0, 200, W, H, 9);
  dith(b, 0, 200, W, 8, C.DEEP, 2);

  // ── 4. a blue and gold carpet in front of the desk ──
  {
    const x = 404, y = 344, w = 472, h = 260;
    b.rect(x, y, w, h, C.GOLD_D);
    b.rect(x + 3, y + 3, w - 6, h - 6, C.BLU_D);
    b.rect(x + 10, y + 10, w - 20, h - 20, C.GOLD); b.rect(x + 12, y + 12, w - 24, h - 24, C.BLU_D);
    // 回纹 key-fret border
    for (let i = x + 16; i < x + w - 22; i += 12) for (const yy of [y + 4, y + h - 9]) { b.hline(i, i + 7, yy, C.GOLD); b.vline(i + 7, yy, yy + 4, C.GOLD); b.hline(i + 3, i + 7, yy + 4, C.GOLD); }
    for (let j = y + 18; j < y + h - 22; j += 12) for (const xx of [x + 4, x + w - 9]) { b.vline(xx, j, j + 7, C.GOLD); b.hline(xx, xx + 4, j + 7, C.GOLD); b.vline(xx + 4, j + 3, j + 7, C.GOLD); }
    b.rect(x + 18, y + 18, w - 36, h - 36, C.BLU);
    dith(b, x + 18, y + 18, w - 36, h - 36, C.BLU_D, 5);
    // field: a lattice of small gold blossoms and cloud scrolls
    for (let j = y + 40, row = 0; j < y + h - 30; j += 34, row++) for (let i = x + 44 + (row % 2) * 30; i < x + w - 36; i += 60) {
      if (Math.abs(i - (x + w / 2)) < 90 && Math.abs(j - (y + h / 2)) < 70) continue;
      for (let a = 0; a < 4; a++) b.set(i + Math.round(Math.cos(a * 1.57) * 3), j + Math.round(Math.sin(a * 1.57) * 2), C.GOLD_D);
      b.set(i, j, C.GOLD);
    }
    // central medallion and corner quarters (宝相花)
    const med = (cx, cy, R) => {
      b.ellipse(cx, cy, R, Math.round(R * 0.8), C.GOLD_D); b.ellipse(cx, cy, R - 3, Math.round(R * 0.8) - 3, C.BLU_D);
      for (let a = 0; a < 12; a++) b.ellipse(cx + Math.round(Math.cos(a * 0.524) * (R - 12)), cy + Math.round(Math.sin(a * 0.524) * (R - 12) * 0.8), 5, 4, C.GOLD);
      b.ellipse(cx, cy, Math.round(R / 3), Math.round(R / 4), C.RED_M); b.ellipse(cx, cy, Math.round(R / 5), Math.round(R / 6), C.GOLD_L);
    };
    med(x + w / 2, y + h / 2, 60);
    for (const [cx, cy] of [[x + 18, y + 18], [x + w - 18, y + 18], [x + 18, y + h - 18], [x + w - 18, y + h - 18]]) {
      for (let a = 0; a < 16; a++) { const px = cx + Math.round(Math.cos(a * 0.39) * 26), py = cy + Math.round(Math.sin(a * 0.39) * 20); if (px > x + 17 && px < x + w - 17 && py > y + 17 && py < y + h - 17) b.ellipse(px, py, 3, 3, C.GOLD); }
    }
    b.hline(x, x + w - 1, y, C.GOLD); // lit top edge
  }

  // ── 5. daylight through the garden window, barred by the lattice ──
  {
    const m = new Bitmap(W, H);
    m.poly([[886, 200], [1236, 200], [1080, 600], [700, 600]], 1);
    for (let y = 200; y < 600; y++) for (let x = 600; x < 1240; x++) {
      if (!m.get(x, y)) continue;
      const u = x + (y - 200) * 0.45; // lattice bars slant with the light
      if (((u | 0) % 46) < 6 || ((y - 200) % 64) < 4) continue;
      if ((x + y) % 2 === 0) { const v = b.get(x, y); if (LIGHT[v] !== undefined) b.set(x, y, LIGHT[v]); }
    }
  }

  // ── 6. bookcase wall (left bay) and a porcelain jar of scrolls ──
  bookcase(b, 40, 52, 356, 150, 3);
  shade(b, [[40, 202], [396, 202], [410, 216], [52, 216]], DARK, 2);
  { // blue and white 画缸 crammed with rolled paintings
    const cx = 380, base = 262;
    shade(b, [[cx - 6, base], [cx + 22, base - 4], [cx + 46, base + 14], [cx + 12, base + 18]], DARK, 2);
    b.ellipse(cx, base - 22, 22, 22, C.JADE); b.rect(cx - 22, base - 22, 45, 18, C.JADE); b.ellipse(cx, base - 4, 18, 4, C.JADE);
    b.ellipse(cx + 8, base - 18, 12, 18, C.PLASTER_S); b.ellipse(cx - 8, base - 26, 5, 8, C.PAPER);
    for (let a = 0; a < 6; a++) { const px = cx - 14 + a * 6; b.line(px, base - 30, px + 3, base - 10, C.BLU); b.set(px + 1, base - 22, C.BLU_D); }
    b.hline(cx - 20, cx + 20, base - 38, C.BLU); b.hline(cx - 18, cx + 18, base - 8, C.BLU);
    b.ellipse(cx, base - 42, 22, 6, C.BLU_D); b.ellipse(cx, base - 42, 19, 4, C.DEEP);
    const r = rng(8);
    for (let k = 0; k < 9; k++) { const sx = cx - 15 + k * 4, top = base - 70 - Math.floor(r() * 18), lean = Math.round((k - 4) * 1.5); b.line(sx, base - 42, sx + lean, top, [C.PAPER, C.GOLD_L, C.JADE][k % 3]); b.line(sx + 1, base - 42, sx + lean + 1, top, C.PLASTER_S); b.ellipse(sx + lean, top, 2, 2, [C.RED_D, C.BROWN, C.GOLD_D][k % 3]); }
  }

  // ── 7. plaque, folding screen, the prince's seat and desk ──
  {
    const x = 576, y = 52, w = 128, h = 26;
    b.rect(x - 4, y - 4, w + 8, h + 8, C.GOLD_D); b.rect(x - 2, y - 2, w + 4, h + 4, C.GOLD); b.hline(x - 2, x + w + 1, y - 2, C.GOLD_L);
    b.rect(x, y, w, h, C.BLU_D); b.hline(x, x + w - 1, y, C.BLU); b.vline(x + w - 1, y, y + h - 1, C.DEEP);
  }
  screen(b, 470, 100, 340, 232);
  shade(b, [[470, 232], [812, 232], [824, 244], [482, 244]], DARK, 2);
  // seat: a low dais with an apricot-yellow cushion and an armrest at each end
  b.rect(560, 222, 160, 44, C.RED_D); b.rect(562, 224, 156, 40, C.RED_M); b.hline(562, 717, 224, C.RED);
  b.rect(580, 228, 120, 30, C.GOLD); b.hline(580, 699, 228, C.GOLD_L); b.rect(580, 254, 120, 4, C.GOLD_D);
  for (let i = 586; i < 696; i += 12) b.ellipse(i, 242, 3, 3, C.GOLD_D);
  for (const ax of [566, 700]) { b.rect(ax, 214, 14, 36, C.DBROWN); b.rect(ax + 2, 214, 10, 6, C.WOOD); b.vline(ax + 2, 220, 248, C.BROWN); }
  // the desk 书案: lacquered top seen from above, with books, brushes, inkstone, paper and a seal box
  {
    const x = 524, y = 264, w = 232, top = 30;
    shade(b, [[x + 8, y + top + 26], [x + w, y + top + 4], [x + w + 26, y + top + 28], [x + w + 10, y + top + 40], [x + 26, y + top + 40]], DARK, 1);
    b.rect(x, y, w, top, C.RED_D); b.rect(x + 2, y + 2, w - 4, top - 6, C.CRIMSON); b.hline(x + 2, x + w - 3, y + 2, C.RED_L);
    b.rect(x - 6, y - 2, 8, top + 2, C.RED_D); b.rect(x + w - 2, y - 2, 8, top + 2, C.RED_D); // 翘头 raised ends
    b.hline(x - 6, x + 1, y - 2, C.RED); b.hline(x + w - 2, x + w + 5, y - 2, C.RED);
    b.rect(x, y + top - 4, w, 4, C.RED_D);
    b.rect(x, y + top, w, 10, C.DBROWN); b.hline(x, x + w - 1, y + top, C.RED_M);
    for (let i = x + 20; i < x + w - 20; i += 24) { b.ellipse(i, y + top + 5, 6, 2, C.GOLD_D); b.set(i, y + top + 5, C.GOLD); }
    for (const lx of [x + 4, x + w - 16]) { b.rect(lx, y + top + 10, 12, 18, C.DBROWN); b.vline(lx, y + top + 10, y + top + 27, C.BROWN); b.rect(lx - 2, y + top + 26, 16, 3, C.DEEP); }
    // on the desk
    for (let i = 0; i < 4; i++) { b.rect(x + 14, y + 16 - i * 4, 34, 4, C.PAPER); b.hline(x + 14, x + 47, y + 16 - i * 4, C.BLU_D); b.hline(x + 14, x + 47, y + 19 - i * 4, C.BLU_D); }
    b.rect(x + 56, y + 6, 26, 16, C.BLU_D); b.rect(x + 58, y + 8, 22, 12, C.BLU); b.rect(x + 74, y + 9, 3, 10, C.PAPER);
    b.rect(x + 92, y + 5, 54, 18, C.PAPER); b.hline(x + 92, x + 145, y + 22, C.PLASTER_S); // a sheet of paper
    for (let c = 0; c < 5; c++) for (let j = y + 8; j < y + 20; j += 2) if ((c * 3 + j) % 7) b.set(x + 138 - c * 8, j, C.BLACK);
    b.rect(x + 92, y + 3, 54, 3, C.TEAL); b.hline(x + 92, x + 145, y + 3, C.SKY); // jade paperweight
    b.rect(x + 156, y + 8, 22, 14, C.BLACK); b.rect(x + 158, y + 10, 10, 8, C.TILE_D); b.set(x + 159, y + 10, C.TILE_L); // inkstone
    b.rect(x + 184, y + 14, 18, 6, C.TEAL); for (let i = 0; i < 3; i++) b.line(x + 186 + i * 5, y + 13, x + 190 + i * 5, y - 6, C.WOOD); // brush rest + brushes
    for (let i = 0; i < 3; i++) b.set(x + 190 + i * 5, y - 7, C.GOLD);
    b.rect(x + 206, y + 8, 16, 14, C.RED_D); b.rect(x + 208, y + 10, 12, 8, C.RED); b.hline(x + 206, x + 221, y + 8, C.GOLD); // seal box
  }
  const lampL = candleStand(b, 488, 318), lampR = candleStand(b, 792, 318);
  for (const cx of [488, 792]) shade(b, [[cx - 8, 318], [cx + 12, 314], [cx + 34, 330], [cx + 6, 334]], DARK, 2);

  // ── 8. the garden window, a qin on its table beneath it, the incense stand ──
  gardenWindow(b, 902, 66, 330, 112);
  {
    const x = 930, y = 206, w = 278, d = 18;
    shade(b, [[x + 10, y + d + 26], [x + w, y + d + 6], [x + w + 22, y + d + 28], [x + w + 8, y + d + 36], [x + 28, y + d + 36]], DARK, 2);
    b.rect(x, y, w, d, C.WOOD); b.hline(x, x + w - 1, y, C.WOOD_L); b.rect(x, y + d, w, 5, C.BROWN); b.hline(x, x + w - 1, y + d + 4, C.DBROWN);
    for (const lx of [x + 6, x + w - 14]) { b.rect(lx, y + d + 5, 8, 26, C.DBROWN); b.vline(lx, y + d + 5, y + d + 30, C.BROWN); }
    b.rect(x + 6, y + d + 22, w - 12, 3, C.DBROWN);
    // 古琴: long black lacquer body, seven strings, mother-of-pearl studs
    const qx = x + 20, qy = y + 4;
    b.rect(qx, qy, 220, 11, C.BLACK); b.rect(qx + 220, qy + 1, 14, 9, C.BLACK); b.rect(qx - 6, qy + 2, 6, 7, C.BLACK);
    b.hline(qx, qx + 219, qy, C.TILE_D); b.hline(qx - 4, qx + 232, qy + 10, C.DEEP);
    for (let s = 0; s < 4; s++) b.hline(qx + 6, qx + 226, qy + 2 + s * 2, C.STONE);
    for (let k = 0; k < 13; k++) b.set(qx + 40 + k * 12, qy + 1, C.JADE);
    b.rect(qx + 224, qy + 2, 4, 7, C.GOLD_D);
    b.vline(qx - 8, qy + 4, qy + 16, C.RED); b.set(qx - 8, qy + 17, C.RED_L); // tassel
    // a small potted orchid at the end of the table
    const ox = x + w - 18, oy = y + 6;
    b.rect(ox - 8, oy - 2, 17, 12, C.JADE); b.hline(ox - 8, ox + 8, oy - 2, C.PAPER); b.vline(ox + 8, oy - 2, oy + 9, C.STONE_L); b.hline(ox - 6, ox + 6, oy + 4, C.BLU);
    for (const [dx, dy] of [[-14, -14], [-8, -22], [2, -24], [10, -16], [16, -8]]) { b.line(ox, oy - 2, ox + dx, oy + dy, C.GRN); b.set(ox + dx, oy + dy, C.GRN_L); }
    b.ellipse(ox - 9, oy - 20, 2, 1, C.PUR_L); b.ellipse(ox + 6, oy - 22, 2, 1, C.PUR_L);
  }
  const smoke = censerStand(b, 862, 318);
  shade(b, [[846, 318], [878, 314], [906, 334], [870, 338]], DARK, 2);

  // ── 9. tea corner: low table with a celadon tea set, two round cushions ──
  {
    const x = 950, y = 540, w = 140, d = 36;
    for (const cx of [918, 1122]) { shade(b, [[cx - 20, y + 30], [cx + 26, y + 22], [cx + 40, y + 40], [cx - 8, y + 48]], DARK, 2); b.ellipse(cx, y + 24, 22, 13, C.RED_D); b.ellipse(cx, y + 22, 21, 11, C.CRIMSON); b.ellipse(cx - 4, y + 19, 12, 5, C.RED_L); b.ellipse(cx, y + 22, 5, 3, C.GOLD); }
    shade(b, [[x + 8, y + d + 18], [x + w, y + d + 2], [x + w + 22, y + d + 20], [x + w + 6, y + d + 30], [x + 26, y + d + 30]], DARK, 1);
    b.rect(x, y, w, d, C.WOOD); b.hline(x, x + w - 1, y, C.WOOD_L); b.vline(x, y, y + d - 1, C.WOOD_L);
    b.rect(x + 6, y + 5, w - 12, d - 10, C.WOOD_L); b.rect(x + 8, y + 7, w - 16, d - 14, C.WOOD);
    b.rect(x, y + d, w, 8, C.BROWN); b.hline(x, x + w - 1, y + d + 7, C.DBROWN);
    for (const lx of [x + 2, x + w - 12]) { b.rect(lx, y + d + 8, 10, 12, C.DBROWN); b.rect(lx - 2, y + d + 18, 14, 3, C.DEEP); }
    // tray, teapot, cups
    b.rect(x + 22, y + 8, 64, 20, C.BLACK); b.rect(x + 24, y + 9, 60, 17, C.RED_D);
    const tx = x + 44, ty = y + 18;
    b.ellipse(tx, ty, 12, 8, C.TEAL); b.ellipse(tx - 4, ty - 3, 5, 3, C.SKY); b.vline(tx + 10, ty - 3, ty + 4, C.BLU_D);
    b.line(tx + 11, ty - 1, tx + 18, ty - 6, C.TEAL); b.set(tx + 18, ty - 7, C.SKY);
    b.ellipse(tx, ty - 8, 6, 2, C.TEAL); b.ellipse(tx, ty - 10, 2, 1, C.SKY);
    b.line(tx - 12, ty - 4, tx - 15, ty + 2, C.BLU_D);
    for (const [cx, cy] of [[x + 70, y + 14], [x + 74, y + 24], [x + 106, y + 18]]) { b.ellipse(cx, cy, 5, 3, C.JADE); b.ellipse(cx, cy, 3, 1, C.SKY); b.set(cx + 4, cy + 1, C.STONE_L); }
    b.rect(x + 98, y + 6, 20, 6, C.GOLD_D); b.hline(x + 98, x + 117, y + 6, C.GOLD); // tea caddy
  }

  // ── 10. a 罗汉床 daybed with a go board on its little table; a potted pine; a tea stove ──
  {
    const x = 64, x1 = 344, y = 530, front = 604;
    shade(b, [[x + 10, front + 30], [x1, front + 4], [x1 + 30, front + 30], [x1 + 14, front + 46], [x + 30, front + 46]], DARK, 1);
    // back rail (围子) seen face-on, with open fretwork
    b.rect(x, y - 34, x1 - x, 36, C.DBROWN); b.hline(x, x1 - 1, y - 34, C.WOOD);
    for (let i = x + 10; i < x1 - 16; i += 30) { b.rect(i, y - 28, 24, 24, C.BROWN); frame(b, i + 3, y - 25, 18, 18, C.WOOD); b.rect(i + 9, y - 19, 6, 6, C.WOOD); b.set(i + 3, y - 25, C.WOOD_L); }
    // seat platform seen from above, a crimson mattress with a gold edge
    b.rect(x, y, x1 - x, front - y, C.WOOD); b.hline(x, x1 - 1, y, C.WOOD_L);
    b.rect(x + 6, y + 2, x1 - x - 12, front - y - 8, C.GOLD); b.rect(x + 8, y + 4, x1 - x - 16, front - y - 12, C.CRIMSON);
    dith(b, x + 8, y + 4, x1 - x - 16, front - y - 12, C.RED_D, 4);
    b.hline(x + 8, x1 - 9, y + 4, C.RED_L);
    // side rails
    for (const sx of [x - 4, x1 - 8]) { b.rect(sx, y - 26, 12, front - y + 24, C.DBROWN); b.vline(sx, y - 26, front - 3, C.WOOD); b.hline(sx, sx + 11, y - 26, C.WOOD_L); }
    // bolsters
    for (const bx of [x + 22, x1 - 22]) { b.ellipse(bx, y + 22, 9, 16, C.GOLD); b.ellipse(bx - 2, y + 18, 5, 10, C.GOLD_L); b.ellipse(bx, y + 22, 3, 3, C.RED); b.vline(bx + 8, y + 12, y + 32, C.GOLD_D); }
    // apron with 壸门 curves, legs
    b.rect(x - 4, front, x1 - x + 8, 12, C.DBROWN); b.hline(x - 4, x1 + 3, front, C.BROWN);
    for (let i = x + 20; i < x1 - 20; i += 40) for (let k = -14; k <= 14; k++) b.set(i + 20 + k, front + 10 - Math.round(Math.sqrt(196 - k * k) / 3), C.DEEP);
    for (const lx of [x - 4, x1 - 8]) { b.rect(lx, front + 12, 12, 14, C.DBROWN); b.rect(lx - 2, front + 24, 16, 3, C.DEEP); }
    // kang table with a go board, two stone pots
    const tx = 150, ty = 546, tw = 108, td = 40;
    b.rect(tx, ty, tw, td, C.DBROWN); b.rect(tx + 2, ty + 1, tw - 4, td - 6, C.WOOD); b.hline(tx + 2, tx + tw - 3, ty + 1, C.WOOD_L); b.rect(tx, ty + td - 5, tw, 5, C.BROWN);
    const gx = tx + 26, gy = ty + 5, gs = 26;
    b.rect(gx - 2, gy - 1, gs + 5, gs - 3, C.GOLD_L); b.vline(gx + gs + 2, gy - 1, gy + gs - 5, C.GOLD); b.hline(gx - 2, gx + gs + 2, gy + gs - 4, C.GOLD);
    for (let k = 0; k <= gs; k += 3) { b.hline(gx, gx + gs - 1, gy + Math.round(k * 0.8), C.BROWN); b.vline(gx + k, gy, gy + Math.round(gs * 0.8), C.BROWN); }
    const r = rng(19);
    for (let k = 0; k < 14; k++) { const px = gx + 3 * Math.floor(r() * 9), py = gy + Math.round(3 * Math.floor(r() * 8) * 0.8); b.rect(px - 1, py - 1, 2, 2, k % 2 ? C.BLACK : C.JADE); }
    for (const [px, c, hi] of [[tx + 12, C.BLACK, C.TILE], [tx + tw - 12, C.JADE, C.PAPER]]) { b.ellipse(px, ty + 18, 8, 7, C.BROWN); b.ellipse(px, ty + 16, 7, 4, C.WOOD); b.ellipse(px, ty + 16, 5, 3, c); b.set(px - 2, ty + 15, hi); }
  }
  const lanL = floorLantern(b, 340, 420), lanR = floorLantern(b, 940, 420);
  for (const cx of [340, 940]) shade(b, [[cx - 12, 420], [cx + 14, 416], [cx + 40, 436], [cx + 10, 440]], DARK, 2);
  let ember;
  { // tea stove (风炉) with a kettle, next to the tea table
    const cx = 1204, base = 620;
    shade(b, [[cx - 16, base], [cx + 16, base - 4], [cx + 40, base + 14], [cx + 8, base + 18]], DARK, 2);
    b.rect(cx - 16, base - 34, 32, 32, C.BRONZE); b.vline(cx - 16, base - 34, base - 3, C.GOLD); b.rect(cx + 10, base - 34, 6, 32, C.GOLD_D); b.vline(cx + 15, base - 34, base - 3, C.BROWN);
    b.ellipse(cx, base - 3, 17, 4, C.BROWN); b.hline(cx - 16, cx + 15, base - 22, C.GOLD_D);
    b.rect(cx - 6, base - 16, 12, 8, C.DEEP); b.rect(cx - 4, base - 13, 8, 4, C.RED); b.hline(cx - 3, cx + 3, base - 12, C.GOLD_L); // embers through the vent
    b.ellipse(cx, base - 34, 16, 4, C.GOLD_D); b.ellipse(cx, base - 35, 12, 3, C.DEEP);
    b.ellipse(cx, base - 44, 13, 9, C.BLACK); b.ellipse(cx - 4, base - 47, 5, 3, C.TILE); b.vline(cx + 11, base - 49, base - 40, C.DEEP); // iron kettle
    b.line(cx + 12, base - 44, cx + 20, base - 50, C.BLACK); b.line(cx - 9, base - 52, cx + 9, base - 52, C.WOOD); b.line(cx - 9, base - 52, cx - 7, base - 46, C.WOOD); b.line(cx + 9, base - 52, cx + 7, base - 46, C.WOOD);
    ember = [cx, base - 14];
  }

  // ── 11. side walls, the door to 太和殿 on the left, front threshold ──
  for (const [x, w] of [[0, 18], [W - 18, 18]]) { b.rect(x, 44, w, H - 44, C.RED_D); b.rect(x + (x ? 0 : w - 4), 44, 4, H - 44, C.RED); }
  b.rect(0, H - 10, W, 10, C.RED_D); b.hline(0, W - 1, H - 10, C.RED);
  doorway(b, 0, 420, 18, 90);
  shade(b, [[18, 420], [30, 420], [60, 510], [18, 510]], LIGHT, 2); // daylight spilling in from the hall

  const half = (p) => [p[0] / 2, p[1] / 2];
  return {
    bg: b,
    spots: {
      walk: [
        { x0: 16, x1: 620, y0: 166, y1: 244 },  // the floor across the room, in front of the desk
        { x0: 16, x1: 254, y0: 120, y1: 166 },  // in front of the bookcase
        { x0: 446, x1: 620, y0: 132, y1: 166 }, // under the garden window, beside the incense stand
        { x0: 180, x1: 440, y0: 166, y1: 340 }, // the carpet and the floor around it
        { x0: 440, x1: 620, y0: 166, y1: 268 }, // behind the tea table
        { x0: 440, x1: 620, y0: 308, y1: 340 }, // in front of the tea table
        { x0: 16, x1: 180, y0: 328, y1: 340 },  // in front of the daybed
      ],
      doors: { taihe: [0, 210, 12, 45] },
      plaque: [320, 32.5], // the blank board above the screen; the game writes the name on it
      emperorStart: [320, 296],
      title: [320, 352],
      seats: { taizi: [320, 130] },
      desk: [262, 131, 116, 30],
      lamps: [half(lampL), half(lampR), half(lanL), half(lanR), half(ember)],
      incense: [half(smoke)],
      lanterns: [[200, 2], [440, 2]],
      npcs: [
        { kind: 'eunuch', x: 218, y: 148, facing: 'right', act: 'idle' },
        { kind: 'lady', x: 512, y: 266, facing: 'front', act: 'tray' },
      ],
      cat: [[100, 334], [210, 330], [560, 330]],
    },
  };
}
