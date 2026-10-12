// SQLite store (edict.db): round trips, incremental write-behind, transactions, 1.x JSON migration,
// backups, idempotency, corrupt JSON / corrupt db recovery, two connections, and a size sanity check.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  MIGRATIONS, SCHEMA_VERSION, SqliteStore, openStateStore, isCorruptError,
  type PersistedSettingsLike, type PersistedStateLike, type StoreLogger, type StoreSource,
} from '../src/main/runtime/sqliteStore';
import { defaultSettings } from '../src/main/runtime/defaults';
import { emptyUsage, type Annotation, type Debate, type Memorial, type NewsItem, type ProviderConfig, type RunNode, type Session, type Task, type Usage } from '../src/shared/types';

const ROOT = path.resolve(__dirname, '..');
const STORE_MODULE = path.join(ROOT, 'src/main/runtime/sqliteStore');
const tmp = (p = 'edict-sqlite-') => fs.mkdtempSync(path.join(os.tmpdir(), p));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
function capture() {
  const lines: string[] = [];
  const log: StoreLogger = (level, line) => lines.push(`${level}: ${line}`);
  return { lines, log };
}

// ───────────────────────── a realistic 1.x data set ─────────────────────────
const T0 = Date.UTC(2026, 8, 30, 2, 0, 0);
const usage = (i: number, o: number, c = 0): Usage => ({ inputTokens: i, outputTokens: o, cachedTokens: c, costUsd: +((i * 3 + o * 15) / 1e6).toFixed(6), calls: 1 });

function legacyTask(n: number, over: Partial<Task> = {}): Task {
  const id = `t-${n}`;
  const at = T0 + n * 3_600_000;
  const plan = {
    summary: `为第 ${n} 道旨意实现 greet(name) 并补充单元测试`,
    subtasks: [
      { id: 'S1', title: '实现 greet', dept: 'gongbu' as const, detail: '在 src/greet.ts 导出 greet(name)', acceptance: 'greet("朕") === "你好，朕"', dependsOn: [] },
      { id: 'S2', title: '补测试', dept: 'xingbu' as const, detail: '覆盖空字符串', acceptance: 'npm test 通过', dependsOn: ['S1'] },
    ],
    risks: ['空名字的处理'],
  };
  const nodes: RunNode[] = [
    { id: `${id}-plan`, kind: 'plan', agentId: 'zhongshu', label: '中书规划', status: 'done', attempts: 1, runId: `run-${n}-1`, model: 'deepseek-chat', providerId: 'deepseek', protocol: 'openai-chat', startedAt: at + 1000, endedAt: at + 9000, exitStatus: 'ok', output: JSON.stringify(plan), usage: usage(1800, 420) },
    { id: `${id}-review`, kind: 'review', agentId: 'menxia', label: '门下审议', status: 'done', attempts: 1, startedAt: at + 9500, endedAt: at + 12000, exitStatus: 'ok', output: '{"verdict":"approve"}', usage: usage(900, 120), effort: 'high' },
    { id: `${id}-S1`, kind: 'exec', agentId: 'gongbu', label: '实现 greet', subtaskId: 'S1', status: 'done', attempts: 2, startedAt: at + 13000, endedAt: at + 40000, exitStatus: 'ok', output: '已实现 greet', usage: usage(5200, 1400, 2000) },
    { id: `${id}-S2`, kind: 'exec', agentId: 'xingbu', label: '补测试', subtaskId: 'S2', status: n % 2 ? 'done' : 'failed', attempts: 1, startedAt: at + 41000, endedAt: at + 52000, exitStatus: n % 2 ? 'ok' : 'interrupted', error: n % 2 ? undefined : '应用退出导致运行中断', usage: usage(3100, 800) },
  ];
  if (nodes[3].error === undefined) delete nodes[3].error;
  return {
    id, title: `旨意 ${n}：实现 greet 函数`, edict: `写一个 greet 函数并测试（第 ${n} 道）`, tier: 'lite', state: n % 2 ? 'Done' : 'Blocked',
    createdAt: at, updatedAt: at + 60_000, workspace: '/Users/emperor/code/demo',
    flow: [
      { at, from: '皇上', to: '太子', remark: '下旨', state: 'Taizi' },
      { at: at + 900, from: '太子', to: '中书省', remark: '分拣为旨意', state: 'Zhongshu' },
      { at: at + 52_500, from: '尚书省', to: '皇上', remark: '回奏', state: n % 2 ? 'Done' : 'Blocked' },
    ],
    plan, planHistory: [{ version: 1, plan, author: 'zhongshu', at: at + 9000 }],
    reviews: [{ round: 1, stage: 'plan', verdict: 'approve', issues: [], comment: '准奏', reviewer: 'menxia', at: at + 12000 }],
    nodes, paused: false,
    ...(n % 2 ? {} : { blockedReason: '应用重启：运行中的节点已中断，可「重试失败节点」局部恢复', resumeState: 'Doing' as const }),
    result: { summary: '## 回奏\n已实现 greet 并通过测试。', artifacts: [{ path: 'src/greet.ts', sha256: 'ab'.repeat(32), bytes: 120, agentId: 'gongbu', nodeId: `${id}-S1`, at: at + 40000 }] },
    changes: [
      { id: `fc-${n}-1`, taskId: id, path: 'src/greet.ts', op: 'create', beforeHash: null, afterHash: 'ab'.repeat(32), agentId: 'gongbu', nodeId: `${id}-S1`, at: at + 30000 },
      { id: `fc-${n}-2`, taskId: id, path: 'README.md', op: 'modify', beforeHash: 'cd'.repeat(32), afterHash: 'ef'.repeat(32), agentId: 'gongbu', nodeId: `${id}-S1`, at: at + 35000, reverted: true },
    ],
    usage: usage(11000, 2740, 2000), budget: { maxTokens: 600_000, maxRejections: 1, maxCostUsd: 0 }, estimate: { tokens: 9000, costUsd: 0.05 },
    strongModel: { providerId: 'deepseek', model: 'deepseek-chat' }, effort: 'high', lastActivityAt: at + 52_000, execRound: 1,
    ...over,
  };
}

