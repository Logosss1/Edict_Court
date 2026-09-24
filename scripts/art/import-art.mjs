#!/usr/bin/env node
// Stage-2 art import: take a cleaned-up image (AI generated → Aseprite/LibreSprite), align it to
// the pixel grid, quantise it to the Tang32 palette and replace the placeholder asset in place.
//
//   node scripts/art/import-art.mjs <kind> <key> <file.png> [--downscale N] [--dry-run]
//     kind: char | scene | prop | tileset
//     key : e.g. zhongshu | taihe | zhezi_doing
//
// Spec lock (rejected otherwise): char sheet = 352×96 (11×2 frames of 32×48), scene = 640×360,
// tileset = multiples of 16, ≤ 32 colours after quantisation, no semi-transparent pixels.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { PALETTE, Bitmap } from '../pixel/raster.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const [kind, key, file, ...rest] = process.argv.slice(2);
if (!kind || !key || !file) {
  console.log('usage: import-art.mjs <char|scene|prop|tileset> <key> <file.png> [--downscale N] [--dry-run]');
  process.exit(1);
}
const down = Number(rest[rest.indexOf('--downscale') + 1]) || 1;
const dry = rest.includes('--dry-run');
const outOverride = rest.includes('--out') ? rest[rest.indexOf('--out') + 1] : null;

// ── minimal PNG decoder (8-bit RGB/RGBA/grey/grey+alpha/indexed, non-interlaced) ──
function decodePNG(buf) {
  let p = 8;
  let w = 0, h = 0, depth = 0, ctype = 0, interlace = 0;
  let plte = null, trns = null;
  const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('ascii', p + 4, p + 8);
    const d = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); depth = d[8]; ctype = d[9]; interlace = d[12]; }
    else if (type === 'PLTE') plte = d;
    else if (type === 'tRNS') trns = d;
    else if (type === 'IDAT') idat.push(d);
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  if (depth !== 8 || interlace) throw new Error(`unsupported PNG (bit depth ${depth}, interlace ${interlace}); export 8-bit non-interlaced`);
  const ch = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ctype];
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * ch;
  const out = Buffer.alloc(w * h * 4);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? line[x - ch] : 0, b = prev[x], c = x >= ch ? prev[x - ch] : 0;
      if (f === 1) line[x] = (line[x] + a) & 255;
      else if (f === 2) line[x] = (line[x] + b) & 255;
      else if (f === 3) line[x] = (line[x] + ((a + b) >> 1)) & 255;
      else if (f === 4) { const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c); line[x] = (line[x] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255; }
    }
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      if (ctype === 6) line.copy(out, o, x * 4, x * 4 + 4);
      else if (ctype === 2) { out[o] = line[x * 3]; out[o + 1] = line[x * 3 + 1]; out[o + 2] = line[x * 3 + 2]; out[o + 3] = 255; }
      else if (ctype === 0) { out[o] = out[o + 1] = out[o + 2] = line[x]; out[o + 3] = 255; }
      else if (ctype === 4) { out[o] = out[o + 1] = out[o + 2] = line[x * 2]; out[o + 3] = line[x * 2 + 1]; }
      else { const i = line[x]; out[o] = plte[i * 3]; out[o + 1] = plte[i * 3 + 1]; out[o + 2] = plte[i * 3 + 2]; out[o + 3] = trns && i < trns.length ? trns[i] : 255; }
    }
    prev = line;
  }
  return { w, h, rgba: out };
}

const pal = PALETTE.map((hx) => (hx ? [parseInt(hx.slice(1, 3), 16), parseInt(hx.slice(3, 5), 16), parseInt(hx.slice(5, 7), 16)] : null));
function nearest(r, g, b) {
  let best = 1, bd = Infinity;
  for (let i = 1; i < pal.length; i++) {
    const [pr, pg, pb] = pal[i];
    // perceptual-ish weighting
    const d = 2 * (r - pr) ** 2 + 4 * (g - pg) ** 2 + 3 * (b - pb) ** 2;
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}

const img = decodePNG(fs.readFileSync(file));
const W = Math.floor(img.w / down), H = Math.floor(img.h / down);
const bmp = new Bitmap(W, H);
let semi = 0;
for (let y = 0; y < H; y++)
  for (let x = 0; x < W; x++) {
    // grid alignment: majority colour of each down×down block
    const votes = new Map();
    for (let j = 0; j < down; j++)
      for (let i = 0; i < down; i++) {
        const o = ((y * down + j) * img.w + (x * down + i)) * 4;
        const a = img.rgba[o + 3];
        if (a > 0 && a < 255) semi++;
        const idx = a < 128 ? 0 : nearest(img.rgba[o], img.rgba[o + 1], img.rgba[o + 2]);
        votes.set(idx, (votes.get(idx) ?? 0) + 1);
      }
    bmp.set(x, y, [...votes.entries()].sort((a, b) => b[1] - a[1])[0][0]);
  }
const spec = { char: [352, 96], scene: [640, 360] }[kind];
if (spec && (W !== spec[0] || H !== spec[1])) throw new Error(`${kind} must be ${spec[0]}×${spec[1]} after downscale (got ${W}×${H})`);
if ((kind === 'tileset') && (W % 16 || H % 16)) throw new Error('tileset must be a multiple of 16×16');
const used = new Set(bmp.px);
used.delete(0);
console.log(`[art] ${file} → ${W}×${H}, ${used.size} Tang32 colours, ${semi} semi-transparent px snapped`);
if (used.size > 32) throw new Error('more than 32 colours');
const dest = { char: `assets/pixel/chars/${key}.png`, scene: `assets/pixel/scenes/${key}.png`, prop: `assets/pixel/props/${key}.png`, tileset: 'assets/pixel/tileset.png' }[kind];
if (!dest) throw new Error(`unknown kind ${kind}`);
const abs = path.join(root, dest);
if (dry) {
  console.log('[art] dry run — would write', dest);
  process.exit(0);
}
if (outOverride) {
  fs.writeFileSync(outOverride, bmp.toPNG());
  console.log('[art] wrote', outOverride);
  process.exit(0);
}
const backup = path.join(root, 'assets/pixel/_placeholder', dest.replace('assets/pixel/', ''));
if (fs.existsSync(abs) && !fs.existsSync(backup)) {
  fs.mkdirSync(path.dirname(backup), { recursive: true });
  fs.copyFileSync(abs, backup);
}
fs.writeFileSync(abs, bmp.toPNG());
const manifest = path.join(root, 'assets/pixel/formal-art.json');
const m = fs.existsSync(manifest) ? JSON.parse(fs.readFileSync(manifest, 'utf8')) : {};
m[dest] = { source: path.basename(file), importedAt: new Date().toISOString(), colours: used.size, downscale: down };
fs.writeFileSync(manifest, JSON.stringify(m, null, 1));
console.log('[art] replaced', dest, '(placeholder backed up)');
