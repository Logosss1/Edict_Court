// 排班 (2.1): run one write subtask with 2–3 lanes side by side. Each lane works in its own worktree branched
// from a snapshot of the edict worktree; 门下省 scores the finished lanes; the emperor picks one on a card or on
// the 比试 page (门下省 picks in 全自动); the picked lane's changes are copied into the edict worktree and
// recorded like any change. The other lanes are discarded, or kept as branches when asked.
import type { AgentId, ApprovalChoice, AttemptLane, LaneSpec, ModelRef, RunNode, Subtask, SubtaskAttempts, Task } from '../../shared/types';
import { AGENT_MAP } from '../../shared/court';
import { TaskAbortedError, type Runtime } from './runtime';
import { runAgent } from './agentLoop';
import { extractJson, now, truncate, uid } from './util';
import { nodeConclusion } from './execPolicy';
import { ownedRequirementsText } from './requirements';
import * as git from '../services/worktree';
import { serial, worktreesDir } from './worktrees';
import { assignPorts, runWorktreeSetup, worktreeSetupOf } from './worktreeSetup';
import { LANE_KEYS, LANE_LABELS, attemptsOfLane, dropLaneTree, laneTreeRecord } from './attempts';
import { guestName } from '../guests/registry';
import fs from 'node:fs';
import path from 'node:path';
import { edictBlock } from './oral';

/** What the orchestrator lends (kept as callbacks so this file does not import it). */
export interface LaneHooks {
  ensureNode: (t: Task, id: string, init: Omit<RunNode, 'id' | 'status' | 'attempts'>) => RunNode;
  runNode: (rt: Runtime, t: Task, node: RunNode, fn: () => Promise<string>) => Promise<string>;
  /** the work of one exec node (official or guest), in the node's own workspace; returns its conclusion JSON */
  execBody: (node: RunNode) => Promise<string>;
}

const deptName = (d: string) => AGENT_MAP[d as AgentId]?.name ?? d;

/** Who does a lane, in words. */
export function laneWho(rt: Runtime, dept: string, spec: { executor: string; model?: ModelRef | null }): string {
  if (spec.executor && spec.executor !== 'self') return `客卿 ${guestName(rt, spec.executor)}`;
  return `${deptName(dept)}官员${spec.model?.model ? `（${spec.model.model}）` : ''}`;
}

/** The lanes this exec node runs, or why the subtask's 排班 is not used (then one lane does it as usual). */
export function lanesWanted(t: Task, node: RunNode, sub: Subtask): { lanes?: LaneSpec[]; why?: string } {
  const lanes = sub.lanes?.length && sub.lanes.length >= 2 ? sub.lanes.slice(0, 3) : null;
  if (!lanes || node.laneId || node.kind !== 'exec' || t.tier === 'solo') return {};
  // 返工 and 补办 rounds: the lane that was picked does it again (its executor became the subtask's)
  if (!node.id.endsWith('-r1')) return {};
  if ((node.effect ?? 'read') !== 'write') return { why: '只有写入类子任务才排班' };
  if (node.grant === 'readonly') return { why: '皇上命这个子任务只读执行' };
  if (t.worktree?.status !== 'active') return { why: '排班需要旨意自己的工作树（这个文件夹不是有提交记录的 git 仓库，或「每道旨意一个工作树」已关闭）' };
  return { lanes };
}

