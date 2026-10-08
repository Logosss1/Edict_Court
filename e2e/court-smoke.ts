import { _electron as electron } from 'playwright';
import electronBinary from 'electron';
import path from 'node:path';
import fs from 'node:fs';
const dataDir = fs.mkdtempSync('/tmp/edict-e2e-');
const SHOTS = process.env.SHOTS ?? '/tmp/claude-0/shots';
fs.mkdirSync(SHOTS, { recursive: true });
const fail = (m: string) => { throw new Error(m); };
(async () => {
  const app = await electron.launch({ executablePath: process.env.EDICT_ELECTRON ?? (electronBinary as unknown as string), args: [process.env.APP_DIR ?? path.resolve('dist'), '--no-sandbox', `--edict-data-dir=${dataDir}`], env: { ...process.env, EDICT_E2E: '1' } });
  const win = await app.firstWindow();
  const errors: string[] = [];
  win.on('console', (m) => { if (m.type() === 'error' || /court/i.test(m.text())) console.log('[console]', m.type(), m.text().slice(0, 300)); });
  win.on('pageerror', (e) => { errors.push(e.message); console.log('[pageerror]', e.message); });
  await win.setViewportSize({ width: 1440, height: 900 });
  await win.waitForTimeout(1500);
  await win.click('[data-testid=to-court]');
  await win.waitForTimeout(3500);
  const hour = Number(process.env.COURT_HOUR ?? 11);
  await win.evaluate((h) => (window as any).__court.setHour(h), hour);
  await win.waitForTimeout(300);
  await win.screenshot({ path: `${SHOTS}/court-taihe.png` });
  for (const [label, n] of [['太和殿广场', 'guangchang'], ['军机处值房', 'junjichu'], ['六部值房', 'liubu'], ['承天门', 'chengtian']] as const) {
    await win.click(`.court-hud > .px-btn:text-is("${label}")`);
    await win.waitForTimeout(1400);
    await win.evaluate((h) => (window as any).__court.setHour(h), hour);
    await win.waitForTimeout(200);
    await win.screenshot({ path: `${SHOTS}/court-${n}.png` });
  }

  // world → page coordinates
  const at = async (x: number, y: number) => {
    const box = (await win.locator('.court-canvas canvas').boundingBox()) ?? fail('no canvas');
    const z = await win.evaluate(() => (window as any).__court.zoom());
    return { x: box.x + x * z, y: box.y + y * z };
  };

  // weather + night at the gate
  await win.click('[data-testid=court-weather] button:nth-child(4)');
  await win.waitForTimeout(1500);
  await win.screenshot({ path: `${SHOTS}/court-chengtian-petals.png` });
  await win.click('[data-testid=court-weather] button:nth-child(2)');
  await win.evaluate(() => (window as any).__court.setHour(22));
  await win.waitForTimeout(1500);
  await win.screenshot({ path: `${SHOTS}/court-chengtian-night-rain.png` });
  await win.click('[data-testid=court-weather] button:nth-child(1)');

  // back to the throne hall: hover card, official menu, reward animation
  await win.click('.court-hud > .px-btn:text-is("太和殿")');
  await win.waitForTimeout(1400);
  await win.evaluate(() => (window as any).__court.setHour(11));
  const p = await at(390, 205);
  await win.mouse.move(p.x, p.y);
  await win.waitForTimeout(400);
  if (!(await win.locator('[data-testid=court-hover-card]').count())) fail('hover card did not appear over 中书省');
  await win.screenshot({ path: `${SHOTS}/court-hover.png` });
  await win.mouse.click(p.x, p.y);
  await win.waitForTimeout(300);
  if (!(await win.locator('[data-testid=court-agent-menu]').count())) fail('official menu did not open');
  await win.screenshot({ path: `${SHOTS}/court-menu.png` });
  await win.click('[data-testid=court-agent-menu] button:nth-of-type(3)'); // 赏赐
  await win.waitForTimeout(700);
  await win.screenshot({ path: `${SHOTS}/court-reward.png` });
  // 办过的旨意
  await win.mouse.click(p.x, p.y);
  await win.click('[data-testid=court-agent-menu] button:nth-of-type(2)');
  await win.waitForTimeout(200);
  if (!(await win.locator('[data-testid=court-history]').count())) fail('history did not open');
  await win.keyboard.press('Escape');
  await win.waitForTimeout(200);

  // the emperor walks: arrow keys leave the throne, clicking the floor moves him
  await win.mouse.move(5, 5);
  await win.keyboard.down('ArrowDown');
  await win.waitForTimeout(900);
  await win.keyboard.up('ArrowDown');
  const f = await at(300, 300);
  await win.mouse.click(f.x, f.y);
  await win.waitForTimeout(1600);
  await win.screenshot({ path: `${SHOTS}/court-walk.png` });
  await win.keyboard.press('Escape');
  await win.waitForTimeout(2500);

  // walking out follows the palace layout: 太和殿 → 太和殿广场 → 承天门 → 六部值房
  const sceneNow = async () => (await win.textContent('.court-hud > .px-btn.on'))?.trim();
  const walkUntil = async (key: string, to: string) => {
    await win.keyboard.down(key);
    for (let t = 0; t < 80 && (await sceneNow()) !== to; t++) await win.waitForTimeout(100);
    await win.keyboard.up(key);
    await win.waitForTimeout(900);
    const now = await sceneNow();
    if (now !== to) fail(`walking ${key} should reach ${to}, got ${now}`);
    console.log(`[court-smoke] walked ${key} → ${to}`);
  };
  await win.mouse.move(5, 5);
  await walkUntil('ArrowDown', '太和殿广场');
  await win.evaluate(() => (window as any).__court.setHour(11));
  await win.waitForTimeout(300);
  await win.screenshot({ path: `${SHOTS}/court-guangchang-walk.png` });
  await walkUntil('ArrowDown', '承天门');
  await walkUntil('ArrowRight', '六部值房');
  await walkUntil('ArrowLeft', '承天门');
  const gate = await at(320, 290);
  await win.mouse.click(gate.x, gate.y); // walk over to the gate, then in through it
  await win.waitForTimeout(4500);
  await walkUntil('ArrowUp', '太和殿广场');
  await walkUntil('ArrowUp', '太和殿');

  // clickable scene object: the memorial wall opens the kanban panel
  await win.click('.court-hud > .px-btn:text-is("军机处值房")');
  await win.waitForTimeout(1400);
  const w = await at(300, 150);
  await win.mouse.click(w.x, w.y);
  await win.waitForTimeout(600);
  const mode = await win.evaluate(() => document.querySelector('[data-testid=court]')?.closest('[hidden]') ? 'hidden' : 'shown');
  console.log('[court-smoke] after wall click, court is', mode);
  if (errors.length) fail(`page errors: ${errors.join(' | ')}`);
  console.log('[court-smoke] ok');
  await app.close();
})().catch((e) => { console.error(e); process.exit(1); });
