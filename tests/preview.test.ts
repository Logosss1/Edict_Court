// HTML 预览 file serving (unit) — the Electron protocol handler delegates to servePreview.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { servePreview, isAllowedPreviewUrl, isLocalRequest, previewUrlFor } from '../src/main/services/preview';
import { executeTool } from '../src/main/runtime/tools';
import { startMockLlm } from './mockLlm';
import { makeRuntime, tmpDir } from './helpers';

test('preview serves workspace files read-only with correct types, index fallback and boundaries', () => {
  const ws = tmpDir('edict-pv-');
  fs.mkdirSync(path.join(ws, 'site/css'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'site/index.html'), '<!doctype html><html><head><title>T</title></head><body>hi</body></html>');
  fs.writeFileSync(path.join(ws, 'site/css/a.css'), 'body{color:red}');
  fs.writeFileSync(path.join(ws, '.env'), 'SECRET=1');
  fs.writeFileSync(path.join(ws, '中文 页.html'), '<p>中文</p>');
  const outside = tmpDir('edict-out-');
  fs.writeFileSync(path.join(outside, 'x.html'), 'nope');
  fs.symlinkSync(outside, path.join(ws, 'link'));

  const idx = servePreview(ws, 'preview://ws/site/');
  assert.equal(idx.status, 200);
  assert.match(idx.headers['content-type'], /text\/html/);
  assert.equal(idx.body.toString(), fs.readFileSync(path.join(ws, 'site/index.html'), 'utf8'), 'served byte-exact');
  assert.equal(idx.headers['cache-control'], 'no-store');
  assert.match(servePreview(ws, 'preview://ws/site/css/a.css').headers['content-type'], /text\/css/);
  assert.equal(servePreview(ws, previewUrlFor('中文 页.html')).status, 200);
  assert.equal(servePreview(ws, 'preview://ws/.env').status, 403, 'secrets refused');
  assert.equal(servePreview(ws, 'preview://ws/link/x.html').status, 403, 'symlink escape refused');
  assert.equal(servePreview(ws, 'preview://ws/../../etc/passwd').status === 200, false);
  assert.equal(servePreview(ws, 'preview://ws/missing.html').status, 404);
  assert.match(servePreview(ws, 'preview://ws/').body.toString(), /site\//, 'directory listing');
  assert.equal(servePreview(null, 'preview://ws/index.html').status, 404);
});

test('preview URL policy: workspace scheme and localhost only', () => {
  assert.ok(isAllowedPreviewUrl('preview://ws/index.html'));
  assert.ok(isAllowedPreviewUrl('http://localhost:5173/'));
  assert.ok(isAllowedPreviewUrl('http://127.0.0.1:8080/a'));
  assert.ok(!isAllowedPreviewUrl('https://example.com/'));
  assert.ok(!isAllowedPreviewUrl('file:///etc/passwd'));
  assert.ok(!isAllowedPreviewUrl('preview://evil/x'));
  assert.ok(isLocalRequest('data:image/png;base64,xx'));
  assert.ok(isLocalRequest('ws://localhost:5173/'));
  assert.ok(!isLocalRequest('https://cdn.example.com/lib.js'));
});

test('preview_page tool: reports unavailable without the desktop browser; passes results through when present (mock host)', async () => {
  const mock = await startMockLlm();
  const rt = makeRuntime(mock.url);
  const ws = tmpDir('edict-ws-');
  fs.writeFileSync(path.join(ws, 'index.html'), '<title>Hi</title>');
  rt.setWorkspace(ws);
  const r0 = await executeTool({ rt, agentId: 'bingbu' }, 'preview_page', { path: 'index.html' });
  assert.equal(r0.ok, false);
  assert.match(r0.output, /仅在桌面应用/);
  // simulate the desktop host (MOCK host: not a real browser)
  rt.opts.previewPage = async (url, o) => ({ url, ok: true, title: 'Hi', text: 'hello', console: [{ level: 'error', message: 'ReferenceError: foo is not defined', source: 'preview://ws/index.html', line: 3 }], failed: [], blocked: ['https://cdn.example.com/x.js'], png: Buffer.from('89504e47', 'hex'), width: o.width, height: o.height, loadMs: 12 });
  const r1 = await executeTool({ rt, agentId: 'bingbu' }, 'preview_page', { path: 'index.html' });
  assert.equal(r1.ok, false, 'console errors make the check fail');
  assert.match(r1.output, /ReferenceError/);
  assert.match(r1.output, /已拦截/);
  const r2 = await executeTool({ rt, agentId: 'bingbu' }, 'preview_page', { url: 'https://example.com' });
  assert.match(r2.output, /只允许/);
  const r3 = await executeTool({ rt, agentId: 'bingbu' }, 'preview_page', { path: '../x.html' });
  assert.equal(r3.ok, false);
  rt.dispose();
  await mock.close();
});
