// 客卿 (2.1): the outside coding agents Edict can ask to do a ministry's subtask, driven over ACP (Edict is the
// client). Edict only finds what is already installed on this computer; it never installs or logs in for you.
import path from 'node:path';
import type { GuestConfig, GuestKind, GuestSettings, GuestStatus, MinistryId } from '../../shared/types';
import { findExecutable, searchDirs } from '../lsp/detect';
import type { Runtime } from '../runtime/runtime';

export interface GuestDef {
  id: string;
  kind: Exclude<GuestKind, 'custom'>;
  name: string;
  /** executables to look for, first found wins; `args` start ACP mode; `alt` = older argument spellings to try */
  candidates: { cmd: string; args: string[]; alt?: string[][] }[];
  installHint: string;
  loginHint: string;
  homepage: string;
}

export const GUEST_DEFS: GuestDef[] = [
  {
    id: 'claude', kind: 'claude', name: 'Claude Code',
    candidates: [{ cmd: 'claude-agent-acp', args: [] }, { cmd: 'claude-code-acp', args: [] }],
    installHint: 'npm install -g @agentclientprotocol/claude-agent-acp',
    loginHint: '先装好 Claude Code，在终端运行 claude 登录一次',
    homepage: 'https://www.npmjs.com/package/@agentclientprotocol/claude-agent-acp',
  },
  {
    id: 'codex', kind: 'codex', name: 'Codex',
    candidates: [{ cmd: 'codex-acp', args: [] }],
    installHint: 'npm install -g @agentclientprotocol/codex-acp',
    loginHint: '在终端运行 codex login 登录一次',
    homepage: 'https://www.npmjs.com/package/@agentclientprotocol/codex-acp',
  },
  {
    id: 'gemini', kind: 'gemini', name: 'Gemini CLI',
    candidates: [{ cmd: 'gemini', args: ['--acp'], alt: [['--experimental-acp']] }],
    installHint: 'npm install -g @google/gemini-cli',
    loginHint: '在终端运行 gemini，按提示登录一次',
    homepage: 'https://www.npmjs.com/package/@google/gemini-cli',
  },
  {
    id: 'opencode', kind: 'opencode', name: 'OpenCode',
    candidates: [{ cmd: 'opencode', args: ['acp'] }],
    installHint: 'npm install -g opencode-ai',
    loginHint: '在终端运行 opencode auth login 配好模型',
    homepage: 'https://www.npmjs.com/package/opencode-ai',
  },
];

export const MINISTRY_IDS: MinistryId[] = ['libu_hr', 'hubu', 'libu', 'bingbu', 'xingbu', 'gongbu'];

export function guestSettingsOf(rt: Runtime): GuestSettings {
  const g = rt.settings.guests as Partial<GuestSettings> | undefined;
  return { agents: Array.isArray(g?.agents) ? g!.agents : [], deptDefault: g?.deptDefault && typeof g.deptDefault === 'object' ? g.deptDefault : {}, attemptsInLite: !!g?.attemptsInLite };
}

/** Split a command line the way a shell would for plain words and quotes (no expansion). */
export function splitCommandLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q: '"' | "'" | null = null;
  let any = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === q) q = null;
      else if (c === '\\' && q === '"' && i + 1 < line.length) cur += line[++i];
      else cur += c;
    } else if (c === '"' || c === "'") {
      q = c;
      any = true;
    } else if (c === '\\' && i + 1 < line.length) {
      cur += line[++i];
      any = true;
    } else if (/\s/.test(c)) {
      if (cur || any) out.push(cur);
      cur = '';
      any = false;
    } else cur += c;
  }
  if (q) throw new Error('命令里的引号没有配对');
  if (cur || any) out.push(cur);
  return out;
}

export const expandHome = (p: string, home = process.env.HOME ?? '') => (p === '~' ? home : p.startsWith('~/') ? path.join(home, p.slice(2)) : p);

/** How to start one guest: the executable and its arguments (plus older spellings to try), or why it cannot start. */
export interface GuestLaunch {
  id: string;
  name: string;
  exe: string;
  args: string[];
  alt: string[][];
}

function configOf(rt: Runtime, id: string): GuestConfig | undefined {
  return guestSettingsOf(rt).agents.find((a) => a.id === id);
}

export function guestStatus(rt: Runtime, id: string, dirs = searchDirs()): GuestStatus | null {
  const def = GUEST_DEFS.find((d) => d.id === id);
  const cfg = configOf(rt, id);
  if (!def && !cfg) return null;
  if (!def) {
    // custom: the command the emperor typed
    const exe = cfg!.command ? findExecutable(expandHome(cfg!.command), dirs) : null;
    return { id, name: cfg!.name, kind: 'custom', builtIn: false, enabled: cfg!.enabled !== false, found: !!exe, path: exe ?? cfg!.command, args: cfg!.args ?? [], note: exe ? undefined : `找不到程序：${cfg!.command || '（未填）'}` };
  }
  const st: GuestStatus = { id, name: def.name, kind: def.kind, builtIn: true, enabled: cfg?.enabled ?? true, found: false, installHint: def.installHint, loginHint: def.loginHint, homepage: def.homepage };
  if (cfg?.command) {
    const exe = findExecutable(expandHome(cfg.command), dirs);
    return { ...st, overridden: true, found: !!exe, path: exe ?? cfg.command, args: cfg.args ?? def.candidates[0].args, note: exe ? undefined : `找不到你填的程序：${cfg.command}` };
  }
  for (const c of def.candidates) {
    const exe = findExecutable(c.cmd, dirs);
    if (exe) return { ...st, found: true, path: exe, args: c.args };
  }
  return st;
}

