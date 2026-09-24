// Procedural Tang-dynasty court characters — 32×48 frames, light from top-left, 1px ink outline.
import { Bitmap, C } from './raster.mjs';

export const FW = 32;
export const FH = 48;

// Animation layout shared by every sprite sheet (22 frames, 11 × 2 grid).
export const ANIMS = {
  idle: [0, 1],
  walk_down: [2, 3, 4, 5],
  walk_up: [6, 7, 8, 9],
  walk_side: [10, 11, 12, 13],
  talk: [14, 15],
  think: [16, 17],
  kneel: [18, 19],
  reject: [20, 21],
};

const ROBES = {
  yellow: [C.GOLD_D, C.GOLD, C.GOLD_L],
  purple: [C.PUR_D, C.PUR, C.PUR_L],
  crimson: [C.RED_D, C.CRIMSON, C.RED_L],
  red: [C.RED_D, C.RED, C.RED_L],
  green: [C.GRN_D, C.GRN, C.GRN_L],
  teal: [C.BLU_D, C.TEAL, C.SKY],
  blue: [C.BLU_D, C.BLU, C.SKY],
  black: [C.BLACK, C.BLU_D, C.BLU],
  steel: [C.STONE_D, C.STONE, C.STONE_L],
  cream: [C.STONE, C.PAPER, C.JADE],
};

export const CHARACTERS = {
  emperor: { robe: 'yellow', hat: 'emperor', hold: 'none', beard: true, seated: true, belt: C.GOLD, emblem: true },
  taizi: { robe: 'crimson', hat: 'crown', hold: 'hu', beard: false, belt: C.GOLD },
  zhongshu: { robe: 'purple', hat: 'futou', hold: 'hu', beard: true, belt: C.GOLD, badge: C.GOLD_L },
  menxia: { robe: 'purple', hat: 'futou', hold: 'hu', beard: true, belt: C.GOLD, badge: C.RED_L, longBeard: true },
  shangshu: { robe: 'purple', hat: 'futou', hold: 'hu', beard: true, belt: C.GOLD, badge: C.SKY },
  hubu: { robe: 'crimson', hat: 'futou', hold: 'hu', beard: true, belt: C.GOLD },
  libu: { robe: 'green', hat: 'futou', hold: 'scroll', beard: false, belt: C.BLACK },
  bingbu: { robe: 'crimson', hat: 'futou', hold: 'hu', beard: true, belt: C.BLACK, armorVest: true },
  xingbu: { robe: 'black', hat: 'futou', hold: 'hu', beard: true, belt: C.GOLD, longBeard: true },
  gongbu: { robe: 'teal', hat: 'futou', hold: 'hu', beard: false, belt: C.BLACK },
  libu_hr: { robe: 'purple', hat: 'futou', hold: 'scroll', beard: false, belt: C.GOLD },
  zaochao: { robe: 'blue', hat: 'futou', hold: 'hu', beard: false, belt: C.BLACK },
  solo: { robe: 'purple', hat: 'futou', hold: 'hu', beard: false, belt: C.JADE, badge: C.JADE },
  guard: { robe: 'red', hat: 'helmet', hold: 'halberd', beard: false, belt: C.BLACK, armor: true },
  lady: { robe: 'red', hat: 'bun', hold: 'none', beard: false, belt: C.GOLD, lady: true },
  clerk: { robe: 'green', hat: 'cap', hold: 'scroll', beard: false, belt: C.BLACK },
};

