// Edict 2.0 execution layer: retries, read-before-edit, pruning, doom loop, parallel reads,
// effect scheduling, write-task dialogs, escalation, always-allow rules, release policy,
// conclusion evidence, node timeouts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { defaultBrain, startMockLlm, type Brain } from './mockLlm';
import { makeRuntime, tmpDir, waitFor, stateOf } from './helpers';
import { submit, decideGate } from '../src/main/runtime/orchestrator';
import { runAgent, pruneToolResults, toolBatches, trackLoop } from '../src/main/runtime/agentLoop';
import { executeTool } from '../src/main/runtime/tools';
import { allowedByRules, classifyCommand, commandPrefix, effectiveMode, isLookCommand, ruleFor, splitCommand } from '../src/main/runtime/permissions';
import { checkEvidence, parseConclusion, scheduleExec } from '../src/main/runtime/execPolicy';
import { backoffMs, classifyLlmError, LlmHttpError, parseRetryAfter } from '../src/main/llm/types';
import { streamLlm } from '../src/main/llm/adapters';
import type { ApprovalRequest, RunNode, Task } from '../src/shared/types';
import type { LlmMessage } from '../src/main/llm/types';

const pending = (rt: ReturnType<typeof makeRuntime>, kind?: string) => [...rt.approvals.values()].find((a) => a.status === 'pending' && (!kind || a.kind === kind));

/** default mock, but 中书省 returns `subtasks` as the plan */
function planBrain(subtasks: unknown[]): Brain {
  const base = defaultBrain({});
  return (c) => {
    if (c.system.includes('你是中书省') && !(c.tools.length && c.toolResults === 0)) return { text: JSON.stringify({ summary: '测试方案', subtasks, risks: [] }) };
    return base(c);
  };
}

// ───────────────────────── pure helpers ─────────────────────────
test('R6: Retry-After parsing, exponential backoff caps, context-length errors are their own kind', () => {
  const h = (o: Record<string, string>) => ({ get: (k: string) => o[k] ?? null });
  assert.equal(parseRetryAfter(h({ 'retry-after': '3' })), 3000);
  assert.equal(parseRetryAfter(h({ 'retry-after-ms': '1500' })), 1500);
  assert.equal(parseRetryAfter(h({ 'retry-after': new Date(10_000).toUTCString() }), 4_000), 6000);
  assert.equal(parseRetryAfter(h({})), undefined);
  assert.equal(backoffMs(0), 2000);
  assert.equal(backoffMs(1), 4000);
  assert.equal(backoffMs(10), 30_000);
  assert.equal(backoffMs(0, 120_000), 60_000);
  assert.equal(backoffMs(0, 5000), 5000);
  const ctx = classifyLlmError(new LlmHttpError(400, '{"error":{"message":"This model\'s maximum context length is 8192 tokens"}}', 'u'));
  assert.equal(ctx.kind, 'context');
  assert.equal(ctx.retryable, false);
  assert.equal(classifyLlmError(new LlmHttpError(400, 'prompt is too long: 210000 tokens > 200000 maximum', 'u')).kind, 'context');
  assert.equal(classifyLlmError(new LlmHttpError(400, 'invalid model id', 'u')).kind, 'config');
});

test('R6: the adapter keeps the server-requested wait on HTTP errors', async () => {
  const fetchImpl = async () => new Response('{"error":"slow down"}', { status: 429, headers: { 'retry-after': '7' } });
  const p = { config: { id: 'x', name: 'x', preset: 'custom', protocol: 'openai-chat' as const, baseUrl: 'http://127.0.0.1:1', enabled: true, models: [] }, apiKey: 'k' };
  await assert.rejects(streamLlm(p as never, 'm', { system: '', messages: [{ role: 'user', content: 'hi' }] }, fetchImpl as never), (e: unknown) => e instanceof LlmHttpError && e.retryAfterMs === 7000);
});

