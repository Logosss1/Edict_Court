// Agent Client Protocol (ACP) tests: protocol level over in-memory streams with a fake host, the Unix
// socket server + consent, the stdio bridge, and end-to-end runs against a real Runtime with the MOCK
// LLM server (label: mock/integration).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { JsonRpcConnection, RpcError } from '../src/main/acp/connection';
import { AcpAgent, promptToText, type AcpHost, type PermissionDecision, type TurnContext } from '../src/main/acp/agent';
import { AcpServer } from '../src/main/acp/server';
import { RuntimeAcpHost } from '../src/main/acp/runtimeHost';
import type { ContentBlock, PermissionOption, SessionUpdate, StopReason } from '../src/main/acp/protocol';
import { startMockLlm, type Brain } from './mockLlm';
import { makeRuntime, tmpDir, waitFor } from './helpers';

// ───────────────────────── helpers ─────────────────────────
function pair() {
  const a2c = new PassThrough();
  const c2a = new PassThrough();
  return { agentIo: { readable: c2a, writable: a2c }, clientIo: { readable: a2c, writable: c2a }, a2c, c2a };
}

type Upd = { sessionId: string; update: SessionUpdate };
type PermReq = { sessionId: string; toolCall: { toolCallId: string; title?: string }; options: PermissionOption[] };

class TestClient {
  conn: JsonRpcConnection;
  updates: Upd[] = [];
  permissionRequests: PermReq[] = [];
  permission: (req: PermReq) => unknown = () => ({ outcome: { outcome: 'selected', optionId: 'allow_once' } });
  constructor(io: ConstructorParameters<typeof JsonRpcConnection>[0]) {
    this.conn = new JsonRpcConnection(io);
    this.conn.onNotification((m, p) => {
      if (m === 'session/update') this.updates.push(p as Upd);
    });
    this.conn.onRequest((m, p) => {
      if (m !== 'session/request_permission') throw RpcError.methodNotFound(m);
      this.permissionRequests.push(p as PermReq);
      return this.permission(p as PermReq);
    });
  }
  init(name = 'test-editor') {
    return this.conn.request<any>('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name, title: 'Test Editor', version: '1.0.0' } });
  }
  of(sessionId: string) {
    return this.updates.filter((u) => u.sessionId === sessionId).map((u) => u.update);
  }
}

const textOf = (ups: SessionUpdate[], kind: 'agent_message_chunk' | 'agent_thought_chunk' | 'user_message_chunk') =>
  ups.filter((u) => u.sessionUpdate === kind).map((u) => ((u as { content: { text?: string } }).content.text ?? '')).join('');

function lineReader(stream: PassThrough) {
  const lines: any[] = [];
  let buf = '';
  stream.on('data', (d: Buffer) => {
    buf += d.toString('utf8');
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      lines.push(JSON.parse(buf.slice(0, i)));
      buf = buf.slice(i + 1);
    }
  });
  return lines;
}

/** Scripted host: behaviour keyed on words in the prompt text. */
class FakeHost implements AcpHost {
  agentInfo = { name: 'fake-agent', title: 'Fake', version: '0.0.1' };
  supportsLoad = true;
  n = 0;
  modeOf = new Map<string, string>();
  prompts: { text: string; modeId?: string }[] = [];
  decisions: PermissionDecision[] = [];
  lateUpdateSent = false;
  modes() {
    return [{ id: 'solo', name: 'Solo 单 Agent' }, { id: 'lite', name: 'Court Lite 简化三省' }];
  }
  async newSession() {
    const sessionId = `fake-${++this.n}`;
    this.modeOf.set(sessionId, 'solo');
    return { sessionId, modeId: 'solo' };
  }
  async loadSession(req: { sessionId: string }, replay: (u: SessionUpdate) => void) {
    replay({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: '旧问题' } });
    replay({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '旧回答' } });
    return { sessionId: req.sessionId, modeId: this.modeOf.get(req.sessionId) ?? 'solo' };
  }
  setMode(id: string, m: string) {
    this.modeOf.set(id, m);
  }
  async prompt(req: { sessionId: string; text: string; modeId?: string }, ctx: TurnContext): Promise<StopReason> {
    this.prompts.push({ text: req.text, modeId: req.modeId });
    const msg = (t: string) => ctx.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: t } });
    if (req.text.includes('WAIT')) {
      msg('working…');
      await new Promise<void>((r) => ctx.signal.addEventListener('abort', () => r(), { once: true }));
      msg('wrapping up'); // allowed: before the prompt response
      setTimeout(() => {
        this.lateUpdateSent = true;
        msg('TOO LATE'); // must be dropped: after the prompt response
      }, 10);
      return 'end_turn'; // the agent must still report `cancelled`
    }
    if (req.text.includes('PERM')) {
      const risk = req.text.includes('HIGH') ? 'high' : 'normal';
      const key = risk === 'high' ? 'run_command' : 'write_file';
      for (let i = 0; i < 2; i++) {
        this.decisions.push(await ctx.requestPermission({ toolCall: { toolCallId: `t${i}`, title: `op ${i}`, kind: 'edit', status: 'pending' }, risk, key, scope: key }));
      }
      return 'end_turn';
    }
    if (req.text.includes('THROW')) throw new Error('boom');
    msg('Hello ');
    ctx.update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking' } });
    ctx.update({ sessionUpdate: 'tool_call', toolCallId: 'c1', title: '读取 a.ts', kind: 'read', status: 'pending' });
    ctx.update({ sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'completed' });
    msg('world');
    return 'end_turn';
  }
}

