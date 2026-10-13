#!/usr/bin/env node
// TEST FIXTURE — a tiny language server over stdio (LSP 3.17: Content-Length framed JSON-RPC 2.0), written
// for Edict's tests from the public spec. Language "fake" (*.fake): `def NAME` / `class NAME` declare symbols
// (indented defs nest under the class above), every other whole-word NAME is a reference; lines containing
// ERROR / WARN produce diagnostics. Definition of `outside` points outside the workspace (LocationLink).
// Hover on `boom` exits(3) when <root>/.crash-once (deleted first) or <root>/.crash-always exists.
// Flags: --pull (advertise pull diagnostics instead of pushing), --chop (write output in tiny delayed fragments).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PULL = process.argv.includes('--pull');
const CHOP = process.argv.includes('--chop');
let root = null;
let shutdownRequested = false;
const docs = new Map(); // uri -> { text, version }
const waiting = new Map();
let nextId = 1;

// ── output (optionally fragmented to exercise the client's framing)
let out = Promise.resolve();
function write(m) {
  const body = Buffer.from(JSON.stringify(m), 'utf8');
  const all = Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]);
  if (!CHOP) return void process.stdout.write(all);
  out = out.then(async () => {
    for (let i = 0; i < all.length; i += 7) {
      process.stdout.write(all.subarray(i, i + 7));
      await new Promise((r) => setTimeout(r, 1));
    }
  });
}
const reply = (id, result) => write({ jsonrpc: '2.0', id, result });
const log = (message) => write({ jsonrpc: '2.0', method: 'window/logMessage', params: { type: 3, message } });
const request = (method, params) =>
  new Promise((resolve) => {
    const id = `srv-${nextId++}`;
    waiting.set(id, resolve);
    write({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
  });

// ── input
let buf = Buffer.alloc(0);
process.stdin.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  for (;;) {
    const sep = buf.indexOf('\r\n\r\n');
    if (sep < 0) return;
    const len = Number(/Content-Length:\s*(\d+)/i.exec(buf.subarray(0, sep).toString('ascii'))?.[1]);
    if (buf.length < sep + 4 + len) return;
    const msg = JSON.parse(buf.subarray(sep + 4, sep + 4 + len).toString('utf8'));
    buf = buf.subarray(sep + 4 + len);
    handle(msg);
  }
});
process.stdin.on('end', () => process.exit(0));

// ── language model
const rel = (uri) => (root ? path.relative(root, fileURLToPath(uri)) : uri);
function allFiles() {
  const files = new Map();
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.fake')) files.set(pathToFileURL(p).href, fs.readFileSync(p, 'utf8'));
    }
  };
  if (root) walk(root);
  for (const [uri, d] of docs) files.set(uri, d.text); // open documents win over disk
  return files;
}
const textOf = (uri) => docs.get(uri)?.text ?? '';
function wordAt(text, pos) {
  const line = text.split('\n')[pos.line] ?? '';
  let s = pos.character;
  let e = pos.character;
  while (s > 0 && /\w/.test(line[s - 1])) s--;
  while (e < line.length && /\w/.test(line[e])) e++;
  return { word: line.slice(s, e), range: { start: { line: pos.line, character: s }, end: { line: pos.line, character: e } } };
}
function declarations() {
  const out = [];
  for (const [uri, text] of allFiles()) {
    let container = null;
    text.split('\n').forEach((l, i) => {
      const m = /^(\s*)(def|class)\s+(\w+)/.exec(l);
      if (!m) return;
      const nested = m[1].length > 0 && container;
      if (!m[1].length) container = m[2] === 'class' ? m[3] : null;
      const c = l.indexOf(m[3], m[1].length + m[2].length);
      out.push({ uri, name: m[3], kind: m[2] === 'class' ? 5 : nested ? 6 : 12, line: i, container: nested ? container : undefined, range: { start: { line: i, character: c }, end: { line: i, character: c + m[3].length } }, full: { start: { line: i, character: 0 }, end: { line: i, character: l.length } } });
    });
  }
  return out;
}
function diagnosticsFor(text) {
  const items = [];
  text.split('\n').forEach((l, i) => {
    for (const [word, severity, code] of [['ERROR', 1, 'E1'], ['WARN', 2, 'W1']]) {
      const c = l.indexOf(word);
      if (c >= 0) items.push({ range: { start: { line: i, character: c }, end: { line: i, character: c + word.length } }, severity, code, source: 'fake', message: severity === 1 ? `假错误：${word}\n第二行说明` : `假警告：${word}` });
    }
  });
  return items;
}
function publish(uri) {
  if (PULL) return;
  const d = docs.get(uri);
  setTimeout(() => write({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri, version: d?.version, diagnostics: d ? diagnosticsFor(d.text) : [] } }), 15);
}

