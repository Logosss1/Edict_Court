// Procedural Tang-dynasty court characters (2× detail) — 64×96 frames shown at half scale, light from
// the top-left, 1px ink outline. Officials wear 唐制常服: 圆领袍 in the rank colours (紫 / 绯 / 绿 / 青),
// 幞头 with soft hanging tails, 革带 with plaques, 鱼袋, 乌皮靴, and carry an ivory 笏.
// The animation layout (names, frame counts, rates) lives in src/renderer/court/game/anims.json so the
// generator and the Phaser runtime can never disagree.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Bitmap, C } from './raster.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const LAYOUT = JSON.parse(fs.readFileSync(path.join(here, '../../src/renderer/court/game/anims.json'), 'utf8'));
export const FW = LAYOUT.frameWidth;
export const FH = LAYOUT.frameHeight;
export const COLS = LAYOUT.columns;
/** name → frame indices on the sheet */
export const ANIMS = (() => {
  const out = {};
  let i = 0;
  for (const a of LAYOUT.anims) {
    out[a.name] = Array.from({ length: a.frames }, (_, k) => i + k);
    i += a.frames;
  }
  return out;
})();

// [deep, shade, base, highlight]
const ROBES = {
  yellow: [C.GOLD_D, C.BRONZE, C.GOLD, C.GOLD_L],
  purple: [C.PUR_D, C.PUR_M, C.PUR, C.PUR_L],
  crimson: [C.RED_D, C.RED_M, C.CRIMSON, C.RED_L],
  red: [C.RED_D, C.RED_M, C.RED, C.RED_L],
  green: [C.GRN_D, C.GRN_D, C.GRN, C.GRN_L],
  teal: [C.BLU_D, C.BLU, C.TEAL, C.SKY],
  blue: [C.BLU_D, C.BLU_D, C.BLU, C.SKY],
  steel: [C.STONE_D, C.STONE_D, C.STONE, C.STONE_L],
};

export const CHARACTERS = {
  emperor: { robe: 'yellow', hat: 'futou_emperor', hold: 'none', beard: 'full', belt: 'gold', roundels: true, fish: false },
  taizi: { robe: 'purple', hat: 'crown', hold: 'hu', beard: 'none', belt: 'jade', fish: true },
  zhongshu: { robe: 'purple', hat: 'futou', hold: 'hu', beard: 'goatee', belt: 'gold', fish: true },
  menxia: { robe: 'purple', hat: 'futou', hold: 'hu', beard: 'long', belt: 'gold', fish: true, brows: 'stern' },
  shangshu: { robe: 'purple', hat: 'futou', hold: 'hu', beard: 'full', belt: 'gold', fish: true, plump: true },
  hubu: { robe: 'crimson', hat: 'futou', hold: 'hu', beard: 'mustache', belt: 'gold', fish: true, plump: true, abacusAtBelt: true },
  libu: { robe: 'green', hat: 'futou', hold: 'scroll', beard: 'goatee', belt: 'silver', fish: false },
  bingbu: { robe: 'crimson', hat: 'futou', hold: 'hu', beard: 'full', belt: 'black', fish: true, armorVest: true },
  xingbu: { robe: 'crimson', hat: 'xiezhi', hold: 'hu', beard: 'long', belt: 'gold', fish: true, brows: 'stern' },
  gongbu: { robe: 'teal', hat: 'futou', hold: 'hu', beard: 'mustache', belt: 'silver', fish: false, rulerAtBelt: true },
  libu_hr: { robe: 'purple', hat: 'futou', hold: 'book', beard: 'goatee', belt: 'gold', fish: true },
  zaochao: { robe: 'blue', hat: 'futou', hold: 'hu', beard: 'none', belt: 'black', fish: false },
  solo: { robe: 'purple', hat: 'futou', hold: 'hu', beard: 'longWhite', belt: 'jade', fish: true },
  guard: { robe: 'red', hat: 'helmet', hold: 'halberd', beard: 'mustache', belt: 'black', armor: true },
  lady: { robe: 'red', hat: 'bun', hold: 'none', beard: 'none', belt: 'none', lady: true },
  clerk: { robe: 'teal', hat: 'cap', hold: 'scroll', beard: 'none', belt: 'black', fish: false },
};

const CX = 32;
const FOOT = 93;

