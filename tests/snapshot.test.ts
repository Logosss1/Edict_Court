// R7 (run_command side effects via shadow snapshots) and E3 (revert a whole node / edict).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { startMockLlm } from './mockLlm';
import { makeRuntime, tmpDir, waitFor, stateOf } from './helpers';
import { createTask, revertNodeAndRedo, submit } from '../src/main/runtime/orchestrator';
import { executeTool } from '../src/main/runtime/tools';
import { checkEvidence } from '../src/main/runtime/execPolicy';
import { sha256 } from '../src/main/runtime/util';
import type { AgentId, RunNode, Task } from '../src/shared/types';

type Rt = ReturnType<typeof makeRuntime>;

/** runtime + workspace + edict without driving it (tools are called directly) */
function setup(files: Record<string, string | Buffer> = {}) {
  const rt = makeRuntime('http://127.0.0.1:9/v1');
  const ws = tmpDir('edict-ws-');
  for (const [p, c] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(ws, p)), { recursive: true });
    fs.writeFileSync(path.join(ws, p), c);
  }
  rt.setWorkspace(ws);
  const t = createTask(rt, { text: '快照测试', tier: 'lite', title: '快照测试', model: null });
  return { rt, ws, t };
}

function addNode(rt: Rt, t: Task, id: string, agentId: AgentId = 'bingbu'): RunNode {
  const n: RunNode = { id, kind: 'exec', agentId, label: `节点 ${id}`, status: 'running', attempts: 1, effect: 'write', grant: 'write_free', subtaskId: id };
  t.nodes.push(n);
  return n;
}

const ctxOf = (rt: Rt, t: Task, n: RunNode, reads?: Map<string, string>) => ({ rt, task: t, node: n, agentId: n.agentId, reads });
const cmd = (rt: Rt, t: Task, n: RunNode, command: string) => executeTool(ctxOf(rt, t, n), 'run_command', { command });
const read = (ws: string, p: string) => fs.readFileSync(path.join(ws, p), 'utf8');
const exists = (ws: string, p: string) => fs.existsSync(path.join(ws, p));

/** count snapshot calls */
function spyTake(rt: Rt) {
  const orig = rt.snapshots.take.bind(rt.snapshots);
  const spy = { calls: 0 };
  rt.snapshots.take = async (root: string) => {
    spy.calls++;
    return orig(root);
  };
  return spy;
}

