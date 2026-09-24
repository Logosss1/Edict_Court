import { _electron as electron } from '/home/claude/.npm-global/lib/node_modules/playwright/index.mjs';
import fs from 'node:fs';
const dataDir = fs.mkdtempSync('/tmp/edict-e2e-');
(async () => {
  const app = await electron.launch({ executablePath: '/home/claude/electron-linux/electron', args: [process.env.APP_DIR ?? '/home/claude/edict-mac/dist', '--no-sandbox', `--edict-data-dir=${dataDir}`], env: { ...process.env, EDICT_E2E: '1' } });
  const win = await app.firstWindow();
  win.on('console', (m) => { if (m.type() !== 'log' || /court|error/i.test(m.text())) console.log('[console]', m.type(), m.text().slice(0, 300)); });
  win.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await win.setViewportSize({ width: 1440, height: 900 });
  await win.waitForTimeout(1500);
  await win.click('[data-testid=to-court]');
  await win.waitForTimeout(3500);
  await win.screenshot({ path: '/tmp/claude-0/shots/court-taihe.png' });
  for (const [i, n] of [[2, 'junjichu'], [3, 'liubu'], [4, 'chengtian']] as const) {
    await win.click(`.court-hud .px-btn:nth-child(${i})`);
    await win.waitForTimeout(1200);
    await win.screenshot({ path: `/tmp/claude-0/shots/court-${n}.png` });
  }
  await app.close();
})().catch((e) => { console.error(e); process.exit(1); });