/** Rough extra cost of 排班: an Edict official's lane is one more exec run on its model; a guest bills its own account. */
export function estimateLanes(rt: Runtime, dept: string, lanes: LaneSpec[]): { lanes: { who: string; costUsd: number | null }[]; judgeUsd: number; totalUsd: number } {
  const run = (ref: ModelRef | null) => {
    if (!ref) return 0;
    let c = 0;
    for (let i = 0; i < 5; i++) c += rt.costOf(ref, { input: 900 + 1800 + 3000, output: 700, cached: Math.round(5700 * 0.3) });
    return c;
  };
  const resolve = (agent: AgentId, m?: ModelRef | null): ModelRef | null => {
    if (m) return m;
    try {
      return rt.resolveModel(agent);
    } catch {
      return null;
    }
  };
  const out = lanes.map((l) => ({ who: laneWho(rt, dept, l), costUsd: l.executor && l.executor !== 'self' ? null : +run(resolve(dept as AgentId, l.model)).toFixed(4) }));
  const jm = resolve('menxia');
  const judgeUsd = jm ? +rt.costOf(jm, { input: 9000, output: 800, cached: 0 }).toFixed(4) : 0;
  return { lanes: out, judgeUsd, totalUsd: +(out.reduce((s, l) => s + (l.costUsd ?? 0), 0) + judgeUsd).toFixed(4) };
}

/**
 * Do exec node `node` (subtask `sub`) with lanes. Runs inside the node's runNode; returns its conclusion JSON
 * (the picked lane's, with what 排班 did added to its system check). Throws when no lane made it or none was picked.
 */
export async function runAttempts(rt: Runtime, t: Task, node: RunNode, sub: Subtask, lanes: LaneSpec[], hooks: LaneHooks): Promise<string> {
  const signal = rt.signalFor(t.id, node.id);
  const act = { taskId: t.id, agentId: sub.dept, nodeId: node.id };
  t.attempts ??= [];
  // after a restart: lanes that all finished go straight on to 评比 / 选用; anything else starts over
  let rec = t.attempts.find((a) => a.nodeId === node.id && (a.status === 'running' || a.status === 'judging' || a.status === 'choosing'));
  if (rec && !(rec.status !== 'running' && rec.lanes.every((l) => l.tree || laneNode(t, l)?.status !== 'done'))) {
    for (const l of rec.lanes) await dropLaneTree(rt, t, l);
    rec.status = 'failed';
    rec.error = '没有办完就中断了（例如应用重启），重新排班';
    rec = undefined;
  }
  if (!rec) {
    rec = await startLanes(rt, t, node, sub, lanes, hooks);
    rt.activity('log', `排班：「${sub.title}」由 ${rec.lanes.length} 路同时办——${rec.lanes.map((l) => `${l.label}路 ${laneWho(rt, sub.dept, l)}`).join('、')}。各在自己的工作树里，从同一个起点出发，互不干扰`, act);
    await Promise.all(rec.lanes.map((l) => runLane(rt, t, rec!, l, hooks)));
    if (signal.aborted || rt.controllers.get(t.id)?.signal.aborted) throw new TaskAbortedError();
    for (const l of rec.lanes) await snapshotLane(rt, t, rec, l);
    rec.status = 'judging';
    rt.touch(t);
  }
  const ok = rec.lanes.filter((l) => laneOk(t, l));
  if (!ok.length) {
    rec.status = 'failed';
    rec.error = `各路都没办成：${rec.lanes.map((l) => `${l.label}路 ${truncate(laneNode(t, l)?.error ?? nodeConclusion(laneNode(t, l))?.summary ?? '失败', 120)}`).join('；')}`;
    for (const l of rec.lanes) await dropLaneTree(rt, t, l);
    rt.audit.record('system', 'attempts_failed', { attempts: rec.id, subtask: sub.id }, t.id);
    throw new Error(rec.error);
  }
  if (rec.status === 'judging') {
    if (ok.length === 1) {
      rec.recommended = ok[0].id;
      rec.judgeNote = `只有${ok[0].label}路办成，直接采用`;
    } else await judge(rt, t, rec, node, sub, ok, hooks);
    rec.status = 'choosing';
    rt.touch(t);
  }
  const pick = await choose(rt, t, rec, node, sub, ok);
  return apply(rt, t, rec, node, sub, pick);
}

const laneNode = (t: Task, l: AttemptLane) => t.nodes.find((n) => n.id === l.nodeId);
const laneOk = (t: Task, l: AttemptLane) => {
  const n = laneNode(t, l);
  return n?.status === 'done' && !!l.tree && nodeConclusion(n)?.status !== 'failed';
};