function fakeSetup(opts: { authorize?: (c: any) => Promise<boolean> } = {}) {
  const p = pair();
  const host = new FakeHost();
  const agent = new AcpAgent(new JsonRpcConnection(p.agentIo), { host, authorize: opts.authorize, cancelGraceMs: 2000 });
  const client = new TestClient(p.clientIo);
  return { ...p, host, agent, client };
}

// ───────────────────────── protocol level ─────────────────────────
test('acp: initialize negotiates protocol v1 and advertises capabilities', async () => {
  const { client, agent } = fakeSetup();
  const r = await client.init('zed');
  assert.equal(r.protocolVersion, 1);
  assert.deepEqual(r.authMethods, []);
  assert.equal(r.agentCapabilities.loadSession, true);
  assert.deepEqual(r.agentCapabilities.promptCapabilities, { image: false, audio: false, embeddedContext: true });
  assert.equal(r.agentInfo.name, 'fake-agent');
  assert.equal(agent.clientInfo?.name, 'zed');
  // a client asking for a newer version gets our latest (1)
  const b = fakeSetup();
  const r2 = await b.client.conn.request<any>('initialize', { protocolVersion: 7, clientInfo: { name: 'x', version: '1' } });
  assert.equal(r2.protocolVersion, 1);
});

test('acp: malformed input, requests before initialize and unknown methods get JSON-RPC errors', async () => {
  const { c2a, a2c } = fakeSetup();
  const out = lineReader(a2c);
  const send = (s: string) => c2a.write(s + '\n');
  send('this is not json');
  send('{"jsonrpc":"2.0","id":1,"method":"session/new","params":{"cwd":"/tmp","mcpServers":[]}}');
  send('[1,2]');
  send('{"jsonrpc":"1.0","id":2,"method":"initialize","params":{"protocolVersion":1}}');
  send('{"jsonrpc":"2.0","id":3}');
  // initialize split across writes, cutting a multi-byte UTF-8 character in half
  const init = Buffer.from('{"jsonrpc":"2.0","id":4,"method":"initialize","params":{"protocolVersion":1,"clientInfo":{"name":"zed","title":"编辑器","version":"1"}}}\n');
  const cut = init.indexOf(Buffer.from('编')) + 1;
  c2a.write(init.subarray(0, cut));
  c2a.write(init.subarray(cut));
  await waitFor(() => out.some((l) => l.id === 4), 2000, 'initialize');
  send('{"jsonrpc":"2.0","id":5,"method":"foo/bar","params":{}}');
  send('{"jsonrpc":"2.0","method":"_zed/whatever","params":{}}'); // unknown notification: ignored, no reply
  send('{"jsonrpc":"2.0","id":6,"method":"session/new","params":{"cwd":"relative/dir","mcpServers":[]}}');
  send('{"jsonrpc":"2.0","id":7,"method":"session/prompt","params":{"sessionId":"nope","prompt":[]}}');
  send('{"jsonrpc":"2.0","id":8,"method":"authenticate","params":{"methodId":"x"}}');
  send('{"jsonrpc":"2.0","id":9,"method":"initialize","params":{"protocolVersion":1}}');
  c2a.write('{"jsonrpc":"2.0","id":10,"method":"session/set_mode","params":{"sessionId":"nope","modeId":"solo"}}\r\n');
  send('{"jsonrpc":"2.0","id":11,"method":"session/new","params":null}');
  await waitFor(() => out.length >= 13, 2000, 'all replies');
  await new Promise((r) => setTimeout(r, 50));
  const byId = (id: number | null) => out.filter((l) => l.id === id);
  assert.equal(out.length, 13, JSON.stringify(out));
  const nulls = byId(null).map((l) => l.error.code);
  assert.deepEqual(nulls, [-32700, -32600]); // parse error, batch
  assert.equal(byId(1)[0].error.code, -32600); // before initialize
  assert.equal(byId(2)[0].error.code, -32600); // wrong jsonrpc version
  assert.equal(byId(3)[0].error.code, -32600); // neither request nor response
  assert.equal(byId(4)[0].result.protocolVersion, 1);
  assert.equal(byId(5)[0].error.code, -32601); // unknown method
  assert.equal(byId(6)[0].error.code, -32602); // cwd must be absolute
  assert.equal(byId(7)[0].error.code, -32002); // unknown session
  assert.equal(byId(8)[0].error.code, -32602); // no auth methods
  assert.equal(byId(9)[0].error.code, -32600); // initialize twice
  assert.equal(byId(10)[0].error.code, -32002); // CRLF framing tolerated
  assert.equal(byId(11)[0].error.code, -32600); // params must be structured
  for (const l of out) assert.equal(l.jsonrpc, '2.0');
});

