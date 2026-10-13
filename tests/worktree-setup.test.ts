// 工作树准备 and ports (2.1): files copied and a script run in each new edict worktree; a port block per worktree
// (mock/integration: MOCK LLM server, real git and a real shell in temp folders).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { startMockLlm } from './mockLlm';
import { makeRuntime, tmpDir, waitFor, stateOf } from './helpers';
import { submit } from '../src/main/runtime/orchestrator';
import { executeTool } from '../src/main/runtime/tools';
import { copyEntryProblem, expandCopyEntry, saveWorktreeSetup, worktreeNote, worktreeSetupOf, PORT_BLOCK } from '../src/main/runtime/worktreeSetup';
import type { Task } from '../src/shared/types';

type Rt = ReturnType<typeof makeRuntime>;

const gitc = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
function makeRepo() {
  const dir = tmpDir('edict-setup-repo-');
  gitc(dir, 'init', '-q', '-b', 'main');
  gitc(dir, 'config', 'user.name', 'Test');
  gitc(dir, 'config', 'user.email', 'test@example.com');
  gitc(dir, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(dir, 'README.md'), '# demo\n');
  fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n.env*\nconfig/*.local.json\n');
  gitc(dir, 'add', '-A');
  gitc(dir, 'commit', '-q', '-m', 'init');
  fs.mkdirSync(path.join(dir, 'node_modules/dep'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.env'), 'A=1\n');
  fs.writeFileSync(path.join(dir, '.env.local'), 'B=2\n');
  fs.mkdirSync(path.join(dir, 'config'));
  fs.writeFileSync(path.join(dir, 'config/app.local.json'), '{"x":1}\n');
  return dir;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function finish(rt: Rt, mock: { close: () => Promise<void> }) {
  for (const t of rt.tasks.values()) rt.cancel(t.id, 'test over');
  for (const a of rt.approvals.values()) if (a.status === 'pending') rt.decideApproval(a.id, false, 'system');
  await sleep(150);
  for (const a of rt.approvals.values()) if (a.status === 'pending') rt.decideApproval(a.id, false, 'system');
  rt.dispose();
  await mock.close();
}

async function startEdict(rt: Rt): Promise<Task> {
  const r = (await submit(rt, { text: '写一个 greet 函数并测试', tier: 'lite', multiAgent: true })) as { taskId: string };
  return rt.tasks.get(r.taskId)!;
}

test('copy entries: relative paths only, wildcards in the last part', () => {
  assert.equal(copyEntryProblem('.env'), null);
  assert.equal(copyEntryProblem('config/*.local.json'), null);
  assert.match(copyEntryProblem('/etc/passwd')!, /相对/);
  assert.match(copyEntryProblem('~/x')!, /相对/);
  assert.match(copyEntryProblem('../x')!, /\.\./);
  assert.match(copyEntryProblem('*/x')!, /最后一段/);
  assert.match(copyEntryProblem('.git/config')!, /\.git/);
  const repo = makeRepo();
  assert.deepEqual(expandCopyEntry(repo, '.env*').sort(), ['.env', '.env.local']);
  assert.deepEqual(expandCopyEntry(repo, 'config/*.local.json'), ['config/app.local.json']);
  assert.deepEqual(expandCopyEntry(repo, 'nope.txt'), []);
});

test('saved per workspace and validated; release / sandbox settings of the workspace survive each other', async () => {
  const mock = await startMockLlm();
  const rt = makeRuntime(mock.url);
  const repo = makeRepo();
  rt.setWorkspace(repo);
  const root = rt.workspace!.root;
  assert.deepEqual(worktreeSetupOf(rt, root), { script: '', copy: [], linkDeps: true, timeoutMin: 10 }, 'defaults');
  assert.throws(() => saveWorktreeSetup(rt, root, { copy: ['../secret'] }), /\.\./);
  assert.throws(() => saveWorktreeSetup(rt, root, { timeoutMin: 0 }), /1～120/);
  saveWorktreeSetup(rt, root, { script: 'npm ci\r\n', copy: ['.env', '.env'], linkDeps: false });
  assert.deepEqual(worktreeSetupOf(rt, root), { script: 'npm ci', copy: ['.env'], linkDeps: false, timeoutMin: 10 });
  rt.setReleaseAlways(root, true);
  assert.equal(worktreeSetupOf(rt, root).script, 'npm ci', 'the release switch keeps the setup');
  assert.equal(rt.settings.workspacePerms[root].releaseAlways, true);
  assert.ok(rt.audit.list({ limit: 50 }).some((e) => e.action === 'worktree_setup_settings'));
  await finish(rt, mock);
});