// ───────────────────────── parts ─────────────────────────
function head(b, cx, top, dir, spec, o) {
  o = { hs: 0, ...o };
  const face = dir !== 'back';
  // face / back of head
  b.ellipse(cx, top + 6, 5, 6, face ? C.SKIN : C.BLACK);
  if (face) {
    // cheek shadow on right (light from top-left)
    for (let y = top + 3; y <= top + 11; y++) b.set(cx + (dir === 'side' ? -4 : 4), y, C.SKIN_S);
    if (dir === 'front') {
      const ey = top + 6 + (o.lookUp ? -1 : 0);
      const blink = o.blink;
      b.set(cx - 2 + o.hs, ey, blink ? C.SKIN_S : C.INK);
      b.set(cx + 2 + o.hs, ey, blink ? C.SKIN_S : C.INK);
      b.set(cx - 3 + o.hs, ey - 2, C.DBROWN); b.set(cx - 2 + o.hs, ey - 2, C.DBROWN); // brows
      b.set(cx + 2 + o.hs, ey - 2, C.DBROWN); b.set(cx + 3 + o.hs, ey - 2, C.DBROWN);
      if (o.mouthOpen) { b.set(cx + o.hs, top + 9, C.RED_D); b.set(cx + 1 + o.hs, top + 9, C.RED_D); b.set(cx + o.hs, top + 10, C.RED_D); }
      else b.set(cx + o.hs, top + 9, C.SKIN_S);
      if (spec.beard) {
        b.set(cx - 2 + o.hs, top + 8, C.BLACK); b.set(cx + 2 + o.hs, top + 8, C.BLACK); // moustache
        b.set(cx + o.hs, top + 11, C.BLACK); b.set(cx + o.hs, top + 12, C.BLACK);
        if (spec.longBeard) { b.set(cx + o.hs, top + 13, C.BLACK); b.set(cx - 1 + o.hs, top + 12, C.BLACK); b.set(cx + 1 + o.hs, top + 12, C.BLACK); b.set(cx + o.hs, top + 14, C.BLACK); }
      }
      if (spec.lady) { b.set(cx - 3 + o.hs, top + 8, C.RED_L); b.set(cx + 3 + o.hs, top + 8, C.RED_L); b.set(cx + o.hs, top + 9, C.RED); }
    } else {
      // side profile facing right
      b.set(cx + 5, top + 6, C.SKIN); b.set(cx + 6, top + 7, C.SKIN); // nose
      b.set(cx + 3, top + 5, C.INK); // eye
      b.set(cx + 2, top + 3, C.DBROWN); b.set(cx + 3, top + 3, C.DBROWN);
      if (o.mouthOpen) b.set(cx + 4, top + 9, C.RED_D);
      if (spec.beard) { b.set(cx + 3, top + 11, C.BLACK); b.set(cx + 3, top + 12, C.BLACK); if (spec.longBeard) b.set(cx + 3, top + 13, C.BLACK); }
      // hair at back of head
      for (let y = top + 1; y <= top + 9; y++) { b.set(cx - 4, y, C.BLACK); b.set(cx - 5, y, C.BLACK); }
    }
  }
  // ears
  if (dir === 'front') { b.set(cx - 6, top + 6, C.SKIN_S); b.set(cx + 6, top + 6, C.SKIN_S); }
  // hats
  const ht = top - 1;
  switch (spec.hat) {
    case 'futou': // 幞头: black cap band + rounded crown (巾子); soft tails hang at the back
      b.rect(cx - 5, ht, 11, 4, C.BLACK);
      b.ellipse(cx, ht - 2, 4, 3, C.BLACK);
      b.set(cx - 2, ht - 3, C.STONE_D); b.set(cx - 3, ht - 2, C.STONE_D);
      if (dir === 'back') { b.rect(cx - 3, top + 7, 2, 10, C.BLACK); b.rect(cx + 2, top + 7, 2, 10, C.BLACK); }
      else if (dir === 'side') { b.rect(cx - 7, top + 3, 2, 8, C.BLACK); }
      if (dir === 'front') { b.set(cx - 5, top + 4, C.BLACK); b.set(cx + 5, top + 4, C.BLACK); b.set(cx - 5, top + 5, C.BLACK); b.set(cx + 5, top + 5, C.BLACK); }
      break;
    case 'emperor': // 幞头 with gold ornament & upright wings (翼善冠 hint)
      b.rect(cx - 5, ht, 11, 4, C.BLACK);
      b.ellipse(cx, ht - 2, 4, 3, C.BLACK);
      b.set(cx, ht - 1, C.GOLD_L); b.set(cx, ht, C.GOLD); b.set(cx - 1, ht, C.GOLD); b.set(cx + 1, ht, C.GOLD);
      if (dir !== 'side') { b.rect(cx - 9, ht - 3, 3, 2, C.BLACK); b.rect(cx + 7, ht - 3, 3, 2, C.BLACK); b.set(cx - 7, ht - 1, C.BLACK); b.set(cx + 7, ht - 1, C.BLACK); }
      break;
    case 'crown': // 太子金冠
      b.rect(cx - 5, ht + 1, 11, 3, C.BLACK);
      b.rect(cx - 3, ht - 3, 7, 4, C.GOLD);
      b.set(cx - 3, ht - 4, C.GOLD_L); b.set(cx, ht - 5, C.GOLD_L); b.set(cx + 3, ht - 4, C.GOLD_L);
      b.hline(cx - 3, cx + 3, ht - 3, C.GOLD_L);
      b.hline(cx - 7, cx + 7, ht + 1, C.GOLD_D); // hairpin
      break;
    case 'helmet': // 兜鍪 with red tassel
      b.ellipse(cx, ht + 2, 6, 4, C.STONE);
      b.hline(cx - 6, cx + 6, ht + 4, C.STONE_D);
      b.set(cx - 3, ht, C.STONE_L); b.set(cx - 2, ht - 1, C.STONE_L);
      b.rect(cx - 1, ht - 5, 2, 3, C.RED); b.set(cx, ht - 6, C.RED_L);
      if (dir !== 'back') { b.vline(cx - 6, top + 4, top + 10, C.STONE_D); b.vline(cx + 6, top + 4, top + 10, C.STONE_D); }
      break;
    case 'bun': // court lady high bun with gold pin
      b.ellipse(cx, ht, 5, 3, C.BLACK);
      b.ellipse(cx, ht - 4, 3, 3, C.BLACK);
      b.set(cx + 3, ht - 3, C.GOLD_L); b.set(cx + 4, ht - 4, C.GOLD); b.set(cx - 4, ht - 1, C.RED_L);
      if (dir === 'front') { b.vline(cx - 6, top + 2, top + 9, C.BLACK); b.vline(cx + 6, top + 2, top + 9, C.BLACK); }
      break;
    case 'cap':
      b.rect(cx - 5, ht, 11, 4, C.BLACK);
      b.ellipse(cx, ht - 1, 4, 2, C.BLACK);
      break;
  }
}