test('acp: session/new returns modes, then available_commands_update; set_mode and slash commands', async () => {
  const { client, host } = fakeSetup();
  await client.init();
  const r = await client.conn.request<any>('session/new', { cwd: '/tmp', mcpServers: [] });
  assert.equal(r.sessionId, 'fake-1');
  assert.equal(r.modes.currentModeId, 'solo');
  assert.deepEqual(r.modes.availableModes.map((m: any) => m.id), ['solo', 'lite']);
  await waitFor(() => client.of('fake-1').some((u) => u.sessionUpdate === 'available_commands_update'), 2000, 'commands');
  const cmds = client.of('fake-1').find((u) => u.sessionUpdate === 'available_commands_update') as any;
  assert.deepEqual(cmds.availableCommands.map((c: any) => c.name), ['solo', 'lite']);
  assert.deepEqual(await client.conn.request('session/set_mode', { sessionId: 'fake-1', modeId: 'lite' }), {});
  assert.equal(host.modeOf.get('fake-1'), 'lite');
  await assert.rejects(client.conn.request('session/set_mode', { sessionId: 'fake-1', modeId: 'nope' }), (e: RpcError) => e.code === -32602);
  // "/solo" alone switches the mode and reports current_mode_update
  const sw = await client.conn.request<any>('session/prompt', { sessionId: 'fake-1', prompt: [{ type: 'text', text: '/solo' }] });
  assert.equal(sw.stopReason, 'end_turn');
  assert.ok(client.of('fake-1').some((u) => u.sessionUpdate === 'current_mode_update' && u.currentModeId === 'solo'));
  assert.equal(host.modeOf.get('fake-1'), 'solo');
  assert.equal(host.prompts.length, 0);
  // "/lite <text>" runs one turn in that mode without switching
  await client.conn.request('session/prompt', { sessionId: 'fake-1', prompt: [{ type: 'text', text: '/lite 实现登录' }] });
  assert.deepEqual(host.prompts.at(-1), { text: '实现登录', modeId: 'lite' });
  assert.equal(host.modeOf.get('fake-1'), 'solo');
  // session/load replays history before answering
  const before = client.updates.length;
  const lr = await client.conn.request<any>('session/load', { sessionId: 'fake-1', cwd: '/tmp', mcpServers: [] });
  assert.equal(lr.modes.currentModeId, 'solo');
  const replay = client.updates.slice(before).map((u) => u.update.sessionUpdate);
  assert.deepEqual(replay.slice(0, 2), ['user_message_chunk', 'agent_message_chunk']);
});

test('acp: prompt streams updates before the response; content blocks become context text', async () => {
  const { client, host } = fakeSetup();
  await client.init();
  const { sessionId } = await client.conn.request<any>('session/new', { cwd: '/tmp', mcpServers: [] });
  const prompt: ContentBlock[] = [
    { type: 'text', text: '请检查' },
    { type: 'resource_link', uri: 'file:///proj/src/a.ts', name: 'a.ts', mimeType: 'text/x-typescript' },
    { type: 'text', text: ' 并修复' },
    { type: 'resource', resource: { uri: 'file:///proj/src/b.ts', text: 'export const b = 1;\n```\n', mimeType: 'text/x-typescript' } },
  ];
  const r = await client.conn.request<any>('session/prompt', { sessionId, prompt });
  assert.equal(r.stopReason, 'end_turn');
  // every update of the turn arrived before the response resolved
  const ups = client.of(sessionId).filter((u) => u.sessionUpdate !== 'available_commands_update');
  assert.deepEqual(ups.map((u) => u.sessionUpdate), ['agent_message_chunk', 'agent_thought_chunk', 'tool_call', 'tool_call_update', 'agent_message_chunk']);
  assert.equal(textOf(ups, 'agent_message_chunk'), 'Hello world');
  const t = host.prompts[0].text;
  assert.match(t, /^请检查 @a\.ts 并修复 @b\.ts/);
  assert.match(t, /【引用的文件 \/ 资源（未附带内容，需要时请自行读取）】\n- a\.ts：\/proj\/src\/a\.ts（text\/x-typescript）/);
  assert.match(t, /【附带上下文】\n### \/proj\/src\/b\.ts\n````\nexport const b = 1;\n```\n\n````/); // fence longer than any run inside
  // host errors become JSON-RPC internal errors; a second session is independent
  await assert.rejects(client.conn.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'THROW' }] }), (e: RpcError) => e.code === -32603 && /boom/.test(e.message));
  await assert.rejects(client.conn.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: '   ' }] }), (e: RpcError) => e.code === -32602);
});

test('acp: promptToText keeps text inline and lists omitted attachments', () => {
  const t = promptToText([
    { type: 'text', text: 'look at' },
    { type: 'resource_link', uri: 'https://example.com/spec', name: 'spec', title: 'API 规范' },
    { type: 'image', data: 'AAAA', mimeType: 'image/png' },
    { type: 'resource', resource: { uri: 'file:///x/logo.png', blob: 'AAAA', mimeType: 'image/png' } },
    { type: 'mystery' } as unknown as ContentBlock,
  ]);
  assert.match(t, /^look at @API 规范 @logo\.png/);
  assert.match(t, /- API 规范：https:\/\/example\.com\/spec/);
  assert.match(t, /【已省略的附件】\n- 图片附件（image\/png；Edict 暂不支持，已忽略）\n- \/x\/logo\.png（二进制内容 image\/png，已省略）/);
});

