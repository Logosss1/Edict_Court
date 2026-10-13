// Interactive checks for the agent tool `preview_page`: parse the `actions` / `viewports` arguments, and run
// the steps against a page through two injected functions — exec(js) (Electron: webContents.executeJavaScript
// in the hidden preview window) and capture() (capturePage → PNG). No Electron import here, so node tests can
// drive the runner with a fake page. Selectors and values only ever reach the page as JSON data.
import type { PreviewResult, PreviewStepResult, PreviewViewportResult } from '../../shared/types';

export const PREVIEW_LIMITS = {
  steps: 25,
  /** whole action run, from the first step to the last */
  totalMs: 60_000,
  /** one {wait} step */
  waitMs: 5_000,
  /** {timeoutMs} on any element step */
  timeoutMs: 15_000,
  /** default for {waitFor} */
  waitForMs: 5_000,
  /** default auto-wait for click / fill / assert … when the element is not there yet */
  autoWaitMs: 2_000,
  pollMs: 100,
  /** pause after a step that changes the page, so async renders land before the next step / screenshot */
  settleMs: 60,
  /** a page script that does not return in this time is treated as a hung page */
  execTimeoutMs: 10_000,
  captureTimeoutMs: 8_000,
  /** per-step screenshots */
  shots: 8,
  viewports: 3,
  resizeSettleMs: 400,
  selector: 500,
  value: 5_000,
  text: 500,
} as const;

export type PreviewOp = 'click' | 'fill' | 'press' | 'wait' | 'waitFor' | 'select' | 'check' | 'scroll' | 'screenshot' | 'assertText' | 'assertVisible';

/** One normalized step (what the parser produces and the page script receives as JSON). */
export interface PreviewAction {
  op: PreviewOp;
  sel?: string;
  value?: string;
  key?: string;
  mods?: { shift?: boolean; ctrl?: boolean; alt?: boolean; meta?: boolean };
  ms?: number;
  checked?: boolean;
  y?: number;
  bottom?: boolean;
  text?: string;
  timeoutMs?: number;
  optional?: boolean;
  /** capture a screenshot after this step */
  shot?: boolean;
}

export interface PreviewViewport {
  width: number;
  height: number;
}

export interface PreviewRenderOptions {
  waitMs: number;
  width: number;
  height: number;
  actions?: PreviewAction[];
  viewports?: PreviewViewport[];
}

type WithPng<T> = Omit<T, 'screenshot'> & { png?: Buffer };
export type PreviewHostStep = WithPng<PreviewStepResult>;
export type PreviewHostViewport = WithPng<PreviewViewportResult>;
/** What the desktop host returns: PNGs as buffers (the caller stores them as blobs). */
export type PreviewHostResult = Omit<PreviewResult, 'screenshot' | 'steps' | 'viewports'> & { png?: Buffer; steps?: PreviewHostStep[]; viewports?: PreviewHostViewport[] };

export interface PreviewIO {
  exec(js: string): Promise<unknown>;
  capture(): Promise<Buffer | null | undefined>;
  resize?(width: number, height: number): Promise<void> | void;
  sleep?(ms: number): Promise<void>;
  now?(): number;
  /** called with the 1-based index before each step (console lines are attributed to it) */
  onStep?(index: number): void;
}

// ───────────────────────── argument parsing ─────────────────────────

const OPS: PreviewOp[] = ['click', 'fill', 'press', 'wait', 'waitFor', 'select', 'check', 'scroll', 'screenshot', 'assertText', 'assertVisible'];
const OPS_HINT = 'click、fill、press、wait、waitFor、select、check、scroll、screenshot、assertText、assertVisible';
const ALIAS: Record<string, string> = { wait_for: 'waitFor', timeout_ms: 'timeoutMs', assert_text: 'assertText', assert_visible: 'assertVisible' };
/** extra fields and the ops they belong to (screenshot / optional / timeoutMs go with any step) */
const EXTRA: Record<string, PreviewOp[] | 'any'> = { value: ['fill', 'select'], selector: ['press', 'assertText'], checked: ['check'], timeoutMs: 'any', optional: 'any', screenshot: 'any' };
const KEYS: Record<string, string> = {
  enter: 'Enter', return: 'Enter', tab: 'Tab', escape: 'Escape', esc: 'Escape', space: ' ', spacebar: ' ', backspace: 'Backspace', delete: 'Delete', del: 'Delete',
  arrowup: 'ArrowUp', up: 'ArrowUp', arrowdown: 'ArrowDown', down: 'ArrowDown', arrowleft: 'ArrowLeft', left: 'ArrowLeft', arrowright: 'ArrowRight', right: 'ArrowRight',
  home: 'Home', end: 'End', pageup: 'PageUp', pagedown: 'PageDown',
};
const MODS: Record<string, 'shift' | 'ctrl' | 'alt' | 'meta'> = { shift: 'shift', control: 'ctrl', ctrl: 'ctrl', alt: 'alt', option: 'alt', meta: 'meta', cmd: 'meta', command: 'meta' };
const own = <T>(o: Record<string, T>, k: string): T | undefined => (Object.hasOwn(o, k) ? o[k] : undefined);
const KEY_HINT = '可用 Enter、Tab、Escape、Space、Backspace、Delete、ArrowUp/Down/Left/Right、Home、End、PageUp、PageDown 或单个字符，可加 Shift+ / Ctrl+ / Alt+ / Meta+ 前缀';