test("R7: a command's create / modify / delete are recorded via 'command', counted as evidence, and revert (binary-safe)", async () => {
  const { rt, ws, t } = setup({ 'a.txt': 'one\n', 'b.txt': 'bee\n', 'bin.dat': Buffer.from([0, 9, 8, 255, 0, 7]) });
  const n = addNode(rt, t, 'n1');
  const reads = new Map<string, string>();
  assert.equal((await executeTool(ctxOf(rt, t, n, reads), 'read_file', { path: 'a.txt' })).ok, true);
  const command = "printf 'new\\n' > c.txt && printf 'ONE\\n' > a.txt && rm b.txt";
  const r = await executeTool(ctxOf(rt, t, n, reads), 'run_command', { command });
  assert.equal(r.ok, true, r.output);
  assert.match(r.output, /命令改动了 3 个文件，已记录，可撤回/);
  assert.equal(t.changes.length, 3);
  assert.ok(t.changes.every((c) => c.via === 'command' && c.command === command && c.nodeId === 'n1' && c.agentId === 'bingbu'));
  const by = (p: string) => t.changes.find((c) => c.path === p)!;
  assert.equal(by('c.txt').op, 'create');
  assert.equal(by('a.txt').op, 'modify');
  assert.equal(by('b.txt').op, 'delete');
  assert.equal(rt.blobs.get(by('a.txt').beforeHash!)!.toString(), 'one\n', 'before content comes from the snapshot');
  assert.equal(by('a.txt').afterHash, sha256('ONE\n'));
  // the agent never saw what the command wrote: editing needs a fresh read
  const stale = await executeTool(ctxOf(rt, t, n, reads), 'edit_file', { path: 'a.txt', old_string: 'ONE', new_string: 'x' });
  assert.match(stale.output, /读取之后已被修改/);
  // view_changes, evidence, 尚书 summary
  const v = await executeTool(ctxOf(rt, t, n), 'view_changes', {});
  assert.match(v.output, /### c\.txt \(新建\) · 由命令/);
  assert.match(v.output, /### b\.txt \(删除\)/);
  const ev = checkEvidence(t, n, { status: 'done', summary: 's', artifacts: [], verification: '', issues: [] }, { run_command: 1 }, rt.workspace!);
  assert.equal(ev.conclusion.status, 'done', 'command changes are evidence for a write task');
  assert.match(ev.systemCheck.join('\n'), /create:c\.txt（命令）/);
  // binary file changed by a command
  const r2 = await cmd(rt, t, n, `node -e "require('fs').writeFileSync('bin.dat', Buffer.from([0,1,2,255]))"`);
  assert.match(r2.output, /命令改动了 1 个文件/);
  const bin = by('bin.dat');
  assert.equal(bin.binary, true);
  // revert one by one
  for (const c of [...t.changes].reverse()) rt.revertChange(t.id, c.id);
  assert.equal(read(ws, 'a.txt'), 'one\n');
  assert.equal(read(ws, 'b.txt'), 'bee\n');
  assert.equal(exists(ws, 'c.txt'), false);
  assert.deepEqual([...fs.readFileSync(path.join(ws, 'bin.dat'))], [0, 9, 8, 255, 0, 7], 'binary content restored byte for byte');
  assert.ok(t.changes.every((c) => c.reverted));
  rt.dispose();
});

test('R7: look-only commands and the setting skip snapshots; commands that change nothing record nothing', async () => {
  const { rt, ws, t } = setup({ 'a.txt': 'a\n' });
  const n = addNode(rt, t, 'n1');
  const spy = spyTake(rt);
  assert.equal((await cmd(rt, t, n, 'ls && cat a.txt')).ok, true);
  assert.equal((await cmd(rt, t, n, 'pwd; wc -l a.txt')).ok, true);
  assert.equal(spy.calls, 0, 'look-only commands are not snapshotted');
  assert.equal(fs.existsSync(path.join(rt.opts.dataDir, 'snapshots')), false);
  const quiet = await cmd(rt, t, n, 'node -e "1"');
  assert.equal(spy.calls, 2);
  assert.doesNotMatch(quiet.output, /命令改动了/);
  assert.equal(t.changes.length, 0);
  // per-command cap on recorded entries
  rt.snapshots.limits.maxChanges = 2;
  const many = await cmd(rt, t, n, 'printf 1 > m1.txt && printf 2 > m2.txt && printf 3 > m3.txt');
  assert.match(many.output, /命令改动了 2 个文件，已记录，可撤回；实际改动 3 个，只记录了前 2 个/);
  assert.equal(t.changes.length, 2);
  rt.updateSettings({ commandSnapshots: false });
  const off = await cmd(rt, t, n, 'printf x > b.txt');
  assert.equal(off.ok, true);
  assert.equal(spy.calls, 4, 'setting off → no snapshots');
  assert.equal(t.changes.length, 2);
  assert.equal(read(ws, 'b.txt'), 'x');
  rt.dispose();
});

test("R7: the workspace's .gitignore, heavy dirs and key files are left out; a plain folder works and gets no .git", async () => {
  const { rt, ws, t } = setup({ '.gitignore': 'gen/\n*.log\n', 'src/keep.ts': 'export {}\n' });
  const n = addNode(rt, t, 'n1');
  const r = await cmd(rt, t, n, 'mkdir -p gen node_modules/pkg src && printf 1 > gen/x.js && printf 2 > app.log && printf 3 > node_modules/pkg/i.js && printf 4 > .env.local && printf 5 > src/real.ts');
  assert.equal(r.ok, true, r.output);
  assert.deepEqual(t.changes.map((c) => c.path), ['src/real.ts']);
  assert.equal(exists(ws, '.git'), false, 'the shadow repo lives in the data dir, not the workspace');
  // a file the workspace starts ignoring leaves the snapshot instead of showing up as changed
  fs.appendFileSync(path.join(ws, '.gitignore'), 'src/keep.ts\n');
  await cmd(rt, t, n, 'printf changed > src/keep.ts');
  assert.deepEqual(t.changes.map((c) => c.path), ['src/real.ts']);
  rt.dispose();
});

test("R7: a workspace that is a git repo keeps its own index and refs untouched", async () => {
  const { rt, ws, t } = setup({ 'tracked.txt': 'v1\n' });
  const g = (...a: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: ws, encoding: 'utf8' });
  g('init', '-q');
  g('add', 'tracked.txt');
  g('commit', '-qm', 'init');
  const n = addNode(rt, t, 'n1');
  const r = await cmd(rt, t, n, "printf 'v2\\n' > tracked.txt");
  assert.match(r.output, /命令改动了 1 个文件/);
  assert.equal(t.changes[0].path, 'tracked.txt');
  assert.equal(g('status', '--porcelain').trim(), 'M tracked.txt', 'only a worktree change, nothing staged by the snapshot');
  assert.equal(g('for-each-ref').trim().split('\n').length, 1, 'no snapshot refs in the workspace repo');
  rt.dispose();
});

test('R7: files over the size cap are listed without content and cannot be reverted; the memorial still hashes them', async () => {
  const { rt, ws, t } = setup({ 'big.bin': 'x'.repeat(5000), 'note.txt': 'n\n' });
  rt.snapshots.limits.maxFileBytes = 1024;
  const n = addNode(rt, t, 'n1');
  const r = await cmd(rt, t, n, "printf y >> big.bin && head -c 3000 /dev/zero > big2.bin && printf hi > small.txt");
  assert.equal(r.ok, true, r.output);
  assert.match(r.output, /命令改动了 3 个文件.*其中 2 个超过 1 KB/);
  const by = (p: string) => t.changes.find((c) => c.path === p)!;
  assert.equal(by('big.bin').op, 'modify');
  assert.equal(by('big.bin').oversize, true);
  assert.equal(by('big.bin').beforeHash, null);
  assert.equal(by('big2.bin').op, 'create');
  assert.equal(by('big2.bin').oversize, true);
  assert.equal(by('small.txt').oversize, undefined);
  assert.equal(rt.blobs.has(sha256(fs.readFileSync(path.join(ws, 'big.bin')))), false, 'big content never stored');
  assert.throws(() => rt.revertChange(t.id, by('big.bin').id), /无法撤回/);
  const v = await executeTool(ctxOf(rt, t, n), 'view_changes', { path: 'big2.bin' });
  assert.match(v.output, /只记录了文件名/);
  n.status = 'done';
  const res = rt.revertTask(t.id);
  assert.deepEqual(res, { reverted: ['small.txt'], conflicts: [], skipped: ['big2.bin', 'big.bin'] });
  // unchanged big files are not reported again
  const again = await cmd(rt, t, n, 'printf z > other.txt');
  assert.match(again.output, /命令改动了 1 个文件/);
  rt.cancel(t.id);
  const art = rt.memorials.get(t.id)!.artifacts.find((a) => a.path === 'big2.bin')!;
  assert.equal(art.bytes, 3000);
  assert.equal(art.sha256, sha256(Buffer.alloc(3000)));
  rt.dispose();
});

test('R7: too many files disables snapshots for the root (audited once); the command still runs', async () => {
  const files: Record<string, string> = {};
  for (let i = 0; i < 8; i++) files[`f${i}.txt`] = String(i);
  const { rt, ws, t } = setup(files);
  rt.snapshots.limits.maxFiles = 5;
  const n = addNode(rt, t, 'n1');
  const r = await cmd(rt, t, n, 'printf x > new.txt');
  assert.equal(r.ok, true);
  assert.match(r.output, /未能记录命令的文件改动：工作区文件过多/);
  assert.equal(read(ws, 'new.txt'), 'x');
  await cmd(rt, t, n, 'printf y > new2.txt');
  assert.equal(t.changes.length, 0);
  const audit = rt.audit.list({ limit: 1000 });
  assert.equal(audit.filter((e) => e.action === 'snapshot_disabled').length, 1);
  assert.ok(audit.filter((e) => e.action === 'command_snapshot_skipped').length >= 2);
  rt.dispose();
});

test('R7: parallel snapshot pairs on one root never collide on index.lock', async () => {
  const { rt, ws, t } = setup({ 'a.txt': 'a' });
  const roots = await Promise.all([0, 1, 2, 3, 4].map((i) => rt.snapshots.around(ws, async () => fs.writeFileSync(path.join(ws, `p${i}.txt`), String(i)))));
  assert.ok(roots.every((x) => x.tracked), roots.map((x) => x.note).join(' | '));
  for (let i = 0; i < 5; i++) assert.ok(roots[i].changes.some((c) => c.path === `p${i}.txt`));
  assert.equal(t.changes.length, 0);
  rt.dispose();
});

test('R7: the shadow repo is gc-ed past 80% of its cap; trees of in-flight pairs survive', async () => {
  const { rt, ws } = setup({ 'r.bin': randomBytes(30 * 1024) });
  const s = rt.snapshots;
  s.limits.maxRepoBytes = 100 * 1024;
  const pinned = (await s.take(ws))!;
  for (let i = 0; i < 4; i++) assert.ok((await s.around(ws, async () => fs.writeFileSync(path.join(ws, 'r.bin'), randomBytes(30 * 1024)))).tracked);
  const gc = rt.audit.list({ limit: 1000 }).filter((e) => e.action === 'snapshot_gc');
  assert.ok(gc.length >= 1, 'gc ran');
  assert.ok((gc.at(-1)!.detail.afterBytes as number) < (gc.at(-1)!.detail.beforeBytes as number));
  const now = (await s.take(ws))!;
  const d = await s.diff(pinned, now);
  assert.deepEqual(d.changes.map((c) => c.path), ['r.bin'], 'the pinned tree was kept through gc');
  assert.ok(Buffer.isBuffer(d.changes[0].before));
  await s.release(pinned, now);
  assert.equal(s.disabled(ws), null);
  // past the cap even after gc (or more new content than the cap): off for this root, shadow repo removed
  s.limits.maxRepoBytes = 10 * 1024;
  const over = await s.around(ws, async () => fs.writeFileSync(path.join(ws, 'r.bin'), randomBytes(30 * 1024)));
  assert.equal(over.tracked, false);
  assert.match(s.disabled(ws) ?? '', /上限/);
  assert.equal(await s.take(ws), null);
  assert.equal(fs.existsSync(s.dirFor(ws)), false, 'the shadow repo of a disabled root is removed');
  rt.dispose();
});

test('E3: revertNode / revertTask go newest first and stop on conflicts without touching anything', async () => {
  const { rt, ws, t } = setup({ 'c.txt': 'c0\n' });
  const n1 = addNode(rt, t, 'n1', 'bingbu');
  const c1 = ctxOf(rt, t, n1, new Map());
  assert.equal((await executeTool(c1, 'write_file', { path: 'a.txt', content: 'v1\n' })).ok, true);
  assert.equal((await executeTool(c1, 'edit_file', { path: 'a.txt', old_string: 'v1', new_string: 'v2' })).ok, true);
  assert.match((await cmd(rt, t, n1, "printf b > b.txt && printf 'c1\\n' > c.txt")).output, /命令改动了 2 个文件/);
  n1.status = 'done';
  rt.releaseWriteLock(t.id, 'n1');
  const n2 = addNode(rt, t, 'n2', 'gongbu');
  assert.equal((await executeTool(ctxOf(rt, t, n2), 'write_file', { path: 'd.txt', content: 'd' })).ok, true);
  assert.match((await cmd(rt, t, n2, "printf 'c2\\n' > c.txt")).output, /命令改动了 1 个文件/);
  n2.status = 'done';
  // n2 changed c.txt after n1: reverting n1 alone would clobber it → nothing happens
  const blocked = rt.revertNode(t.id, 'n1');
  assert.deepEqual(blocked, { reverted: [], conflicts: ['c.txt'], skipped: [] });
  assert.equal(read(ws, 'a.txt'), 'v2\n');
  assert.equal(exists(ws, 'b.txt'), true);
  assert.ok(t.changes.every((c) => !c.reverted));
  const r2 = rt.revertNode(t.id, 'n2');
  assert.deepEqual(r2.reverted.sort(), ['c.txt', 'd.txt']);
  assert.equal(read(ws, 'c.txt'), 'c1\n');
  // n1 now reverts cleanly, newest first: a.txt v2 → v1 → (created) gone
  const r1 = rt.revertNode(t.id, 'n1');
  assert.deepEqual(r1, { reverted: ['c.txt', 'b.txt', 'a.txt'], conflicts: [], skipped: [] });
  assert.equal(read(ws, 'c.txt'), 'c0\n');
  assert.equal(exists(ws, 'a.txt'), false);
  assert.equal(exists(ws, 'b.txt'), false);
  const order = rt.audit.list({ limit: 1000 }).filter((e) => e.action === 'revert_change' && e.detail.scope === 'node').map((e) => e.detail.path);
  assert.deepEqual(order, ['c.txt', 'd.txt', 'c.txt', 'b.txt', 'a.txt', 'a.txt']);
  assert.ok(rt.audit.list({ limit: 1000 }).some((e) => e.action === 'revert_node' && e.detail.nodeId === 'n1' && (e.detail.conflicts as string[]).length === 1));
  assert.throws(() => rt.revertNode(t.id, 'nope'), /节点不存在/);
  // whole edict: a human edit after the agent's write is a conflict; force overwrites it
  const n3 = addNode(rt, t, 'n3', 'libu');
  rt.releaseWriteLock(t.id, 'n2');
  await executeTool(ctxOf(rt, t, n3), 'write_file', { path: 'e.txt', content: 'agent' });
  await cmd(rt, t, n3, 'printf f > f.txt');
  assert.throws(() => rt.revertTask(t.id), /正在执行/);
  n3.status = 'done';
  fs.writeFileSync(path.join(ws, 'e.txt'), 'human');
  assert.deepEqual(rt.revertTask(t.id), { reverted: [], conflicts: ['e.txt'], skipped: [] });
  assert.equal(exists(ws, 'f.txt'), true);
  assert.deepEqual(rt.revertTask(t.id, { force: true }), { reverted: ['f.txt', 'e.txt'], conflicts: [], skipped: [] });
  assert.equal(exists(ws, 'e.txt'), false);
  assert.ok(t.changes.every((c) => c.reverted));
  rt.dispose();
});

test('E3: revert a ministry at the 御批 gate and redo it as rework', async () => {
  const mock = await startMockLlm();
  const rt = makeRuntime(mock.url);
  const ws = tmpDir('edict-ws-');
  rt.setWorkspace(ws);
  const r = await submit(rt, { text: '写一个 greet 函数并测试', tier: 'lite', multiAgent: true });
  const id = (r as { taskId: string }).taskId;
  await waitFor(() => rt.tasks.get(id)!.gate?.kind === 'final' || stateOf(rt, id) === 'Blocked', 20000, 'final gate');
  const t = rt.tasks.get(id)!;
  assert.equal(t.state, 'PendingConfirm', t.blockedReason);
  assert.ok(t.changes.some((c) => c.nodeId === 'exec-S1-r1' && c.path === 'greet.js'));
  assert.throws(() => revertNodeAndRedo(rt, id, 'triage'), /撤回并重做/);
  const res = revertNodeAndRedo(rt, id, 'exec-S1-r1', { comment: '换个写法' });
  assert.deepEqual(res, { reverted: ['greet.js'], conflicts: [], skipped: [], redo: 'rework' });
  assert.equal(t.rework?.targets.join(), 'S1');
  assert.match(t.rework?.feedback ?? '', /换个写法[\s\S]*已撤回/);
  await waitFor(() => (rt.tasks.get(id)!.gate?.kind === 'final' && t.nodes.some((n) => n.id === 'exec-S1-r2' && n.status === 'done')) || stateOf(rt, id) === 'Blocked', 20000, 'rework done');
  assert.equal(t.state, 'PendingConfirm', t.blockedReason);
  assert.ok(exists(ws, 'greet.js'), 'S1 wrote greet.js again');
  const g = t.changes.filter((c) => c.path === 'greet.js');
  assert.deepEqual(g.map((c) => [c.nodeId, !!c.reverted]), [['exec-S1-r1', true], ['exec-S1-r2', false]]);
  rt.dispose();
  await mock.close();
});