test('a new edict worktree gets the copied files, its own ports and the script, before officials start', async () => {
  const mock = await startMockLlm();
  const rt = makeRuntime(mock.url);
  const repo = makeRepo();
  rt.setWorkspace(repo);
  const root = rt.workspace!.root;
  saveWorktreeSetup(rt, root, {
    copy: ['.env*', 'config/*.local.json', 'missing.txt'],
    linkDeps: false,
    script: 'echo "$EDICT_PORT $EDICT_PORT_RANGE" > port.txt && echo "$EDICT_ROOT_PATH" > root.txt && test -f .env && ls greet.js 2>/dev/null; echo ready > setup-ok.txt',
  });
  const t = await startEdict(rt);
  await waitFor(() => t.gate?.kind === 'final' || stateOf(rt, t.id) === 'Blocked', 30000, 'final gate');
  const w = t.worktree!;
  assert.ok(w?.ports, 'a port block');
  assert.equal(w.ports!.to - w.ports!.from + 1, PORT_BLOCK);
  assert.ok(w.ports!.from >= 42000);
  // copied (ignored files only; nothing tracked is overwritten), not linked
  assert.equal(fs.readFileSync(path.join(w.path, '.env'), 'utf8'), 'A=1\n');
  assert.ok(fs.existsSync(path.join(w.path, '.env.local')));
  assert.ok(fs.existsSync(path.join(w.path, 'config/app.local.json')));
  assert.ok(!fs.existsSync(path.join(w.path, 'node_modules')), 'linkDeps off');
  assert.deepEqual(w.setup!.copied.sort(), ['.env', '.env.local', 'config/app.local.json']);
  assert.deepEqual(w.setup!.missing, ['missing.txt']);
  // the script ran in the worktree with the ports and the main folder, before the ministry wrote greet.js
  assert.equal(w.setup!.ok, true, w.setup!.output);
  assert.equal(fs.readFileSync(path.join(w.path, 'port.txt'), 'utf8').trim(), `${w.ports!.from} ${w.ports!.from}-${w.ports!.to}`);
  assert.equal(fs.readFileSync(path.join(w.path, 'root.txt'), 'utf8').trim(), root);
  assert.doesNotMatch(w.setup!.output ?? '', /greet\.js/, 'nothing written before the setup finished');
  assert.ok(fs.existsSync(path.join(w.path, 'greet.js')));
  // officials' commands see the ports; the prompt tells them
  const r = await executeTool({ rt, agentId: 'bingbu', task: t }, 'run_command', { command: 'echo "port=$EDICT_PORT"' });
  assert.match(r.output, new RegExp(`port=${w.ports!.from}`));
  assert.match(worktreeNote(w), new RegExp(`独占端口 ${w.ports!.from}–${w.ports!.to}`));
  const s1 = mock.calls.find((c) => c.system.includes('兵部尚书'))!;
  assert.ok(s1, 'ministry called');
  const audit = rt.audit.list({ taskId: t.id, limit: 200 });
  assert.ok(audit.some((e) => e.action === 'worktree_setup' && (e.detail as { ok?: boolean }).ok === true));
  // the main checkout untouched
  assert.ok(!fs.existsSync(path.join(repo, 'port.txt')));
  await finish(rt, mock);
});

test('two edicts at once get different port blocks; a busy port is skipped; a failing script does not stop the edict', async () => {
  const mock = await startMockLlm();
  const rt = makeRuntime(mock.url);
  const repo = makeRepo();
  rt.setWorkspace(repo);
  // something else already listens on the first port of the range
  const base = 43000 + Math.floor(Math.random() * 500) * 10;
  rt.updateSettings({ worktreePortBase: base });
  const busy = net.createServer();
  await new Promise<void>((r) => busy.listen(base, '127.0.0.1', () => r()));
  saveWorktreeSetup(rt, rt.workspace!.root, { script: 'echo boom >&2; exit 3' });
  const [a, b] = await Promise.all([startEdict(rt), startEdict(rt)]);
  await waitFor(() => a.worktree?.setup && b.worktree?.setup, 30000, 'both set up');
  assert.notEqual(a.worktree!.ports!.from, b.worktree!.ports!.from);
  assert.ok(![a, b].some((t) => t.worktree!.ports!.from === base), 'the busy port block is skipped');
  for (const t of [a, b]) {
    assert.equal(t.worktree!.setup!.ok, false);
    assert.equal(t.worktree!.setup!.exitCode, 3);
    assert.match(t.worktree!.setup!.output!, /boom/);
    assert.match(worktreeNote(t.worktree), /准备脚本没有成功/);
  }
  await waitFor(() => a.gate?.kind === 'final' && b.gate?.kind === 'final', 40000, 'both reach the final gate anyway');
  // a freed block goes to the next worktree
  busy.close();
  await finish(rt, mock);
});
