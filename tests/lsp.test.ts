// LSP module (integration: real child processes over stdio — a fake server fixture, plus pyright when installed).
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir, waitFor } from './helpers';
import { PathBoundaryError, Workspace } from '../src/main/services/workspace';
import { MessageReader, encodeMessage, type LspMessage } from '../src/main/lsp/client';
import { LANGUAGE_ID_BY_EXT, LSP_SERVERS, type LspServerDef } from '../src/main/lsp/registry';
import { clearDetectCache, detectServer, findExecutable, installHint, parseVersion, searchDirs } from '../src/main/lsp/detect';
import { LspManager, type LspDiagnosticsEvent, type LspServerStatus } from '../src/main/lsp/manager';
import { LSP_OPERATIONS, LSP_TOOL_SPEC, findColumn, runLspTool } from '../src/main/lsp/tool';

const FIXTURE = path.resolve('tests/fixtures/fake-lsp.mjs');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const fakeDef = (args: string[] = []): LspServerDef => ({
  id: 'fake', name: 'Fake LS', languages: ['Fake'], languageIds: ['fake'], extensions: ['.fake'],
  commands: [{ cmd: process.execPath, args: [FIXTURE, ...args] }], rootMarkers: [],
  install: { all: 'npm i -g fake-ls' }, homepage: 'https://example.invalid/fake',
});
const missingDef: LspServerDef = {
  id: 'nope', name: 'Nope LS', languages: ['Nope'], languageIds: ['nope'], extensions: ['.nope'],
  commands: [{ cmd: 'edict-definitely-not-installed-ls', args: ['--stdio'] }], rootMarkers: [],
  install: { darwin: 'brew install nope-ls', linux: 'apt install nope-ls', all: 'see docs' }, homepage: 'https://example.invalid/nope',
};
const FAST = { diagnosticSettleMs: 40, probeVersion: false };
const managers: LspManager[] = [];
/** Every manager is disposed at the end even when an assertion fails mid-test (no stray servers). */
function manager(o: ConstructorParameters<typeof LspManager>[0]) {
  const m = new LspManager(o);
  managers.push(m);
  return m;
}
after(() => Promise.all(managers.map((m) => m.dispose())));

function makeWs() {
  const dir = tmpDir('edict-lsp-');
  fs.writeFileSync(
    path.join(dir, 'main.fake'),
    [
      'class Greeter', //       1
      '  def greet', //         2
      '  def wave', //          3
      'def helper', //          4
      'greet()', //             5
      'helper() ERROR here', // 6
      'outside', //             7
      'boom', //                8
      'WARN 中文 helper', //    9
    ].join('\n'),
  );
  fs.writeFileSync(path.join(dir, 'lib.fake'), 'def libfn\nhelper()\nlibfn()\n');
  fs.mkdirSync(path.join(dir, 'sub'));
  fs.writeFileSync(path.join(dir, 'sub', 'other.fake'), 'greet() helper()\n');
  return { dir, ws: new Workspace(dir) };
}

const serverOf = async (m: LspManager, id = 'fake'): Promise<LspServerStatus> => (await m.status()).servers.find((s) => s.id === id)!;
const logged = (m: LspManager, text: string) => m.logs('fake').some((l) => l.text === text);
const pidAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test('framing: Content-Length counts UTF-8 bytes; split, coalesced and noisy streams decode', () => {
  const got: LspMessage[] = [];
  const junk: string[] = [];
  const r = new MessageReader((m) => got.push(m), (t) => junk.push(t));
  const payload = { jsonrpc: '2.0' as const, id: 1, result: { text: '中文 ✓ émoji 🎉' } };
  const a = encodeMessage(payload);
  const b = encodeMessage({ jsonrpc: '2.0', method: 'x', params: {} });
  assert.equal(Number(/Content-Length: (\d+)/.exec(a.toString('utf8'))![1]), Buffer.byteLength(JSON.stringify(payload)));
  for (const byte of a) r.push(Buffer.from([byte])); // byte by byte, splitting multibyte chars
  r.push(Buffer.concat([Buffer.from('server banner\r\n\r\n'), b, a.subarray(0, 10)])); // banner + 1.x messages
  r.push(a.subarray(10));
  r.push(Buffer.from('Content-Length: 2\r\nContent-Type: application/vscode-jsonrpc; charset=utf-8\r\n\r\n{}'));
  assert.equal(got.length, 4);
  assert.deepEqual(got[0], payload);
  assert.equal(got[1].method, 'x');
  assert.deepEqual(got[2], payload);
  assert.deepEqual(got[3], {});
  assert.deepEqual(junk, ['server banner']);
});

