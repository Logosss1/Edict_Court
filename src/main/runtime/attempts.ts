// 排班 (2.1): one subtask done by 2–3 lanes side by side, each in its own worktree branched from the edict
// worktree; 门下省 scores them, the emperor picks one (门下省 picks in 全自动) and only that lane's changes go in.
// This file: lookups and clean-up the runtime needs (no orchestration; that is attemptRun.ts).
import fs from 'node:fs';
import type { AttemptLane, EdictWorktree, RunNode, SubtaskAttempts, Task } from '../../shared/types';
import type { Runtime } from './runtime';
import * as git from '../services/worktree';
import { edictDir, serial, worktreesDir } from './worktrees';
import { now, truncate } from './util';
import path from 'node:path';

export const LANE_LABELS = ['甲', '乙', '丙'];
export const LANE_KEYS = ['a', 'b', 'c'];

/** The lane an exec node runs (it works in that lane's worktree), or undefined. */
export function laneOf(t: Task | undefined | null, node: RunNode | undefined | null): AttemptLane | undefined {
  if (!t?.attempts || !node?.laneId) return undefined;
  for (const a of t.attempts) for (const l of a.lanes) if (l.id === node.laneId) return l;
  return undefined;
}

/** The 排班 record a lane belongs to. */
export function attemptsOfLane(t: Task, laneId: string): { rec: SubtaskAttempts; lane: AttemptLane } | undefined {
  for (const rec of t.attempts ?? []) for (const lane of rec.lanes) if (lane.id === laneId) return { rec, lane };
  return undefined;
}

/**
 * Remove a lane's worktree directory. `keep`: commit what it changed to its branch first and keep the branch
 * (status kept); otherwise the branch goes too (status discarded). Never throws.
 */
export async function dropLaneTree(rt: Runtime, t: Task, lane: AttemptLane, keep = false): Promise<void> {
  const w = lane.worktree;
  if (!w || w.status !== 'active') return;
  const managed = path.resolve(w.path).startsWith(path.resolve(worktreesDir(rt)) + path.sep);
  await serial(rt, `repo:${w.repoRoot}`, async () => {
    try {
      if (keep && fs.existsSync(w.path)) {
        const c = await git.commitAll(w.path, `排班 ${lane.label}路（旨意 ${t.id}，未采用）`, w.links);
        if (c.commit) w.commit = c.commit;
      }
      git.unlinkDeps(w.path, w.links);
      rt.forgetWorkspace(edictDir(w));
      if (w.sub) rt.forgetWorkspace(w.path);
      if (fs.existsSync(w.path)) await git.removeWorktree(w.repoRoot, w.path, { force: true, managed });
      await git.prune(w.repoRoot);
      if (!keep) await git.deleteBranch(w.repoRoot, w.branch, true);
      w.status = keep ? 'kept' : 'discarded';
      w.finishedAt = now();
      rt.audit.record('system', keep ? 'attempt_lane_kept' : 'attempt_lane_removed', { lane: lane.id, branch: w.branch, path: w.path, commit: w.commit ?? null }, t.id);
    } catch (e) {
      w.error = (e as Error).message;
      rt.audit.record('system', 'attempt_lane_cleanup_failed', { lane: lane.id, path: w.path, error: truncate(w.error, 300) }, t.id);
    }
  });
  rt.touch(t);
}

/** Every lane worktree of the edict still on disk is removed (an edict that ended while its lanes were out). */
export async function dropLaneTrees(rt: Runtime, t: Task): Promise<void> {
  for (const rec of t.attempts ?? []) {
    const live = rec.lanes.filter((l) => l.worktree?.status === 'active');
    if (!live.length) continue;
    for (const l of live) await dropLaneTree(rt, t, l);
    if (rec.status === 'running' || rec.status === 'judging' || rec.status === 'choosing') {
      rec.status = 'failed';
      rec.error ??= '旨意已结束，各路工作树已清理';
    }
  }
  rt.touch(t);
}

/** The worktree record of a new lane (not yet on disk). */
export function laneTreeRecord(w: EdictWorktree, dir: string, branch: string, base: string): EdictWorktree {
  return { path: dir, branch, base, baseBranch: w.branch, repoRoot: w.repoRoot, sub: w.sub, status: 'active', createdAt: now() };
}
