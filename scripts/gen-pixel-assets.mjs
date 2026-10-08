// Generate placeholder pixel art (stage 1 of the art pipeline).
// Spec lock (2× detail): scenes 1280×720 shown at half scale over the 640×360 world · characters
// 64×96 frames (shown at 32×48 world units) · Tang48 palette, ≤48 colours per scene · uniform 1px
// ink outline · light from top-left · frame layout shared with the runtime via anims.json.
// Formal art (stage 2) replaces these files 1:1 — see docs/ART_PIPELINE.md.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PALETTE } from './pixel/raster.mjs';
import { buildSheet, CHARACTERS, ANIMS, FW, FH, COLS, LAYOUT } from './pixel/characters.mjs';
import { buildScenes, buildProps, SW, SH, SCALE } from './pixel/scenes.mjs';

const MAX_COLORS = 48;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'assets/pixel');
for (const d of ['chars', 'scenes', 'props']) fs.mkdirSync(path.join(out, d), { recursive: true });
// never overwrite formal art imported through scripts/art/import-art.mjs
const formalPath = path.join(out, 'formal-art.json');
const formal = fs.existsSync(formalPath) ? JSON.parse(fs.readFileSync(formalPath, 'utf8')) : {};
const write = (p, data) => {
  const rel = path.relative(root, p).split(path.sep).join('/');
  if (formal[rel]) return console.log('[assets] keep formal art', rel);
  fs.writeFileSync(p, data);
};
// files of the old 1× pipeline that no longer exist in the 2× one
for (const stale of ['tileset.png', 'tang32.gpl']) fs.rmSync(path.join(out, stale), { force: true });

const report = { spec: { character: [FW, FH], scene: [SW, SH], scale: SCALE, paletteSize: PALETTE.length - 1, maxColorsPerScene: MAX_COLORS }, scenes: {}, characters: {} };

// characters
const charColors = {};
for (const key of Object.keys(CHARACTERS)) {
  const { sheet, frames } = buildSheet(key);
  write(path.join(out, 'chars', `${key}.png`), sheet.toPNG());
  charColors[key] = sheet.colorsUsed();
  report.characters[key] = { frames, colors: charColors[key].size - (charColors[key].has(0) ? 1 : 0) };
}
fs.writeFileSync(path.join(out, 'chars', 'atlas.json'), JSON.stringify({ frameWidth: FW, frameHeight: FH, columns: COLS, displayScale: LAYOUT.displayScale, anims: ANIMS, characters: Object.keys(CHARACTERS) }, null, 1));

// scenes (background + hotspot / placement data in world units)
const scenes = buildScenes();
const sceneChars = {
  taihe: ['emperor', 'taizi', 'zhongshu', 'menxia', 'shangshu', 'hubu', 'libu', 'bingbu', 'xingbu', 'gongbu', 'libu_hr', 'guard', 'lady'],
  junjichu: ['clerk', 'shangshu', 'zaochao', 'emperor'],
  liubu: ['hubu', 'libu', 'bingbu', 'xingbu', 'gongbu', 'libu_hr', 'clerk', 'emperor'],
  chengtian: ['guard', 'zaochao', 'zhongshu', 'menxia', 'shangshu', 'taizi', 'emperor'],
  guangchang: ['guard', 'emperor'],
};
const props = buildProps();
for (const [k, b] of Object.entries(props)) write(path.join(out, 'props', `${k}.png`), b.toPNG());
fs.writeFileSync(path.join(out, 'props', 'props.json'), JSON.stringify(Object.fromEntries(Object.entries(props).map(([k, b]) => [k, [b.w, b.h]])), null, 1));
for (const [key, s] of Object.entries(scenes)) {
  write(path.join(out, 'scenes', `${key}.png`), s.bg.toPNG());
  fs.writeFileSync(path.join(out, 'scenes', `${key}.json`), JSON.stringify({ width: SW, height: SH, scale: SCALE, spots: s.spots }, null, 1));
  // palette discipline check: background + every sprite that appears in this scene
  const used = new Set(s.bg.colorsUsed());
  for (const c of sceneChars[key]) for (const x of charColors[c]) used.add(x);
  for (const p of Object.values(props)) for (const x of p.colorsUsed()) used.add(x);
  used.delete(0);
  report.scenes[key] = { colors: used.size, ok: used.size >= 16 && used.size <= MAX_COLORS };
  if (used.size > MAX_COLORS) throw new Error(`scene ${key} uses ${used.size} colours (> ${MAX_COLORS})`);
}
fs.writeFileSync(path.join(out, 'palette.json'), JSON.stringify({ name: 'Tang48', colors: PALETTE.slice(1) }, null, 1));
// GIMP palette for Aseprite / LibreSprite (Sprite → Color Mode → Indexed with this palette)
fs.writeFileSync(path.join(out, 'tang48.gpl'), ['GIMP Palette', 'Name: Tang48 (Edict)', 'Columns: 8', '#', ...PALETTE.slice(1).map((h, i) => `${parseInt(h.slice(1, 3), 16)} ${parseInt(h.slice(3, 5), 16)} ${parseInt(h.slice(5, 7), 16)}\tc${i + 1}`)].join('\n') + '\n');
fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 1));
console.log('[assets] pixel art generated:', JSON.stringify(report.scenes));