function robeBody(b, cx, top, bottom, dir, spec, o) {
  const [sh, base, hi] = ROBES[spec.robe];
  const w0 = dir === 'side' ? 5 : 8; // half width at shoulders
  const w1 = dir === 'side' ? 6 : 10; // half width at hem
  b.poly([[cx - w0, top], [cx + w0, top], [cx + w1, bottom], [cx - w1, bottom]], base);
  // light left, shade right
  for (let y = top; y <= bottom; y++) {
    const t = (y - top) / (bottom - top);
    const hw = Math.round(w0 + (w1 - w0) * t);
    b.set(cx - hw, y, hi);
    b.set(cx - hw + 1, y, hi);
    b.set(cx + hw, y, sh);
    b.set(cx + hw - 1, y, sh);
    b.set(cx + hw - 2, y, sh);
  }
  // hem shadow & folds
  b.hline(cx - w1, cx + w1, bottom, sh);
  if (dir !== 'side') {
    for (let y = top + 12; y < bottom; y++) {
      b.set(cx - 3, y, sh);
      b.set(cx + 4, y, sh);
    }
  }
  // round collar (圆领)
  if (dir === 'front') {
    b.hline(cx - 3, cx + 3, top, sh);
    b.set(cx - 4, top + 1, sh); b.set(cx + 4, top + 1, sh);
    b.set(cx - 2, top + 1, C.JADE); b.set(cx + 2, top + 1, C.JADE);
  }
  // belt 革带 with plaques
  const by = top + 11;
  if (dir !== 'back' || true) {
    const bw = dir === 'side' ? 5 : 8;
    b.hline(cx - bw, cx + bw, by, spec.belt === C.JADE ? C.BLACK : spec.belt === C.GOLD ? C.BLACK : spec.belt);
    for (let x = cx - bw + 1; x <= cx + bw; x += 3) b.set(x, by, spec.belt === C.BLACK ? C.STONE : spec.belt);
  }
  if (spec.emblem && dir === 'front') {
    // dragon roundel on chest (团龙)
    b.ellipse(cx + 4, top + 5, 2, 2, C.GOLD_L);
    b.set(cx + 4, top + 5, C.RED);
    b.ellipse(cx - 4, top + 5, 2, 2, C.GOLD_L);
    b.set(cx - 4, top + 5, C.RED);
  }
  if (spec.armor || spec.armorVest) {
    // 明光铠 plates over chest
    const aw = dir === 'side' ? 4 : 6;
    b.rect(cx - aw, top + 1, aw * 2 + 1, 9, C.STONE);
    b.hline(cx - aw, cx + aw, top + 1, C.STONE_L);
    if (dir === 'front') { b.ellipse(cx - 3, top + 5, 2, 2, C.GOLD); b.ellipse(cx + 3, top + 5, 2, 2, C.GOLD); b.set(cx - 3, top + 5, C.GOLD_L); b.set(cx + 3, top + 5, C.GOLD_L); }
    for (let y = top + 3; y < top + 10; y += 2) b.set(cx + aw, y, C.STONE_D);
    if (spec.armor) {
      // tassets (skirt plates)
      for (let y = top + 13; y < top + 20; y += 2) b.hline(cx - 7, cx + 7, y, C.STONE_D);
    }
  }
  if (spec.badge && dir === 'front') b.set(cx + 6, by, spec.badge);
  if (spec.lady && dir === 'front') {
    // 披帛 shawl
    b.line(cx - 8, top + 2, cx - 10, top + 16, C.GOLD_L);
    b.line(cx + 8, top + 2, cx + 10, top + 16, C.GOLD_L);
    b.hline(cx - 5, cx + 5, top + 3, C.GOLD_L);
  }
  void o;
}

