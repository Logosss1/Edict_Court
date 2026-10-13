// @mcp:<server>/<uri> references in an edict (composer @ picker → submit): parsing, and expansion against a real
// stdio MCP server (resources fixture) — the officials see a 【附带资源】 block; unreadable refs are noted; budget; audit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startMockLlm, defaultBrain } from './mockLlm';
import { makeRuntime, tmpDir, waitFor, stateOf } from './helpers';
import { findMcpRefs, mcpRefToken } from '../src/shared/mcpRefs';
import { expandMcpRefs, MCP_REF_BUDGET } from '../src/main/mcp/refs';
import { submit } from '../src/main/runtime/orchestrator';
import type { Task } from '../src/shared/types';

const RES_FIXTURE = path.resolve('tests/fixtures/mcp-resources-server.mjs');

test('@mcp references: parsing (bare / bracketed / punctuation / CJK), dedupe, tokens round-trip', () => {
  assert.deepEqual(findMcpRefs('看看 @mcp:docs/fixture://readme 和 @mcp:my.srv-2/file:///tmp/a.txt。'), [
    { server: 'docs', uri: 'fixture://readme' },
    { server: 'my.srv-2', uri: 'file:///tmp/a.txt' },
  ]);
  assert.deepEqual(findMcpRefs('请总结@mcp:docs/fixture://readme并汇报'), [{ server: 'docs', uri: 'fixture://readme' }], 'CJK text right after a bare ref ends it');
  assert.deepEqual(findMcpRefs('(see @mcp:docs/x://a/b), then @mcp:docs/x://a/b.'), [{ server: 'docs', uri: 'x://a/b' }], 'trailing punctuation dropped, duplicates merged');
  assert.deepEqual(findMcpRefs('@mcp:docs/<file:///My Docs/说明.md> ok'), [{ server: 'docs', uri: 'file:///My Docs/说明.md' }]);
  assert.deepEqual(findMcpRefs('mail me@mcp.example.com, or @mcp:bad name/x'), []);
  assert.equal(mcpRefToken('docs', 'fixture://readme'), '@mcp:docs/fixture://readme');
  for (const uri of ['file:///My Docs/a.md', 'wiki://Foo_(bar)', 'notes://会议纪要']) {
    const tok = mcpRefToken('docs', uri);
    assert.ok(tok.startsWith('@mcp:docs/<'), tok);
    assert.deepEqual(findMcpRefs(`前 ${tok}，后`), [{ server: 'docs', uri }], `round-trip ${uri}`);
  }
});

test('@mcp references are read when the edict is submitted: 【附带资源】 for the officials, unreadable ones noted, budget, audit', async () => {
  let soloSaw = '';
  const base = defaultBrain({});
  const mock = await startMockLlm({
    brain: (c) => {
      if (c.system.includes('独相')) {
        if (c.toolResults === 0) soloSaw = c.messages.filter((m) => m.role === 'user').map((m) => m.content).join('\n');
        return { text: '已阅。' };
      }
      return base(c);
    },
  });
  const rt = makeRuntime(mock.url);
  rt.setWorkspace(tmpDir('edict-ws-'));
  rt.mcp.load(false);
  rt.mcp.saveConfig(JSON.stringify({ mcpServers: { res: { command: process.execPath, args: [RES_FIXTURE] } } }), ['res']);
  try {
    await waitFor(() => rt.mcp.states.get('res')?.status === 'ok', 15000, 'resources server connected');

    // no references → text untouched, nothing read
    assert.deepEqual(await expandMcpRefs(rt, '普通旨意'), { text: '普通旨意', refs: [] });

    const typed = '请总结 @mcp:res/fixture://readme 并核对 @mcp:res/fixture://nope 与 @mcp:ghost/x://y，再看 @mcp:res/fixture://readme';
    const r = (await submit(rt, { text: typed, tier: 'solo', multiAgent: false })) as { kind: 'task'; taskId: string };
    await waitFor(() => ['Done', 'Blocked'].includes(stateOf(rt, r.taskId)), 20000, 'solo done');
    const task = rt.tasks.get(r.taskId) as Task;
    assert.ok(task.edict.startsWith(typed), 'the typed edict comes first, unchanged');
    assert.ok(!task.title.includes('附带资源'), 'title from the typed text');
    for (const seen of [task.edict, soloSaw]) {
      assert.match(seen, /【附带资源】/);
      assert.match(seen, /### res · fixture:\/\/readme\n【fixture:\/\/readme】 text\/markdown\n# Hello\nfixture readme/);
      assert.match(seen, /### res · fixture:\/\/nope\n（无法读取：.*Resource not found/);
      assert.match(seen, /### ghost · x:\/\/y\n（无法读取：MCP 服务 ghost 未连接）/);
      assert.equal(seen.split('### res · fixture://readme').length, 2, 'a repeated reference is read once');
    }

    // budget: a 30k-char resource is cut to the total budget, later refs are noted instead of read
    const big = await expandMcpRefs(rt, '@mcp:res/fixture://big @mcp:res/fixture://notes/1');
    assert.equal(big.refs[0].ok, true);
    assert.equal(big.refs[0].truncated, true);
    assert.ok(big.refs[0].chars <= MCP_REF_BUDGET);
    assert.equal(big.refs[1].ok, false);
    assert.match(big.text, /### res · fixture:\/\/notes\/1\n（未附带：资源内容已达 8000 字符上限/);
    assert.ok(big.text.length < MCP_REF_BUDGET + 800, `block stays within budget (${big.text.length})`);
    assert.ok(!big.text.includes('END'), 'the tail of the oversized resource is not attached');

    // audit: which refs were attached (URIs, sizes, ok), never their contents
    const audit = fs.readFileSync(path.join(rt.opts.dataDir, 'audit.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const att = audit.filter((a) => a.action === 'mcp_resources_attached');
    assert.equal(att.length, 2);
    assert.deepEqual(att[0].detail.refs.map((x: { server: string; uri: string; ok: boolean }) => `${x.server} ${x.uri} ${x.ok}`), ['res fixture://readme true', 'res fixture://nope false', 'ghost x://y false']);
    assert.ok(audit.some((a) => a.action === 'mcp_resource_read' && a.actor === 'emperor' && a.detail.uri === 'fixture://readme' && a.detail.ok === true));
    assert.ok(audit.some((a) => a.action === 'edict_submitted' && a.detail.mcpRefs === 3 && a.detail.chars === typed.length));
    assert.ok(!JSON.stringify(att).includes('fixture readme'), 'resource contents never in the audit');
  } finally {
    rt.dispose();
    await mock.close();
  }
});