// ───────────────────────── small items (drawn at a hand) ─────────────────────────
function hu(b, x, y, len = 20, tilt = 0) {
  // ivory tablet, slightly tapered; (x, y) = bottom centre
  for (let k = 0; k < len; k++) {
    const xx = x + Math.round((tilt * k) / len);
    const w = k > len - 4 ? 2 : 3;
    for (let i = 0; i < w; i++) b.set(xx - 1 + i, y - k, i === w - 1 ? C.STONE_L : C.JADE);
  }
}
function huFlat(b, x, y, len = 24) {
  for (let i = 0; i < len; i++) {
    b.set(x + i, y, C.JADE);
    b.set(x + i, y + 1, C.JADE);
    b.set(x + i, y + 2, C.STONE_L);
  }
}
function scrollOpen(b, x, y, w = 26, h = 10, t = 0) {
  b.rect(x, y, w, h, C.PAPER);
  b.hline(x, x + w - 1, y + h - 1, C.STONE_L);
  for (let r = 0; r < 3; r++) for (let i = 4 + r * 7; i < w - 4; i += 2) if ((i + r + t) % 9) b.set(x + i, y + 2 + r * 2, C.BLACK);
  b.rect(x - 2, y - 1, 2, h + 2, C.WOOD);
  b.rect(x + w, y - 1, 2, h + 2, C.WOOD);
  b.set(x - 2, y - 2, C.GOLD); b.set(x + w + 1, y - 2, C.GOLD);
  b.set(x - 2, y + h + 1, C.GOLD); b.set(x + w + 1, y + h + 1, C.GOLD);
}
function scrollRolled(b, x, y, w = 12) {
  b.rect(x, y, w, 4, C.PAPER);
  b.hline(x, x + w - 1, y + 3, C.STONE_L);
  b.rect(x - 1, y - 1, 2, 6, C.GOLD);
  b.rect(x + w - 1, y - 1, 2, 6, C.GOLD);
  b.hline(x + 2, x + w - 3, y + 1, C.RED);
}
function paper(b, x, y, w, h, lines = 3) {
  b.rect(x, y, w, h, C.PAPER);
  b.vline(x + w - 1, y, y + h - 1, C.STONE_L);
  b.hline(x, x + w - 1, y + h - 1, C.STONE_L);
  for (let c = 0; c < lines; c++) for (let j = 2; j < h - 2; j += 2) b.set(x + w - 3 - c * 3, y + j, C.BLACK);
}
function brush(b, x, y, dx = -3, dy = 6) {
  // (x, y) = grip; tip at (x+dx, y+dy)
  b.line(x - Math.round(dx * 0.6), y - Math.round(dy * 0.6), x + dx, y + dy, C.WOOD);
  b.set(x + dx, y + dy, C.BLACK);
  b.set(x + dx + (dx < 0 ? 1 : -1), y + dy, C.BLACK);
  b.set(x + dx, y + dy - 1, C.BLACK);
}
function sealBlock(b, x, y) {
  b.rect(x - 2, y - 3, 5, 5, C.BRONZE);
  b.hline(x - 2, x + 2, y + 2, C.RED);
  b.set(x - 2, y - 3, C.GOLD_L);
  b.rect(x - 1, y - 6, 3, 3, C.GOLD);
  b.set(x - 1, y - 6, C.GOLD_L);
}
function token(b, x, y) {
  b.rect(x, y, 4, 8, C.GOLD);
  b.vline(x + 3, y, y + 7, C.GOLD_D);
  b.hline(x, x + 3, y + 2, C.RED);
  b.set(x, y, C.GOLD_L);
}
function abacus(b, x, y, t = 0) {
  const w = 20, h = 12;
  b.rect(x, y, w, h, C.DBROWN);
  b.rect(x + 1, y + 1, w - 2, h - 2, C.WOOD_L);
  b.hline(x + 1, x + w - 2, y + 4, C.DBROWN);
  for (let i = 0; i < 6; i++) {
    const rx = x + 2 + i * 3;
    b.vline(rx + 1, y + 1, y + h - 2, C.BROWN);
    const up = (i + t) % 3 === 0;
    b.rect(rx, up ? y + 2 : y + 1, 3, 1, C.BLACK);
    const low = ((i * 2 + t) % 4) + 1;
    for (let k = 0; k < 3; k++) b.rect(rx, y + 5 + k + (k >= 4 - low ? 2 : 0), 3, 1, k % 2 ? C.DBROWN : C.BLACK);
  }
}
function bookOpen(b, x, y, flip = 0) {
  const w = 18, h = 11;
  b.rect(x, y, w, h, C.PAPER);
  b.vline(x + 9, y, y + h - 1, C.STONE_L);
  b.hline(x, x + w - 1, y + h - 1, C.STONE);
  b.rect(x - 1, y + 1, 1, h, C.RED_D);
  b.rect(x + w, y + 1, 1, h, C.RED_D);
  for (let c = 0; c < 2; c++) for (let j = 2; j < h - 2; j += 2) { b.set(x + 3 + c * 2, y + j, C.BLACK); b.set(x + 12 + c * 2, y + j, C.BLACK); }
  if (flip) {
    // a page turning over the spine
    const px = flip === 1 ? x + 12 : x + 6;
    b.poly([[x + 9, y - 1], [px + 3, y - 3], [px + 2, y + h - 3], [x + 9, y + h - 1]], C.JADE);
    b.line(x + 9, y - 1, px + 3, y - 3, C.STONE_L);
  }
}
function bookClosed(b, x, y) {
  b.rect(x, y, 10, 13, C.BLU_D);
  b.rect(x + 1, y + 1, 8, 11, C.BLU);
  b.rect(x + 6, y + 2, 2, 8, C.PAPER);
  b.vline(x + 9, y, y + 12, C.STONE_L);
}
function hangingScroll(b, x, y, sway = 0) {
  // painting (青绿山水) hanging from the top roller held at (x, y)
  const w = 18, h = 26;
  const X = x - w / 2 + sway;
  b.rect(x - w / 2 - 2, y, w + 4, 2, C.WOOD);
  b.rect(X, y + 2, w, h, C.PAPER);
  b.rect(X + 2, y + 4, w - 4, h - 7, C.JADE);
  b.poly([[X + 2, y + h - 3], [X + 7, y + 10], [X + 11, y + h - 3]], C.GRN);
  b.poly([[X + 8, y + h - 3], [X + 12, y + 13], [X + w - 2, y + h - 3]], C.TEAL);
  b.set(X + 7, y + 10, C.GRN_L); b.set(X + 12, y + 13, C.SKY);
  b.ellipse(X + 13, y + 8, 1, 1, C.RED);
  b.rect(x - w / 2 - 1 + sway, y + h + 2, w + 2, 2, C.WOOD);
}
function baton(b, x, y, tx, ty) {
  b.line(x, y, tx, ty, C.WOOD);
  b.set(tx, ty, C.GOLD_L);
  b.rect(x - 1, y + 1, 2, 3, C.RED);
}
function scales(b, x, y, tilt = 0) {
  // hand at (x, y) holding the top ring; beam below
  b.set(x, y + 1, C.GOLD_D); b.set(x, y + 2, C.GOLD_D);
  const by = y + 3;
  b.line(x - 9, by + tilt, x + 9, by - tilt, C.GOLD_D);
  const pan = (px, py) => {
    b.line(px, py, px - 3, py + 7, C.STONE);
    b.line(px, py, px + 3, py + 7, C.STONE);
    b.hline(px - 4, px + 4, py + 8, C.BRONZE);
    b.hline(px - 3, px + 3, py + 9, C.GOLD_D);
  };
  pan(x - 9, by + tilt);
  pan(x + 9, by - tilt);
}
function quadrant(b, x, y, a = 0) {
  // 曲尺 carpenter's square
  const L = 14;
  for (let i = 0; i < L; i++) { b.set(x + i, y + Math.round(i * a), C.GOLD); b.set(x + i, y + 1 + Math.round(i * a), C.GOLD_D); }
  for (let j = 0; j < 9; j++) { b.set(x, y - j, C.GOLD); b.set(x + 1, y - j, C.GOLD_D); }
  for (let i = 3; i < L; i += 3) b.set(x + i, y + Math.round(i * a), C.BLACK);
}
function cup(b, x, y, steam = 0) {
  b.rect(x - 3, y, 7, 4, C.JADE);
  b.hline(x - 3, x + 3, y, C.TEAL);
  b.vline(x + 3, y, y + 3, C.STONE_L);
  b.hline(x - 4, x + 4, y + 4, C.TEAL);
  if (steam) { b.set(x - 1 + (steam % 2), y - 3, C.SKY_L); b.set(x + (steam % 2), y - 5, C.SKY_L); b.set(x - 1, y - 7, C.SKY_L); }
}
function halberd(b, x, top, bottom) {
  b.vline(x, top + 8, bottom, C.WOOD);
  b.vline(x + 1, top + 8, bottom, C.BROWN);
  b.poly([[x, top], [x + 3, top + 7], [x - 2, top + 7]], C.STONE_L);
  b.vline(x, top + 1, top + 6, C.JADE);
  b.poly([[x + 2, top + 9], [x + 8, top + 7], [x + 7, top + 11], [x + 2, top + 12]], C.STONE);
  b.rect(x - 2, top + 13, 5, 3, C.RED);
  b.set(x - 2, top + 16, C.RED); b.set(x + 2, top + 16, C.RED_L);
}

// ───────────────────────── marks ─────────────────────────
function sweat(b, x, y) {
  b.set(x, y, C.SKY_L); b.set(x, y + 1, C.SKY); b.set(x - 1, y + 2, C.SKY); b.set(x, y + 2, C.SKY); b.set(x + 1, y + 2, C.BLU);
}
function sparkle(b, x, y) {
  b.set(x, y, C.GOLD_L); b.set(x - 1, y, C.GOLD); b.set(x + 1, y, C.GOLD); b.set(x, y - 1, C.GOLD); b.set(x, y + 1, C.GOLD);
}
function anger(b, x, y) {
  b.set(x, y, C.RED_L); b.set(x + 2, y, C.RED_L); b.set(x + 1, y + 1, C.RED); b.set(x, y + 2, C.RED_L); b.set(x + 2, y + 2, C.RED_L);
}

