// Edict 2.0 settings center backends: 存储与备份 (backupNow / storageInfo), desktop notification gating
// (settings.notify) and the always-allow rules shown on 权限与审批 (source + revoking an edict-scoped rule).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { MemorySecrets, makeRuntime, tmpDir, waitFor } from './helpers';
import { Runtime } from '../src/main/runtime/runtime';
import { installOrchestrator, block } from '../src/main/runtime/orchestrator';
import { backupNow, backupPath, listBackups, storageInfo } from '../src/main/runtime/storage';
import { executeTool } from '../src/main/runtime/tools';
import type { RunNode, Task } from '../src/shared/types';

const NO_LLM = 'http://127.0.0.1:9/v1'; // never called in these tests

function fakeTask(rt: Runtime, id: string, over: Partial<Task> = {}): Task {
  const at = Date.now();
  const t = {
    id, title: `旨意 ${id}`, edict: 'x', tier: 'lite', state: 'Doing', flow: [], planHistory: [], reviews: [], nodes: [], paused: false, changes: [],
    usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0, costUsd: 0, calls: 0 }, budget: { maxTokens: 0, maxRejections: 1, maxCostUsd: 0 },
    createdAt: at, updatedAt: at, lastActivityAt: at, workspace: rt.workspace?.root ?? null, ...over,
  } as Task;
  rt.tasks.set(id, t);
  return t;
}

test('backupNow: flushes pending writes, writes a consistent copy into backups/, lists it and records an audit entry', () => {
  const rt = makeRuntime(NO_LLM);
  const fresh = storageInfo(rt);
  assert.equal(fresh.origin, 'fresh');
  assert.equal(fresh.backups.length, 0);
  assert.equal(fresh.encrypted, false);
  assert.ok(fresh.dbFile.endsWith('edict.db') && fresh.dbBytes > 0);
  assert.equal(fresh.dataDir, rt.opts.dataDir);

  // pending (not yet flushed) changes must be in the copy
  rt.updateSettings({ nodeTimeoutMin: 42 });
  const t = fakeTask(rt, 'T-backup', { state: 'Done' });
  rt.touch(t);
  const when = new Date(2026, 9, 12, 9, 5, 7);
  const b = backupNow(rt, when);
  assert.equal(b.name, 'edict-20261012-090507.db');
  const file = path.join(rt.opts.dataDir, 'backups', b.name);
  assert.ok(fs.existsSync(file));
  assert.equal(b.bytes, fs.statSync(file).size);
  assert.ok(!fs.readdirSync(path.join(rt.opts.dataDir, 'backups')).some((f) => f.endsWith('.tmp')), 'no temp file left');
  // a second backup in the same second gets its own name
  const b2 = backupNow(rt, when);
  assert.equal(b2.name, 'edict-20261012-090507-2.db');
  const info = storageInfo(rt);
  assert.deepEqual(info.backups.map((x) => x.name).sort(), [b.name, b2.name].sort());
  assert.equal(info.counts.tasks, 1);
  assert.deepEqual(listBackups(rt.opts.dataDir).length, 2);
  assert.ok(rt.audit.list({ limit: 20 }).some((e) => e.action === 'storage_backup' && e.detail.name === b.name));

  // the copy restores: a runtime opened on it sees the settings and the task
  const restoreDir = tmpDir('edict-restore-');
  fs.copyFileSync(file, path.join(restoreDir, 'edict.db'));
  const rt2 = new Runtime({ dataDir: restoreDir, fetchImpl: (u, i) => fetch(u, i), secrets: new MemorySecrets(), version: 'test', platform: process.platform, resourcesDir: process.cwd() });
  assert.equal(rt2.settings.nodeTimeoutMin, 42);
  assert.ok(rt2.tasks.has('T-backup'));
  rt2.dispose();

  // names are validated: no traversal, only our own files
  assert.equal(backupPath(rt, b.name), file);
  for (const bad of ['../edict.db', 'edict.db', '..%2Fedict.db', 'edict-20261012-090507.db/../../x', 'edict-20991231-000000.db']) assert.throws(() => backupPath(rt, bad));
  rt.dispose();
});