test('acp: session/cancel ends the turn with `cancelled`; nothing is sent after the response', async () => {
  const { client, host } = fakeSetup();
  await client.init();
  const { sessionId } = await client.conn.request<any>('session/new', { cwd: '/tmp', mcpServers: [] });
  const pending = client.conn.request<any>('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'WAIT' }] });
  await waitFor(() => textOf(client.of(sessionId), 'agent_message_chunk').includes('working'), 2000, 'started');
  // a second prompt on the same session while one runs is rejected
  await assert.rejects(client.conn.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'again' }] }), (e: RpcError) => e.code === -32600);
  client.conn.notify('session/cancel', { sessionId });
  const r = await pending;
  assert.equal(r.stopReason, 'cancelled');
  assert.ok(textOf(client.of(sessionId), 'agent_message_chunk').includes('wrapping up'));
  await waitFor(() => host.lateUpdateSent, 2000, 'late update attempted');
  await new Promise((res) => setTimeout(res, 30));
  assert.ok(!textOf(client.of(sessionId), 'agent_message_chunk').includes('TOO LATE'), 'updates after the response are dropped');
  // the session is usable again
  const r2 = await client.conn.request<any>('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'hi' }] });
  assert.equal(r2.stopReason, 'end_turn');
});

test('acp: permission round trip — allow_always remembered for normal risk, never for high risk', async () => {
  const { client, host } = fakeSetup();
  await client.init();
  const { sessionId } = await client.conn.request<any>('session/new', { cwd: '/tmp', mcpServers: [] });
  client.permission = () => ({ outcome: { outcome: 'selected', optionId: 'allow_always' } });
  await client.conn.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'PERM' }] });
  assert.deepEqual(host.decisions, ['allow', 'allow']);
  assert.equal(client.permissionRequests.length, 1, 'second normal-risk request auto-allowed for this session');
  const first = client.permissionRequests[0];
  assert.equal(first.sessionId, sessionId);
  assert.equal(first.toolCall.toolCallId, 't0');
  assert.deepEqual(first.options.map((o) => o.kind), ['allow_once', 'allow_always', 'reject_once', 'reject_always']);
  // high risk: no "always allow" offered, and an allow_always answer only covers one operation
  host.decisions = [];
  await client.conn.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'PERM HIGH' }] });
  assert.deepEqual(host.decisions, ['allow', 'allow']);
  assert.equal(client.permissionRequests.length, 3, 'every high-risk operation is asked');
  assert.ok(!client.permissionRequests[1].options.some((o) => o.kind === 'allow_always'));
  // reject_always is remembered; cancelled outcome maps to cancelled; unknown option ids reject
  const b = fakeSetup();
  await b.client.init();
  const s2 = (await b.client.conn.request<any>('session/new', { cwd: '/tmp', mcpServers: [] })).sessionId;
  b.client.permission = () => ({ outcome: { outcome: 'selected', optionId: 'reject_always' } });
  await b.client.conn.request('session/prompt', { sessionId: s2, prompt: [{ type: 'text', text: 'PERM' }] });
  assert.deepEqual(b.host.decisions, ['reject', 'reject']);
  assert.equal(b.client.permissionRequests.length, 1);
  const c = fakeSetup();
  await c.client.init();
  const s3 = (await c.client.conn.request<any>('session/new', { cwd: '/tmp', mcpServers: [] })).sessionId;
  let n = 0;
  c.client.permission = () => (n++ === 0 ? { outcome: { outcome: 'cancelled' } } : { outcome: { outcome: 'selected', optionId: 'made_up' } });
  await c.client.conn.request('session/prompt', { sessionId: s3, prompt: [{ type: 'text', text: 'PERM' }] });
  assert.deepEqual(c.host.decisions, ['cancelled', 'reject']);
  // a client that errors on request_permission leaves the decision to Edict ("detached")
  const d = fakeSetup();
  await d.client.init();
  const s4 = (await d.client.conn.request<any>('session/new', { cwd: '/tmp', mcpServers: [] })).sessionId;
  d.client.permission = () => {
    throw new RpcError(-32601, 'not supported');
  };
  await d.client.conn.request('session/prompt', { sessionId: s4, prompt: [{ type: 'text', text: 'PERM' }] });
  assert.deepEqual(d.host.decisions, ['detached', 'detached']);
});

test('acp: consent gate refusal returns an error and closes the connection', async () => {
  const { client, agent } = fakeSetup({ authorize: async () => false });
  let closed = false;
  agent.conn.onClose(() => (closed = true));
  await assert.rejects(client.init('evil'), (e: RpcError) => e.code === -32001 && /拒绝/.test(e.message));
  await waitFor(() => closed && client.conn.closed, 2000, 'closed');
});