async function afterInitialized() {
  const cfg = await request('workspace/configuration', { items: [{ section: 'fake' }, { section: 'fake.other' }] });
  log(`configuration -> ${JSON.stringify(cfg.result)}`);
  const reg = await request('client/registerCapability', { registrations: [{ id: 'r1', method: 'workspace/didChangeWatchedFiles', registerOptions: {} }] });
  log(`register -> ${JSON.stringify(reg.result)}`);
  const prog = await request('window/workDoneProgress/create', { token: 'idx' });
  log(`progress -> ${JSON.stringify(prog.result)}`);
  write({ jsonrpc: '2.0', method: '$/progress', params: { token: 'idx', value: { kind: 'begin', title: '索引' } } });
  setTimeout(() => write({ jsonrpc: '2.0', method: '$/progress', params: { token: 'idx', value: { kind: 'end' } } }), 20);
  const folders = await request('workspace/workspaceFolders');
  log(`folders -> ${JSON.stringify(folders.result)}`);
  const unknown = await request('fake/unknownRequest', {});
  log(`unknown -> ${unknown.error?.code}`);
}

function handle(m) {
  if (m.id !== undefined && !m.method) {
    waiting.get(m.id)?.(m);
    waiting.delete(m.id);
    return;
  }
  const p = m.params ?? {};
  switch (m.method) {
    case 'initialize': {
      root = p.rootUri ? fileURLToPath(p.rootUri) : null;
      const caps = p.capabilities ?? {};
      reply(m.id, {
        capabilities: {
          textDocumentSync: { openClose: true, change: 1, save: { includeText: false } },
          definitionProvider: true, referencesProvider: true, hoverProvider: true, documentSymbolProvider: true, workspaceSymbolProvider: true,
          ...(PULL ? { diagnosticProvider: { identifier: 'fake', interFileDependencies: false, workspaceDiagnostics: false } } : {}),
        },
        serverInfo: { name: 'fake-lsp', version: '0.0.1' },
      });
      log(`init root=${root} folders=${p.workspaceFolders?.length} hierarchical=${caps.textDocument?.documentSymbol?.hierarchicalDocumentSymbolSupport} pid=${typeof p.processId}`);
      return;
    }
    case 'initialized':
      return void afterInitialized();
    case 'textDocument/didOpen':
      docs.set(p.textDocument.uri, { text: p.textDocument.text, version: p.textDocument.version });
      log(`didOpen ${rel(p.textDocument.uri)} v${p.textDocument.version} lang=${p.textDocument.languageId}`);
      return publish(p.textDocument.uri);
    case 'textDocument/didChange': {
      const d = docs.get(p.textDocument.uri);
      d.text = p.contentChanges.at(-1).text;
      d.version = p.textDocument.version;
      log(`didChange ${rel(p.textDocument.uri)} v${d.version}`);
      return publish(p.textDocument.uri);
    }
    case 'textDocument/didSave':
      return log(`didSave ${rel(p.textDocument.uri)}`);
    case 'textDocument/didClose':
      docs.delete(p.textDocument.uri);
      log(`didClose ${rel(p.textDocument.uri)}`);
      return publish(p.textDocument.uri);
    case 'workspace/didChangeWatchedFiles':
      return log(`watched ${p.changes.map((c) => `${rel(c.uri)}:${c.type}`).join(',')}`);
    case 'workspace/didChangeConfiguration':
      return;
    case 'textDocument/diagnostic': {
      const d = docs.get(p.textDocument.uri);
      log(`pull ${rel(p.textDocument.uri)} prev=${p.previousResultId ?? '-'} id=${p.identifier}`);
      if (d && p.previousResultId === String(d.version)) return reply(m.id, { kind: 'unchanged', resultId: String(d.version) });
      return reply(m.id, { kind: 'full', resultId: String(d?.version ?? 0), items: diagnosticsFor(textOf(p.textDocument.uri)) });
    }
    case 'textDocument/definition': {
      const { word, range } = wordAt(textOf(p.textDocument.uri), p.position);
      if (word === 'outside') {
        const t = { start: { line: 9, character: 4 }, end: { line: 9, character: 11 } };
        return reply(m.id, [{ originSelectionRange: range, targetUri: pathToFileURL('/definitely/outside/lib.fake').href, targetRange: t, targetSelectionRange: t }]);
      }
      return reply(m.id, declarations().filter((d) => d.name === word).map((d) => ({ uri: d.uri, range: d.range })));
    }
    case 'textDocument/references': {
      const { word } = wordAt(textOf(p.textDocument.uri), p.position);
      const out = [];
      if (word)
        for (const [uri, text] of allFiles())
          text.split('\n').forEach((l, i) => {
            for (const mm of l.matchAll(new RegExp(`\\b${word}\\b`, 'g'))) out.push({ uri, range: { start: { line: i, character: mm.index }, end: { line: i, character: mm.index + word.length } } });
          });
      return reply(m.id, out);
    }
    case 'textDocument/hover': {
      const { word, range } = wordAt(textOf(p.textDocument.uri), p.position);
      if (word === 'boom' && root) {
        const once = path.join(root, '.crash-once');
        if (fs.existsSync(once)) {
          fs.unlinkSync(once);
          process.stderr.write('fake-lsp: crashing (once)\n');
          process.exit(3);
        }
        if (fs.existsSync(path.join(root, '.crash-always'))) {
          process.stderr.write('fake-lsp: crashing (always)\n');
          process.exit(3);
        }
      }
      if (!word) return reply(m.id, null);
      const n = declarations().filter((d) => d.name === word).length;
      return reply(m.id, { contents: { kind: 'markdown', value: `**${word}** — 中文悬停说明（${n} 处声明）` }, range });
    }
    case 'textDocument/documentSymbol': {
      const decl = declarations().filter((d) => d.uri === p.textDocument.uri);
      const top = [];
      for (const d of decl) {
        const sym = { name: d.name, detail: d.kind === 5 ? 'class' : `${d.name}()`, kind: d.kind, range: d.full, selectionRange: d.range, children: [] };
        if (d.container && top.length && top.at(-1).name === d.container) top.at(-1).children.push(sym);
        else top.push(sym);
      }
      return reply(m.id, top);
    }
    case 'workspace/symbol': {
      const q = String(p.query ?? '').toLowerCase();
      return reply(m.id, declarations().filter((d) => d.name.toLowerCase().includes(q)).map((d) => ({ name: d.name, kind: d.kind, containerName: d.container, location: { uri: d.uri, range: d.range } })));
    }
    case 'shutdown':
      shutdownRequested = true;
      log('shutdown');
      return reply(m.id, null);
    case 'exit':
      return process.exit(shutdownRequested ? 0 : 1);
    default:
      if (m.id !== undefined) write({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: `method not found: ${m.method}` } });
  }
}
