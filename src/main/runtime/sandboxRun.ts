// 命令沙箱 (2.1), runtime side: the policy for one edict's commands, running a command inside it, and the
// card when the sandbox stops a command (run once without the sandbox / let this workspace write that folder /
// leave it failed). Release and deploy commands, which ask every time anyway, run outside the sandbox.
import path from 'node:path';
import fs from 'node:fs';
import type { SandboxSettings, Task } from '../../shared/types';
import type { Runtime } from './runtime';
import type { ToolContext } from './tools';
import { defaultSandboxSettings } from './defaults';
import { runCommand, type ExecResult } from '../services/exec';
import { buildProfile, detectDenial, expandHome, gitCommonDir, realish, sandboxBackend, tempDirs, type SandboxDenial, type SandboxPolicy } from '../services/sandbox';
import { classifyCommand } from './permissions';
import { agentName } from '../../shared/court';
import { truncate } from './util';
import { commandEnv } from './worktreeSetup';
import { laneOf } from './attempts';

export function sandboxSettingsOf(rt: Runtime): SandboxSettings {
  const s = rt.settings.sandbox as Partial<SandboxSettings> | undefined;
  const d = defaultSandboxSettings();
  const list = (v: unknown, dflt: string[]) => (Array.isArray(v) ? v.map(String).filter(Boolean) : dflt);
  return { enabled: s?.enabled ?? d.enabled, network: s?.network ?? d.network, writable: list(s?.writable, d.writable), caches: list(s?.caches, d.caches), denyRead: list(s?.denyRead, d.denyRead) };
}

export function sandboxStatus(rt: Runtime) {
  return { available: sandboxBackend().available(), platform: process.platform, settings: sandboxSettingsOf(rt) };
}

/** The policy for commands run in `root` for `task` (null: sandbox off, unavailable, or this command is exempt). */
export function sandboxPolicy(rt: Runtime, root: string, task?: Task): SandboxPolicy {
  const s = sandboxSettingsOf(rt);
  const permRoot = rt.permRoot(task);
  const perWs = (permRoot && rt.settings.workspacePerms?.[permRoot]?.sandboxWritable) || [];
  const common = gitCommonDir(root);
  return {
    writable: [root, ...(common ? [common] : []), ...tempDirs(), ...[...s.caches, ...s.writable, ...perWs].map((p) => expandHome(p))],
    // Edict's own data (keys, database, other edicts' worktrees) is never readable from a command
    denyRead: [...s.denyRead.map((p) => expandHome(p)), rt.opts.dataDir],
    allowRead: [root, ...(common ? [common] : [])],
    network: s.network,
  };
}

export const SANDBOX_KIND_LABEL: Record<SandboxDenial['kind'], string> = { write: '写入', read: '读取', network: '联网', unknown: '某个操作' };

/**
 * Run one official command, inside the sandbox when it applies. When the sandbox stops it, ask the emperor
 * (always, in every permission mode: it is the line the sandbox draws) and run it again if told to.
 */