// ───────────────────────── head & hats ─────────────────────────
function headFront(b, cx, top, spec, f) {
  const hs = f.hs ?? 0; // head turn: shifts facial features
  const fy = top + 14; // face centre
  // neck
  b.rect(cx - 3, fy + 9, 7, 4, C.SKIN_S);
  // face
  b.ellipse(cx, fy, 9, 10, C.SKIN);
  // light from top-left: highlight cheek, shade right jaw
  for (let y = fy - 6; y <= fy + 6; y++) { b.set(cx + 8 - (Math.abs(y - fy) > 5 ? 1 : 0), y, C.SKIN_S); b.set(cx + 7 - (Math.abs(y - fy) > 6 ? 1 : 0), y + 1, C.SKIN_S); }
  b.hline(cx - 4, cx + 5, fy + 9, C.SKIN_S);
  b.set(cx - 6, fy - 2, C.SKIN_L); b.set(cx - 5, fy - 3, C.SKIN_L); b.set(cx - 6, fy - 1, C.SKIN_L);
  // ears
  b.rect(cx - 10, fy - 2, 2, 5, C.SKIN_S);
  b.rect(cx + 9, fy - 2, 2, 5, C.SKIN_S);
  b.set(cx - 10, fy, C.SKIN);
  // eyes
  const ey = fy - 1 + (f.eyes === 'down' ? 1 : f.eyes === 'up' ? -1 : 0);
  const ex = (f.eyes === 'left' ? -1 : f.eyes === 'right' ? 1 : 0) + hs;
  const eye = (x) => {
    if (f.eyes === 'closed') { b.hline(x - 1, x + 1, ey + 1, C.DBROWN); return; }
    if (f.eyes === 'squint') { b.hline(x - 1, x + 1, ey, C.INK); b.set(x, ey + 1, C.INK); return; }
    b.rect(x - 1, ey, 2, 2, C.INK);
    b.set(x + 1, ey, C.DBROWN);
    if (f.eyes !== 'down') b.set(x - 1, ey, C.BLACK);
  };
  eye(cx - 4 + ex);
  eye(cx + 4 + ex);
  // brows
  const by = ey - 3;
  if (spec.brows === 'stern' || f.brows === 'angry') {
    b.line(cx - 7 + hs, by, cx - 2 + hs, by + 1, C.BLACK);
    b.line(cx + 7 + hs, by, cx + 2 + hs, by + 1, C.BLACK);
  } else if (f.brows === 'worried') {
    b.line(cx - 6 + hs, by + 1, cx - 2 + hs, by, C.DBROWN);
    b.line(cx + 6 + hs, by + 1, cx + 2 + hs, by, C.DBROWN);
  } else {
    b.hline(cx - 6 + hs, cx - 3 + hs, by, spec.beard === 'longWhite' ? C.STONE_L : C.DBROWN);
    b.hline(cx + 3 + hs, cx + 6 + hs, by, spec.beard === 'longWhite' ? C.STONE_L : C.DBROWN);
  }
  // nose
  b.set(cx + 1 + hs, fy + 2, C.SKIN_S);
  b.set(cx + 1 + hs, fy + 3, C.SKIN_S);
  // mouth
  const my = fy + 5;
  const m = f.mouth ?? 'closed';
  if (m === 'open') { b.rect(cx - 1 + hs, my, 3, 2, C.RED_D); b.set(cx + hs, my + 1, C.RED); }
  else if (m === 'smile') { b.set(cx - 2 + hs, my, C.RED_D); b.hline(cx - 1 + hs, cx + 1 + hs, my + 1, C.RED_D); b.set(cx + 2 + hs, my, C.RED_D); }
  else if (m === 'wavy') { b.set(cx - 2 + hs, my + 1, C.RED_D); b.set(cx - 1 + hs, my, C.RED_D); b.set(cx + hs, my + 1, C.RED_D); b.set(cx + 1 + hs, my, C.RED_D); }
  else if (m === 'yawn') { b.rect(cx - 1 + hs, my - 1, 3, 3, C.RED_D); }
  else b.hline(cx - 1 + hs, cx + 1 + hs, my, C.SKIN_S);
  if (spec.lady) { b.set(cx - 6 + hs, fy + 3, C.PINK); b.set(cx + 5 + hs, fy + 3, C.PINK); b.set(cx + hs, my, C.RED); b.set(cx + hs, fy - 6, C.RED); }
  // beards
  const hair = spec.beard === 'longWhite' ? C.STONE_L : C.BLACK;
  const hair2 = spec.beard === 'longWhite' ? C.STONE : C.INK;
  const mouthOpen = m === 'open' || m === 'yawn';
  if (spec.beard && spec.beard !== 'none') {
    // moustache (八字胡)
    b.line(cx - 1 + hs, my - 1, cx - 4 + hs, my + 1, hair);
    b.line(cx + 2 + hs, my - 1, cx + 5 + hs, my + 1, hair);
  }
  if (['goatee', 'full', 'long', 'longWhite'].includes(spec.beard)) {
    const len = spec.beard === 'goatee' ? 3 : spec.beard === 'full' ? 4 : 9;
    const w = spec.beard === 'full' ? 3 : 1;
    for (let k = 0; k < len; k++) for (let i = -w; i <= w; i++) {
      if (mouthOpen && k < 1 && Math.abs(i) < 2) continue;
      const ww = k > len - 3 ? Math.max(0, w - 1) : w;
      if (Math.abs(i) <= ww) b.set(cx + hs + i + (k > 6 ? 1 : 0), my + 2 + k, (i + k) % 3 ? hair : hair2);
    }
    if (spec.beard === 'full') { b.vline(cx - 6 + hs, fy + 3, fy + 7, hair); b.vline(cx + 7 + hs, fy + 3, fy + 7, hair); }
  }
}

function hatFront(b, cx, top, spec, f) {
  switch (spec.hat) {
    case 'futou':
    case 'futou_emperor': {
      // 巾子 (raised crown) + band wrapped round the head
      // mid-Tang 巾子: a tall two-lobed crown leaning slightly forward
      const crownH = spec.hat === 'futou_emperor' ? 14 : 12;
      b.ellipse(cx - 3, top + 9 - crownH + 6, 5, crownH - 6, C.BLACK);
      b.ellipse(cx + 3, top + 9 - crownH + 6, 5, crownH - 6, C.BLACK);
      b.rect(cx - 7, top + 3, 15, 5, C.BLACK);
      b.set(cx, top + 9 - crownH + 1, C.INK);
      b.line(cx - 5, top + 9 - crownH + 3, cx - 7, top + 4, C.STONE_D);
      b.rect(cx - 11, top + 6, 23, 5, C.BLACK);
      b.ellipse(cx, top + 9, 11, 3, C.BLACK);
      // sheen (light top-left)
      b.line(cx - 4, top + 1, cx - 6, top + 5, C.STONE_D);
      b.set(cx - 3, top + 1, C.STONE_D);
      b.hline(cx - 9, cx - 4, top + 7, C.STONE_D);
      // knot behind (visible as two lobes)
      b.set(cx + 6, top + 3, C.INK); b.set(cx + 7, top + 4, C.INK);
      if (spec.hat === 'futou_emperor') {
        b.rect(cx - 1, top + 2, 3, 3, C.GOLD);
        b.set(cx, top + 2, C.GOLD_L);
        b.hline(cx - 10, cx + 10, top + 10, C.GOLD_D);
      }
      break;
    }
    case 'crown': {
      // 远游冠: black cap, gold crown with ribs, hairpin through it, red cords
      b.rect(cx - 10, top + 7, 21, 5, C.BLACK);
      b.ellipse(cx, top + 8, 10, 3, C.BLACK);
      b.rect(cx - 6, top - 1, 13, 9, C.GOLD);
      for (let x = cx - 5; x <= cx + 5; x += 3) b.vline(x, top, top + 7, C.GOLD_D);
      b.hline(cx - 6, cx + 6, top - 1, C.GOLD_L);
      b.set(cx - 6, top, C.GOLD_L);
      b.hline(cx - 14, cx + 14, top + 5, C.GOLD_L); // 簪
      b.set(cx - 15, top + 5, C.RED); b.set(cx + 15, top + 5, C.RED);
      b.line(cx - 10, top + 12, cx - 9, top + 23, C.RED); // 缨
      b.line(cx + 10, top + 12, cx + 9, top + 23, C.RED);
      break;
    }
    case 'xiezhi': {
      // 獬豸冠: tall black cap with a single horn
      b.rect(cx - 7, top - 2, 15, 13, C.BLACK);
      b.ellipse(cx, top + 9, 11, 3, C.BLACK);
      b.rect(cx - 11, top + 6, 23, 5, C.BLACK);
      b.line(cx, top - 2, cx + 3, top - 8, C.STONE_L);
      b.line(cx + 1, top - 2, cx + 4, top - 8, C.JADE);
      b.set(cx + 5, top - 9, C.JADE);
      b.line(cx - 5, top, cx - 5, top + 6, C.STONE_D);
      break;
    }
    case 'helmet': {
      // 兜鍪 with neck guard and red plume
      b.ellipse(cx, top + 4, 11, 7, C.STONE);
      b.rect(cx - 12, top + 6, 25, 4, C.STONE_D);
      b.hline(cx - 12, cx + 12, top + 7, C.GOLD);
      b.line(cx - 5, top - 1, cx - 8, top + 4, C.STONE_L);
      b.set(cx - 4, top - 1, C.JADE);
      b.rect(cx - 1, top - 8, 3, 6, C.GOLD_D);
      b.ellipse(cx, top - 11, 3, 4, C.RED);
      b.set(cx - 1, top - 13, C.RED_L); b.set(cx - 2, top - 11, C.RED_L);
      // cheek guards
      b.rect(cx - 12, top + 10, 3, 12, C.STONE_D);
      b.rect(cx + 10, top + 10, 3, 12, C.STONE_D);
      b.vline(cx - 12, top + 10, top + 21, C.STONE);
      break;
    }
    case 'bun': {
      // 高髻 with gold pins and a flower
      b.ellipse(cx, top + 9, 11, 5, C.BLACK);
      b.ellipse(cx + 1, top + 1, 6, 7, C.BLACK);
      b.ellipse(cx - 5, top - 2, 4, 4, C.BLACK);
      b.line(cx - 3, top - 3, cx - 1, top + 3, C.BLU_D);
      b.set(cx - 7, top - 3, C.BLU_D);
      b.line(cx + 4, top - 2, cx + 10, top - 6, C.GOLD);
      b.set(cx + 11, top - 7, C.GOLD_L);
      b.ellipse(cx - 8, top + 5, 2, 2, C.PINK);
      b.set(cx - 8, top + 5, C.GOLD_L);
      b.vline(cx - 10, top + 10, top + 20, C.BLACK);
      b.vline(cx + 10, top + 10, top + 20, C.BLACK);
      break;
    }
    case 'cap': {
      // 平巾帻
      b.rect(cx - 10, top + 6, 21, 6, C.BLACK);
      b.ellipse(cx, top + 6, 8, 3, C.BLACK);
      b.rect(cx - 3, top + 1, 7, 4, C.BLACK);
      b.hline(cx - 9, cx - 3, top + 7, C.STONE_D);
      break;
    }
  }
  void f;
}

