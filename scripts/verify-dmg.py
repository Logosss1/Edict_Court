#!/usr/bin/env python3
"""Verify a UDIF .dmg produced on Linux: decode the koly/blkx tables, inflate every chunk,
then open the embedded ISO9660+RockRidge filesystem and check the app bundle (exec bits,
framework symlinks, Applications link, byte-identical binaries vs the staging folder)."""
import sys, os, struct, zlib, bz2, plistlib, hashlib, io, stat

sys.path.insert(0, os.environ.get('PYCDLIB_PATH', '/home/claude/deps/pycdlib'))
import pycdlib  # noqa: E402

dmg_path, stage = sys.argv[1], sys.argv[2]
data = open(dmg_path, 'rb').read()
koly = data[-512:]
assert koly[:4] == b'koly', 'missing koly trailer'
xml_off, xml_len = struct.unpack('>QQ', koly[0xD8:0xE8])
pl = plistlib.loads(data[xml_off:xml_off + xml_len])
blkx = pl['resource-fork']['blkx']
out = io.BytesIO()
for part in blkx:
    mish = part['Data']
    assert mish[:4] == b'mish'
    sector_number = struct.unpack('>Q', mish[8:16])[0]
    data_offset = struct.unpack('>Q', mish[24:32])[0]
    n = struct.unpack('>I', mish[200:204])[0]
    for i in range(n):
        e = mish[204 + i * 40: 244 + i * 40]
        typ, _, sec, cnt, off, ln = struct.unpack('>IIQQQQ', e)
        start = (sector_number + sec) * 512
        if typ in (0xFFFFFFFF, 0x7FFFFFFE):
            continue
        chunk = data[data_offset + off: data_offset + off + ln]
        if typ == 0x80000005:
            raw = zlib.decompress(chunk)
        elif typ == 0x80000006:
            raw = bz2.decompress(chunk)
        elif typ == 1:
            raw = chunk
        elif typ in (0, 2):
            raw = b'\0' * (cnt * 512)
        else:
            raise SystemExit(f'unsupported chunk type {typ:#x}')
        out.seek(start)
        out.write(raw)
img = out.getvalue()
print(f'UDIF ok: {len(blkx)} partitions, {len(img) / 1e6:.1f} MB raw')

iso = pycdlib.PyCdlib()
iso.open_fp(io.BytesIO(img))
checks = []

def rec(path):
    return iso.get_record(rr_path=path)

def check(name, cond):
    checks.append((name, cond))
    print(('✔' if cond else '✖'), name)

r = rec('/Edict.app/Contents/MacOS/Edict')
check('main executable present', r is not None)
check('main executable has exec bit', bool(r.rock_ridge.get_file_mode() & 0o111))
h = hashlib.sha256()
iso.get_file_from_iso_fp(buf := io.BytesIO(), rr_path='/Edict.app/Contents/MacOS/Edict')
check('main executable byte-identical to signed staging copy', hashlib.sha256(buf.getvalue()).hexdigest() == hashlib.sha256(open(os.path.join(stage, 'Edict.app/Contents/MacOS/Edict'), 'rb').read()).hexdigest())
apps = rec('/Applications')
check('Applications symlink', apps.rock_ridge.is_symlink() and apps.rock_ridge.symlink_path() == b'/Applications')
cur = rec('/Edict.app/Contents/Frameworks/Electron Framework.framework/Versions/Current')
check('framework Versions/Current symlink preserved', cur.rock_ridge.is_symlink() and cur.rock_ridge.symlink_path() == b'A')
helper = rec('/Edict.app/Contents/Frameworks/Electron Helper (Renderer).app/Contents/MacOS/Electron Helper (Renderer)')
check('renderer helper executable with exec bit', bool(helper.rock_ridge.get_file_mode() & 0o111))
cs = rec('/Edict.app/Contents/_CodeSignature/CodeResources')
check('bundle code seal (CodeResources) present', cs is not None)
check('app resources present', rec('/Edict.app/Contents/Resources/app/renderer/index.html') is not None)
iso.close()
sys.exit(0 if all(c for _, c in checks) else 1)
