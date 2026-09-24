// Build: esbuild bundles main / preload / renderer; vendor libs and pixel assets are copied.
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const prod = process.argv.includes('--prod');

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(path.join(dist, 'renderer'), { recursive: true });

const common = { bundle: true, sourcemap: prod ? false : 'linked', minify: prod, logLevel: 'warning', legalComments: 'none' };

await build({ ...common, entryPoints: [path.join(root, 'src/main/main.ts')], outfile: path.join(dist, 'main.js'), platform: 'node', format: 'cjs', target: 'node22', external: ['electron'] });
await build({ ...common, entryPoints: [path.join(root, 'src/preload/preload.ts')], outfile: path.join(dist, 'preload.js'), platform: 'node', format: 'cjs', target: 'node22', external: ['electron'] });
await build({
  ...common,
  entryPoints: [path.join(root, 'src/renderer/main.tsx')],
  outfile: path.join(dist, 'renderer/app.js'),
  platform: 'browser',
  format: 'iife',
  target: 'chrome130',
  jsx: 'automatic',
  external: ['../vendor/*', '../assets/*'],
  define: { 'process.env.NODE_ENV': JSON.stringify(prod ? 'production' : 'development') },
});
fs.copyFileSync(path.join(root, 'src/renderer/index.html'), path.join(dist, 'renderer/index.html'));

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}
copyDir(path.join(root, 'vendor'), path.join(dist, 'vendor'));
if (fs.existsSync(path.join(root, 'assets'))) copyDir(path.join(root, 'assets'), path.join(dist, 'assets'));
// drop unused monaco locales to save space
const vsDir = path.join(dist, 'vendor/monaco/vs');
(function prune(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) prune(p);
    else if (/\.nls\.(de|es|fr|it|ja|ko|ru|zh-tw)\.js$/.test(e.name)) fs.rmSync(p);
  }
})(vsDir);
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
fs.writeFileSync(path.join(dist, 'package.json'), JSON.stringify({ name: 'edict', productName: 'Edict', version: pkg.version, main: 'main.js', license: 'MIT' }, null, 2));
console.log('[build] done →', path.relative(root, dist), prod ? '(prod)' : '(dev)');