test('desktop notifications follow settings.notify: all · attention (only what needs the emperor) · off', async () => {
  const sent: string[] = [];
  const rt = new Runtime({ dataDir: tmpDir('edict-data-'), fetchImpl: (u, i) => fetch(u, i), secrets: new MemorySecrets(), version: 'test', platform: process.platform, resourcesDir: process.cwd(), notify: (title) => sent.push(title) });
  installOrchestrator(rt);
  assert.equal(rt.settings.notify, 'all', 'default');
  const fire = () => {
    sent.length = 0;
    const t = fakeTask(rt, `T-${Math.random().toString(36).slice(2, 8)}`);
    void rt.requestDecision({ kind: 'action', taskId: t.id, agentId: 'bingbu', tool: 'run_command', summary: '$ node x.js', detail: '', risk: 'normal', reason: '执行命令' });
    rt.setGate(t, { kind: 'final', message: '回奏待御批' });
    block(rt, t, '测试阻塞');
    rt.notifyDesktop('info', '旨意完成', t.title);
    return [...sent];
  };
  assert.deepEqual(fire(), ['操作待批准', '奏折待批', '旨意阻塞', '旨意完成']);
  rt.updateSettings({ notify: 'attention' });
  assert.deepEqual(fire(), ['操作待批准', '奏折待批', '旨意阻塞']);
  rt.updateSettings({ notify: 'off' });
  assert.deepEqual(fire(), []);
  // a finished edict notifies only under 'all'
  for (const [pref, want] of [['all', 1], ['attention', 0]] as const) {
    rt.updateSettings({ notify: pref });
    sent.length = 0;
    const t = fakeTask(rt, `T-done-${pref}`, { state: 'Done' });
    rt.onTerminal(t);
    assert.equal(sent.filter((x) => x === '旨意完成').length, want, pref);
  }
  rt.dispose();
});

test('always-allow rules remember their source; an edict-scoped rule can be revoked (audited)', async () => {
  const rt = makeRuntime(NO_LLM);
  rt.updateSettings({ permissionMode: 'ask' });
  rt.setWorkspace(tmpDir('edict-ws-'));
  const t = fakeTask(rt, 'T-rules', { title: '实现登录页' });
  const node = { id: 'n1', kind: 'exec', agentId: 'xingbu', label: '刑部 · 测试', status: 'running', attempts: 1, effect: 'write', grant: 'write' } as RunNode;
  const run = (command: string) => executeTool({ rt, agentId: 'xingbu', task: t, node }, 'run_command', { command });
  const pending = () => waitFor(() => [...rt.approvals.values()].find((a) => a.status === 'pending'), 3000, 'approval card');

  let p = run('node -e "1"');
  let ap = await pending();
  rt.decideApproval(ap.id, true, 'emperor', 'task');
  await p;
  assert.deepEqual(t.allowRules?.map((r) => [r.key, r.source]), [['cmd:node -e', { taskId: 'T-rules', title: '实现登录页', agentId: 'xingbu' }]]);

  p = run('npm run typecheck -- --pretty');
  ap = await pending();
  rt.decideApproval(ap.id, true, 'emperor', 'workspace');
  await p;
  const root = rt.permRoot(t)!;
  const wsRule = rt.settings.workspacePerms[root].rules.find((r) => r.key === 'cmd:npm run typecheck');
  assert.deepEqual(wsRule?.source, { taskId: 'T-rules', title: '实现登录页', agentId: 'xingbu' });

  rt.removeTaskAllowRule('T-rules', 'cmd:node -e');
  assert.deepEqual(t.allowRules, []);
  assert.ok(rt.audit.list({ limit: 20 }).some((e) => e.action === 'allow_rule_removed' && e.detail.scope === 'task' && e.taskId === 'T-rules'));
  // asks again after the revoke
  p = run('node -e "2"');
  ap = await pending();
  rt.decideApproval(ap.id, false, 'emperor', 'deny');
  await p;
  rt.removeAllowRule(root, 'cmd:npm run typecheck');
  assert.equal(rt.settings.workspacePerms[root].rules.length, 0);
  assert.throws(() => rt.removeTaskAllowRule('nope', 'x'));
  rt.dispose();
});
