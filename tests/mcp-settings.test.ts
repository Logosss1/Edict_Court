// 连接服务（MCP） settings page and 下旨 pickers, pure parts: the add cards build entries the backend parses as-is,
// the "plain text vs keychain" hint agrees with extractSecrets, config merge / remove, and the / and @ triggers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractSecrets, parseMcpConfig } from '../src/main/mcp/manager';
import { findMcpRefs } from '../src/shared/mcpRefs';
import { EMPTY_LOCAL, EMPTY_REMOTE, addToConfig, argMovesToKeychain, buildLocal, buildRemote, checkUrl, parseEnvLines, parseHeaderLines, removeFromConfig, serverNames, splitCommandLine, valueFate } from '../src/renderer/settings/pages/mcpForm';
import { applyPick, filterPrompts, filterResources, resourceInsert, triggerAt } from '../src/renderer/workbench/mcpPick';
import type { McpPromptListItem, McpResourceListItem } from '../src/shared/types';

test('add remote: auth modes, transport, headers; validation of names and URLs', () => {
  const r = (p: Partial<typeof EMPTY_REMOTE>, existing: string[] = []) => buildRemote({ ...EMPTY_REMOTE, ...p }, existing);
  assert.deepEqual(r({ name: 'linear', url: 'https://mcp.linear.app/sse' }).entry, { url: 'https://mcp.linear.app/sse' }, 'auto = OAuth on demand (no auth key)');
  assert.deepEqual(r({ name: 'a', url: 'https://x.dev/mcp', transport: 'sse', auth: 'oauth', clientId: ' cid ' }).entry, { url: 'https://x.dev/mcp', type: 'sse', auth: { type: 'oauth', clientId: 'cid' } });
  assert.deepEqual(r({ name: 'a', url: 'https://x.dev/mcp', auth: 'none', headers: 'X-Api-Version: 2\n\nX-Team=core' }).entry, { url: 'https://x.dev/mcp', auth: { type: 'none' }, headers: { 'X-Api-Version': '2', 'X-Team': 'core' } });
  assert.deepEqual(r({ name: 'a', url: 'https://x.dev/mcp', auth: 'bearer', token: 'ghp_123', headers: 'X-A: b=c:d' }).entry?.headers, { Authorization: 'Bearer ghp_123', 'X-A': 'b=c:d' });
  assert.equal(r({ name: 'a', url: 'https://x.dev', auth: 'bearer', token: 'Bearer ${env:TOK}' }).entry?.headers?.Authorization, 'Bearer ${env:TOK}');

  assert.match(r({ name: '', url: 'https://x.dev' }).errors.name!, /名称/);
  assert.match(r({ name: 'bad name', url: 'https://x.dev' }).errors.name!, /字母/);
  assert.match(r({ name: 'Linear', url: 'https://x.dev' }, ['linear']).errors.name!, /同名/, 'duplicates are case-insensitive');
  assert.match(r({ name: 'a', url: 'ftp://x' }).errors.url!, /https/);
  assert.match(r({ name: 'a', url: 'https://' }).errors.url!, /格式|主机/);
  assert.match(r({ name: 'a', url: 'https://x.dev', auth: 'bearer' }).errors.token!, /令牌/);
  assert.match(r({ name: 'a', url: 'https://x.dev', auth: 'bearer', token: 't', headers: 'authorization: x' }).errors.headers!, /Authorization/);
  assert.match(r({ name: 'a', url: 'https://x.dev', headers: 'no separator' }).errors.headers!, /第 1 行/);
  assert.match(r({ name: 'a', url: 'https://x.dev', headers: 'A: 1\na: 2' }).errors.headers!, /重复/);
  assert.equal(r({ name: 'a', url: 'https://x.dev' }).entry !== undefined, true);
  assert.ok(checkUrl('http://example.com/mcp').warn, 'plain http to a remote host warns');
  assert.equal(checkUrl('http://127.0.0.1:3000/mcp').warn, undefined);
});

