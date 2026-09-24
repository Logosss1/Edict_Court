// MCP client/manager (integration: real child process over stdio + real local HTTP servers; LLM is MOCK).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { startMockLlm, defaultBrain } from './mockLlm';
import { makeRuntime, tmpDir, waitFor, stateOf } from './helpers';
import { parseMcpConfig, interpolate, extractSecrets, exposedName } from '../src/main/mcp/manager';
import { executeTool } from '../src/main/runtime/tools';
import { submit } from '../src/main/runtime/orchestrator';

const FIXTURE = path.resolve('tests/fixtures/mcp-echo-server.mjs');
const stdioCfg = (extra: Record<string, unknown> = {}) => JSON.stringify({ mcpServers: { demo: { command: process.execPath, args: [FIXTURE], env: { ECHO_PREFIX: 'P' }, ...extra } } });

test('config: Cursor + VS Code shapes, validation, interpolation, secret extraction, exposed names', () => {
  assert.deepEqual(Object.keys(parseMcpConfig('{"servers":{"a":{"url":"https://x/mcp"}}}').mcpServers), ['a']);
  assert.throws(() => parseMcpConfig('{"mcpServers":{"bad name!":{"command":"x"}}}'), /服务名不合法/);
  assert.throws(() => parseMcpConfig('{"mcpServers":{"a":{}}}'), /command/);
  assert.throws(() => parseMcpConfig('{"mcpServers":{"a":{"url":"file:///x"}}}'), /http/);
  process.env.EDICT_T = 'v1';
  assert.equal(interpolate('${env:EDICT_T}|${workspaceFolderBasename}|${secret:a/b}|${/}', { workspace: '/tmp/proj', secret: (id) => (id === 'a/b' ? 'S' : null) }), `v1|proj|S|${path.sep}`);
  const cfg = parseMcpConfig(JSON.stringify({ mcpServers: { gh: { command: 'npx', args: ['server', '--api-key=abc123'], env: { GITHUB_TOKEN: 'ghp_realtoken123', DEBUG: '1', PATHY: '${env:HOME}' } }, remote: { url: 'https://x/mcp', headers: { Authorization: 'Bearer abcdefghijklmnop' } } } }));
  const store = new Map<string, string>();
  const moved = extractSecrets(cfg, (id, v) => store.set(id, v));
  assert.equal(cfg.mcpServers.gh.env!.GITHUB_TOKEN, '${secret:gh/env/GITHUB_TOKEN}');
  assert.equal(cfg.mcpServers.gh.env!.DEBUG, '1');
  assert.equal(cfg.mcpServers.gh.env!.PATHY, '${env:HOME}');
  assert.equal(cfg.mcpServers.gh.args![1], '--api-key=${secret:gh/args/1}');
  assert.equal(cfg.mcpServers.remote.headers!.Authorization, '${secret:remote/headers/Authorization}');
  assert.equal(store.get('gh/env/GITHUB_TOKEN'), 'ghp_realtoken123');
  assert.equal(moved.length, 3);
  assert.ok(!JSON.stringify(cfg).includes('ghp_realtoken123'));
  const long = exposedName('a-very-long-server-name-indeed', 'and_an_even_longer_tool_name_that_goes_on_and_on_and_on');
  assert.ok(long.length <= 64 && /^mcp__[\w-]+$/.test(long));
  assert.equal(exposedName('my.server', 'do thing'), 'mcp__my_server__do_thing');
});