/** Snapshot the edict worktree, then one node, worktree, port block and setup run per lane. */
async function startLanes(rt: Runtime, t: Task, node: RunNode, sub: Subtask, lanes: LaneSpec[], hooks: LaneHooks): Promise<SubtaskAttempts> {
  const w = t.worktree!;
  const base = await serial(rt, `repo:${w.repoRoot}`, () => git.snapshotCommit(w.path, `Edict 旨意 ${t.id} · ${sub.id} 排班起点`, w.links));
  const rec: SubtaskAttempts = { id: uid('at'), subtaskId: sub.id, nodeId: node.id, round: t.execRound ?? 1, base, lanes: [], status: 'running', at: now() };
  t.attempts!.push(rec);
  const n = node.attempts > 1 ? String(node.attempts) : '';
  lanes.forEach((spec, k) => {
    const key = LANE_KEYS[k];
    const label = LANE_LABELS[k];
    const ln = hooks.ensureNode(t, `${node.id}-${key}${n}`, { kind: 'lane', agentId: sub.dept, label: `${node.label}（${label}路 · ${laneWho(rt, sub.dept, spec)}）`, subtaskId: sub.id, effect: 'write', laneId: `${rec.id}-${key}` });
    ln.grant = node.grant;
    ln.grantNote = node.grantNote;
    rec.lanes.push({ id: `${rec.id}-${key}`, label, executor: spec.executor || 'self', model: spec.model ?? null, nodeId: ln.id });
  });
  rt.audit.record('emperor', 'attempts_started', { attempts: rec.id, subtask: sub.id, base, lanes: rec.lanes.map((l) => ({ id: l.id, executor: l.executor, model: l.model?.model ?? null })) }, t.id);
  const setup = worktreeSetupOf(rt, rt.permRoot(t));
  for (const [k, lane] of rec.lanes.entries()) {
    const dir = path.join(worktreesDir(rt), path.basename(path.dirname(w.path)), `${path.basename(w.path)}-${sub.id}-${LANE_KEYS[k]}${n}`);
    let branch = `${w.branch}-${sub.id}-${LANE_KEYS[k]}${n}`;
    await serial(rt, `repo:${w.repoRoot}`, async () => {
      for (let i = 2; await git.branchExists(w.repoRoot, branch); i++) branch = `${w.branch}-${sub.id}-${LANE_KEYS[k]}${n}-${i}`;
      await git.addWorktree(w.repoRoot, dir, branch, base);
    });
    const lw = laneTreeRecord(w, dir, branch, base);
    if (setup.linkDeps) {
      const links = git.linkDeps(w.repoRoot, dir);
      if (w.sub) links.push(...git.linkDeps(path.join(w.repoRoot, w.sub), path.join(dir, w.sub)).map((x) => `${w.sub}/${x}`));
      if (links.length) lw.links = links;
    }
    lane.worktree = lw;
    await assignPorts(rt, lw);
    rt.touch(t);
    if ((setup.script || setup.copy.length) && t.workspace) await runWorktreeSetup(rt, t, lw, { mainDir: t.workspace, label: `${lane.label}路的工作树`, signal: rt.signalFor(t.id) });
  }
  return rec;
}

/** One lane's run: its node does the subtask in its own worktree. A failed lane is noted, not fatal. */
async function runLane(rt: Runtime, t: Task, rec: SubtaskAttempts, lane: AttemptLane, hooks: LaneHooks): Promise<void> {
  const n = laneNode(t, lane)!;
  try {
    await hooks.runNode(rt, t, n, () => hooks.execBody(n));
  } catch (e) {
    if (e instanceof TaskAbortedError) throw e;
    rt.activity('log', `${lane.label}路没有办成：${truncate(n.error ?? (e as Error).message, 200)}`, { taskId: t.id, agentId: n.agentId, nodeId: n.id });
  }
}