test('R4: old tool results are pruned, the newest and skills are kept, command output keeps its tail', () => {
  const big = 'x'.repeat(4000);
  const msgs: LlmMessage[] = [{ role: 'user', content: 'task' }];
  for (let i = 0; i < 12; i++) {
    msgs.push({ role: 'assistant', content: '', toolCalls: [{ id: `c${i}`, name: i === 0 ? 'load_skill' : i === 1 ? 'run_command' : 'read_file', args: {}, rawArgs: '{}' }] });
    msgs.push({ role: 'tool', toolCallId: `c${i}`, toolName: i === 0 ? 'load_skill' : i === 1 ? 'run_command' : 'read_file', content: i === 1 ? `$ npm test\nexit=1 · 9ms\nstdout:\n${big}TAIL-MARK` : big });
  }
  const { messages, pruned } = pruneToolResults(msgs, 1000, 8);
  assert.equal(pruned, 3); // 12 results − 8 newest − 1 skill
  const tools = messages.filter((m) => m.role === 'tool');
  assert.equal(tools[0].content, big, 'skill text never pruned');
  assert.match(tools[1].content, /^\[已裁剪\]/);
  assert.match(tools[1].content, /exit=1/);
  assert.match(tools[1].content, /TAIL-MARK$/);
  assert.ok(tools.slice(-8).every((m) => m.content === big));
  assert.equal(pruneToolResults(msgs, 10_000_000).pruned, 0, 'under budget → untouched');
});

test('R9 / R8: read-only calls are batched; identical consecutive calls are counted', () => {
  const b = toolBatches([{ name: 'read_file' }, { name: 'search' }, { name: 'write_file' }, { name: 'list_dir' }, { name: 'outline' }, { name: 'run_command' }]);
  assert.deepEqual(b.map((x) => x.map((c) => c.name)), [['read_file', 'search'], ['write_file'], ['list_dir', 'outline'], ['run_command']]);
  const loop = { sig: '', streak: 0 };
  assert.equal(trackLoop(loop, 'read_file', { path: 'a', start_line: 1 }), 1);
  assert.equal(trackLoop(loop, 'read_file', { start_line: 1, path: 'a' }), 2, 'argument order does not matter');
  assert.equal(trackLoop(loop, 'read_file', { path: 'a', start_line: 1 }), 3);
  assert.equal(trackLoop(loop, 'read_file', { path: 'b' }), 1);
});

test('R5: release / deploy classification, rule prefixes by arity, compound commands', () => {
  for (const c of ['git push origin main', 'npm publish', 'npm test && npm publish', 'vercel --prod', 'gh release create v1', 'gh pr merge 12 --squash', 'kubectl apply -f x.yaml', 'docker push me/app']) {
    const k = classifyCommand(c);
    assert.ok(k.high && k.release, c);
  }
  const mixed = classifyCommand('git push && rm -rf build');
  assert.ok(mixed.high && !mixed.release, 'a non-release high-risk part keeps it unconditionally high');
  assert.ok(!classifyCommand('npm test').release);
  assert.equal(commandPrefix('npm run build -- --watch'), 'npm run build');
  assert.equal(commandPrefix('git commit -m "x"'), 'git commit');
  assert.equal(commandPrefix('FOO=1 pytest -q tests/'), 'pytest');
  assert.equal(commandPrefix('python3 -m pytest -q'), 'python3 -m pytest');
  assert.equal(commandPrefix('make'), 'make');
  assert.equal(commandPrefix('echo $(whoami)'), null);
  assert.deepEqual(splitCommand('npm test && npm run lint | tee out; ls'), ['npm test', 'npm run lint', 'tee out', 'ls']);
  const r = ruleFor('run_command', { command: 'npm test && npm run lint' })!;
  assert.deepEqual(r.keys, ['cmd:npm test', 'cmd:npm run lint']);
  assert.ok(allowedByRules(r.keys, [{ key: 'cmd:npm test', label: '', at: 0 }, { key: 'cmd:npm run lint', label: '', at: 0 }]));
  assert.ok(!allowedByRules(r.keys, [{ key: 'cmd:npm test', label: '', at: 0 }]), 'every part must be allowed');
  assert.equal(ruleFor('run_command', { command: 'echo `id`' }), null);
  assert.deepEqual(ruleFor('edit_file', {})!.keys, ['tool:write']);
  assert.deepEqual(ruleFor('mcp__gh__create_issue', {})!.keys, ['mcp:gh/create_issue']);
  assert.equal(effectiveMode('auto-edit', 'write_free'), 'auto');
  assert.equal(effectiveMode('readonly', 'write'), 'ask');
  assert.equal(effectiveMode('auto', 'readonly'), 'readonly');
  assert.ok(isLookCommand('git status && ls -la'));
  assert.ok(!isLookCommand('npm test'));
  assert.ok(!isLookCommand('find . -delete'));
  assert.ok(!isLookCommand('cat a > b'));
});

