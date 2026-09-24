// Assemble the Apple Silicon (arm64) Edict.app from the official Electron darwin-arm64 build,
// ad-hoc sign it, and produce a zip + DMG. Works on macOS or Linux.
//
// Env:
//   ELECTRON_DARWIN_ZIP  path to electron-v44.4.5-darwin-arm64.zip (verified against SHASUMS256)
//   RCODESIGN            path to rcodesign (Linux) — on macOS `codesign` is used instead
//   DMG_TOOL             path to libdmg-hfsplus `dmg` (Linux only)
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const ver = pkg.version;
const ELECTRON_VERSION = pkg.devDependencies.electron;
const zip = process.env.ELECTRON_DARWIN_ZIP ?? path.join(root, 'deps', `electron-v${ELECTRON_VERSION}-darwin-arm64.zip`);
const EXPECTED_SHA = 'a212eee63ba2f45fd83bd28f77a3e3313a336ad17a4c25adf617942eef5e0e2c'; // electron v44.4.5 darwin-arm64 (SHASUMS256.txt)
const release = path.join(root, 'release');
const stage = path.join(release, 'stage');
const app = path.join(stage, 'Edict.app');
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', ...opts });

// 0. verify the electron archive
if (!fs.existsSync(zip)) throw new Error(`Electron archive not found: ${zip}\nDownload electron-v${ELECTRON_VERSION}-darwin-arm64.zip from https://github.com/electron/electron/releases into ./deps/ or set ELECTRON_DARWIN_ZIP.`);
const sha = crypto.createHash('sha256').update(fs.readFileSync(zip)).digest('hex');
if (sha !== EXPECTED_SHA) throw new Error(`Electron zip checksum mismatch: ${sha}`);
console.log('[package] electron zip sha256 OK');

// 1. production build
sh('node', [path.join(root, 'scripts/build.mjs'), '--prod']);

// 2. unpack electron (preserving framework symlinks)
fs.rmSync(release, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });
sh('unzip', ['-q', zip, '-d', stage]);
fs.renameSync(path.join(stage, 'Electron.app'), app);
const res = path.join(app, 'Contents/Resources');
fs.rmSync(path.join(res, 'default_app.asar'), { force: true });
fs.cpSync(path.join(root, 'dist'), path.join(res, 'app'), { recursive: true });
for (const f of fs.readdirSync(path.join(res, 'app'))) if (f.endsWith('.map')) fs.rmSync(path.join(res, 'app', f));
fs.copyFileSync(path.join(root, 'assets/icon/edict.icns'), path.join(res, 'edict.icns'));
fs.rmSync(path.join(res, 'electron.icns'), { force: true });
// licences
fs.mkdirSync(path.join(res, 'licenses'), { recursive: true });
for (const [src, dst] of [['LICENSE', 'Edict-LICENSE.txt'], ['THIRD_PARTY_NOTICES.md', 'THIRD_PARTY_NOTICES.md']]) if (fs.existsSync(path.join(root, src))) fs.copyFileSync(path.join(root, src), path.join(res, 'licenses', dst));

// 3. rename main executable + Info.plist (helpers keep their Electron names — Electron looks them up by ELECTRON_PRODUCT_NAME first)
fs.renameSync(path.join(app, 'Contents/MacOS/Electron'), path.join(app, 'Contents/MacOS/Edict'));
const plistPy = `
import plistlib, sys
p = sys.argv[1]
d = plistlib.load(open(p, 'rb'))
d.update({
  'CFBundleExecutable': 'Edict', 'CFBundleName': 'Edict', 'CFBundleDisplayName': 'Edict',
  'CFBundleIdentifier': 'app.edict.mac', 'CFBundleShortVersionString': '${ver}', 'CFBundleVersion': '${ver}',
  'CFBundleIconFile': 'edict.icns', 'LSApplicationCategoryType': 'public.app-category.developer-tools',
  'NSHumanReadableCopyright': 'Edict for Mac — MIT License. Not affiliated with Microsoft or Apple.',
  'LSArchitecturePriority': ['arm64'], 'NSRequiresAquaSystemAppearance': False,
})
d.pop('ElectronAsarIntegrity', None)
plistlib.dump(d, open(p, 'wb'))
`;
sh('python3', ['-c', plistPy, path.join(app, 'Contents/Info.plist')]);
// Electron's helper bundles omit CFBundleExecutable; declare it so signing tools treat them as proper nested bundles
const helperPy = `
import plistlib, sys, os
for app in sys.argv[1:]:
    p = os.path.join(app, 'Contents/Info.plist')
    d = plistlib.load(open(p, 'rb'))
    d.setdefault('CFBundleExecutable', os.path.basename(app)[:-4])
    plistlib.dump(d, open(p, 'wb'))
`;
const fw = path.join(app, 'Contents/Frameworks');
sh('python3', ['-c', helperPy, ...fs.readdirSync(fw).filter((f) => f.endsWith('.app')).map((f) => path.join(fw, f))]);

// 4. ad-hoc code signature (required for arm64 binaries to launch)
if (process.platform === 'darwin') {
  sh('codesign', ['--force', '--deep', '--sign', '-', app]);
} else {
  const rc = process.env.RCODESIGN ?? 'rcodesign';
  sh(rc, ['sign', app]);
  // `rcodesign verify` does not handle ad-hoc (CMS-less) signatures; inspect instead
  const bins = [
    'Contents/MacOS/Edict',
    'Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework',
    'Contents/Frameworks/Electron Helper.app/Contents/MacOS/Electron Helper',
    'Contents/Frameworks/Electron Helper (GPU).app/Contents/MacOS/Electron Helper (GPU)',
    'Contents/Frameworks/Electron Helper (Renderer).app/Contents/MacOS/Electron Helper (Renderer)',
    'Contents/Frameworks/Electron Helper (Plugin).app/Contents/MacOS/Electron Helper (Plugin)',
  ];
  for (const b of bins) {
    const info = execFileSync(rc, ['print-signature-info', path.join(app, b)], { encoding: 'utf8' });
    if (!/ADHOC/.test(info)) throw new Error(`not signed: ${b}`);
  }
  console.log('[package] ad-hoc signatures present on main, framework and helpers');
}

// 5. DMG staging extras
fs.symlinkSync('/Applications', path.join(stage, 'Applications'));
fs.copyFileSync(path.join(root, 'docs/INSTALL_MAC.md'), path.join(stage, '首次打开必读 README.md'));

// 6. zip (symlinks preserved) + dmg
const zipOut = path.join(release, `Edict-${ver}-arm64-mac.zip`);
sh('zip', ['-q', '-r', '-y', zipOut, 'Edict.app'], { cwd: stage });
const dmgOut = path.join(release, `Edict-${ver}-arm64.dmg`);
if (process.platform === 'darwin') {
  sh('hdiutil', ['create', '-volname', 'Edict', '-srcfolder', stage, '-ov', '-format', 'UDZO', dmgOut]);
} else {
  const iso = path.join(release, 'edict.iso');
  sh('python3', [path.join(root, 'scripts/make-iso.py'), stage, iso, 'Edict']);
  sh(process.env.DMG_TOOL ?? 'dmg', [iso, dmgOut]);
  fs.rmSync(iso);
}
for (const f of [zipOut, dmgOut]) {
  const h = crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
  fs.writeFileSync(`${f}.sha256`, `${h}  ${path.basename(f)}\n`);
  console.log('[package]', path.basename(f), (fs.statSync(f).size / 1e6).toFixed(1), 'MB', h);
}
