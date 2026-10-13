// 工作树准备 (2.1): every new edict worktree can get untracked files copied from the main folder (.env …) and a
// setup script run in it (npm ci …), and each one gets a block of ports to itself so edicts that start dev
// servers side by side do not fight over :3000. Officials see the ports as EDICT_PORT / EDICT_PORT_RANGE.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import type { EdictWorktree, PortBlock, Task, WorktreeSetup, WorktreeSetupRun } from '../../shared/types';
import type { Runtime } from './runtime';
import { runCommand } from '../services/exec';
import { now, truncate } from './util';

export const PORT_BLOCK = 10;
const MAX_SLOTS = 100;

export function defaultWorktreeSetup(): WorktreeSetup {
  return { script: '', copy: [], linkDeps: true, timeoutMin: 10 };
}

/** The 工作树准备 of workspace `root` (keyed like the 本工作区 rules: the main folder an edict was submitted on). */
export function worktreeSetupOf(rt: Runtime, root: string | null | undefined): WorktreeSetup {
  const s = (root && rt.settings.workspacePerms?.[root]?.worktreeSetup) as Partial<WorktreeSetup> | undefined;
  const d = defaultWorktreeSetup();
  return {
    script: typeof s?.script === 'string' ? s.script : d.script,
    copy: Array.isArray(s?.copy) ? s.copy.map(String).filter(Boolean) : d.copy,
    linkDeps: s?.linkDeps ?? d.linkDeps,
    timeoutMin: Number.isFinite(s?.timeoutMin) && s!.timeoutMin! > 0 ? Math.min(120, s!.timeoutMin!) : d.timeoutMin,
  };
}

/** A copy entry must stay inside the folder: relative, no `..`, wildcards only in the last part. */
export function copyEntryProblem(entry: string): string | null {
  const e = entry.trim().replace(/\\/g, '/');
  if (!e) return '不能为空';
  if (path.isAbsolute(e) || /^~/.test(e)) return `${entry}：请写相对主工作区的路径`;
  const parts = e.split('/').filter(Boolean);
  if (parts.some((p) => p === '..' || p === '.')) return `${entry}：不能含 .. 或 .`;
  if (parts.slice(0, -1).some((p) => /[*?]/.test(p))) return `${entry}：通配符只能用在最后一段`;
  if (parts[0] === '.git') return `${entry}：不能复制 .git`;
  return null;
}

export function saveWorktreeSetup(rt: Runtime, root: string, patch: Partial<WorktreeSetup>): WorktreeSetup {
  if (!root) throw new Error('请先打开工作区');
  const cur = worktreeSetupOf(rt, root);
  const copy = Array.isArray(patch.copy) ? [...new Set(patch.copy.map((c) => String(c).trim().replace(/\\/g, '/')).filter(Boolean))] : cur.copy;
  const bad = copy.map(copyEntryProblem).find(Boolean);
  if (bad) throw new Error(`要复制的文件：${bad}`);
  const timeout = patch.timeoutMin === undefined ? cur.timeoutMin : Math.round(Number(patch.timeoutMin));
  if (!Number.isFinite(timeout) || timeout < 1 || timeout > 120) throw new Error('脚本时限要在 1～120 分钟之间');
  const next: WorktreeSetup = {
    script: typeof patch.script === 'string' ? patch.script.replace(/\r\n/g, '\n').trim() : cur.script,
    copy,
    linkDeps: typeof patch.linkDeps === 'boolean' ? patch.linkDeps : cur.linkDeps,
    timeoutMin: timeout,
  };
  const perms = { ...(rt.settings.workspacePerms ?? {}) };
  perms[root] = { ...perms[root], rules: perms[root]?.rules ?? [], worktreeSetup: next };
  rt.updateSettings({ workspacePerms: perms });
  rt.audit.record('emperor', 'worktree_setup_settings', { root, script: !!next.script, scriptChars: next.script.length, copy: next.copy, linkDeps: next.linkDeps, timeoutMin: next.timeoutMin });
  return next;
}