// ───────────────────────── Unix socket server ─────────────────────────
function connectClient(sockPath: string): Promise<{ sock: net.Socket; client: TestClient }> {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(sockPath);
    sock.once('connect', () => resolve({ sock, client: new TestClient(sock) }));
    sock.once('error', reject);
  });
}

test('acp socket: 0600 socket, consent per client name, refusal closes, stop removes the socket', async () => {
  const dir = tmpDir('edict-acp-');
  const sockPath = path.join(dir, 'acp.sock');
  const asked: string[] = [];
  let answer = false;
  const server = new AcpServer({ socketPath: sockPath, host: new FakeHost(), confirmClient: async (info) => (asked.push(`${info.name}@${info.version}`), answer) });
  await server.setEnabled(true);
  assert.ok(server.listening);
  const st = fs.lstatSync(sockPath);
  assert.ok(st.isSocket());
  assert.equal(st.mode & 0o777, 0o600);
  await server.setEnabled(true); // idempotent
  // refused
  const a = await connectClient(sockPath);
  const aClosed = new Promise((r) => a.sock.once('close', r));
  await assert.rejects(a.client.init('zed'), (e: RpcError) => e.code === -32001);
  await aClosed;
  assert.deepEqual(asked, ['zed@1.0.0']);
  // approved once → remembered for this client name
  answer = true;
  const b = await connectClient(sockPath);
  assert.equal((await b.client.init('zed')).protocolVersion, 1);
  const s = await b.client.conn.request<any>('session/new', { cwd: '/tmp', mcpServers: [] });
  assert.ok(s.sessionId);
  const c = await connectClient(sockPath);
  await c.client.init('zed');
  assert.equal(asked.length, 2, 'no second dialog for an approved client');
  assert.deepEqual(server.approvedClients(), ['zed']);
  // another client name asks again
  answer = false;
  const d = await connectClient(sockPath);
  await assert.rejects(d.client.init('other-editor'));
  assert.equal(asked.length, 3);
  b.sock.destroy();
  c.sock.destroy();
  await server.setEnabled(false);
  assert.ok(!server.listening);
  assert.ok(!fs.existsSync(sockPath), 'socket removed on stop');
  // a non-socket file at the path is never deleted
  fs.writeFileSync(sockPath, 'not a socket');
  await assert.rejects(server.setEnabled(true), /不是套接字/);
  assert.equal(fs.readFileSync(sockPath, 'utf8'), 'not a socket');
});

test('acp socket: a client that never sends initialize is dropped', async () => {
  const dir = tmpDir('edict-acp-');
  const sockPath = path.join(dir, 'acp.sock');
  const server = new AcpServer({ socketPath: sockPath, host: new FakeHost(), confirmClient: async () => true, initTimeoutMs: 150 });
  await server.start();
  const sock = net.createConnection(sockPath);
  await new Promise((r) => sock.once('close', r));
  await server.stop();
});

