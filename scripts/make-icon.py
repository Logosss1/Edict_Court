#!/usr/bin/env python3
"""Generate the Edict app icon (pixel-style vermilion seal with the character 敕) and a .icns.

Output: assets/icon/edict-1024.png, assets/icon/edict.icns
The glyph is rasterised with the OFL Fusion Pixel font at its native 12px size and then
scaled with nearest-neighbour, so the icon keeps the same pixel language as the court.
"""
import struct, io, os, sys
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FONT = os.path.join(ROOT, 'vendor/fonts/fusion-pixel-12px-zh_hans.otf')
OUT = os.path.join(ROOT, 'assets/icon')
os.makedirs(OUT, exist_ok=True)

INK = (26, 18, 32, 255)
RED = (179, 50, 42, 255)
RED_D = (110, 26, 28, 255)
RED_L = (224, 96, 74, 255)
GOLD = (208, 152, 46, 255)
GOLD_L = (242, 210, 122, 255)
PAPER = (244, 230, 196, 255)

# 32×32 pixel canvas, later scaled ×32 → 1024
S = 32
im = Image.new('RGBA', (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(im)
# macOS-style rounded square silhouette built from pixels
d.rounded_rectangle([1, 1, 30, 30], radius=6, fill=RED)
d.rounded_rectangle([1, 1, 30, 30], radius=6, outline=INK)
# bevel: light top-left, dark bottom-right
for i in range(3, 28):
    im.putpixel((i, 2), RED_L)
    im.putpixel((2, i), RED_L)
    im.putpixel((i, 29), RED_D)
    im.putpixel((29, i), RED_D)
# gold seal border
d.rectangle([5, 5, 26, 26], outline=GOLD)
d.rectangle([6, 6, 25, 25], outline=GOLD_L)
# glyph 敕 at native 12px
glyph = Image.new('L', (16, 16), 0)
gd = ImageDraw.Draw(glyph)
font = ImageFont.truetype(FONT, 12)
gd.text((2, 1), '敕', font=font, fill=255)
bbox = glyph.getbbox()
g = glyph.crop(bbox)
g = g.point(lambda v: 255 if v > 96 else 0)
# scale glyph ×1 but draw it doubled for weight inside the 32 grid (2px strokes)
gw, gh = g.size
gx = (S - gw * 1) // 2
gy = (S - gh * 1) // 2
paper = Image.new('RGBA', (S, S), (0, 0, 0, 0))
for y in range(gh):
    for x in range(gw):
        if g.getpixel((x, y)):
            paper.putpixel((gx + x, gy + y), PAPER)
im.alpha_composite(paper)

big = im.resize((1024, 1024), Image.NEAREST)
# chunkier glyph: render a second pass at 2× pixel grid (16px glyph on 64 grid) for the large sizes
S2 = 64
im2 = im.resize((S2, S2), Image.NEAREST)
glyph2 = Image.new('L', (32, 32), 0)
ImageDraw.Draw(glyph2).text((4, 2), '敕', font=font, fill=255)
g2 = glyph2.crop(glyph2.getbbox()).point(lambda v: 255 if v > 96 else 0)
g2 = g2.resize((g2.size[0] * 3, g2.size[1] * 3), Image.NEAREST)
# clear inner area and draw the 3× glyph centred
inner = ImageDraw.Draw(im2)
inner.rectangle([14, 14, 49, 49], fill=RED)
w2, h2 = g2.size
ox, oy = (S2 - w2) // 2, (S2 - h2) // 2
for y in range(h2):
    for x in range(w2):
        if g2.getpixel((x, y)):
            im2.putpixel((ox + x, oy + y), PAPER)
            if 0 <= ox + x + 1 < S2 and 0 <= oy + y + 1 < S2 and not g2.getpixel((min(x + 1, w2 - 1), min(y + 1, h2 - 1))):
                im2.putpixel((ox + x + 1, oy + y + 1), RED_D)
big = im2.resize((1024, 1024), Image.NEAREST)
big.save(os.path.join(OUT, 'edict-1024.png'))

# .icns with PNG payloads
entries = [(b'ic10', 1024), (b'ic09', 512), (b'ic08', 256), (b'ic07', 128), (b'ic14', 512), (b'ic13', 256), (b'ic12', 64), (b'ic11', 32)]
chunks = b''
for code, size in entries:
    buf = io.BytesIO()
    big.resize((size, size), Image.NEAREST).save(buf, 'PNG')
    data = buf.getvalue()
    chunks += code + struct.pack('>I', len(data) + 8) + data
icns = b'icns' + struct.pack('>I', len(chunks) + 8) + chunks
with open(os.path.join(OUT, 'edict.icns'), 'wb') as f:
    f.write(icns)
print('icon written', os.path.join(OUT, 'edict.icns'), len(icns), 'bytes')