test('R2 / E7: unknown or missing status and unstructured replies are partial; evidence downgrades done', () => {
  assert.equal(parseConclusion('```json\n{"status":"done","summary":"ok","artifacts":[],"verification":"x","issues":[]}\n```').status, 'done');
  const weird = parseConclusion('{"status":"finished","summary":"ok"}');
  assert.equal(weird.status, 'partial');
  assert.match(weird.issues.join(), /status 无效/);
  assert.equal(parseConclusion('{"summary":"ok"}').status, 'partial');
  const prose = parseConclusion('都做完了，放心。');
  assert.equal(prose.status, 'partial');
  assert.equal(prose.structured, false);

  const dir = tmpDir('edict-ev-');
  fs.writeFileSync(path.join(dir, 'real.txt'), 'hi');
  const ws = { readBuffer: (p: string) => (fs.existsSync(path.join(dir, p)) ? fs.readFileSync(path.join(dir, p)) : null) } as never;
  const task = { changes: [] } as unknown as Task;
  const done = { status: 'done' as const, summary: 's', artifacts: ['real.txt', 'ghost.txt'], verification: 'v', issues: [] };
  const n = (effect: RunNode['effect']) => ({ id: 'n1', kind: 'exec', effect } as RunNode);
  const a = checkEvidence(task, n('read'), done, {}, ws);
  assert.equal(a.conclusion.status, 'partial');
  assert.match(a.conclusion.issues.join(), /ghost\.txt/);
  assert.ok(a.systemCheck.some((l) => l.startsWith('real.txt ✓')));
  const w = checkEvidence(task, n('write'), { ...done, artifacts: [] }, {}, ws);
  assert.match(w.conclusion.issues.join(), /没有记录到任何文件改动/);
  const v = checkEvidence(task, n('verify'), { ...done, artifacts: [] }, {}, ws);
  assert.match(v.conclusion.issues.join(), /没有执行任何命令/);
  assert.equal(checkEvidence(task, n('verify'), { ...done, artifacts: [] }, { run_command: 1 }, ws).conclusion.status, 'done');
});

test('R1: scheduler runs read nodes side by side and write / verify nodes alone, in plan order', async () => {
  const nodes = (['read', 'read', 'write', 'read', 'verify'] as const).map((effect, i) => ({ id: `n${i}`, status: 'pending', effect } as RunNode));
  let live = 0;
  const log: string[] = [];
  await scheduleExec(nodes, {
    limit: 3,
    ready: () => true,
    run: async (n) => {
      n.status = 'running';
      live++;
      log.push(`start ${n.id} live=${live}`);
      await new Promise((r) => setTimeout(r, 15));
      live--;
      n.status = 'done';
    },
  });
  assert.deepEqual(log, ['start n0 live=1', 'start n1 live=2', 'start n2 live=1', 'start n3 live=1', 'start n4 live=1']);
  // dependencies still gate readiness
  const a = { id: 'a', status: 'pending', effect: 'read' } as RunNode;
  const b = { id: 'b', status: 'pending', effect: 'read' } as RunNode;
  const order: string[] = [];
  await scheduleExec([b, a], { limit: 3, ready: (n) => n.id === 'a' || a.status === 'done', run: async (n) => { order.push(n.id); n.status = 'done'; } });
  assert.deepEqual(order, ['a', 'b']);
});