export async function runOfficialCommand(ctx: ToolContext, cmd: string, root: string, timeoutMs: number): Promise<ExecResult & { sandboxNote?: string }> {
  const { rt, task, agentId, node } = ctx;
  const env = commandEnv(task, laneOf(task, node)?.worktree?.ports);
  const s = sandboxSettingsOf(rt);
  const exempt = classifyCommand(cmd).release;
  const usable = s.enabled && !exempt && sandboxBackend().available();
  if (s.enabled && !exempt && !usable) warnUnavailable(rt);
  if (!usable) return runCommand(cmd, root, { timeoutMs, signal: ctx.signal, env });
  let policy = sandboxPolicy(rt, root, task);
  let r = await runCommand(cmd, root, { timeoutMs, signal: ctx.signal, env, sandboxProfile: buildProfile(policy) });
  if (r.exitCode === 0 || r.timedOut || ctx.signal?.aborted) return r;
  const den = detectDenial(`${r.stdout}\n${r.stderr}`, policy);
  if (!den) return r;
  rt.audit.record(agentId, 'sandbox_denied', { command: truncate(cmd, 300), kind: den.kind, path: den.path ?? null }, task?.id);
  const dir = den.kind === 'write' && den.path ? folderOf(den.path) : null;
  const what = den.path ? `${SANDBOX_KIND_LABEL[den.kind]} ${den.path}` : den.kind === 'network' ? '联网（沙箱已关闭网络）' : '它要做的事';
  const d = await rt.requestDecision({
    kind: 'sandbox', taskId: task?.id, agentId, nodeId: node?.id, tool: 'run_command',
    summary: `${agentName(agentId)}的命令被沙箱拦下：${what}`,
    detail: JSON.stringify({ command: cmd, 输出: truncate(`${r.stderr || r.stdout}`.trim(), 600) }),
    risk: 'normal',
    reason: den.kind === 'unknown' ? '命令报了权限错误，可能是沙箱拦下的' : '命令沙箱只准写工作区、临时目录和包管理缓存，也不准读密钥目录',
    choices: [
      { id: 'rerun', label: '本次不受沙箱限制，重跑一次', hint: '命令会从头再执行一次', approve: true, tone: 'primary' },
      ...(dir && rt.permRoot(task) ? [{ id: 'allow_dir', label: `允许本工作区写 ${dir}，并重跑`, hint: '记在设置 › 权限与审批 › 命令沙箱', approve: true }] : []),
      { id: 'keep', label: '不用了，按失败处理', hint: '官员会换个做法', approve: false, comment: 'optional' as const },
    ],
  });
  if (!d.approve) return { ...r, sandboxNote: `（命令被沙箱拦下：${what}；皇上没有放行${d.comment ? `，批示：${d.comment}` : ''}。请换一种不需要${SANDBOX_KIND_LABEL[den.kind]}这里的做法。）` };
  if (d.choice === 'allow_dir' && dir) {
    addSandboxWritable(rt, rt.permRoot(task)!, dir, task, agentId);
    policy = sandboxPolicy(rt, root, task);
    r = await runCommand(cmd, root, { timeoutMs, signal: ctx.signal, env, sandboxProfile: buildProfile(policy) });
    return { ...r, sandboxNote: `（皇上准许本工作区写 ${dir}，已在沙箱里重跑）` };
  }
  rt.audit.record('emperor', 'sandbox_bypass', { command: truncate(cmd, 300) }, task?.id);
  r = await runCommand(cmd, root, { timeoutMs, signal: ctx.signal, env });
  return { ...r, sandboxNote: '（皇上准许这一次不受沙箱限制，已重跑）' };
}

function folderOf(p: string): string {
  try {
    if (fs.statSync(p).isDirectory()) return p;
  } catch {
    /* not there yet */
  }
  return path.dirname(p);
}

const warned = new WeakSet<Runtime>();
function warnUnavailable(rt: Runtime) {
  if (warned.has(rt)) return;
  warned.add(rt);
  rt.activity('log', process.platform === 'darwin' ? '命令沙箱不可用（系统的 sandbox-exec 无法运行），官员的命令暂时只靠审批把关。' : '命令沙箱只在 macOS 上可用；此处官员的命令只靠审批把关。', {});
}

/** Let commands in workspace `root` write `dir` (from the sandbox card or the settings page). */
export function addSandboxWritable(rt: Runtime, root: string, dir: string, task?: Task, agentId?: string) {
  const perms = { ...(rt.settings.workspacePerms ?? {}) };
  const cur = perms[root] ?? { rules: [] };
  const abs = realish(expandHome(dir));
  if ((cur.sandboxWritable ?? []).includes(abs)) return;
  perms[root] = { ...cur, sandboxWritable: [...(cur.sandboxWritable ?? []), abs] };
  rt.updateSettings({ workspacePerms: perms });
  rt.audit.record('emperor', 'sandbox_writable_added', { root, dir: abs, ...(agentId ? { agentId } : {}) }, task?.id);
}

export function removeSandboxWritable(rt: Runtime, root: string, dir: string) {
  const perms = { ...(rt.settings.workspacePerms ?? {}) };
  const cur = perms[root];
  if (!cur?.sandboxWritable?.includes(dir)) return;
  perms[root] = { ...cur, sandboxWritable: cur.sandboxWritable.filter((d) => d !== dir) };
  rt.updateSettings({ workspacePerms: perms });
  rt.audit.record('emperor', 'sandbox_writable_removed', { root, dir });
}

export function saveSandboxSettings(rt: Runtime, patch: Partial<SandboxSettings>) {
  const cur = sandboxSettingsOf(rt);
  const clean = (v: unknown) => (Array.isArray(v) ? [...new Set(v.map((x) => String(x).trim()).filter(Boolean))] : undefined);
  const next: SandboxSettings = {
    enabled: typeof patch.enabled === 'boolean' ? patch.enabled : cur.enabled,
    network: typeof patch.network === 'boolean' ? patch.network : cur.network,
    writable: clean(patch.writable) ?? cur.writable,
    caches: clean(patch.caches) ?? cur.caches,
    denyRead: clean(patch.denyRead) ?? cur.denyRead,
  };
  rt.updateSettings({ sandbox: next });
  rt.audit.record('emperor', 'sandbox_settings', { enabled: next.enabled, network: next.network, writable: next.writable.length, caches: next.caches.length, denyRead: next.denyRead.length });
  return sandboxStatus(rt);
}