function legacyFixture(): { state: PersistedStateLike; settings: PersistedSettingsLike } {
  const tasks = [legacyTask(1), legacyTask(2), legacyTask(3, { tier: 'solo', state: 'Done', sessionId: 's-solo' })];
  const debates: Debate[] = [{
    id: 'db-1', topic: '是否把存储换成 SQLite', taskId: 't-1', participants: ['zhongshu', 'menxia', 'bingbu'], round: 2, maxRounds: 2, status: 'concluded',
    conclusion: '准：增量写入，保留 1.x 备份', createdAt: T0, updatedAt: T0 + 5000, pendingInterjections: [],
    messages: [
      { id: 'dm-1', speaker: 'zhongshu', content: '整文件重写在任务多时太慢。', at: T0 + 1000, round: 1, kind: 'official' },
      { id: 'dm-2', speaker: 'emperor', content: '务必可回滚。', at: T0 + 2000, round: 1, kind: 'emperor' },
      { id: 'dm-3', speaker: 'menxia', content: '附议，需备份。', at: T0 + 3000, round: 2, kind: 'official', repliesTo: 'dm-2' },
    ],
  }];
  const sessions: Session[] = [
    { id: 's-solo', title: '独奏：greet', source: 'solo', agentId: 'solo', taskId: 't-3', createdAt: T0, updatedAt: T0 + 100, status: 'done', usage: usage(400, 100), messages: [{ role: 'user', content: '写 greet', at: T0 }, { role: 'assistant', content: '```ts\nexport const greet = (n: string) => `你好，${n}`;\n```', at: T0 + 50 }] },
    { id: 's-chat', title: '太子闲聊', source: 'taizi-chat', agentId: 'taizi', createdAt: T0 + 200, updatedAt: T0 + 300, status: 'done', usage: usage(80, 40), messages: [{ role: 'user', content: '今日天气？', at: T0 + 200 }, { role: 'assistant', content: '臣不知。', at: T0 + 250 }] },
  ];
  const t1 = tasks[0];
  const memorials: Memorial[] = [{
    taskId: 't-1', title: t1.title, edict: t1.edict, tier: t1.tier, finalState: 'Done', archivedAt: T0 + 7_200_000,
    stages: [{ key: 'edict', label: '圣旨', at: t1.createdAt, items: [t1.edict, '档位：lite'] }, { key: 'report', label: '回奏', at: t1.updatedAt, items: ['已实现 greet'] }],
    artifacts: t1.result!.artifacts, usage: t1.usage, models: ['deepseek-chat'],
    runs: t1.nodes.map((nd) => ({ nodeId: nd.id, label: nd.label, runId: nd.runId, model: nd.model, exitStatus: nd.exitStatus, startedAt: nd.startedAt, endedAt: nd.endedAt })).map((r) => clone(r)),
    flow: t1.flow,
  }];
  const annotations: Annotation[] = [
    { id: 'an-1', agentId: 'gongbu', taskId: 't-2', text: '注意空字符串', at: T0 + 10, consumedAt: T0 + 20, response: '遵旨', respondedAt: T0 + 30 },
    { id: 'an-2', agentId: 'menxia', text: '从严审议', at: T0 + 40 },
  ];
  const news: NewsItem[] = [
    { id: 'nw-3', title: '捷报：「旨意 3」已完成', source: '军机处', category: '朝廷', at: T0 + 30_000, summary: '已实现 greet' },
    { id: 'nw-2', title: 'Node 24 发布', link: 'https://example.com/node-24', source: 'example', category: '科技', at: T0 + 20_000 },
    { id: 'nw-1', title: '捷报：「旨意 1」已完成', source: '军机处', category: '朝廷', at: T0 + 10_000 },
  ];
  const providers: ProviderConfig[] = [
    { id: 'deepseek', name: 'DeepSeek', preset: 'deepseek', protocol: 'openai-chat', baseUrl: 'https://api.deepseek.com/v1', hasKey: true, enabled: true, replayReasoning: true,
      models: [{ id: 'deepseek-chat', inputPrice: 0.27, outputPrice: 1.1, cachedInputPrice: 0.07, contextWindow: 64000 }, { id: 'deepseek-reasoner', inputPrice: 0.55, outputPrice: 2.19, contextWindow: 64000, reasoning: { style: 'none', levels: [], default: '' } }] },
    { id: 'anthropic', name: 'Anthropic', preset: 'anthropic', protocol: 'anthropic-messages', baseUrl: 'https://api.anthropic.com', hasKey: false, enabled: true, extraHeaders: { 'x-team': '中书' },
      models: [{ id: 'claude-x', inputPrice: 3, outputPrice: 15, contextWindow: 200000, maxOutputTokens: 64000, reasoning: { style: 'anthropic-budget', levels: ['low', 'high'], default: 'low', budgets: { low: 2048, high: 16384 } } }] },
  ];
  return {
    state: {
      tasks, debates, sessions, memorials, annotations, news,
      agentStats: { zhongshu: { usage: usage(5400, 1260), completed: 3, sessions: 3, errors: 0 }, gongbu: { usage: usage(15600, 4200), completed: 3, sessions: 4, errors: 1 } },
      totals: { ...usage(33000, 8220, 6000), calls: 12 },
      seqByDay: { '20260930': 3 },
    },
    settings: {
      settings: { ...defaultSettings(), routing: { strong: { providerId: 'deepseek', model: 'deepseek-chat' }, economy: { providerId: 'deepseek', model: 'deepseek-chat' } }, lastWorkspace: '/Users/emperor/code/demo', newsFeeds: [{ url: 'https://example.com/feed.xml', category: '科技', enabled: true }], composerEffort: 'high' },
      providers,
    },
  };
}