// ───────────────────────── tools with a runtime ─────────────────────────
test('R3: editing or overwriting an existing file needs a fresh read in this run', async () => {
  const mock = await startMockLlm();
  const rt = makeRuntime(mock.url);
  const ws = tmpDir('edict-ws-');
  fs.writeFileSync(path.join(ws, 'a.txt'), 'one\ntwo\n');
  rt.setWorkspace(ws);
  const ctx = { rt, agentId: 'bingbu' as const, reads: new Map<string, string>() };
  let r = await executeTool(ctx, 'edit_file', { path: 'a.txt', old_string: 'one', new_string: 'ONE' });
  assert.equal(r.ok, false);
  assert.match(r.output, /还没读过/);
  r = await executeTool(ctx, 'write_file', { path: 'a.txt', content: 'clobber' });
  assert.equal(r.ok, false, 'blind overwrite refused');
  assert.equal((await executeTool(ctx, 'read_file', { path: 'a.txt' })).ok, true);
  r = await executeTool(ctx, 'edit_file', { path: 'a.txt', old_string: 'one', new_string: 'ONE' });
  assert.equal(r.ok, true, r.output);
  r = await executeTool(ctx, 'edit_file', { path: 'a.txt', old_string: 'two', new_string: 'TWO' });
  assert.equal(r.ok, true, 'own edit keeps the read fresh');
  fs.writeFileSync(path.join(ws, 'a.txt'), 'someone else\n');
  r = await executeTool(ctx, 'edit_file', { path: 'a.txt', old_string: 'someone', new_string: 'x' });
  assert.equal(r.ok, false);
  assert.match(r.output, /读取之后已被修改/);
  assert.equal((await executeTool(ctx, 'write_file', { path: 'new.txt', content: 'fresh' })).ok, true, 'new files need no read');
  assert.equal((await executeTool({ rt, agentId: 'bingbu' }, 'write_file', { path: 'a.txt', content: 'no guard without a run' })).ok, true);
  // agents' search never reads key files (read_file would ask first)
  fs.writeFileSync(path.join(ws, '.env'), 'API_TOKEN=findme\n');
  fs.writeFileSync(path.join(ws, 'notes.md'), 'findme here\n');
  const found = await executeTool(ctx, 'search', { query: 'findme' });
  assert.match(found.output, /notes\.md/);
  assert.doesNotMatch(found.output, /\.env/);
  rt.dispose();
  await mock.close();
});

test('R5: always-allow per workspace, never for high risk; release needs the workspace opt-in', async () => {
  const mock = await startMockLlm();
  const rt = makeRuntime(mock.url);
  rt.updateSettings({ permissionMode: 'ask' });
  const ws = tmpDir('edict-ws-');
  rt.setWorkspace(ws);
  const root = rt.workspace!.root;
  const ctx = { rt, agentId: 'gongbu' as const };
  // first run: ask, pick 「本工作区永久允许」
  const p1 = executeTool(ctx, 'run_command', { command: 'echo hello' });
  const ap = await waitFor(() => pending(rt, 'action'), 5000, 'action approval');
  assert.deepEqual(ap.choices!.map((c) => c.id), ['once', 'workspace', 'deny']);
  assert.match(ap.ruleLabel!, /「echo」/);
  rt.decideApproval(ap.id, true, 'emperor', 'workspace');
  assert.equal((await p1).ok, true);
  assert.ok(rt.settings.workspacePerms[root].rules.some((x) => x.key === 'cmd:echo'));
  // second run: no approval
  const before = rt.approvals.size;
  assert.equal((await executeTool(ctx, 'run_command', { command: 'echo again' })).ok, true);
  assert.equal(rt.approvals.size, before);
  // deny with a note reaches the agent
  const p2 = executeTool(ctx, 'run_command', { command: 'node -e "1"' });
  const ap2 = await waitFor(() => pending(rt, 'action'), 5000, 'second approval');
  rt.decideApproval(ap2.id, false, 'emperor', 'deny', '改用 npm test');
  const out2 = await p2;
  assert.equal(out2.ok, false);
  assert.match(out2.output, /改用 npm test/);
  // high risk: only once / deny, rules never apply
  const p3 = executeTool(ctx, 'run_command', { command: 'rm -rf build' });
  const ap3 = await waitFor(() => pending(rt, 'action'), 5000, 'high-risk approval');
  assert.equal(ap3.risk, 'high');
  assert.deepEqual(ap3.choices!.map((c) => c.id), ['once', 'deny']);
  rt.decideApproval(ap3.id, false);
  await p3;
  // release: asks every time until the workspace opts in
  const p4 = executeTool(ctx, 'run_command', { command: 'git push origin main' });
  const ap4 = await waitFor(() => pending(rt, 'action'), 5000, 'release approval');
  assert.equal(ap4.risk, 'high');
  assert.match(ap4.reason, /发版\/部署/);
  assert.deepEqual(ap4.choices!.map((c) => c.id), ['once', 'deny']);
  rt.decideApproval(ap4.id, false);
  await p4;
  rt.setReleaseAlways(root, true);
  const n = rt.approvals.size;
  await executeTool(ctx, 'run_command', { command: 'git push origin main' });
  assert.equal(rt.approvals.size, n, 'opted-in workspace runs release commands without asking');
  assert.ok(rt.audit.list({ limit: 20 }).some((e) => e.action === 'approval_auto' && e.detail.by === 'releaseAlways'));
  // …but a high-risk part in the same line still asks
  const p5 = executeTool(ctx, 'run_command', { command: 'git push && rm -rf dist' });
  const ap5 = await waitFor(() => pending(rt, 'action'), 5000, 'mixed approval');
  rt.decideApproval(ap5.id, false);
  await p5;
  rt.removeAllowRule(root, 'cmd:echo');
  assert.ok(!rt.settings.workspacePerms[root].rules.length);
  rt.dispose();
  await mock.close();
});

