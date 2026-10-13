// 客卿 (2.1): who does an exec node (a guest or the ministry's own official), the guest's run with fallback to the
// ministry when it cannot start, the check after a read-only subtask, and the settings page's connection test.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentId, GuestTestResult, RunNode, Subtask, Task } from '../../shared/types';
import type { Runtime } from '../runtime/runtime';
import { TaskAbortedError } from '../runtime/runtime';
import { AGENT_MAP } from '../../shared/court';
import { parseConclusion } from '../runtime/execPolicy';
import { EXEC_OUTPUT_RULE } from '../runtime/souls';
import { laneOf } from '../runtime/attempts';
import { truncate } from '../runtime/util';
import { RpcError } from '../acp/connection';
import { GuestStartError, startGuest } from './client';
import { executorOf, guestLaunch, guestName, guestStatus, type GuestLaunch } from './registry';
import { runGuest } from './run';

export { guestStatuses, saveGuest, removeGuest, setGuestDefaults, guestSettingsOf, executorOf, guestName } from './registry';

const deptName = (id: string) => AGENT_MAP[id as AgentId]?.name ?? id;

/** Who does this exec node: a guest (launch details) or the ministry itself; `fallback` says why a chosen guest cannot. */
export function pickGuest(rt: Runtime, t: Task, node: RunNode, sub: Subtask): { launch?: GuestLaunch; fallback?: string } {
  const id = node.laneId ? (laneOf(t, node)?.executor === 'self' ? null : (laneOf(t, node)?.executor ?? null)) : executorOf(rt, sub);
  if (!id) return {};
  const name = guestName(rt, id);
  const tree = node.laneId ? laneOf(t, node)?.worktree : t.worktree;
  if (tree?.status !== 'active' || !rt.workspaceFor(t, node)) {
    const why = t.tier === 'solo' ? 'Solo 不建工作树' : !t.workspace ? '本旨意没有工作区' : rt.settings.worktreePerEdict === false ? '「每道旨意一个工作树」已关闭' : '这个文件夹不是有提交记录的 git 仓库';
    return { fallback: `客卿 ${name} 只在旨意自己的工作树里办差（${why}），改由${deptName(sub.dept)}自己办` };
  }
  const l = guestLaunch(rt, id);
  if ('error' in l) return { fallback: `${l.error}，改由${deptName(sub.dept)}自己办` };
  return { launch: l };
}

/** The guest's brief: who it stands in for, where it works, what not to do, and the conclusion format. */
export function guestPrompt(dept: string, launchName: string, parts: string[]): string {
  return [
    `你是 Edict（三省六部）请来的客卿 ${launchName}，替${deptName(dept)}办下面这个子任务。当前目录就是本旨意自己的 git 工作树：只在这里面读写文件、执行命令。不要 git commit、push、发版或部署，提交与合并由皇上在结案时决定。`,
    ...parts,
    EXEC_OUTPUT_RULE,
  ].filter(Boolean).join('\n\n');
}

/**
 * Do one exec node with a guest. Returns null when the guest never got going (the caller lets the ministry do it);
 * throws when it failed after it had started changing things (the node fails, it can be retried).
 */
export async function execWithGuest(rt: Runtime, t: Task, node: RunNode, sub: Subtask, launch: GuestLaunch, prompt: string): Promise<{ text: string; toolCounts: Record<string, number> } | null> {
  const agentId = sub.dept as AgentId;
  node.guest = { id: launch.id, name: launch.name };
  rt.touch(t);
  try {
    const r = await runGuest({
      rt, task: t, node, agentId, launch, prompt,
      repairPrompt: `请只输出结构化结论，不要再改文件或执行命令。\n${EXEC_OUTPUT_RULE}`,
      isStructured: (x) => parseConclusion(x).structured,
      signal: rt.signalFor(t.id, node.id),
    });
    if (r.direct.length) await afterReadonly(rt, t, node, launch, r.direct.map((c) => c.id));
    return { text: r.text, toolCounts: r.toolCounts };
  } catch (e) {
    if (e instanceof TaskAbortedError) throw e;
    const touched = rt.changesFor(t, node).some((c) => c.nodeId === node.id && !c.reverted);
    const msg = e instanceof GuestStartError ? e.message : (e as Error)?.message ?? String(e);
    if (e instanceof GuestStartError || !touched) {
      const login = e instanceof GuestStartError && e.needsLogin ? `（看起来还没登录：${guestStatus(rt, launch.id)?.loginHint ?? '请先在终端登录一次'}）` : '';
      rt.audit.record('system', 'guest_fallback', { guest: launch.id, node: node.id, error: truncate(msg, 400), login: !!login }, t.id);
      rt.activity('error', `客卿 ${launch.name} 没能接手「${node.label}」：${truncate(msg, 300)}${login}。这个子任务退回${deptName(sub.dept)}自己办`, { taskId: t.id, agentId, nodeId: node.id });
      rt.toast('warn', `客卿 ${launch.name} 没能接手，已退回${deptName(sub.dept)}：${truncate(msg, 120)}`);
      node.guest = undefined;
      rt.touch(t);
      return null;
    }
    throw new Error(`客卿 ${launch.name} 办差中断：${truncate(msg, 400)}`);
  }
}