// ───────────────────────── ports ─────────────────────────
/** Port blocks held by live work: edict worktrees and (2.1) the extra worktrees of multi-attempt lanes. */
export function portsInUse(rt: Runtime, except?: PortBlock): PortBlock[] {
  const out: PortBlock[] = [];
  for (const t of rt.tasks.values()) {
    if (t.worktree?.status === 'active' && t.worktree.ports) out.push(t.worktree.ports);
    for (const a of t.attempts ?? []) for (const l of a.lanes) if (l.worktree?.status === 'active' && l.worktree.ports) out.push(l.worktree.ports);
  }
  return except ? out.filter((b) => b !== except) : out;
}

const portFree = (port: number) =>
  new Promise<boolean>((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen({ port, host: '127.0.0.1', exclusive: true }, () => s.close(() => resolve(true)));
  });

/** The lowest block of PORT_BLOCK ports from the base that no live worktree holds and whose first port is free. */
export async function allocPorts(rt: Runtime): Promise<PortBlock | undefined> {
  const base = Math.max(1024, Math.min(65000, Math.round(Number(rt.settings.worktreePortBase) || 42000)));
  const taken = new Set(portsInUse(rt).map((b) => b.from));
  for (let i = 0; i < MAX_SLOTS; i++) {
    const from = base + i * PORT_BLOCK;
    if (from + PORT_BLOCK - 1 > 65535) break;
    if (taken.has(from)) continue;
    if (!(await portFree(from))) continue;
    return { from, to: from + PORT_BLOCK - 1 };
  }
  return undefined;
}

// one allocation at a time across all repositories, so two new worktrees never get the same block
const portLocks = new WeakMap<Runtime, Promise<unknown>>();
/** Give worktree `w` (already attached to its edict or lane) a port block of its own. */
export function assignPorts(rt: Runtime, w: EdictWorktree): Promise<void> {
  const run = (portLocks.get(rt) ?? Promise.resolve()).then(async () => {
    if (!w.ports) w.ports = await allocPorts(rt);
  });
  portLocks.set(rt, run.catch(() => undefined));
  return run.catch(() => undefined);
}

export const portEnv = (p?: PortBlock): Record<string, string> => (p ? { EDICT_PORT: String(p.from), EDICT_PORT_RANGE: `${p.from}-${p.to}` } : {});

/** Env for an official's command in this edict (its worktree's ports; a lane's own when `lane` is given). */
export function commandEnv(t: Task | undefined, lanePorts?: PortBlock): Record<string, string> {
  return portEnv(lanePorts ?? (t?.worktree?.status === 'active' ? t.worktree.ports : undefined));
}

/** The prompt line about ports and the setup, for officials working in a worktree. */
export function worktreeNote(w: EdictWorktree | undefined): string {
  if (!w || w.status !== 'active') return '';
  const lines: string[] = [];
  if (w.ports) lines.push(`本旨意独占端口 ${w.ports.from}–${w.ports.to}，命令里可用环境变量 $EDICT_PORT（=${w.ports.from}）和 $EDICT_PORT_RANGE。起开发服务器、测试服务时请用这些端口（例如 PORT=$EDICT_PORT npm run dev，或 --port $EDICT_PORT），不要用 3000、5173 等默认端口，免得和其他旨意抢。`);
  const s = w.setup;
  if (s && !s.noScript && !s.ok) lines.push(`注意：建立工作树后运行的准备脚本没有成功（${s.timedOut ? '超时' : `退出码 ${s.exitCode}`}），依赖可能没装好。需要时先自己安装依赖再运行。脚本输出末尾：\n${truncate(s.output ?? '', 600)}`);
  if (w.links?.length) lines.push(`依赖目录 ${w.links.join('、')} 是从主工作区链接过来的，不要在里面安装或删除东西。`);
  return lines.length ? `【工作树】\n${lines.join('\n')}` : '';
}