// ───────────────────────── court flows ─────────────────────────
test('R1: each write subtask asks before it starts; rejecting blocks with the reason', async () => {
  const mock = await startMockLlm();
  const rt = makeRuntime(mock.url);
  rt.updateSettings({ permissionMode: 'auto-edit', finalGate: false });
  rt.setWorkspace(tmpDir('edict-ws-'));
  const r = (await submit(rt, { text: '写一个 greet 函数并测试', tier: 'lite', multiAgent: true })) as { taskId: string };
  const wt = await waitFor(() => pending(rt, 'write_task'), 20000, 'write-task dialog');
  const t = rt.tasks.get(r.taskId)!;
  assert.equal(t.nodes.find((n) => n.id === wt.nodeId)!.status, 'waiting');
  assert.deepEqual(wt.choices!.map((c) => c.id), ['write', 'write_free', 'readonly', 'deny']);
  rt.decideApproval(wt.id, true, 'emperor', 'write', '注意保持导出名不变');
  // S2 (verify) runs a non-safe command in auto-edit → one action approval; allow it for this edict
  const cmd = await waitFor(() => pending(rt, 'action'), 20000, 'command approval');
  assert.match(cmd.summary, /node greet\.test\.js/);
  rt.decideApproval(cmd.id, true, 'emperor', 'task');
  await waitFor(() => stateOf(rt, r.taskId) === 'Done' || stateOf(rt, r.taskId) === 'Blocked', 25000, 'done');
  assert.equal(stateOf(rt, r.taskId), 'Done', t.blockedReason);
  const s1 = t.nodes.find((n) => n.subtaskId === 'S1')!;
  assert.equal(s1.grant, 'write');
  assert.ok(mock.calls.some((c) => c.system.includes('兵部尚书') && c.lastUser.includes('注意保持导出名不变')), 'grant note reaches the ministry');
  assert.ok(t.allowRules?.some((x) => x.key === 'cmd:node greet.test.js'));
  assert.equal(JSON.parse(t.nodes.find((n) => n.subtaskId === 'S2')!.output!).status, 'done');

  // rejection
  const r2 = (await submit(rt, { text: '写一个 greet 函数并测试', tier: 'lite', multiAgent: true })) as { taskId: string };
  const wt2 = await waitFor(() => pending(rt, 'write_task'), 20000, 'second write-task dialog');
  rt.decideApproval(wt2.id, false, 'emperor', 'deny', '先别动代码');
  await waitFor(() => stateOf(rt, r2.taskId) === 'Blocked', 20000, 'blocked');
  const t2 = rt.tasks.get(r2.taskId)!;
  assert.match(t2.blockedReason!, /被皇上驳回/);
  const rej = t2.nodes.find((n) => n.subtaskId === 'S1')!;
  assert.equal(rej.exitStatus, 'rejected');
  assert.match(rej.error!, /先别动代码/);
  rt.cancel(r2.taskId);
  rt.dispose();
  await mock.close();
});