function feet(b, cx, y, dir, step) {
  if (dir === 'side') {
    const a = step === 1 ? 3 : step === -1 ? -2 : 0;
    b.rect(cx - 2 + a, y, 5, 2, C.BLACK);
    b.rect(cx - 2 - a, y, 4, 2, C.BLACK);
    b.set(cx + 3 + a, y + 1, C.BLACK);
    return;
  }
  const l = step === 1 ? -1 : 0;
  const r = step === -1 ? -1 : 0;
  b.rect(cx - 5, y + l, 4, 2 - l, C.BLACK);
  b.rect(cx + 2, y + r, 4, 2 - r, C.BLACK);
  b.set(cx - 5, y + l, C.STONE_D);
  b.set(cx + 2, y + r, C.STONE_D);
}

function arms(b, cx, top, dir, spec, o) {
  const [sh, base, hi] = ROBES[spec.robe];
  if (dir === 'back') {
    b.poly([[cx - 8, top], [cx - 11, top + 14], [cx - 7, top + 17]], base);
    b.poly([[cx + 8, top], [cx + 11, top + 14], [cx + 7, top + 17]], sh);
    return;
  }
  if (dir === 'side') {
    // one big sleeve in front, hands forward holding item
    b.poly([[cx - 2, top + 1], [cx + 5, top + 6], [cx + 7, top + 15], [cx + 1, top + 16], [cx - 3, top + 8]], base);
    b.line(cx - 2, top + 1, cx - 3, top + 8, hi);
    b.line(cx + 7, top + 15, cx + 1, top + 16, sh);
    b.rect(cx + 6, top + 6, 2, 2, C.SKIN);
    if (spec.hold === 'hu') b.rect(cx + 7, top - 3, 2, 10, C.PAPER);
    if (spec.hold === 'scroll') b.rect(cx + 6, top + 4, 4, 3, C.PAPER);
    if (spec.hold === 'halberd') b.vline(cx + 8, top - 18, top + 22, C.WOOD);
    return;
  }
  // front
  const pose = o.arm;
  const leftSleeve = () => {
    b.poly([[cx - 8, top], [cx - 12, top + 13], [cx - 9, top + 17], [cx - 2, top + 11], [cx - 3, top + 6]], base);
    b.line(cx - 8, top, cx - 12, top + 13, hi);
    b.line(cx - 9, top + 17, cx - 2, top + 11, sh);
  };
  const rightSleeve = () => {
    b.poly([[cx + 8, top], [cx + 12, top + 13], [cx + 9, top + 17], [cx + 2, top + 11], [cx + 3, top + 6]], base);
    b.line(cx + 12, top + 13, cx + 9, top + 17, sh);
    b.line(cx + 8, top, cx + 12, top + 13, sh);
  };
  if (pose === 'hold' || pose === 'kneel') {
    leftSleeve();
    rightSleeve();
    b.rect(cx - 2, top + 8, 5, 3, C.SKIN); // clasped hands
    b.set(cx + 2, top + 10, C.SKIN_S);
    if (spec.hold === 'hu') { b.rect(cx - 1, top + 1, 3, 9, C.PAPER); b.vline(cx + 1, top + 1, top + 8, C.STONE_L); b.rect(cx - 2, top + 8, 5, 3, C.SKIN); }
    if (spec.hold === 'scroll') { b.rect(cx - 4, top + 6, 9, 3, C.PAPER); b.set(cx - 4, top + 6, C.RED); b.set(cx + 4, top + 6, C.RED); b.hline(cx - 3, cx + 3, top + 8, C.STONE_L); }
  } else if (pose === 'raise' || pose === 'wave') {
    leftSleeve();
    // right arm raised to shoulder height, open hand
    const up = pose === 'wave' && o.alt ? -2 : 0;
    b.poly([[cx + 7, top], [cx + 15, top - 6 + up], [cx + 16, top - 2 + up], [cx + 9, top + 7]], base);
    b.line(cx + 9, top + 7, cx + 16, top - 2 + up, sh);
    b.rect(cx + 14, top - 9 + up, 3, 4, C.SKIN);
    b.set(cx + 13, top - 8 + up, C.SKIN);
    if (spec.hold === 'hu' && pose === 'raise') { b.rect(cx - 1, top + 2, 3, 10, C.PAPER); b.rect(cx - 2, top + 8, 4, 3, C.SKIN); }
  } else if (pose === 'chin') {
    leftSleeve();
    b.poly([[cx + 7, top], [cx + 10, top + 8], [cx + 4, top + 4], [cx + 3, top]], base);
    b.line(cx + 7, top, cx + 10, top + 8, sh);
    b.rect(cx + 2, top - 3, 3, 3, C.SKIN); // hand at chin
  } else if (pose === 'reject') {
    // hu tablet raised horizontally as objection (封驳)
    b.poly([[cx - 8, top], [cx - 13, top - 3], [cx - 12, top + 2], [cx - 7, top + 8]], base);
    b.poly([[cx + 8, top], [cx + 13, top - 3], [cx + 12, top + 2], [cx + 7, top + 8]], base);
    b.rect(cx - 14, top - 6, 3, 3, C.SKIN);
    b.rect(cx + 12, top - 6, 3, 3, C.SKIN);
    b.rect(cx - 12, top - 7 + (o.alt ? 1 : 0), 25, 3, C.PAPER);
    b.hline(cx - 12, cx + 12, top - 5 + (o.alt ? 1 : 0), C.STONE_L);
  } else {
    // relaxed: sleeves hang at sides
    b.poly([[cx - 8, top], [cx - 12, top + 15], [cx - 7, top + 17]], base);
    b.poly([[cx + 8, top], [cx + 12, top + 15], [cx + 7, top + 17]], sh);
    b.rect(cx - 11, top + 16, 3, 2, C.SKIN);
    b.rect(cx + 9, top + 16, 3, 2, C.SKIN);
  }
  if (spec.hold === 'halberd') {
    b.vline(cx + 13, top - 24, top + 22, C.WOOD);
    b.vline(cx + 14, top - 24, top + 22, C.BROWN);
    b.poly([[cx + 13, top - 30], [cx + 16, top - 24], [cx + 13, top - 22]], C.STONE_L);
    b.rect(cx + 15, top - 22, 3, 2, C.STONE);
    b.rect(cx + 12, top - 21, 4, 2, C.RED);
    b.rect(cx + 12, top + 2, 3, 3, C.SKIN);
  }
}