/** Write a 1.x data dir exactly the way JsonFile.saveNow() did. */
function write1x(dir: string, fx = legacyFixture()) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(fx.state, null, 1));
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(fx.settings, null, 1));
  fs.writeFileSync(path.join(dir, 'audit.jsonl'), '{"seq":1}\n');
  return fx;
}

/** An in-memory runtime stand-in: same bounded projections as Runtime.persistedState(). */
function model(fx = legacyFixture()) {
  const m = { state: clone(fx.state), settings: clone(fx.settings) };
  const source: StoreSource = {
    state: () => ({ ...m.state, sessions: m.state.sessions.slice(-300), annotations: m.state.annotations.slice(-1000), news: m.state.news.slice(0, 200) }),
    settings: () => m.settings,
  };
  return { m, source };
}

const backups = (dir: string) => fs.readdirSync(dir).filter((f) => f.startsWith('backup-1.x-'));

// ───────────────────────── tests ─────────────────────────

test('schema: WAL, synchronous=NORMAL, foreign keys, busy timeout, ordered migrations recorded in user_version', () => {
  const dir = tmp();
  const s = SqliteStore.open(path.join(dir, 'edict.db'));
  const p = (q: string) => Object.values(s.raw.prepare(q).get() as object)[0];
  assert.equal(s.journalMode, 'wal');
  assert.equal(p('PRAGMA journal_mode'), 'wal');
  assert.equal(p('PRAGMA synchronous'), 1, 'NORMAL');
  assert.equal(p('PRAGMA foreign_keys'), 1);
  assert.equal(p('PRAGMA busy_timeout'), 5000);
  assert.equal(s.schemaVersion, SCHEMA_VERSION);
  for (let i = 1; i < MIGRATIONS.length; i++) assert.ok(MIGRATIONS[i].version > MIGRATIONS[i - 1].version, 'strictly increasing');
  const applied = s.raw.prepare('SELECT version, name FROM schema_migrations ORDER BY version').all().map((r) => Number(r.version));
  assert.deepEqual(applied, MIGRATIONS.map((m) => m.version));
  const tables = s.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((r) => r.name);
  for (const t of ['annotations', 'debates', 'kv', 'memorials', 'meta', 'news', 'schema_migrations', 'sessions', 'tasks']) assert.ok(tables.includes(t), t);
  s.close();
  // re-opening an up-to-date db applies nothing
  const s2 = SqliteStore.open(path.join(dir, 'edict.db'));
  assert.equal(s2.raw.prepare('SELECT count(*) AS n FROM schema_migrations').get()!.n, MIGRATIONS.length);
  s2.close();
});

test('round trip: every field and the runtime order survive close + reopen', () => {
  const dir = tmp();
  const fx = legacyFixture();
  const s = SqliteStore.open(path.join(dir, 'edict.db'));
  assert.ok(s.isEmpty());
  assert.equal(s.upsertTasks(fx.state.tasks), 3);
  assert.equal(s.upsertTasks(fx.state.tasks), 0, 'unchanged rows are not rewritten');
  s.upsertMany('debates', fx.state.debates);
  s.upsertMany('sessions', fx.state.sessions);
  s.upsertMany('memorials', fx.state.memorials);
  s.upsertMany('annotations', fx.state.annotations);
  // news is stored newest first regardless of insertion order
  s.upsertMany('news', [...fx.state.news].reverse());
  assert.equal(s.setKv('totals', fx.state.totals), true);
  assert.equal(s.setKv('totals', fx.state.totals), false, 'same value → no write');
  s.setKv('seqByDay', fx.state.seqByDay);
  s.setKv('agentStats', fx.state.agentStats);
  s.setKv('settings', fx.settings.settings);
  s.setKv('providers', fx.settings.providers);
  assert.ok(!s.isEmpty());
  s.close();
  assert.throws(() => s.loadState(), /closed/);

  const s2 = SqliteStore.open(path.join(dir, 'edict.db'));
  const st = s2.loadState();
  assert.deepEqual(st, clone(fx.state));
  assert.deepEqual(st.tasks.map((t) => t.id), ['t-1', 't-2', 't-3']);
  assert.deepEqual(st.news.map((n) => n.id), ['nw-3', 'nw-2', 'nw-1']);
  assert.deepEqual(s2.loadSettings(), clone(fx.settings));
  assert.equal(s2.getKv('nope'), undefined);
  // indexed columns mirror the JSON
  assert.deepEqual({ ...s2.raw.prepare("SELECT state, created_at, updated_at FROM tasks WHERE id = 't-2'").get() }, { state: 'Blocked', created_at: fx.state.tasks[1].createdAt, updated_at: fx.state.tasks[1].updatedAt });
  // an update keeps the row's position (Map semantics), delete removes it
  const t1 = { ...st.tasks[0], title: '改名', updatedAt: st.tasks[0].updatedAt + 1 };
  assert.equal(s2.upsertTasks([t1]), 1);
  assert.equal(s2.deleteTask('t-2'), true);
  assert.equal(s2.deleteTask('t-2'), false);
  assert.deepEqual(s2.loadState().tasks.map((t) => [t.id, t.title]), [['t-1', '改名'], ['t-3', fx.state.tasks[2].title]]);
  // replaceAll stores exactly the given list, in order
  assert.equal(s2.replaceAll('annotations', [fx.state.annotations[1]]), 1);
  assert.deepEqual(s2.loadState().annotations.map((a) => a.id), ['an-2']);
  assert.equal(s2.deleteKv('seqByDay'), true);
  assert.deepEqual(s2.loadState().seqByDay, {});
  assert.deepEqual(s2.counts(), { tasks: 2, debates: 1, sessions: 2, memorials: 1, annotations: 1, news: 3, kv: 4 });
  assert.equal(s2.integrityCheck(true).ok, true);
  s2.close();
  // an empty store loads as the runtime's fallback state, and settings as null
  const s3 = SqliteStore.open(path.join(tmp(), 'edict.db'));
  assert.deepEqual(s3.loadState(), { tasks: [], debates: [], sessions: [], memorials: [], annotations: [], news: [], agentStats: {}, totals: { inputTokens: 0, outputTokens: 0, cachedTokens: 0, costUsd: 0, calls: 0 }, seqByDay: {} });
  assert.equal(s3.loadSettings(), null);
  s3.close();
});

