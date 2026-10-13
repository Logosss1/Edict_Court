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
  const setHour = (h: number) => win.evaluate((x) => (window as any).__court.setHour(x), h);
  const officials = (): Promise<any[]> => win.evaluate(() => (window as any).__court.officials());
  const settle = async (ms = 15000) => {
    for (let t = 0; t < ms / 250; t++) {
      if (!(await officials()).some((o) => o.moving)) return;
      await win.waitForTimeout(250);
    }
  };
  await setHour(hour);
  await win.waitForTimeout(400);

  // office hours, no court: the hall is empty, the officials are at their desks
  // (a morning court opened by the real clock closes at the next session tick once the hour is pinned)
  for (let t = 0; t < 80 && (await officials()).length; t++) await win.waitForTimeout(250);
  const empty = await officials();
  if (empty.length) fail(`太和殿 should be empty at ${hour}:00 without court, found ${empty.map((o) => o.label).join(',')}`);
  await win.screenshot({ path: `${SHOTS}/court-taihe-empty.png` });
  const scenes = ['yutu', 'guangchang', 'junjichu', 'liubu', 'donggong', 'chengtian'];
  const expect: Record<string, string[]> = { junjichu: ['zhongshu', 'menxia', 'shangshu'], liubu: ['hubu', 'libu', 'bingbu', 'xingbu', 'gongbu', 'libu_hr'], donggong: ['taizi'], chengtian: ['zaochao'] };
  for (const n of scenes) {
    await win.click(`[data-testid=court-scene-${n}]`);
    await win.waitForTimeout(1400);
    await setHour(hour);
    await win.waitForTimeout(300);
    const here = (await officials()).map((o) => o.key);
    for (const id of expect[n] ?? []) if (!here.includes(id)) fail(`${id} should be in ${n} at ${hour}:00, found ${here.join(',')}`);
    await win.screenshot({ path: `${SHOTS}/court-${n}.png` });
  }
  for (const n of ['yuhuayuan', 'gongdao', 'jiaolou']) {
    await win.selectOption('[data-testid=court-sights]', n);
    await win.waitForTimeout(1400);
    await setHour(hour);
    await win.waitForTimeout(300);
    await win.screenshot({ path: `${SHOTS}/court-${n}.png` });
  }

  // world → page coordinates
  const at = async (x: number, y: number) => {
    const box = (await win.locator('.court-canvas canvas').boundingBox()) ?? fail('no canvas');
    const z = await win.evaluate(() => (window as any).__court.zoom());
    return { x: box.x + x * z, y: box.y + y * z };
  };

  // weather + night at the gate and on the moat
  await win.click('[data-testid=court-scene-chengtian]');
  await win.waitForTimeout(1400);
  await win.click('[data-testid=court-weather] button:nth-child(4)');
  await win.waitForTimeout(1500);
  await win.screenshot({ path: `${SHOTS}/court-chengtian-petals.png` });
  await win.click('[data-testid=court-weather] button:nth-child(2)');
  await setHour(22);
  await win.waitForTimeout(1500);
  await win.screenshot({ path: `${SHOTS}/court-chengtian-night-rain.png` });
  await win.click('[data-testid=court-weather] button:nth-child(1)');
  await win.selectOption('[data-testid=court-sights]', 'jiaolou');
  await win.waitForTimeout(1400);
  await setHour(22);
  await win.waitForTimeout(600);
  await win.screenshot({ path: `${SHOTS}/court-jiaolou-night.png` });
  // at night the ministries have gone home
  await win.click('[data-testid=court-scene-liubu]');
  await win.waitForTimeout(1400);
  await setHour(22);
  await settle();
  if ((await officials()).length) fail('六部院 should be empty at 22:00 with nothing to do');
  await win.screenshot({ path: `${SHOTS}/court-liubu-night.png` });

  // 上朝: the drum at the gate, then the officials file into the hall
  await win.click('[data-testid=court-scene-taihe]');
  await win.waitForTimeout(1400);
  await setHour(hour);
  await win.click('[data-testid=court-session]');
  await win.waitForTimeout(5200);
  if ((await win.textContent('[data-testid=court-session]'))?.trim() !== '退朝') fail('court session did not open after 上朝');
  await win.waitForTimeout(1500);
  await win.screenshot({ path: `${SHOTS}/court-taihe-procession.png` });
  await settle();
  const ranks = await officials();
  if (ranks.length < 12) fail(`all officials should stand in court, found ${ranks.length}`);
  await win.screenshot({ path: `${SHOTS}/court-taihe-session.png` });
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

  // the emperor walks: arrow keys leave the throne, clicking the floor moves him, officials bow as he passes
  await win.mouse.move(5, 5);
  await win.keyboard.down('ArrowDown');
  await win.waitForTimeout(900);
  await win.keyboard.up('ArrowDown');
  const f = await at(320, 300);
  await win.mouse.click(f.x, f.y);
  await win.waitForTimeout(1600);
  await win.screenshot({ path: `${SHOTS}/court-walk.png` });
  await win.keyboard.press('Escape');
  await win.waitForTimeout(2500);

  // 退朝: they bow and file out; the hall is empty again
  await win.click('[data-testid=court-session]');
  await win.waitForTimeout(3600);
  await win.screenshot({ path: `${SHOTS}/court-taihe-tuichao.png` });
  for (let t = 0; t < 80 && (await officials()).length; t++) await win.waitForTimeout(250);
  if ((await officials()).length) fail('the officials should leave the hall after 退朝');

  // walking out follows the palace layout: 太和殿 → 广场 → 承天门 → 六部院
  const sceneNow = async () => (await win.textContent('.court-hud > .px-btn.on'))?.trim();
  const walkUntil = async (key: string, to: string) => {
    await win.keyboard.down(key);
    for (let t = 0; t < 100 && (await sceneNow()) !== to; t++) await win.waitForTimeout(100);
    await win.keyboard.up(key);
    await win.waitForTimeout(900);
    const now = await sceneNow();
    if (now !== to) fail(`walking ${key} should reach ${to}, got ${now}`);
    console.log(`[court-smoke] walked ${key} → ${to}`);
  };
  await win.mouse.move(5, 5);
  await walkUntil('ArrowDown', '广场');
  await setHour(hour);
  await win.waitForTimeout(300);
  await win.screenshot({ path: `${SHOTS}/court-guangchang-walk.png` });
  await walkUntil('ArrowDown', '承天门');
  // out of the gate passage onto the road, then east to the ministries
  await win.keyboard.down('ArrowDown');
  await win.waitForTimeout(1600);
  await win.keyboard.up('ArrowDown');
  await win.screenshot({ path: `${SHOTS}/court-chengtian-walk.png` });
  await walkUntil('ArrowRight', '六部院');
  await walkUntil('ArrowLeft', '承天门');
  // walk over to the gate passage, then in through it
  const [gx, gy, gw, gh] = await win.evaluate(() => (window as any).__court.spots().doors.guangchang);
  const gate = await at(gx + gw / 2, gy + gh + 16);
  await win.mouse.click(gate.x, gate.y);
  await win.waitForTimeout(4500);
  await walkUntil('ArrowUp', '广场');
  await walkUntil('ArrowUp', '太和殿');

  // clickable scene object: the memorial wall opens the kanban panel
  await win.click('[data-testid=court-scene-junjichu]');
  await win.waitForTimeout(1400);
  const w = await at(300, 120);
  await win.mouse.click(w.x, w.y);
  await win.waitForTimeout(600);
  const mode = await win.evaluate(() => document.querySelector('[data-testid=court]')?.closest('[hidden]') ? 'hidden' : 'shown');
  console.log('[court-smoke] after wall click, court is', mode);
  if (errors.length) fail(`page errors: ${errors.join(' | ')}`);
  console.log('[court-smoke] ok');
  await app.close();
})().catch((e) => { console.error(e); process.exit(1); });
