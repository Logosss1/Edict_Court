// Indexed-colour raster + PNG encoder (no dependencies). Palette index 0 = transparent.
import zlib from 'node:zlib';

// Tang32 master palette — every scene & sprite draws ONLY from these colours (≤32 incl. transparency).
export const PALETTE = [
  null,       // 0 transparent
  '#1a1220',  // 1 ink (outline)
  '#3b2622',  // 2 dark brown
  '#6a3f2c',  // 3 brown
  '#9a6440',  // 4 wood
  '#6e1a1c',  // 5 red dark
  '#b3322a',  // 6 vermilion 朱红
  '#e0604a',  // 7 red light
  '#8a5a1c',  // 8 gold dark
  '#d0982e',  // 9 gold
  '#f2d27a',  // 10 gold light
  '#f4e6c4',  // 11 paper / cream
  '#c88a64',  // 12 skin shadow
  '#ecb98f',  // 13 skin
  '#f8f4ea',  // 14 white jade 汉白玉
  '#c4bdb0',  // 15 stone light
  '#8f887f',  // 16 stone
  '#5a5550',  // 17 stone dark
  '#3c2150',  // 18 purple dark
  '#6d3b8e',  // 19 purple 紫
  '#a26cc0',  // 20 purple light
  '#1c4436',  // 21 green dark
  '#3c7a52',  // 22 green 绿
  '#7cb07a',  // 23 green light
  '#3a8a94',  // 24 teal 青
  '#1e2f55',  // 25 blue dark
  '#3b5f9c',  // 26 blue
  '#a02a3c',  // 27 crimson 绯
  '#2a2428',  // 28 black (hat / iron)
  '#8fb8cc',  // 29 sky
  '#d2e6e4',  // 30 sky light / cloud
  '#ffe7a3',  // 31 lantern glow
];
export const C = {
  T: 0, INK: 1, DBROWN: 2, BROWN: 3, WOOD: 4, RED_D: 5, RED: 6, RED_L: 7, GOLD_D: 8, GOLD: 9, GOLD_L: 10, PAPER: 11, SKIN_S: 12, SKIN: 13,
  JADE: 14, STONE_L: 15, STONE: 16, STONE_D: 17, PUR_D: 18, PUR: 19, PUR_L: 20, GRN_D: 21, GRN: 22, GRN_L: 23, TEAL: 24, BLU_D: 25, BLU: 26,
  CRIMSON: 27, BLACK: 28, SKY: 29, SKY_L: 30, GLOW: 31,
};

const rgb = PALETTE.map((h) => (h ? [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)] : [0, 0, 0]));

export class Bitmap {
  constructor(w, h) {
    this.w = w;
    this.h = h;
    this.px = new Uint8Array(w * h);
  }
  set(x, y, c) {
    x = Math.round(x);
    y = Math.round(y);
    if (x < 0 || y < 0 || x >= this.w || y >= this.h || c === undefined || c === null) return;
    this.px[y * this.w + x] = c;
  }
  get(x, y) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return 0;
    return this.px[y * this.w + x];
  }
  rect(x, y, w, h, c) {
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) this.set(x + i, y + j, c);
  }
  hline(x0, x1, y, c) {
    for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) this.set(x, y, c);
  }
  vline(x, y0, y1, c) {
    for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) this.set(x, y, c);
  }
  line(x0, y0, x1, y1, c) {
    const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    for (;;) {
      this.set(x0, y0, c);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x0 += sx; }
      if (e2 <= dx) { err += dx; y0 += sy; }
    }
  }
  ellipse(cx, cy, rx, ry, c) {
    for (let y = -ry; y <= ry; y++) for (let x = -rx; x <= rx; x++) if ((x * x) / (rx * rx + 0.3) + (y * y) / (ry * ry + 0.3) <= 1) this.set(cx + x, cy + y, c);
  }
  /** filled polygon (scanline, even-odd) */
  poly(pts, c) {
    const ys = pts.map((p) => p[1]);
    for (let y = Math.floor(Math.min(...ys)); y <= Math.ceil(Math.max(...ys)); y++) {
      const xs = [];
      for (let i = 0; i < pts.length; i++) {
        const [x1, y1] = pts[i];
        const [x2, y2] = pts[(i + 1) % pts.length];
        if ((y1 <= y && y2 > y) || (y2 <= y && y1 > y)) xs.push(x1 + ((y - y1) / (y2 - y1)) * (x2 - x1));
      }
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) for (let x = Math.round(xs[k]); x <= Math.round(xs[k + 1]); x++) this.set(x, y, c);
    }
  }
  /** replace colour a with b inside the rect */
  recolor(map) {
    for (let i = 0; i < this.px.length; i++) if (map[this.px[i]] !== undefined) this.px[i] = map[this.px[i]];
  }
  blit(src, dx, dy, { flipX = false, transparent = true } = {}) {
    for (let y = 0; y < src.h; y++)
      for (let x = 0; x < src.w; x++) {
        const c = src.px[y * src.w + (flipX ? src.w - 1 - x : x)];
        if (c || !transparent) this.set(dx + x, dy + y, c);
      }
  }
  /** uniform outline rule: every transparent pixel 4-adjacent to the silhouette becomes `c` */
  outline(c = C.INK) {
    const add = [];
    for (let y = 0; y < this.h; y++)
      for (let x = 0; x < this.w; x++) {
        if (this.get(x, y)) continue;
        if (this.get(x - 1, y) || this.get(x + 1, y) || this.get(x, y - 1) || this.get(x, y + 1)) add.push([x, y]);
      }
    for (const [x, y] of add) this.set(x, y, c);
  }
  /** dither fill: checkerboard of a/b */
  dither(x, y, w, h, a, b) {
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) this.set(x + i, y + j, (i + j) % 2 ? a : b);
  }
  clone() {
    const b = new Bitmap(this.w, this.h);
    b.px.set(this.px);
    return b;
  }
  colorsUsed() {
    return new Set(this.px);
  }
  toPNG() {
    const raw = Buffer.alloc((this.w * 4 + 1) * this.h);
    for (let y = 0; y < this.h; y++) {
      raw[y * (this.w * 4 + 1)] = 0;
      for (let x = 0; x < this.w; x++) {
        const c = this.px[y * this.w + x];
        const o = y * (this.w * 4 + 1) + 1 + x * 4;
        const [r, g, b] = rgb[c];
        raw[o] = r;
        raw[o + 1] = g;
        raw[o + 2] = b;
        raw[o + 3] = c ? 255 : 0;
      }
    }
    return encodePNG(this.w, this.h, raw);
  }
}

const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encodePNG(w, h, raw) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

// deterministic PRNG for textures
export function rng(seed = 1) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
