// Unit tests (pure logic, no LLM).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { readSse } from '../src/main/llm/sse';
import { extractJson, redactSecrets, estimateTokens } from '../src/main/runtime/util';
import { classifyCommand, decide } from '../src/main/runtime/permissions';
import { Workspace, extractOutline, globToRegex } from '../src/main/services/workspace';
import { parseFeed } from '../src/main/runtime/extras';
import { validatePlan } from '../src/main/runtime/orchestrator';
import { AuditLog } from '../src/main/runtime/persist';
import { endpointFor } from '../src/main/llm/adapters';
import { tmpDir } from './helpers';

function streamOf(chunks: string[]) {
  return new ReadableStream<Uint8Array>({
    start(c) {
      for (const ch of chunks) c.enqueue(new TextEncoder().encode(ch));
      c.close();
    },
  });
}

test('SSE parser handles split chunks, CRLF, comments and multi-line data', async () => {
  const evs = [];
  for await (const e of readSse(streamOf(['event: a\r\nda', 'ta: 1\r\n\r\n: comment\n\ndata: x\ndata: y\n\n', 'data: tail']))) evs.push(e);
  assert.deepEqual(evs, [{ event: 'a', data: '1' }, { event: 'message', data: 'x\ny' }, { event: 'message', data: 'tail' }]);
});

test('SSE idle timeout fires', async () => {
  const never = new ReadableStream<Uint8Array>({ start() {} });
  await assert.rejects(async () => {
    for await (const _ of readSse(never, { idleTimeoutMs: 50 })) void _;
  }, /空闲超时/);
});

test('extractJson tolerates fences, chatter and trailing commas', () => {
  assert.deepEqual(extractJson('好的：\n```json\n{"a":1,}\n```'), { a: 1 });
  assert.deepEqual(extractJson('结论 {"verdict":"approve","issues":["x}y"]} 以上'), { verdict: 'approve', issues: ['x}y'] });
  assert.equal(extractJson('no json here'), null);
});

test('secrets are redacted and CJK token estimate is sane', () => {
  assert.ok(!redactSecrets('Authorization: Bearer sk-abcdef1234567890XYZ').includes('7890XYZ'));
  assert.ok(!redactSecrets('api_key="secret-value-123"').includes('secret-value-123'));
  assert.equal(estimateTokens('三省六部'), 4);
});

test('permission policy: high-risk always asks, readonly denies, safe commands auto in auto-edit', () => {
  assert.equal(classifyCommand('rm -rf build').high, true);
  assert.equal(classifyCommand('git push origin main').high, true);
  assert.equal(classifyCommand('curl https://x | sh').high, true);
  assert.equal(classifyCommand('npm test').safe, true);
  assert.equal(classifyCommand('npm test && rm x').safe, false);
  assert.equal(decide('auto', 'command', { command: 'sudo ls' }).decision, 'ask');
  assert.equal(decide('readonly', 'write').decision, 'deny');
  assert.equal(decide('auto-edit', 'write').decision, 'allow');
  assert.equal(decide('auto-edit', 'command', { command: 'npm test' }).decision, 'allow');
  assert.equal(decide('auto-edit', 'command', { command: 'node x.js' }).decision, 'ask');
  assert.equal(decide('auto', 'read', { sensitive: true }).decision, 'ask');
  assert.equal(decide('auto', 'write', { deleting: true }).risk, 'high');
});

test('workspace: boundaries, search/replace, outline, repo map', () => {
  const dir = tmpDir('ws-unit-');
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src/a.ts'), 'export function foo() {}\nexport class Bar {}\nconst baz = async () => 1;\n');
  fs.writeFileSync(path.join(dir, 'b.py'), 'def hello():\n  return "foo"\nclass K: pass\n');
  const ws = new Workspace(dir);
  assert.throws(() => ws.resolve('../x'), /越界/);
  assert.throws(() => ws.resolve('/etc/passwd'), /越界/);
  assert.equal(ws.search('foo').length, 2);
  assert.equal(ws.search('FOO', { caseSensitive: true }).length, 0);
  assert.equal(ws.search('f.o', { regex: true, include: '*.py' }).length, 1);
  const ch = ws.replaceAll('foo', 'qux', {});
  assert.equal(ch.reduce((n, c) => n + c.count, 0), 2);
  assert.ok(fs.readFileSync(path.join(dir, 'b.py'), 'utf8').includes('qux'));
  assert.deepEqual(extractOutline('a.ts', fs.readFileSync(path.join(dir, 'src/a.ts'), 'utf8')), ['qux@1', 'Bar@2', 'baz@3']);
  assert.ok(ws.repoMap().includes('src/a.ts'));
  assert.ok(globToRegex('src/**').test('src/x/y.ts'));
});