test('write-behind: marks are batched for 250 ms and only dirty / changed rows are written', async () => {
  const dir = tmp();
  const fx = legacyFixture();
  const seed = SqliteStore.open(path.join(dir, 'edict.db'));
  seed.importLegacy(fx.state, fx.settings);
  seed.close();

  const s = SqliteStore.open(path.join(dir, 'edict.db'));
  const { m, source } = model(fx);
  m.state = s.loadState(); // like the runtime: keep the loaded objects and mutate them in place
  m.settings = s.loadSettings()!;
  s.bind(source);
  const reader = SqliteStore.open(path.join(dir, 'edict.db')); // a second connection sees only committed data
  const titleOnDisk = (id: string) => {
    const r = reader.raw.prepare('SELECT json FROM tasks WHERE id = ?').get(id) as { json: string } | undefined;
    return r ? (JSON.parse(r.json) as Task).title : undefined;
  };

  // 1) touch(task): one task edited in place, many marks → one flush, one row
  const t2 = m.state.tasks[1];
  t2.title = '已修改';
  t2.nodes[3].status = 'done';
  const before = s.stats();
  for (let i = 0; i < 20; i++) {
    s.markDirty('tasks', t2.id);
    s.markStateDirty();
  }
  assert.equal(s.pending, true);
  assert.notEqual(titleOnDisk('t-2'), '已修改', 'not written synchronously');
  await sleep(320);
  assert.equal(s.pending, false);
  assert.equal(titleOnDisk('t-2'), '已修改');
  let after = s.stats();
  assert.equal(after.flushes - before.flushes, 1, 'one batched flush');
  assert.equal(after.rowsWritten - before.rowsWritten, 1, 'only the dirty task row');

  // 2) persist() with nothing changed writes nothing (content-synced rows are compared, task rows not even serialized)
  s.markStateDirty();
  const r2 = s.flush();
  assert.equal(r2.written + r2.deleted, 0);
  assert.equal(r2.skipped, 1 + 2 + 2 + 3 + 3, 'debate + sessions + annotations + news + kv, compared and left alone');

  // 3) in-place edits of content-synced kinds are picked up by persist() alone
  m.state.sessions[0].messages.push({ role: 'user', content: '再来一个', at: T0 + 999 });
  m.state.annotations[1].consumedAt = T0 + 1234;
  m.state.totals.calls++;
  s.markStateDirty();
  assert.equal(s.flush().written, 3);

  // 4) memorials are rebuilt as new objects → a reference change is enough
  m.state.memorials[0] = { ...m.state.memorials[0], archivedAt: T0 + 9_999_999 };
  s.markStateDirty();
  assert.equal(s.flush().written, 1);

  // 5) a task edited in place WITHOUT markDirty is (by design) not seen by persist() — but a full flush catches it
  m.state.tasks[2].title = '未 touch 的修改';
  s.markStateDirty();
  assert.equal(s.flush().written, 0);
  assert.equal(s.flush({ full: true }).written, 1);
  assert.equal(titleOnDisk('t-3'), '未 touch 的修改');

  // 6) deletions: removed from the runtime → row deleted; bounded lists drop what falls out of the window
  m.state.tasks.splice(0, 1); // api deleteTask → rt.tasks.delete + persist()
  m.state.news = [{ id: 'nw-4', title: '新消息', source: 'x', category: '科技', at: T0 + 40_000 }, ...m.state.news].slice(0, 2);
  s.markStateDirty();
  const r6 = s.flush();
  assert.equal(r6.written, 1, 'nw-4');
  assert.equal(r6.deleted, 3, 't-1, nw-2, nw-1');
  assert.deepEqual(reader.loadState().news.map((n) => n.id), ['nw-4', 'nw-3']);
  // a row-level mark for something the source no longer has deletes it
  m.state.debates = [];
  s.markDirty('debates', 'db-1');
  assert.equal(s.flush().deleted, 1);

  // 7) settings: saveSettings() → settings + providers, unchanged → no write
  s.markSettingsDirty();
  assert.equal(s.flush().written, 0);
  m.settings.settings.theme = 'dark';
  m.settings.providers[1].enabled = false;
  s.markSettingsDirty();
  assert.equal(s.flush().written, 2);
  assert.equal(reader.loadSettings()!.settings.theme, 'dark');

  // 8) marks before bind() are kept and flushed once bound
  const late = SqliteStore.open(path.join(dir, 'edict.db'), { debounceMs: 10 });
  late.markKvDirty('seqByDay');
  assert.equal(late.pending, true);
  m.state.seqByDay['20261001'] = 1;
  late.bind(source);
  await sleep(60);
  assert.equal(late.pending, false);
  assert.deepEqual(reader.getKv('seqByDay'), { '20260930': 3, '20261001': 1 });
  late.close();
  after = s.stats();
  assert.equal(after.failedFlushes, 0);
  s.close();
  reader.close();
});