test('add local: a pasted command line is split, env lines parsed, errors reported', () => {
  const l = (p: Partial<typeof EMPTY_LOCAL>, existing: string[] = []) => buildLocal({ ...EMPTY_LOCAL, ...p }, existing);
  assert.deepEqual(l({ name: 'fs', command: 'npx', args: '-y\n @modelcontextprotocol/server-filesystem \n\n~/Documents' }).entry, { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '~/Documents'] });
  assert.deepEqual(l({ name: 'fs', command: `npx -y "@scope/my server" --root='/My Docs'` }).entry, { command: 'npx', args: ['-y', '@scope/my server', '--root=/My Docs'] });
  assert.deepEqual(l({ name: 'py', command: 'uvx', env: 'export API_KEY="sk-1"\n# comment\nLOG=debug' }).entry, { command: 'uvx', args: [], env: { API_KEY: 'sk-1', LOG: 'debug' } });
  assert.match(l({ name: 'py', command: '' }).errors.command!, /命令/);
  assert.match(l({ name: 'py', command: 'x', env: '1BAD=x' }).errors.env!, /KEY=VALUE/);
  assert.match(l({ name: 'py', command: 'x', env: 'A=1\nA=2' }).errors.env!, /重复/);
  assert.match(l({ name: 'fs', command: 'x' }, ['fs']).errors.name!, /同名/);
  assert.deepEqual(splitCommandLine(`a "b c" 'd e' f\\ g ""`), ['a', 'b c', 'd e', 'f g', '']);
  assert.deepEqual(parseEnvLines('A = 1 ').pairs, [{ key: 'A', value: '1' }]);
  assert.deepEqual(parseHeaderLines('X-Y : z ').pairs, [{ key: 'X-Y', value: 'z' }]);
});

test('built entries parse unchanged, and the plain-text hint matches what extractSecrets moves to the keychain', () => {
  const remote = buildRemote({ ...EMPTY_REMOTE, name: 'r', url: 'https://x.dev/mcp', auth: 'bearer', token: 'tok123', headers: 'X-Team: core\nX-Api-Key: abc\nX-Ref: ${env:REF}' }, []).entry!;
  const local = buildLocal({ ...EMPTY_LOCAL, name: 'l', command: 'node server.js --api-key=k1 --port=3', env: 'API_TOKEN=t1\nLOG_LEVEL=debug\nGH=ghp_abcdef\nHOME_DIR=${env:HOME}' }, []).entry!;
  let text = addToConfig('', 'r', remote);
  text = addToConfig(text, 'l', local);
  const cfg = parseMcpConfig(text);
  assert.deepEqual(cfg.mcpServers.r, remote);
  assert.deepEqual(cfg.mcpServers.l, local);
  const moved = extractSecrets(structuredClone(cfg), () => undefined).sort();
  const predicted = [
    ...Object.entries(remote.headers!).filter(([k, v]) => valueFate(k, v) === 'keychain').map(([k]) => `r.headers.${k}`),
    ...Object.entries(local.env!).filter(([k, v]) => valueFate(k, v) === 'keychain').map(([k]) => `l.env.${k}`),
    ...local.args!.map((a, i) => (argMovesToKeychain(a) ? `l.args[${i}]` : '')).filter(Boolean),
  ].sort();
  assert.deepEqual(moved, predicted);
  assert.deepEqual(predicted, ['l.args[1]', 'l.env.API_TOKEN', 'l.env.GH', 'r.headers.Authorization', 'r.headers.X-Api-Key']);
  assert.equal(valueFate('X-Team', 'core'), 'plain');
  assert.equal(valueFate('X-Ref', '${env:REF}'), 'reference');
});