export function parseKey(raw: string): { key: string; mods: NonNullable<PreviewAction['mods']> } | null {
  const s = raw.trim() || (raw === ' ' ? ' ' : '');
  if (!s) return null;
  const parts = s.length > 1 && s.endsWith('++') ? [...s.slice(0, -2).split('+'), '+'] : s.length > 1 ? s.split('+') : [s];
  const last = parts.pop()!;
  const mods: NonNullable<PreviewAction['mods']> = {};
  for (const p of parts) {
    const m = own(MODS, p.trim().toLowerCase());
    if (!m) return null;
    mods[m] = true;
  }
  const key = [...last].length === 1 ? last : own(KEYS, last.trim().toLowerCase());
  return key ? { key, mods } : null;
}

const keyLabel = (a: PreviewAction) => [a.mods?.ctrl && 'Ctrl', a.mods?.alt && 'Alt', a.mods?.shift && 'Shift', a.mods?.meta && 'Meta', a.key === ' ' ? 'Space' : a.key].filter(Boolean).join('+');

const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

function parseStep(raw: unknown, n: number): PreviewAction | string {
  const at = `第 ${n} 步`;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return `${at}应为对象，如 {"click": "#submit"}`;
  const src: Record<string, unknown> = Object.create(null);
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) src[own(ALIAS, k) ?? k] = v;
  const unknown = Object.keys(src).filter((k) => !OPS.includes(k as PreviewOp) && !Object.hasOwn(EXTRA, k));
  if (unknown.length) return `${at}含未知字段 ${unknown.join('、')}；可用动作：${OPS_HINT}`;
  const ops = OPS.filter((o) => o in src && o !== 'screenshot');
  if (ops.length > 1) return `${at}同时写了 ${ops.join(' 和 ')}：每步只能有一个动作，请拆成多步`;
  const op: PreviewOp | undefined = ops[0] ?? ('screenshot' in src ? 'screenshot' : undefined);
  if (!op) return `${at}缺少动作；可用动作：${OPS_HINT}`;
  for (const k of Object.keys(src)) {
    const allow = own(EXTRA, k);
    if (allow && allow !== 'any' && !allow.includes(op)) return `${at}：${op} 不需要 ${k} 字段${k === 'selector' ? `（选择器直接写在 ${op} 里，如 {"${op}": "#id"}）` : ''}`;
  }
  const a: PreviewAction = { op };
  const str = (k: string, max: number, what: string): string | null => {
    const v = typeof src[k] === 'number' ? String(src[k]) : src[k];
    if (typeof v !== 'string' || !v.trim()) return `${at}：${k} 需要${what}（非空字符串）`;
    if (v.length > max) return `${at}：${k} 过长（最多 ${max} 字符）`;
    return null;
  };
  const selOf = (k: string): string | null => {
    const e = str(k, PREVIEW_LIMITS.selector, ' CSS 选择器');
    if (e) return e;
    a.sel = String(src[k]).trim();
    return null;
  };
  let err: string | null = null;
  switch (op) {
    case 'click':
    case 'waitFor':
    case 'check':
    case 'assertVisible':
      err = selOf(op);
      if (!err && op === 'check' && src.checked !== undefined) {
        if (typeof src.checked !== 'boolean') err = `${at}：checked 应为 true 或 false`;
        else a.checked = src.checked;
      }
      break;
    case 'fill':
    case 'select': {
      err = selOf(op);
      if (err) break;
      const v = typeof src.value === 'number' || typeof src.value === 'boolean' ? String(src.value) : src.value;
      if (typeof v !== 'string') err = `${at}：${op} 缺少 value（要${op === 'fill' ? '填入的文字' : '选择的选项值或文字'}）`;
      else if (v.length > (op === 'fill' ? PREVIEW_LIMITS.value : PREVIEW_LIMITS.selector)) err = `${at}：value 过长`;
      else a.value = v;
      break;
    }
    case 'press': {
      const k = parseKey(typeof src.press === 'string' ? src.press : '');
      if (!k) err = `${at}：不支持的按键 ${JSON.stringify(src.press ?? '')}；${KEY_HINT}`;
      else {
        a.key = k.key;
        if (Object.keys(k.mods).length) a.mods = k.mods;
        if (src.selector !== undefined) err = selOf('selector');
      }
      break;
    }
    case 'wait': {
      const ms = num(src.wait);
      if (ms === null || ms < 0) err = `${at}：wait 需要毫秒数（0–${PREVIEW_LIMITS.waitMs}）`;
      else a.ms = Math.min(PREVIEW_LIMITS.waitMs, Math.round(ms));
      break;
    }
    case 'scroll': {
      const v = src.scroll;
      const y = num(v);
      if (y !== null) a.y = Math.max(0, Math.round(y));
      else if (typeof v === 'string' && /^(top|bottom)$/i.test(v.trim())) {
        if (v.trim().toLowerCase() === 'top') a.y = 0;
        else a.bottom = true;
      } else err = selOf('scroll');
      break;
    }
    case 'screenshot':
      if (src.screenshot !== true) err = `${at}：screenshot 应为 true`;
      break;
    case 'assertText': {
      err = str('assertText', PREVIEW_LIMITS.text, '要查找的文本');
      if (!err) a.text = String(src.assertText);
      if (!err && src.selector !== undefined) err = selOf('selector');
      break;
    }
  }
  if (err) return err;
  if (src.timeoutMs !== undefined) {
    const t = num(src.timeoutMs);
    if (t === null || t < 0) return `${at}：timeoutMs 应为毫秒数`;
    a.timeoutMs = Math.min(PREVIEW_LIMITS.timeoutMs, Math.round(t));
  }
  if (src.optional !== undefined) {
    if (typeof src.optional !== 'boolean') return `${at}：optional 应为 true 或 false`;
    if (src.optional) a.optional = true;
  }
  if (op !== 'screenshot' && src.screenshot !== undefined) {
    if (typeof src.screenshot !== 'boolean') return `${at}：screenshot 应为 true 或 false`;
    if (src.screenshot) a.shot = true;
  }
  return a;
}

