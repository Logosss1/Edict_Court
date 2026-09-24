// HTML 预览 tab — renders workspace pages (preview://ws/…) or a local dev server inside a sandboxed
// <webview> (isolated partition, local-only network by default), with live reload, device sizes and a console.
import { createElement, useEffect, useRef, useState } from 'react';
import { useStore, setUI, openTab, toast, getState, type Tab } from '../store';
import { call } from '../api';
import { Icon } from '../common/Icon';

export const PREVIEWABLE = /\.(html?|svg)$/i;

/** Open (or focus) a preview tab for a workspace path or a localhost URL. */
export async function openPreview(target: string) {
  try {
    const isUrl = /^https?:\/\//.test(target);
    const url = isUrl ? target : await call<string>('previewUrl', target);
    const title = isUrl ? target.replace(/^https?:\/\//, '') : target.split('/').pop() || '预览';
    openTab({ id: `preview:${isUrl ? target : target}`, kind: 'preview', title: `预览 · ${title}`, url, path: isUrl ? undefined : target });
  } catch (e) {
    toast((e as Error).message, 'error');
  }
}

interface ConsoleLine { level: string; message: string; source?: string; line?: number; at: number }
const DEVICES: { id: string; label: string; w?: number; h?: number }[] = [
  { id: 'fit', label: '自适应' },
  { id: 'phone', label: '手机 390', w: 390, h: 844 },
  { id: 'tablet', label: '平板 820', w: 820, h: 1180 },
  { id: 'laptop', label: '笔记本 1280', w: 1280, h: 800 },
  { id: 'desktop', label: '桌面 1440', w: 1440, h: 900 },
];
const LEVEL = (l: number | string) => (typeof l === 'number' ? (['log', 'info', 'warning', 'error'][l] ?? 'log') : l);

export function PreviewView({ tab }: { tab: Tab }) {
  const ref = useRef<HTMLElement & { reload(): void; loadURL(u: string): Promise<void>; getURL(): string; openDevTools(): void; isDevToolsOpened(): boolean; closeDevTools(): void; canGoBack(): boolean; goBack(): void }>(null);
  const [addr, setAddr] = useState(tab.url ?? '');
  const [current, setCurrent] = useState(tab.url ?? '');
  const [title, setTitle] = useState('');
  const [device, setDevice] = useState('fit');
  const [auto, setAuto] = useState(true);
  const [logs, setLogs] = useState<ConsoleLine[]>([]);
  const [showConsole, setShowConsole] = useState(false);
  const [blocked, setBlocked] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const fsVersion = useStore((s) => s.ui.fsVersion);
  const changed = useStore((s) => s.ui.changedPaths);
  const allowNet = useStore((s) => !!s.settings.previewAllowNetwork);
  const lastBlocked = useStore((s) => s.ui.previewBlocked);

  useEffect(() => {
    const wv = ref.current;
    if (!wv) return;
    const onConsole = (e: Event) => {
      const ev = e as unknown as { level: number | string; message: string; sourceId?: string; line?: number };
      if (/Electron Security Warning/.test(ev.message)) return; // dev-only host warning, not the page's
      setLogs((l) => [...l.slice(-499), { level: LEVEL(ev.level), message: ev.message, source: ev.sourceId, line: ev.line, at: Date.now() }]);
    };
    const onNav = (e: Event) => {
      const u = (e as unknown as { url: string }).url;
      setCurrent(u);
      setAddr(u);
    };
    const onStart = () => {
      setLoading(true);
      setFailed(null);
    };
    const onStop = () => setLoading(false);
    const onFail = (e: Event) => {
      const ev = e as unknown as { errorCode: number; errorDescription: string; validatedURL: string; isMainFrame: boolean };
      if (ev.errorCode === -3) return;
      if (ev.isMainFrame) setFailed(`${ev.errorDescription}（${ev.errorCode}）${ev.validatedURL}`);
      setLogs((l) => [...l, { level: 'error', message: `加载失败：${ev.validatedURL} — ${ev.errorDescription}`, at: Date.now() }]);
    };
    const onTitle = (e: Event) => setTitle((e as unknown as { title: string }).title);
    wv.addEventListener('console-message', onConsole);
    wv.addEventListener('did-navigate', onNav);
    wv.addEventListener('did-start-loading', onStart);
    wv.addEventListener('did-stop-loading', onStop);
    wv.addEventListener('did-fail-load', onFail);
    wv.addEventListener('page-title-updated', onTitle);
    return () => {
      wv.removeEventListener('console-message', onConsole);
      wv.removeEventListener('did-navigate', onNav);
      wv.removeEventListener('did-start-loading', onStart);
      wv.removeEventListener('did-stop-loading', onStop);
      wv.removeEventListener('did-fail-load', onFail);
      wv.removeEventListener('page-title-updated', onTitle);
    };
  }, []);

  // live reload when workspace files change (agent writes or your saves)
  useEffect(() => {
    if (!auto || !current.startsWith('preview://') || !fsVersion) return;
    if (changed.length && !changed.some((p) => /\.(html?|css|m?js|json|svg|png|jpe?g|gif|webp|woff2?)$/i.test(p))) return;
    reload();
  }, [fsVersion]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (lastBlocked) setBlocked((b) => (b.includes(lastBlocked.url) ? b : [...b.slice(-49), lastBlocked.url]));
  }, [lastBlocked]);

  const reload = () => {
    setLogs([]);
    setBlocked([]);
    try {
      ref.current?.reload();
    } catch {
      /* not attached yet */
    }
  };
  const go = () => {
    let u = addr.trim();
    if (!u) return;
    if (!/^[a-z]+:\/\//i.test(u)) u = /^(localhost|127\.0\.0\.1)(:\d+)?/.test(u) ? `http://${u}` : `preview://ws/${u.replace(/^\/+/, '')}`;
    if (!/^preview:\/\/ws\//.test(u) && !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/.test(u)) {
      toast('预览只支持工作区文件或本机开发服务器（localhost）', 'warn');
      return;
    }
    setLogs([]);
    void ref.current?.loadURL(u).catch(() => {});
  };
  const errors = logs.filter((l) => l.level === 'error').length;
  const warns = logs.filter((l) => l.level === 'warning').length;
  const dev = DEVICES.find((d) => d.id === device)!;
  const relPath = current.startsWith('preview://ws/') ? decodeURIComponent(current.slice('preview://ws/'.length)) : null;

  return (
    <div className="preview-view" data-testid="preview-view">
      <div className="pv-bar">
        <button className="icon-btn" title="刷新" onClick={reload}><Icon name="retry" size={14} /></button>
        <input className="input pv-addr" value={addr} onChange={(e) => setAddr(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && go()} spellCheck={false} data-testid="preview-addr" title="工作区相对路径，或 http://localhost:端口/" />
        <select className="input sm" value={device} onChange={(e) => setDevice(e.target.value)} title="视口尺寸">
          {DEVICES.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
        </select>
        <label className="chk small" title="工作区文件变化时自动刷新"><input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} /> 自动刷新</label>
        <button className={`btn sm ${errors ? 'danger' : ''}`} onClick={() => setShowConsole(!showConsole)} data-testid="preview-console-btn">
          控制台 {errors ? `✖${errors}` : ''}{warns ? ` ⚠${warns}` : ''}
        </button>
        <button className="icon-btn" title="开发者工具" onClick={() => { const w = ref.current; if (w) (w.isDevToolsOpened() ? w.closeDevTools() : w.openDevTools()); }}><Icon name="code" size={14} /></button>
        {relPath && <button className="icon-btn" title="在默认浏览器中打开" onClick={() => call('previewOpenExternal', relPath)}><Icon name="external" size={14} /></button>}
        {!relPath && current.startsWith('http') && <button className="icon-btn" title="在默认浏览器中打开" onClick={() => call('previewOpenExternal', current)}><Icon name="external" size={14} /></button>}
      </div>
      {(blocked.length > 0 && !allowNet) && (
        <div className="notice small pv-notice">
          已拦截 {blocked.length} 个外部网络请求（如 CDN）：<code className="ellipsis">{blocked[0]}</code> — 预览默认只允许本地资源，防止生成的页面向外发送数据。
          <button className="link" onClick={async () => { if (await call<boolean>('confirm', '允许 HTML 预览加载外部网络资源？', '页面（可能由 Agent 生成）将可以访问互联网，包括向外发送数据。仅在信任该页面时开启；可随时在此关闭。')) { await call('updateSettings', { previewAllowNetwork: true }); reload(); } }}>允许外部网络</button>
        </div>
      )}
      {allowNet && <div className="notice small pv-notice">⚠ 预览已允许外部网络。<button className="link" onClick={async () => { await call('updateSettings', { previewAllowNetwork: false }); reload(); }}>恢复仅本地</button></div>}
      {failed && <div className="notice warn small pv-notice">页面加载失败：{failed}</div>}
      <div className={`pv-stage ${dev.w ? 'device' : ''}`}>
        <div className="pv-frame" style={dev.w ? { width: dev.w, height: dev.h } : undefined}>
          {createElement('webview', { ref, src: tab.url, partition: 'edict-preview', className: 'pv-webview', webpreferences: 'contextIsolation=yes,sandbox=yes,javascript=yes', 'data-testid': 'preview-webview' })}
          {loading && <div className="pv-loading">加载中…</div>}
        </div>
      </div>
      {showConsole && (
        <div className="pv-console" data-testid="preview-console">
          <div className="pv-console-head">
            <b>控制台</b> <span className="muted small">{title}</span>
            <span style={{ flex: 1 }} />
            <button className="link small" onClick={() => setLogs([])}>清空</button>
            {errors > 0 && <button className="link small" onClick={() => sendToComposer(relPath ?? current, logs)}>让 Agent 修复</button>}
          </div>
          {logs.length === 0 && <div className="muted small pad">（暂无输出）</div>}
          {logs.map((l, i) => (
            <div key={i} className={`pv-log lv-${l.level}`}>
              <span className="pv-lv">{l.level === 'error' ? '✖' : l.level === 'warning' ? '⚠' : '›'}</span>
              <span className="pv-msg">{l.message}</span>
              {l.source && <span className="muted small">{l.source.replace('preview://ws/', '')}:{l.line}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function sendToComposer(target: string, logs: ConsoleLine[]) {
  const errs = logs.filter((l) => l.level === 'error').slice(0, 15).map((l) => `- ${l.message}${l.source ? ` (${l.source.replace('preview://ws/', '')}:${l.line})` : ''}`).join('\n');
  const text = `预览 ${target} 时控制台报错，请修复并用 preview_page 复验：\n${errs}`;
  void import('./AgentPane').then(({ draftToComposer }) => draftToComposer(text));
  void getState;
  setUI({});
}
