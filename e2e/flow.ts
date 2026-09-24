// End-to-end UI flow (label: INTEGRATION / MOCK LLM, host: Linux + Xvfb — not a Mac).
// Drives the real Electron app: configure a provider through the UI, issue edicts in all three
// tiers, approve/reject gates, edit a plan (L2), interject in a debate (L2), annotate an agent,
// use editor/terminal, switch modes, and capture screenshots.
import { _electron as electron } from '/home/claude/.npm-global/lib/node_modules/playwright/index.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { startMockLlm } from '../tests/mockLlm';

const SHOTS = process.env.SHOTS ?? path.resolve('docs/screenshots');
fs.mkdirSync(SHOTS, { recursive: true });
const results: { step: string; ok: boolean; note?: string }[] = [];
const ok = (step: string, cond: boolean, note?: string) => {
  results.push({ step, ok: cond, note });
  console.log(`${cond ? '✔' : '✖'} ${step}${note ? ' — ' + note : ''}`);
};

(async () => {
  const mock = await startMockLlm({ delayMs: 12, rejectPlanTimes: 1 });
  const dataDir = fs.mkdtempSync('/tmp/edict-e2e-data-');
  const ws = fs.mkdtempSync('/tmp/edict-e2e-ws-');
  fs.writeFileSync(path.join(ws, 'README.md'), '# demo project\n');
  fs.writeFileSync(path.join(ws, 'index.ts'), 'export function add(a: number, b: number) {\n  return a + b;\n}\nconst x: number = "oops";\n');
  const app = await electron.launch({ executablePath: process.env.EDICT_ELECTRON ?? '/home/claude/electron-linux/electron', args: [path.resolve('dist'), '--no-sandbox', `--edict-data-dir=${dataDir}`], env: { ...process.env, EDICT_E2E: '1' } });
  const win = await app.firstWindow();
  const errors: string[] = [];
  win.on('pageerror', (e) => errors.push(e.message));
  win.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await win.setViewportSize({ width: 1440, height: 900 });
  await win.waitForSelector('.titlebar');
  const shot = (n: string) => win.screenshot({ path: path.join(SHOTS, `${n}.png`) });
  const inv = (m: string, ...a: unknown[]) => win.evaluate(([m, a]) => (window as any).edict.invoke(m, ...(a as unknown[])), [m, a] as const);
  const waitTask = async (pred: (t: any) => boolean, ms = 30000) => {
    const start = Date.now();
    while (Date.now() - start < ms) {
      const snap: any = await inv('snapshot');
      const t = snap.tasks.find(pred);
      if (t) return t;
      await win.waitForTimeout(250);
    }
    throw new Error('waitTask timeout');
  };

  // 1. configure provider through the UI (模型配置)
  await win.click('button[title="模型配置（⌘,）"]');
  await win.selectOption('[data-testid=add-provider]', 'custom');
  await win.fill('[data-testid=provider-baseurl]', mock.url);
  await win.fill('[data-testid=provider-key]', 'sk-e2e-SECRET-KEY-000');
  await win.click('button:has-text("添加模型")');
  await win.click('button:has-text("添加模型")');
  const ids = await win.$$('[data-testid=model-id]');
  await ids[0].fill('mock-strong');
  await ids[1].fill('mock-economy');
  await win.click('[data-testid=provider-save]');
  await win.waitForTimeout(500);
  await win.click('button:has-text("测试连接")');
  await win.waitForSelector('text=连接成功', { timeout: 10000 });
  ok('模型配置：通过 UI 添加服务并测试连接', true);
  await shot('01-models');

  // 2. workspace
  await inv('setWorkspace', ws);
  await win.waitForTimeout(600);
  ok('打开工作区', (await win.textContent('.tb-ws'))!.includes(path.basename(ws)));

  // 3. Court Lite edict through the composer (封驳 once → re-plan)
  await win.fill('#composer-input', '写一个 greet 函数并测试');
  await win.click('[data-testid=composer-send]');
  // high-risk / non-safe command approval appears (node greet.test.js) → approve in dock
  const ap = await win.waitForSelector('[data-testid=approval-approve]', { timeout: 30000 });
  await shot('02-workbench-approval');
  await ap.click();
  ok('命令执行需皇上批准（审批卡片）', true);
  const t1 = await waitTask((t) => t.gate?.kind === 'final');
  ok('Court Lite：门下封驳 1 次后重拟并准奏', t1.reviews.filter((r: any) => r.verdict === 'reject').length === 1 && t1.planHistory.length === 2);
  await win.waitForTimeout(400);
  await shot('03-workbench-final-gate');
  await win.click('[data-testid=gate-approve]');
  const done1 = await waitTask((t) => t.id === t1.id && t.state === 'Done');
  ok('御批结案 → Done，奏折归档', !!done1);
  ok('产物真实存在', fs.existsSync(path.join(ws, 'greet.js')) && fs.existsSync(path.join(ws, 'greet.test.js')));

  // 4. kanban + editor + live refresh
  await win.click('.tab:has-text("旨意看板")');
  await win.waitForTimeout(300);
  await shot('04-kanban');
  await win.click('.tree-row:has-text("greet.js")');
  await win.waitForSelector('.monaco-editor', { timeout: 15000 });
  await win.waitForTimeout(800);
  const hasCode = await win.evaluate(() => document.querySelector('.monaco-editor .view-lines')?.textContent ?? '');
  ok('Editor 打开 Agent 产出的文件', hasCode.includes('greet'));
  const v0 = await win.evaluate(() => (window as any).__edictUI.getState().ui.fsVersion);
  fs.writeFileSync(path.join(ws, 'greet.js'), "exports.greet = (n) => `Hello, ${n}!`; // edited on disk\n");
  await win.waitForTimeout(2000);
  const v1 = await win.evaluate(() => (window as any).__edictUI.getState().ui);
  console.log('fsVersion', v0, '->', v1.fsVersion, v1.changedPaths, await win.evaluate(() => (window as any).monaco.editor.getModels().map((m: any) => m.uri.path + '=' + m.getValue().slice(0, 60))));
  const refreshed = (await win.evaluate(() => document.querySelector('.monaco-editor .view-lines')?.textContent ?? '')).replace(/\u00a0/g, ' ');
  ok('磁盘改动实时刷新到 Editor', refreshed.includes('edited on disk'));
  await win.click('.tree-row:has-text("index.ts")');
  await win.waitForTimeout(2500);
  await win.click('button[title^="终端"]');
  await win.click('.bp-tab:has-text("问题")');
  await win.waitForTimeout(500);
  const probs = await win.$$eval('.problem', (els) => els.length);
  ok('问题面板显示 TS 诊断', probs > 0, `${probs} 条`);
  await shot('05-editor-problems');
  await win.click('.bp-tab:has-text("终端")');
  await win.waitForTimeout(1500);
  await win.click('.term-view');
  await win.keyboard.type('echo EDICT_TERM_OK\n');
  await win.waitForTimeout(1500);
  const termText = await win.evaluate(() => document.querySelector('.term-view .xterm-rows')?.textContent ?? '');
  ok('集成终端可交互', termText.includes('EDICT_TERM_OK'));
  await shot('06-terminal');

  // 5. global search & replace
  await win.click('.ab-item[title^="全局搜索"]');
  await win.fill('#search-input', 'greet');
  await win.press('#search-input', 'Enter');
  await win.waitForSelector('.sr-hit', { timeout: 5000 });
  ok('全局搜索', (await win.$$('.sr-hit')).length > 0);
  await shot('07-search');

  // 6. Full Court: plan gate → emperor edits the plan in the COURT review overlay (L2)
  await inv('updateSettings', { permissionMode: 'auto' });
  await win.click('.ab-item[title="资源管理器"]');
  await win.click('[title="新旨意"]').catch(() => {});
  await win.fill('#composer-input', '写一个 greet 函数并测试（完整流程）');
  await win.click('.tier-seg button:has-text("Full Court")');
  await win.check('text=直接下旨');
  await win.click('[data-testid=composer-send]');
  const t2 = await waitTask((t) => t.tier === 'full' && t.gate?.kind === 'plan', 40000);
  await win.click('[data-testid=to-court]');
  await win.waitForTimeout(2500);
  await shot('08-court-taihe-presenter');
  await win.click('[data-testid=court-gates]');
  await win.waitForSelector('[data-testid=memorial-review]');
  // strike out S2 and retitle S1
  const trash = await win.$$('[data-testid=memorial-review] .pe-sub button[title="删去此子任务"]');
  await trash[1].click();
  await win.fill('[data-testid=memorial-review] .pe-sub input.input >> nth=0', '实现 greet.js（朕亲定）');
  await win.fill('[data-testid=memorial-review] textarea[placeholder^="朱批"]', '只做实现，测试另议');
  await shot('09-court-memorial-review-edit');
  await win.click('[data-testid=memorial-review] [data-testid=gate-approve]');
  const t2b = await waitTask((t) => t.id === t2.id && (t.state === 'Doing' || t.gate?.kind === 'final'), 30000);
  ok('L2 涂改方案：按修改后的方案执行', t2b.planHistory.at(-1).author === 'emperor' && t2b.plan.subtasks.length === 1);
  await win.click('.court-hud .px-btn:has-text("六部值房")');
  await win.waitForTimeout(1500);
  await shot('10-court-liubu');
  await win.click('.court-hud .px-btn:has-text("军机处值房")');
  await win.waitForTimeout(1500);
  await shot('11-court-junjichu');
  const t2c = await waitTask((t) => t.id === t2.id && t.gate?.kind === 'final', 40000);
  ok('Full Court：尚书派发 + 门下审议成果', t2c.nodes.some((n: any) => n.kind === 'dispatch' && n.status === 'done') && t2c.nodes.some((n: any) => n.kind === 'result_review' && n.status === 'done'));
  await win.click('.court-hud .px-btn:has-text("太和殿")');
  await win.waitForTimeout(1500);
  await win.click('[data-testid=court-gates]');
  await win.waitForSelector('[data-testid=memorial-review]');
  await win.click('[data-testid=memorial-review] .px-btn:has-text("改动")');
  await win.waitForTimeout(1500);
  await shot('12-court-memorial-diff');
  await win.click('[data-testid=memorial-review] .px-btn:has-text("回奏")');
  await win.click('[data-testid=memorial-review] [data-testid=gate-approve]');
  await waitTask((t) => t.id === t2.id && t.state === 'Done');
  ok('朝堂内准奏结案，工作台同步', true);

  // 7. agent dialog + annotation from the court
  await win.evaluate(() => (window as any).__court && true);
  await inv('annotate', 'bingbu', '朱批测试：下一轮请先回应', undefined);
  const snap: any = await inv('snapshot');
  ok('朱批入库（待下一轮回应）', snap.annotations.some((a: any) => a.text.includes('朱批测试')));

  // 8. 朝堂议政 in Taihe with emperor interjection (L2)
  const d: any = await inv('debateCreate', '是否先写测试再实现？', ['zhongshu', 'menxia', 'bingbu'], 1);
  await inv('debateRun', d.id);
  await win.waitForTimeout(3000);
  await win.fill('[data-testid=emperor-input]', '朕以为必须先写测试');
  await win.press('[data-testid=emperor-input]', 'Enter');
  await win.waitForTimeout(2500);
  const snap2: any = await inv('snapshot');
  const dd = snap2.debates.find((x: any) => x.id === d.id);
  const em = dd.messages.find((m: any) => m.kind === 'emperor');
  const replies = dd.messages.filter((m: any) => m.repliesTo === em?.id);
  ok('L2 插话：官员针对皇上发言继续辩论', !!em && replies.length >= 1 && replies[0].content.includes('回禀皇上'), `${replies.length} 条回应`);
  await shot('13-court-debate');

  // 9. Solo from the court emperor box
  await win.click('.emperor-box .px-btn:has-text("Solo")').catch(() => {});
  await inv('submit', { text: '写个文件', tier: 'lite', multiAgent: false });
  await waitTask((t) => t.tier === 'solo' && t.state === 'Done');
  ok('Solo 单 Agent 直接执行', fs.existsSync(path.join(ws, 'solo.txt')));

  // 10. chengtian + ceremony
  await win.click('.court-hud .px-btn:has-text("承天门")');
  await win.waitForTimeout(1200);
  await shot('14-court-chengtian');
  await win.click('.court-hud .px-btn:has-text("上朝")');
  await win.waitForTimeout(1800);
  await shot('15-court-ceremony');
  await win.waitForTimeout(4500);

  // 11. back to workbench: panels
  await win.keyboard.press('Control+J').catch(() => {});
  await win.click('text=回工作台 ⌘J').catch(() => {});
  await win.waitForTimeout(500);
  for (const [panel, name] of [['memorials', '16-memorials'], ['monitor', '17-monitor'], ['officials', '18-officials'], ['templates', '19-templates'], ['debate', '20-debate'], ['audit', '21-audit'], ['sessions', '22-sessions'], ['skills', '23-skills'], ['news', '24-news']] as const) {
    await win.evaluate((p) => (window as any).__openPanel?.(p), panel);
    await win.waitForTimeout(500);
    if (panel === 'audit') {
      await win.click('button:has-text("校验哈希链")');
      await win.waitForTimeout(400);
      ok('审计哈希链校验通过', (await win.textContent('.panel-tools'))!.includes('完整'));
    }
    if (panel === 'news') {
      await inv('updateSettings', { newsFeeds: [{ url: mock.url.replace('/v1', '/feed.xml'), category: '科技', enabled: true }] });
      await win.click('button:has-text("采集")');
      await win.waitForTimeout(800);
    }
    await shot(name);
  }
  // dark mode (follows macOS appearance by default)
  await inv('updateSettings', { theme: 'dark' });
  await win.evaluate(() => (window as any).__openPanel('kanban'));
  await win.waitForTimeout(600);
  await shot('25-dark-kanban');
  await win.evaluate(() => (window as any).__edictUI.setUI({ mode: 'court', courtScene: 'taihe' }));
  await win.waitForTimeout(1500);
  await shot('26-dark-court');
  await win.evaluate(() => (window as any).__edictUI.setUI({ mode: 'workbench' }));
  // secrets must not leak
  const leak = [path.join(dataDir, 'EdictData/audit.jsonl'), path.join(dataDir, 'EdictData/state.json'), path.join(dataDir, 'EdictData/settings.json')].some((f) => fs.existsSync(f) && fs.readFileSync(f, 'utf8').includes('SECRET-KEY'));
  ok('API Key 未出现在审计/状态/设置文件中', !leak);
  ok('无前端运行时错误', errors.filter((e) => !/ResizeObserver|Autofocus|Electron Security|favicon/.test(e)).length === 0, errors.slice(0, 3).join(' | '));
  await app.close();
  await mock.close();
  fs.writeFileSync(path.join(SHOTS, 'e2e-results.json'), JSON.stringify({ host: 'linux-xvfb (not macOS)', llm: 'mock (scripted, real SSE wire formats)', results }, null, 2));
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error('E2E FAILED', e);
  process.exit(1);
});
