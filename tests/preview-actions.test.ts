// preview_page interactive steps (unit): the step runner driven through injected exec / capture. The fake page
// below runs the REAL injected step script in a node:vm context against a tiny fake DOM — no Electron, no browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { captureViewports, parsePreviewActions, parsePreviewPlan, runPreviewSteps, stepScript, type PreviewAction, type PreviewIO, type PreviewRenderOptions } from '../src/main/services/previewActions';
import { executeTool } from '../src/main/runtime/tools';
import { checkEvidence } from '../src/main/runtime/execPolicy';
import type { PreviewResult, RunNode, Task } from '../src/shared/types';
import { startMockLlm } from './mockLlm';
import { makeRuntime, tmpDir } from './helpers';

class FakeEvent {
  type: string;
  cancelable = false;
  defaultPrevented = false;
  [k: string]: unknown;
  constructor(type: string, init: Record<string, unknown> = {}) {
    this.type = type;
    Object.assign(this, init);
  }
  preventDefault() {
    if (this.cancelable) this.defaultPrevented = true;
  }
}

class FakeEl {
  id = '';
  type = '';
  value = '';
  text = '';
  checked = false;
  disabled = false;
  readOnly = false;
  hidden = false;
  isContentEditable = false;
  tabIndex = 0;
  selectedIndex = -1;
  options: { value: string; text: string; label?: string; disabled?: boolean }[] = [];
  form: { querySelector(s: string): FakeEl | null; requestSubmit?(): void } | null = null;
  attrs: Record<string, string> = {};
  events: string[] = [];
  listeners: Record<string, ((e: FakeEvent) => void)[]> = {};
  constructor(public page: FakePage, public tagName: string, init: Partial<FakeEl> = {}) {
    Object.assign(this, init);
  }
  get innerText(): string {
    if (this.tagName === 'BODY') return [...this.page.els.values()].map((e) => e.innerText).filter(Boolean).join('\n');
    return this.hidden ? '' : this.text;
  }
  get textContent() {
    return this.text;
  }
  set textContent(v: string) {
    this.text = v;
  }
  getClientRects() {
    return this.hidden ? [] : [{}];
  }
  getBoundingClientRect() {
    return this.hidden ? { left: 0, top: 0, width: 0, height: 0 } : { left: 10, top: 10, width: 120, height: 24 };
  }
  getAttribute(n: string) {
    return this.attrs[n] ?? null;
  }
  on(type: string, fn: (e: FakeEvent) => void) {
    (this.listeners[type] ??= []).push(fn);
    return this;
  }
  dispatchEvent(e: FakeEvent) {
    this.events.push(e.type);
    if (e.type === 'click' && this.tagName === 'INPUT' && this.type === 'checkbox') this.checked = !this.checked;
    for (const fn of this.listeners[e.type] ?? []) fn.call(this, e);
    return !e.defaultPrevented;
  }
  click() {
    this.dispatchEvent(new FakeEvent('click', { bubbles: true, cancelable: true }));
  }
  focus() {
    this.page.active = this;
  }
  scrollIntoView() {}
  contains(o: unknown) {
    return o === this;
  }
}

/** A fake page: elements registered by exact selector string; a virtual clock; screenshots as numbered buffers. */
class FakePage {
  els = new Map<string, FakeEl>();
  queried: string[] = [];
  logs: string[] = [];
  active: FakeEl | null = null;
  cover: FakeEl | null = null;
  clock = 0;
  execs = 0;
  shots = 0;
  scrollY = 0;
  beforeExec?: () => void;
  body = new FakeEl(this, 'BODY');
  ctx: vm.Context;
  constructor() {
    const page = this;
    const document = {
      get body() {
        return page.body;
      },
      documentElement: { scrollHeight: 2400, scrollWidth: 1280, clientWidth: 1280 },
      get activeElement() {
        return page.active ?? page.body;
      },
      querySelector(sel: string) {
        page.queried.push(sel);
        if (sel.startsWith('!!')) throw new SyntaxError(`'${sel}' is not a valid selector`);
        return page.els.get(sel) ?? null;
      },
      querySelectorAll: () => [...page.els.values()],
      elementFromPoint: () => page.cover,
    };
    const g: Record<string, unknown> = {
      document,
      console: { info: (m: string) => page.logs.push(m), log: (m: string) => page.logs.push(m) },
      setTimeout,
      Event: FakeEvent, InputEvent: FakeEvent, MouseEvent: FakeEvent, PointerEvent: FakeEvent, KeyboardEvent: FakeEvent,
      getComputedStyle: (el: FakeEl) => ({ visibility: el.hidden ? 'hidden' : 'visible' }),
      scrollTo: (_x: number, y: number) => (page.scrollY = y),
      scrollBy: (_x: number, dy: number) => (page.scrollY += dy),
      get scrollY() {
        return page.scrollY;
      },
      innerHeight: 800,
    };
    g.window = g;
    this.ctx = vm.createContext(g);
  }
  add(sel: string, tag: string, init: Partial<FakeEl> = {}) {
    const el = new FakeEl(this, tag, init);
    this.els.set(sel, el);
    return el;
  }
  io(): PreviewIO {
    return {
      exec: async (js) => {
        this.execs++;
        this.beforeExec?.();
        return vm.runInContext(js, this.ctx);
      },
      capture: async () => Buffer.from(`png-${++this.shots}`),
      sleep: async (ms) => {
        this.clock += ms;
      },
      now: () => this.clock,
    };
  }
}