test('R1: a read subtask that tries to write escalates once; 改为只读 keeps it read-only', async () => {
  const mock = await startMockLlm({ brain: planBrain([{ id: 'S1', title: '实现 greet.js', dept: 'bingbu', effect: 'read', detail: '创建 greet.js', acceptance: '可用', dependsOn: [] }]) });
  const rt = makeRuntime(mock.url);
  rt.updateSettings({ permissionMode: 'auto-edit', finalGate: false });
  const ws = tmpDir('edict-ws-');
  rt.setWorkspace(ws);
  const r = (await submit(rt, { text: '写一个 greet 函数', tier: 'lite', multiAgent: true })) as { taskId: string };
  const esc = await waitFor(() => pending(rt, 'escalate'), 20000, 'escalation');
  assert.match(esc.summary, /只读子任务要改文件/);
  assert.deepEqual(esc.choices!.map((c) => c.id), ['write', 'write_free', 'once', 'deny']);
  rt.decideApproval(esc.id, true, 'emperor', 'write_free');
  await waitFor(() => stateOf(rt, r.taskId) === 'Done' || stateOf(rt, r.taskId) === 'Blocked', 25000, 'done');
  assert.equal(stateOf(rt, r.taskId), 'Done', rt.tasks.get(r.taskId)!.blockedReason);
  assert.ok(fs.existsSync(path.join(ws, 'greet.js')));
  assert.equal(rt.tasks.get(r.taskId)!.nodes.find((n) => n.subtaskId === 'S1')!.grant, 'write_free');
  assert.equal([...rt.approvals.values()].filter((a) => a.kind === 'escalate').length, 1);
  rt.dispose();
  await mock.close();

  // write subtask, emperor picks 改为只读执行 → only read tools, no file written, still concludes
  const mock2 = await startMockLlm({ brain: planBrain([{ id: 'S1', title: '实现 greet.js', dept: 'bingbu', effect: 'write', detail: '创建 greet.js', acceptance: '可用', dependsOn: [] }]) });
  const rt2 = makeRuntime(mock2.url);
  rt2.updateSettings({ permissionMode: 'auto-edit', finalGate: false });
  const ws2 = tmpDir('edict-ws-');
  rt2.setWorkspace(ws2);
  const r2 = (await submit(rt2, { text: '写一个 greet 函数', tier: 'lite', multiAgent: true })) as { taskId: string };
  const wt = await waitFor(() => pending(rt2, 'write_task'), 20000, 'write-task dialog');
  rt2.decideApproval(wt.id, true, 'emperor', 'readonly');
  await waitFor(() => !!rt2.tasks.get(r2.taskId)!.nodes.find((n) => n.subtaskId === 'S1' && n.status === 'done') || stateOf(rt2, r2.taskId) === 'Blocked', 25000, 'S1 finished');
  const execCall = mock2.calls.find((c) => c.system.includes('兵部尚书') && c.tools.length)!;
  assert.ok(!execCall.tools.includes('write_file') && execCall.tools.includes('read_file'), 'read tools only');
  assert.ok(execCall.lastUser.includes('改为只读执行'));
  assert.ok(!fs.existsSync(path.join(ws2, 'greet.js')));
  rt2.dispose();
  await mock2.close();
});

