// Electron side of HTML 预览: the `preview://ws/` scheme in an isolated partition, the network policy,
// <webview> hardening, and the hidden sandboxed browser used by the agent tool `preview_page`.
import { BrowserWindow, session, type WebContents } from 'electron';
import { PREVIEW_PARTITION, isAllowedPreviewUrl, isLocalRequest, servePreview } from './services/preview';
import type { Runtime } from './runtime/runtime';
import type { PreviewResult } from '../shared/types';

export function installPreview(rt: Runtime, onBlocked: (url: string) => void) {
  const ses = session.fromPartition(PREVIEW_PARTITION);
  ses.protocol.handle('preview', (req) => {
    const r = servePreview(rt.workspace?.root, req.url);
    return new Response(new Uint8Array(r.body), { status: r.status, headers: r.headers });
  });
  // Outbound network from previewed pages: local only unless the emperor allows it (pages may be agent-written).
  ses.webRequest.onBeforeRequest((d, cb) => {
    if (isLocalRequest(d.url) || rt.settings.previewAllowNetwork) return cb({});
    onBlocked(d.url);
    blockedSink?.(d.url);
    cb({ cancel: true });
  });
  ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  ses.setPermissionCheckHandler(() => false);
  ses.on('will-download', (e) => e.preventDefault());
}

let blockedSink: ((url: string) => void) | null = null;

/** Called from web-contents-created: lock down <webview> guests and hidden preview windows. */
export function hardenContents(contents: WebContents) {
  contents.on('will-attach-webview', (e, prefs, params) => {
    delete (prefs as { preload?: string }).preload;
    prefs.nodeIntegration = false;
    prefs.nodeIntegrationInSubFrames = false;
    prefs.contextIsolation = true;
    prefs.sandbox = true;
    prefs.webSecurity = true;
    if (params.partition !== PREVIEW_PARTITION || !isAllowedPreviewUrl(params.src || 'about:blank') && params.src !== 'about:blank') e.preventDefault();
  });
  if (contents.getType() === 'webview') {
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-navigate', (e, url) => {
      if (!isAllowedPreviewUrl(url)) e.preventDefault();
    });
  }
}

let queue: Promise<unknown> = Promise.resolve();

/** Render one page off-screen; serialized so agents never open many hidden browsers at once. */
export function previewPage(url: string, o: { waitMs: number; width: number; height: number }): Promise<Omit<PreviewResult, 'screenshot'> & { png?: Buffer }> {
  const run = () => renderOnce(url, o);
  const p = queue.then(run, run);
  queue = p.catch(() => undefined);
  return p;
}

async function renderOnce(url: string, o: { waitMs: number; width: number; height: number }): Promise<Omit<PreviewResult, 'screenshot'> & { png?: Buffer }> {
  const started = Date.now();
  const consoleLines: PreviewResult['console'] = [];
  const failed: string[] = [];
  const blocked: string[] = [];
  const win = new BrowserWindow({
    show: false,
    width: o.width,
    height: o.height,
    useContentSize: true,
    webPreferences: { partition: PREVIEW_PARTITION, sandbox: true, contextIsolation: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false, spellcheck: false },
  });
  const wc = win.webContents;
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  wc.on('will-navigate', (e, u) => {
    if (!isAllowedPreviewUrl(u)) e.preventDefault();
  });
  wc.on('console-message', (...a: unknown[]) => {
    const ev = a[0] as { level?: string | number; message?: string; sourceId?: string; lineNumber?: number };
    const levelRaw = ev.level ?? a[1];
    if (/Electron Security Warning/.test(String(ev.message ?? a[2] ?? ''))) return;
    const level = typeof levelRaw === 'number' ? (['verbose', 'info', 'warning', 'error'][levelRaw] ?? 'info') : String(levelRaw ?? 'info');
    consoleLines.push({ level, message: String(ev.message ?? a[2] ?? '').slice(0, 2000), source: ev.sourceId ?? (a[4] as string | undefined), line: ev.lineNumber ?? (a[3] as number | undefined) });
  });
  wc.on('did-fail-load', (_e, code, desc, u, isMain) => {
    if (code !== -3) failed.push(`${isMain ? '[主页面] ' : ''}${u} — ${desc} (${code})`);
  });
  const prevSink = blockedSink;
  blockedSink = (u) => blocked.push(u);
  let ok = true;
  try {
    await Promise.race([
      wc.loadURL(url),
      new Promise((_, rej) => setTimeout(() => rej(new Error('页面加载超时（20s）')), 20000)),
    ]).catch((e) => {
      ok = false;
      failed.push(`${url} — ${(e as Error).message}`);
    });
    await new Promise((r) => setTimeout(r, o.waitMs));
    const info = (await wc
      .executeJavaScript(`(() => ({ title: document.title, text: (document.body && document.body.innerText || '').slice(0, 6000), status: document.readyState }))()`, true)
      .catch(() => ({ title: '', text: '' }))) as { title: string; text: string };
    const img = await wc.capturePage().catch(() => null);
    const png = img && !img.isEmpty() ? img.toPNG() : undefined;
    return { url, ok: ok && !failed.some((f) => f.startsWith('[主页面]')), title: info.title, text: info.text, console: consoleLines.slice(0, 200), failed, blocked: [...new Set(blocked)], png, width: o.width, height: o.height, loadMs: Date.now() - started };
  } finally {
    blockedSink = prevSink;
    if (!win.isDestroyed()) win.destroy();
  }
}
