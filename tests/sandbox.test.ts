// Edict 2.1 · 命令沙箱: the profile, telling a sandbox refusal from an ordinary failure, and the card when the
// sandbox stops an official's command. Linux has no sandbox-exec, so a stand-in backend runs the command and
// marks it sandboxed; on macOS the last test runs the real sandbox-exec.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { startMockLlm } from './mockLlm';
import { makeRuntime, tmpDir, waitFor } from './helpers';
import { executeTool } from '../src/main/runtime/tools';
import { addSandboxWritable, removeSandboxWritable, runOfficialCommand, sandboxPolicy, sandboxSettingsOf, saveSandboxSettings } from '../src/main/runtime/sandboxRun';
import { buildProfile, detectDenial, expandHome, gitCommonDir, realish, setSandboxBackendForTests, type SandboxBackend, type SandboxPolicy } from '../src/main/services/sandbox';
import { runCommand } from '../src/main/services/exec';
import { classifyCommand } from '../src/main/runtime/permissions';
import { DEFAULT_SANDBOX_CACHES, DEFAULT_SANDBOX_DENY_READ } from '../src/shared/sandboxDefaults';
import type { RunNode, Task } from '../src/shared/types';

const HOME = os.homedir();

test('profile: deny writes outside the allowed folders, deny reading secret folders (except the workspace), network optional', () => {
  const ws = tmpDir('edict-ws-');
  const p: SandboxPolicy = { writable: [ws, '/opt/my "odd" dir\\x'], denyRead: ['/secret/keys'], allowRead: [ws], network: true };
  const prof = buildProfile(p);
  const lines = prof.split('\n');
  assert.deepEqual(lines.slice(0, 2), ['(version 1)', '(allow default)']);
  assert.match(prof, new RegExp(`\\(deny file-write\\* \\(require-not \\(require-any \\(subpath "${realish(ws).replace(/[/.]/g, '\\$&')}"\\)`));
  assert.ok(prof.includes('(subpath "/opt/my \\"odd\\" dir\\\\x")'), 'quotes and backslashes escaped');
  assert.ok(prof.includes('(literal "/dev/null")'));
  assert.ok(prof.includes(`(deny file-read-data (require-all (require-any (subpath "/secret/keys")) (require-not (require-any (subpath "${realish(ws)}")))))`));
  assert.ok(!prof.includes('network-outbound'), 'network on: no network rule');
  const off = buildProfile({ ...p, network: false, denyRead: [] });
  assert.ok(off.includes('(deny network-outbound (require-not (remote ip "localhost:*")))'));
  assert.ok(!off.includes('file-read-data'));
  // only denials on top of allow default: order never matters
  for (const l of lines.slice(2)) assert.match(l, /^\(deny /);
});

test('paths: ~ expanded, symlinks resolved, a missing tail kept', () => {
  assert.equal(expandHome('~/.ssh', '/Users/a'), '/Users/a/.ssh');
  assert.equal(expandHome('~', '/Users/a'), '/Users/a');
  assert.equal(expandHome('/abs/~x', '/Users/a'), '/abs/~x');
  const d = tmpDir('edict-real-');
  fs.mkdirSync(path.join(d, 'real'));
  fs.symlinkSync(path.join(d, 'real'), path.join(d, 'link'));
  assert.equal(realish(path.join(d, 'link', 'not', 'yet')), path.join(fs.realpathSync(d), 'real', 'not', 'yet'));
});

test('gitCommonDir: a worktree may write its repository’s .git; a normal checkout needs nothing extra', () => {
  const repo = tmpDir('edict-repo-');
  fs.mkdirSync(path.join(repo, '.git', 'worktrees', 'wt1'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.git', 'worktrees', 'wt1', 'commondir'), '../..\n');
  const wt = tmpDir('edict-wt-');
  fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${path.join(repo, '.git', 'worktrees', 'wt1')}\n`);
  assert.equal(gitCommonDir(wt), path.join(repo, '.git'));
  assert.equal(gitCommonDir(repo), null);
  assert.equal(gitCommonDir(tmpDir('edict-plain-')), null);
  if (spawnSync('git', ['--version']).status === 0) {
    const r2 = tmpDir('edict-repo2-');
    const git = (...a: string[]) => spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: r2 });
    git('init', '-q');
    fs.writeFileSync(path.join(r2, 'a.txt'), 'a');
    git('add', '.');
    git('commit', '-qm', 'a');
    const wt2 = path.join(tmpDir('edict-wt2-'), 'w');
    assert.equal(git('worktree', 'add', '-q', wt2).status, 0);
    assert.equal(realish(gitCommonDir(wt2)!), realish(path.join(r2, '.git')), 'real git worktree');
  }
});

test('detectDenial: a refused path outside the allowed folders is the sandbox; inside them it is a real permission problem', () => {
  const ws = realish(tmpDir('edict-ws-'));
  const p: SandboxPolicy = { writable: [ws, '/tmp'], denyRead: [`${HOME}/.ssh`, '/data/edict'], allowRead: ['/data/edict/worktrees/w1'], network: true };
  assert.deepEqual(detectDenial('touch: /Users/x/Library/Foo/bar: Operation not permitted', p), { kind: 'write', path: '/Users/x/Library/Foo/bar' });
  assert.deepEqual(detectDenial("npm ERR! Error: EPERM: operation not permitted, open '/opt/global/lib/x'", p), { kind: 'write', path: '/opt/global/lib/x' });
  assert.deepEqual(detectDenial('cat: ~/.ssh/id_ed25519: Operation not permitted', p), { kind: 'read', path: realish(`${HOME}/.ssh/id_ed25519`) });
  assert.equal(detectDenial('cat: /data/edict/worktrees/w1/a.txt: Permission denied', p)?.kind, 'write', 'allowRead is readable; a refusal there is about writing');
  assert.equal(detectDenial(`rm: ${ws}/locked: Permission denied`, p), null, 'inside the workspace: not the sandbox');
  assert.equal(detectDenial('mkdir: /tmp/x: Permission denied', p), null);
  assert.deepEqual(detectDenial('Error: operation not permitted', p), { kind: 'unknown' });
  assert.equal(detectDenial('FAIL src/a.test.ts\nexpected 1 to be 2', p), null, 'an ordinary failure');
  assert.equal(detectDenial('curl: (6) Could not resolve host: example.com', p), null, 'network on: a DNS error is just a DNS error');
  assert.deepEqual(detectDenial('curl: (6) Could not resolve host: example.com', { ...p, network: false }), { kind: 'network' });
  assert.deepEqual(detectDenial('ls: /usr/bin/thing: Permission denied', p), { kind: 'unknown' }, 'system paths are not ours to allow');
});

test('policy for an edict: workspace, temp, caches, the workspace’s extra folders; Edict’s own data unreadable', async () => {
  const mock = await startMockLlm();
  const rt = makeRuntime(mock.url);
  const ws = tmpDir('edict-ws-');
  rt.setWorkspace(ws);
  const s = sandboxSettingsOf(rt);
  assert.equal(s.enabled, true);
  assert.equal(s.network, true, 'network on by default');
  assert.deepEqual(s.caches, DEFAULT_SANDBOX_CACHES);
  assert.deepEqual(s.denyRead, DEFAULT_SANDBOX_DENY_READ);
  assert.ok(!s.denyRead.includes('~/.npmrc'), 'npm keeps working');
  addSandboxWritable(rt, ws, '~/edict-extra-out');
  const p = sandboxPolicy(rt, ws);
  assert.equal(p.writable[0], ws);
  assert.ok(p.writable.includes(os.tmpdir()));
  assert.ok(p.writable.includes(path.join(HOME, '.npm')));
  assert.ok(p.writable.includes(realish(path.join(HOME, 'edict-extra-out'))));
  assert.ok(p.denyRead.includes(path.join(HOME, '.ssh')));
  assert.ok(p.denyRead.includes(rt.opts.dataDir));
  assert.deepEqual(p.allowRead, [ws]);
  removeSandboxWritable(rt, ws, realish(path.join(HOME, 'edict-extra-out')));
  assert.ok(!sandboxPolicy(rt, ws).writable.includes(realish(path.join(HOME, 'edict-extra-out'))));
  const st = saveSandboxSettings(rt, { network: false, writable: [' ~/shared ', '~/shared', ''] });
  assert.equal(st.settings.network, false);
  assert.deepEqual(st.settings.writable, ['~/shared']);
  assert.equal(st.settings.enabled, true, 'untouched fields keep their value');
  rt.dispose();
  await mock.close();
});

/** Stand-in for sandbox-exec: runs the command, tells it whether `dir` is writable under the profile. */
function fakeBackend(dir: string, available = true) {
  const profiles: string[] = [];
  const b: SandboxBackend = {
    available: () => available,
    wrap(profile, shell, cmd) {
      profiles.push(profile);
      return { file: shell, args: ['-c', `EDICT_DIR_OK=${profile.includes(`(subpath "${realish(dir)}")`) ? 1 : 0}; ${cmd}`] };
    },
  };
  return { b, profiles };
}

/** Writes `dir`/out.txt unless sandboxed without permission for it (then fails like sandbox-exec does). */
const writeOutside = (dir: string) => `if [ "$EDICT_SANDBOX" = 1 ] && [ "$EDICT_DIR_OK" != 1 ]; then echo "touch: ${dir}/out.txt: Operation not permitted" >&2; exit 1; fi; echo "wrote sandboxed=\${EDICT_SANDBOX:-0}"`;

test('run_command: commands run in the sandbox; when it stops one the emperor picks rerun / allow this folder / leave it', async () => {
  const mock = await startMockLlm();
  const rt = makeRuntime(mock.url);
  rt.updateSettings({ permissionMode: 'auto' });
  const ws = tmpDir('edict-ws-');
  rt.setWorkspace(ws);
  const outside = path.join(HOME, `edict-sbx-test-${process.pid}-${Date.now()}`, 'sub');
  const { b, profiles } = fakeBackend(outside);
  setSandboxBackendForTests(b);
  try {
    const t = { id: 'T-sbx', title: '沙箱', edict: 'x', tier: 'lite', state: 'Doing', nodes: [], changes: [], reviews: [], planHistory: [], flow: [], usage: {}, createdAt: Date.now(), updatedAt: Date.now(), lastActivityAt: Date.now(), workspace: ws } as unknown as Task;
    rt.tasks.set(t.id, t);
    const node = { id: 'n1', kind: 'exec', agentId: 'gongbu', label: '工部 · 构建', status: 'running', attempts: 1 } as RunNode;
    const run = (command: string) => executeTool({ rt, agentId: 'gongbu', task: t, node }, 'run_command', { command });
    const card = () => waitFor(() => [...rt.approvals.values()].find((a) => a.status === 'pending' && a.kind === 'sandbox'), 5000, 'sandbox card');

    // allowed: runs once, inside the sandbox, no card
    let r = await run('echo "in=$EDICT_SANDBOX" > made.txt && cat made.txt');
    assert.equal(r.ok, true, r.output);
    assert.match(r.output, /in=1/);
    assert.equal(fs.readFileSync(path.join(ws, 'made.txt'), 'utf8').trim(), 'in=1');
    assert.ok(profiles.at(-1)!.includes(`(subpath "${realish(ws)}")`));
    assert.ok(profiles.at(-1)!.includes(`(subpath "${realish(rt.opts.dataDir)}")`), "Edict's data folder is in the no-read list");

    // an ordinary failure is not the sandbox's business
    r = await run('echo "FAIL expected 1 got 2" >&2; exit 1');
    assert.equal(r.ok, false);
    assert.ok(![...rt.approvals.values()].some((a) => a.kind === 'sandbox'));

    // 1. leave it failed
    let p = run(writeOutside(outside));
    let ap = await card();
    assert.deepEqual(ap.choices!.map((c) => c.id), ['rerun', 'allow_dir', 'keep']);
    assert.match(ap.summary, new RegExp(`被沙箱拦下：写入 ${realish(outside)}/out\\.txt`));
    rt.decideApproval(ap.id, false, 'emperor', 'keep', '别往外写');
    r = await p;
    assert.equal(r.ok, false);
    assert.match(r.output, /命令被沙箱拦下[\s\S]*批示：别往外写/);

    // 2. rerun once outside the sandbox
    p = run(writeOutside(outside));
    ap = await card();
    rt.decideApproval(ap.id, true, 'emperor', 'rerun');
    r = await p;
    assert.equal(r.ok, true, r.output);
    assert.match(r.output, /wrote sandboxed=0/);
    assert.match(r.output, /不受沙箱限制，已重跑/);
    assert.ok(rt.audit.list({ taskId: t.id }).some((e) => e.action === 'sandbox_bypass'));

    // 3. let this workspace write that folder: saved, rerun inside the sandbox, no card next time
    p = run(writeOutside(outside));
    ap = await card();
    assert.match(ap.choices!.find((c) => c.id === 'allow_dir')!.label, new RegExp(`允许本工作区写 ${realish(outside)}`));
    rt.decideApproval(ap.id, true, 'emperor', 'allow_dir');
    r = await p;
    assert.equal(r.ok, true, r.output);
    assert.match(r.output, /wrote sandboxed=1/);
    assert.deepEqual(rt.settings.workspacePerms[ws].sandboxWritable, [realish(outside)]);
    const cards = [...rt.approvals.values()].filter((a) => a.kind === 'sandbox').length;
    r = await run(writeOutside(outside));
    assert.equal(r.ok, true);
    assert.equal([...rt.approvals.values()].filter((a) => a.kind === 'sandbox').length, cards);
    const actions = rt.audit.list({ taskId: t.id }).map((e) => e.action);
    assert.ok(actions.includes('sandbox_denied') && actions.includes('sandbox_writable_added'));

    // network switched off: a DNS failure is the sandbox's
    saveSandboxSettings(rt, { network: false });
    p = run('if [ "$EDICT_SANDBOX" = 1 ]; then echo "npm ERR! getaddrinfo ENOTFOUND registry.npmjs.org" >&2; exit 1; fi; echo fetched');
    ap = await card();
    assert.match(ap.summary, /联网（沙箱已关闭网络）/);
    assert.ok(!ap.choices!.some((c) => c.id === 'allow_dir'), 'no folder to allow for the network');
    rt.decideApproval(ap.id, true, 'emperor', 'rerun');
    assert.match((await p).output, /fetched/);
    saveSandboxSettings(rt, { network: true });

    // release / deploy commands (asked every time anyway) run outside the sandbox
    assert.equal(classifyCommand('git push origin main').release, true);
    const rel = await runOfficialCommand({ rt, agentId: 'gongbu', task: t, node }, 'echo "sbx=${EDICT_SANDBOX:-0}"; git push 2>/dev/null; true', ws, 20_000);
    assert.match(rel.stdout, /sbx=0/);

    // sandbox switched off
    saveSandboxSettings(rt, { enabled: false });
    r = await run('echo "sbx=${EDICT_SANDBOX:-0}"');
    assert.match(r.output, /sbx=0/);
  } finally {
    setSandboxBackendForTests(null);
    rt.dispose();
    await mock.close();
  }
});

test('no sandbox-exec: commands still run (approvals only), with one notice', async () => {
  const mock = await startMockLlm();
  const rt = makeRuntime(mock.url);
  const ws = tmpDir('edict-ws-');
  rt.setWorkspace(ws);
  setSandboxBackendForTests(fakeBackend('/nowhere', false).b);
  const logs: string[] = [];
  rt.on((e) => {
    if (e.type === 'activity') logs.push(e.activity.content);
  });
  try {
    for (let i = 0; i < 2; i++) {
      const r = await executeTool({ rt, agentId: 'gongbu' }, 'run_command', { command: 'echo "sbx=${EDICT_SANDBOX:-0}"' });
      assert.match(r.output, /sbx=0/);
    }
    assert.equal(logs.filter((l) => l.includes('命令沙箱')).length, 1);
  } finally {
    setSandboxBackendForTests(null);
    rt.dispose();
    await mock.close();
  }
});

// The real thing: only where /usr/bin/sandbox-exec exists (Rowan's Mac).
test('macOS sandbox-exec: writes outside, secret reads and (when off) the network are refused; the workspace works', { skip: process.platform !== 'darwin' || !fs.existsSync('/usr/bin/sandbox-exec') }, async () => {
  const ws = realish(tmpDir('edict-ws-'));
  const outsideRoot = realish(fs.mkdtempSync(path.join(HOME, '.edict-sbx-check-')));
  const secret = path.join(outsideRoot, 'secret');
  fs.mkdirSync(secret);
  fs.writeFileSync(path.join(secret, 'key'), 'TOPSECRET');
  const blocked = path.join(outsideRoot, 'blocked');
  try {
    const policy: SandboxPolicy = { writable: [ws, os.tmpdir(), '/private/tmp', '/private/var/folders'], denyRead: [secret], allowRead: [ws], network: true };
    const run = (cmd: string, p = policy) => runCommand(cmd, ws, { timeoutMs: 30_000, sandboxProfile: buildProfile(p) });
    let r = await run('echo hi > a.txt && cat a.txt && mkdir -p sub/dir && echo x > sub/dir/y && echo tmp > "${TMPDIR:-/tmp}/edict-sbx-$$" && rm "${TMPDIR:-/tmp}/edict-sbx-$$" && ls /usr/bin >/dev/null && git --version');
    assert.equal(r.exitCode, 0, r.stderr);
    assert.match(r.stdout, /^hi/);
    r = await run(`mkdir -p ${JSON.stringify(blocked)} && echo x > ${JSON.stringify(path.join(blocked, 'f'))}`);
    assert.notEqual(r.exitCode, 0);
    assert.ok(!fs.existsSync(path.join(blocked, 'f')), 'nothing written outside');
    assert.deepEqual(detectDenial(`${r.stdout}\n${r.stderr}`, policy)?.kind, 'write', r.stderr);
    r = await run(`cat ${JSON.stringify(path.join(secret, 'key'))}`);
    assert.notEqual(r.exitCode, 0);
    assert.ok(!r.stdout.includes('TOPSECRET'));
    assert.equal(detectDenial(`${r.stdout}\n${r.stderr}`, policy)?.kind, 'read', r.stderr);
    // on macOS listing a folder needs read-data on it too, so a secret folder cannot even be listed
    r = await run(`ls ${JSON.stringify(secret)}`);
    assert.notEqual(r.exitCode, 0);
    assert.ok(!r.stdout.includes('key'));
    assert.equal(detectDenial(`${r.stdout}\n${r.stderr}`, policy)?.kind, 'read', r.stderr);
    r = await run(`ls ${JSON.stringify(outsideRoot)} && cat ${JSON.stringify(path.join(ws, 'a.txt'))}`);
    assert.equal(r.exitCode, 0, r.stderr);
    assert.match(r.stdout, /secret/);
    // network off: outbound refused, loopback still fine
    const srv = (await import('node:http')).createServer((_q, s) => s.end('local-ok'));
    await new Promise<void>((res) => srv.listen(0, '127.0.0.1', () => res()));
    const port = (srv.address() as { port: number }).port;
    try {
      r = await run(`curl -sS --max-time 5 http://127.0.0.1:${port}/`, { ...policy, network: false });
      assert.equal(r.stdout, 'local-ok', r.stderr);
      r = await run('curl -sS --max-time 5 -o /dev/null https://example.com/', { ...policy, network: false });
      assert.notEqual(r.exitCode, 0, 'outbound blocked');
    } finally {
      srv.close();
    }
  } finally {
    fs.rmSync(outsideRoot, { recursive: true, force: true });
  }
});

test('macOS sandbox-exec: an edict worktree can edit, run node and commit; the main checkout and the home folder stay untouched', { skip: process.platform !== 'darwin' || !fs.existsSync('/usr/bin/sandbox-exec') }, async () => {
  // outside the temp folders (those are writable), like a real repository in the home folder
  const root = realish(fs.mkdtempSync(path.join(HOME, '.edict-sbx-check-')));
  const repo = path.join(root, 'repo');
  const wt = path.join(root, 'wt');
  const git = (cwd: string, ...args: string[]) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' });
  try {
    fs.mkdirSync(repo);
    git(repo, 'init', '-q');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'init');
    assert.equal(git(repo, 'worktree', 'add', '-q', '-b', 'edict/T1', wt).status, 0);
    const policy: SandboxPolicy = { writable: [wt, gitCommonDir(wt)!, os.tmpdir(), '/private/tmp', '/private/var/folders'], denyRead: DEFAULT_SANDBOX_DENY_READ.map((p) => expandHome(p)), allowRead: [wt], network: true };
    const run = (cmd: string) => runCommand(cmd, wt, { timeoutMs: 60_000, sandboxProfile: buildProfile(policy) });
    let r = await run(`echo b > b.txt && node -e "require('fs').writeFileSync('n.txt','1')" && git add -A && git -c user.name=t -c user.email=t@t commit -qm b && git log --oneline | wc -l`);
    assert.equal(r.exitCode, 0, r.stderr);
    assert.equal(r.stdout.trim(), '2');
    assert.equal(git(repo, 'log', '--oneline', 'edict/T1').stdout.trim().split('\n').length, 2, 'the commit is in the repository');
    r = await run(`echo x > ${JSON.stringify(path.join(repo, 'outside.txt'))}`);
    assert.notEqual(r.exitCode, 0);
    assert.equal(detectDenial(`${r.stdout}\n${r.stderr}`, policy)?.kind, 'write', r.stderr);
    r = await run(`echo x > ${JSON.stringify(path.join(root, 'stray.txt'))}`);
    assert.notEqual(r.exitCode, 0);
    assert.ok(!fs.existsSync(path.join(repo, 'outside.txt')) && !fs.existsSync(path.join(root, 'stray.txt')), 'nothing written outside the worktree');
    assert.equal(git(repo, 'status', '--porcelain').stdout.trim(), '', 'main checkout untouched');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