/** Arrays sometimes arrive JSON-encoded as a string. */
function asArray(raw: unknown, name: string): unknown[] | string | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  let v = raw;
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v);
    } catch {
      return `${name} 不是合法的 JSON 数组`;
    }
  }
  return Array.isArray(v) ? v : `${name} 应为数组`;
}

export function parsePreviewActions(raw: unknown): { ok: true; actions: PreviewAction[] } | { ok: false; error: string } {
  const arr = asArray(raw, 'actions');
  if (arr === undefined) return { ok: true, actions: [] };
  if (typeof arr === 'string') return { ok: false, error: `${arr}，如 [{"click": "#start"}, {"assertText": "已开始"}]` };
  if (arr.length > PREVIEW_LIMITS.steps) return { ok: false, error: `actions 最多 ${PREVIEW_LIMITS.steps} 步（收到 ${arr.length} 步），请拆成几次 preview_page 调用` };
  const actions: PreviewAction[] = [];
  for (let i = 0; i < arr.length; i++) {
    const s = parseStep(arr[i], i + 1);
    if (typeof s === 'string') return { ok: false, error: s };
    actions.push(s);
  }
  return { ok: true, actions };
}

const clampVp = (w: number, h: number): PreviewViewport => ({ width: Math.min(2560, Math.max(320, Math.round(w))), height: Math.min(1600, Math.max(320, Math.round(h))) });

function parseViewport(raw: unknown, name: string): PreviewViewport | string {
  let v = raw;
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v);
    } catch {
      /* fall through */
    }
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return `${name} 应为 {"width": 375, "height": 812}`;
  const w = num((v as Record<string, unknown>).width);
  const h = num((v as Record<string, unknown>).height);
  if (w === null || h === null) return `${name} 需要数字 width 与 height`;
  return clampVp(w, h);
}

/** `actions`, `viewport` and `viewports` of a preview_page call (or of previewCapture). */
export function parsePreviewPlan(args: { actions?: unknown; viewport?: unknown; viewports?: unknown }): { ok: true; actions: PreviewAction[]; viewport?: PreviewViewport; viewports: PreviewViewport[] } | { ok: false; error: string } {
  const acts = parsePreviewActions(args.actions);
  if (!acts.ok) return acts;
  let viewport: PreviewViewport | undefined;
  if (args.viewport !== undefined && args.viewport !== null && args.viewport !== '') {
    const v = parseViewport(args.viewport, 'viewport');
    if (typeof v === 'string') return { ok: false, error: v };
    viewport = v;
  }
  const arr = asArray(args.viewports, 'viewports');
  if (typeof arr === 'string') return { ok: false, error: `${arr}，如 [{"width": 375, "height": 812}]` };
  if (arr && arr.length > PREVIEW_LIMITS.viewports) return { ok: false, error: `viewports 最多 ${PREVIEW_LIMITS.viewports} 个（收到 ${arr.length} 个）` };
  const viewports: PreviewViewport[] = [];
  for (let i = 0; i < (arr?.length ?? 0); i++) {
    const v = parseViewport(arr![i], `viewports 第 ${i + 1} 项`);
    if (typeof v === 'string') return { ok: false, error: v };
    viewports.push(v);
  }
  return { ok: true, actions: acts.actions, viewport, viewports };
}

const quote = (s: string, n = 40) => `“${s.length > n ? s.slice(0, n) + '…' : s}”`;
const short = (s: string | undefined, n = 80) => (!s ? '' : s.length > n ? s.slice(0, n) + '…' : s);