test('E7 (Lite): a doubtful conclusion stops at a gate instead of closing unseen', async () => {
  // 兵部 claims an artifact that does not exist
  const base = defaultBrain({});
  const brain: Brain = (c) => {
    if (c.system.includes('你是中书省') && !(c.tools.length && c.toolResults === 0)) return { text: JSON.stringify({ summary: 's', subtasks: [{ id: 'S1', title: '写文档', dept: 'bingbu', effect: 'write', detail: 'd', acceptance: 'a', dependsOn: [] }], risks: [] }) };
    if (c.system.includes('兵部尚书')) return { text: '```json\n{"status":"done","summary":"写好了","artifacts":["DOCS.md"],"verification":"未验证","issues":[]}\n```' };
    return base(c);
  };
  const mock = await startMockLlm({ brain });
  const rt = makeRuntime(mock.url);
  rt.updateSettings({ finalGate: false });
  rt.setWorkspace(tmpDir('edict-ws-'));
  const r = (await submit(rt, { text: '写文档', tier: 'lite', multiAgent: true })) as { taskId: string };
  const t = rt.tasks.get(r.taskId)!;
  await waitFor(() => t.gate?.kind === 'reject_limit' || t.state === 'Done' || t.state === 'Blocked', 25000, 'doubt gate');
  assert.equal(t.gate?.kind, 'reject_limit', t.blockedReason);
  assert.match(t.gate!.message, /成果存疑/);
  assert.match(t.gate!.message, /DOCS\.md/);
  decideGate(rt, r.taskId, { approve: true, comment: '知道了，结案' });
  await waitFor(() => t.state === 'Done', 10000, 'done after emperor approval');
  rt.dispose();
  await mock.close();
});

test('R2: an unstructured conclusion gets one format-repair turn', async () => {
  const base = defaultBrain({});
  const brain: Brain = (c) => {
    if (c.system.includes('兵部尚书') && !c.tools.length && c.lastUser.includes('请只输出结构化结论')) return { text: '```json\n{"status":"done","summary":"修正后","artifacts":[],"verification":"已看","issues":[]}\n```' };
    if (c.system.includes('兵部尚书')) return { text: '做完了。' };
    return base(c);
  };
  const mock = await startMockLlm({ brain });
  const rt = makeRuntime(mock.url);
  const r = await runAgent({ rt, agentId: 'bingbu', prompt: 'x' });
  assert.equal(r.text, '做完了。');
  rt.dispose();
  await mock.close();
  // through the engine (no workspace: text-only subtask)
  const mock2 = await startMockLlm({ brain: (c) => (c.system.includes('你是中书省') ? { text: JSON.stringify({ summary: 's', subtasks: [{ id: 'S1', title: '答复', dept: 'bingbu', detail: 'd', acceptance: 'a', dependsOn: [] }], risks: [] }) } : brain(c)) });
  const rt2 = makeRuntime(mock2.url);
  rt2.updateSettings({ finalGate: false });
  const s = (await submit(rt2, { text: '回答一个问题', tier: 'lite', multiAgent: true })) as { taskId: string };
  await waitFor(() => ['Done', 'Blocked'].includes(stateOf(rt2, s.taskId)), 25000, 'done');
  const node = rt2.tasks.get(s.taskId)!.nodes.find((n) => n.kind === 'exec')!;
  assert.equal(JSON.parse(node.output!).summary, '修正后');
  rt2.dispose();
  await mock2.close();
});