function futouTailsFront(b, cx, top, spec) {
  if (spec.hat !== 'futou' && spec.hat !== 'futou_emperor' && spec.hat !== 'xiezhi') return;
  // soft tails (软脚) hang behind the head — from the front only their tips flutter past the shoulders
  b.rect(cx - 17, top + 26, 2, 7, C.BLACK);
  b.rect(cx + 16, top + 27, 2, 6, C.BLACK);
}

function headBack(b, cx, top, spec, tail = 24) {
  b.ellipse(cx, top + 14, 9, 10, C.BLACK);
  b.rect(cx - 3, top + 22, 7, 4, C.SKIN_S);
  b.rect(cx - 10, top + 12, 2, 5, C.SKIN_S);
  b.rect(cx + 9, top + 12, 2, 5, C.SKIN_S);
  if (spec.hat === 'helmet') {
    b.ellipse(cx, top + 9, 11, 9, C.STONE);
    b.rect(cx - 11, top + 12, 23, 12, C.STONE_D);
    b.ellipse(cx, top - 8, 3, 4, C.RED);
    return;
  }
  if (spec.hat === 'bun') {
    b.ellipse(cx, top + 9, 11, 6, C.BLACK);
    b.ellipse(cx + 1, top + 1, 6, 7, C.BLACK);
    b.line(cx + 4, top - 2, cx + 10, top - 6, C.GOLD);
    b.rect(cx - 8, top + 16, 17, 10, C.BLACK);
    return;
  }
  hatFront(b, cx, top, { ...spec, hat: spec.hat === 'crown' ? 'crown' : spec.hat }, {});
  // hide face details the front hat drawing may leave: tails hang down the back
  if (spec.hat === 'futou' || spec.hat === 'futou_emperor' || spec.hat === 'xiezhi') {
    b.rect(cx - 4, top + 10, 3, tail, C.BLACK);
    b.rect(cx + 2, top + 10, 3, tail, C.BLACK);
  }
}

function headSide(b, cx, top, spec, f) {
  // profile facing right
  const fy = top + 14;
  b.rect(cx - 2, fy + 8, 6, 5, C.SKIN_S);
  b.ellipse(cx, fy, 9, 10, C.SKIN);
  b.ellipse(cx - 3, fy - 1, 7, 9, C.BLACK); // hair at the back
  b.rect(cx - 2, fy - 2, 3, 5, C.SKIN_S); // ear
  b.set(cx - 1, fy, C.SKIN);
  b.set(cx + 9, fy + 1, C.SKIN); b.set(cx + 10, fy + 2, C.SKIN); b.set(cx + 9, fy + 2, C.SKIN_S); // nose
  const eyes = f.eyes === 'closed' ? C.DBROWN : C.INK;
  b.rect(cx + 5, fy - 1, 2, 2, eyes);
  if (f.eyes === 'closed') b.set(cx + 5, fy - 1, C.SKIN);
  b.hline(cx + 4, cx + 7, fy - 4, C.DBROWN);
  if (f.mouth === 'open') b.rect(cx + 7, fy + 5, 2, 2, C.RED_D);
  else b.set(cx + 7, fy + 5, C.SKIN_S);
  const hair = spec.beard === 'longWhite' ? C.STONE_L : C.BLACK;
  if (spec.beard && spec.beard !== 'none') b.line(cx + 6, fy + 4, cx + 9, fy + 5, hair);
  if (['goatee', 'full', 'long', 'longWhite'].includes(spec.beard)) {
    const len = spec.beard === 'goatee' ? 3 : spec.beard === 'full' ? 4 : 9;
    for (let k = 0; k < len; k++) { b.set(cx + 6 - Math.floor(k / 4), fy + 8 + k, hair); b.set(cx + 7 - Math.floor(k / 4), fy + 8 + k, hair); }
  }
  if (spec.lady) b.set(cx + 4, fy + 3, C.PINK);
  // hat
  switch (spec.hat) {
    case 'futou':
    case 'futou_emperor':
    case 'xiezhi':
      b.ellipse(cx + 1, top + 6, 7, 7, C.BLACK);
      b.rect(cx - 9, top + 6, 19, 6, C.BLACK);
      b.line(cx - 2, top + 1, cx - 4, top + 5, C.STONE_D);
      if (spec.hat === 'xiezhi') { b.line(cx + 2, top - 1, cx + 6, top - 7, C.JADE); }
      if (spec.hat === 'futou_emperor') { b.rect(cx + 1, top + 2, 2, 2, C.GOLD); }
      // tail swinging behind
      b.rect(cx - 11, top + 10, 3, 18, C.BLACK);
      break;
    case 'crown':
      b.rect(cx - 9, top + 7, 19, 5, C.BLACK);
      b.rect(cx - 4, top - 1, 10, 9, C.GOLD);
      b.vline(cx - 1, top, top + 7, C.GOLD_D); b.vline(cx + 2, top, top + 7, C.GOLD_D);
      b.hline(cx - 12, cx + 11, top + 5, C.GOLD_L);
      break;
    case 'helmet':
      b.ellipse(cx, top + 9, 11, 9, C.STONE);
      b.rect(cx - 12, top + 10, 14, 14, C.STONE_D);
      b.hline(cx - 12, cx + 11, top + 10, C.GOLD);
      b.ellipse(cx, top - 8, 3, 4, C.RED);
      break;
    case 'bun':
      b.ellipse(cx - 2, top + 8, 9, 6, C.BLACK);
      b.ellipse(cx - 1, top + 1, 6, 7, C.BLACK);
      b.line(cx + 2, top - 2, cx + 8, top - 6, C.GOLD);
      b.ellipse(cx - 7, top + 5, 2, 2, C.PINK);
      break;
    case 'cap':
      b.rect(cx - 9, top + 6, 18, 6, C.BLACK);
      b.rect(cx - 3, top + 1, 7, 5, C.BLACK);
      break;
  }
}