/** Short Chinese label of a step, for results and the activity stream. */
export function describeAction(a: PreviewAction): string {
  switch (a.op) {
    case 'click':
      return `点击 ${short(a.sel)}`;
    case 'fill':
      return `填写 ${short(a.sel)} ← ${quote(a.value ?? '')}`;
    case 'press':
      return `按键 ${keyLabel(a)}${a.sel ? `（${short(a.sel)}）` : ''}`;
    case 'wait':
      return `等待 ${a.ms}ms`;
    case 'waitFor':
      return `等待出现 ${short(a.sel)}`;
    case 'select':
      return `选择 ${short(a.sel)} = ${quote(a.value ?? '')}`;
    case 'check':
      return `${a.checked === false ? '取消勾选' : '勾选'} ${short(a.sel)}`;
    case 'scroll':
      return a.sel ? `滚动到 ${short(a.sel)}` : a.bottom ? '滚动到底部' : `滚动到 y=${a.y ?? 0}`;
    case 'screenshot':
      return '截图';
    case 'assertText':
      return `断言文本 ${quote(a.text ?? '')}${a.sel ? `（${short(a.sel)} 内）` : ''}`;
    case 'assertVisible':
      return `断言可见 ${short(a.sel)}`;
  }
}

// ───────────────────────── the page side ─────────────────────────

/**
 * Runs inside the previewed page (main world) with one step as its only argument, and resolves to
 * { ok, note, retry }. retry = the precondition is not met yet (element missing / hidden / disabled /
 * text not there) and nothing was done, so the runner may poll again. Synthetic events cannot trigger
 * browser default actions, so Enter / Tab / Space / Backspace / arrows emulate the common ones.
 * Plain ES2017 in a raw string: it must not depend on anything the bundler would inject.
 */
