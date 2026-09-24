// MOCK LLM SERVER — for automated tests only. Speaks real OpenAI Chat Completions,
// Anthropic Messages and OpenAI Responses SSE wire formats over HTTP, with scripted,
// role-aware replies. Results obtained with this server are labelled "mock/integration",
// never "real model" verification.
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface MockCall {
  protocol: string;
  system: string;
  lastUser: string;
  tools: string[];
  auth: string | undefined;
  model: string;
}

export interface MockReply {
  text?: string;
  reasoning?: string;
  toolCalls?: { name: string; args: Record<string, unknown> }[];
}

export type Brain = (c: MockCall & { messages: { role: string; content: string }[]; toolResults: number }) => MockReply;

export interface MockOptions {
  brain?: Brain;
  rejectPlanTimes?: number; // 门下省 rejects the plan N times first
  rejectResultTimes?: number;
  failExecTimes?: number; // HTTP 500 for ministry calls N times (tests retry/blocking)
  delayMs?: number;
}

export function defaultBrain(opts: MockOptions): Brain {
  let planRejects = 0;
  let resultRejects = 0;
  return (c) => {
    const s = c.system;
    const u = c.lastUser;
    if (s.includes('上下文压缩器')) return { text: '摘要：已完成若干操作。' };
    if (s.includes('连接测试')) return { text: '在线' };
    if (s.includes('你是太子')) {
      if (/^(你好|在吗|hi|hello)/i.test(u.replace('皇上输入：', '').trim())) return { text: '{"type":"chat","title":"","reply":"儿臣在。父皇有何吩咐？","reason":"问候"}' };
      return { reasoning: '判断为需要动手的旨意', text: '{"type":"edict","title":"编写问候模块","reply":"","reason":"需要写代码"}' };
    }
    if (u.includes('议政结论') || u.includes('总结议政结论')) return { text: '## 共识\n先写测试后实现。\n## 建议旨意\n实现 greet 函数并补测试。' };
    if (u.includes('轮发言')) {
      const answeringEmperor = u.includes('皇上口谕 · 须先回应');
      return { text: answeringEmperor ? '回禀皇上：臣遵旨，先按皇上所言补充测试，再议其余。' : '臣以为此事可行，但需先写测试。' };
    }
    if (u.includes('议政结论') || u.includes('总结议政结论')) return { text: '## 共识\n先写测试后实现。\n## 建议旨意\n实现 greet 函数并补测试。' };
    if (s.includes('你是中书省')) {
      if (c.tools.length && c.toolResults === 0 && !u.includes('不合规')) return { toolCalls: [{ name: 'list_dir', args: { path: '.' } }] };
      return {
        reasoning: '拆解为实现与测试两个子任务',
        text: JSON.stringify({
          summary: u.includes('封驳意见') ? '已按封驳意见补充验收标准。实现 greet 并测试。' : '实现 greet 模块并测试',
          subtasks: [
            { id: 'S1', title: '实现 greet.js', dept: 'bingbu', detail: '创建 greet.js 导出 greet(name)', acceptance: 'greet("A") 返回 "Hello, A"', dependsOn: [] },
            { id: 'S2', title: '编写测试', dept: 'xingbu', detail: '创建 greet.test.js', acceptance: '测试可运行', dependsOn: ['S1'] },
          ],
          risks: ['无'],
        }),
      };
    }
    if (s.includes('你是门下省')) {
      if (u.includes('审议成果') || u.includes('核对实际改动')) {
        if (c.tools.includes('view_changes') && c.toolResults === 0) return { toolCalls: [{ name: 'view_changes', args: {} }] };
        if (resultRejects < (opts.rejectResultTimes ?? 0)) {
          resultRejects++;
          return { text: '{"verdict":"reject","issues":["测试未覆盖空字符串"],"comment":"成果不足","rework":["S2"]}' };
        }
        return { text: '{"verdict":"approve","issues":[],"comment":"成果与改动相符","rework":[]}' };
      }
      if (planRejects < (opts.rejectPlanTimes ?? 0)) {
        planRejects++;
        return { reasoning: '缺少验收标准细节', text: '{"verdict":"reject","issues":["S2 验收标准不可验证"],"comment":"方案需补充验收细节"}' };
      }
      return { text: '{"verdict":"approve","issues":[],"comment":"方案可行"}' };
    }
    if (s.includes('你是尚书省')) {
      if (u.includes('执行令')) return { text: '{"orders":[{"subtaskId":"S1","instruction":"先实现"},{"subtaskId":"S2","instruction":"后测试"}],"note":"S2 依赖 S1"}' };
      return { text: '## 成果\n已实现 greet 并编写测试。\n## 产物与验证\n- greet.js\n## 遗留问题\n无' };
    }
    if (s.includes('兵部尚书') || s.includes('刑部尚书') || s.includes('户部尚书') || s.includes('礼部尚书') || s.includes('工部尚书') || s.includes('吏部尚书') || s.includes('独相')) {
      const isTest = s.includes('刑部尚书');
      if (c.tools.length && c.toolResults === 0) {
        return isTest
          ? { toolCalls: [{ name: 'write_file', args: { path: 'greet.test.js', content: "const {greet}=require('./greet');\nif(greet('A')!=='Hello, A') throw new Error('fail');\nconsole.log('ok');\n" } }] }
          : { toolCalls: [{ name: 'write_file', args: { path: s.includes('独相') ? 'solo.txt' : 'greet.js', content: "exports.greet = (n) => `Hello, ${n}`;\n" } }] };
      }
      if (c.tools.length && c.toolResults === 1 && isTest) return { toolCalls: [{ name: 'run_command', args: { command: 'node greet.test.js' } }] };
      const art = s.includes('独相') ? 'solo.txt' : isTest ? 'greet.test.js' : 'greet.js';
      return { text: '已完成。\n```json\n' + JSON.stringify({ status: 'done', summary: `完成 ${art}`, artifacts: [art], verification: isTest ? 'node greet.test.js → ok' : '未验证', issues: [] }) + '\n```' };
    }
    return { text: '（mock 默认回复）' };
  };
}