test('transaction: a throw rolls back rows, kv and the change tracking; savepoints nest', async () => {
  const fx = legacyFixture();
  const s = SqliteStore.open(path.join(tmp(), 'edict.db'));
  s.upsertTasks([fx.state.tasks[0]]);
  assert.throws(() => s.transaction(() => {
    s.upsertTasks([fx.state.tasks[1]]);
    s.setKv('totals', fx.state.totals);
    s.deleteTask('t-1');
    throw new Error('boom');
  }), /boom/);
  assert.equal(s.counts().tasks, 1);
  assert.equal(s.getKv('totals'), undefined);
  // the change tracking was rolled back too: t-1 is still known (unchanged → skipped), t-2 / totals are not
  assert.equal(s.upsertTasks([fx.state.tasks[0]]), 0);
  assert.equal(s.upsertTasks([fx.state.tasks[1]]), 1);
  assert.equal(s.setKv('totals', fx.state.totals), true);
  assert.deepEqual(s.loadState().tasks.map((t) => t.id), ['t-1', 't-2']);
  const { m } = model(fx);

  // nested: the inner failure is contained, the outer commit keeps its own writes
  s.transaction(() => {
    s.upsertTasks([fx.state.tasks[2]]);
    assert.throws(() => s.transaction(() => {
      s.deleteTask('t-1');
      throw new Error('inner');
    }), /inner/);
  });
  assert.deepEqual(s.loadState().tasks.map((t) => t.id), ['t-1', 't-2', 't-3']);
  // async callbacks are refused (and rolled back) instead of committing half a transaction
  assert.throws(() => s.transaction((async () => {
    s.deleteTask('t-3');
  }) as unknown as () => void), /synchronous/);
  assert.equal(s.loadState().tasks.length, 3);
  // a failing flush keeps its marks for the next attempt
  let fail = true;
  s.bind({ state: () => { if (fail) throw new Error('source down'); return { ...m.state, tasks: [] }; } });
  s.markDirty('tasks', 't-1');
  assert.throws(() => s.flush(), /source down/);
  assert.equal(s.pending, true);
  fail = false;
  assert.equal(s.flush().deleted, 1);
  assert.equal(s.stats().failedFlushes, 1);
  s.close();
});

test('migration: a realistic 1.x data dir is imported in one go, backed up with a README, originals retired', () => {
  const dir = tmp();
  const fx = write1x(dir);
  const origState = fs.readFileSync(path.join(dir, 'state.json'));
  const origSettings = fs.readFileSync(path.join(dir, 'settings.json'));
  const { lines, log } = capture();
  const s = openStateStore(dir, { log, now: () => new Date(2026, 9, 12, 10, 15, 30) });
  const rep = s.openReport!;
  assert.equal(rep.created, true);
  assert.equal(rep.origin, 'import:1.x');
  assert.deepEqual(rep.imported!.counts, { tasks: 3, debates: 1, sessions: 2, memorials: 1, annotations: 2, news: 3, providers: 2, settings: true, skipped: 0 });
  assert.deepEqual(rep.renamed.sort(), ['settings.json', 'state.json']);
  // data
  assert.deepEqual(s.loadState(), clone(fx.state));
  assert.deepEqual(s.loadSettings(), clone(fx.settings));
  // backup folder: byte-identical originals + Chinese README
  assert.deepEqual(backups(dir), ['backup-1.x-20261012-101530']);
  const b = path.join(dir, 'backup-1.x-20261012-101530');
  assert.deepEqual(fs.readdirSync(b).sort(), ['README.txt', 'settings.json', 'state.json']);
  assert.ok(fs.readFileSync(path.join(b, 'state.json')).equals(origState));
  assert.ok(fs.readFileSync(path.join(b, 'settings.json')).equals(origSettings));
  const readme = fs.readFileSync(path.join(b, 'README.txt'), 'utf8');
  for (const s2 of ['Edict 1.x 数据备份', 'edict.db', '如何回滚', 'edict.db-wal', 'state.json', 'settings.json', '.migrated', dir]) assert.ok(readme.includes(s2), `README mentions ${s2}`);
  // originals renamed, everything else untouched
  assert.ok(!fs.existsSync(path.join(dir, 'state.json')) && !fs.existsSync(path.join(dir, 'settings.json')));
  assert.ok(fs.readFileSync(path.join(dir, 'state.json.migrated')).equals(origState));
  assert.ok(fs.readFileSync(path.join(dir, 'settings.json.migrated')).equals(origSettings));
  assert.equal(fs.readFileSync(path.join(dir, 'audit.jsonl'), 'utf8'), '{"seq":1}\n');
  // one summary line
  const info = lines.filter((l) => l.startsWith('info:'));
  assert.equal(info.length, 1, lines.join('\n'));
  assert.match(info[0], /migrated 1\.x JSON → edict\.db .*3 tasks, 1 debates, 2 sessions, 1 memorials, 2 annotations, 3 news, 2 providers, settings; backup: backup-1\.x-20261012-101530; originals renamed/);
  assert.equal(s.getMeta('import_backup'), 'backup-1.x-20261012-101530');
  s.close();
});

