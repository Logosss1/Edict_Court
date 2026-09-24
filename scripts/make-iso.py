#!/usr/bin/env python3
"""Build an ISO9660 + Rock Ridge image from a staging folder (symlinks & exec bits preserved).

Used on non-macOS build hosts: the ISO is then converted to a compressed UDIF .dmg with the
`dmg` tool from libdmg-hfsplus (the same approach Bitcoin Core uses for its macOS releases).
On a Mac, prefer `hdiutil create -srcfolder` (see scripts/make-dmg.sh).
"""
import os, sys, stat

sys.path.insert(0, os.environ.get('PYCDLIB_PATH', '/home/claude/deps/pycdlib'))
import pycdlib  # noqa: E402

src, out, label = sys.argv[1], sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else 'Edict'
iso = pycdlib.PyCdlib()
iso.new(interchange_level=3, vol_ident=label[:32].upper().replace(' ', '_'), rock_ridge='1.09', sys_ident='MACOS')

counter = [0]
def iso_name(is_dir):
    counter[0] += 1
    return f'D{counter[0]:06d}' if is_dir else f'F{counter[0]:06d}.;1'

handles = []
def walk(local, isodir):
    for name in sorted(os.listdir(local)):
        p = os.path.join(local, name)
        st = os.lstat(p)
        if stat.S_ISLNK(st.st_mode):
            iso.add_symlink(symlink_path=f'{isodir}/{iso_name(False)}'.replace('//', '/'), rr_symlink_name=name, rr_path=os.readlink(p))
        elif stat.S_ISDIR(st.st_mode):
            ip = f'{isodir}/{iso_name(True)}'.replace('//', '/')
            iso.add_directory(ip, rr_name=name, file_mode=0o040755)
            walk(p, ip)
        else:
            mode = 0o100755 if st.st_mode & 0o111 else 0o100644
            fp = open(p, 'rb')
            handles.append(fp)
            iso.add_fp(fp, st.st_size, f'{isodir}/{iso_name(False)}'.replace('//', '/'), rr_name=name, file_mode=mode)

walk(src, '')
iso.write(out)
iso.close()
for h in handles:
    h.close()
print('iso written', out)
