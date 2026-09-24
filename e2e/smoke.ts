// Launch the built app under Xvfb and take screenshots (Linux host — NOT a Mac).
import { _electron as electron } from 'playwright';
import electronBinary from 'electron';
import path from 'node:path';
import fs from 'node:fs';
const dataDir = fs.mkdtempSync('/tmp/edict-e2e-');
(async () => {
  const app = await electron.launch({ executablePath: process.env.EDICT_ELECTRON ?? (electronBinary as unknown as string), args: [process.env.APP_DIR ?? path.resolve('dist'), '--no-sandbox', `--edict-data-dir=${dataDir}`], env: { ...process.env, EDICT_E2E: '1' } });
  const win = await app.firstWindow();
  win.on('console', (m) => console.log('[console]', m.type(), m.text().slice(0, 300)));
  win.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await win.setViewportSize({ width: 1440, height: 900 });
  await win.waitForTimeout(2500);
  await win.screenshot({ path: '/tmp/claude-0/shots/smoke-workbench.png' });
  console.log('title', await win.title());
  await app.close();
})().catch((e) => { console.error(e); process.exit(1); });
