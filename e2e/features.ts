// E2E for v1.1 features (label: INTEGRATION / MOCK LLM, host: Linux + Xvfb — not a Mac):
// 思考程度 slider → request body, relay-503 error card → 换模型重试, protocol probe, HTML 预览 (webview,
// console capture, network block), agent preview_page with a real hidden browser + screenshot,
// 技能与 MCP 中心 (skill edit, MCP server with real stdio JSON-RPC, agent calls an MCP tool).
import { _electron as electron } from 'playwright';
import electronBinary from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { startMockLlm, defaultBrain } from '../tests/mockLlm';

const SHOTS = process.env.SHOTS ?? path.resolve('docs/screenshots');
fs.mkdirSync(SHOTS, { recursive: true });
const results: { step: string; ok: boolean; note?: string }[] = [];
const ok = (step: string, cond: boolean, note?: string) => {
  results.push({ step, ok: cond, note });
  console.log(`${cond ? '✔' : '✖'} ${step}${note ? ' — ' + note : ''}`);
};
const ONLY = (process.env.ONLY ?? '').split(',').filter(Boolean);
const want = (k: string) => !ONLY.length || ONLY.includes(k);

(async () => {
  const base = defaultBrain({});
  const mock = await startMockLlm({
    delayMs: 5,
    reject: (c) => (c.model === 'relay-bad' ? { status: 503, body: '{"error":{"message":"当前分组暂不支持您请求的模型或接入方式，请尝试其他模型","type":"new_api_error"}}' } : undefined),
    brain: (c) => {
      if (c.system.includes('独相') && c.lastUser.includes('PREVIEWTEST') && c.toolResults === 0) return { toolCalls: [{ name: 'preview_page', args: { path: 'index.html', wait_ms: 300 } }] };
      if (c.system.includes('独相') && c.lastUser.includes('MCPTEST') && c.toolResults === 0) return { toolCalls: [{ name: 'mcp__demo__echo', args: { text: '朕知道了' } }] };
      if (c.system.includes('独相') && c.lastUser.includes('PREVIEWACT') && c.toolResults === 0) return { toolCalls: [{ name: 'preview_page', args: { path: 'click.html', actions: [{ fill: '#name', value: '魏征' }, { click: '#go' }, { assertText: '已点名：李靖', timeoutMs: 300 }] } }] };
      if (c.system.includes('独相') && (c.lastUser.includes('PREVIEWTEST') || c.lastUser.includes('MCPTEST') || c.lastUser.includes('PREVIEWACT'))) return { text: '已验证。' };
      return base(c);
    },
  });
  const dataDir = fs.mkdtempSync('/tmp/edict-e2e2-data-');
  const ws = fs.mkdtempSync('/tmp/edict-e2e2-ws-');
  fs.writeFileSync(
    path.join(ws, 'index.html'),
    `<!doctype html><html><head><meta charset="utf-8"><title>凌烟阁</title><link rel="stylesheet" href="style.css">
<script src="https://cdn.example.com/lib.js"></script></head>
<body><h1>凌烟阁功臣录</h1><p id="n">加载中</p><script src="app.js"></script></body></html>`,
  );
  fs.writeFileSync(path.join(ws, 'style.css'), 'body{font-family:sans-serif;background:#f5efe3;color:#2b2118;padding:24px} h1{color:#b3322a}');
  fs.writeFileSync(path.join(ws, 'app.js'), "document.getElementById('n').textContent='共 24 人';\nconsole.log('ready');\nundefinedFn();\n");
  const app = await electron.launch({ executablePath: process.env.EDICT_ELECTRON ?? (electronBinary as unknown as string), args: [path.resolve('dist'), '--no-sandbox', `--edict-data-dir=${dataDir}`], env: { ...process.env, EDICT_E2E: '1' } });
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

  await inv('upsertProvider', {
    id: '', name: 'Mock 中转', preset: 'custom', protocol: 'openai-chat', baseUrl: mock.url, enabled: true, hasKey: false,
    models: [
      { id: 'mock-strong', inputPrice: 3, outputPrice: 15, contextWindow: 128000, reasoning: { style: 'openai', levels: ['low', 'medium', 'high', 'xhigh'], default: 'medium' } },
      { id: 'mock-economy', inputPrice: 0.2, outputPrice: 0.8, contextWindow: 128000 },
      { id: 'relay-bad', inputPrice: 1, outputPrice: 1, contextWindow: 128000 },
    ],
  }, 'sk-e2e-SECRET-KEY-111');
  await inv('setWorkspace', ws);
  await inv('updateSettings', { permissionMode: 'auto', finalGate: false });
  await win.waitForTimeout(600);

  // ── 1. 思考程度 slider
  if (want('effort')) {
    await win.evaluate(() => (window as any).__edictUI.setUI({ composerHidden: false }));
    const slider = win.locator('[data-testid=composer] [data-testid=effort] input[type=range]');
    await slider.waitFor({ timeout: 5000 });
    const max = await slider.getAttribute('max');
    ok('思考程度滑块按模型档位显示（mock-strong：Low→XHigh，4 档）', max === '3', `max=${max}`);
    await slider.fill('3');
    await win.waitForTimeout(200);
    const label = await win.textContent('[data-testid=composer] .effort-v');
    ok('滑到最右 = 该模型最高档，显示英文原名 XHigh', label === 'XHigh', label ?? '');
    const effTip = (await win.locator('[data-testid=composer] [data-testid=effort]').getAttribute('data-tip-desc')) ?? '';
    ok('思考程度说明：新文案，不再写「最右是该模型最高档」', effTip.startsWith('模型想得越深结果越好，但更慢、更费 token。') && !effTip.includes('最右'), effTip);
    await shot('30-effort-slider');
    await win.fill('#composer-input', 'EFFORTTEST 写 solo.txt');
    await win.click('text=协同'); // off → Solo
    await win.click('[data-testid=composer-send]');
    await waitTask((t) => t.edict.includes('EFFORTTEST') && t.state === 'Done');
    const b = mock.bodies.find((x: any) => JSON.stringify(x.messages ?? []).includes('EFFORTTEST'));
    ok('请求体携带 reasoning_effort=xhigh（真实 Electron → mock 服务）', b?.reasoning_effort === 'xhigh' && b?.max_tokens === undefined && typeof b?.max_completion_tokens === 'number', JSON.stringify({ e: b?.reasoning_effort, mct: b?.max_completion_tokens }));
    // economy model has no ladder → shows 不适用
    await win.selectOption('[data-testid=composer] select.mini-select', { label: 'mock-economy · Mock 中转' });
    ok('无思考档位的模型显示「不适用」', await win.isVisible('[data-testid=composer] [data-testid=effort-none]'));
  }

  // ── 2. relay 503 error card → 换模型重试
  if (want('error')) {
    await win.selectOption('[data-testid=composer] select.mini-select', { label: 'relay-bad · Mock 中转' });
    await win.fill('#composer-input', 'RELAYTEST 写 solo.txt');
    await win.click('[data-testid=composer-send]');
    const t = await waitTask((x) => x.edict.includes('RELAYTEST') && x.state === 'Blocked', 20000);
    await win.waitForSelector('[data-testid=model-error-card]', { timeout: 8000 });
    const card = (await win.textContent('[data-testid=model-error-card]')) ?? '';
    const tries = mock.calls.filter((c) => c.model === 'relay-bad').length;
    ok('中转站 503「分组不支持」→ 可读错误卡片，且不盲目重试', card.includes('不被支持') && card.includes('协议探测') && tries === 1, `calls=${tries}`);
    await shot('31-error-card');
    await win.selectOption('[data-testid=err-model-pick]', { label: 'mock-strong · Mock 中转' });
    await win.click('[data-testid=retry-with-model]');
    const done = await waitTask((x) => x.id === t.id && x.state === 'Done', 20000).catch(() => null);
    ok('换模型重试：局部重试该节点后结案', !!done);
    // protocol probe in 模型配置
    await win.evaluate(() => (window as any).__openPanel('models'));
    await win.waitForSelector('[data-testid=probe-btn]');
    await win.click('[data-testid=probe-btn]');
    await win.waitForSelector('[data-testid=probe-table]', { timeout: 15000 });
    const probe = (await win.textContent('[data-testid=probe-table]')) ?? '';
    ok('协议探测矩阵（Chat / Responses / Messages × 有无思考参数）', probe.includes('Chat Completions') && probe.includes('可用'));
    await win.click('[data-testid=reasoning-btn] >> nth=0');
    await win.waitForSelector('[data-testid=reasoning-editor]');
    await shot('32-models-reasoning-probe');
    // 检测思考档位: the mock accepts any level, so the result is "unconfirmed" and the hand-set ladder is kept
    const before = mock.calls.length;
    await win.click('[data-testid=reasoning-detect]');
    await win.waitForSelector('.toast >> text=不校验思考档位', { timeout: 15000 });
    const summary = (await win.textContent('[data-testid=reasoning-btn] >> nth=0')) ?? '';
    ok('检测思考档位：服务不校验时标「未能确认」，保留原档位', summary.startsWith('未能确认') && summary.includes('Low→XHigh') && mock.calls.length - before === 2, `${summary} calls=${mock.calls.length - before}`);
    // per-official models (设置 · 官员模型与路由): one row each, model dropdown wide enough to read "model · service"
    await win.evaluate(() => (window as any).__openSettings('routing'));
    const rows = win.locator('[data-testid=agent-model-list] [data-testid^=agent-model-]');
    await rows.first().waitFor({ timeout: 5000 });
    await rows.first().scrollIntoViewIfNeeded();
    const boxes = await rows.evaluateAll((els) => els.map((e) => { const r = e.getBoundingClientRect(); const sel = e.querySelector('select')!.getBoundingClientRect(); return { y: r.y, w: sel.width }; }));
    ok('官员模型竖排：每位官员一行，模型下拉足够宽', boxes.length >= 10 && boxes.every((b, i) => i === 0 || b.y > boxes[i - 1].y) && boxes.every((b) => b.w >= 230), JSON.stringify(boxes.slice(0, 3)));
    await shot('33-models-agent-list');
  }

  // ── 3. HTML 预览
  if (want('preview')) {
    await win.evaluate(() => (window as any).__edictUI.setUI({ sideView: 'explorer' }));
    await win.click('.tree-row:has-text("index.html")');
    await win.waitForSelector('[data-testid=editor-preview]');
    await win.click('[data-testid=editor-preview]');
    await win.waitForSelector('[data-testid=preview-webview]');
    let consoleTxt = '';
    for (let i = 0; i < 40; i++) {
      consoleTxt = (await win.textContent('[data-testid=preview-console-btn]')) ?? '';
      if (consoleTxt.includes('✖')) break;
      await win.waitForTimeout(250);
    }
    ok('预览页签：webview 加载工作区页面并捕获控制台错误', consoleTxt.includes('✖1'), consoleTxt);
    const blockedShown = await win.isVisible('text=已拦截').catch(() => false);
    ok('预览默认拦截外部网络请求（CDN）并提示', blockedShown);
    await win.click('[data-testid=preview-console-btn]');
    await win.waitForSelector('[data-testid=preview-console]');
    const logs = (await win.textContent('[data-testid=preview-console]')) ?? '';
    ok('控制台面板显示 undefinedFn 错误与 console.log', logs.includes('undefinedFn') && logs.includes('ready'));
    await win.waitForTimeout(500);
    await shot('33-html-preview');
    // live reload: change the page on disk
    fs.writeFileSync(path.join(ws, 'app.js'), "document.getElementById('n').textContent='共 24 人（已修复）';\nconsole.log('ready');\n");
    let fixed = false;
    for (let i = 0; i < 40 && !fixed; i++) {
      await win.waitForTimeout(250);
      const t = (await win.textContent('[data-testid=preview-console-btn]')) ?? '';
      fixed = !t.includes('✖');
    }
    ok('磁盘改动后预览自动刷新（错误消失）', fixed);
    // hidden-browser capture (the same host function the agent tool uses)
    const cap: any = await inv('previewCapture', 'preview://ws/index.html', 800, 600);
    ok('无头预览：标题 / 文本 / 截图', cap.title === '凌烟阁' && cap.text.includes('已修复') && /^[a-f0-9]{64}$/.test(cap.screenshot ?? ''), JSON.stringify({ title: cap.title, blocked: cap.blocked?.length }));
    // interactive steps in the same hidden browser: fill / select / check / press / click change the page; assertions verify it
    fs.writeFileSync(
      path.join(ws, 'click.html'),
      `<!doctype html><html><head><meta charset="utf-8"><title>点名册</title><style>body{font-family:sans-serif;margin:0;padding:16px}.wide{width:520px;height:30px;background:#b3322a}</style></head>
<body><h1>点名册</h1><input id="name" placeholder="姓名"><select id="dept"><option value="li">吏部</option><option value="bing">兵部</option></select>
<label><input type="checkbox" id="ok"> 已核</label><button type="button" id="go">点名</button><p id="out">尚未点名</p><div class="wide"></div>
<script>
var go = document.getElementById('go');
go.addEventListener('click', function () {
  var d = document.getElementById('dept');
  document.getElementById('out').textContent = '已点名：' + document.getElementById('name').value + '（' + d.options[d.selectedIndex].text + (document.getElementById('ok').checked ? '，已核' : '') + '）';
  fetch('https://cdn.example.com/track').catch(function () {});
  alert('点名完成');
});
document.getElementById('name').addEventListener('keydown', function (e) { if (e.key === 'Enter') go.click(); });
</script></body></html>`,
    );
    const interact: any = await inv('previewCapture', 'preview://ws/click.html', 800, 600, {
      actions: [
        { fill: '#name', value: '魏征' },
        { select: '#dept', value: '兵部' },
        { check: '#ok' },
        { press: 'Enter', selector: '#name' },
        { assertText: '已点名：魏征（兵部，已核）' },
        { fill: '#name', value: '房玄龄' },
        { click: '#go', screenshot: true },
        { assertText: '已点名：房玄龄（兵部，已核）', selector: '#out' },
        { assertVisible: '#out' },
      ],
      viewports: [{ width: 375, height: 667 }],
    });
    const stepNotes = JSON.stringify((interact.steps ?? []).map((s: any) => `${s.ok ? '✓' : '✗'} ${s.action}: ${s.note}`));
    ok('无头预览交互：填写 / 选择 / 勾选 / 回车 / 点击后文字改变，断言通过', interact.steps?.length === 9 && interact.steps.every((s: any) => s.ok) && interact.text.includes('已点名：房玄龄（兵部，已核）'), stepNotes);
    ok('交互期间：alert 不阻塞（记入控制台）、外部请求仍被拦截、步骤截图存为 blob', interact.console.some((c: any) => c.message.includes('[alert] 点名完成') && c.step === 4) && interact.blocked.some((u: string) => u.includes('cdn.example.com/track')) && /^[a-f0-9]{64}$/.test(interact.steps?.[6]?.screenshot ?? ''), JSON.stringify({ console: interact.console?.slice(0, 3), blocked: interact.blocked }));
    const vp = interact.viewports?.[0];
    const vpUrl: string | null = vp?.screenshot ? await inv('blobImage', vp.screenshot) : null;
    const vpWidth = vpUrl ? Buffer.from(vpUrl.split(',')[1], 'base64').readUInt32BE(16) : 0;
    ok('交互后另截手机尺寸：375 宽截图，并发现横向溢出', vpWidth === 375 && vp?.overflowX === true && vp?.contentWidth > 375, JSON.stringify({ vpWidth, overflowX: vp?.overflowX, contentWidth: vp?.contentWidth }));
    const failRun: any = await inv('previewCapture', 'preview://ws/click.html', 800, 600, { actions: [{ click: '#go' }, { assertText: '不存在的文字', timeoutMs: 300 }, { click: '#go' }] });
    ok('交互断言失败：该步报错并给出当前文本，后续步骤不执行', failRun.steps?.[0]?.ok === true && failRun.steps?.[1]?.ok === false && /未找到文本 “不存在的文字”；当前文本：.*已点名/.test(failRun.steps?.[1]?.note ?? '') && failRun.steps?.[2]?.skipped === true, JSON.stringify(failRun.steps?.map((s: any) => s.note)));
    // agent uses preview_page
    fs.writeFileSync(path.join(ws, 'app.js'), "document.getElementById('n').textContent='共 24 人';\nbroken();\n");
    await win.evaluate(() => (window as any).__edictUI.setUI({ composerHidden: false }));
    await win.selectOption('[data-testid=composer] select.mini-select', { label: 'mock-strong · Mock 中转' });
    await win.click('[data-testid=composer] .tier-seg button:has-text("Solo")');
    await win.fill('#composer-input', 'PREVIEWTEST 验证页面');
    await win.click('[data-testid=composer-send]');
    await waitTask((x) => x.edict.includes('PREVIEWTEST') && ['Done', 'Blocked'].includes(x.state), 30000);
    await win.waitForSelector('[data-testid=act-preview] img', { timeout: 10000 }).catch(() => null);
    const act = (await win.textContent('[data-testid=act-preview]').catch(() => '')) ?? '';
    ok('Agent 调用 preview_page：活动流展示截图与控制台错误', act.includes('凌烟阁') && act.includes('broken'), act.slice(0, 120));
    await shot('34-agent-preview');
    // agent preview_page with actions: per-step results (and the failed assertion) are in the tool result
    await win.evaluate(() => (window as any).__edictUI.setUI({ composerHidden: false }));
    await win.fill('#composer-input', 'PREVIEWACT 验证点名页');
    await win.click('[data-testid=composer-send]');
    const pt = await waitTask((x) => x.edict.includes('PREVIEWACT') && ['Done', 'Blocked'].includes(x.state), 30000);
    const pacts: any[] = await inv('activities', pt.id);
    const tr = pacts.find((a) => a.kind === 'tool_result' && a.data?.name === 'preview_page');
    const pv = pacts.find((a) => a.kind === 'preview');
    ok('Agent 调用 preview_page 带 actions：工具结果逐步列出，断言失败判为未通过', !!tr && tr.data.ok === false && /交互检查：未通过（2\/3 步成功；第 3 步「断言文本 “已点名：李靖”」失败）/.test(tr.content) && /✓ 2\. 点击 #go/.test(tr.content) && /交互 2\/3 步通过/.test(pv?.content ?? ''), (tr?.content ?? '').slice(0, 300));
  }

  // ── 4. 技能与 MCP 中心
  if (want('mcp')) {
    await win.evaluate(() => (window as any).__openPanel('skills'));
    await win.waitForSelector('[data-testid=skills-center]');
    await win.click('[data-testid=skills-new]');
    await win.fill('[data-testid=skill-name]', 'html-qa');
    await win.fill('[data-testid=skill-desc]', '网页产物验收清单');
    await win.fill('[data-testid=skill-body]', '# 网页验收\n1. preview_page 无控制台错误\n2. 手机宽度不溢出\n');
    await win.click('[data-testid=skill-save]');
    await win.waitForTimeout(400);
    const skills: any[] = (await inv('snapshot')).skills;
    ok('技能中心：新建技能并保存', skills.some((s) => s.name === 'html-qa' && s.description.includes('验收')));
    await shot('35-skills-center');
    // MCP server (real stdio JSON-RPC child process)
    const server = path.resolve('tests/fixtures/mcp-echo-server.mjs');
    await win.click('[data-testid=tab-mcp]');
    await win.waitForSelector('[data-testid=mcp-json]');
    const json = JSON.stringify({ mcpServers: { demo: { command: process.execPath.includes('electron') ? 'node' : process.execPath, args: [server], env: { ECHO_PREFIX: '${env:HOME}' } } } }, null, 2);
    await win.fill('[data-testid=mcp-json]', json);
    // the native "trust this local command?" dialog cannot be clicked by Playwright → the harness answers it
    let asked = '';
    await app.evaluate(({ dialog }) => {
      (globalThis as any).__asked = '';
      (dialog as any).showMessageBox = async (_w: unknown, o: { message: string; detail?: string }) => {
        (globalThis as any).__asked = `${o.message}\n${o.detail ?? ''}`;
        return { response: 1, checkboxChecked: false };
      };
    });
    await win.click('[data-testid=mcp-save]');
    await win.waitForTimeout(300);
    asked = await app.evaluate(() => (globalThis as any).__asked as string);
    ok('保存本地 MCP 命令前弹出原生确认框（测试替身代点「信任并运行」）', asked.includes('允许 Edict 在本机运行') && asked.includes('mcp-echo-server.mjs'), asked.split('\n')[0]);
    await win.waitForSelector('[data-testid=mcp-server-demo] .mcp-status.ok', { timeout: 15000 }).catch(() => null);
    await win.click('[data-testid=mcp-server-demo] button.link:has-text("工具")').catch(() => {});
    await win.waitForTimeout(200);
    const row = (await win.textContent('[data-testid=mcp-server-demo]').catch(() => '')) ?? '';
    ok('MCP：Cursor 格式 mcp.json 保存后连接 stdio 服务并列出工具', row.includes('echo') && row.includes('已连接'), row.slice(0, 160));
    await shot('36-mcp-center');
    await win.evaluate(() => (window as any).__edictUI.setUI({ composerHidden: false }));
    await win.click('[data-testid=composer] .tier-seg button:has-text("Solo")');
    await win.fill('#composer-input', 'MCPTEST 调用 demo');
    await win.click('[data-testid=composer-send]');
    const t = await waitTask((x) => x.edict.includes('MCPTEST') && ['Done', 'Blocked'].includes(x.state), 30000);
    const acts: any[] = await inv('activities', t.id, 200);
    const res = acts.find((a) => a.kind === 'tool_result' && a.data?.name === 'mcp__demo__echo');
    ok('Agent 调用 MCP 工具 mcp__demo__echo 并拿到结果', t.state === 'Done' && !!res && res.content.includes('朕知道了'), `${t.state} · ${res?.content?.slice(0, 80) ?? acts.filter((a) => a.kind === 'tool_result').map((a) => a.content.slice(0, 60)).join(' | ')}`);
  }

  // ── 5. 协同设计（Phase 1）
  if (want('designs')) {
    await win.evaluate(() => (window as any).__openPanel('designs'));
    await win.waitForSelector('[data-testid=designs-panel]');
    ok('协同设计面板：内置三省六部只读并展示流程', (await win.textContent('[data-testid=design-flow]'))!.includes('门下审议'));
    await win.click('[data-testid=design-copy-full]');
    await win.waitForSelector('[data-testid=design-editor]');
    ok('「复制完整版修改」打开编辑器（未保存前不产生新设计）', ((await inv('designList')) as any[]).every((d) => d.native));
    await win.click('[data-testid=de-save]');
    await win.waitForSelector('[data-testid=design-set-default]');
    const list: any[] = await inv('designList');
    const copy = list.find((d) => !d.native);
    ok('保存后成为我的设计（v1）', !!copy && copy.activeVersion === 1, copy?.name);
    await win.click('[data-testid=design-set-default]');
    await win.waitForTimeout(300);
    await shot('40-designs-panel');
    await win.evaluate(() => (window as any).__edictUI.setUI({ composerHidden: false }));
    await win.waitForSelector('[data-testid=design-pick]');
    const picked = await win.$eval('[data-testid=design-pick]', (e) => (e as HTMLSelectElement).value);
    ok('下旨框出现协同设计选择，默认选中刚复制的设计', picked === copy.id);
    ok('选择自定义设计时隐藏 Solo/Lite/Full 档位', !(await win.isVisible('[data-testid=composer] .tier-seg')));
    await win.fill('#composer-input', 'DESIGNTEST 写一个 greet 函数并测试');
    await win.check('text=直接下旨').catch(() => {});
    await win.click('[data-testid=composer-send]');
    const t1 = await waitTask((x) => x.edict.includes('DESIGNTEST') && (x.gate?.kind === 'plan' || x.state === 'Blocked'), 30000);
    ok('按复制的设计下旨：钉住版本并走到方案御览', t1.design?.id === copy.id && t1.design?.version === 1 && t1.gate?.kind === 'plan', `${t1.state} ${t1.blockedReason ?? ''}`);
    // a new version while the edict waits does not affect it
    const spec: any = await inv('designGet', copy.id);
    await inv('designSave', { ...spec, steps: spec.steps.filter((x: any) => x.id !== 'dispatch') }, 'E2E: 去掉派发');
    await win.click('[data-testid=gate-approve]');
    // (this E2E runs with finalGate off, which the copy inherited → the design ends without 御批)
    const t2 = await waitTask((x) => x.id === t1.id && ['Done', 'Blocked'].includes(x.state), 40000);
    ok('设计更新为 v2 后，进行中的旨意仍按 v1（含尚书派发、六部执行、门下审议成果）完成', t2.state === 'Done' && t2.design.version === 1 && t2.nodes.some((n: any) => n.kind === 'dispatch' && n.status === 'done') && t2.nodes.some((n: any) => n.kind === 'result_review' && n.status === 'done'), t2.blockedReason);
    await shot('41-design-task');
    // rollback through the UI
    await win.evaluate(() => (window as any).__openPanel('designs'));
    await win.click(`[data-testid=design-item-${copy.id}]`);
    await win.click('.design-versions .ver >> text=v1');
    await win.click('[data-testid=design-activate]');
    await win.waitForTimeout(300);
    const after: any[] = await inv('designList');
    ok('版本回滚：v2 → v1', after.find((d) => d.id === copy.id).activeVersion === 1);
    const audit: any[] = await inv('auditList', undefined, 400);
    ok('设计操作全程审计', ['design_saved', 'design_activated'].every((a) => audit.some((e) => e.action === a)));
  }

  if (want('designer')) {
    // 协同设计编辑器: blank design → canvas drag & drop → form → court layout → save → court follows it
    const center = async (sel: string) => { await win.locator(sel).scrollIntoViewIfNeeded(); const b = (await win.locator(sel).boundingBox())!; return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; };
    await win.evaluate(() => (window as any).__edictUI.setUI({ sideView: null }));
    await win.evaluate(() => (window as any).__openPanel('designs'));
    await win.click('[data-testid=design-new]');
    await win.waitForSelector('[data-testid=flow-canvas]');
    ok('新建空白设计：校验通过', (await win.textContent('[data-testid=de-issues]'))!.includes('校验通过'));
    await win.fill('[data-testid=de-name]', 'E2E 自定义协作');
    // the target is measured after the drag has started (empty phase lanes open up while dragging)
    const drag = async (from: string, dest: { x: number; y: number } | string | (() => Promise<{ x: number; y: number }>)) => {
      await win.locator(from).scrollIntoViewIfNeeded();
      const b = (await win.locator(from).boundingBox())!;
      await win.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
      await win.mouse.down();
      await win.mouse.move(b.x + b.width / 2 + 10, b.y + b.height / 2 + 10, { steps: 3 });
      await win.waitForTimeout(80);
      const to = typeof dest === 'string' ? await center(dest) : typeof dest === 'function' ? await dest() : dest;
      await win.mouse.move(to.x, to.y, { steps: 8 });
      await win.mouse.up();
      await win.waitForTimeout(150);
    };
    const lane = async (name: string) => (await win.locator(`.fc-lane:has(.fc-lane-h:text-is("${name}"))`).boundingBox())!;
    // drag a review in from the palette into the 汇总 lane after the last column
    await drag('[data-testid=fc-new-review]', async () => {
      const report = await lane('汇总');
      const last = (await win.locator('.fc-card:not(.fixed)').last().boundingBox())!;
      return { x: last.x + last.width + 110, y: report.y + report.height / 2 };
    });
    const cards = await win.$$eval('.fc-card:not(.fixed)', (els) => els.map((e) => e.getAttribute('data-testid')));
    ok('画布：从工具条拖入一个审议步骤', cards.length === 3 && cards[2] === 'fc-card-review', cards.join(','));
    // point its rejection back at the first step with the ↺ knob
    await drag('[data-testid=fc-knob-review]', '[data-testid=fc-card-step]');
    await win.click('[data-testid=fc-card-review]');
    ok('画布：拖 ↺ 设定封驳退回到第一步', (await win.locator('.fc-reject-t').count()) === 1 && (await win.$eval('[data-testid=sf-reject]', (e) => (e as HTMLSelectElement).value)) === 'step');
    // assign a role by dropping its chip on the review
    const roleChip = win.locator('[data-testid^=fc-role-]').nth(1);
    const roleId = (await roleChip.getAttribute('data-testid'))!.replace('fc-role-', '');
    await drag(`[data-testid=fc-role-${roleId}]`, '[data-testid=fc-card-review]');
    // drop a new single step on top of the first column → runs in parallel with it
    await drag('[data-testid=fc-new-agent]', '[data-testid=fc-card-step]');
    const parTags = await win.locator('.fc-card .fc-tag >> text=并行').count();
    ok('画布：拖到卡片正上方即与它并行', parTags === 1);
    await win.click('[data-testid=fc-card-step2]');
    await win.waitForSelector('[data-testid=step-form-step2]');
    await win.fill('[data-testid=step-form-step2] [data-testid=sf-label]', '并行查资料');
    await shot('44-designer-canvas');
    // form view: add a role and rename it
    await win.click('[data-testid=de-tab-form]');
    await win.click('[data-testid=de-add-role]');
    const roleForm = win.locator('[data-testid^=role-form-]').last();
    await roleForm.locator('input.input').first().fill('史官');
    ok('表单：添加并改名角色', (await win.locator('.de-item-h b >> text=史官').count()) === 1);
    const modelSel = roleForm.locator('[data-testid=role-model]');
    const firstDefault = (await modelSel.locator('option').first().textContent()) ?? '';
    await modelSel.selectOption({ label: 'mock-strong' });
    await roleForm.locator('[data-testid=role-effort]').selectOption('high');
    ok('表单：角色默认跟随路由，可指定模型和思考程度', firstDefault.startsWith('跟随经济路由') && (await modelSel.inputValue()).endsWith('::mock-strong'), firstDefault);
    await shot('45-designer-form');
    // court layout: auto seating, then drag a seat and make it sit at a desk
    await win.click('[data-testid=de-court]');
    await win.waitForSelector('[data-testid=de-sheet-court]');
    await win.click('[data-testid=court-layout-auto]');
    await win.waitForSelector('[data-testid=cl-stage]');
    const seats = await win.locator('[data-testid^=cl-seat-]').count();
    ok('朝堂布局：按角色自动排班', seats === 3, String(seats));
    const stage = (await win.locator('[data-testid=cl-stage]').boundingBox())!;
    const firstSeat = (await win.locator('[data-testid^=cl-seat-]').first().getAttribute('data-testid'))!.replace('cl-seat-', '');
    await drag(`[data-testid=cl-seat-${firstSeat}]`, { x: stage.x + 330, y: stage.y + 220 });
    await win.click(`[data-testid=cl-pose-sit]`);
    await win.selectOption('[data-testid=cl-idle]', 'write');
    await shot('46-designer-court-layout');
    await win.click('[data-testid=de-sheet-done]');
    await win.click('[data-testid=de-save]');
    await win.waitForSelector('[data-testid=design-set-default]');
    const mine = ((await inv('designList')) as any[]).find((d) => d.name === 'E2E 自定义协作');
    const spec: any = mine && (await inv('designGet', mine.id));
    const review = spec?.steps.find((s: any) => s.id === 'review');
    const seat = spec?.court?.seats.find((s: any) => s.role === firstSeat);
    ok('保存：流程、并行、封驳、角色与朝堂布局都写入新设计', !!spec && review?.onReject?.goto === 'step' && review.role === roleId && spec.steps.find((s: any) => s.id === 'step2')?.parallel === true
      && spec.roles.some((r: any) => r.name === '史官' && r.model?.model === 'mock-strong' && r.effort === 'high') && seat?.pose === 'sit' && seat.idle === 'write' && Math.abs(seat.x - 330) <= 2 && spec.court.hideBuiltin === true, JSON.stringify({ review, step2: spec?.steps.find((s: any) => s.id === 'step2'), roles: spec?.roles.map((r: any) => r.name), seat }));
    const shiguan = spec?.roles.find((r: any) => r.name === '史官');
    const cell = (await win.textContent(`[data-testid=role-model-cell-${shiguan?.id}]`).catch(() => '')) ?? '';
    ok('详情页角色表显示每个角色用的模型', cell.includes('mock-strong') && cell.includes('High'), cell);
    // the court follows the chosen design's layout
    await win.click('[data-testid=design-set-default]');
    await win.evaluate(() => (window as any).__edictUI.setUI({ mode: 'court', courtScene: 'taihe' }));
    await win.waitForFunction(() => (window as any).__court?.officials?.().some((o: any) => o.seat), null, { timeout: 15000 });
    const offs: any[] = await win.evaluate(() => (window as any).__court.officials());
    const names = spec.court.seats.filter((s: any) => s.scene === 'taihe').map((s: any) => spec.roles.find((r: any) => r.id === s.role).name);
    const sat = offs.find((o) => o.label === spec.roles.find((r: any) => r.id === firstSeat).name);
    ok('朝堂按设计布局：只站本设计的角色，位置与姿态一致', offs.every((o) => o.seat) && names.every((n: string) => offs.some((o) => o.label === n)) && !!sat && sat.seated && Math.abs(sat.x - seat.x) <= 1, offs.map((o) => `${o.label}@${o.x},${o.y}`).join(' '));
    await win.waitForTimeout(900);
    await shot('47-court-custom-layout');
    await win.evaluate(() => (window as any).__edictUI.setUI({ mode: 'workbench' }));
    await inv('updateSettings', { defaultDesign: 'edict-court' });
  }

  if (want('manage')) {
    // design list: built-in can't be deleted; others can be favourited, edited and deleted
    await win.evaluate(() => (window as any).__edictUI.setUI({ mode: 'workbench', sideView: null }));
    await win.evaluate(() => (window as any).__openPanel('designs'));
    await win.waitForSelector('[data-testid=designs-panel]');
    const mk = async (name: string) => {
      const t: any = await inv('designTemplate', 'lite');
      const { version: _v, createdAt: _c, ...body } = t;
      return inv('designSave', { ...body, name, origin: { kind: 'user' } }, 'E2E');
    };
    const a: any = await mk('E2E 甲');
    const b: any = await mk('E2E 乙');
    await win.waitForSelector(`[data-testid=design-item-${b.id}]`);
    ok('内置三省六部没有删除按钮', (await win.locator('[data-testid=design-row-del-edict-court]').count()) === 0 && (await win.locator(`[data-testid=design-row-del-${a.id}]`).count()) === 1);
    await win.click(`[data-testid=design-fav-${a.id}]`);
    await win.waitForTimeout(300);
    const order = await win.$$eval('[data-testid^=design-item-]', (els) => els.map((e) => e.getAttribute('data-testid')!.replace('design-item-', '')));
    ok('收藏后排到内置之后的最前面，并显示 ★', order[0] === 'edict-court' && order[1] === a.id && (await win.textContent(`[data-testid=design-fav-${a.id}]`)) === '★', order.join(','));
    await shot('50-designs-list-actions');
    // edit from the row icon, then the corner link for seating
    await win.click(`[data-testid=design-row-edit-${b.id}]`);
    await win.waitForSelector('[data-testid=design-editor]');
    ok('列表上的 ✎ 直接进入修改', (await win.inputValue('[data-testid=de-name]')) === 'E2E 乙');
    await win.click('[data-testid=de-court]');
    await win.waitForSelector('[data-testid=de-sheet-court]');
    ok('编辑页右上角「朝堂站位」打开站位面板', await win.isVisible('[data-testid=court-layout-empty]'));
    await shot('51-designer-court-sheet');
    await win.click('[data-testid=de-sheet-done]');
    await win.click('[data-testid=de-close]');
    await win.waitForSelector('[data-testid=design-set-default]');
    await win.click(`[data-testid=design-item-${b.id}]`);
    await win.click('[data-testid=design-court-link]');
    await win.waitForSelector('[data-testid=de-sheet-court]');
    ok('详情页角落的「朝堂站位」直接打开站位编辑', true);
    await win.click('[data-testid=de-sheet-done]');
    await win.click('[data-testid=de-close]');
    // delete (in-app confirm) — cancel first, then confirm
    await win.click(`[data-testid=design-row-del-${b.id}]`);
    await win.waitForSelector('[data-testid=confirm-msg]');
    await shot('52-design-delete-confirm');
    await win.click('.modal-actions >> text=取消');
    ok('取消删除时设计保留', ((await inv('designList')) as any[]).some((d) => d.id === b.id));
    await win.click(`[data-testid=design-row-del-${b.id}]`);
    await win.click('[data-testid=confirm-ok]');
    await win.waitForTimeout(400);
    ok('确认后删除，列表与下旨选择里都消失', !((await inv('designList')) as any[]).some((d) => d.id === b.id) && (await win.locator(`[data-testid=design-item-${b.id}]`).count()) === 0);
    const audit: any[] = await inv('auditList', undefined, 400);
    ok('删除写入审计', audit.some((e) => e.action === 'design_deleted' && e.detail?.id === b.id) || audit.some((e) => e.action === 'design_deleted'));
    await win.click('[data-testid=toast-action] >> text=撤销');
    await win.waitForSelector(`[data-testid=design-item-${b.id}]`, { timeout: 3000 }).catch(() => {});
    ok('删除后可在提示里一键撤销，设计连同版本恢复', ((await inv('designList')) as any[]).some((d) => d.id === b.id && d.versions.length === 1));
    // editor: undo / redo, Delete on a selected step, Esc closes the seating sheet
    await win.click(`[data-testid=design-row-edit-${a.id}]`);
    await win.waitForSelector('[data-testid=flow-canvas]');
    await win.fill('[data-testid=de-name]', 'E2E 甲 改');
    await win.click('[data-testid=flow-canvas]', { position: { x: 5, y: 5 } }).catch(() => {});
    await win.waitForTimeout(700);
    const nCards = await win.locator('.fc-card:not(.fixed)').count();
    await win.locator('.fc-card:not(.fixed)').first().click();
    await win.keyboard.press('Delete');
    const afterDel = await win.locator('.fc-card:not(.fixed)').count();
    await win.click('[data-testid=de-undo]');
    const afterUndo = await win.locator('.fc-card:not(.fixed)').count();
    ok('选中步骤按 Delete 删除，撤销后回来', afterDel === nCards - 1 && afterUndo === nCards, `${nCards}→${afterDel}→${afterUndo}`);
    await win.click('[data-testid=de-undo]');
    const undone = await win.inputValue('[data-testid=de-name]');
    await win.click('[data-testid=de-redo]');
    ok('撤销 / 重做按钮', undone === 'E2E 甲' && (await win.inputValue('[data-testid=de-name]')) === 'E2E 甲 改', undone);
    await win.click('[data-testid=de-court]');
    await win.waitForSelector('[data-testid=de-sheet-court]');
    await win.keyboard.press('Escape');
    await win.waitForTimeout(150);
    ok('Esc 关闭站位面板', (await win.locator('[data-testid=de-sheet-court]').count()) === 0);
    // leaving without saving keeps an autosaved copy that the list offers to restore
    await win.waitForTimeout(500);
    await win.evaluate(() => (window as any).__openPanel('kanban'));
    await win.waitForTimeout(300);
    await win.evaluate(() => (window as any).__openPanel('designs'));
    await win.waitForSelector('[data-testid=design-stash]', { timeout: 3000 }).catch(() => {});
    ok('没保存就离开：列表顶部提示「继续编辑」', (await win.locator('[data-testid=design-stash]').count()) === 1);
    await shot('53-design-stash');
    await win.click('[data-testid=design-stash-resume]');
    await win.waitForSelector('[data-testid=design-editor]');
    ok('继续编辑恢复未保存的修改', (await win.inputValue('[data-testid=de-name]')) === 'E2E 甲 改');
    await win.keyboard.press('Control+S');
    await win.waitForSelector('[data-testid=design-set-default]', { timeout: 5000 }).catch(() => {});
    const a2 = ((await inv('designList')) as any[]).find((d) => d.id === a.id);
    ok('Ctrl/⌘+S 保存为新版本，自动保存的副本随之清除', a2?.activeVersion === 2 && a2.name === 'E2E 甲 改' && (await win.locator('[data-testid=design-stash]').count()) === 0, JSON.stringify({ v: a2?.activeVersion, n: a2?.name }));
    // the built-in row's ✎ opens an unsaved copy; leaving it creates nothing
    const before = ((await inv('designList')) as any[]).length;
    await win.click('[data-testid=design-row-edit-edict-court]');
    await win.waitForSelector('[data-testid=design-editor]');
    await win.click('[data-testid=de-close]');
    await win.waitForSelector('[data-testid=designs-panel] .split-list');
    ok('内置的 ✎ 是「复制后修改」，不保存就不留下', ((await inv('designList')) as any[]).length === before);
  }

  if (want('tips')) {
    // hover descriptions on the activity bar (screens, bottom group, shortcuts)
    await win.evaluate(() => (window as any).__edictUI.setUI({ mode: 'workbench', sideView: 'explorer' }));
    await win.mouse.move(700, 450);
    await win.hover('[data-testid=ab-designs]');
    await win.waitForSelector('[data-testid=tip]', { timeout: 3000 });
    const t1 = await win.textContent('[data-testid=tip]');
    ok('活动栏悬停显示名称与一行说明', !!t1 && t1.includes('协同设计') && t1.includes('分工协作') && !t1.includes('朝堂谁站哪'), t1 ?? '');
    await shot('48-tip-activitybar');
    await win.hover('[data-testid=ab-settings]');
    await win.waitForFunction(() => document.querySelector('[data-testid=tip]')?.textContent?.includes('⌘,'), null, { timeout: 3000 });
    ok('带快捷键的入口在提示里显示快捷键', true);
    await win.hover('[data-testid=ab-permissions]');
    await win.waitForFunction(() => document.querySelector('[data-testid=tip]')?.textContent?.includes('官员动手前'), null, { timeout: 3000 });
    ok('活动栏底部的权限、MCP 等入口也有悬停说明（含当前权限模式）', true);
    await shot('49-tip-permissions');
    // the composer's controls explain themselves too (cards open above, inside the window)
    await win.evaluate(() => (window as any).__edictUI.setUI({ composerHidden: false }));
    const sw = win.locator('[data-testid=composer] label.switch input');
    if (!(await sw.isChecked())) await sw.check();
    await win.mouse.move(700, 450);
    await win.hover('[data-testid=composer] label.switch');
    await win.waitForFunction(() => document.querySelector('[data-testid=tip]')?.textContent?.includes('多位 AI'), null, { timeout: 3000 });
    await win.hover('[data-testid=composer] label.chk:has-text("直接下旨")');
    await win.waitForFunction(() => document.querySelector('[data-testid=tip]')?.textContent?.includes('闲聊'), null, { timeout: 3000 });
    const tb = (await win.locator('[data-testid=tip]').boundingBox())!;
    const vp = win.viewportSize()!;
    ok('下旨框的「协同」「直接下旨」等也有悬停说明，且完整显示在窗口内', tb.y >= 0 && tb.y + tb.height <= vp.height && tb.x >= 0 && tb.x + tb.width <= vp.width, JSON.stringify(tb));
    await shot('54-tip-composer');
    await win.mouse.move(700, 450);
    await win.waitForTimeout(200);
    ok('移开鼠标提示消失', (await win.locator('[data-testid=tip]').count()) === 0);
  }

  if (want('sidebar')) {
    // left activity bar: 待办 / 网页预览 side views, pinned screens, right-click customize, 进入朝堂
    await win.evaluate(() => (window as any).__edictUI.setUI({ mode: 'workbench', sideView: null }));
    await win.click('[data-testid=ab-inbox]');
    await win.waitForSelector('[data-testid=inbox]');
    ok('活动栏「待办」打开等你处理的事', true);
    await shot('42-sidebar-inbox');
    await win.click('[data-testid=ab-preview]');
    await win.waitForSelector('[data-testid=preview-side]');
    await win.waitForTimeout(400);
    const htmlFiles = await win.$$eval('.ps-file .ps-name', (els) => els.map((e) => e.textContent));
    ok('网页预览侧栏列出工作区 HTML 文件', htmlFiles.includes('index.html'), htmlFiles.join(','));
    await shot('43-sidebar-preview');
    await win.click('.ps-file >> text=index.html');
    await win.waitForTimeout(800);
    ok('点击即在预览标签页打开', (await win.locator('.tab >> text=预览 · index.html').count()) > 0 || (await win.locator('text=预览 · index.html').count()) > 0);
    await win.click('[data-testid=ab-designs]');
    await win.waitForSelector('[data-testid=designs-panel]');
    ok('活动栏「协同设计」直达设计面板', true);
    // right-click → customize: unpin 朝堂议政, pin 旨库, then reset
    await win.click('[data-testid=activitybar]', { button: 'right', position: { x: 24, y: 520 } });
    await win.waitForSelector('[data-testid=ab-customize]');
    await win.click('[data-testid=ab-pin-debate]');
    await win.click('[data-testid=activitybar]', { button: 'right', position: { x: 24, y: 520 } });
    await win.click('[data-testid=ab-pin-templates]');
    await win.waitForTimeout(200);
    const pinned = await win.evaluate(() => [!!document.querySelector('[data-testid=ab-debate]'), !!document.querySelector('[data-testid=ab-templates]') || !!document.querySelector('[data-testid=ab-more]')]);
    ok('右键活动栏可增减常用页面', !pinned[0] && pinned[1], JSON.stringify(pinned));
    await win.click('[data-testid=activitybar]', { button: 'right', position: { x: 24, y: 520 } });
    await win.click('[data-testid=ab-reset]');
    await win.mouse.click(700, 450);
    await win.click('[data-testid=to-court]');
    await win.waitForTimeout(600);
    ok('标题栏「朝堂」切换到朝堂', await win.locator('[data-testid=court]').isVisible());
    await win.evaluate(() => (window as any).__edictUI.setUI({ mode: 'workbench' }));
  }

  const leak = ['audit.jsonl', 'state.json', 'settings.json', 'mcp.json', 'edict.db', 'edict.db-wal'].map((f) => path.join(dataDir, 'EdictData', f)).some((f) => fs.existsSync(f) && fs.readFileSync(f, 'utf8').includes('SECRET-KEY'));
  ok('API Key 未出现在审计/状态/设置/mcp.json 中', !leak);
  ok('无前端运行时错误', errors.filter((e) => !/ResizeObserver|Autofocus|Electron Security|favicon|cdn\.example\.com|ERR_BLOCKED|undefinedFn|broken/.test(e)).length === 0, errors.slice(0, 3).join(' | '));
  await app.close();
  await mock.close();
  fs.writeFileSync(path.join(SHOTS, 'e2e-features-results.json'), JSON.stringify({ host: 'linux-xvfb (not macOS)', llm: 'mock (scripted, real SSE wire formats)', mcp: 'real stdio child process (test fixture server)', results }, null, 2));
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