function sse(res: http.ServerResponse, events: { event?: string; data: unknown }[], delayMs: number) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  let i = 0;
  const next = () => {
    if (i >= events.length) return res.end();
    const e = events[i++];
    res.write(`${e.event ? `event: ${e.event}\n` : ''}data: ${typeof e.data === 'string' ? e.data : JSON.stringify(e.data)}\n\n`);
    if (delayMs) setTimeout(next, delayMs);
    else setImmediate(next);
  };
  next();
}

const chunk = (s: string, n = 12) => {
  const out: string[] = [];
  for (let i = 0; i < s.length; i += n) out.push(s.slice(i, i + n));
  return out;
};

export async function startMockLlm(opts: MockOptions = {}) {
  const brain = opts.brain ?? defaultBrain(opts);
  const calls: MockCall[] = [];
  let execFails = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const url = req.url ?? '';
      if (req.method === 'GET' && url.endsWith('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ data: [{ id: 'mock-strong' }, { id: 'mock-economy' }] }));
      }
      if (req.method === 'GET' && url.includes('feed')) {
        res.writeHead(200, { 'content-type': 'application/rss+xml' });
        return res.end('<rss><channel><item><title>Mock 要闻一则</title><link>https://example.com/a</link><pubDate>Mon, 01 Jan 2026 00:00:00 GMT</pubDate></item></channel></rss>');
      }
      let j: any = {};
      try {
        j = JSON.parse(body || '{}');
      } catch {
        /* ignore */
      }
      let protocol = 'openai-chat';
      let system = '';
      let messages: { role: string; content: string }[] = [];
      let tools: string[] = [];
      let toolResults = 0;
      if (url.endsWith('/chat/completions')) {
        system = j.messages?.find((m: any) => m.role === 'system')?.content ?? '';
        messages = (j.messages ?? []).filter((m: any) => m.role !== 'system').map((m: any) => ({ role: m.role, content: String(m.content ?? '') }));
        tools = (j.tools ?? []).map((t: any) => t.function.name);
        let k = messages.length - 1;
        while (k >= 0 && messages[k].role !== 'user') k--;
        toolResults = (j.messages ?? []).filter((m: any) => m.role === 'tool').length;
      } else if (url.endsWith('/messages')) {
        protocol = 'anthropic-messages';
        system = (j.system ?? []).map((b: any) => b.text).join('\n');
        messages = (j.messages ?? []).map((m: any) => ({ role: m.role, content: (m.content ?? []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n') }));
        tools = (j.tools ?? []).map((t: any) => t.name);
        toolResults = (j.messages ?? []).flatMap((m: any) => m.content ?? []).filter((b: any) => b.type === 'tool_result').length;
      } else if (url.endsWith('/responses')) {
        protocol = 'openai-responses';
        system = j.instructions ?? '';
        messages = (j.input ?? []).filter((i: any) => i.role).map((i: any) => ({ role: i.role, content: String(i.content) }));
        tools = (j.tools ?? []).map((t: any) => t.name);
        toolResults = (j.input ?? []).filter((i: any) => i.type === 'function_call_output').length;
      } else {
        res.writeHead(404);
        return res.end('not found');
      }
      const lastUser = [...messages].reverse().find((m) => m.role === 'user' && m.content)?.content ?? '';
      const firstUser = messages.find((m) => m.role === 'user')?.content ?? '';
      const call: MockCall = { protocol, system, lastUser: lastUser.includes('朱批') || lastUser.includes('不合规') || lastUser.includes('请只输出') ? `${firstUser}\n${lastUser}` : lastUser, tools, auth: (req.headers.authorization as string) ?? (req.headers['x-api-key'] as string), model: j.model };
      calls.push(call);
      const isMinistry = /(兵部|刑部)尚书/.test(system);
      if (isMinistry && execFails < (opts.failExecTimes ?? 0)) {
        execFails++;
        res.writeHead(500, { 'content-type': 'application/json' });
        return res.end('{"error":{"message":"mock upstream failure"}}');
      }
      const r = brain({ ...call, messages, toolResults });
      const delay = opts.delayMs ?? 0;
      const usage = { in: 100 + system.length / 4, out: 20 + (r.text?.length ?? 0) / 4 };
      if (protocol === 'openai-chat') {
        const ev: { data: unknown }[] = [];
        for (const p of chunk(r.reasoning ?? '')) ev.push({ data: { choices: [{ index: 0, delta: { reasoning_content: p } }] } });
        for (const p of chunk(r.text ?? '')) ev.push({ data: { choices: [{ index: 0, delta: { content: p } }] } });
        (r.toolCalls ?? []).forEach((tc, i) => {
          const args = JSON.stringify(tc.args);
          ev.push({ data: { choices: [{ index: 0, delta: { tool_calls: [{ index: i, id: `call_${calls.length}_${i}`, type: 'function', function: { name: tc.name, arguments: '' } }] } }] } });
          for (const p of chunk(args, 20)) ev.push({ data: { choices: [{ index: 0, delta: { tool_calls: [{ index: i, function: { arguments: p } }] } }] } });
        });
        ev.push({ data: { choices: [{ index: 0, delta: {}, finish_reason: r.toolCalls?.length ? 'tool_calls' : 'stop' }] } });
        ev.push({ data: { choices: [], usage: { prompt_tokens: Math.round(usage.in), completion_tokens: Math.round(usage.out), prompt_tokens_details: { cached_tokens: 50 } } } });
        ev.push({ data: '[DONE]' });
        return sse(res, ev, delay);
      }
      if (protocol === 'anthropic-messages') {
        const ev: { event: string; data: unknown }[] = [{ event: 'message_start', data: { type: 'message_start', message: { usage: { input_tokens: Math.round(usage.in), cache_read_input_tokens: 40, output_tokens: 1 } } } }];
        let idx = 0;
        if (r.reasoning) {
          ev.push({ event: 'content_block_start', data: { type: 'content_block_start', index: idx, content_block: { type: 'thinking' } } });
          for (const p of chunk(r.reasoning)) ev.push({ event: 'content_block_delta', data: { type: 'content_block_delta', index: idx, delta: { type: 'thinking_delta', thinking: p } } });
          idx++;
        }
        if (r.text) {
          ev.push({ event: 'content_block_start', data: { type: 'content_block_start', index: idx, content_block: { type: 'text', text: '' } } });
          for (const p of chunk(r.text)) ev.push({ event: 'content_block_delta', data: { type: 'content_block_delta', index: idx, delta: { type: 'text_delta', text: p } } });
          idx++;
        }
        for (const tc of r.toolCalls ?? []) {
          ev.push({ event: 'content_block_start', data: { type: 'content_block_start', index: idx, content_block: { type: 'tool_use', id: `toolu_${calls.length}_${idx}`, name: tc.name, input: {} } } });
          for (const p of chunk(JSON.stringify(tc.args), 20)) ev.push({ event: 'content_block_delta', data: { type: 'content_block_delta', index: idx, delta: { type: 'input_json_delta', partial_json: p } } });
          idx++;
        }
        ev.push({ event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: r.toolCalls?.length ? 'tool_use' : 'end_turn' }, usage: { output_tokens: Math.round(usage.out) } } });
        ev.push({ event: 'message_stop', data: { type: 'message_stop' } });
        return sse(res, ev, delay);
      }
      const ev: { event: string; data: unknown }[] = [];
      for (const p of chunk(r.reasoning ?? '')) ev.push({ event: 'response.reasoning_summary_text.delta', data: { type: 'response.reasoning_summary_text.delta', delta: p } });
      for (const p of chunk(r.text ?? '')) ev.push({ event: 'response.output_text.delta', data: { type: 'response.output_text.delta', delta: p } });
      (r.toolCalls ?? []).forEach((tc, i) => {
        const id = `fc_${i}`;
        ev.push({ event: 'response.output_item.added', data: { type: 'response.output_item.added', item: { type: 'function_call', id, call_id: `call_${calls.length}_${i}`, name: tc.name, arguments: '' } } });
        for (const p of chunk(JSON.stringify(tc.args), 20)) ev.push({ event: 'response.function_call_arguments.delta', data: { type: 'response.function_call_arguments.delta', item_id: id, delta: p } });
      });
      ev.push({ event: 'response.completed', data: { type: 'response.completed', response: { id: 'resp_mock', status: 'completed', usage: { input_tokens: Math.round(usage.in), output_tokens: Math.round(usage.out), input_tokens_details: { cached_tokens: 30 } } } } });
      return sse(res, ev, delay);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}/v1`, port, calls, close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }) };
}