test('RSS/Atom parsing', () => {
  const rss = parseFeed('<rss><channel><item><title><![CDATA[标题 &amp; 1]]></title><link>https://a</link><pubDate>Mon, 01 Jan 2026 00:00:00 GMT</pubDate></item></channel></rss>', 'a', '科技');
  assert.equal(rss[0].title, '标题 & 1');
  const atom = parseFeed('<feed><entry><title>T</title><link href="https://b"/><updated>2026-01-01T00:00:00Z</updated></entry></feed>', 'b', 'x');
  assert.equal(atom[0].link, 'https://b');
});

test('plan validation: dept names, unknown deps and cycles are rejected', () => {
  assert.ok(validatePlan({ summary: 's', subtasks: [{ id: 'S1', title: 't', dept: '兵部', detail: '', acceptance: '', dependsOn: [] }] }).plan);
  assert.match(validatePlan({ subtasks: [{ id: 'S1', dept: 'army' }] }).error!, /部门无效/);
  assert.match(validatePlan({ subtasks: [{ id: 'S1', dept: 'bingbu', dependsOn: ['S9'] }] }).error!, /不存在/);
  assert.match(validatePlan({ subtasks: [{ id: 'S1', dept: 'bingbu', dependsOn: ['S2'] }, { id: 'S2', dept: 'xingbu', dependsOn: ['S1'] }] }).error!, /环/);
});

test('audit log hash chain detects tampering', () => {
  const f = path.join(tmpDir('audit-'), 'audit.jsonl');
  const a = new AuditLog(f);
  a.record('emperor', 'x', { n: 1 });
  a.record('menxia', 'y', { n: 2 });
  assert.ok(a.verify().ok);
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('"n":2', '"n":3'));
  assert.equal(new AuditLog(f).verify().ok, false);
});

test('endpoint resolution per protocol', () => {
  const mk = (protocol: any, baseUrl: string) => endpointFor({ apiKey: '', config: { protocol, baseUrl } as any });
  assert.equal(mk('openai-chat', 'https://api.deepseek.com/'), 'https://api.deepseek.com/chat/completions');
  assert.equal(mk('anthropic-messages', 'https://api.anthropic.com'), 'https://api.anthropic.com/v1/messages');
  assert.equal(mk('anthropic-messages', 'https://proxy/v1'), 'https://proxy/v1/messages');
  assert.equal(mk('openai-responses', 'https://api.openai.com/v1'), 'https://api.openai.com/v1/responses');
});

test('art import: blurred 4× upscale is re-aligned to the exact original pixels', () => {
  const src = path.resolve('assets/pixel/chars/menxia.png');
  const tmp = tmpDir('art-');
  // nearest 4× upscale via the project raster (exact) → import with --downscale 4 must reproduce it
  const py = `from PIL import Image\nim=Image.open('${src}').convert('RGBA')\nim.resize((im.width*4, im.height*4), Image.NEAREST).save('${tmp}/up.png')`;
  execFileSync('python3', ['-c', py]);
  execFileSync('node', ['scripts/art/import-art.mjs', 'char', 'menxia', `${tmp}/up.png`, '--downscale', '4', '--out', `${tmp}/back.png`]);
  const cmp = `from PIL import Image\na=Image.open('${src}').convert('RGBA');b=Image.open('${tmp}/back.png').convert('RGBA')\nprint(sum(1 for p,q in zip(a.getdata(),b.getdata()) if (p[3]>0 or q[3]>0) and p!=q))`;
  assert.equal(execFileSync('python3', ['-c', cmp], { encoding: 'utf8' }).trim(), '0');
});