// ───────────────────────── poses ─────────────────────────
function standing(spec, o) {
  const b = new Bitmap(FW, FH);
  const cx = 16 + (o.dx ?? 0);
  const bob = o.bob ?? 0;
  const headTop = 5 + bob;
  const bodyTop = 18 + bob;
  const bottom = 44;
  feet(b, cx, 45, o.dir, o.step ?? 0);
  if (o.dir === 'back') {
    robeBody(b, cx, bodyTop, bottom, 'back', spec, o);
    arms(b, cx, bodyTop, 'back', spec, o);
    head(b, cx, headTop, 'back', spec, o);
  } else if (o.dir === 'side') {
    robeBody(b, cx, bodyTop, bottom, 'side', spec, o);
    head(b, cx, headTop, 'side', spec, o);
    arms(b, cx, bodyTop, 'side', spec, o);
  } else {
    robeBody(b, cx, bodyTop, bottom, 'front', spec, o);
    head(b, cx + (o.hs ?? 0), headTop, 'front', spec, o);
    arms(b, cx, bodyTop, 'front', spec, o);
  }
  b.outline(C.INK);
  return b;
}

function kneeling(spec, o) {
  const b = new Bitmap(FW, FH);
  const cx = 16;
  const [sh, base, hi] = ROBES[spec.robe];
  const bow = o.bow;
  const headTop = bow ? 25 : 15;
  // spread robe on the ground
  b.poly([[cx - 8, headTop + 12], [cx + 8, headTop + 12], [cx + 13, 46], [cx - 13, 46]], base);
  for (let y = headTop + 12; y <= 46; y++) { b.set(cx - 13 + Math.round((46 - y) * 0.3), y, hi); }
  b.hline(cx - 13, cx + 13, 46, sh);
  b.hline(cx - 12, cx + 12, 45, sh);
  if (!bow) {
    head(b, cx, headTop, 'front', spec, { ...o, blink: true });
    arms(b, cx, headTop + 13, 'front', spec, { arm: 'kneel' });
  } else {
    // bowed: sleeves forward on the floor, hat visible
    b.poly([[cx - 9, 36], [cx + 9, 36], [cx + 12, 44], [cx - 12, 44]], base);
    b.hline(cx - 12, cx + 12, 44, sh);
    b.rect(cx - 3, 42, 7, 2, C.SKIN);
    head(b, cx, headTop, 'back', spec, o);
  }
  b.outline(C.INK);
  return b;
}