/** The lane's worktree as a tree, and its diff against the base (kept as a blob for 比试 and the 奏折). */
async function snapshotLane(rt: Runtime, t: Task, rec: SubtaskAttempts, lane: AttemptLane) {
  const w = lane.worktree;
  if (!w || w.status !== 'active' || !fs.existsSync(w.path)) return;
  try {
    lane.tree = await git.snapshotTree(w.path, w.links);
    const d = await git.treeDiffText(w.path, rec.base, lane.tree);
    lane.diff = { files: d.files, added: d.added, removed: d.removed };
    lane.diffHash = rt.blobs.put(Buffer.from(d.text || '（没有改动）'));
  } catch (e) {
    lane.tree = undefined;
    rt.activity('error', `${lane.label}路的改动没能读出：${(e as Error).message}`, { taskId: t.id, nodeId: lane.nodeId });
  }
  rt.touch(t);
}

const JUDGE_DIFF = 7000;

/** 门下省 scores the lanes that finished (0–100 each, with reasons) and recommends one. */
async function judge(rt: Runtime, t: Task, rec: SubtaskAttempts, node: RunNode, sub: Subtask, ok: AttemptLane[], hooks: LaneHooks) {
  const jn = hooks.ensureNode(t, `judge-${node.id}${node.attempts > 1 ? `-${node.attempts}` : ''}`, { kind: 'judge', agentId: 'menxia', label: `门下评比·${sub.title}` });
  rec.judgeNodeId = jn.id;
  const lanesText = ok.map((l) => {
    const n = laneNode(t, l)!;
    const c = nodeConclusion(n);
    const diff = l.diffHash ? rt.blobs.get(l.diffHash)?.toString('utf8') ?? '' : '';
    return [
      `### ${l.label}路（${laneWho(rt, sub.dept, l)}）`,
      `结论：${c ? JSON.stringify({ status: c.status, summary: c.summary, artifacts: c.artifacts, verification: c.verification, issues: c.issues }) : truncate(n.output ?? '无', 1500)}`,
      c?.systemCheck?.length ? `系统核验：${c.systemCheck.join('；')}` : '',
      `改动：${l.diff ? `${l.diff.files} 个文件，+${l.diff.added} −${l.diff.removed}` : '未知'}`,
      `差异（节选）：\n${truncate(diff, JUDGE_DIFF)}`,
    ].filter(Boolean).join('\n');
  });
  try {
    const out = await hooks.runNode(rt, t, jn, async () => {
      const r = await runAgent({
        rt, agentId: 'menxia', task: t, node: jn, maxTokens: 2000, temperature: 0.1, label: jn.label,
        prompt: [
          `【比试】子任务「${sub.title}」由 ${ok.length} 路分别完成，请你评比。`,
          edictBlock(t, 2000),
          `【子任务 ${sub.id}】${sub.title}\n做法：${sub.detail}\n验收标准：${sub.acceptance}`,
          t.plan ? ownedRequirementsText(t.plan, sub) : '',
          `【各路成果】\n${lanesText.join('\n\n')}`,
          `请按验收标准、需求、实际改动和验证结果给每一路打分（0–100），各写一句理由，再选出最该采用的一路。只看成果，不看是谁办的。只输出 JSON：{"scores":[{"lane":"${ok[0].label}","score":80,"comment":"理由"}],"pick":"${ok[0].label}","note":"一句话说明为什么选它"}`,
        ].filter(Boolean).join('\n\n'),
      });
      return r.text;
    });
    const j = extractJson<{ scores?: { lane?: string; score?: number; comment?: string }[]; pick?: string; note?: string }>(out);
    for (const s of j?.scores ?? []) {
      const l = ok.find((x) => x.label === String(s.lane ?? '').replace(/路$/, ''));
      if (!l) continue;
      l.score = Math.max(0, Math.min(100, Math.round(Number(s.score) || 0)));
      l.comment = truncate(String(s.comment ?? ''), 300);
    }
    const picked = ok.find((x) => x.label === String(j?.pick ?? '').replace(/路$/, '')) ?? [...ok].sort((a, b) => (b.score ?? -1) - (a.score ?? -1))[0];
    rec.recommended = picked.id;
    rec.judgeNote = truncate(String(j?.note ?? '') || (j ? `${picked.label}路得分最高` : '门下省没有按格式给出评比，默认推荐第一路'), 400);
  } catch (e) {
    if (e instanceof TaskAbortedError) throw e;
    rec.recommended = ok[0].id;
    rec.judgeNote = `门下省评比没有完成（${truncate((e as Error).message, 160)}），默认推荐${ok[0].label}路`;
  }
  rt.audit.record('menxia', 'attempts_judged', { attempts: rec.id, scores: ok.map((l) => ({ lane: l.label, score: l.score ?? null })), recommended: rec.recommended, note: rec.judgeNote }, t.id);
  rt.activity('log', `门下评比「${sub.title}」：${ok.map((l) => `${l.label}路 ${l.score ?? '—'} 分`).join('，')}；推荐${ok.find((l) => l.id === rec.recommended)?.label}路。${rec.judgeNote}`, { taskId: t.id, agentId: 'menxia', nodeId: node.id });
  rt.touch(t);
}