// ───────────────────────── body ─────────────────────────
function boots(b, cx, dir, step) {
  if (dir === 'side') {
    const a = step === 1 ? 5 : step === -1 ? -4 : 0;
    b.rect(cx - 3 + a, FOOT - 3, 9, 4, C.BLACK);
    b.set(cx + 6 + a, FOOT - 1, C.BLACK);
    b.rect(cx - 3 - a, FOOT - 3, 8, 4, C.INK);
    b.hline(cx - 3 + a, cx + 4 + a, FOOT - 3, C.STONE_D);
    return;
  }
  const l = step === 1 ? -2 : 0;
  const r = step === -1 ? -2 : 0;
  b.rect(cx - 9, FOOT - 3 + l, 7, 4 - l, C.BLACK);
  b.rect(cx + 3, FOOT - 3 + r, 7, 4 - r, C.BLACK);
  b.hline(cx - 9, cx - 4, FOOT - 3 + l, C.STONE_D);
  b.hline(cx + 3, cx + 8, FOOT - 3 + r, C.STONE_D);
}

function robe(b, cx, top, spec, dir, o) {
  const [deep, sh, base, hi] = ROBES[spec.robe];
  const bottom = FOOT - 3;
  const plump = spec.plump ? 2 : 0;
  const w0 = (dir === 'side' ? 9 : 14) + plump; // shoulders
  const w1 = (dir === 'side' ? 12 : 19) + plump; // hem
  const sway = o.sway ?? 0; // hem swing while walking
  const wb = w0 - (dir === 'side' ? 0 : 1); // waist (just above the belt)
  const yb = top + 18;
  const pts = [[cx - w0, top + 3], [cx - w0 + 3, top], [cx + w0 - 3, top], [cx + w0, top + 3], [cx + wb, yb], [cx + w1 + sway, bottom], [cx - w1 + sway, bottom], [cx - wb, yb]];
  b.poly(pts, base);
  const halfAt = (y) => (y <= yb ? Math.round(w0 + (wb - w0) * ((y - top) / (yb - top))) : Math.round(wb + (w1 - wb) * ((y - yb) / (bottom - yb))));
  // shading
  for (let y = top; y <= bottom; y++) {
    const t = (y - top) / (bottom - top);
    const hw = y < top + 3 ? w0 - 3 + y - top : halfAt(y);
    const sx = Math.round(sway * t);
    b.set(cx - hw + sx, y, hi);
    b.set(cx - hw + 1 + sx, y, hi);
    for (let k = 0; k < 4; k++) b.set(cx + hw - k + sx, y, k < 1 ? deep : sh);
  }
  b.hline(cx - w1 + sway, cx + w1 + sway, bottom, deep);
  b.hline(cx - w1 + 1 + sway, cx + w1 - 1 + sway, bottom - 1, sh);
  if (dir === 'lady') return;
  // 襕 — the horizontal band near the hem of a 襕袍
  if (dir !== 'side' && !spec.lady) b.hline(cx - w1 + 2 + sway, cx + w1 - 2 + sway, bottom - 7, sh);
  // folds
  if (dir === 'front' || dir === 'back') {
    for (let y = top + 22; y < bottom - 1; y++) {
      const t = (y - top) / (bottom - top);
      b.set(cx - 5 + Math.round(sway * t) - Math.round(t * 3), y, sh);
      b.set(cx + 6 + Math.round(sway * t) + Math.round(t * 3), y, sh);
    }
    for (let y = top + 34; y < bottom - 1; y++) b.set(cx + Math.round(sway * ((y - top) / (bottom - top))), y, sh);
  } else {
    for (let y = top + 22; y < bottom - 1; y++) b.set(cx + 2 + Math.round(sway * ((y - top) / (bottom - top))), y, sh);
  }
  if (dir === 'front') {
    // round collar 圆领 with white under-collar at the throat
    b.ellipse(cx, top + 1, 6, 3, sh);
    b.ellipse(cx, top + 1, 4, 2, C.JADE);
    b.hline(cx - 3, cx + 3, top - 1, C.SKIN_S);
    b.line(cx + 4, top + 2, cx + 7, top + 6, deep); // collar fastening to the right shoulder
  }
  if (spec.roundels && dir === 'front') {
    for (const [x, y] of [[cx - 7, top + 9], [cx + 7, top + 9], [cx, top + 30], [cx - 9, top + 40], [cx + 10, top + 40]]) {
      b.ellipse(x, y, 3, 3, C.GOLD_L);
      b.ellipse(x, y, 2, 2, C.GOLD);
      b.set(x, y, C.RED);
    }
  }
  // belt 革带 with plaques (銙)
  if (spec.belt !== 'none') {
    const by = top + 19;
    const bw = (dir === 'side' ? 10 : 15) + plump;
    const plate = spec.belt === 'gold' ? C.GOLD : spec.belt === 'jade' ? C.JADE : spec.belt === 'silver' ? C.STONE_L : C.STONE;
    b.rect(cx - bw, by, bw * 2 + 1, 3, C.BLACK);
    for (let x = cx - bw + 1; x <= cx + bw; x += 4) { b.set(x, by + 1, plate); b.set(x + 1, by + 1, plate); }
    if (dir === 'front') {
      // ends hanging
      b.rect(cx + 8, by + 3, 2, 6, C.BLACK);
      if (spec.fish) {
        // 鱼袋 at the right hip
        b.rect(cx + 11 + plump, by + 3, 4, 8, spec.belt === 'gold' ? C.GOLD : C.STONE_L);
        b.vline(cx + 14 + plump, by + 3, by + 10, C.GOLD_D);
        b.set(cx + 12 + plump, by + 5, C.RED_D);
      }
      if (spec.abacusAtBelt) { b.rect(cx - 15 - plump, by + 3, 7, 5, C.DBROWN); b.rect(cx - 14 - plump, by + 4, 5, 3, C.WOOD_L); b.vline(cx - 12 - plump, by + 4, by + 6, C.BLACK); }
      if (spec.rulerAtBelt) { b.vline(cx - 13, by + 2, by + 12, C.GOLD); b.hline(cx - 13, cx - 9, by + 12, C.GOLD); }
    }
  }
  if (spec.armor || spec.armorVest) {
    // 明光铠: chest plates with round mirrors
    const aw = dir === 'side' ? 9 : 12;
    b.rect(cx - aw, top + 2, aw * 2 + 1, 16, C.STONE);
    b.hline(cx - aw, cx + aw, top + 2, C.STONE_L);
    for (let y = top + 6; y < top + 18; y += 3) b.hline(cx - aw, cx + aw, y, C.STONE_D);
    if (dir === 'front') {
      for (const x of [cx - 6, cx + 6]) { b.ellipse(x, top + 9, 4, 4, C.GOLD_D); b.ellipse(x, top + 9, 3, 3, C.GOLD); b.set(x - 1, top + 8, C.GOLD_L); }
      b.vline(cx, top + 2, top + 17, C.STONE_D);
    }
    if (spec.armor) for (let y = top + 24; y < top + 40; y += 3) b.hline(cx - w0 - 1, cx + w0 + 1, y, C.STONE_D);
  }
  if (spec.lady && dir === 'front') {
    // 襦裙: high waist band + striped skirt
    b.rect(cx - w0, top + 8, w0 * 2 + 1, 3, C.GOLD);
    for (let x = cx - w1; x < cx + w1; x += 5) for (let y = top + 12; y < bottom - 1; y++) b.set(x + Math.round(((y - top) / (bottom - top)) * ((x - cx) / 5)), y, C.RED_D);
  }
}

function shawl(b, cx, top, alt = 0) {
  // 披帛 flowing on both sides
  b.line(cx - 12, top + 2, cx - 18, top + 30 + alt, C.GOLD_L);
  b.line(cx - 13, top + 2, cx - 19, top + 30 + alt, C.PAPER);
  b.line(cx + 12, top + 2, cx + 18, top + 30 - alt, C.GOLD_L);
  b.line(cx + 13, top + 2, cx + 19, top + 30 - alt, C.PAPER);
  b.hline(cx - 10, cx + 10, top + 4, C.GOLD_L);
}

