#!/usr/bin/env node
// TEST FIXTURE — MCP server over stdio with resources (paginated, templates, text / blob / oversized)
// and prompts (with arguments, embedded resource, image). Tool `mutate` adds a resource and a prompt and
// emits notifications/resources/list_changed + notifications/prompts/list_changed. Written from the public spec.
import readline from 'node:readline';

const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 1, 2, 3, 4]).toString('base64');
const resources = [
  { uri: 'fixture://readme', name: 'readme', title: '说明', description: 'Fixture readme', mimeType: 'text/markdown' },
  { uri: 'fixture://logo', name: 'logo', mimeType: 'image/png', size: 16 },
  { uri: 'fixture://big', name: 'big', mimeType: 'text/plain', description: 'Very long text' },
  { uri: 'fixture://multi', name: 'multi', description: 'Text + blob in one read' },
];
const prompts = [
  { name: 'review', title: '代码审查', description: 'Review a file', arguments: [{ name: 'file', description: 'path', required: true }, { name: 'focus', description: 'what to look at' }] },
  { name: 'greet', description: 'Say hello with a picture' },
];
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let m;
  try { m = JSON.parse(line); } catch { return; }
  if (m.id !== undefined && !m.method) return;
  const reply = (result) => send({ jsonrpc: '2.0', id: m.id, result });
  const fail = (code, message) => send({ jsonrpc: '2.0', id: m.id, error: { code, message } });
  if (m.method && !m.method.startsWith('notifications/')) process.stderr.write(`method ${m.method}\n`);
  switch (m.method) {
    case 'initialize':
      return reply({ protocolVersion: '2025-06-18', capabilities: { tools: {}, resources: { listChanged: true }, prompts: { listChanged: true } }, serverInfo: { name: 'resources-fixture', version: '0.1.0' } });
    case 'notifications/initialized':
      return;
    case 'tools/list':
      return reply({ tools: [{ name: 'mutate', description: 'Add a resource and a prompt', inputSchema: { type: 'object', properties: {} } }] });
    case 'tools/call':
      resources.push({ uri: 'fixture://added', name: 'added', mimeType: 'text/plain' });
      prompts.push({ name: 'added_prompt', arguments: [] });
      reply({ content: [{ type: 'text', text: 'mutated' }] });
      send({ jsonrpc: '2.0', method: 'notifications/resources/list_changed' });
      send({ jsonrpc: '2.0', method: 'notifications/prompts/list_changed' });
      return;
    case 'resources/list': {
      const second = m.params?.cursor === 'r2'; // paginate: 2 + rest
      return reply(second ? { resources: resources.slice(2) } : { resources: resources.slice(0, 2), nextCursor: 'r2' });
    }
    case 'resources/templates/list':
      return reply({ resourceTemplates: [{ uriTemplate: 'fixture://notes/{id}', name: 'note', description: 'A note by id', mimeType: 'text/plain' }] });
    case 'resources/read': {
      const uri = m.params?.uri;
      if (uri === 'fixture://readme') return reply({ contents: [{ uri, mimeType: 'text/markdown', text: '# Hello\nfixture readme' }] });
      if (uri === 'fixture://logo') return reply({ contents: [{ uri, mimeType: 'image/png', blob: PNG }] });
      if (uri === 'fixture://big') return reply({ contents: [{ uri, mimeType: 'text/plain', text: 'x'.repeat(30000) + 'END' }] });
      if (uri === 'fixture://multi') return reply({ contents: [{ uri: 'fixture://multi#a', mimeType: 'text/plain', text: 'part A' }, { uri: 'fixture://multi#b', mimeType: 'application/octet-stream', blob: Buffer.from('BINARY').toString('base64') }] });
      if (uri === 'fixture://added') return reply({ contents: [{ uri, mimeType: 'text/plain', text: 'added later' }] });
      const note = typeof uri === 'string' && uri.match(/^fixture:\/\/notes\/(.+)$/);
      if (note) return reply({ contents: [{ uri, mimeType: 'text/plain', text: `note ${note[1]}` }] });
      return fail(-32002, `Resource not found: ${uri}`);
    }
    case 'prompts/list':
      return reply({ prompts });
    case 'prompts/get': {
      const { name, arguments: a = {} } = m.params ?? {};
      if (name === 'review') {
        if (!a.file) return fail(-32602, 'missing file');
        return reply({
          description: 'Review prompt',
          messages: [
            { role: 'user', content: { type: 'text', text: `请审查 ${a.file}，重点：${a.focus ?? '全部'}` } },
            { role: 'assistant', content: { type: 'text', text: '好的，请提供文件。' } },
            { role: 'user', content: { type: 'resource', resource: { uri: 'fixture://readme', mimeType: 'text/markdown', text: '# Hello' } } },
          ],
        });
      }
      if (name === 'greet') return reply({ messages: [{ role: 'user', content: { type: 'text', text: '你好' } }, { role: 'user', content: { type: 'image', data: PNG, mimeType: 'image/png' } }] });
      if (name === 'added_prompt') return reply({ messages: [{ role: 'user', content: { type: 'text', text: 'added' } }] });
      return fail(-32602, `unknown prompt ${name}`);
    }
    case 'ping':
      return reply({});
    default:
      if (m.id !== undefined) fail(-32601, 'method not found');
  }
});