/** The lane to use: 门下省's in 全自动 (or when only one made it), else the emperor's on a card / the 比试 page. */
async function choose(rt: Runtime, t: Task, rec: SubtaskAttempts, node: RunNode, sub: Subtask, ok: AttemptLane[]): Promise<AttemptLane> {
  const rec0 = ok.find((l) => l.id === rec.recommended) ?? ok[0];
  const auto = rt.modeFor(t) === 'auto' || t.schedule?.permission === 'worktree';
  if (ok.length === 1 || auto) {
    rec.pickedBy = 'menxia';
    rt.activity('log', ok.length === 1 ? `只有${rec0.label}路办成，采用它` : `全自动模式：按门下省推荐采用${rec0.label}路（落选各路的改动可在「比试」里查看）`, { taskId: t.id, agentId: 'menxia', nodeId: node.id });
    return rec0;
  }
  const line = (l: AttemptLane) => {
    const n = laneNode(t, l);
    const secs = n?.startedAt && n.endedAt ? Math.round((n.endedAt - n.startedAt) / 1000) : null;
    return `${l.label}路 · ${laneWho(rt, sub.dept, l)}：${l.score !== undefined ? `${l.score} 分` : '未评分'} · ${l.diff ? `${l.diff.files} 个文件 +${l.diff.added} −${l.diff.removed}` : ''}${secs !== null ? ` · ${secs} 秒` : ''}${n?.usage?.costUsd ? ` · $${n.usage.costUsd.toFixed(4)}` : ''}${l.comment ? `\n  ${l.comment}` : ''}`;
  };
  const failed = rec.lanes.filter((l) => !ok.includes(l));
  const choices: ApprovalChoice[] = [
    ...ok.map((l): ApprovalChoice => ({ id: l.id, label: `采用${l.label}路${l.id === rec0.id ? '（门下推荐）' : ''}`, hint: `${laneWho(rt, sub.dept, l)}${l.score !== undefined ? ` · ${l.score} 分` : ''}${l.comment ? `：${l.comment}` : ''}`, approve: true, tone: l.id === rec0.id ? 'primary' : 'default' })),
    { id: 'none', label: '都不用', hint: '这个子任务记为失败，可以局部重试（重新排班）', approve: false, tone: 'danger' },
  ];
  const d = await rt.requestDecision({
    kind: 'attempt', taskId: t.id, agentId: 'menxia', nodeId: node.id, tool: `attempt:${rec.id}`,
    summary: `「${sub.title}」${ok.length} 路都办完了，请选一路采用`,
    detail: [...ok.map(line), ...failed.map((l) => `${l.label}路 · ${laneWho(rt, sub.dept, l)}：没有办成`)].join('\n'),
    risk: 'normal',
    reason: `门下省推荐${rec0.label}路：${rec.judgeNote ?? ''}。各路的改动可在旨意详情的「比试」里并排查看。`,
    choices,
  });
  if (aborted(rt, t)) throw new TaskAbortedError();
  const picked = d.approve ? ok.find((l) => l.id === d.choice) : undefined;
  if (!picked) {
    rec.status = 'failed';
    rec.error = `皇上没有采用任何一路${d.comment ? `：${d.comment}` : ''}`;
    rt.audit.record('emperor', 'attempts_none', { attempts: rec.id, comment: d.comment ?? null }, t.id);
    for (const l of rec.lanes) await dropLaneTree(rt, t, l);
    throw new Error(rec.error);
  }
  rec.pickedBy = 'emperor';
  return picked;
}

