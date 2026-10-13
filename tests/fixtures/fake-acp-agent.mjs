#!/usr/bin/env node
// FAKE ACP AGENT — for automated tests only. Speaks ACP v1 as an agent on stdio, the way outside coding agents
// do when Edict drives them (客卿): reads and writes files through the client, runs a command in a client terminal,
// asks permission, and (in some modes) changes files behind the client's back. Behaviour: --mode <name>.
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(k);
  return i >= 0 ? argv[i + 1] : d;
};
const mode = opt('--mode', 'normal');
const logFile = opt('--log', process.env.FAKE_ACP_LOG);
const log = (o) => logFile && fs.appendFileSync(logFile, JSON.stringify(o) + '\n');
if (mode === 'crash') {
  process.stderr.write('fake agent: cannot start (no config)\n');
  process.exit(3);
}

let buf = '';
let nextId = 1000;
const pending = new Map();
let cwd = process.cwd();
let cancelled = false;
let prompts = 0;
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
const request = (method, params) => new Promise((resolve, reject) => {
  const id = nextId++;
  pending.set(id, { resolve, reject });
  send({ id, method, params });
});
const update = (u) => send({ method: 'session/update', params: { sessionId: 's1', update: u } });
const say = (t) => update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: t } });
const conclusion = (o) => '\n```json\n' + JSON.stringify({ status: 'done', summary: '完成', artifacts: [], verification: '未验证', issues: [], ...o }) + '\n```';

async function work(text) {
  prompts++;
  log({ prompt: text, n: prompts, mode });
  update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '先看看仓库。' } });
  update({ sessionUpdate: 'plan', entries: [{ content: '读 README', priority: 'high', status: 'completed' }, { content: '写 greet.js', priority: 'high', status: 'pending' }] });
  if (mode === 'hang') {
    while (!cancelled) await new Promise((r) => setTimeout(r, 50));
    return 'cancelled';
  }
  if (mode === 'readonly-sneaky') {
    fs.writeFileSync(path.join(cwd, 'sneaky.txt'), 'written behind the client\n');
    update({ sessionUpdate: 'tool_call', toolCallId: 'x1', title: 'Write sneaky.txt', kind: 'edit', status: 'completed' });
    say('看完了，顺手记了点东西。' + conclusion({ summary: '分析完成', verification: '只读分析' }));
    return 'end_turn';
  }
  if (mode === 'noformat' && prompts > 1) {
    say(conclusion({ summary: '补交结论：写了 greet.js', artifacts: ['greet.js'] }));
    return 'end_turn';
  }
  const readme = await request('fs/read_text_file', { sessionId: 's1', path: path.join(cwd, 'README.md') });
  log({ read: readme.content });
  update({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Write greet.js', kind: 'edit', status: 'pending', locations: [{ path: path.join(cwd, 'greet.js') }] });
  const perm = await request('session/request_permission', {
    sessionId: 's1',
    toolCall: { toolCallId: 't1', title: 'Write greet.js', kind: 'edit', locations: [{ path: path.join(cwd, 'greet.js') }], rawInput: { file_path: path.join(cwd, 'greet.js') } },
    options: [{ optionId: 'ok', name: 'Allow', kind: 'allow_once' }, { optionId: 'always', name: 'Always', kind: 'allow_always' }, { optionId: 'no', name: 'Reject', kind: 'reject_once' }],
  });
  log({ permission: perm.outcome });
  if (perm.outcome.outcome !== 'selected' || perm.outcome.optionId === 'no') {
    update({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'failed' });
    say('没有获准写文件。' + conclusion({ status: 'failed', summary: '未获准写入' }));
    return 'end_turn';
  }
  try {
    await request('fs/write_text_file', { sessionId: 's1', path: path.join(cwd, 'greet.js'), content: 'exports.greet = (n) => `Hello, ${n}`;\n' });
  } catch (e) {
    log({ writeError: e.message });
    say(conclusion({ status: 'failed', summary: `写入失败：${e.message}` }));
    return 'end_turn';
  }
  update({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed', content: [{ type: 'diff', path: path.join(cwd, 'greet.js'), newText: 'exports.greet…' }] });
  update({ sessionUpdate: 'tool_call', toolCallId: 't2', title: 'node greet check', kind: 'execute', status: 'in_progress', rawInput: { command: 'node -e …' } });
  const term = await request('terminal/create', { sessionId: 's1', command: 'node', args: ['-e', "console.log(require('./greet').greet('A') + ' port=' + process.env.EDICT_PORT)"], env: [{ name: 'FAKE', value: '1' }], cwd });
  const exit = await request('terminal/wait_for_exit', { sessionId: 's1', terminalId: term.terminalId });
  const out = await request('terminal/output', { sessionId: 's1', terminalId: term.terminalId });
  await request('terminal/release', { sessionId: 's1', terminalId: term.terminalId });
  log({ exit, output: out.output });
  update({ sessionUpdate: 'tool_call_update', toolCallId: 't2', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: out.output } }] });
  // overwrite: change a file it never read through the client (it reads with its own tools)
  if (mode === 'overwrite' && fs.existsSync(path.join(cwd, 'app.js'))) {
    await request('fs/write_text_file', { sessionId: 's1', path: path.join(cwd, 'app.js'), content: "require('./greet');\n" });
  }
  // its own built-in tool, not through the client
  fs.writeFileSync(path.join(cwd, 'notes.md'), '# notes by the fake agent\n');
  if (mode === 'noformat') {
    say('我做完了，greet.js 已写好。');
    return 'end_turn';
  }
  say(`已写好 greet.js 并运行检查：${out.output.trim()}` + conclusion({ summary: '写了 greet.js', artifacts: ['greet.js', 'notes.md'], verification: `node → ${out.output.trim()}` }));
  return 'end_turn';
}

async function handle(m) {
  if (m.method === 'initialize') {
    send({ id: m.id, result: { protocolVersion: 1, agentInfo: { name: 'fake-agent', title: 'Fake Agent', version: '1.0.0' }, agentCapabilities: {}, authMethods: mode === 'auth' ? [{ id: 'login', name: 'Log in' }] : [] } });
    log({ clientCapabilities: m.params?.clientCapabilities, clientInfo: m.params?.clientInfo });
    return;
  }
  if (m.method === 'session/new') {
    if (mode === 'auth') return send({ id: m.id, error: { code: -32000, message: 'Authentication required' } });
    cwd = m.params.cwd;
    log({ sessionCwd: cwd, port: process.env.EDICT_PORT ?? null });
    return send({ id: m.id, result: { sessionId: 's1' } });
  }
  if (m.method === 'session/prompt') {
    const text = (m.params.prompt ?? []).map((b) => b.text ?? '').join('\n');
    try {
      const stopReason = await work(text);
      send({ id: m.id, result: { stopReason } });
    } catch (e) {
      send({ id: m.id, error: { code: -32603, message: e.message } });
    }
    return;
  }
  if (m.method === 'session/cancel') {
    cancelled = true;
    log({ cancelled: true });
    return;
  }
  if (m.id !== undefined) send({ id: m.id, error: { code: -32601, message: `Method not found: ${m.method}` } });
}

process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    if (m.method) void handle(m);
    else if (pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) p.reject(new Error(m.error.message));
      else p.resolve(m.result);
    }
  }
});
process.stdin.on('end', () => process.exit(0));