test('acp bridge: relays stdio to the socket; a missing socket prints a bilingual error', async () => {
  const { build } = await import('esbuild');
  const outDir = tmpDir('edict-bridge-');
  const bridge = path.join(outDir, 'acp-bridge.js');
  await build({ entryPoints: [path.join(process.cwd(), 'src/acp-bridge/bridge.ts')], outfile: bridge, bundle: true, platform: 'node', format: 'cjs', target: 'node22', logLevel: 'silent' });
  const dir = tmpDir('edict-acp-');
  const sockPath = path.join(dir, 'acp.sock');
  const server = new AcpServer({ socketPath: sockPath, host: new FakeHost(), confirmClient: async () => true });
  await server.start();
  const child = spawn(process.execPath, [bridge, '--socket', sockPath, '--no-launch'], { stdio: ['pipe', 'pipe', 'pipe'] });
  const exited = new Promise<number | null>((r) => child.once('exit', (code) => r(code)));
  const client = new TestClient({ readable: child.stdout!, writable: child.stdin! });
  const r = await client.init('zed');
  assert.equal(r.protocolVersion, 1);
  const s = await client.conn.request<any>('session/new', { cwd: '/tmp', mcpServers: [] });
  const p = await client.conn.request<any>('session/prompt', { sessionId: s.sessionId, prompt: [{ type: 'text', text: 'hi' }] });
  assert.equal(p.stopReason, 'end_turn');
  assert.equal(textOf(client.of(s.sessionId), 'agent_message_chunk'), 'Hello world');
  child.stdin!.end();
  assert.equal(await exited, 0);
  await server.stop();
  // socket missing → clear error (Chinese + English) on stderr, exit 1, nothing on stdout
  const miss = spawn(process.execPath, [bridge, '--socket', path.join(dir, 'missing.sock'), '--no-launch'], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  let stdout = '';
  miss.stderr!.on('data', (d) => (stderr += d));
  miss.stdout!.on('data', (d) => (stdout += d));
  const code = await new Promise<number | null>((res) => miss.once('exit', (c) => res(c)));
  assert.equal(code, 1);
  assert.equal(stdout, '');
  assert.match(stderr, /无法连接 Edict 的 ACP 套接字/);
  assert.match(stderr, /Cannot reach Edict's ACP socket/);
});

// ───────────────────────── real Runtime + mock LLM ─────────────────────────
async function runtimeSetup(o: { brain?: Brain; delayMs?: number; host?: ConstructorParameters<typeof RuntimeAcpHost>[1] } = {}) {
  const mock = await startMockLlm({ brain: o.brain, delayMs: o.delayMs });
  const rt = makeRuntime(mock.url);
  const ws = tmpDir('edict-ws-');
  rt.setWorkspace(ws);
  const host = new RuntimeAcpHost(rt, o.host);
  const connect = async (name = 'zed') => {
    const p = pair();
    new AcpAgent(new JsonRpcConnection(p.agentIo), { host });
    const client = new TestClient(p.clientIo);
    await client.init(name);
    return client;
  };
  const close = async () => {
    host.dispose();
    rt.dispose();
    await mock.close();
  };
  return { mock, rt, ws, host, connect, close };
}

test('acp integration: Solo prompt end to end — streaming, tool call with real diff, end_turn, session/load replay', async () => {
  const env = await runtimeSetup();
  const { rt, ws, host } = env;
  const client = await env.connect();
  const ns = await client.conn.request<any>('session/new', { cwd: ws, mcpServers: [{ name: 'editor-fs', command: '/usr/bin/false', args: [], env: [] }] });
  const sessionId = ns.sessionId as string;
  assert.match(sessionId, /^acp-/);
  assert.equal(ns.modes.currentModeId, 'solo');
  assert.deepEqual(ns.modes.availableModes.map((m: any) => m.id), ['solo', 'lite', 'full']);
  const res = await client.conn.request<any>('session/prompt', { sessionId, prompt: [{ type: 'text', text: '写个文件' }] });
  assert.equal(res.stopReason, 'end_turn');
  const ups = client.of(sessionId);
  assert.match(textOf(ups, 'agent_message_chunk'), /已完成/);
  assert.match(textOf(ups, 'agent_thought_chunk'), /editor-fs.*未启动/);
  const call = ups.find((u) => u.sessionUpdate === 'tool_call') as any;
  assert.equal(call.kind, 'edit');
  assert.equal(call.status, 'pending');
  assert.deepEqual(call.locations, [{ path: path.join(ws, 'solo.txt') }]);
  const doneUpd = ups.find((u) => u.sessionUpdate === 'tool_call_update' && u.toolCallId === call.toolCallId && u.status === 'completed') as any;
  assert.ok(doneUpd, 'tool call completed');
  assert.equal(doneUpd.content[0].type, 'diff');
  assert.equal(doneUpd.content[0].path, path.join(ws, 'solo.txt'));
  assert.equal(doneUpd.content[0].oldText, null);
  assert.equal(doneUpd.content[0].newText, fs.readFileSync(path.join(ws, 'solo.txt'), 'utf8'));
  // the edict is a normal Solo task with ACP provenance in audit + activity stream
  const task = [...rt.tasks.values()].at(-1)!;
  assert.equal(task.tier, 'solo');
  assert.equal(task.state, 'Done');
  assert.ok(rt.audit.list({ taskId: task.id }).some((e) => e.action === 'acp_prompt' && e.actor === 'acp:zed'));
  assert.ok(rt.activities(task.id).some((a) => a.content.includes('经 ACP 下达')));
  // second prompt continues the same Solo conversation (history kept)
  await client.conn.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: '再写一个' }] });
  const tasks = [...rt.tasks.values()];
  assert.equal(tasks.length, 2);
  assert.equal(tasks[0].sessionId, tasks[1].sessionId);
  assert.equal(rt.sessions.get(tasks[0].sessionId!)!.messages.length, 4);
  // session/load on a new connection (e.g. editor restarted) replays the conversation
  host.dispose(); // flush index
  const reloaded = new RuntimeAcpHost(rt);
  const p = pair();
  new AcpAgent(new JsonRpcConnection(p.agentIo), { host: reloaded });
  const c2 = new TestClient(p.clientIo);
  await c2.init('zed');
  const lr = await c2.conn.request<any>('session/load', { sessionId, cwd: ws, mcpServers: [] });
  assert.equal(lr.modes.currentModeId, 'solo');
  const replay = c2.of(sessionId);
  assert.deepEqual(replay.slice(0, 4).map((u) => u.sessionUpdate), ['user_message_chunk', 'agent_message_chunk', 'user_message_chunk', 'agent_message_chunk']);
  assert.equal(textOf(replay.slice(0, 1), 'user_message_chunk'), '写个文件');
  assert.match(textOf(replay.slice(1, 2), 'agent_message_chunk'), /已完成/);
  await assert.rejects(c2.conn.request('session/load', { sessionId: 'acp-nope', cwd: ws, mcpServers: [] }), (e: RpcError) => e.code === -32002);
  reloaded.dispose();
  await env.close();
});