test('config merge and removal keep the file shape (mcpServers or VS Code servers)', () => {
  const t = addToConfig('{"mcpServers":{"a":{"url":"https://a.dev"}}}', 'b', { command: 'x', args: [] });
  assert.deepEqual(serverNames(t), ['a', 'b']);
  assert.throws(() => addToConfig(t, 'b', { url: 'https://b.dev' }), /同名/);
  assert.deepEqual(serverNames(removeFromConfig(t, 'a')), ['b']);
  const vs = addToConfig('{"servers":{"a":{"url":"https://a.dev"}}}', 'c', { url: 'https://c.dev' });
  assert.deepEqual(Object.keys(JSON.parse(vs)), ['servers']);
  assert.deepEqual(serverNames(vs), ['a', 'c']);
  assert.deepEqual(serverNames('not json'), []);
});

test('下旨 pickers: / at the start of an empty line, @ after space / CJK, filtering, inserted tokens parse back', () => {
  assert.deepEqual(triggerAt('/', 1), { kind: 'prompt', start: 0, end: 1, raw: '/', query: '' });
  assert.deepEqual(triggerAt('第一行\n/rev', 8), { kind: 'prompt', start: 4, end: 8, raw: '/rev', query: 'rev' });
  assert.equal(triggerAt('看 /rev', 6), null, 'not at the start of the line');
  assert.equal(triggerAt('/rev x', 4), null, 'the line has more text after the caret');
  assert.equal(triggerAt('/usr/bin', 8), null, 'a path is not a prompt');
  assert.deepEqual(triggerAt('请看 @rea', 7), { kind: 'resource', start: 3, end: 7, raw: '@rea', query: 'rea' });
  assert.deepEqual(triggerAt('请看@', 3)?.kind, 'resource', 'right after CJK text');
  assert.equal(triggerAt('mail me@x.com', 9), null, 'emails do not open it');
  assert.equal(triggerAt('@mcp:docs/x 再说', 13), null);
  assert.equal(triggerAt('@mcp:do', 7)?.query, 'do');

  const prompts: McpPromptListItem[] = [
    { server: 'docs', name: 'greet', description: 'Say hello', arguments: [] },
    { server: 'docs', name: 'review', title: '代码审查', description: 'Review a file', arguments: [{ name: 'file', required: true }] },
  ];
  assert.deepEqual(filterPrompts(prompts, 'rev').map((p) => p.name), ['review']);
  assert.deepEqual(filterPrompts(prompts, '审查').map((p) => p.name), ['review']);
  assert.equal(filterPrompts(prompts, '').length, 2);
  const res: McpResourceListItem[] = [
    { server: 'docs', uri: 'fixture://readme', name: 'readme', title: '说明' },
    { server: 'wiki', uri: 'notes://会议 纪要', name: 'minutes' },
  ];
  assert.deepEqual(filterResources(res, 'wiki/notes').map((r) => r.name), ['minutes']);
  assert.deepEqual(filterResources(res, 'read').map((r) => r.name), ['readme']);

  const t = triggerAt('请总结 @rea', 8)!;
  const out = applyPick('请总结 @rea', t, resourceInsert(res[0]));
  assert.equal(out.text, '请总结 @mcp:docs/fixture://readme ');
  assert.equal(out.caret, out.text.length);
  const out2 = applyPick('看@m并汇报', triggerAt('看@m并汇报', 3)!, resourceInsert(res[1]));
  assert.equal(out2.text, '看@mcp:wiki/<notes://会议 纪要> 并汇报');
  assert.deepEqual(findMcpRefs(out2.text), [{ server: 'wiki', uri: 'notes://会议 纪要' }]);
  const p = triggerAt('前言\n/rev', 7)!;
  assert.equal(applyPick('前言\n/rev', p, '请审查 a.ts').text, '前言\n请审查 a.ts');
  assert.equal(applyPick('前言\n/re', p, 'X').text, '前言\n/reX', 'trigger text changed meanwhile → insert where it ended, not over other text');
});