const parsed = (raw: unknown): PreviewAction[] => {
  const p = parsePreviewActions(raw);
  assert.ok(p.ok, p.ok ? '' : p.error);
  return p.actions;
};

test('steps run in order against the page; fill reaches the page with input/change; selectors and values stay JSON data', async () => {
  const page = new FakePage();
  const out = page.add('#out', 'P', { text: '未开始' });
  const name = page.add('#name', 'INPUT', { id: 'name', type: 'text' });
  // quotes, backticks, ${}, </script>, U+2028, a newline and a would-be code break-out — must arrive byte-exact
  const evil = 'button[data-x="a\'b`c${1}</script>' + String.fromCharCode(0x2028) + '"]\n\'); globalThis.pwned = 1; (\'';
  const value = '张三"\'`${x}\\' + String.fromCharCode(0x2029);
  page.add(evil, 'BUTTON', { id: 'go', text: '开始' }).on('click', () => (out.text = `你好，${name.value}`));
  const steps = await runPreviewSteps(parsed([{ fill: '#name', value }, { click: evil }, { assertText: '你好，张三' }, { assertVisible: '#out' }, { screenshot: true }]), page.io());
  assert.deepEqual(steps.map((s) => [s.index, s.ok]), [[1, true], [2, true], [3, true], [4, true], [5, true]], JSON.stringify(steps));
  assert.deepEqual(page.queried, ['#name', evil, '#out'], 'one lookup per element step, in order, selector byte-exact');
  assert.equal(name.value, value, 'value byte-exact');
  assert.deepEqual(name.events.filter((e) => e === 'input' || e === 'change'), ['input', 'change']);
  assert.equal((page.ctx as { pwned?: number }).pwned, undefined, 'nothing in a selector ran as code');
  assert.match(steps[1].note, /已点击 button#go “开始”/);
  assert.equal(steps[1].action.startsWith('点击 button[data-x='), true);
  assert.equal(steps[4].png?.toString(), 'png-1');
  assert.equal(page.execs, 4, 'wait / screenshot steps do not touch the page');
  const js = stepScript({ op: 'click', sel: evil });
  assert.ok(!js.includes(evil) && !js.includes(String.fromCharCode(0x2028)) && !js.includes('</script>'), 'the selector only appears JSON-escaped');
});

test('the first failed step stops the run (later steps skipped); optional steps may fail and the run continues', async () => {
  const page = new FakePage();
  let clicks = 0;
  page.add('#a', 'BUTTON', { text: 'A' }).on('click', () => clicks++);
  const s1 = await runPreviewSteps(parsed([{ click: '#missing' }, { click: '#a' }, { assertText: 'A' }]), page.io());
  assert.equal(s1[0].ok, false);
  assert.match(s1[0].note, /未找到元素：#missing（已等待 2000ms）/, 'auto-waits up to 2s for the element');
  assert.deepEqual(s1.slice(1).map((s) => [s.skipped, s.note]), [[true, '未执行（第 1 步失败后中止）'], [true, '未执行（第 1 步失败后中止）']]);
  assert.equal(clicks, 0);

  const s2 = await runPreviewSteps(parsed([{ click: '#missing', optional: true, timeoutMs: 300 }, { click: '#a' }]), page.io());
  assert.deepEqual(s2.map((s) => [s.ok, s.optional ?? false, s.skipped ?? false]), [[false, true, false], [true, false, false]]);
  assert.equal(clicks, 1);

  // an invalid selector is not retried; a disabled / covered element is reported as such
  const before = page.execs;
  const s3 = await runPreviewSteps(parsed([{ click: '!!bad' }]), page.io());
  assert.match(s3[0].note, /选择器无效：!!bad/);
  assert.equal(page.execs - before, 1);
  page.add('#off', 'BUTTON', { disabled: true });
  assert.match((await runPreviewSteps(parsed([{ click: '#off', timeoutMs: 0 }]), page.io()))[0].note, /元素已禁用/);
  page.cover = page.add('#overlay', 'DIV', { id: 'overlay' });
  assert.match((await runPreviewSteps(parsed([{ click: '#a', timeoutMs: 0 }]), page.io()))[0].note, /元素被遮挡：#a 上面盖着 div#overlay/);
  assert.equal(clicks, 1, 'a covered element is not clicked');

  // a hung page (script never returns) stops everything, optional or not
  const hung: PreviewIO = { exec: () => new Promise(() => {}), capture: async () => null };
  const s4 = await runPreviewSteps(parsed([{ click: '#a', optional: true }, { click: '#b' }]), hung, { execTimeoutMs: 30 });
  assert.match(s4[0].note, /页面无响应/);
  assert.equal(s4[1].skipped, true);
});

test('assert steps: page text, scoped text, visibility, and waitFor polling until the element shows up', async () => {
  const page = new FakePage();
  page.add('#msg', 'DIV', { text: '保存成功  共 3 条' });
  page.add('#modal', 'DIV', { hidden: true, text: '对话框' });
  const late = page.add('#late', 'DIV', { hidden: true, text: '加载完成' });
  let n = 0;
  page.beforeExec = () => {
    if (++n === 6) late.hidden = false;
  };
  const steps = await runPreviewSteps(
    parsed([{ assertText: '保存成功 共 3 条' }, { assertText: '保存', selector: '#msg' }, { waitFor: '#late' }, { assertVisible: '#modal', optional: true, timeoutMs: 200 }, { assertText: '不存在的文字', timeoutMs: 0 }, { assertText: '对话框', selector: '#msg' }]),
    page.io(),
  );
  assert.deepEqual(steps.map((s) => s.ok), [true, true, true, false, false, false]);
  assert.match(steps[0].note, /找到文本/, 'whitespace-insensitive match');
  assert.match(steps[2].note, /已出现 div “加载完成”/);
  assert.ok(steps[2].ms >= 300, 'waitFor polled');
  assert.match(steps[3].note, /元素不可见：#modal（已等待 200ms）/);
  assert.match(steps[4].note, /未找到文本 “不存在的文字”；当前文本：保存成功 共 3 条 加载完成/, 'failure shows what the page says instead');
  assert.equal(steps[5].skipped, true);
});

test('press / select / check emulate the browser defaults frameworks rely on', async () => {
  const page = new FakePage();
  let submitted = 0;
  const keys: string[] = [];
  const btn = page.add('#send', 'BUTTON', { id: 'send', type: 'submit', text: '发送' }).on('click', () => submitted++);
  const form = { querySelector: () => btn };
  const q = page.add('#q', 'INPUT', { id: 'q', type: 'text', value: 'ab', form }).on('keydown', (e) => keys.push(`${e.key}:${e.keyCode}`));
  const city = page.add('#city', 'SELECT', { id: 'city', options: [{ value: 'bj', text: '北京' }, { value: 'sh', text: '上海' }], selectedIndex: 0 });
  const agree = page.add('#agree', 'INPUT', { id: 'agree', type: 'checkbox' });
  const steps = await runPreviewSteps(
    parsed([
      { press: 'Backspace', selector: '#q' },
      { press: 'c' },
      { press: 'Enter' },
      { press: 'Tab' },
      { select: '#city', value: '上海' },
      { check: '#agree' },
      { check: '#agree' },
      { check: '#agree', checked: false },
      { fill: '#agree', value: 'x', optional: true },
      { select: '#city', value: '广州', timeoutMs: 0 },
    ]),
    page.io(),
  );
  assert.deepEqual(steps.map((s) => s.ok), [true, true, true, true, true, true, true, true, false, false], JSON.stringify(steps.map((s) => s.note)));
  assert.equal(q.value, 'ac', 'Backspace deleted, "c" typed');
  assert.deepEqual(keys, ['Backspace:8', 'c:67', 'Enter:13', 'Tab:9'], 'keydown carries key and keyCode, on the focused field');
  assert.equal(submitted, 1, 'Enter in a form field clicks its submit button');
  assert.match(steps[2].note, /已提交表单/);
  assert.match(steps[3].note, /焦点移到 select#city/);
  assert.equal(city.selectedIndex, 1, 'selected by option text');
  assert.deepEqual(city.events.filter((e) => e === 'input' || e === 'change'), ['input', 'change']);
  assert.match(steps[5].note, /已勾选/);
  assert.match(steps[6].note, /已是勾选状态/);
  assert.equal(agree.checked, false);
  assert.match(steps[8].note, /复选框\/单选框请用 check/);
  assert.match(steps[9].note, /没有选项 “广州”；现有：bj（北京）、sh（上海）/);
  // the page's dialogs never block: stubbed and logged
  vm.runInContext('alert("已保存"); confirm("删除?")', page.ctx);
  assert.deepEqual(page.logs, ['[alert] 已保存', '[confirm] 删除? → 确定']);
});

test('caps: step count, wait length, timeouts, total time budget and per-step screenshots', async () => {
  const many = parsePreviewActions(Array.from({ length: 26 }, () => ({ wait: 1 })));
  assert.equal(many.ok, false);
  assert.match(!many.ok ? many.error : '', /actions 最多 25 步（收到 26 步）/);
  assert.deepEqual(parsed([{ wait: 999999 }, { waitFor: '#x', timeoutMs: 99999 }]), [{ op: 'wait', ms: 5000 }, { op: 'waitFor', sel: '#x', timeoutMs: 15000 }]);

  const page = new FakePage();
  const slow = await runPreviewSteps(parsed(Array.from({ length: 25 }, () => ({ wait: 5000 }))), page.io());
  assert.equal(slow.filter((s) => s.ok).length, 12, '60s budget = 12 × 5s');
  assert.match(slow[12].note, /超出交互总时长上限（60s）/);
  assert.ok(slow.slice(13).every((s) => s.skipped));

  const shots = await runPreviewSteps(parsed(Array.from({ length: 10 }, () => ({ screenshot: true }))), page.io());
  assert.equal(shots.filter((s) => s.png).length, 8);
  assert.ok(shots.every((s) => s.ok));
  assert.match(shots[9].note, /截图已达上限 8 张/);
});

test('argument parsing: normalized steps, and bad steps rejected with clear Chinese messages', () => {
  assert.deepEqual(parsed('[{"click":"#a"}]'), [{ op: 'click', sel: '#a' }], 'a JSON-encoded array is accepted');
  assert.deepEqual(parsed([{ wait_for: '#x', timeout_ms: 800 }]), [{ op: 'waitFor', sel: '#x', timeoutMs: 800 }]);
  assert.deepEqual(parsed([{ press: 'shift+tab' }, { press: 'Space', selector: '#b' }, { press: 'esc' }]), [
    { op: 'press', key: 'Tab', mods: { shift: true } },
    { op: 'press', key: ' ', sel: '#b' },
    { op: 'press', key: 'Escape' },
  ]);
  assert.deepEqual(parsed([{ scroll: 'bottom' }, { scroll: 1200 }, { scroll: '#footer' }, { scroll: 'top' }]), [{ op: 'scroll', bottom: true }, { op: 'scroll', y: 1200 }, { op: 'scroll', sel: '#footer' }, { op: 'scroll', y: 0 }]);
  assert.deepEqual(parsed([{ click: '#a', screenshot: true, optional: true }, { check: '#c', checked: false }, { select: '#s', value: 2 }]), [
    { op: 'click', sel: '#a', shot: true, optional: true },
    { op: 'check', sel: '#c', checked: false },
    { op: 'select', sel: '#s', value: '2' },
  ]);
  const bad: [unknown, RegExp][] = [
    ['not json', /actions 不是合法的 JSON 数组/],
    [{ click: '#a' }, /actions 应为数组/],
    [['#a'], /第 1 步应为对象/],
    [[{}], /第 1 步缺少动作/],
    [[{ click: '#a' }, { hover: '#b' }], /第 2 步含未知字段 hover/],
    [[{ click: '#a', fill: '#b', value: 'x' }], /第 1 步同时写了 click 和 fill：每步只能有一个动作/],
    [[{ click: '' }], /第 1 步：click 需要 CSS 选择器/],
    [[{ click: 'x'.repeat(501) }], /第 1 步：click 过长/],
    [[{ fill: '#a' }], /第 1 步：fill 缺少 value/],
    [[{ press: 'F13' }], /第 1 步：不支持的按键 "F13"；可用 Enter、Tab/],
    [[{ press: 'Hyper+a' }], /不支持的按键/],
    [[{ wait: -1 }], /第 1 步：wait 需要毫秒数/],
    [[{ click: '#a', selector: '#b' }], /click 不需要 selector 字段/],
    [[{ check: '#a', checked: 'yes' }], /checked 应为 true 或 false/],
    [[{ screenshot: false }], /screenshot 应为 true/],
    [JSON.parse('[{"__proto__": {"click": "#x"}}]'), /含未知字段 __proto__/],
  ];
  for (const [raw, re] of bad) {
    const r = parsePreviewActions(raw);
    assert.equal(r.ok, false, JSON.stringify(raw));
    assert.match(r.ok ? '' : r.error, re);
  }
  const vp = parsePreviewPlan({ viewport: { width: 100, height: 99999 }, viewports: [{ width: 375, height: 812 }] });
  assert.ok(vp.ok);
  assert.deepEqual(vp.ok && [vp.viewport, vp.viewports], [{ width: 320, height: 1600 }, [{ width: 375, height: 812 }]]);
  const vbad = parsePreviewPlan({ viewports: Array.from({ length: 4 }, () => ({ width: 375, height: 812 })) });
  assert.match(!vbad.ok ? vbad.error : '', /viewports 最多 3 个（收到 4 个）/);
  const vbad2 = parsePreviewPlan({ viewports: [{ width: 'wide' }] });
  assert.match(!vbad2.ok ? vbad2.error : '', /viewports 第 1 项 需要数字 width 与 height/);
});

test('extra viewports: resized, captured, horizontal overflow noted', async () => {
  let cw = 1280;
  let sw = 1280;
  const sizes: number[][] = [];
  const io: PreviewIO = {
    exec: async () => ({ sw, cw }),
    capture: async () => Buffer.from(`shot-${cw}`),
    resize: (w, h) => {
      sizes.push([w, h]);
      cw = w;
      sw = w === 375 ? 420 : w;
    },
    sleep: async () => {},
  };
  const v = await captureViewports([{ width: 375, height: 812 }, { width: 768, height: 1024 }], io);
  assert.deepEqual(sizes, [[375, 812], [768, 1024]]);
  assert.deepEqual(v.map((x) => [x.width, x.png?.toString(), x.overflowX, x.contentWidth]), [[375, 'shot-375', true, 420], [768, 'shot-768', false, 768]]);
  const none = await captureViewports([{ width: 375, height: 812 }], { exec: async () => null, capture: async () => null });
  assert.match(none[0].note ?? '', /不能调整视口/);
});

test('preview_page tool: bad steps rejected before the browser opens; per-step results, screenshots and failed assertions in the result', async () => {
  const mock = await startMockLlm();
  const rt = makeRuntime(mock.url);
  const ws = tmpDir('edict-ws-');
  fs.writeFileSync(path.join(ws, 'index.html'), '<button id="go">开始</button><p id="out">未开始</p>');
  rt.setWorkspace(ws);
  const calls: PreviewRenderOptions[] = [];
  // desktop host stand-in (MOCK host, not a real browser): the real step runner against the fake page
  rt.opts.previewPage = async (url, o) => {
    calls.push(o);
    const page = new FakePage();
    const out = page.add('#out', 'P', { text: '未开始' });
    page.add('#go', 'BUTTON', { id: 'go', text: '开始' }).on('click', () => (out.text = '已开始'));
    const steps = o.actions ? await runPreviewSteps(o.actions, page.io()) : undefined;
    const viewports = o.viewports?.map((v) => ({ ...v, png: Buffer.from(`vp-${v.width}`), overflowX: v.width < 400, contentWidth: 420 }));
    return { url, ok: true, title: '按钮页', text: page.body.innerText, console: [], failed: [], blocked: [], png: Buffer.from('main'), width: o.width, height: o.height, loadMs: 5, steps, viewports };
  };
  const ctx = { rt, agentId: 'bingbu' as const };

  const bad = await executeTool(ctx, 'preview_page', { path: 'index.html', actions: [{ click: '#go' }, { hover: '#go' }] });
  assert.equal(bad.ok, false);
  assert.match(bad.output, /^preview_page 参数有误：第 2 步含未知字段 hover/);
  const bad2 = await executeTool(ctx, 'preview_page', { path: 'index.html', actions: [{ press: 'F13' }] });
  assert.match(bad2.output, /不支持的按键/);
  assert.equal(calls.length, 0, 'the browser is not opened for bad arguments');

  const good = await executeTool(ctx, 'preview_page', { path: 'index.html', actions: [{ click: '#go', screenshot: true }, { assertText: '已开始' }], viewport: { width: 375, height: 700 }, viewports: [{ width: 1024, height: 768 }, { width: 360, height: 640 }] });
  assert.equal(good.ok, true, good.output);
  assert.match(good.output, /交互检查：通过（2\/2 步成功）/);
  assert.match(good.output, /✓ 1\. 点击 #go — 已点击 button#go “开始”；已截图 \[截图\]/);
  assert.match(good.output, /360×640：已截图；⚠ 出现横向滚动/);
  assert.match(good.output, /可见文本（操作后，节选）：\n已开始/);
  assert.deepEqual([calls[0].width, calls[0].height, calls[0].actions, calls[0].viewports], [375, 700, [{ op: 'click', sel: '#go', shot: true }, { op: 'assertText', text: '已开始' }], [{ width: 1024, height: 768 }, { width: 360, height: 640 }]]);
  const act = rt.activities().filter((a) => a.kind === 'preview').pop()!;
  assert.match(act.content, /交互 2\/2 步通过 · 另截 2 种尺寸/);
  const data = act.data as unknown as PreviewResult;
  assert.equal(rt.blobs.get(data.steps![0].screenshot!)?.toString(), 'png-1', 'step screenshot stored as a blob');
  assert.equal(rt.blobs.get(data.viewports![1].screenshot!)?.toString(), 'vp-360');
  assert.equal(rt.blobs.get(data.screenshot!)?.toString(), 'main');
  assert.equal((data as unknown as { png?: unknown }).png, undefined);

  const failing = await executeTool(ctx, 'preview_page', { path: 'index.html', actions: [{ click: '#go' }, { assertText: '已完成', timeoutMs: 0 }, { click: '#go' }] });
  assert.equal(failing.ok, false, 'a failed assertion fails the call');
  assert.match(failing.output, /交互检查：未通过（1\/3 步成功；第 2 步「断言文本 “已完成”」失败，后续步骤未执行）/);
  assert.match(failing.output, /✗ 2\. 断言文本 “已完成” — 未找到文本 “已完成”；当前文本：已开始/);
  assert.match(failing.output, /· 3\. 点击 #go — 未执行（第 2 步失败后中止）/);
  const audit = fs.readFileSync(path.join(rt.opts.dataDir, 'audit.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((e) => e.action === 'preview_page').pop();
  assert.deepEqual([audit?.detail?.steps, audit?.detail?.stepsFailed], [3, 2]);
  rt.dispose();
  await mock.close();
});

test('checkEvidence still counts preview_page calls and shows how many did not pass', () => {
  const dir = tmpDir('edict-ev-');
  const ws = { readBuffer: (p: string) => (fs.existsSync(path.join(dir, p)) ? fs.readFileSync(path.join(dir, p)) : null) } as never;
  const task = { changes: [] } as unknown as Task;
  const node = { id: 'n1', kind: 'exec', effect: 'verify' } as RunNode;
  const done = { status: 'done' as const, summary: 's', artifacts: [], verification: 'v', issues: [] };
  const r = checkEvidence(task, node, done, { preview_page: 2, 'preview_page:failed': 1 }, ws);
  assert.equal(r.conclusion.status, 'done', 'a verify node that previewed has evidence');
  assert.ok(r.systemCheck.includes('本节点执行命令 0 次、预览页面 2 次（其中 1 次未通过）'), r.systemCheck.join(' | '));
  assert.ok(checkEvidence(task, node, done, { preview_page: 1 }, ws).systemCheck.includes('本节点执行命令 0 次、预览页面 1 次'));
});