test('stdio server: untrusted until approved, then initialize + paginated tools/list + calls + roots (real child process)', async () => {
  const mock = await startMockLlm();
  const rt = makeRuntime(mock.url);
  const ws = tmpDir('edict-ws-');
  rt.setWorkspace(ws);
  rt.mcp.load(false);
  const r = rt.mcp.saveConfig(stdioCfg()); // not trusted
  assert.deepEqual(r.untrusted, ['demo']);
  await waitFor(() => rt.mcp.states.get('demo')?.status === 'untrusted', 5000, 'untrusted');
  rt.mcp.trust('demo');
  await waitFor(() => rt.mcp.states.get('demo')?.status === 'ok' || rt.mcp.states.get('demo')?.status === 'error', 15000, 'connected');
  const st = rt.mcp.states.get('demo')!;
  assert.equal(st.status, 'ok', st.error);
  assert.equal(st.transport, 'stdio');
  assert.equal(st.serverInfo?.name, 'echo-fixture');
  assert.deepEqual(st.tools.map((t) => t.name), ['echo', 'add', 'delete_everything', 'fail', 'roots'], 'both pages listed');
  assert.equal(st.tools.find((t) => t.name === 'echo')!.policy.risk, 'read');
  assert.equal(st.tools.find((t) => t.name === 'delete_everything')!.policy.risk, 'high');
  assert.equal(st.tools.find((t) => t.name === 'add')!.policy.risk, 'write');
  await waitFor(() => st.logs.some((l) => l.text.includes('echo-server booting')), 3000, 'stderr captured');
  // calls through the agent tool path (permission mode auto in tests)
  const echo = await executeTool({ rt, agentId: 'bingbu' }, 'mcp__demo__echo', { text: 'hi' });
  assert.deepEqual(echo, { ok: true, output: 'P:hi' });
  const add = await executeTool({ rt, agentId: 'bingbu' }, 'mcp__demo__add', { a: 2, b: 40 });
  assert.equal(add.output, '42');
  const fail = await executeTool({ rt, agentId: 'bingbu' }, 'mcp__demo__fail', {});
  assert.equal(fail.ok, false);
  assert.match(fail.output, /boom/);
  const roots = await executeTool({ rt, agentId: 'bingbu' }, 'mcp__demo__roots', {});
  assert.ok(roots.output.includes(fs.realpathSync(ws)) || roots.output.includes(ws), 'server asked roots/list and got the workspace');
  // read-only toolsets only see read-risk tools
  assert.deepEqual(rt.mcp.toolSpecsFor('zhongshu', true).map((t) => t.name), ['mcp__demo__echo', 'mcp__demo__roots']);
  assert.equal(rt.mcp.toolSpecsFor('bingbu', false).length, 5);
  // agent grants
  rt.mcp.setServerPolicy('demo', { agents: ['xingbu'] });
  assert.equal(rt.mcp.toolSpecsFor('bingbu', false).length, 0);
  assert.match((await executeTool({ rt, agentId: 'bingbu' }, 'mcp__demo__echo', { text: 'x' })).output, /未获授权/);
  rt.mcp.setServerPolicy('demo', { agents: 'all' });
  // disabled tool
  rt.mcp.setToolPolicy('demo', 'add', { enabled: false });
  assert.match((await executeTool({ rt, agentId: 'bingbu' }, 'mcp__demo__add', { a: 1, b: 1 })).output, /已停用/);
  // high risk always asks — even in auto mode; deny it
  const pending = executeTool({ rt, agentId: 'bingbu' }, 'mcp__demo__delete_everything', {});
  const ap = await waitFor(() => [...rt.approvals.values()].find((a) => a.tool === 'mcp__demo__delete_everything'), 5000, 'approval');
  assert.equal(ap.risk, 'high');
  rt.decideApproval(ap.id, false);
  assert.match((await pending).output, /未批准/);
  // readonly mode denies non-read tools
  rt.updateSettings({ permissionMode: 'readonly' });
  assert.match((await executeTool({ rt, agentId: 'bingbu' }, 'mcp__demo__fail', {})).output, /只读/);
  assert.equal((await executeTool({ rt, agentId: 'bingbu' }, 'mcp__demo__echo', { text: 'ok' })).ok, true);
  rt.updateSettings({ permissionMode: 'auto' });
  // changing the command line requires trust again
  rt.mcp.saveConfig(stdioCfg({ args: [FIXTURE, '--changed'] }));
  await waitFor(() => rt.mcp.states.get('demo')?.status === 'untrusted', 5000, 'untrusted after change');
  const audit = fs.readFileSync(path.join(rt.opts.dataDir, 'audit.jsonl'), 'utf8');
  assert.ok(audit.includes('"mcp_call"') && audit.includes('"mcp_trusted"'));
  rt.dispose();
  await mock.close();
});

test('secrets typed into mcp.json are moved to the SecretStore and still reach the server', async () => {
  const mock = await startMockLlm();
  const rt = makeRuntime(mock.url);
  rt.mcp.load(false);
  const r = rt.mcp.saveConfig(JSON.stringify({ mcpServers: { demo: { command: process.execPath, args: [FIXTURE], env: { ECHO_PREFIX: 'sk-live-SECRET-999' } } } }), ['demo']);
  assert.deepEqual(r.moved, ['demo.env.ECHO_PREFIX']);
  const onDisk = fs.readFileSync(rt.mcp.configPath, 'utf8');
  assert.ok(!onDisk.includes('SECRET-999') && onDisk.includes('${secret:demo/env/ECHO_PREFIX}'));
  await waitFor(() => rt.mcp.states.get('demo')?.status === 'ok', 15000, 'connected');
  assert.equal((await executeTool({ rt, agentId: 'solo' }, 'mcp__demo__echo', { text: 'x' })).output, 'sk-live-SECRET-999:x');
  const audit = fs.readFileSync(path.join(rt.opts.dataDir, 'audit.jsonl'), 'utf8');
  assert.ok(!audit.includes('SECRET-999'), 'secret never in audit');
  rt.dispose();
  await mock.close();
});