test('acp integration: model deltas stream incrementally — text as message, reasoning as thought, nothing duplicated', async () => {
  const answer = '第一段：分析需求。第二段：给出方案。第三段：总结要点，结束回答。'.repeat(3);
  const reasoning = '先想清楚用户要什么，再组织回答的结构。';
  const brain: Brain = (c) => (c.system.includes('独相') ? { reasoning, text: answer } : { text: 'x' });
  const env = await runtimeSetup({ brain, delayMs: 8 });
  const client = await env.connect();
  const { sessionId } = await client.conn.request<any>('session/new', { cwd: env.ws, mcpServers: [] });
  const res = await client.conn.request<any>('session/prompt', { sessionId, prompt: [{ type: 'text', text: '解释一下' }] });
  assert.equal(res.stopReason, 'end_turn');
  const ups = client.of(sessionId);
  const msgs = ups.filter((u) => u.sessionUpdate === 'agent_message_chunk');
  assert.ok(msgs.length > 1, `streamed in several chunks (got ${msgs.length})`);
  assert.equal(textOf(ups, 'agent_message_chunk'), answer);
  assert.equal(textOf(ups, 'agent_thought_chunk'), reasoning);
  const firstThought = ups.findIndex((u) => u.sessionUpdate === 'agent_thought_chunk');
  const firstMsg = ups.findIndex((u) => u.sessionUpdate === 'agent_message_chunk');
  assert.ok(firstThought < firstMsg, 'reasoning precedes the answer');
  await env.close();
});

test('acp integration: approvals go to the editor; allow_always never covers high-risk commands', async () => {
  const brain: Brain = (c) => {
    if (!c.system.includes('独相')) return { text: 'x' };
    if (c.toolResults === 0) return { toolCalls: [{ name: 'write_file', args: { path: 'a.txt', content: 'A\n' } }] };
    if (c.toolResults <= 2) return { toolCalls: [{ name: 'run_command', args: { command: 'rm -rf build' } }] };
    return { text: '完成' };
  };
  const env = await runtimeSetup({ brain });
  const { rt, ws } = env;
  rt.updateSettings({ permissionMode: 'ask' });
  const client = await env.connect();
  const { sessionId } = await client.conn.request<any>('session/new', { cwd: ws, mcpServers: [] });
  const answers = ['allow_always', 'allow_always', 'reject_once'];
  client.permission = () => ({ outcome: { outcome: 'selected', optionId: answers[client.permissionRequests.length - 1] } });
  const res = await client.conn.request<any>('session/prompt', { sessionId, prompt: [{ type: 'text', text: '改文件并清理' }] });
  assert.equal(res.stopReason, 'end_turn');
  assert.equal(client.permissionRequests.length, 3, 'write once + each high-risk command asked separately');
  const [w, h1, h2] = client.permissionRequests;
  assert.match(w.toolCall.title ?? '', /写入文件：a\.txt/);
  assert.ok(w.options.some((o) => o.kind === 'allow_always'));
  for (const h of [h1, h2]) {
    assert.match(h.toolCall.title ?? '', /高风险/);
    assert.ok(!h.options.some((o) => o.kind === 'allow_always'), 'no always-allow for high risk');
  }
  // the permission request reuses the tool call announced just before it
  const calls = client.of(sessionId).filter((u) => u.sessionUpdate === 'tool_call') as any[];
  assert.equal(calls.length, 3);
  assert.deepEqual(client.permissionRequests.map((r) => r.toolCall.toolCallId), calls.map((c) => c.toolCallId));
  const statusOf = (id: string) => (client.of(sessionId).filter((u) => u.sessionUpdate === 'tool_call_update' && u.toolCallId === id) as any[]).map((u) => u.status);
  assert.deepEqual(statusOf(calls[0].toolCallId), ['in_progress', 'completed']);
  assert.deepEqual(statusOf(calls[2].toolCallId), ['failed', 'failed']); // denied → the tool reports failure
  assert.equal(calls[1].kind, 'execute');
  const aps = [...rt.approvals.values()];
  assert.deepEqual(aps.map((a) => [a.tool, a.risk, a.status]), [['write_file', 'normal', 'approved'], ['run_command', 'high', 'approved'], ['run_command', 'high', 'denied']]);
  const decided = rt.audit.list({}).filter((e) => e.action === 'approval_granted' || e.action === 'approval_denied');
  assert.ok(decided.every((e) => e.actor === 'acp:zed'));
  assert.equal(fs.readFileSync(path.join(ws, 'a.txt'), 'utf8'), 'A\n');
  await env.close();
});

test('acp integration: session/cancel cancels the edict and returns `cancelled`', async () => {
  const brain: Brain = (c) => (c.system.includes('独相') ? { text: '这是一段很长的回答。'.repeat(40) } : { text: 'x' });
  const env = await runtimeSetup({ brain, delayMs: 15 });
  const { rt, ws } = env;
  const client = await env.connect();
  const { sessionId } = await client.conn.request<any>('session/new', { cwd: ws, mcpServers: [] });
  const pending = client.conn.request<any>('session/prompt', { sessionId, prompt: [{ type: 'text', text: '讲个长故事' }] });
  await waitFor(() => textOf(client.of(sessionId), 'agent_message_chunk').length > 0, 10000, 'streaming started');
  client.conn.notify('session/cancel', { sessionId });
  const res = await pending;
  assert.equal(res.stopReason, 'cancelled');
  const task = [...rt.tasks.values()].at(-1)!;
  assert.equal(task.state, 'Cancelled');
  assert.match(task.flow.at(-1)!.remark, /编辑器取消/);
  await env.close();
});