// ───────────────────────── copy + script ─────────────────────────
const globRe = (s: string) => new RegExp(`^${s.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);

/** Expand one copy entry against `from` (wildcards in the last part only). Returns relative paths. */
export function expandCopyEntry(from: string, entry: string): string[] {
  const e = entry.trim().replace(/\\/g, '/').replace(/\/+$/, '');
  const parts = e.split('/').filter(Boolean);
  const last = parts.pop()!;
  const dirRel = parts.join('/');
  const dir = path.join(from, dirRel);
  if (!/[*?]/.test(last)) return fs.existsSync(path.join(dir, last)) ? [e] : [];
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const re = globRe(last);
  return names.filter((n) => re.test(n) && n !== '.git').map((n) => (dirRel ? `${dirRel}/${n}` : n));
}

function copyInto(from: string, to: string, entries: string[]): { copied: string[]; missing: string[] } {
  const copied: string[] = [];
  const missing: string[] = [];
  for (const entry of entries) {
    if (copyEntryProblem(entry)) continue;
    const hits = expandCopyEntry(from, entry);
    if (!hits.length) missing.push(entry);
    for (const rel of hits) {
      const src = path.join(from, rel);
      const dst = path.join(to, rel);
      if (fs.existsSync(dst)) continue; // tracked in git, or linked: never overwrite
      try {
        const st = fs.lstatSync(src);
        if (st.isSymbolicLink()) continue;
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.cpSync(src, dst, { recursive: true, errorOnExist: false, force: false });
        copied.push(rel);
      } catch {
        missing.push(rel);
      }
    }
  }
  return { copied, missing };
}

/**
 * Run the workspace's 工作树准备 in worktree `w` (the edict's own, or a lane's): copy files, then run the script.
 * Never throws: a failure is recorded on `w.setup` and told to the officials (they can install things themselves).
 */
export async function runWorktreeSetup(rt: Runtime, t: Task, w: EdictWorktree, o: { mainDir: string; label?: string; signal?: AbortSignal }): Promise<WorktreeSetupRun> {
  const setup = worktreeSetupOf(rt, rt.permRoot(t));
  const dir = w.sub ? path.join(w.path, w.sub) : w.path;
  const what = o.label ?? '本旨意的工作树';
  const { copied, missing } = setup.copy.length ? copyInto(o.mainDir, dir, setup.copy) : { copied: [], missing: [] };
  if (copied.length) rt.activity('log', `工作树准备：已从主工作区复制 ${copied.join('、')} 到${what}`, { taskId: t.id });
  const run: WorktreeSetupRun = { at: now(), copied, ...(missing.length ? { missing } : {}), ok: true };
  if (!setup.script) {
    run.noScript = true;
  } else {
    rt.activity('log', `工作树准备：正在${what}里运行准备脚本（最多 ${setup.timeoutMin} 分钟）…`, { taskId: t.id, data: { worktree: dir } });
    const env = { ...portEnv(w.ports), EDICT_ROOT_PATH: o.mainDir, EDICT_WORKTREE_PATH: dir, EDICT_TASK_ID: t.id };
    const r = await runCommand(setup.script, dir, { timeoutMs: setup.timeoutMin * 60_000, maxOutput: 256 * 1024, signal: o.signal, env });
    const out = `${r.stdout}${r.stderr ? `\n${r.stderr}` : ''}`.trim();
    Object.assign(run, { ok: r.exitCode === 0 && !r.timedOut, exitCode: r.exitCode, timedOut: r.timedOut || undefined, durationMs: r.durationMs, output: out.length > 4000 ? `…${out.slice(-4000)}` : out });
    if (o.signal?.aborted) run.ok = false;
    rt.activity(run.ok ? 'log' : 'error', run.ok ? `工作树准备：脚本完成（${Math.round(r.durationMs / 1000)} 秒）` : `工作树准备：脚本${r.timedOut ? `超过 ${setup.timeoutMin} 分钟被停止` : `失败（退出码 ${r.exitCode}）`}。官员会照常办差，需要时自己装依赖。${out ? `输出末尾：${truncate(out.slice(-300), 300)}` : ''}`, { taskId: t.id });
  }
  w.setup = run;
  rt.audit.record('system', 'worktree_setup', { path: dir, copied, missing, script: !run.noScript, ok: run.ok, exitCode: run.exitCode ?? null, timedOut: !!run.timedOut, durationMs: run.durationMs ?? 0 }, t.id);
  rt.touch(t);
  return run;
}