test('migration is idempotent: no re-import, no duplicate rows or backups; an interrupted rename is completed', () => {
  const dir = tmp();
  write1x(dir);
  openStateStore(dir, { log: () => {} }).close();
  const { lines, log } = capture();
  const s = openStateStore(dir, { log });
  assert.equal(s.openReport!.imported, undefined);
  assert.equal(s.openReport!.created, false);
  assert.deepEqual(s.counts(), { tasks: 3, debates: 1, sessions: 2, memorials: 1, annotations: 2, news: 3, kv: 5 });
  assert.equal(backups(dir).length, 1);
  assert.deepEqual(lines, []);
  s.close();

  // crash between commit and rename: the identical original is still there → just finish the rename
  fs.copyFileSync(path.join(dir, 'state.json.migrated'), path.join(dir, 'state.json'));
  const c1 = capture();
  const s2 = openStateStore(dir, { log: c1.log });
  assert.deepEqual(s2.openReport!.renamed, ['state.json']);
  assert.ok(!fs.existsSync(path.join(dir, 'state.json')));
  assert.equal(s2.counts().tasks, 3);
  assert.equal(backups(dir).length, 1);
  assert.match(c1.lines.join('\n'), /finished an interrupted 1\.x migration/);
  s2.close();

  // a state.json written by a 1.x build after the upgrade is never imported over the db, and is left alone
  const fx2 = legacyFixture();
  fx2.state.tasks = [legacyTask(9)];
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(fx2.state));
  const c2 = capture();
  const s3 = openStateStore(dir, { log: c2.log });
  assert.equal(s3.openReport!.imported, undefined);
  assert.deepEqual(s3.loadState().tasks.map((t) => t.id), ['t-1', 't-2', 't-3']);
  assert.ok(fs.existsSync(path.join(dir, 'state.json')));
  assert.match(c2.lines.join('\n'), /warn: \[store\] ignoring state\.json/);
  s3.close();

  // a fresh (never-written) db over a 1.x dir still imports: "absent or empty"
  const dir2 = tmp();
  openStateStore(dir2, { log: () => {} }).close();
  write1x(dir2);
  const s4 = openStateStore(dir2, { log: () => {} });
  assert.equal(s4.openReport!.origin, 'import:1.x');
  assert.equal(s4.counts().tasks, 3);
  s4.close();
  // and a brand-new data dir is simply fresh: no backup, nothing renamed
  const dir3 = tmp();
  const s5 = openStateStore(dir3, { log: () => {} });
  assert.equal(s5.openReport!.origin, 'fresh');
  assert.equal(s5.openReport!.imported, undefined);
  assert.deepEqual(fs.readdirSync(dir3).filter((f) => !f.startsWith('edict.db')), []);
  s5.close();
});

test('corrupt 1.x JSON: kept as .corrupt-<ts>, imported as empty, the healthy file still migrates', () => {
  const dir = tmp();
  const fx = legacyFixture();
  const torn = JSON.stringify(fx.state, null, 1).slice(0, 5000); // torn write
  fs.writeFileSync(path.join(dir, 'state.json'), torn);
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(fx.settings, null, 1));
  const { lines, log } = capture();
  const s = openStateStore(dir, { log });
  const corrupt = fs.readdirSync(dir).filter((f) => /^state\.json\.corrupt-\d+$/.test(f));
  assert.equal(corrupt.length, 1);
  assert.equal(fs.readFileSync(path.join(dir, corrupt[0]), 'utf8'), torn);
  assert.deepEqual(s.openReport!.imported!.corrupt, ['state.json']);
  assert.equal(s.loadState().tasks.length, 0);
  assert.deepEqual(s.loadSettings(), clone(fx.settings));
  const b = path.join(dir, backups(dir)[0]);
  assert.equal(fs.readFileSync(path.join(b, 'state.json'), 'utf8'), torn, 'the corrupt original is in the backup as-is');
  assert.match(fs.readFileSync(path.join(b, 'README.txt'), 'utf8'), /已损坏/);
  assert.ok(fs.existsSync(path.join(dir, 'state.json.migrated')));
  assert.match(lines.join('\n'), /corrupt \(imported as empty, copy kept\): state\.json/);
  s.close();
  // a JSON value that is not an object (e.g. "null") counts as corrupt, too
  const dir2 = tmp();
  fs.writeFileSync(path.join(dir2, 'state.json'), 'null');
  const s2 = openStateStore(dir2, { log: () => {} });
  assert.deepEqual(s2.openReport!.imported!.corrupt, ['state.json']);
  assert.equal(s2.loadSettings(), null);
  s2.close();
});

test('corrupt edict.db: moved aside as edict.db.corrupt-<ts>, recreated, refilled from the newest backup', () => {
  const dir = tmp();
  const fx = write1x(dir);
  const s = openStateStore(dir, { log: () => {}, now: () => new Date(2026, 9, 1, 8, 0, 0) });
  s.upsertTasks([legacyTask(7)]); // post-migration work (lost on recovery, by necessity)
  s.close();
  // an older backup must not win over the newest one
  fs.mkdirSync(path.join(dir, 'backup-1.x-20250101-000000'));
  fs.writeFileSync(path.join(dir, 'backup-1.x-20250101-000000', 'state.json'), JSON.stringify({ tasks: [legacyTask(42)] }));
  // clobber the header
  const db = path.join(dir, 'edict.db');
  const buf = fs.readFileSync(db);
  buf.write('this is not sqlite at all!', 0);
  fs.writeFileSync(db, buf);
  fs.writeFileSync(`${db}-wal`, 'stale wal'); // must be moved with it, never replayed into the new file

  const { lines, log } = capture();
  const s2 = openStateStore(dir, { log });
  const rep = s2.openReport!;
  assert.ok(rep.recoveredCorrupt && /edict\.db\.corrupt-\d+$/.test(rep.recoveredCorrupt));
  assert.ok(fs.existsSync(rep.recoveredCorrupt!));
  // the stale -wal is moved along with the db (or already consumed by SQLite's own failed open) — never replayed into the new file
  if (fs.existsSync(`${rep.recoveredCorrupt}-wal`)) assert.equal(fs.readFileSync(`${rep.recoveredCorrupt}-wal`, 'utf8'), 'stale wal');
  assert.ok(!fs.existsSync(`${db}-wal`) || !fs.readFileSync(`${db}-wal`).includes('stale wal'));
  assert.equal(rep.origin, 'import:backup');
  assert.equal(rep.imported!.from, 'backup-1.x-20261001-080000');
  assert.deepEqual(s2.loadState(), clone(fx.state));
  assert.deepEqual(s2.loadSettings(), clone(fx.settings));
  assert.ok(s2.integrityCheck(true).ok);
  assert.match(lines.join('\n'), /error: \[store\] edict\.db is corrupt .*moved aside to edict\.db\.corrupt-\d+/);
  assert.match(lines.join('\n'), /migrated backup-1\.x-20261001-080000 → edict\.db/);
  s2.close();
  // idempotent after recovery
  const s3 = openStateStore(dir, { log: () => {} });
  assert.equal(s3.openReport!.imported, undefined);
  assert.equal(s3.counts().tasks, 3);
  s3.close();
});