test('acp integration: Court Lite turn streams the court as thoughts, sends the plan, and ends at the final gate', async () => {
  const env = await runtimeSetup();
  const { rt, ws } = env;
  const client = await env.connect();
  const { sessionId } = await client.conn.request<any>('session/new', { cwd: ws, mcpServers: [] });
  await client.conn.request('session/set_mode', { sessionId, modeId: 'lite' });
  const res = await client.conn.request<any>('session/prompt', { sessionId, prompt: [{ type: 'text', text: '写一个 greet 函数并测试' }] });
  assert.equal(res.stopReason, 'end_turn');
  const ups = client.of(sessionId);
  const task = [...rt.tasks.values()].at(-1)!;
  assert.equal(task.tier, 'lite');
  assert.equal(task.state, 'PendingConfirm');
  assert.equal(task.gate?.kind, 'final');
  const msg = textOf(ups, 'agent_message_chunk');
  assert.match(msg, /已实现 greet/); // 尚书回奏 is the answer
  assert.match(msg, /需要在 Edict 中由皇上御批/);
  assert.match(textOf(ups, 'agent_thought_chunk'), /【中书省/);
  const plans = ups.filter((u) => u.sessionUpdate === 'plan') as any[];
  assert.ok(plans.length >= 2);
  assert.deepEqual(plans.at(-1).entries.map((e: any) => [e.content, e.status]), [['兵部·实现 greet.js', 'completed'], ['刑部·编写测试', 'completed']]);
  assert.ok(fs.existsSync(path.join(ws, 'greet.js')));
  await env.close();
});

test('acp integration: the editor cwd must be the Edict workspace unless the user lets Edict switch', async () => {
  const env = await runtimeSetup();
  const { rt, ws } = env;
  const other = tmpDir('edict-ws2-');
  const client = await env.connect();
  await assert.rejects(client.conn.request('session/new', { cwd: other, mcpServers: [] }), (e: RpcError) => /不一致/.test(e.message) && /Open .* in Edict first/.test(e.message));
  await assert.rejects(client.conn.request('session/new', { cwd: path.join(other, 'missing'), mcpServers: [] }), (e: RpcError) => e.code === -32602);
  assert.equal(rt.workspace?.root, ws);
  const asked: string[] = [];
  const h2 = new RuntimeAcpHost(rt, { confirmWorkspace: async (r) => (asked.push(`${r.client.name}:${r.cwd}`), true) });
  const p = pair();
  new AcpAgent(new JsonRpcConnection(p.agentIo), { host: h2 });
  const c2 = new TestClient(p.clientIo);
  await c2.init('zed');
  const s = await c2.conn.request<any>('session/new', { cwd: other, mcpServers: [] });
  assert.ok(s.sessionId);
  assert.deepEqual(asked, [`zed:${other}`]);
  assert.equal(rt.workspace?.root, other);
  assert.ok(rt.audit.list({}).some((e) => e.action === 'acp_workspace_switch'));
  h2.dispose();
  await env.close();
});

test('acp service: createAcpService serves the runtime over the socket; Zed agent_servers snippet', async () => {
  const { createAcpService, zedAgentServerConfig } = await import('../src/main/acp/index');
  const mock = await startMockLlm();
  const rt = makeRuntime(mock.url);
  const ws = tmpDir('edict-ws-');
  rt.setWorkspace(ws);
  const asked: string[] = [];
  const svc = createAcpService(rt, { confirmClient: async (i) => (asked.push(i.name), true) });
  assert.equal(svc.socketPath, path.join(rt.opts.dataDir, 'acp.sock'));
  await svc.setEnabled(true);
  const { sock, client } = await connectClient(svc.socketPath);
  await client.init('zed');
  const { sessionId } = await client.conn.request<any>('session/new', { cwd: ws, mcpServers: [] });
  const r = await client.conn.request<any>('session/prompt', { sessionId, prompt: [{ type: 'text', text: '写个文件' }] });
  assert.equal(r.stopReason, 'end_turn');
  assert.deepEqual(asked, ['zed']);
  assert.equal(svc.host.listSessions()[0].id, sessionId);
  sock.destroy();
  await svc.dispose();
  assert.ok(!svc.server.listening && !fs.existsSync(svc.socketPath));
  const index = JSON.parse(fs.readFileSync(path.join(rt.opts.dataDir, 'acp-sessions.json'), 'utf8'));
  assert.ok(index.sessions.some((s: { id: string; turns: unknown[] }) => s.id === sessionId && s.turns.length === 1));
  const cfg = zedAgentServerConfig({ appExecutable: '/Applications/Edict.app/Contents/MacOS/Edict', bridgeScript: '/Applications/Edict.app/Contents/Resources/app/acp-bridge.js' });
  assert.deepEqual(cfg, { agent_servers: { Edict: { type: 'custom', command: '/Applications/Edict.app/Contents/MacOS/Edict', args: ['/Applications/Edict.app/Contents/Resources/app/acp-bridge.js'], env: { ELECTRON_RUN_AS_NODE: '1' } } } });
  rt.dispose();
  await mock.close();
});