/** wide sleeve from shoulder (sx, sy) to hand (hx, hy) */
function sleeve(b, spec, sx, sy, hx, hy, opts = {}) {
  const [deep, sh, base, hi] = ROBES[spec.robe];
  const dx = hx - sx, dy = hy - sy;
  const L = Math.max(1, Math.hypot(dx, dy));
  const ux = dx / L, uy = dy / L;
  let nx = -uy, ny = ux;
  if (ny > 0) { nx = -nx; ny = -ny; } // n points "up"
  const w0 = opts.w0 ?? 5, w1 = opts.w1 ?? 7;
  const droop = opts.droop ?? 5;
  const cx0 = hx - ux * 2, cy0 = hy - uy * 2;
  const pts = [
    [sx + nx * w0, sy + ny * w0],
    [cx0 + nx * w1, cy0 + ny * w1],
    [cx0 - nx * w1, cy0 - ny * w1 + droop],
    [sx - nx * w0, sy - ny * w0],
  ];
  b.poly(pts, base);
  b.line(Math.round(pts[0][0]), Math.round(pts[0][1]), Math.round(pts[1][0]), Math.round(pts[1][1]), opts.shadeTop ? sh : hi);
  b.line(Math.round(pts[2][0]), Math.round(pts[2][1]), Math.round(pts[3][0]), Math.round(pts[3][1]), sh);
  b.line(Math.round(pts[1][0]), Math.round(pts[1][1]), Math.round(pts[2][0]), Math.round(pts[2][1]), deep);
  // crease where the sleeve folds against the body
  const mx = Math.round((pts[2][0] + pts[3][0]) / 2), my = Math.round((pts[2][1] + pts[3][1]) / 2);
  b.line(Math.round(pts[3][0]), Math.round(pts[3][1]) + 1, mx, my + 1, deep);
}
function hand(b, x, y) {
  b.ellipse(x, y, 2, 2, C.SKIN);
  b.set(x + 1, y + 1, C.SKIN_S);
  b.set(x + 2, y, C.SKIN_S);
  b.set(x - 1, y - 1, C.SKIN_L);
}

// ───────────────────────── frame composer ─────────────────────────
/**
 * f: { dir: 'front'|'back'|'side', bob, step, sway, lean,
 *      l: [x, y] | null, r: [x, y] | null      — hand targets relative to (CX, shoulder line)
 *      eyes, mouth, brows, hs, items(b, ctx), front(b, ctx), marks: [...]
 *      pose: 'stand'|'kneel'|'bow-floor'|'sit' }
 */
function frame(spec, f) {
  const b = new Bitmap(FW, FH);
  const pose = f.pose ?? 'stand';
  if (pose === 'kneel' || pose === 'bow-floor' || pose === 'sit') return kneelFrame(b, spec, f);
  const bob = f.bob ?? 0;
  const lean = f.lean ?? 0; // forward bow: head/shoulders lower
  const cx = CX + (f.dx ?? 0);
  const headTop = 8 + bob + lean;
  const bodyTop = 33 + bob + Math.round(lean / 2);
  const sy = bodyTop + 3;
  const ctx = { cx, sy, bodyTop, headTop, b };
  const dir = f.dir ?? 'front';
  if (spec.hold === 'halberd' && dir !== 'side') halberd(b, cx + 19, headTop - 14, FOOT - 1);
  if (dir === 'front') {
    futouTailsFront(b, cx, headTop, spec);
    if (spec.lady) shawl(b, cx, bodyTop, f.alt ? 1 : 0);
    f.behind?.(b, ctx);
    boots(b, cx, dir, f.step ?? 0);
    robe(b, cx, bodyTop, spec, dir, f);
    if (f.armsBehindHead) arms(b, spec, ctx, f);
    headFront(b, cx, headTop, spec, f);
    hatFront(b, cx, headTop, spec, f);
    if (!f.armsBehindHead) arms(b, spec, ctx, f);
  } else if (dir === 'back') {
    boots(b, cx, dir, f.step ?? 0);
    robe(b, cx, bodyTop, spec, dir, f);
    // sleeves hang at the sides
    sleeve(b, spec, cx - 12, sy, cx - 15 + (f.step ?? 0) * 2, sy + 30, { w0: 5, w1: 7, droop: 3 });
    sleeve(b, spec, cx + 12, sy, cx + 15 - (f.step ?? 0) * 2, sy + 30, { w0: 5, w1: 7, droop: 3, shadeTop: true });
    headBack(b, cx, headTop, spec);
    if (spec.hold === 'halberd') halberd(b, cx + 19, headTop - 14, FOOT - 1);
  } else {
    if (spec.hold === 'halberd') halberd(b, cx + 12, headTop - 14, FOOT - 1);
    boots(b, cx, dir, f.step ?? 0);
    robe(b, cx, bodyTop, spec, 'side', f);
    headSide(b, cx, headTop, spec, f);
    // one sleeve in front, swinging with the step
    const swing = (f.step ?? 0) * 4;
    const hx = cx + 6 + swing, hy = sy + (spec.hold === 'none' ? 26 : 16);
    sleeve(b, spec, cx - 1, sy + 1, hx, hy, { w0: 5, w1: 7, droop: 4 });
    hand(b, hx + 1, hy);
    if (spec.hold === 'hu') hu(b, hx + 2, hy + 1, 18, 2);
    else if (spec.hold === 'scroll') scrollRolled(b, hx - 2, hy - 2, 10);
    else if (spec.hold === 'book') bookClosed(b, hx - 3, hy - 6);
  }
  for (const m of f.marks ?? []) m(b, ctx);
  b.outline(C.INK);
  return b;
}

/** front-view arms + held items */
function arms(b, spec, ctx, f) {
  const { cx, sy } = ctx;
  const L = f.l ?? [-3, 24];
  const R = f.r ?? [3, 24];
  const lh = [cx + L[0], sy + L[1]];
  const rh = [cx + R[0], sy + R[1]];
  f.itemsBack?.(b, ctx, lh, rh);
  sleeve(b, spec, cx - 12, sy, lh[0], lh[1], { droop: f.lDroop ?? 5 });
  sleeve(b, spec, cx + 12, sy, rh[0], rh[1], { droop: f.rDroop ?? 5, shadeTop: true });
  if (!f.hideL) hand(b, lh[0], lh[1]);
  if (!f.hideR) hand(b, rh[0], rh[1]);
  f.items?.(b, ctx, lh, rh);
}