test('corrupt edict.db pages (header intact) are caught by quick_check; without a backup it starts empty', () => {
  const dir = tmp();
  const s = openStateStore(dir, { log: () => {} });
  s.upsertTasks(Array.from({ length: 300 }, (_, i) => legacyTask(i + 1)));
  s.close();
  const db = path.join(dir, 'edict.db');
  const fd = fs.openSync(db, 'r+');
  const size = fs.fstatSync(fd).size;
  fs.writeSync(fd, Buffer.alloc(4096 * 4, 0x5a), 0, 4096 * 4, Math.floor(size / 2 / 4096) * 4096);
  fs.closeSync(fd);
  const raw = SqliteStore.open(db); // opens fine: the damage is in the middle
  assert.equal(raw.integrityCheck().ok, false);
  raw.close();
  const { lines, log } = capture();
  const s2 = openStateStore(dir, { log });
  assert.ok(s2.openReport!.recoveredCorrupt);
  assert.equal(s2.openReport!.origin, 'fresh');
  assert.ok(s2.isEmpty());
  assert.match(lines.join('\n'), /no 1\.x backup to recover from/);
  s2.close();
  assert.equal(isCorruptError({ errcode: 26 }), true);
  assert.equal(isCorruptError({ errcode: 779 }), true, 'SQLITE_CORRUPT_INDEX');
  assert.equal(isCorruptError({ errcode: 5 }), false, 'SQLITE_BUSY is not corruption');
});

test('two stores on one db (e.g. two runtimes on one data dir) interleave safely', async () => {
  const dir = tmp();
  write1x(dir);
  const a = openStateStore(dir, { log: () => {}, debounceMs: 20 });
  const b = openStateStore(dir, { log: () => {}, debounceMs: 20 });
  assert.equal(b.openReport!.imported, undefined, 'the second open does not import again');
  const ma = model();
  ma.m.state = a.loadState();
  const mb = model();
  mb.m.state = b.loadState();
  a.bind(ma.source);
  b.bind(mb.source);
  for (let i = 0; i < 50; i++) {
    const ta = legacyTask(100 + i);
    const tb = legacyTask(200 + i);
    ma.m.state.tasks.push(ta);
    mb.m.state.tasks.push(tb);
    a.markDirty('tasks', ta.id);
    b.markDirty('tasks', tb.id);
    if (i % 10 === 0) {
      a.setKv(`a-${i}`, i); // direct writes interleaved with the other connection's write-behind
      b.setKv(`b-${i}`, i);
    }
    if (i % 7 === 0) await sleep(25);
  }
  // b deletes one of the shared rows; a never deletes rows it did not know about (b's tasks)
  mb.m.state.tasks = mb.m.state.tasks.filter((t) => t.id !== 't-2');
  b.markStateDirty();
  a.markStateDirty();
  await sleep(80);
  a.flush();
  b.flush();
  assert.ok(a.integrityCheck().ok && b.integrityCheck().ok);
  const seenByA = new Set(a.loadState().tasks.map((t) => t.id));
  assert.ok(seenByA.has('t-200') && seenByA.has('t-249') && seenByA.has('t-100'), 'a reads b\'s committed rows');
  a.checkpoint();
  a.close();
  b.close();
  const c = openStateStore(dir, { log: () => {} });
  const ids = c.loadState().tasks.map((t) => t.id);
  assert.equal(ids.length, new Set(ids).size, 'no duplicates');
  assert.equal(ids.length, 3 + 100 - 1);
  assert.ok(!ids.includes('t-2'));
  assert.equal(c.getKv('a-40'), 40);
  assert.equal(c.getKv('b-40'), 40);
  assert.equal(c.integrityCheck(true).ok, true);
  c.close();
});

function runChild(code: string, args: string[], env: Record<string, string> = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const dir = tmp('edict-sqlite-child-');
  const file = path.join(dir, 'child.ts');
  fs.writeFileSync(file, code);
  const childEnv: NodeJS.ProcessEnv = { ...process.env, ...env };
  delete childEnv.NODE_TEST_CONTEXT; // the child is a plain script, not a test-runner worker
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ['--import', 'tsx', file, ...args], { cwd: ROOT, env: childEnv });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => (stdout += d));
    p.stderr.on('data', (d) => (stderr += d));
    p.on('close', (c) => resolve({ code: c, stdout, stderr }));
  });
}