function seated(spec, o) {
  const b = new Bitmap(FW, FH);
  const cx = 16;
  const [sh, base, hi] = ROBES[spec.robe];
  const headTop = 7 + (o.bob ?? 0);
  const bodyTop = 20 + (o.bob ?? 0);
  // lap: wide robe over knees
  b.poly([[cx - 8, bodyTop], [cx + 8, bodyTop], [cx + 10, 34], [cx + 12, 44], [cx - 12, 44], [cx - 10, 34]], base);
  for (let y = bodyTop; y <= 44; y++) b.set(cx - 10 - (y > 34 ? Math.round((y - 34) * 0.2) : 0), y, hi);
  b.hline(cx - 12, cx + 12, 44, sh);
  b.hline(cx - 11, cx + 11, 35, sh);
  b.vline(cx, 36, 43, sh);
  robeBody(b, cx, bodyTop, 34, 'front', spec, o);
  b.rect(cx - 7, 45, 5, 2, C.BLACK);
  b.rect(cx + 3, 45, 5, 2, C.BLACK);
  head(b, cx + (o.hs ?? 0), headTop, 'front', spec, o);
  if (o.arm === 'raise' || o.arm === 'wave' || o.arm === 'chin') arms(b, cx, bodyTop, 'front', { ...spec, hold: 'none' }, o);
  else {
    // hands resting on knees
    b.poly([[cx - 8, bodyTop], [cx - 12, bodyTop + 10], [cx - 6, bodyTop + 14]], base);
    b.poly([[cx + 8, bodyTop], [cx + 12, bodyTop + 10], [cx + 6, bodyTop + 14]], sh);
    b.rect(cx - 7, bodyTop + 13, 3, 2, C.SKIN);
    b.rect(cx + 5, bodyTop + 13, 3, 2, C.SKIN);
  }
  b.outline(C.INK);
  return b;
}