/** A subtask marked read-only, yet the guest changed files with its own tools: the emperor keeps or reverts them. */
async function afterReadonly(rt: Runtime, t: Task, node: RunNode, launch: GuestLaunch, ids: string[]) {
  const readOnly = node.grant === 'readonly' || ((node.effect ?? 'read') === 'read' && !node.grant);
  if (!readOnly) return;
  const files = t.changes.filter((c) => ids.includes(c.id)).map((c) => c.path);
  const revert = () => {
    let n = 0;
    for (const id of ids) {
      try {
        rt.revertChange(t.id, id, true);
        n++;
      } catch {
        /* oversize or lost: listed in the activity below */
      }
    }
    rt.activity('human', `已撤回客卿 ${launch.name} 在只读子任务里改的 ${n} 个文件${n < ids.length ? `（${ids.length - n} 个无法撤回）` : ''}`, { taskId: t.id, agentId: node.agentId, nodeId: node.id });
  };
  if (t.schedule?.permission === 'readonly') return revert();
  if (rt.modeFor(t) === 'auto') {
    rt.activity('log', `⚠ 客卿 ${launch.name} 在只读子任务里改了 ${files.length} 个文件（全自动模式，先保留，可在改动列表里撤回）`, { taskId: t.id, agentId: node.agentId, nodeId: node.id });
    return;
  }
  const d = await rt.requestDecision({
    kind: 'guest', taskId: t.id, agentId: node.agentId, nodeId: node.id, tool: 'guest',
    summary: `客卿 ${launch.name} 在只读子任务里改了 ${files.length} 个文件`,
    detail: files.slice(0, 30).join('\n') + (files.length > 30 ? `\n…共 ${files.length} 个` : ''),
    risk: 'normal',
    reason: `「${node.label}」按只读子任务开工，客卿却用它自带的工具改了文件（没有经过 Edict 的审批）。`,
    choices: [
      { id: 'revert', label: '撤回这些改动', hint: '文件恢复到客卿动手之前', approve: true, tone: 'primary' },
      { id: 'keep', label: '保留', hint: '改动留在工作树里，结案时一起处理', approve: true },
    ],
  });
  if (d.choice === 'keep') {
    rt.audit.record('emperor', 'guest_readonly_kept', { guest: launch.id, files }, t.id);
    rt.activity('human', `保留客卿 ${launch.name} 改的 ${files.length} 个文件`, { taskId: t.id, agentId: node.agentId, nodeId: node.id });
  } else {
    rt.audit.record('emperor', 'guest_readonly_reverted', { guest: launch.id, files }, t.id);
    revert();
  }
}

/** Settings page: start the guest in an empty temp folder, handshake, open a session, close. */
export async function testGuest(rt: Runtime, id: string): Promise<GuestTestResult> {
  const started = Date.now();
  const l = guestLaunch(rt, id);
  if ('error' in l) return { ok: false, message: l.error, ms: 0 };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'edict-guest-test-'));
  let proc: Awaited<ReturnType<typeof startGuest>>['proc'] | undefined;
  try {
    const s = await startGuest({ exe: l.exe, args: l.args, alt: l.alt, cwd: dir, version: rt.opts.version, onRequest: (m) => Promise.reject(RpcError.methodNotFound(m)) });
    proc = s.proc;
    const info = s.init.agentInfo;
    await proc.newSession(dir);
    const r: GuestTestResult = { ok: true, message: `连接成功${info ? `：${info.title ?? info.name} ${info.version}` : ''}`, agentName: info?.title ?? info?.name, agentVersion: info?.version, ms: Date.now() - started };
    rt.audit.record('emperor', 'guest_test', { id, ok: true, agent: r.agentName ?? null, version: r.agentVersion ?? null });
    return r;
  } catch (e) {
    const needsLogin = e instanceof GuestStartError && e.needsLogin;
    const hint = guestStatus(rt, id)?.loginHint;
    const r: GuestTestResult = { ok: false, needsLogin, message: needsLogin ? `${l.name} 还没登录${hint ? `：${hint}` : ''}（${truncate((e as Error).message, 200)}）` : truncate((e as Error).message, 600), ms: Date.now() - started };
    rt.audit.record('emperor', 'guest_test', { id, ok: false, needsLogin, error: truncate((e as Error).message, 300) });
    return r;
  } finally {
    await proc?.close(300).catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
