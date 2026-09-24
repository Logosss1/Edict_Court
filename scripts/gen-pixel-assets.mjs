// Generate placeholder pixel art (stage 1 of the art pipeline).
// Spec lock: tileset 16×16 · characters 32×48 · ≤32 colours per scene (Tang32 palette)
// · uniform 1px ink outline · light from top-left · sprite sheets with
// idle / walk / talk / think / kneel / reject frames.
// Formal art (stage 2) replaces these files 1:1 — see docs/ART_PIPELINE.md.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PALETTE } from './pixel/raster.mjs';
import { buildSheet, CHARACTERS, ANIMS, FW, FH } from './pixel/characters.mjs';
import { buildTileset, buildScenes, buildProps, TS, SW, SH } from './pixel/scenes.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'assets/pixel');
for (const d of ['chars', 'scenes', 'props']) fs.mkdirSync(path.join(out, d), { recursive: true });
// never overwrite formal art imported through scripts/art/import-art.mjs
const formalPath = path.join(out, 'formal-art.json');
const formal = fs.existsSync(formalPath) ? JSON.parse(fs.readFileSync(formalPath, 'utf8')) : {};
const origWrite = fs.writeFileSync;
const write = (p, data) => {
  const rel = path.relative(root, p).split(path.sep).join('/');
  if (formal[rel]) return console.log('[assets] keep formal art', rel);
  origWrite(p, data);
};

const report = { spec: { tile: TS, character: [FW, FH], scene: [SW, SH], paletteSize: PALETTE.length - 1 }, scenes: {}, characters: {} };

// characters
const charColors = {};
for (const key of Object.keys(CHARACTERS)) {
  const { sheet, frames } = buildSheet(key);
  write(path.join(out, 'chars', `${key}.png`), sheet.toPNG());
  charColors[key] = sheet.colorsUsed();
  report.characters[key] = { frames, colors: charColors[key].size - (charColors[key].has(0) ? 1 : 0) };
}
fs.writeFileSync(path.join(out, 'chars', 'atlas.json'), JSON.stringify({ frameWidth: FW, frameHeight: FH, columns: 11, anims: ANIMS, characters: Object.keys(CHARACTERS) }, null, 1));

// tileset + scenes (Tiled-compatible maps for later hand editing)
const { tileset, index, cols, names } = buildTileset();
write(path.join(out, 'tileset.png'), tileset.toPNG());
const scenes = buildScenes(tileset, index);
const sceneChars = {
  taihe: ['emperor', 'taizi', 'zhongshu', 'menxia', 'shangshu', 'hubu', 'libu', 'bingbu', 'xingbu', 'gongbu', 'libu_hr', 'guard', 'lady'],
  junjichu: ['clerk', 'shangshu', 'zaochao'],
  liubu: ['hubu', 'libu', 'bingbu', 'xingbu', 'gongbu', 'libu_hr', 'clerk'],
  chengtian: ['guard', 'zaochao', 'zhongshu', 'menxia', 'shangshu', 'taizi'],
};
const props = buildProps();
for (const [k, b] of Object.entries(props)) write(path.join(out, 'props', `${k}.png`), b.toPNG());
for (const [key, s] of Object.entries(scenes)) {
  write(path.join(out, 'scenes', `${key}.png`), s.bg.toPNG());
  const tiled = {
    type: 'map', version: '1.10', orientation: 'orthogonal', renderorder: 'right-down', infinite: false,
    width: 40, height: 23, tilewidth: TS, tileheight: TS,
    tilesets: [{ firstgid: 1, name: 'tang16', image: '../tileset.png', imagewidth: tileset.w, imageheight: tileset.h, tilewidth: TS, tileheight: TS, columns: cols, tilecount: names.length, tiles: names.map((n, i) => ({ id: i, type: n })) }],
    layers: [{ id: 1, name: 'base', type: 'tilelayer', width: 40, height: 23, x: 0, y: 0, opacity: 1, visible: true, data: s.map.slice(0, 40 * 23) }],
    properties: [{ name: 'spots', type: 'string', value: JSON.stringify(s.spots) }],
  };
  fs.writeFileSync(path.join(out, 'scenes', `${key}.json`), JSON.stringify(tiled));
  // palette discipline check: background + every sprite that appears in this scene
  const used = new Set(s.bg.colorsUsed());
  for (const c of sceneChars[key]) for (const x of charColors[c]) used.add(x);
  for (const p of Object.values(props)) for (const x of p.colorsUsed()) used.add(x);
  used.delete(0);
  report.scenes[key] = { colors: used.size, ok: used.size >= 16 && used.size <= 32 };
  if (used.size > 32) throw new Error(`scene ${key} uses ${used.size} colours (> 32)`);
}
fs.writeFileSync(path.join(out, 'palette.json'), JSON.stringify({ name: 'Tang32', colors: PALETTE.slice(1) }, null, 1));
// GIMP palette for Aseprite / LibreSprite (Sprite → Color Mode → Indexed with this palette)
fs.writeFileSync(path.join(out, 'tang32.gpl'), ['GIMP Palette', 'Name: Tang32 (Edict)', 'Columns: 8', '#', ...PALETTE.slice(1).map((h, i) => `${parseInt(h.slice(1, 3), 16)} ${parseInt(h.slice(3, 5), 16)} ${parseInt(h.slice(5, 7), 16)}\tc${i + 1}`)].join('\n') + '\n');
fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 1));
console.log('[assets] pixel art generated:', JSON.stringify(report.scenes));