export function buildSheet(key) {
  const spec = CHARACTERS[key];
  const frames = [];
  const S = spec.seated ? seated : standing;
  const holdPose = spec.hold === 'none' || spec.hold === 'halberd' ? (spec.hold === 'halberd' ? 'relaxed' : 'relaxed') : 'hold';
  const idleArm = spec.seated ? 'rest' : holdPose;
  // idle
  frames.push(S(spec, { dir: 'front', arm: idleArm, bob: 0 }));
  frames.push(S(spec, { dir: 'front', arm: idleArm, bob: 1, blink: true }));
  // walk down / up / side
  const steps = [1, 0, -1, 0];
  for (const st of steps) frames.push(spec.seated ? seated(spec, { arm: 'rest', bob: st === 0 ? 0 : 1 }) : standing(spec, { dir: 'front', arm: idleArm, step: st, bob: st === 0 ? 1 : 0 }));
  for (const st of steps) frames.push(spec.seated ? seated(spec, { arm: 'rest' }) : standing(spec, { dir: 'back', arm: idleArm, step: st, bob: st === 0 ? 1 : 0 }));
  for (const st of steps) frames.push(spec.seated ? seated(spec, { arm: 'rest' }) : standing(spec, { dir: 'side', arm: idleArm, step: st, bob: st === 0 ? 1 : 0 }));
  // talk
  frames.push(S(spec, { dir: 'front', arm: 'raise', mouthOpen: true }));
  frames.push(S(spec, { dir: 'front', arm: spec.seated ? 'rest' : idleArm, mouthOpen: false }));
  // think
  frames.push(S(spec, { dir: 'front', arm: 'chin', lookUp: true }));
  frames.push(S(spec, { dir: 'front', arm: 'chin', lookUp: true, blink: true, bob: 1 }));
  // kneel (跪拜)
  frames.push(spec.seated ? seated(spec, { arm: 'rest' }) : kneeling(spec, { bow: false }));
  frames.push(spec.seated ? seated(spec, { arm: 'rest', bob: 1 }) : kneeling(spec, { bow: true }));
  // reject (封驳)
  frames.push(spec.seated ? seated(spec, { arm: 'wave', hs: -1, mouthOpen: true }) : standing(spec, { dir: 'front', arm: 'reject', hs: -1, mouthOpen: true }));
  frames.push(spec.seated ? seated(spec, { arm: 'wave', hs: 1, alt: true }) : standing(spec, { dir: 'front', arm: 'reject', hs: 1, alt: true }));
  const cols = 11;
  const sheet = new Bitmap(FW * cols, FH * 2);
  frames.forEach((f, i) => sheet.blit(f, (i % cols) * FW, Math.floor(i / cols) * FH));
  return { sheet, frames: frames.length };
}