/** kneeling (跪), bowing to the floor (叩首) and sitting on the heels (跪坐) */
function kneelFrame(b, spec, f) {
  const [deep, sh, base, hi] = ROBES[spec.robe];
  const cx = CX + (f.dx ?? 0);
  const bob = f.bob ?? 0;
  if (f.pose === 'bow-floor') {
    // kowtow: back view of the hat, sleeves flat on the floor
    b.poly([[cx - 18, FOOT - 22], [cx + 18, FOOT - 22], [cx + 24, FOOT], [cx - 24, FOOT]], base);
    b.hline(cx - 24, cx + 24, FOOT, deep);
    b.hline(cx - 22, cx + 22, FOOT - 1, sh);
    for (let y = FOOT - 22; y <= FOOT; y++) b.set(cx - 18 - Math.round((y - FOOT + 22) * 0.27), y, hi);
    b.poly([[cx - 20, FOOT - 9], [cx + 20, FOOT - 9], [cx + 22, FOOT - 1], [cx - 22, FOOT - 1]], sh);
    b.rect(cx - 6, FOOT - 5, 13, 3, C.SKIN);
    const ht = FOOT - 44 + bob;
    headBack(b, cx, ht + 8, spec, 8);
    if (spec.belt !== 'none') b.rect(cx - 16, FOOT - 18, 33, 2, C.BLACK);
    for (const m of f.marks ?? []) m(b, { cx, sy: ht + 36, headTop: ht + 8, bodyTop: ht + 30, b });
    b.outline(C.INK);
    return b;
  }
  const sit = f.pose === 'sit';
  const headTop = (sit ? 26 : 22) + bob;
  const bodyTop = headTop + 25;
  const sy = bodyTop + 3;
  // robe spread over the knees
  const w0 = 14 + (spec.plump ? 2 : 0);
  b.poly([[cx - w0, bodyTop + 3], [cx - w0 + 3, bodyTop], [cx + w0 - 3, bodyTop], [cx + w0, bodyTop + 3], [cx + w0 + 3, FOOT - 14], [cx + 23, FOOT], [cx - 23, FOOT], [cx - w0 - 3, FOOT - 14]], base);
  for (let y = bodyTop; y <= FOOT; y++) {
    const t = (y - bodyTop) / (FOOT - bodyTop);
    const hw = Math.round(w0 + (23 - w0) * t);
    b.set(cx - hw, y, hi); b.set(cx - hw + 1, y, hi);
    b.set(cx + hw, y, deep); b.set(cx + hw - 1, y, sh); b.set(cx + hw - 2, y, sh);
  }
  b.hline(cx - 23, cx + 23, FOOT, deep);
  b.hline(cx - 20, cx + 20, FOOT - 12, sh); // knees
  b.vline(cx, FOOT - 11, FOOT - 1, sh);
  b.ellipse(cx, bodyTop + 1, 6, 3, sh);
  b.ellipse(cx, bodyTop + 1, 4, 2, C.JADE);
  if (spec.roundels) for (const [x, y] of [[cx - 7, bodyTop + 9], [cx + 7, bodyTop + 9], [cx - 12, FOOT - 6], [cx + 12, FOOT - 6]]) { b.ellipse(x, y, 3, 3, C.GOLD_L); b.ellipse(x, y, 2, 2, C.GOLD); b.set(x, y, C.RED); }
  if (spec.belt !== 'none') {
    const plate = spec.belt === 'gold' ? C.GOLD : spec.belt === 'jade' ? C.JADE : C.STONE_L;
    b.rect(cx - 15, bodyTop + 17, 31, 3, C.BLACK);
    for (let x = cx - 14; x <= cx + 15; x += 4) { b.set(x, bodyTop + 18, plate); b.set(x + 1, bodyTop + 18, plate); }
  }
  if (spec.armor || spec.armorVest) { b.rect(cx - 12, bodyTop + 2, 25, 14, C.STONE); for (let y = bodyTop + 5; y < bodyTop + 16; y += 3) b.hline(cx - 12, cx + 12, y, C.STONE_D); }
  if (spec.lady) shawl(b, cx, bodyTop, 0);
  futouTailsFront(b, cx, headTop, spec);
  headFront(b, cx, headTop, spec, f);
  hatFront(b, cx, headTop, spec, f);
  const ctx = { cx, sy, bodyTop, headTop, b };
  arms(b, spec, ctx, { l: [-4, 18], r: [4, 18], ...f, items: f.items ?? ((bb, c, lh, rh) => { if (spec.hold === 'hu' && !sit) hu(bb, cx, lh[1] + 2, 18); void rh; }) });
  for (const m of f.marks ?? []) m(b, ctx);
  b.outline(C.INK);
  return b;
}

// ───────────────────────── animation definitions ─────────────────────────
const H = (spec) => (b, ctx, lh) => {
  // default held item while hands are clasped
  if (spec.hold === 'hu') hu(b, ctx.cx, lh[1] + 2, 20);
  else if (spec.hold === 'scroll') scrollRolled(b, ctx.cx - 6, lh[1] - 4, 12);
  else if (spec.hold === 'book') bookClosed(b, ctx.cx - 5, lh[1] - 10);
};
const CLASP = { l: [-3, 24], r: [3, 24] };

