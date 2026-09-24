#!/usr/bin/env node
// TEST FIXTURE — a tiny MCP server over stdio (newline-delimited JSON-RPC 2.0), written for Edict's
// tests from the public MCP spec. Tools: echo (read-only), add, delete_everything (destructive), fail.
import readline from 'node:readline';

const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');
let nextId = 1000;
const waiting = new Map();
const rl = readline.createInterface({ input: process.stdin });
const TOOLS = [
  { name: 'echo', title: '回声', description: 'Echo text back (prefixed with ECHO_PREFIX env if set)', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }, annotations: { readOnlyHint: true } },
  { name: 'add', description: 'Add two numbers', inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] } },
  { name: 'delete_everything', description: 'Pretend to delete everything', inputSchema: { type: 'object', properties: {} }, annotations: { destructiveHint: true } },
  { name: 'fail', description: 'Always returns an error result', inputSchema: { type: 'object', properties: {} } },
  { name: 'roots', description: 'Ask the client for its roots', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } },
];
process.stderr.write('echo-server booting\n');
rl.on('line', async (line) => {
  let m;
  try { m = JSON.parse(line); } catch { return; }
  if (m.id !== undefined && !m.method) { waiting.get(m.id)?.(m); waiting.delete(m.id); return; }
  const reply = (result) => send({ jsonrpc: '2.0', id: m.id, result });
  switch (m.method) {
    case 'initialize':
      return reply({ protocolVersion: m.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: { listChanged: true }, logging: {} }, serverInfo: { name: 'echo-fixture', version: '0.1.0' }, instructions: 'Test fixture server.' });
    case 'notifications/initialized':
      send({ jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info', logger: 'fixture', data: 'initialized ok' } });
      return;
    case 'tools/list': {
      const page = m.params?.cursor === 'p2' ? 1 : 0; // paginate: 3 + 2
      return reply(page === 0 ? { tools: TOOLS.slice(0, 3), nextCursor: 'p2' } : { tools: TOOLS.slice(3) });
    }
    case 'tools/call': {
      const { name, arguments: a = {} } = m.params ?? {};
      if (name === 'echo') return reply({ content: [{ type: 'text', text: `${process.env.ECHO_PREFIX ? process.env.ECHO_PREFIX + ':' : ''}${a.text}` }] });
      if (name === 'add') return reply({ content: [{ type: 'text', text: String(Number(a.a) + Number(a.b)) }], structuredContent: { sum: Number(a.a) + Number(a.b) } });
      if (name === 'delete_everything') return reply({ content: [{ type: 'text', text: 'deleted (pretend)' }] });
      if (name === 'fail') return reply({ content: [{ type: 'text', text: 'boom' }], isError: true });
      if (name === 'roots') {
        const id = nextId++;
        const r = await new Promise((res) => { waiting.set(id, res); send({ jsonrpc: '2.0', id, method: 'roots/list' }); });
        return reply({ content: [{ type: 'text', text: JSON.stringify(r.result?.roots ?? []) }] });
      }
      return send({ jsonrpc: '2.0', id: m.id, error: { code: -32602, message: `unknown tool ${name}` } });
    }
    case 'ping':
      return reply({});
    default:
      if (m.id !== undefined) send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'method not found' } });
  }
});