const aborted = (rt: Runtime, t: Task) => t.state === 'Cancelled' || !!rt.controllers.get(t.id)?.signal.aborted;

const same = (a: Buffer | null, b: Buffer | null) => (a === null || b === null ? a === b : a.equals(b));

/** Copy the picked lane's changes into the edict worktree (3-way merge where the edict changed a file meanwhile). */
async function apply(rt: Runtime, t: Task, rec: SubtaskAttempts, node: RunNode, sub: Subtask, lane: AttemptLane): Promise<string> {
  const w = t.worktree!;
  const ws = rt.workspaceFor(t);
  if (!ws || !lane.tree) throw new Error('旨意的工作树不可用，没法合入选中的一路');
  await rt.acquireWriteLock(t.id, node.id, rt.signalFor(t.id, node.id));
  const agentId = sub.dept as AgentId;
  const conflicts: string[] = [];
  const applied: string[] = [];
  const changes = await git.treeChanges(w.path, rec.base, lane.tree);
  for (const c of changes) {
    const rel = w.sub ? (c.path.startsWith(`${w.sub}/`) ? c.path.slice(w.sub.length + 1) : null) : c.path;
    if (!rel) continue;
    try {
      const theirs = c.status === 'D' ? null : await git.blobAt(w.path, lane.tree, c.path);
      const base = c.status === 'A' ? null : await git.blobAt(w.path, rec.base, c.path);
      const cur = ws.readBuffer(rel);
      let next = theirs;
      if (!same(cur, base)) {
        // the edict worktree changed this file after the lanes started (another subtask)
        if (same(cur, theirs)) continue;
        const m = cur && base && theirs && !cur.includes(0) && !theirs.includes(0) ? await git.mergeThree(cur, base, theirs) : null;
        if (!m?.ok) {
          conflicts.push(rel);
          continue;
        }
        next = m.out;
      }
      if (next === null) ws.remove(rel);
      else ws.write(rel, next);
      rt.recordChange(t, agentId, node.id, rel, cur, next);
      applied.push(rel);
    } catch (e) {
      conflicts.push(`${rel}（${truncate((e as Error).message, 80)}）`);
    }
  }
  rec.pick = lane.id;
  rec.conflicts = conflicts.length ? conflicts : undefined;
  rec.keptOthers = !!rec.keepOthersRequested && rec.lanes.some((l) => l.id !== lane.id && l.worktree?.status === 'active');
  rec.status = 'applied';
  rt.audit.record(rec.pickedBy === 'emperor' ? 'emperor' : 'menxia', 'attempt_picked', { attempts: rec.id, lane: lane.id, label: lane.label, executor: lane.executor, model: lane.model?.model ?? null, files: applied, conflicts, keptOthers: rec.keptOthers }, t.id);
  rt.activity(rec.pickedBy === 'emperor' ? 'human' : 'log', `${rec.pickedBy === 'emperor' ? '皇上' : '门下省'}采用${lane.label}路（${laneWho(rt, sub.dept, lane)}）：${applied.length} 个文件合入旨意工作树${conflicts.length ? `；${conflicts.length} 个文件与其他子任务的改动冲突，保留了旨意里的版本：${conflicts.join('、')}` : ''}${rec.keptOthers ? '；落选各路保留为分支' : ''}`, { taskId: t.id, agentId, nodeId: node.id });
  // 返工 of this subtask goes to the lane that won
  if (sub.executor !== lane.executor && (lane.executor !== 'self' || sub.executor)) {
    sub.executor = lane.executor;
    rt.activity('log', `之后「${sub.title}」若要返工，由${laneWho(rt, sub.dept, { executor: lane.executor })}办`, { taskId: t.id, nodeId: node.id });
  }
  for (const l of rec.lanes) await dropLaneTree(rt, t, l, rec.keptOthers && l.id !== lane.id);
  rt.touch(t);
  const n = laneNode(t, lane)!;
  const c = nodeConclusion(n);
  const others = rec.lanes.filter((l) => l.id !== lane.id).map((l) => `${l.label}路 ${l.score !== undefined ? `${l.score} 分` : laneOk(t, l) ? '未评分' : '未办成'}`);
  const systemCheck = [
    `排班 ${rec.lanes.length} 路，采用${lane.label}路（${laneWho(rt, sub.dept, lane)}，${rec.pickedBy === 'emperor' ? '皇上选定' : '门下省推荐'}${lane.score !== undefined ? `，${lane.score} 分` : ''}）；${others.join('，')}`,
    `合入旨意工作树的改动：${applied.length ? applied.join(', ') : '无'}`,
    ...(conflicts.length ? [`与其他子任务冲突、没有合入：${conflicts.join(', ')}`] : []),
    ...(c?.systemCheck ?? []),
  ];
  const base = c ?? { status: 'done' as const, summary: `${lane.label}路完成`, artifacts: [], verification: '未验证', issues: [] };
  const { systemCheck: _old, ...plain } = base as typeof base & { systemCheck?: string[] };
  return JSON.stringify({ ...plain, ...(conflicts.length ? { status: 'partial', issues: [...plain.issues, `排班合入时 ${conflicts.length} 个文件冲突：${conflicts.join('、')}`] } : {}), systemCheck });
}