test('registry: every well-known server present and well-formed, with macOS + Linux install hints', () => {
  const ids = new Set<string>();
  for (const d of LSP_SERVERS) {
    assert.ok(!ids.has(d.id), `duplicate ${d.id}`);
    ids.add(d.id);
    assert.ok(d.commands.length && d.extensions.length && d.languageIds.length && d.languages.length, d.id);
    for (const e of d.extensions) {
      assert.match(e, /^\.[a-z0-9]+$/, `${d.id} ${e}`);
      assert.ok(LANGUAGE_ID_BY_EXT[e], `languageId for ${e}`);
    }
    for (const p of ['darwin', 'linux'] as const) assert.ok(installHint(d, p).length > d.name.length + 4, `${d.id} ${p} hint`);
    assert.match(d.homepage, /^https:\/\//);
  }
  const want = ['typescript-language-server', 'vtsls', 'pyright', 'basedpyright', 'pylsp', 'gopls', 'rust-analyzer', 'clangd', 'sourcekit-lsp', 'jdtls', 'kotlin-language-server', 'ruby-lsp', 'solargraph', 'intelephense', 'lua-language-server', 'bash-language-server', 'yaml-language-server', 'dart', 'csharp-ls', 'zls', 'vue-language-server', 'vscode-html-language-server', 'vscode-css-language-server', 'vscode-json-language-server'];
  for (const id of want) assert.ok(ids.has(id), id);
  assert.ok(LSP_SERVERS.find((d) => d.id === 'sourcekit-lsp')!.commands[0].xcrun, 'sourcekit-lsp via xcrun');
  assert.deepEqual(LSP_SERVERS.find((d) => d.id === 'bash-language-server')!.commands[0].args, ['start']);
  assert.match(installHint(LSP_SERVERS.find((d) => d.id === 'rust-analyzer')!, 'linux'), /rustup component add rust-analyzer/);
});

test('detect: PATH + common dirs without a shell, version probe, cache revalidation, overrides, missing → hint', async () => {
  clearDetectCache();
  const bin = tmpDir('edict-lsp-bin-');
  const home = tmpDir('edict-lsp-home-');
  const exe = path.join(bin, 'edict-fake-ls');
  fs.writeFileSync(exe, '#!/bin/sh\necho "edict-fake-ls 1.2.3 (test build)"\n');
  fs.chmodSync(exe, 0o755);
  fs.writeFileSync(path.join(bin, 'edict-not-exec'), 'x');
  fs.mkdirSync(path.join(home, 'go', 'bin'), { recursive: true });
  const goExe = path.join(home, 'go', 'bin', 'edict-go-ls');
  fs.writeFileSync(goExe, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(goExe, 0o755);
  const env = { PATH: bin };
  const dirs = searchDirs({ env, home });
  assert.equal(dirs[0], bin, 'PATH first');
  assert.equal(findExecutable('edict-fake-ls', dirs), exe);
  assert.equal(findExecutable('edict-not-exec', [bin]), null, 'not executable');
  assert.equal(findExecutable('edict-go-ls', dirs), goExe, '~/go/bin searched');
  assert.equal(findExecutable(exe, []), exe, 'absolute path verified directly');

  const def: LspServerDef = { ...fakeDef(), id: 'probe', commands: [{ cmd: 'edict-missing-first', args: [] }, { cmd: 'edict-fake-ls', args: ['--stdio'], version: { args: ['--version'] } }] };
  const d = await detectServer(def, { env, home, probeVersion: true });
  assert.equal(d.found, true);
  assert.equal(d.path, exe);
  assert.equal(d.command, 'edict-fake-ls');
  assert.deepEqual(d.args, ['--stdio']);
  assert.equal(d.version, '1.2.3');
  assert.equal(await detectServer(def, { env, home }), d, 'cached');
  fs.rmSync(exe);
  assert.equal((await detectServer(def, { env, home })).found, false, 'cached hit revalidated: binary removed');

  const miss = await detectServer(missingDef, { env, home, platform: 'linux' });
  assert.equal(miss.found, false);
  assert.equal(miss.installHint, 'Nope LS：apt install nope-ls');
  assert.equal(installHint(missingDef, 'darwin'), 'Nope LS：brew install nope-ls');
  assert.equal(installHint(missingDef, 'win32'), 'Nope LS：see docs');
  const ov = await detectServer(missingDef, { env, home, overrides: { nope: { path: goExe, args: ['--x'] } } });
  assert.equal(ov.found, true);
  assert.equal(ov.path, goExe);
  assert.deepEqual(ov.args, ['--x']);

  // rustup ships a rust-analyzer proxy (a link to rustup) even without the component: not "installed"
  const cargo = tmpDir('edict-lsp-cargo-');
  fs.writeFileSync(path.join(cargo, 'rustup'), '#!/bin/sh\n[ "$1" = which ] && [ -f "${0%/*}/component" ] && echo /toolchain/bin/$2 && exit 0\necho "error: not a file" >&2\nexit 1\n');
  fs.chmodSync(path.join(cargo, 'rustup'), 0o755);
  fs.linkSync(path.join(cargo, 'rustup'), path.join(cargo, 'rust-analyzer'));
  const ra = LSP_SERVERS.find((x) => x.id === 'rust-analyzer')!;
  const proxy = await detectServer(ra, { env: { PATH: cargo }, home, platform: 'linux' });
  assert.equal(proxy.found, false);
  assert.match(proxy.note ?? '', /rustup 代理存在，但当前工具链未安装 rust-analyzer 组件/);
  assert.equal(proxy.installHint, 'rust-analyzer：rustup component add rust-analyzer');
  fs.writeFileSync(path.join(cargo, 'component'), '');
  const real = await detectServer(ra, { env: { PATH: cargo }, home, platform: 'linux', refresh: true });
  assert.equal(real.found, true);
  assert.equal(real.path, path.join(cargo, 'rust-analyzer'));

  assert.equal(parseVersion('golang.org/x/tools/gopls v0.16.1\n    golang.org/x/tools/gopls@v0.16.1 h1:abc'), '0.16.1');
  assert.equal(parseVersion('Ubuntu clangd version 18.1.3 (1ubuntu1)'), '18.1.3');
  assert.equal(parseVersion('rust-analyzer 1.86.0 (05f9846 2025-03-31)'), '1.86.0');
  assert.equal(parseVersion(null), undefined);
});

test('manager + fake server: lazy start, handshake, didOpen → diagnostics, navigation, symbols, disk sync, dispose', async () => {
  const { dir, ws } = makeWs();
  const events: LspDiagnosticsEvent[] = [];
  let statusChanges = 0;
  const m = manager({ workspace: () => ws, registry: [fakeDef(), missingDef], config: FAST, onDiagnostics: (e) => events.push(e), onStatusChange: () => statusChanges++ });
  let s = await serverOf(m);
  assert.equal(s.installed, true);
  assert.equal(s.running, false, 'nothing started until a file is touched');
  assert.equal((await serverOf(m, 'nope')).installed, false);
  assert.match((await serverOf(m, 'nope')).installHint, /^Nope LS：/);

  const d = await m.diagnostics('main.fake', 5000);
  assert.equal(d.fresh, true);
  assert.equal(d.mode, 'push');
  assert.equal(d.server, 'fake');
  assert.equal(d.path, 'main.fake');
  assert.deepEqual(d.diagnostics.map((x) => [x.severity, x.line, x.column, x.endColumn, x.code, x.source]), [['error', 6, 10, 15, 'E1', 'fake'], ['warning', 9, 1, 5, 'W1', 'fake']]);
  assert.ok(events.some((e) => e.path === 'main.fake' && e.server === 'fake' && e.diagnostics.length === 2), 'editor event');

  s = await serverOf(m);
  assert.equal(s.running, true);
  assert.equal(s.instances.length, 1);
  assert.equal(s.instances[0].root, '.');
  assert.equal(s.instances[0].openDocs, 1);
  assert.equal(s.instances[0].serverInfo?.name, 'fake-lsp');
  const pid = s.instances[0].pid!;
  assert.ok(pid && pidAlive(pid));

  // server → client requests answered; initialize params as specified
  await waitFor(() => logged(m, 'unknown -> -32601'), 5000, 'handshake');
  const logs = m.logs('fake').map((l) => l.text);
  assert.ok(logs.includes('configuration -> [null,null]'), logs.join('\n'));
  assert.ok(logs.includes('register -> null'));
  assert.ok(logs.includes('progress -> null'));
  assert.ok(logs.some((t) => t.startsWith('folders -> [{"uri":"file://') && t.includes(path.basename(dir))));
  assert.ok(logs.some((t) => t === `init root=${dir} folders=1 hierarchical=true pid=number`), logs.join('\n'));
  assert.ok(logs.includes('didOpen main.fake v1 lang=fake'));

  // navigation (1-based in and out)
  assert.deepEqual((await m.definition('main.fake', 5, 2)).locations, [{ path: 'main.fake', line: 2, column: 7, endLine: 2, endColumn: 12, external: false }]);
  assert.deepEqual((await m.definition('lib.fake', 2, 1)).locations.map((l) => `${l.path}:${l.line}:${l.column}`), ['main.fake:4:5'], 'cross-file');
  assert.deepEqual((await m.definition('main.fake', 7, 3)).locations.map((l) => [l.path, l.line, l.column, l.external]), [['/definitely/outside/lib.fake', 10, 5, true]], 'LocationLink outside the workspace');
  const refs = (await m.references('main.fake', 4, 6)).locations.map((l) => `${l.path}:${l.line}:${l.column}`).sort();
  assert.deepEqual(refs, ['lib.fake:2:1', 'main.fake:4:5', 'main.fake:6:1', 'main.fake:9:9', 'sub/other.fake:1:9']);
  const h = await m.hover('main.fake', 1, 8);
  assert.equal(h.text, '**Greeter** — 中文悬停说明（1 处声明）');
  const syms = await m.documentSymbols('main.fake');
  assert.deepEqual(syms.symbols.map((x) => [x.depth, x.kindName, x.name, x.location.line, x.location.column, x.container ?? '']), [[0, '类', 'Greeter', 1, 7, ''], [1, '方法', 'greet', 2, 7, 'Greeter'], [1, '方法', 'wave', 3, 7, 'Greeter'], [0, '函数', 'helper', 4, 5, '']]);
  const wsym = await m.workspaceSymbols('fn');
  assert.deepEqual(wsym.symbols.map((x) => [x.name, x.kindName, x.location.path, x.location.line, x.server]), [['libfn', '函数', 'lib.fake', 1, 'fake']]);
  assert.deepEqual(wsym.servers, [{ id: 'fake', name: 'Fake LS' }]);

  // target document changed on disk → didChange v2 (+didSave) → fresh diagnostics
  fs.writeFileSync(path.join(dir, 'main.fake'), 'def helper\nERROR here\n');
  const d2 = await m.diagnostics('main.fake', 5000);
  assert.equal(d2.fresh, true);
  assert.deepEqual(d2.diagnostics.map((x) => [x.line, x.column]), [[2, 1]]);
  assert.ok(logged(m, 'didChange main.fake v2') && logged(m, 'didSave main.fake'));
  const t0 = Date.now();
  await m.diagnostics('main.fake', 5000);
  assert.ok(Date.now() - t0 < 1000, 'unchanged → served from cache without waiting');

  // another open document changed on disk → resynced on the next operation
  fs.writeFileSync(path.join(dir, 'lib.fake'), 'def libfn2\n');
  await m.documentSymbols('main.fake');
  assert.ok(logged(m, 'didChange lib.fake v2'));
  // fs watcher hook: unopened files become didChangeWatchedFiles; deleted open docs are closed
  fs.writeFileSync(path.join(dir, 'sub', 'new.fake'), 'def fresh\n');
  fs.rmSync(path.join(dir, 'lib.fake'));
  await m.notifyFilesChanged(['sub/new.fake', 'lib.fake', 'README.md', '../escape.fake']);
  await waitFor(() => logged(m, 'watched sub/new.fake:2') && logged(m, 'didClose lib.fake'), 5000, 'watched files');
  assert.ok(!m.logs('fake').some((l) => l.text.includes('README')), 'irrelevant files are not forwarded');

  assert.ok(statusChanges > 0);
  await m.dispose();
  await waitFor(() => !pidAlive(pid), 5000, 'server process gone after dispose');
  assert.equal((await serverOf(m)).instances.length, 0);
});

test('boundary: paths outside the workspace are refused by the manager and the tool (incl. symlink escape)', async () => {
  const { dir, ws } = makeWs();
  const outside = tmpDir('edict-lsp-out-');
  fs.writeFileSync(path.join(outside, 'x.fake'), 'def x\n');
  fs.symlinkSync(outside, path.join(dir, 'link'));
  const m = manager({ workspace: ws, registry: [fakeDef()], config: FAST });
  await assert.rejects(m.definition('../x.fake', 1, 1), PathBoundaryError);
  await assert.rejects(m.diagnostics(path.join(outside, 'x.fake')), PathBoundaryError);
  await assert.rejects(m.hover('link/x.fake', 1, 5), PathBoundaryError);
  await assert.rejects(m.watchFile('/etc/hosts'), PathBoundaryError);
  const r = await runLspTool(m, ws, { operation: 'definition', path: '../x.fake', line: 1, column: 1 });
  assert.equal(r.ok, false);
  assert.match(r.output, /^错误：路径越界/);
  const r2 = await runLspTool(m, ws, { operation: 'hover', path: 'link/x.fake', line: 1, column: 5 });
  assert.match(r2.output, /符号链接越界/);
  assert.equal((await serverOf(m)).running, false, 'refused paths never start a server');
  await m.dispose();
});

test('lsp tool: compact Chinese output, symbol → column, argument errors, install hints, enable toggles', async () => {
  const { dir, ws } = makeWs();
  fs.writeFileSync(path.join(dir, 'x.nope'), 'nothing');
  fs.writeFileSync(path.join(dir, 'x.xyz'), 'nothing');
  // --chop: the fixture writes its output in 7-byte fragments → exercises framing over a real pipe
  const m = manager({ workspace: ws, registry: [fakeDef(['--chop']), missingDef], config: FAST });
  assert.equal(LSP_TOOL_SPEC.name, 'lsp');
  assert.deepEqual((LSP_TOOL_SPEC.parameters as { properties: { operation: { enum: string[] } } }).properties.operation.enum, [...LSP_OPERATIONS]);
  assert.equal(findColumn('  foo.foobar(foo)', 'foobar'), 7);
  assert.equal(findColumn('xfoo foo', 'foo'), 6, 'whole word first');

  const diag = await runLspTool(m, ws, { operation: 'diagnostics', path: 'main.fake' });
  assert.equal(diag.ok, true, diag.output);
  assert.equal(diag.output, 'main.fake（Fake LS）：1 个错误，1 个警告\nmain.fake:6:10 错误 [E1] 假错误：ERROR ⏎ 第二行说明（fake）\nmain.fake:9:1 警告 [W1] 假警告：WARN（fake）');
  const def = await runLspTool(m, ws, { operation: 'definition', path: 'main.fake', line: 5, symbol: 'greet' });
  assert.equal(def.output, '定义（1 处，Fake LS）：\nmain.fake:2:7  def greet');
  const refs = await runLspTool(m, ws, { operation: 'references', path: 'main.fake', line: 4, symbol: 'helper' });
  assert.equal(refs.output, ['引用 5 处（3 个文件，Fake LS）：', 'lib.fake:2:1  helper()', 'main.fake:4:5  def helper', 'main.fake:6:1  helper() ERROR here', 'main.fake:9:9  WARN 中文 helper', 'sub/other.fake:1:9  greet() helper()'].join('\n'));
  const ext = await runLspTool(m, ws, { operation: 'definition', path: 'main.fake', line: 7, column: 1 });
  assert.equal(ext.output, '定义（1 处，Fake LS）：\n[工作区外] /definitely/outside/lib.fake:10:5');
  const hov = await runLspTool(m, ws, { operation: 'hover', path: 'main.fake', line: 1, symbol: 'Greeter' });
  assert.equal(hov.output, 'main.fake:1:7 悬停信息（Fake LS）：\n**Greeter** — 中文悬停说明（1 处声明）');
  const syms = await runLspTool(m, ws, { operation: 'symbols', path: 'main.fake' });
  assert.equal(syms.output, 'main.fake 符号大纲（Fake LS，4 个）：\n类 Greeter — class  :1\n  方法 greet — greet()  :2\n  方法 wave — wave()  :3\n函数 helper — helper()  :4');
  const wsym = await runLspTool(m, ws, { operation: 'workspace_symbols', query: 'greet' });
  assert.equal(wsym.output, '匹配 “greet” 的符号 2 个（Fake LS）：\n方法 greet — Greeter  main.fake:2:7\n类 Greeter  main.fake:1:7', 'exact name first');
  const wsymLang = await runLspTool(m, ws, { operation: 'workspace_symbols', query: 'libfn', language: 'fake' });
  assert.match(wsymLang.output, /函数 libfn {2}lib\.fake:1:5/);
  const none = await runLspTool(m, ws, { operation: 'hover', path: 'main.fake', line: 2, column: 1 });
  assert.match(none.output, /没有悬停信息/);

  // argument errors
  assert.match((await runLspTool(m, ws, { operation: 'definition', path: 'main.fake', line: 5 })).output, /需要 column.*或 symbol/);
  assert.match((await runLspTool(m, ws, { operation: 'definition', path: 'main.fake', line: 5, symbol: 'nothere' })).output, /第 5 行未找到标识符 “nothere”/);
  assert.match((await runLspTool(m, ws, { operation: 'definition', path: 'main.fake', line: 99, column: 1 })).output, /行号 99 超出范围/);
  assert.match((await runLspTool(m, ws, { operation: 'rename', path: 'main.fake' })).output, /未知操作：rename/);
  assert.match((await runLspTool(m, ws, { operation: 'symbols' })).output, /需要 path/);
  assert.match((await runLspTool(m, ws, { operation: 'symbols', path: 'nope/missing.fake' })).output, /文件不存在/);
  assert.match((await runLspTool(m, ws, { operation: 'workspace_symbols' })).output, /需要 query/);

  // no server installed → install hint; unknown file type → clear message
  const miss = await runLspTool(m, ws, { operation: 'diagnostics', path: 'x.nope' });
  assert.equal(miss.ok, false);
  assert.ok(miss.output.startsWith('未检测到 Nope 的语言服务器'), miss.output);
  assert.ok(miss.output.includes(`- ${installHint(missingDef)}`), miss.output);
  assert.match(miss.output, /search \/ outline/);
  assert.match((await runLspTool(m, ws, { operation: 'symbols', path: 'x.xyz' })).output, /暂无可处理 \.xyz 的语言服务器/);

  // per-server and global toggles (running servers are stopped)
  m.setServerEnabled('fake', false);
  assert.equal((await serverOf(m)).enabled, false);
  assert.match((await runLspTool(m, ws, { operation: 'diagnostics', path: 'main.fake' })).output, /均已在设置中停用/);
  await waitFor(() => !m.logs('fake').length || logged(m, 'shutdown'), 5000, 'stopped on disable');
  m.setServerEnabled('fake', true);
  m.setConfig({ enabled: false });
  assert.match((await runLspTool(m, ws, { operation: 'symbols', path: 'main.fake' })).output, /LSP 语言服务已在设置中关闭/);
  m.setConfig({ enabled: true });
  assert.equal((await runLspTool(m, ws, { operation: 'symbols', path: 'main.fake' })).ok, true);
  await m.dispose();
});

test('crash: restart with backoff and retry once; give up after maxRestarts until restart()', async () => {
  const { dir, ws } = makeWs();
  const m = manager({ workspace: ws, registry: [fakeDef()], config: { ...FAST, maxRestarts: 2, restartBackoffMs: 20 } });
  await m.diagnostics('main.fake', 3000);
  const pid1 = (await serverOf(m)).instances[0].pid;
  fs.writeFileSync(path.join(dir, '.crash-once'), '');
  const h = await m.hover('main.fake', 8, 2); // the server dies on this request, is restarted, and the request is retried
  assert.match(h.text, /^\*\*boom\*\*/);
  let s = await serverOf(m);
  assert.equal(s.instances[0].state, 'running');
  assert.equal(s.instances[0].crashes, 1);
  assert.notEqual(s.instances[0].pid, pid1);
  assert.match(s.lastError ?? '', /code=3/);
  assert.match(s.lastError ?? '', /crashing \(once\)/);
  assert.ok(logged(m, 'didOpen main.fake v1 lang=fake'), 'documents reopened in the new process');

  fs.writeFileSync(path.join(dir, '.crash-always'), '');
  await assert.rejects(m.hover('main.fake', 8, 2), /连接断开/);
  s = await serverOf(m);
  assert.equal(s.instances[0].state, 'failed');
  assert.equal(s.instances[0].crashes, 3);
  const r = await runLspTool(m, ws, { operation: 'hover', path: 'main.fake', line: 8, column: 2 });
  assert.equal(r.ok, false);
  assert.match(r.output, /崩溃 3 次，已停止自动重启：.*crashing \(always\)/);
  assert.match((await runLspTool(m, ws, { operation: 'symbols', path: 'main.fake' })).output, /已停止自动重启/, 'stays down');

  fs.rmSync(path.join(dir, '.crash-always'));
  await m.restart('fake');
  assert.match((await m.hover('main.fake', 8, 2)).text, /^\*\*boom\*\*/);
  s = await serverOf(m);
  assert.equal(s.instances[0].state, 'running');
  assert.equal(s.instances[0].crashes, 0);
  await m.dispose();
});

test('idle: documents closed after docIdleMs, server stopped after idleMs and restarted lazily; editor pins stay open', async () => {
  const { ws } = makeWs();
  const m = manager({ workspace: ws, registry: [fakeDef()], config: { ...FAST, idleMs: 700, docIdleMs: 150 } });
  await m.diagnostics('main.fake', 3000);
  await waitFor(() => logged(m, 'didClose main.fake'), 3000, 'document idle close');
  for (let i = 0; i < 200 && (await serverOf(m)).running; i++) await sleep(25);
  const s = await serverOf(m);
  assert.equal(s.running, false, 'idle server stopped');
  assert.equal(s.instances[0].state, 'stopped');
  assert.ok(logged(m, 'shutdown'), 'graceful shutdown request');

  assert.equal((await m.diagnostics('main.fake', 3000)).diagnostics.length, 2, 'lazily restarted');
  m.setConfig({ idleMs: 60_000 });
  const w = await m.watchFile('main.fake', 3000);
  assert.equal(w.diagnostics.length, 2);
  await sleep(450);
  assert.ok(!logged(m, 'didClose main.fake'), 'pinned document not idle-closed');
  m.unwatchFile('main.fake');
  await waitFor(() => logged(m, 'didClose main.fake'), 3000, 'closed after unpin');
  await m.dispose();
});

test('pull diagnostics (textDocument/diagnostic) with resultId / unchanged, when the server advertises it', async () => {
  const { dir, ws } = makeWs();
  const m = manager({ workspace: ws, registry: [fakeDef(['--pull'])], config: FAST });
  const a = await m.diagnostics('main.fake');
  assert.equal(a.mode, 'pull');
  assert.equal(a.diagnostics.length, 2);
  const b = await m.diagnostics('main.fake');
  assert.deepEqual(b.diagnostics, a.diagnostics);
  assert.ok(logged(m, 'pull main.fake prev=- id=fake') && logged(m, 'pull main.fake prev=1 id=fake'), 'previousResultId sent');
  fs.writeFileSync(path.join(dir, 'main.fake'), 'ERROR\n');
  assert.deepEqual((await m.diagnostics('main.fake')).diagnostics.map((d) => [d.line, d.severity]), [[1, 'error']]);
  await m.dispose();
});

test('workspace switch: servers of the previous workspace are stopped', async () => {
  const one = makeWs();
  const two = makeWs();
  let cur = one.ws;
  const m = manager({ workspace: () => cur, registry: [fakeDef()], config: FAST });
  await m.diagnostics('main.fake', 3000);
  const pid = (await serverOf(m)).instances[0].pid!;
  cur = two.ws;
  await m.diagnostics('main.fake', 3000);
  await waitFor(() => !pidAlive(pid), 5000, 'old server stopped');
  const s = await serverOf(m);
  assert.equal(s.instances.length, 1);
  assert.equal(s.instances[0].root, '.');
  await m.dispose();
});

// ───────────── real server (only when installed on this machine) ─────────────
clearDetectCache();
const PYRIGHT = findExecutable('pyright-langserver');
test('real server: pyright diagnostics, definition, hover and tool output', { skip: PYRIGHT ? false : 'pyright-langserver not on PATH' }, async () => {
  const dir = tmpDir('edict-lsp-py-');
  fs.writeFileSync(path.join(dir, 'util.py'), 'def add(a: int, b: int) -> int:\n    return a + b\n');
  fs.writeFileSync(path.join(dir, 'main.py'), 'from util import add\n\ntotal: int = add(1, 2)\nname: str = add(1, 2)\n');
  const ws = new Workspace(dir);
  const m = manager({ workspace: ws, config: { probeVersion: false } });
  const d = await m.diagnostics('main.py', 30000);
  assert.equal(d.server, 'pyright');
  const errors = d.diagnostics.filter((x) => x.severity === 'error');
  assert.equal(errors.length, 1, JSON.stringify(d.diagnostics));
  assert.equal(errors[0].line, 4);
  assert.match(errors[0].message, /str/);
  const def = await m.definition('main.py', 3, 14);
  assert.deepEqual(def.locations.map((l) => [l.path, l.line, l.column, l.external]), [['util.py', 1, 5, false]]);
  assert.match((await m.hover('main.py', 3, 14)).text, /def add\(\s*a: int,\s*b: int\s*\) -> int/);
  const out = await runLspTool(m, ws, { operation: 'diagnostics', path: 'main.py' });
  assert.match(out.output, /^main\.py（Pyright）：1 个错误，0 个警告\nmain\.py:4:13 错误/);
  const st = await serverOf(m, 'pyright');
  assert.equal(st.path, PYRIGHT);
  assert.equal(st.running, true);
  await m.dispose();
});