const PAGE_STEP = String.raw`async function (a) {
  var w = window, d = document;
  if (!w.__edictDialogs) {
    w.__edictDialogs = true;
    try {
      w.alert = function (m) { console.info('[alert] ' + m); };
      w.confirm = function (m) { console.info('[confirm] ' + m + ' → 确定'); return true; };
      w.prompt = function (m, v) { console.info('[prompt] ' + m); return v == null ? '' : String(v); };
    } catch (e) {}
  }
  var R = function (ok, note, retry) { return { ok: ok, note: String(note).slice(0, 400), retry: !!retry }; };
  var norm = function (s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); };
  var cut = function (s, n) { s = norm(s); return s.length > n ? s.slice(0, n) + '…' : s; };
  var name = function (el) {
    if (!el || !el.tagName) return String(el);
    var s = el.tagName.toLowerCase() + (el.id ? '#' + el.id : '');
    var at = function (n) { return el.getAttribute ? el.getAttribute(n) : ''; };
    var field = /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
    var lab = field && el.labels && el.labels[0] ? el.labels[0].innerText : '';
    var t = cut(field ? lab || at('aria-label') || at('placeholder') || (/^(button|submit|reset)$/i.test(el.type || '') ? el.value : '') : el.innerText || at('aria-label') || '', 30);
    return t ? s + ' “' + t + '”' : s;
  };
  var shown = function (el) {
    if (!el.getClientRects().length) return false;
    var r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && w.getComputedStyle(el).visibility !== 'hidden';
  };
  var find = function (sel, vis) {
    var el;
    try { el = d.querySelector(sel); } catch (e) { return { err: R(false, '选择器无效：' + sel) }; }
    if (!el) return { err: R(false, '未找到元素：' + sel, true) };
    if (vis && !shown(el)) return { err: R(false, '元素不可见：' + sel, true) };
    return { el: el };
  };
  var fire = function (el, type, C, init) {
    var E = w[C] || w.Event;
    return el.dispatchEvent(new E(type, Object.assign({ bubbles: true, cancelable: true, composed: true }, init || {})));
  };
  var input = function (el, data, kind) { fire(el, 'input', 'InputEvent', { cancelable: false, inputType: kind || 'insertText', data: data == null ? null : String(data) }); };
  var change = function (el) { fire(el, 'change', 'Event', { cancelable: false }); };
  var setVal = function (el, v) {
    var C = el.tagName === 'TEXTAREA' ? w.HTMLTextAreaElement : el.tagName === 'SELECT' ? w.HTMLSelectElement : w.HTMLInputElement;
    var pd = C && Object.getOwnPropertyDescriptor(C.prototype, 'value');
    if (pd && pd.set) pd.set.call(el, v); else el.value = v;
  };
  var typeable = function (el) { return el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && !/^(checkbox|radio|button|submit|reset|file|image|range|color|hidden)$/i.test(el.type || '')); };
  var tick = function () { return new Promise(function (r) { setTimeout(r, 20); }); };
  var el, f, lb;
  try {
    switch (a.op) {
      case 'click': {
        f = find(a.sel, true); if (f.err) return f.err; el = f.el; lb = name(el);
        if (el.disabled) return R(false, '元素已禁用：' + lb, true);
        if (el.scrollIntoView) el.scrollIntoView({ block: 'center', inline: 'center' });
        var r = el.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2;
        var hit = d.elementFromPoint ? d.elementFromPoint(x, y) : null;
        if (hit && hit !== el && !el.contains(hit)) return R(false, '元素被遮挡：' + a.sel + ' 上面盖着 ' + name(hit), true);
        var m = { clientX: x, clientY: y, button: 0, buttons: 1, detail: 1, view: w };
        var up = Object.assign({}, m, { buttons: 0 });
        fire(el, 'pointerdown', 'PointerEvent', Object.assign({ pointerType: 'mouse', isPrimary: true }, m));
        fire(el, 'mousedown', 'MouseEvent', m);
        if (el.focus) el.focus();
        fire(el, 'pointerup', 'PointerEvent', Object.assign({ pointerType: 'mouse', isPrimary: true }, up));
        fire(el, 'mouseup', 'MouseEvent', up);
        fire(el, 'click', 'MouseEvent', up);
        return R(true, '已点击 ' + lb);
      }
      case 'fill': {
        f = find(a.sel, true); if (f.err) return f.err; el = f.el; lb = name(el);
        var ft = String(el.type || '');
        if (el.disabled) return R(false, '输入框已禁用：' + lb, true);
        if (el.readOnly) return R(false, '输入框只读：' + lb);
        if (el.tagName === 'SELECT') return R(false, '这是下拉框，请用 select：' + a.sel);
        if (el.tagName === 'INPUT' && /^(checkbox|radio)$/i.test(ft)) return R(false, '复选框/单选框请用 check：' + a.sel);
        if (el.tagName === 'INPUT' && /^(file|submit|button|reset|image|hidden)$/i.test(ft)) return R(false, '该输入框无法填写（type=' + ft + '）：' + a.sel);
        if (el.focus) el.focus();
        if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
          setVal(el, a.value); input(el, a.value); change(el);
          var got = String(el.value);
          return R(true, '已填写 ' + lb + ' ← “' + cut(a.value, 60) + '”' + (got !== a.value ? '（页面实际值为 “' + cut(got, 60) + '”）' : ''));
        }
        if (el.isContentEditable) { el.textContent = a.value; input(el, a.value); return R(true, '已填写 ' + lb + ' ← “' + cut(a.value, 60) + '”'); }
        return R(false, '不是输入框：' + lb);
      }
      case 'press': {
        if (a.sel) { f = find(a.sel, true); if (f.err) return f.err; if (f.el.focus) f.el.focus(); }
        el = d.activeElement || d.body;
        var k = a.key, md = a.mods || {};
        var KC = { Enter: 13, Tab: 9, Escape: 27, ' ': 32, Backspace: 8, Delete: 46, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Home: 36, End: 35, PageUp: 33, PageDown: 34 };
        var kc = KC[k] || (k.length === 1 ? k.toUpperCase().charCodeAt(0) : 0);
        var code = k === ' ' ? 'Space' : KC[k] ? k : /^[a-z]$/i.test(k) ? 'Key' + k.toUpperCase() : /^[0-9]$/.test(k) ? 'Digit' + k : '';
        var combo = [md.ctrl && 'Ctrl', md.alt && 'Alt', md.shift && 'Shift', md.meta && 'Meta', k === ' ' ? 'Space' : k].filter(Boolean).join('+');
        var key = function (type, t) {
          var e = new (w.KeyboardEvent || w.Event)(type, { key: k, code: code, bubbles: true, cancelable: true, composed: true, shiftKey: !!md.shift, ctrlKey: !!md.ctrl, altKey: !!md.alt, metaKey: !!md.meta });
          try {
            Object.defineProperty(e, 'keyCode', { get: function () { return kc; } });
            Object.defineProperty(e, 'which', { get: function () { return kc; } });
          } catch (x) {}
          return t.dispatchEvent(e);
        };
        lb = name(el);
        var plain = !md.ctrl && !md.meta && !md.alt, did = '', act = null;
        var btn = el.tagName === 'BUTTON' || el.tagName === 'SUMMARY' || (el.tagName === 'INPUT' && /^(button|submit|reset|image)$/i.test(el.type || ''));
        var go = key('keydown', el);
        if (go && plain) {
          if (k.length === 1) {
            if (key('keypress', el)) {
              if (typeable(el)) { setVal(el, el.value + k); input(el, k); did = '，已输入'; }
              else if (el.isContentEditable) { el.textContent += k; input(el, k); did = '，已输入'; }
              else if (k === ' ' && (btn || (el.tagName === 'INPUT' && /^(checkbox|radio)$/i.test(el.type || '')))) act = el;
              else if (k === ' ' && (el === d.body || el === d.documentElement)) { w.scrollBy(0, w.innerHeight * 0.9); did = '，页面下翻'; }
            }
          } else if (k === 'Enter') {
            if (key('keypress', el)) {
              if (el.tagName === 'TEXTAREA') { setVal(el, el.value + '\n'); input(el, '\n', 'insertLineBreak'); did = '，已换行'; }
              else if (btn || (el.tagName === 'A' && el.href)) act = el;
              else if (typeable(el) && el.form) {
                var sb = el.form.querySelector('button[type=submit],button:not([type]),input[type=submit],input[type=image]');
                if (sb && !sb.disabled) { sb.click(); did = '，已提交表单（' + name(sb) + '）'; }
                else if (el.form.requestSubmit) { el.form.requestSubmit(); did = '，已提交表单'; }
              }
            }
          } else if (k === 'Tab') {
            var list = Array.prototype.filter.call(d.querySelectorAll('a[href],button,input,select,textarea,summary,iframe,[tabindex],[contenteditable]'), function (n) { return !n.disabled && n.tabIndex >= 0 && n.type !== 'hidden' && shown(n); });
            if (list.length) {
              var i = list.indexOf(el), nx = md.shift ? list[i <= 0 ? list.length - 1 : i - 1] : list[(i + 1) % list.length];
              nx.focus(); did = '，焦点移到 ' + name(nx);
            }
          } else if (k === 'Backspace' && typeable(el)) {
            if (el.value) { setVal(el, el.value.slice(0, -1)); input(el, null, 'deleteContentBackward'); did = '，已删除一个字符'; }
          } else if ((k === 'ArrowDown' || k === 'ArrowUp') && el.tagName === 'SELECT') {
            var si = el.selectedIndex + (k === 'ArrowDown' ? 1 : -1);
            if (si >= 0 && si < el.options.length) { el.selectedIndex = si; input(el); change(el); did = '，已选中 “' + cut(el.options[si].text, 30) + '”'; }
          } else if (el === d.body || el === d.documentElement) {
            var dy = { ArrowDown: 40, ArrowUp: -40, PageDown: w.innerHeight * 0.9, PageUp: -w.innerHeight * 0.9 }[k];
            if (dy) { w.scrollBy(0, dy); did = '，页面滚动'; }
            else if (k === 'Home') { w.scrollTo(0, 0); did = '，滚到顶部'; }
            else if (k === 'End') { w.scrollTo(0, d.documentElement.scrollHeight); did = '，滚到底部'; }
          }
        }
        key('keyup', d.activeElement || el);
        if (act) { act.click(); did = '，已触发点击'; }
        return R(true, '已按 ' + combo + '（' + lb + '）' + (go ? did : '，页面拦截了默认行为'));
      }
      case 'select': {
        f = find(a.sel, true); if (f.err) return f.err; el = f.el; lb = name(el);
        if (el.tagName !== 'SELECT') return R(false, '不是下拉框 <select>：' + lb + '（自定义下拉请用 click 依次点开、点选）');
        if (el.disabled) return R(false, '下拉框已禁用：' + lb, true);
        var opts = Array.prototype.slice.call(el.options);
        var o = opts.filter(function (x) { return x.value === a.value; })[0] || opts.filter(function (x) { return norm(x.label || x.text) === norm(a.value); })[0];
        if (!o) return R(false, '下拉框 ' + lb + ' 没有选项 “' + cut(a.value, 40) + '”；现有：' + (opts.slice(0, 12).map(function (x) { return x.value === norm(x.text) ? x.value : x.value + '（' + cut(x.text, 20) + '）'; }).join('、') || '（无）'), true);
        if (o.disabled) return R(false, '该选项已禁用：' + cut(o.text, 40));
        el.selectedIndex = opts.indexOf(o); input(el); change(el);
        return R(true, '已选择 “' + cut(o.text || o.value, 40) + '”（' + lb + '）');
      }
      case 'check': {
        f = find(a.sel, false); if (f.err) return f.err; el = f.el; lb = name(el);
        var want = a.checked !== false, ctl = el;
        var box = function (n) { return n && n.tagName === 'INPUT' && /^(checkbox|radio)$/i.test(n.type || ''); };
        if (!box(ctl) && el.tagName === 'LABEL' && box(el.control)) ctl = el.control;
        var aria = !box(ctl) && el.getAttribute && el.getAttribute('aria-checked') !== null;
        if (!box(ctl) && !aria) return R(false, '不是复选框/单选框：' + lb);
        var st = function () { return aria ? ctl.getAttribute('aria-checked') === 'true' : !!ctl.checked; };
        if (st() === want) return R(true, (want ? '已是勾选状态：' : '已是未勾选状态：') + lb);
        if (!aria && !want && /^radio$/i.test(ctl.type)) return R(false, '单选框不能直接取消，请改为勾选同组的另一个选项');
        if (ctl.disabled || (aria && el.getAttribute('aria-disabled') === 'true')) return R(false, '复选框已禁用：' + lb, true);
        el.click();
        await tick();
        if (st() !== want) return R(false, '点击后状态没有变化（页面阻止了切换？）：' + lb);
        return R(true, (want ? '已勾选 ' : '已取消勾选 ') + lb);
      }
      case 'scroll': {
        if (a.sel) {
          f = find(a.sel, false); if (f.err) return f.err;
          f.el.scrollIntoView({ block: 'center' });
          return R(true, '已滚动到 ' + name(f.el) + '（y=' + Math.round(w.scrollY) + '）');
        }
        var de = d.documentElement;
        w.scrollTo(0, a.bottom ? de.scrollHeight : a.y || 0);
        return R(true, '已滚动到 y=' + Math.round(w.scrollY) + '（页面高 ' + Math.round(de.scrollHeight) + '）');
      }
      case 'waitFor':
      case 'assertVisible':
        f = find(a.sel, true); if (f.err) return f.err;
        return R(true, (a.op === 'waitFor' ? '已出现 ' : '可见：') + name(f.el));
      case 'assertText': {
        var root = d.body;
        if (a.sel) { f = find(a.sel, false); if (f.err) return f.err; root = f.el; }
        var txt = !root ? '' : /^(INPUT|TEXTAREA|SELECT)$/.test(root.tagName) ? root.value : (root.innerText || root.textContent || '');
        if (String(txt).indexOf(a.text) >= 0 || norm(txt).indexOf(norm(a.text)) >= 0) return R(true, '找到文本 “' + cut(a.text, 60) + '”');
        return R(false, '未找到文本 “' + cut(a.text, 60) + '”' + (a.sel ? '（在 ' + a.sel + ' 内）' : '') + '；当前文本：' + (cut(txt, 160) || '（空）'), true);
      }
      default:
        return R(false, '未知动作：' + a.op);
    }
  } catch (e) {
    return R(false, '执行出错：' + (e && e.message ? e.message : e));
  }
}`;

