// HTML 预览 — serves the open workspace read-only on the private `preview://ws/` scheme
// (no network port is opened), inside an isolated session partition whose outbound network is limited to
// local addresses unless the user allows it. Pure functions here are shared by Electron and node tests.
import fs from 'node:fs';
import path from 'node:path';
import { Workspace, PathBoundaryError } from './workspace';

export const PREVIEW_SCHEME = 'preview';
export const PREVIEW_ORIGIN = 'preview://ws';
export const PREVIEW_PARTITION = 'edict-preview';

const MIME: Record<string, string> = {
  html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8', map: 'application/json; charset=utf-8', txt: 'text/plain; charset=utf-8', md: 'text/plain; charset=utf-8', xml: 'application/xml; charset=utf-8',
  svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', ico: 'image/x-icon', bmp: 'image/bmp',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', mp4: 'video/mp4', webm: 'video/webm',
  wasm: 'application/wasm', pdf: 'application/pdf', csv: 'text/csv; charset=utf-8',
};

export interface PreviewResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

const text = (status: number, msg: string): PreviewResponse => ({ status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }, body: Buffer.from(msg) });

/** Map a preview:// request onto a workspace file (read-only, boundary-checked, secrets refused). */
export function servePreview(root: string | null | undefined, rawUrl: string): PreviewResponse {
  if (!root) return text(404, '未打开工作区：请先在 Edict 中打开文件夹');
  const u = new URL(rawUrl);
  let rel = decodeURIComponent(u.pathname).replace(/^\/+/, '');
  const ws = new Workspace(root);
  let abs: string;
  try {
    abs = ws.resolve(rel || '.');
  } catch (e) {
    return text(e instanceof PathBoundaryError ? 403 : 400, (e as Error).message);
  }
  const r = ws.rel(abs);
  if (r === '.git' || r.startsWith('.git/') || ws.isSensitive(abs)) return text(403, '出于安全考虑，预览不提供此文件（.git / 密钥 / .env）');
  if (!fs.existsSync(abs)) return text(404, `未找到：${rel || '/'}`);
  if (fs.statSync(abs).isDirectory()) {
    const idx = ['index.html', 'index.htm'].map((f) => path.join(abs, f)).find((f) => fs.existsSync(f));
    if (!idx) {
      const items = fs.readdirSync(abs, { withFileTypes: true }).filter((d) => !d.name.startsWith('.')).slice(0, 500);
      const base = rel ? `/${rel.replace(/\/?$/, '/')}` : '/';
      const html = `<!doctype html><meta charset="utf-8"><title>${esc(rel || '工作区')}</title><body style="font:13px -apple-system,sans-serif;padding:16px"><h3>${esc(rel || '工作区根目录')}</h3><ul>${items.map((d) => `<li><a href="${base}${encodeURIComponent(d.name)}${d.isDirectory() ? '/' : ''}">${esc(d.name)}${d.isDirectory() ? '/' : ''}</a></li>`).join('')}</ul>`;
      return { status: 200, headers: { 'content-type': MIME.html, 'cache-control': 'no-store' }, body: Buffer.from(html) };
    }
    abs = idx;
    rel = ws.rel(idx);
  }
  const st = fs.statSync(abs);
  if (st.size > 64 * 1024 * 1024) return text(413, '文件过大，预览不提供');
  const ext = path.extname(abs).slice(1).toLowerCase();
  const type = MIME[ext] ?? 'application/octet-stream';
  const body = fs.readFileSync(abs);
  return { status: 200, headers: { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }, body };
}

/** Workspace-relative path → preview URL. */
export function previewUrlFor(rel: string): string {
  const clean = rel.replace(/^\.?\/+/, '').split('/').map(encodeURIComponent).join('/');
  return `${PREVIEW_ORIGIN}/${clean}`;
}

/** Subresource policy for the preview partition: workspace scheme, inline data, local dev servers. */
export function isLocalRequest(url: string): boolean {
  if (/^(data|blob|devtools|chrome-extension|about):/i.test(url)) return true;
  try {
    const u = new URL(url);
    if (u.protocol === `${PREVIEW_SCHEME}:`) return u.host === 'ws';
    return ['http:', 'https:', 'ws:', 'wss:'].includes(u.protocol) && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  } catch {
    return false;
  }
}

/** Only the workspace scheme and local dev servers may be previewed. */
export function isAllowedPreviewUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol === `${PREVIEW_SCHEME}:`) return u.host === 'ws';
    return (u.protocol === 'http:' || u.protocol === 'https:') && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  } catch {
    return false;
  }
}

function esc(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}
