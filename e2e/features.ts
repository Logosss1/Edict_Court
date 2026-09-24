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
      if (c.system.includes('独相') && (c.lastUser.includes('PREVIEWTEST') || c.lastUser.includes('MCPTEST'))) return { text: '已验证。' };
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
    ok('思考程度滑块按模型档位显示（mock-strong：低→超高，4 档）', max === '3', `max=${max}`);
    await slider.fill('3');
    await win.waitForTimeout(200);
    const label = await win.textContent('[data-testid=composer] .effort-v');
    ok('滑到最右 = 该模型最高档（超高 xhigh）', label === '超高', label ?? '');
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

  const leak = ['audit.jsonl', 'state.json', 'settings.json', 'mcp.json'].map((f) => path.join(dataDir, 'EdictData', f)).some((f) => fs.existsSync(f) && fs.readFileSync(f, 'utf8').includes('SECRET-KEY'));
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