/** JSON is valid JS; also escape U+2028/2029 and '<' so no string content can end up as code. */
const jsonArg = (v: unknown) => JSON.stringify(v).replace(/[\u2028\u2029<]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);

/** The script for one step: a fixed function applied to the step as JSON data. */
export function stepScript(a: PreviewAction): string {
  const { op, sel, value, key, mods, checked, y, bottom, text } = a;
  return `(${PAGE_STEP})(${jsonArg({ op, sel, value, key, mods, checked, y, bottom, text })})`;
}

const METRICS_JS = `(function(){var e=document.documentElement;return e?{sw:e.scrollWidth,cw:e.clientWidth}:null})()`;

// ───────────────────────── the runner ─────────────────────────

export class PreviewTimeout extends Error {}

export function withTimeout<T>(p: Promise<T>, ms: number, msg = '超时'): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p,
    new Promise<never>((_, rej) => {
      timer = setTimeout(() => rej(new PreviewTimeout(msg)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

const MUTATING = new Set<PreviewOp>(['click', 'fill', 'press', 'select', 'check', 'scroll']);

interface Reply {
  ok: boolean;
  note: string;
  retry?: boolean;
  fatal?: boolean;
}

function asReply(v: unknown): Reply {
  if (v && typeof v === 'object' && typeof (v as Reply).ok === 'boolean') {
    const r = v as Reply;
    return { ok: r.ok, note: String(r.note ?? '').slice(0, 400), retry: !!r.retry };
  }
  return { ok: false, note: '页面脚本返回了意外结果（页面可能改写了内置对象）' };
}

const msgOf = (e: unknown) => String((e as Error)?.message ?? e).slice(0, 200);

/** Steps that cannot run (page failed to load …), all reported as skipped. */
export function skippedSteps(actions: PreviewAction[], note: string): PreviewHostStep[] {
  return actions.map((a, i) => ({ index: i + 1, action: describeAction(a), ok: false, skipped: true, note, ms: 0, ...(a.optional ? { optional: true } : {}) }));
}

/**
 * Run the steps in order. Element steps poll until their precondition holds (auto-wait, capped by the
 * step's timeoutMs and the overall budget); the first failed step stops the run unless it is optional;
 * a hung page or an exhausted budget stops it regardless. Every step gets a result (later ones skipped).
 */
export async function runPreviewSteps(actions: PreviewAction[], io: PreviewIO, o: { totalMs?: number; execTimeoutMs?: number } = {}): Promise<PreviewHostStep[]> {
  const sleep = io.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = io.now ?? Date.now;
  const execTimeout = o.execTimeoutMs ?? PREVIEW_LIMITS.execTimeoutMs;
  const end = now() + Math.min(o.totalMs ?? PREVIEW_LIMITS.totalMs, PREVIEW_LIMITS.totalMs);
  const out: PreviewHostStep[] = [];
  let stopped: string | null = null;
  let shots = 0;

  const attempt = async (a: PreviewAction, deadline: number): Promise<Reply> => {
    const js = stepScript(a);
    const t0 = now();
    for (;;) {
      let r: Reply;
      try {
        r = asReply(await withTimeout(io.exec(js), execTimeout));
      } catch (e) {
        if (e instanceof PreviewTimeout) return { ok: false, note: `页面无响应：脚本 ${Math.round(execTimeout / 1000)}s 未返回（页面可能卡死）`, fatal: true };
        r = { ok: false, note: `页面脚本执行失败：${msgOf(e)}`, retry: true }; // e.g. mid-navigation
      }
      if (r.ok || !r.retry) return r;
      if (now() + PREVIEW_LIMITS.pollMs > deadline) return now() > t0 ? { ...r, note: `${r.note}（已等待 ${now() - t0}ms）` } : r;
      await sleep(PREVIEW_LIMITS.pollMs);
    }
  };
  const capture = async (): Promise<Buffer | null> => {
    try {
      const b = await withTimeout(io.capture(), PREVIEW_LIMITS.captureTimeoutMs);
      return b && b.length ? b : null;
    } catch {
      return null;
    }
  };

  for (let i = 0; i < Math.min(actions.length, PREVIEW_LIMITS.steps); i++) {
    const a = actions[i];
    const base = { index: i + 1, action: describeAction(a), ...(a.optional ? { optional: true } : {}) };
    if (stopped) {
      out.push({ ...base, ok: false, skipped: true, note: stopped, ms: 0 });
      continue;
    }
    io.onStep?.(i + 1);
    const t0 = now();
    let r: Reply;
    if (t0 >= end) r = { ok: false, note: `超出交互总时长上限（${PREVIEW_LIMITS.totalMs / 1000}s）`, fatal: true };
    else if (a.op === 'wait') {
      const ms = Math.max(0, Math.min(a.ms ?? 0, end - t0));
      await sleep(ms);
      r = { ok: true, note: `已等待 ${ms}ms${ms < (a.ms ?? 0) ? '（受总时长上限截断）' : ''}` };
    } else if (a.op === 'screenshot') r = { ok: true, note: '' };
    else {
      const limit = a.timeoutMs ?? (a.op === 'waitFor' ? PREVIEW_LIMITS.waitForMs : PREVIEW_LIMITS.autoWaitMs);
      r = await attempt(a, Math.min(end, t0 + limit));
    }
    if (r.ok && MUTATING.has(a.op)) await sleep(PREVIEW_LIMITS.settleMs);
    let png: Buffer | null = null;
    if ((a.op === 'screenshot' || a.shot) && !r.fatal) {
      const add = (s: string) => (r.note = r.note ? `${r.note}；${s}` : s);
      if (shots >= PREVIEW_LIMITS.shots) add(`截图已达上限 ${PREVIEW_LIMITS.shots} 张，未截`);
      else {
        png = await capture();
        if (png) shots++;
        add(png ? '已截图' : '截图失败');
      }
    }
    out.push({ ...base, ok: r.ok, note: r.note, ms: Math.max(0, now() - t0), ...(png ? { png } : {}) });
    if (!r.ok && (r.fatal || !a.optional)) stopped = r.fatal ? `未执行（${r.note}）` : `未执行（第 ${i + 1} 步失败后中止）`;
  }
  return out;
}

/** After the steps: resize to each extra viewport and capture it, noting horizontal overflow. */
export async function captureViewports(viewports: PreviewViewport[], io: PreviewIO, o: { execTimeoutMs?: number } = {}): Promise<PreviewHostViewport[]> {
  const sleep = io.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const out: PreviewHostViewport[] = [];
  for (const v of viewports.slice(0, PREVIEW_LIMITS.viewports)) {
    if (!io.resize) {
      out.push({ ...v, note: '当前环境不能调整视口' });
      continue;
    }
    try {
      await io.resize(v.width, v.height);
      await sleep(PREVIEW_LIMITS.resizeSettleMs);
      const m = (await withTimeout(io.exec(METRICS_JS), o.execTimeoutMs ?? PREVIEW_LIMITS.execTimeoutMs).catch(() => null)) as { sw?: number; cw?: number } | null;
      const png = await withTimeout(io.capture(), PREVIEW_LIMITS.captureTimeoutMs).catch(() => null);
      const over = m && typeof m.sw === 'number' && typeof m.cw === 'number' ? m.sw > m.cw + 1 : undefined;
      out.push({ ...v, ...(png && png.length ? { png } : { note: '截图失败' }), ...(over !== undefined ? { overflowX: over, contentWidth: m!.sw } : {}) });
    } catch (e) {
      out.push({ ...v, note: `调整视口失败：${msgOf(e)}` });
    }
  }
  return out;
}

/** Host result → PreviewResult, every PNG stored through `put` (the blob store) and replaced by its hash. */
export function storePreviewShots(r: PreviewHostResult, put: (png: Buffer) => string): PreviewResult {
  const { png, steps, viewports, ...rest } = r;
  const keep = <T extends { png?: Buffer }>({ png: p, ...s }: T) => ({ ...s, ...(p && p.length ? { screenshot: put(p) } : {}) });
  return { ...rest, ...(png && png.length ? { screenshot: put(png) } : {}), ...(steps ? { steps: steps.map(keep) } : {}), ...(viewports ? { viewports: viewports.map(keep) } : {}) };
}