export function guestStatuses(rt: Runtime): GuestStatus[] {
  const dirs = searchDirs();
  const ids = [...GUEST_DEFS.map((d) => d.id), ...guestSettingsOf(rt).agents.filter((a) => !GUEST_DEFS.some((d) => d.id === a.id)).map((a) => a.id)];
  return ids.map((id) => guestStatus(rt, id, dirs)!).filter(Boolean);
}

/** Launch details for an enabled, installed guest; otherwise the reason it cannot do the work. */
export function guestLaunch(rt: Runtime, id: string): GuestLaunch | { error: string } {
  const st = guestStatus(rt, id);
  if (!st) return { error: `没有名为 ${id} 的客卿` };
  if (!st.enabled) return { error: `客卿 ${st.name} 已停用` };
  if (!st.found || !st.path) return { error: st.note ?? `本机没有找到 ${st.name}${st.installHint ? `（安装：${st.installHint}）` : ''}` };
  const def = GUEST_DEFS.find((d) => d.id === id);
  const cand = def?.candidates.find((c) => path.basename(st.path!) === c.cmd);
  return { id, name: st.name, exe: st.path, args: st.args ?? [], alt: configOf(rt, id)?.command ? [] : (cand?.alt ?? []) };
}

export const guestName = (rt: Runtime, id: string) => GUEST_DEFS.find((d) => d.id === id)?.name ?? configOf(rt, id)?.name ?? id;

/** Who does subtask `sub`: a guest id, or null for the ministry's own official. */
export function executorOf(rt: Runtime, sub: { dept: string; executor?: string }): string | null {
  if (sub.executor === 'self') return null;
  if (sub.executor) return sub.executor;
  return guestSettingsOf(rt).deptDefault[sub.dept as MinistryId] ?? null;
}

// ───────────────────────── settings ─────────────────────────
export function saveGuest(rt: Runtime, cfg: Partial<GuestConfig> & { id?: string; commandLine?: string }): GuestStatus {
  const g = guestSettingsOf(rt);
  const def = cfg.id ? GUEST_DEFS.find((d) => d.id === cfg.id) : undefined;
  const prev = cfg.id ? g.agents.find((a) => a.id === cfg.id) : undefined;
  let next: GuestConfig;
  if (def) {
    next = { id: def.id, name: def.name, kind: def.kind, enabled: cfg.enabled ?? prev?.enabled ?? true };
    const line = cfg.commandLine !== undefined ? cfg.commandLine.trim() : undefined;
    if (line) {
      const [command, ...args] = splitCommandLine(line);
      next.command = command;
      next.args = args;
    } else if (line === undefined && prev?.command) {
      next.command = prev.command;
      next.args = prev.args;
    }
  } else {
    const name = (cfg.name ?? prev?.name ?? '').trim();
    if (!name) throw new Error('请给这位客卿起个名字');
    const line = cfg.commandLine !== undefined ? cfg.commandLine.trim() : undefined;
    let command = prev?.command;
    let args = prev?.args ?? [];
    if (line !== undefined) {
      if (!line) throw new Error('请填写启动命令（以 ACP 模式启动这个智能体的命令）');
      [command, ...args] = splitCommandLine(line);
    }
    if (!command) throw new Error('请填写启动命令');
    const id = prev?.id ?? `g_${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 20) || 'guest'}_${Date.now().toString(36).slice(-4)}`;
    if (GUEST_DEFS.some((d) => d.name === name) && !prev) throw new Error(`${name} 已在列表里`);
    next = { id, name, kind: 'custom', enabled: cfg.enabled ?? prev?.enabled ?? true, command, args };
  }
  const agents = [...g.agents.filter((a) => a.id !== next.id), next];
  rt.updateSettings({ guests: { ...g, agents } });
  rt.audit.record('emperor', 'guest_saved', { id: next.id, name: next.name, kind: next.kind, enabled: next.enabled, command: next.command ?? null });
  return guestStatus(rt, next.id)!;
}

export function removeGuest(rt: Runtime, id: string) {
  const g = guestSettingsOf(rt);
  const builtIn = GUEST_DEFS.some((d) => d.id === id);
  const agents = g.agents.filter((a) => a.id !== id);
  const deptDefault = { ...g.deptDefault };
  if (!builtIn) for (const k of Object.keys(deptDefault) as MinistryId[]) if (deptDefault[k] === id) delete deptDefault[k];
  rt.updateSettings({ guests: { ...g, agents, deptDefault } });
  rt.audit.record('emperor', builtIn ? 'guest_reset' : 'guest_removed', { id });
}

export function setGuestDefaults(rt: Runtime, patch: { deptDefault?: Partial<Record<MinistryId, string | null>>; attemptsInLite?: boolean }) {
  const g = guestSettingsOf(rt);
  const deptDefault = { ...g.deptDefault };
  for (const [k, v] of Object.entries(patch.deptDefault ?? {})) {
    if (!MINISTRY_IDS.includes(k as MinistryId)) continue;
    if (v) deptDefault[k as MinistryId] = v;
    else delete deptDefault[k as MinistryId];
  }
  rt.updateSettings({ guests: { ...g, deptDefault, attemptsInLite: patch.attemptsInLite ?? g.attemptsInLite } });
  rt.audit.record('emperor', 'guest_defaults', { deptDefault, attemptsInLite: patch.attemptsInLite ?? g.attemptsInLite });
}