/** Minimal HTTP MCP server for tests: Streamable HTTP (JSON or SSE replies) and legacy HTTP+SSE. */
async function httpMcp(mode: 'json' | 'sse' | 'legacy') {
  let sseRes: http.ServerResponse | null = null;
  const seen: { method: string; session?: string; version?: string; auth?: string }[] = [];
  const handle = (m: any) => {
    if (m.method === 'initialize') return { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: `http-${mode}`, version: '1' } };
    if (m.method === 'tools/list') return { tools: [{ name: 'time', description: 'now', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } }] };
    if (m.method === 'tools/call') return { content: [{ type: 'text', text: `tick-${mode}` }] };
    return {};
  };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      if (mode === 'legacy') {
        if (req.method === 'GET' && req.url === '/sse') {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.write('event: endpoint\ndata: /messages?sid=1\n\n');
          sseRes = res;
          return;
        }
        if (req.method === 'POST' && req.url?.startsWith('/messages')) {
          const m = JSON.parse(body);
          seen.push({ method: m.method, auth: req.headers.authorization as string });
          res.writeHead(202).end();
          if (m.id !== undefined) sseRes?.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: m.id, result: handle(m) })}\n\n`);
          return;
        }
        res.writeHead(404).end();
        return;
      }
      if (req.method === 'DELETE') return res.writeHead(200).end();
      if (req.method !== 'POST') return res.writeHead(405).end();
      const m = JSON.parse(body);
      seen.push({ method: m.method, session: req.headers['mcp-session-id'] as string, version: req.headers['mcp-protocol-version'] as string, auth: req.headers.authorization as string });
      if (m.id === undefined) return res.writeHead(202).end();
      const out = { jsonrpc: '2.0', id: m.id, result: handle(m) };
      const headers: Record<string, string> = m.method === 'initialize' ? { 'mcp-session-id': 'sess-42' } : {};
      if (mode === 'sse') {
        res.writeHead(200, { ...headers, 'content-type': 'text/event-stream' });
        res.write(`event: message\ndata: ${JSON.stringify(out)}\n\n`);
        return res.end();
      }
      res.writeHead(200, { ...headers, 'content-type': 'application/json' }).end(JSON.stringify(out));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}${mode === 'legacy' ? '/sse' : '/mcp'}`, seen, close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }) };
}

for (const mode of ['json', 'sse', 'legacy'] as const) {
  test(`remote MCP over ${mode === 'legacy' ? 'legacy HTTP+SSE (auto fallback)' : `Streamable HTTP (${mode} replies)`}`, async () => {
    const srv = await httpMcp(mode);
    const mock = await startMockLlm();
    const rt = makeRuntime(mock.url);
    rt.mcp.load(false);
    rt.mcp.saveConfig(JSON.stringify({ mcpServers: { remote: { url: srv.url, headers: { Authorization: 'Bearer test-token-abcdefgh' } } } }));
    await waitFor(() => ['ok', 'error'].includes(rt.mcp.states.get('remote')?.status ?? ''), 15000, 'remote connected');
    const st = rt.mcp.states.get('remote')!;
    assert.equal(st.status, 'ok', st.error);
    assert.equal(st.transport, mode === 'legacy' ? 'sse' : 'http');
    const out = await executeTool({ rt, agentId: 'solo' }, 'mcp__remote__time', {});
    assert.equal(out.output, `tick-${mode}`);
    assert.ok(srv.seen.every((s) => s.auth === 'Bearer test-token-abcdefgh'), 'header (from keychain) sent');
    if (mode !== 'legacy') {
      const call = srv.seen.find((s) => s.method === 'tools/call')!;
      assert.equal(call.session, 'sess-42', 'Mcp-Session-Id echoed');
      assert.equal(call.version, '2025-06-18', 'MCP-Protocol-Version header');
    }
    rt.dispose();
    await mock.close();
    await srv.close();
  });
}

test('agent (mock LLM) calls an MCP tool during a Solo task; result lands in the activity stream', async () => {
  const base = defaultBrain({});
  const mock = await startMockLlm({
    brain: (c) => {
      if (c.system.includes('独相') && c.toolResults === 0) {
        assert.ok(c.tools.includes('mcp__demo__echo'), 'MCP tool offered to the agent');
        return { toolCalls: [{ name: 'mcp__demo__echo', args: { text: '朕知道了' } }] };
      }
      if (c.system.includes('独相')) return { text: '已调用。' };
      return base(c);
    },
  });
  const rt = makeRuntime(mock.url);
  rt.setWorkspace(tmpDir('edict-ws-'));
  rt.mcp.load(false);
  rt.mcp.saveConfig(stdioCfg(), ['demo']);
  await waitFor(() => rt.mcp.states.get('demo')?.status === 'ok', 15000, 'connected');
  const r = (await submit(rt, { text: '调用 demo', tier: 'solo', multiAgent: false })) as { taskId: string };
  await waitFor(() => ['Done', 'Blocked'].includes(stateOf(rt, r.taskId)), 20000, 'solo done');
  assert.equal(stateOf(rt, r.taskId), 'Done');
  const res = rt.activities(r.taskId, 200).find((a) => a.kind === 'tool_result' && a.data?.name === 'mcp__demo__echo');
  assert.equal(res?.content, 'P:朕知道了');
  rt.dispose();
  await mock.close();
});
