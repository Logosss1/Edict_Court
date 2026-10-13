// Edict 2.1 · 定时旨意: the emperor schedules edicts (each day, some weekdays, every N hours, each morning court,
// once) with a permission cap set when scheduling; officials may propose one, which waits for the emperor's word.
// Time math is pure; the rest runs against the MOCK LLM server with real git in temp folders (mock/integration).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { startMockLlm } from './mockLlm';
import { makeRuntime, tmpDir, waitFor, stateOf } from './helpers';
import { executeTool } from '../src/main/runtime/tools';
import { MISSED_AFTER_MS, modeForCap, scheduleNote, type ScheduleDraft } from '../src/main/runtime/scheduler';
import { describeRule, describeStop, nextFire, permissionsFor, ruleProblem, upcoming } from '../src/shared/schedule';
import type { EdictSchedule, Task } from '../src/shared/types';

type Rt = ReturnType<typeof makeRuntime>;

const local = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();
const H = 3_600_000;

const gitc = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
function makeRepo() {
  const dir = tmpDir('edict-sch-repo-');
  gitc(dir, 'init', '-q', '-b', 'main');
  gitc(dir, 'config', 'user.name', 'Test');
  gitc(dir, 'config', 'user.email', 'test@example.com');
  gitc(dir, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(dir, 'README.md'), '# demo\n');
  gitc(dir, 'add', '-A');
  gitc(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

const draft = (workspace: string | null, o: Partial<ScheduleDraft> = {}): ScheduleDraft => ({
  title: '每日巡检', text: '写一个 greet 函数并测试', workspace, tier: 'lite', rule: { kind: 'daily', time: '09:00' }, permission: 'readonly', stop: { kind: 'never' }, missed: 'once', enabled: true, ...o,
});

/** Make a schedule due `ago` ms before now, then run one check. */
async function fireDue(rt: Rt, s: EdictSchedule, ago = 1000): Promise<EdictSchedule> {
  rt.schedules.get(s.id)!.nextAt = Date.now() - ago;
  await rt.schedules.tick(Date.now());
  return rt.schedules.get(s.id)!;
}

const pending = (rt: Rt, kind?: string, taskId?: string) => [...rt.approvals.values()].find((a) => a.status === 'pending' && (!kind || a.kind === kind) && (!taskId || a.taskId === taskId));
const lastTask = (rt: Rt, s: EdictSchedule) => rt.tasks.get(rt.schedules.get(s.id)!.lastTaskId!)!;
const cancelAll = (rt: Rt) => {
  for (const t of rt.tasks.values()) rt.cancel(t.id, 'test over');
  for (const a of rt.approvals.values()) if (a.status === 'pending') rt.decideApproval(a.id, false, 'system');
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Cancel everything, let late cards (a worktree made while git was busy) come and go, then shut down. */
async function finish(rt: Rt, mock: { close: () => Promise<void> }) {
  cancelAll(rt);
  await sleep(150);
  cancelAll(rt);
  await sleep(100);
  rt.dispose();
  await mock.close();
}

// ───────────────────────── time rules ─────────────────────────

test('nextFire: daily, weekly, morning court, every N hours and once, in local time', () => {
  const d = { kind: 'daily' as const, time: '09:00' };
  assert.equal(nextFire(d, local(2026, 10, 13, 8, 0)), local(2026, 10, 13, 9, 0));
  assert.equal(nextFire(d, local(2026, 10, 13, 9, 0)), local(2026, 10, 14, 9, 0), 'strictly after');
  assert.equal(nextFire(d, local(2026, 12, 31, 23, 0)), local(2027, 1, 1, 9, 0), 'across the year');
  // 2026-10-13 is a Tuesday: Mon/Wed 09:00 → Wednesday, then next Monday
  const w = { kind: 'weekly' as const, days: [1, 3], time: '09:00' };
  assert.equal(new Date(local(2026, 10, 13)).getDay(), 2);
  assert.equal(nextFire(w, local(2026, 10, 13, 12, 0)), local(2026, 10, 14, 9, 0));
  assert.equal(nextFire(w, local(2026, 10, 14, 9, 0)), local(2026, 10, 19, 9, 0));
  assert.equal(nextFire({ kind: 'weekly', days: [], time: '09:00' }, local(2026, 10, 13)), null);
  assert.equal(nextFire({ kind: 'court' }, local(2026, 10, 13, 7, 0)), local(2026, 10, 14, 6, 0), 'morning court opens at 6:00');
  assert.equal(nextFire({ kind: 'court' }, local(2026, 10, 13, 5, 59)), local(2026, 10, 13, 6, 0));
  // every 6 hours from when it was made; a long gap moves on in whole steps (never stacks up)
  const iv = { kind: 'interval' as const, hours: 6 };
  const base = local(2026, 10, 13, 8, 0);
  assert.equal(nextFire(iv, base, base), base + 6 * H);
  assert.equal(nextFire(iv, base + 20 * H, base), base + 24 * H);
  assert.equal(nextFire(iv, base + 24 * H, base), base + 30 * H, 'strictly after');
  assert.deepEqual(upcoming(iv, base, 3, base), [base + 6 * H, base + 12 * H, base + 18 * H]);
  assert.deepEqual(upcoming(d, local(2026, 10, 13, 10, 0), 2), [local(2026, 10, 14, 9, 0), local(2026, 10, 15, 9, 0)]);
  // once
  const once = { kind: 'once' as const, at: local(2026, 10, 20, 15, 30) };
  assert.equal(nextFire(once, local(2026, 10, 13)), once.at);
  assert.equal(nextFire(once, once.at), null);
});

test('rules read as people say them, and bad ones are named', () => {
  assert.equal(describeRule({ kind: 'daily', time: '09:00' }), '每天 09:00');
  assert.equal(describeRule({ kind: 'weekly', days: [0, 3, 1], time: '18:30' }), '每周一、三、日 18:30', 'Monday first, Sunday last');
  assert.equal(describeRule({ kind: 'interval', hours: 4 }), '每隔 4 小时');
  assert.equal(describeRule({ kind: 'court' }), '每次早朝（每天 06:00）');
  assert.equal(describeRule({ kind: 'once', at: local(2026, 10, 20, 15, 30) }), '2026-10-20 15:30 一次');
  assert.equal(describeStop({ kind: 'count', n: 3 }), '执行 3 次后停');
  assert.equal(describeStop({ kind: 'never' }), '一直执行');
  const nowMs = local(2026, 10, 13, 12);
  assert.equal(ruleProblem({ kind: 'daily', time: '9点' }, nowMs), '时间要写成 时:分，例如 09:00');
  assert.equal(ruleProblem({ kind: 'daily', time: '24:00' }, nowMs), '时间要写成 时:分，例如 09:00');
  assert.equal(ruleProblem({ kind: 'weekly', days: [], time: '09:00' }, nowMs), '至少选一天');
  assert.equal(ruleProblem({ kind: 'interval', hours: 0.5 }, nowMs), '间隔要在 1 到 720 小时之间');
  assert.equal(ruleProblem({ kind: 'once', at: nowMs - 1 }, nowMs), '执行时间要在将来');
  assert.equal(ruleProblem({ kind: 'court' }, nowMs), null);
  assert.deepEqual(permissionsFor('solo'), ['readonly', 'ask']);
  assert.deepEqual(permissionsFor('full'), ['readonly', 'ask', 'worktree']);
  assert.deepEqual([modeForCap('readonly'), modeForCap('ask'), modeForCap('worktree')], ['readonly', 'ask', 'auto']);
});

// ───────────────────────── the emperor's schedules ─────────────────────────

test('saving checks the edict, the time and the folder; schedules survive a restart', async () => {
  const mock = await startMockLlm();
  const dataDir = tmpDir('edict-sch-data-');
  const rt = makeRuntime(mock.url, 'openai-chat', dataDir);
  const ws = tmpDir('edict-sch-ws-');
  assert.throws(() => rt.schedules.upsert(draft(ws, { text: '  ' })), /旨意内容为空/);
  assert.throws(() => rt.schedules.upsert(draft(ws, { rule: { kind: 'daily', time: '25:00' } })), /时:分/);
  assert.throws(() => rt.schedules.upsert(draft(path.join(ws, 'nope'))), /工作区不存在/);
  assert.throws(() => rt.schedules.upsert(draft(ws, { id: 'sch-missing' })), /不存在/);
  const events: number[] = [];
  rt.on((e) => e.type === 'schedules' && events.push(e.schedules.length));
  const s = rt.schedules.upsert(draft(ws, { title: '', tier: 'solo', permission: 'worktree', stop: { kind: 'count', n: 3 } }));
  assert.equal(s.title, '写一个 greet 函数并测试', 'title from the edict when left empty');
  assert.equal(s.permission, 'ask', 'a Solo edict has no worktree: the worktree cap becomes asking');
  assert.equal(s.enabled, true);
  assert.ok(s.nextAt! > Date.now() && s.nextAt! <= Date.now() + 24 * H + 60_000);
  assert.deepEqual(s.origin, { by: 'emperor' });
  assert.deepEqual(events, [1]);
  assert.deepEqual(rt.snapshot().schedules.map((x) => x.id), [s.id]);
  assert.ok(rt.audit.list({ limit: 50 }).some((e) => e.action === 'schedule_created'));
  // editing keeps id and history; turning off clears the next time
  const s2 = rt.schedules.upsert({ ...draft(ws, { title: '改名', rule: { kind: 'interval', hours: 2 } }), id: s.id });
  assert.equal(s2.id, s.id);
  assert.equal(s2.title, '改名');
  assert.ok(Math.abs(s2.nextAt! - (Date.now() + 2 * H)) < 60_000);
  assert.equal(rt.schedules.setEnabled(s.id, false).nextAt, null);
  assert.ok(rt.schedules.setEnabled(s.id, true).nextAt);
  // restart: same data folder
  rt.dispose();
  const rt2 = makeRuntime(mock.url, 'openai-chat', dataDir);
  const back = rt2.schedules.get(s.id)!;
  assert.equal(back.title, '改名');
  assert.deepEqual(back.rule, { kind: 'interval', hours: 2 });
  rt2.schedules.remove(s.id);
  assert.equal(rt2.schedules.all().length, 0);
  rt2.dispose();
  await mock.close();
});

test('a due schedule issues its edict straight away (no triage, no prince question), in the folder it was set for', async () => {
  const mock = await startMockLlm();
  const rt = makeRuntime(mock.url);
  const open = tmpDir('edict-sch-open-');
  const ws = tmpDir('edict-sch-ws-');
  rt.setWorkspace(open);
  const s = rt.schedules.upsert(draft(ws, { permission: 'ask' }));
  const before = s.nextAt!;
  const after = await fireDue(rt, s);
  assert.equal(after.runs, 1);
  assert.equal(after.history[0].outcome, 'started');
  assert.ok(after.nextAt! > Date.now(), 'next time moved on');
  assert.ok(after.nextAt! >= before);
  const t = lastTask(rt, s);
  assert.equal(t.workspace, ws);
  assert.notEqual(t.workspace, rt.workspace!.root);
  assert.equal(rt.workspaceFor(t)!.root, path.resolve(ws), 'works there although another folder is open');
  assert.deepEqual({ id: t.schedule!.id, permission: t.schedule!.permission }, { id: s.id, permission: 'ask' });
  assert.equal(t.permissionMode, 'ask');
  assert.equal(rt.modeFor(t), 'ask', 'the cap wins over the 全自动 setting');
  assert.equal(t.title, '每日巡检');
  assert.equal(t.flow[0].from, '定时旨意');
  assert.equal(t.nodes.find((n) => n.kind === 'triage')!.output, '{"type":"edict","reason":"皇上直接下旨"}');
  assert.ok(!mock.calls.some((c) => c.system.includes('你是太子')), 'no prince triage');
  assert.match(scheduleNote(t), /定时旨意.*每次改文件、执行命令都要等皇上批准/);
  // 每次改动都问我: the write subtask asks before it starts, even though the setting is 全自动
  const card = await waitFor(() => pending(rt, 'write_task', t.id), 20000, 'write task card');
  assert.match(card.summary, /写任务/);
  assert.equal(rt.schedules.keepAwake(), false, 'waiting on the emperor: the Mac may sleep');
  // while it is still going, the next due time is skipped and noted
  const again = await fireDue(rt, s);
  assert.equal(again.runs, 1);
  assert.equal(again.history[0].outcome, 'skipped');
  assert.equal(again.history[0].taskId, t.id);
  assert.match(again.history[0].note!, /还没办完/);
  await assert.rejects(rt.schedules.runNow(s.id), /还没办完/);
  // runNow once it is over: counts as a run, regular times untouched
  rt.cancel(t.id);
  const next = rt.schedules.get(s.id)!.nextAt;
  const r = await rt.schedules.runNow(s.id);
  assert.ok(r.taskId && r.taskId !== t.id);
  assert.equal(rt.schedules.get(s.id)!.runs, 2);
  assert.equal(rt.schedules.get(s.id)!.nextAt, next);
  assert.equal(rt.schedules.get(s.id)!.history[0].note, '手动执行');
  assert.equal(rt.tasks.get(r.taskId!)!.schedule!.id, s.id);
  await finish(rt, mock);
});

test('missed while Edict was closed: made up once, or skipped, as the schedule says', async () => {
  const mock = await startMockLlm();
  const rt = makeRuntime(mock.url);
  const ws = tmpDir('edict-sch-ws-');
  const once = rt.schedules.upsert(draft(ws, { title: '补跑', missed: 'once' }));
  const skip = rt.schedules.upsert(draft(ws, { title: '跳过', missed: 'skip', rule: { kind: 'interval', hours: 1 } }));
  rt.schedules.get(once.id)!.nextAt = Date.now() - 3 * 24 * H; // three days missed
  rt.schedules.get(skip.id)!.nextAt = Date.now() - 5 * H;
  await rt.schedules.tick(Date.now());
  const a = rt.schedules.get(once.id)!;
  assert.equal(a.runs, 1, 'once, not once per missed day');
  assert.equal(a.history[0].catchUp, true);
  assert.match(a.history[0].note!, /补跑错过的/);
  assert.equal(lastTask(rt, a).schedule!.catchUp, true);
  assert.ok(a.nextAt! > Date.now());
  const b = rt.schedules.get(skip.id)!;
  assert.equal(b.runs, 0);
  assert.equal(b.history[0].outcome, 'skipped');
  assert.match(b.history[0].note!, /按设置跳过/);
  assert.ok(b.nextAt! > Date.now() && b.nextAt! <= Date.now() + H, 'next whole hour step');
  // just due (within five minutes) is not "missed"
  const c = rt.schedules.upsert(draft(ws, { title: '刚到点', missed: 'skip' }));
  rt.schedules.get(c.id)!.nextAt = Date.now() - MISSED_AFTER_MS + 30_000;
  await rt.schedules.tick(Date.now());
  assert.equal(rt.schedules.get(c.id)!.history[0].outcome, 'started');
  await finish(rt, mock);
});

test('stop rules and one-off schedules end by themselves; a missing folder is a failed run', async () => {
  const mock = await startMockLlm();
  const rt = makeRuntime(mock.url);
  const ws = tmpDir('edict-sch-ws-');
  const count = rt.schedules.upsert(draft(ws, { stop: { kind: 'count', n: 1 } }));
  const c = await fireDue(rt, count);
  assert.equal(c.runs, 1);
  assert.equal(c.enabled, false);
  assert.equal(c.nextAt, null);
  assert.match(c.ended!, /已执行 1 次/);
  cancelAll(rt);
  // until: the next time falls after the end date
  const until = rt.schedules.upsert(draft(ws, { rule: { kind: 'interval', hours: 1 }, stop: { kind: 'until', at: Date.now() + 10 * 60_000 } }));
  assert.equal(until.enabled, false, 'already past its end');
  assert.match(until.ended!, /截止/);
  // once
  const one = rt.schedules.upsert(draft(ws, { rule: { kind: 'once', at: Date.now() + H } }));
  assert.equal(one.nextAt, one.rule.kind === 'once' ? one.rule.at : -1);
  const o = await fireDue(rt, one);
  assert.equal(o.runs, 1);
  assert.equal(o.enabled, false);
  assert.match(o.ended!, /已执行/);
  cancelAll(rt);
  // turning an ended one back on without changing it says why it cannot run
  assert.throws(() => rt.schedules.setEnabled(count.id, true), /已执行 1 次：要再启用/);
  assert.equal(rt.schedules.get(count.id)!.enabled, false);
  assert.match(rt.schedules.get(count.id)!.ended!, /已执行 1 次/);
  const more = rt.schedules.upsert({ ...draft(ws, { stop: { kind: 'count', n: 5 } }), id: count.id });
  assert.equal(more.enabled, true, 'raising the count brings it back');
  assert.equal(more.ended, undefined);
  // the folder went away
  const gone = tmpDir('edict-sch-gone-');
  const g = rt.schedules.upsert(draft(gone));
  fs.rmSync(gone, { recursive: true, force: true });
  const f = await fireDue(rt, g);
  assert.equal(f.runs, 0);
  assert.equal(f.history[0].outcome, 'failed');
  assert.match(f.history[0].note!, /工作区不存在/);
  assert.ok(f.enabled && f.nextAt! > Date.now(), 'tries again next time');
  rt.dispose();
  await mock.close();
});

// ───────────────────────── permission caps ─────────────────────────

test('只读: no worktree, write subtasks run read-only without asking, writes and commands are refused', async () => {
  const mock = await startMockLlm();
  const rt = makeRuntime(mock.url);
  const repo = makeRepo();
  const s = rt.schedules.upsert(draft(repo, { permission: 'readonly' }));
  await fireDue(rt, s);
  const t = lastTask(rt, s);
  assert.equal(rt.modeFor(t), 'readonly');
  const s1 = await waitFor(() => t.nodes.find((n) => n.subtaskId === 'S1' && n.grant), 20000, 'S1 granted');
  assert.equal(s1.grant, 'readonly');
  assert.ok(!pending(rt, 'write_task', t.id), 'nobody is asked');
  assert.equal(t.worktree, undefined, 'a read-only edict needs no worktree');
  const w = await executeTool({ rt, agentId: 'bingbu', task: t }, 'write_file', { path: 'x.txt', content: 'x' });
  assert.equal(w.ok, false);
  assert.match(w.output, /按「只读」排定/);
  const c = await executeTool({ rt, agentId: 'bingbu', task: t }, 'run_command', { command: 'touch y.txt' });
  assert.equal(c.ok, false);
  assert.ok(!pending(rt, 'escalate', t.id), 'no upgrade card for a read-only schedule');
  assert.equal((await executeTool({ rt, agentId: 'bingbu', task: t }, 'read_file', { path: 'README.md' })).ok, true);
  await waitFor(() => TERMINAL_OR_GATE(t), 30000, 'end of the run');
  assert.ok(!fs.existsSync(path.join(repo, 'greet.js')) && !fs.existsSync(path.join(repo, 'x.txt')));
  assert.equal(gitc(repo, 'status', '--porcelain'), '');
  await finish(rt, mock);
});

test('在旨意工作树里改: always its own worktree, works there without asking; the main checkout is untouched', async () => {
  const mock = await startMockLlm();
  const rt = makeRuntime(mock.url);
  rt.updateSettings({ permissionMode: 'ask', worktreePerEdict: false });
  const repo = makeRepo();
  const s = rt.schedules.upsert(draft(repo, { permission: 'worktree' }));
  await fireDue(rt, s);
  const t = lastTask(rt, s);
  await waitFor(() => t.gate?.kind === 'final' || stateOf(rt, t.id) === 'Blocked', 30000, 'final gate');
  assert.equal(t.state, 'PendingConfirm', t.blockedReason);
  assert.equal(t.worktree?.status, 'active', 'worktree although 每道旨意一个工作树 is off');
  assert.equal(rt.modeFor(t), 'auto');
  assert.ok(!rt.audit.list({ taskId: t.id, limit: 500 }).some((e) => e.action === 'approval_requested'), 'nobody was asked while it worked');
  assert.ok(fs.existsSync(path.join(t.worktree!.path, 'greet.js')));
  assert.ok(!fs.existsSync(path.join(repo, 'greet.js')));
  assert.equal(gitc(repo, 'status', '--porcelain'), '');
  assert.match(scheduleNote(t), /工作树里可以放手改/);
  // high risk still asks
  const hi = executeTool({ rt, agentId: 'bingbu', task: t }, 'run_command', { command: 'rm -rf build' });
  const card = await waitFor(() => pending(rt, 'action', t.id), 5000, 'high-risk card');
  assert.equal(card.risk, 'high');
  rt.decideApproval(card.id, false);
  assert.equal((await hi).ok, false);
  await finish(rt, mock);
});

test('在旨意工作树里改 outside a git repository falls back to asking', async () => {
  const mock = await startMockLlm();
  const rt = makeRuntime(mock.url);
  const ws = tmpDir('edict-sch-plain-');
  const s = rt.schedules.upsert(draft(ws, { permission: 'worktree' }));
  await fireDue(rt, s);
  const t = lastTask(rt, s);
  assert.equal(t.permissionMode, 'auto');
  assert.equal(rt.modeFor(t), 'ask', 'no worktree yet / none possible');
  await waitFor(() => pending(rt, 'write_task', t.id), 20000, 'write task card');
  assert.equal(t.worktree, undefined);
  await finish(rt, mock);
});

// ───────────────────────── officials' proposals ─────────────────────────

test('an official proposes a schedule; it takes effect only when the emperor approves', async () => {
  const mock = await startMockLlm();
  const dataDir = tmpDir('edict-sch-data-');
  const rt = makeRuntime(mock.url, 'openai-chat', dataDir);
  const ws = tmpDir('edict-sch-ws-');
  rt.setWorkspace(ws);
  const args = { title: '每周查依赖', edict: '检查依赖是否有新版本，列出可升级的包', when: { kind: 'weekly', days: [1], time: '09:00' }, permission: 'readonly', reason: '依赖常有安全更新' };
  // no edict context: proposes for the open folder
  const r = await executeTool({ rt, agentId: 'gongbu' }, 'propose_schedule', args);
  assert.equal(r.ok, true, r.output);
  assert.match(r.output, /已上疏提议定时旨意「每周查依赖」（每周一 09:00，只读）/);
  const p = rt.schedules.all()[0];
  assert.equal(p.proposal, 'pending');
  assert.equal(p.enabled, false);
  assert.equal(p.nextAt, null);
  assert.equal(p.workspace, rt.workspace!.root);
  assert.deepEqual(p.origin, { by: 'official', agentId: 'gongbu', taskId: undefined, reason: '依赖常有安全更新' });
  const card = pending(rt, 'schedule')!;
  assert.ok(card);
  assert.deepEqual(card.choices!.map((c) => c.id), ['approve', 'paused', 'deny']);
  assert.match(card.summary, /工部.*提议定时旨意：每周查依赖（每周一 09:00）/);
  // a tick does nothing for a proposal; enabling it or running it is refused
  await rt.schedules.tick(Date.now());
  assert.equal(rt.tasks.size, 0);
  assert.throws(() => rt.schedules.setEnabled(p.id, true), /还没准奏/);
  await assert.rejects(rt.schedules.runNow(p.id), /还没准奏/);
  // the same asker cannot propose twice; bad rules are refused
  assert.match((await executeTool({ rt, agentId: 'gongbu' }, 'propose_schedule', args)).output, /已经提议过/);
  assert.match((await executeTool({ rt, agentId: 'hubu' }, 'propose_schedule', { ...args, when: { kind: 'once' } })).output, /when 无效/);
  // approved
  rt.decideApproval(card.id, true, 'emperor', 'approve');
  await waitFor(() => !rt.schedules.get(p.id)!.proposal, 2000, 'approved');
  const ok = rt.schedules.get(p.id)!;
  assert.equal(ok.enabled, true);
  assert.ok(ok.nextAt! > Date.now());
  assert.ok(rt.audit.list({ limit: 100 }).some((e) => e.action === 'schedule_proposal_approved'));

  // 排上，但先停用
  await executeTool({ rt, agentId: 'libu' }, 'propose_schedule', { ...args, title: '每日周报', when: { kind: 'daily', time: '18:00' } });
  const p2 = rt.schedules.all().find((x) => x.title === '每日周报')!;
  rt.decideApproval(pending(rt, 'schedule')!.id, true, 'emperor', 'paused');
  await waitFor(() => !rt.schedules.get(p2.id)!.proposal, 2000, 'paused');
  assert.equal(rt.schedules.get(p2.id)!.enabled, false);

  // the emperor edits a proposal and saves it: that is his answer, the card closes
  await executeTool({ rt, agentId: 'hubu' }, 'propose_schedule', { ...args, title: '月度账目', when: { kind: 'daily', time: '07:00' } });
  const pe = rt.schedules.all().find((x) => x.title === '月度账目')!;
  const peCard = pending(rt, 'schedule')!;
  const edited = rt.schedules.upsert({ ...draft(ws, { title: '月度账目', text: pe.text, rule: { kind: 'daily', time: '07:30' } }), id: pe.id });
  assert.equal(edited.proposal, undefined);
  assert.equal(edited.enabled, true);
  assert.deepEqual(edited.origin, pe.origin, 'still shows who proposed it');
  assert.equal(rt.approvals.get(peCard.id)!.status, 'approved');
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(rt.schedules.get(pe.id), 'not dropped by its card closing');

  // 不必: the proposal is dropped
  await executeTool({ rt, agentId: 'xingbu' }, 'propose_schedule', { ...args, title: '每小时扫描', when: { kind: 'interval', hours: 1 } });
  const p3 = rt.schedules.all().find((x) => x.title === '每小时扫描')!;
  rt.decideApproval(pending(rt, 'schedule')!.id, false, 'emperor', 'deny', '太频繁');
  await waitFor(() => !rt.schedules.get(p3.id), 2000, 'dropped');

  // a pending proposal is put again after a restart (approval cards live in memory)
  await executeTool({ rt, agentId: 'bingbu' }, 'propose_schedule', { ...args, title: '早朝跑测试', when: { kind: 'court' }, permission: 'worktree' });
  const p4 = rt.schedules.all().find((x) => x.title === '早朝跑测试')!;
  assert.equal(p4.permission, 'worktree');
  rt.dispose();
  const rt2 = makeRuntime(mock.url, 'openai-chat', dataDir);
  assert.equal(rt2.schedules.get(p4.id)!.proposal, 'pending');
  assert.ok(!pending(rt2, 'schedule'));
  rt2.schedules.start();
  rt2.schedules.stop();
  const again = pending(rt2, 'schedule')!;
  assert.equal(again.tool, `schedule:${p4.id}`);
  rt2.schedules.start(); // started twice: still one card
  rt2.schedules.stop();
  assert.equal([...rt2.approvals.values()].filter((a) => a.status === 'pending' && a.kind === 'schedule').length, 1);
  // deleting it closes its card
  rt2.schedules.remove(p4.id);
  assert.equal(rt2.approvals.get(again.id)!.status, 'denied');
  rt2.dispose();
  await mock.close();
});

test('inside an edict the proposal points back to it, and a scheduled edict cannot propose another', async () => {
  const mock = await startMockLlm();
  const rt = makeRuntime(mock.url);
  const repo = makeRepo();
  const s = rt.schedules.upsert(draft(repo, { permission: 'ask' }));
  await fireDue(rt, s);
  const t = lastTask(rt, s);
  const args = { title: '再排一个', edict: '…', when: { kind: 'daily', time: '10:00' }, reason: 'x' };
  assert.match((await executeTool({ rt, agentId: 'bingbu', task: t }, 'propose_schedule', args)).output, /定时旨意里不再提议/);
  cancelAll(rt);
  // an ordinary edict
  rt.setWorkspace(repo);
  const { submit } = await import('../src/main/runtime/orchestrator');
  const r = (await submit(rt, { text: '写一个 greet 函数并测试', tier: 'lite', multiAgent: true })) as { taskId: string };
  const e = rt.tasks.get(r.taskId)!;
  const out = await executeTool({ rt, agentId: 'bingbu', task: e }, 'propose_schedule', { ...args, permission: 'bogus' });
  assert.equal(out.ok, true, out.output);
  const p = rt.schedules.all().find((x) => x.proposal)!;
  assert.equal(p.permission, 'readonly', 'unknown permission → read-only');
  assert.equal(p.workspace, rt.permRoot(e), 'the repository, not the edict worktree');
  assert.deepEqual(p.origin.by === 'official' && [p.origin.agentId, p.origin.taskId], ['bingbu', e.id]);
  const card = pending(rt, 'schedule')!;
  assert.equal(card.taskId, undefined, 'the official does not wait on it');
  assert.match(card.detail, new RegExp(`提议自旨意：.*${e.id}`));
  assert.ok(rt.agents.get('bingbu')!.status !== 'waiting');
  // the proposal outlives its edict
  rt.cancel(e.id);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(rt.schedules.get(p.id)!.proposal, 'pending');
  assert.equal(rt.approvals.get(card.id)!.status, 'pending');
  await finish(rt, mock);
});

test('the Mac is kept awake only while a scheduled edict is working', async () => {
  const mock = await startMockLlm({ delayMs: 40 });
  const rt = makeRuntime(mock.url);
  const ws = tmpDir('edict-sch-ws-');
  assert.equal(rt.schedules.keepAwake(), false);
  const s = rt.schedules.upsert(draft(ws, { permission: 'worktree' }));
  await fireDue(rt, s);
  const t = lastTask(rt, s);
  assert.equal(rt.schedules.keepAwake(), true);
  await waitFor(() => pending(rt, undefined, t.id) || TERMINAL_OR_GATE(t), 30000, 'waits or ends');
  assert.equal(rt.schedules.keepAwake(), false);
  await finish(rt, mock);
});

const TERMINAL_OR_GATE = (t: Task) => !!t.gate || ['Done', 'Cancelled', 'Failed', 'Blocked'].includes(t.state);