function animFrames(name, spec) {
  const hold = H(spec);
  const base = { dir: 'front', ...CLASP, items: hold };
  const rel = (lh, rh) => ({ l: lh, r: rh });
  const free = spec.hold === 'halberd' || spec.hold === 'none';
  const restArms = free ? { l: [-17, 27], r: [17, 27], items: undefined, lDroop: 3, rDroop: 3 } : {};
  switch (name) {
    case 'idle':
      return [0, 0, 1, 1].map((bob, i) => ({ ...base, ...restArms, bob, eyes: i === 3 ? 'closed' : 'open' }));
    case 'walk_down':
      return [1, 0, -1, 0].map((st) => ({ ...base, ...restArms, step: st, bob: st === 0 ? 1 : 0, sway: -st }));
    case 'walk_up':
      return [1, 0, -1, 0].map((st) => ({ dir: 'back', step: st, bob: st === 0 ? 1 : 0, sway: -st }));
    case 'walk_side':
      return [1, 0, -1, 0].map((st) => ({ dir: 'side', step: st, bob: st === 0 ? 1 : 0, sway: -st * 2 }));
    case 'talk':
      return [0, 1, 2, 1].map((k) => ({ ...base, r: [16 + k, -2 - k * 2], hideR: false, mouth: k % 2 ? 'closed' : 'open', items: (b, ctx, lh) => { if (spec.hold === 'hu') hu(b, lh[0] + 1, lh[1] + 2, 20); } }));
    case 'think':
      return [0, 0, 1, 1].map((k, i) => ({ ...base, r: [6, -3], l: [4, 14], eyes: i === 1 ? 'closed' : 'up', items: undefined, marks: i >= 2 ? [(b, c) => { b.set(c.cx + 16, c.headTop + 2 - k, C.SKY_L); b.set(c.cx + 19, c.headTop - 2 - k, C.SKY_L); b.set(c.cx + 18, c.headTop - 1 - k, C.SKY_L); }] : [] }));
    case 'kneel':
      return [
        { pose: 'kneel', bob: 0, eyes: 'down' },
        { pose: 'kneel', bob: 1, eyes: 'down' },
        { pose: 'bow-floor', bob: 0 },
        { pose: 'bow-floor', bob: 1 },
      ];
    case 'reject':
      return [
        { ...base, brows: 'angry', mouth: 'open', r: [14, -10], l: [-6, 18], items: (b, ctx, lh, rh) => scrollRolled(b, rh[0] - 6, rh[1] - 6, 12), marks: [(b, c) => anger(b, c.cx + 12, c.headTop + 2)] },
        { ...base, brows: 'angry', mouth: 'open', r: [22, 4], l: [-6, 18], items: (b) => { const x = 50, y = 46; b.rect(x, y, 10, 4, C.PAPER); b.rect(x - 1, y - 1, 2, 6, C.GOLD); b.rect(x + 9, y - 1, 2, 6, C.GOLD); }, marks: [(b, c) => anger(b, c.cx + 12, c.headTop + 2)] },
        { ...base, brows: 'angry', mouth: 'closed', r: [20, 8], l: [-6, 18], items: (b) => { const x = 52, y = 62; b.rect(x, y, 4, 10, C.PAPER); b.rect(x - 1, y - 1, 6, 2, C.GOLD); b.rect(x - 1, y + 9, 6, 2, C.GOLD); } },
        { ...base, brows: 'angry', l: [-12, -4], r: [12, -4], items: (b, ctx) => huFlat(b, ctx.cx - 12, ctx.sy - 7, 25) },
      ];
    case 'bow':
      // 作揖: hands raised together, body bending
      return [0, 2, 4, 2].map((lean, i) => ({ ...base, lean, l: [-2, 12 + lean], r: [2, 12 + lean], eyes: lean > 2 ? 'closed' : 'down', mouth: i === 2 ? 'closed' : 'closed', items: (b, ctx, lh) => { if (spec.hold === 'hu') hu(b, ctx.cx, lh[1] + 3, 20); } }));
    case 'present':
      // 执笏奏事: tablet raised before the face
      return [0, 1, 0, 1].map((k) => ({ ...base, l: [-2, 2 + k * 2], r: [2, 2 + k * 2], mouth: k ? 'open' : 'closed', items: (b, ctx, lh) => (spec.hold === 'hu' || free ? hu(b, ctx.cx, lh[1] + 2, 22) : scrollRolled(b, ctx.cx - 6, lh[1] - 3, 12)) }));
    case 'read':
      return [0, 1, 2, 3].map((k) => ({ ...base, l: [-14, 15], r: [14, 15], eyes: 'down', hs: k < 2 ? -1 : 1, items: (b, ctx) => scrollOpen(b, ctx.cx - 13, ctx.sy + 10, 26, 10, k) }));
    case 'write':
      return [0, 1, 2, 3].map((k) => ({ ...base, l: [-9, 22], r: [5 + (k % 2) * 2, 15 + (k > 1 ? 2 : 0)], eyes: 'down', items: (b, ctx, lh, rh) => { paper(b, ctx.cx - 14, ctx.sy + 17, 18, 12, 1 + k); brush(b, rh[0], rh[1], -3, 7); } }));
    case 'seal':
      return [
        { ...base, l: [-8, 22], r: [10, 0], eyes: 'down', items: (b, ctx, lh, rh) => { paper(b, ctx.cx - 12, ctx.sy + 18, 20, 12, 3); sealBlock(b, rh[0], rh[1] - 2); } },
        { ...base, l: [-8, 22], r: [6, 8], eyes: 'down', items: (b, ctx, lh, rh) => { paper(b, ctx.cx - 12, ctx.sy + 18, 20, 12, 3); sealBlock(b, rh[0], rh[1] - 2); } },
        { ...base, bob: 1, l: [-8, 22], r: [2, 16], eyes: 'closed', items: (b, ctx, lh, rh) => { paper(b, ctx.cx - 12, ctx.sy + 18, 20, 12, 3); sealBlock(b, rh[0], rh[1] - 2); } },
        { ...base, l: [-8, 22], r: [12, 10], mouth: 'smile', items: (b, ctx) => { paper(b, ctx.cx - 12, ctx.sy + 18, 20, 12, 3); b.rect(ctx.cx - 2, ctx.sy + 22, 5, 5, C.RED); b.rect(ctx.cx - 1, ctx.sy + 23, 3, 3, C.RED_L); } },
      ];
    case 'dispatch':
      return [0, 1, 2, 3].map((k) => ({ ...base, l: [-10, 20], r: k === 0 ? [8, 18] : k === 1 ? [18, 10] : k === 2 ? [24, 8] : [14, 16], mouth: k === 2 ? 'open' : 'closed', items: (b, ctx, lh, rh) => { for (let i = 0; i < 3; i++) token(b, lh[0] - 4 + i * 3, lh[1] - 9 - (i % 2)); if (k > 0 && k < 3) token(b, rh[0] + 1, rh[1] - 8); } }));
    case 'abacus':
      return [0, 1, 2, 3].map((k) => ({ ...base, l: [-10, 20], r: [6 + (k % 2) * 3, 18], eyes: 'down', mouth: k === 3 ? 'open' : 'closed', items: (b, ctx) => abacus(b, ctx.cx - 10, ctx.sy + 14, k) }));
    case 'search':
      return [0, 1, 2, 0].map((flip, k) => ({ ...base, l: [-10, 20], r: [4 + flip * 4, 13], eyes: k % 2 ? 'left' : 'right', items: (b, ctx) => bookOpen(b, ctx.cx - 9, ctx.sy + 13, flip) }));
    case 'view':
      return [0, 1, 0, -1].map((sway, k) => ({ ...base, l: [-11, 2], r: [11, 2], eyes: 'down', hs: k === 1 ? 1 : 0, items: (b, ctx) => hangingScroll(b, ctx.cx, ctx.sy + 1, sway) }));
    case 'scheme':
      // 兵部: baton pointing over a sand table, other hand on the hip
      return [0, 1, 2, 1].map((k) => ({ ...base, l: [-16, 18], lDroop: 2, r: [18, 20 + k * 3], mouth: k === 2 ? 'open' : 'closed', eyes: 'down', items: (b, ctx, lh, rh) => baton(b, rh[0], rh[1], rh[0] + 9, rh[1] + 12 + k) }));
    case 'law':
      return [1, 0, -1, 0].map((tilt) => ({ ...base, l: [-8, 20], r: [16, -4], eyes: 'right', brows: 'angry', items: (b, ctx, lh, rh) => { bookClosed(b, lh[0] - 4, lh[1] - 10); scales(b, rh[0], rh[1] + 1, tilt); } }));
    case 'measure':
      return [0, 1, 2, 1].map((k) => ({ ...base, l: [-11, 20], r: [10 + k * 2, 16 - k], eyes: 'down', items: (b, ctx, lh, rh) => { scrollOpen(b, ctx.cx - 16, ctx.sy + 18, 18, 9, 0); quadrant(b, rh[0] - 2, rh[1] + 5, 0); } }));
    case 'worry':
      return [0, 1, 0, 1].map((k) => ({ ...base, r: [11, -16 + k * 2], l: [-3, 22], brows: 'worried', eyes: 'squint', mouth: 'wavy', items: undefined, marks: [(b, c) => sweat(b, c.cx - 13, c.headTop + 10 + k * 2)] }));
    case 'joy':
      return [0, 1, 0, 1].map((k) => ({ ...base, l: [-17, 8 - k * 3], r: [17, 8 - k * 3], bob: k ? -1 : 0, mouth: 'smile', eyes: k ? 'closed' : 'open', items: undefined, marks: [(b, c) => { sparkle(b, c.cx - 15 + k * 2, c.headTop + 1); sparkle(b, c.cx + 16 - k * 2, c.headTop + 6 - k * 3); }] }));
    case 'fear':
      return [0, 1, 0, -1].map((dx) => ({ pose: 'bow-floor', dx, marks: [(b, c) => { sweat(b, c.cx - 15, c.headTop + 4); sweat(b, c.cx + 15, c.headTop + 8); }] }));
    case 'tea':
      return [0, 1, 2, 1].map((k) => ({ ...base, l: [-4, 22], r: k === 2 ? [5, -1] : k === 1 ? [6, 10] : [3, 21], eyes: k === 2 ? 'closed' : 'open', items: (b, ctx, lh, rh) => { b.hline(lh[0] - 5, lh[0] + 4, lh[1] - 3, C.TEAL); cup(b, rh[0], rh[1] - 6, k === 0 ? 1 : k === 3 ? 2 : 0); } }));
    case 'stretch':
      return [0, 1, 1, 0].map((k, i) => ({ ...base, armsBehindHead: true, l: k ? [-13, -26] : [-16, -10], r: k ? [13, -26] : [16, -10], mouth: i === 1 || i === 2 ? 'yawn' : 'closed', eyes: 'closed', bob: k ? -1 : 0, items: undefined }));
    case 'look':
      return [-2, -2, 2, 2].map((hs, i) => ({ ...base, ...restArms, hs, eyes: hs < 0 ? 'left' : 'right', bob: i % 2 }));
    case 'sit_idle':
      return [0, 0, 1, 1].map((bob, i) => ({ pose: 'sit', bob, l: [-12, 20], r: [12, 20], eyes: i === 3 ? 'closed' : 'open', items: () => {} }));
    case 'sit_talk':
      return [0, 1, 2, 1].map((k) => ({ pose: 'sit', l: [-12, 20], r: [16 + k, -2 - k * 2], mouth: k % 2 ? 'closed' : 'open', items: () => {} }));
    case 'sit_write':
      return [0, 1, 2, 3].map((k) => ({ pose: 'sit', l: [-9, 20], r: [5 + (k % 2) * 2, 13 + (k > 1 ? 2 : 0)], eyes: 'down', items: (b, ctx, lh, rh) => { paper(b, ctx.cx - 14, ctx.sy + 15, 18, 10, 1 + k); brush(b, rh[0], rh[1], -3, 7); } }));
  }
  throw new Error(`unknown anim ${name}`);
}

export function buildSheet(key) {
  const spec = CHARACTERS[key];
  const frames = [];
  for (const a of LAYOUT.anims) {
    const defs = animFrames(a.name, spec);
    if (defs.length !== a.frames) throw new Error(`${key}:${a.name} has ${defs.length} frames, layout says ${a.frames}`);
    for (const d of defs) frames.push(frame(spec, d));
  }
  const rows = Math.ceil(frames.length / COLS);
  const sheet = new Bitmap(FW * COLS, FH * rows);
  frames.forEach((f, i) => sheet.blit(f, (i % COLS) * FW, Math.floor(i / COLS) * FH));
  return { sheet, frames: frames.length };
}