// ───────────────────────── 比试 page ─────────────────────────
/** Pick a lane from the 比试 page (answers the pending card); `keepOthers` keeps the other lanes as branches. */
export function chooseAttempt(rt: Runtime, taskId: string, laneId: string | null, o: { keepOthers?: boolean; attemptsId?: string; comment?: string } = {}) {
  const t = rt.getTask(taskId);
  const found = laneId ? attemptsOfLane(t, laneId) : undefined;
  const rec = found?.rec ?? t.attempts?.find((a) => a.id === o.attemptsId);
  if (!rec) throw new Error('没有这个排班');
  if (rec.status !== 'choosing') throw new Error(rec.status === 'applied' ? '这次排班已经选定了' : '各路还没办完，现在还不能选');
  const ap = [...rt.approvals.values()].find((a) => a.status === 'pending' && a.kind === 'attempt' && a.taskId === taskId && a.tool === `attempt:${rec.id}`);
  if (!ap) throw new Error('没有待选的比试卡');
  rec.keepOthersRequested = !!o.keepOthers;
  if (laneId) rt.decideApproval(ap.id, true, 'emperor', laneId, o.comment);
  else rt.decideApproval(ap.id, false, 'emperor', 'none', o.comment);
}

/** One lane's diff text against the base (kept after its worktree is gone). */
export function attemptDiff(rt: Runtime, taskId: string, laneId: string): string {
  const t = rt.getTask(taskId);
  const f = attemptsOfLane(t, laneId);
  if (!f) throw new Error('没有这一路');
  return f.lane.diffHash ? rt.blobs.get(f.lane.diffHash)?.toString('utf8') ?? '（差异已不在本机）' : '（这一路还没有办完）';
}