test('two processes racing on a 1.x data dir: exactly one import and one backup', async () => {
  const dir = tmp();
  write1x(dir);
  const code = `import { openStateStore } from ${JSON.stringify(STORE_MODULE)};
const until = Number(process.env.START_AT);
while (Date.now() < until) { /* line up both processes */ }
const s = openStateStore(process.argv[2], { log: () => {} });
console.log(JSON.stringify({ imported: !!s.openReport?.imported, counts: s.counts() }));
s.close();
`;
  const startAt = String(Date.now() + 2500);
  const rs = await Promise.all([runChild(code, [dir], { START_AT: startAt }), runChild(code, [dir], { START_AT: startAt })]);
  for (const r of rs) assert.equal(r.code, 0, r.stderr);
  const out = rs.map((r) => JSON.parse(r.stdout.trim().split('\n').pop()!));
  assert.equal(out.filter((o) => o.imported).length, 1);
  for (const o of out) assert.equal(o.counts.tasks, 3);
  assert.equal(backups(dir).length, 1);
  assert.ok(!fs.existsSync(path.join(dir, 'state.json')));
  const s = openStateStore(dir, { log: () => {} });
  assert.ok(s.integrityCheck(true).ok);
  s.close();
});

test('only the SQLite ExperimentalWarning is suppressed; other warnings still print', async () => {
  const dir = tmp();
  const r = await runChild(`import { openStateStore } from ${JSON.stringify(STORE_MODULE)};
openStateStore(process.argv[2], { log: () => {} }).close();
process.emitWarning('custom warning still shown', 'CustomWarning');
process.emitWarning('an experimental thing', 'ExperimentalWarning');
`, [dir]);
  assert.equal(r.code, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /SQLite is an experimental feature/);
  assert.match(r.stderr, /CustomWarning: custom warning still shown/);
  assert.match(r.stderr, /ExperimentalWarning: an experimental thing/);
});

test('close() flushes pending marks; marks after close are ignored (late async work after dispose)', () => {
  const dir = tmp();
  const s = openStateStore(dir, { log: () => {} });
  const { m, source } = model();
  s.bind(source);
  s.markStateDirty();
  s.markSettingsDirty();
  s.close();
  s.close(); // idempotent
  s.markDirty('tasks', 't-1');
  s.markStateDirty();
  assert.equal(s.stats().droppedAfterClose, 2);
  assert.deepEqual(s.flush(), { written: 0, deleted: 0, skipped: 0, ms: 0 });
  const s2 = openStateStore(dir, { log: () => {} });
  assert.deepEqual(s2.loadState(), clone(m.state));
  assert.deepEqual(s2.loadSettings(), clone(m.settings));
  s2.close();
});

test('size sanity: 2,000 tasks load fast and touching one task writes exactly one row', (t) => {
  const dir = tmp();
  const tasks = Array.from({ length: 2000 }, (_, i) => legacyTask(i + 1));
  const bytes = tasks.reduce((n, x) => n + JSON.stringify(x).length, 0);
  let t0 = performance.now();
  const s = openStateStore(dir, { log: () => {} });
  s.upsertTasks(tasks);
  s.transaction(() => {
    // what the runtime's first persist() writes on a fresh db
    s.setKv('totals', emptyUsage());
    s.setKv('seqByDay', {});
    s.setKv('agentStats', {});
    s.setKv('settings', defaultSettings());
    s.setKv('providers', []);
  });
  s.close();
  const insertMs = performance.now() - t0;

  t0 = performance.now();
  const s2 = openStateStore(dir, { log: () => {} });
  const openMs = performance.now() - t0;
  t0 = performance.now();
  const st = s2.loadState();
  const loadMs = performance.now() - t0;
  assert.equal(st.tasks.length, 2000);
  const live = { ...st };
  s2.bind({ state: () => live, settings: () => ({ settings: defaultSettings(), providers: [] }) });

  // Runtime.touch(task) → markDirty('tasks', id) + persist() → markStateDirty()
  const victim = st.tasks[1234];
  victim.nodes[0].status = 'failed';
  victim.updatedAt++;
  const changes0 = s2.totalChanges();
  const stats0 = s2.stats();
  s2.markDirty('tasks', victim.id);
  s2.markStateDirty();
  t0 = performance.now();
  const r = s2.flush();
  const flushMs = performance.now() - t0;
  assert.equal(r.written, 1);
  assert.equal(r.deleted, 0);
  assert.equal(s2.totalChanges() - changes0, 1, 'SQLite total_changes(): one row');
  assert.equal(s2.stats().rowsWritten - stats0.rowsWritten, 1);
  // a persist() with nothing new does not touch any of the 2,000 task rows
  const changes1 = s2.totalChanges();
  s2.markStateDirty();
  assert.equal(s2.flush().written, 0);
  assert.equal(s2.totalChanges(), changes1);
  // a full flush (shutdown) compares everything and still writes nothing new
  t0 = performance.now();
  assert.equal(s2.flush({ full: true }).written, 0);
  const fullMs = performance.now() - t0;
  const q = performance.now();
  assert.ok(s2.integrityCheck().ok);
  const quickMs = performance.now() - q;
  s2.close();
  const dbBytes = fs.statSync(path.join(dir, 'edict.db')).size;
  t.diagnostic(`2,000 tasks (${(bytes / 1e6).toFixed(1)} MB JSON, db ${(dbBytes / 1e6).toFixed(1)} MB): insert ${insertMs.toFixed(0)} ms, open+quick_check ${openMs.toFixed(0)} ms, load ${loadMs.toFixed(0)} ms, one-row flush ${flushMs.toFixed(1)} ms, full flush ${fullMs.toFixed(0)} ms, quick_check ${quickMs.toFixed(0)} ms`);
  assert.ok(flushMs < 250, `one-row flush took ${flushMs} ms`);
  assert.ok(loadMs < 10_000 && insertMs < 20_000, 'generous bounds: this is a sanity check, not a benchmark');
});