test('R8 / R9: doom loop warns on the 3rd identical call and asks on the 4th; reads in one step run as a batch', async () => {
  let n = 0;
  const brain: Brain = (c) => {
    if (c.system.includes('上下文压缩器')) return { text: '摘要' };
    if (c.toolResults === 0) return { toolCalls: [{ name: 'read_file', args: { path: 'a.txt' } }, { name: 'list_dir', args: {} }, { name: 'search', args: { query: 'x' } }] };
    if (c.toolResults < 7) return { toolCalls: [{ name: 'list_dir', args: { path: 'sub' } }] };
    n++;
    return { text: '完成' };
  };
  const mock = await startMockLlm({ brain });
  const rt = makeRuntime(mock.url);
  const ws = tmpDir('edict-ws-');
  fs.writeFileSync(path.join(ws, 'a.txt'), 'x');
  fs.mkdirSync(path.join(ws, 'sub'));
  rt.setWorkspace(ws);
  const run = runAgent({ rt, agentId: 'bingbu', prompt: 'go', tools: ['read_file', 'list_dir', 'search'], maxSteps: 10 });
  const ap = await waitFor(() => pending(rt, 'loop'), 10000, 'loop approval');
  assert.match(ap.summary, /疑似死循环/);
  rt.decideApproval(ap.id, false);
  const res = await run;
  assert.equal(res.text, '完成');
  const acts = rt.activities(undefined, 200).filter((a) => a.kind === 'tool_call' || a.kind === 'tool_result');
  assert.deepEqual(acts.slice(0, 6).map((a) => a.kind), ['tool_call', 'tool_call', 'tool_call', 'tool_result', 'tool_result', 'tool_result'], 'first step ran as one batch');
  const results = rt.activities(undefined, 200).filter((a) => a.kind === 'tool_result' && (a.data as { name?: string })?.name === 'list_dir');
  assert.ok(results.some((a) => a.content.includes('【系统提示】')), 'third identical call carries the hint');
  assert.ok(results.some((a) => a.content.includes('皇上叫停了这次重复调用')));
  assert.equal(res.toolCounts.list_dir >= 4, true);
  rt.dispose();
  await mock.close();
});

test('R6: a context-length error compresses and retries once', async () => {
  let rejected = 0;
  const mock = await startMockLlm({
    reject: (c) => (c.system.includes('兵部尚书') && rejected++ === 0 ? { status: 400, body: '{"error":{"message":"This model\'s maximum context length is 8192 tokens. However, your messages resulted in 9000 tokens."}}' } : undefined),
  });
  const rt = makeRuntime(mock.url);
  const r = await runAgent({ rt, agentId: 'bingbu', prompt: '总结一下' });
  assert.ok(r.text.length > 0);
  assert.equal(rejected, 2);
  assert.ok(rt.audit.list({ limit: 30 }).some((e) => e.action === 'context_overflow'));
  rt.dispose();
  await mock.close();
});

test('E5: a node over its wall-clock limit fails (not cancels) and blocks for local retry', async () => {
  const mock = await startMockLlm({ delayFor: (c) => (c.system.includes('兵部尚书') ? 400 : undefined) });
  const rt = makeRuntime(mock.url);
  rt.updateSettings({ nodeTimeoutMin: 0.02, finalGate: false }); // 1.2 s
  rt.setWorkspace(tmpDir('edict-ws-'));
  const r = (await submit(rt, { text: '写一个 greet 函数并测试', tier: 'lite', multiAgent: true })) as { taskId: string };
  await waitFor(() => ['Blocked', 'Done'].includes(stateOf(rt, r.taskId)), 30000, 'blocked by timeout');
  const t = rt.tasks.get(r.taskId)!;
  assert.equal(t.state, 'Blocked');
  const n = t.nodes.find((x) => x.status === 'failed')!;
  assert.equal(n.exitStatus, 'error');
  assert.match(n.error!, /超过单节点时限/);
  assert.notEqual(t.state, 'Cancelled');
  rt.dispose();
  await mock.close();
});

test('approvals: choices are validated; a required note must be given; system denial ignores choices', async () => {
  const mock = await startMockLlm();
  const rt = makeRuntime(mock.url);
  const p = rt.requestDecision({ agentId: 'bingbu', tool: 'x', summary: 's', detail: '', risk: 'normal', reason: 'r', choices: [{ id: 'go', label: 'go', approve: true }, { id: 'why', label: 'why', approve: false, comment: 'required' }] });
  const ap = [...rt.approvals.values()].find((a) => a.status === 'pending') as ApprovalRequest;
  assert.throws(() => rt.decideApproval(ap.id, true, 'emperor', 'nope'), /无效的选项/);
  assert.throws(() => rt.decideApproval(ap.id, false, 'emperor', 'why'), /理由/);
  rt.decideApproval(ap.id, true, 'emperor', 'why', '因为');
  const d = await p;
  assert.deepEqual(d, { approve: false, choice: 'why', comment: '因为' }, 'the choice decides approve, not the flag');
  rt.dispose();
  await mock.close();
});
