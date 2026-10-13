// 客卿 (2.1): an outside agent does one ministry subtask in the edict's worktree. Its file reads and writes and
// its commands come back to Edict as ACP requests and go through Edict's own tools (permissions, sandbox, change
// records); its permission requests become Edict's cards. Whatever it changes with its own built-in tools is found
// by a shadow snapshot before and after, recorded like any change (revertable).
import fs from 'node:fs';
import path from 'node:path';
import type { Activity, AgentId, FileChange, RunNode, Task } from '../../shared/types';
import type { Runtime } from '../runtime/runtime';
import { TaskAbortedError } from '../runtime/runtime';
import { executeTool, permit, permKey, type ToolContext, type ToolName } from '../runtime/tools';
import { isLookCommand } from '../runtime/permissions';
import { RpcError } from '../acp/connection';
import { CLIENT_FS_TERMINAL, CLIENT_METHODS, ErrorCode, text, type ContentBlock, type CreateTerminalRequest, type PermissionOption, type ReadTextFileRequest, type RequestPermissionRequest, type RequestPermissionResponse, type SessionNotification, type TerminalRef, type ToolCallUpdate, type WriteTextFileRequest } from '../acp/protocol';
import { OVERSIZE, type ShadowSnap } from '../services/shadowSnapshot';
import type { Workspace } from '../services/workspace';
import type { ExecResult } from '../services/exec';
import { GuestStartError, startGuest, type GuestProcess } from './client';
import type { GuestLaunch } from './registry';
import { sha256, truncate } from '../runtime/util';
import { commandEnv } from '../runtime/worktreeSetup';
import { laneOf } from '../runtime/attempts';

export interface GuestRunOptions {
  rt: Runtime;
  task: Task;
  node: RunNode;
  /** the ministry the guest stands in for (its avatar and permissions) */
  agentId: AgentId;
  launch: GuestLaunch;
  prompt: string;
  /** asked once more in the same session when the first answer has no structured conclusion */
  repairPrompt: string;
  /** true when `text` already holds a structured conclusion */
  isStructured: (text: string) => boolean;
  signal: AbortSignal;
}

export interface GuestRunResult {
  text: string;
  toolCounts: Record<string, number>;
  /** files the guest changed with its own tools (found by the snapshots) */
  direct: FileChange[];
  stopReason: string;
}

interface Term {
  promise: Promise<{ ok: boolean; output: string; exec?: ExecResult }>;
  abort: AbortController;
  result?: { ok: boolean; output: string; exec?: ExecResult };
  limit?: number;
}

const ALLOW: PermissionOption['kind'][] = ['allow_once', 'allow_always'];
const REJECT: PermissionOption['kind'][] = ['reject_once', 'reject_always'];

const shQuote = (s: string) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

/** A command string as the guest's terminal request meant it. */
export function terminalCommand(p: CreateTerminalRequest, root: string): string {
  const args = Array.isArray(p.args) ? p.args.map(String) : [];
  const env = (p.env ?? []).filter((e) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(e.name)).map((e) => `${e.name}=${shQuote(String(e.value))}`);
  // `sh -c "<line>"` style: run the line itself (permissions and the sandbox see what really runs)
  let line = args.length === 2 && /(^|\/)(ba|z)?sh$/.test(p.command) && args[0] === '-c' ? args[1] : [p.command, ...args.map(shQuote)].join(' ');
  if (!args.length) line = p.command;
  if (env.length) line = `export ${env.join(' ')}; ${line}`;
  const cwd = p.cwd && path.resolve(p.cwd) !== path.resolve(root) ? p.cwd : null;
  return cwd ? `cd ${shQuote(cwd)} && ${line}` : line;
}

/** Workspace-relative path for an absolute path a guest sent (also through the folder's real path). */
function relOf(ws: Workspace, p: string): string {
  try {
    return ws.rel(ws.resolve(p));
  } catch (e) {
    const real = (() => {
      try {
        return fs.realpathSync(ws.root);
      } catch {
        return ws.root;
      }
    })();
    const abs = path.resolve(p);
    if (real !== ws.root && (abs === real || abs.startsWith(real + path.sep))) return ws.rel(ws.resolve(path.join(ws.root, path.relative(real, abs))));
    throw e;
  }
}

const commandOf = (u: ToolCallUpdate): string => {
  const raw = u.rawInput as Record<string, unknown> | undefined;
  const c = raw?.command ?? raw?.cmd;
  if (Array.isArray(c)) return c.map(String).join(' ');
  return typeof c === 'string' ? c : '';
};

/** Run one subtask with a guest. Throws GuestStartError when it never got going (the caller falls back). */
export async function runGuest(o: GuestRunOptions): Promise<GuestRunResult> {
  const { rt, task: t, node, agentId, launch } = o;
  const ws = rt.workspaceFor(t, node);
  if (!ws) throw new GuestStartError('本旨意的工作树不可用');
  const who = `客卿 ${launch.name}`;
  const toolCounts: Record<string, number> = {};
  const count = (k: string) => (toolCounts[k] = (toolCounts[k] ?? 0) + 1);
  const preApproved = new Set<string>();
  // no `reads` here: the guest keeps track of what it has read itself (it may read with its own tools), so
  // Edict's read-before-overwrite rule for officials does not apply to its writes
  const ctx: ToolContext = { rt, task: t, node, agentId, signal: o.signal, preApproved };
  const terms = new Map<string, Term>();
  let termSeq = 0;
  let turnText = '';
  let textAct: Activity | null = null;
  let thinkAct: Activity | null = null;
  const toolActs = new Map<string, Activity>();
  const endStreams = () => {
    if (textAct) rt.finishActivity(textAct, textAct.content || '');
    if (thinkAct) rt.finishActivity(thinkAct, thinkAct.content || '');
    textAct = thinkAct = null;
  };
  const act = { taskId: t.id, agentId, nodeId: node.id };
  const busy = (activity: string, status: 'thinking' | 'writing' | 'tool' = 'tool') => rt.setAgent(agentId, { status, taskId: t.id, nodeId: node.id, activity: `${who}：${activity}` });

  // ── requests from the guest ──
  const onRequest = async (method: string, params: unknown): Promise<unknown> => {
    rt.heartbeat(agentId, t.id);
    switch (method) {
      case CLIENT_FS_TERMINAL.readTextFile: {
        const p = params as ReadTextFileRequest;
        let rel: string;
        try {
          rel = relOf(ws, String(p.path ?? ''));
        } catch (e) {
          throw new RpcError(ErrorCode.InvalidParams, (e as Error).message);
        }
        if (ws.isSensitive(rel)) throw new RpcError(ErrorCode.InvalidParams, `${rel} 是密钥类文件，Edict 不提供给客卿`);
        const buf = ws.readBuffer(rel);
        if (!buf) throw RpcError.notFound(`文件不存在：${rel}`);
        count('read_file');
        rt.activity('tool_call', `读取 ${rel}`, { ...act, data: { name: 'read_file', args: { path: rel }, guest: launch.id } });
        let content = buf.toString('utf8');
        if (p.line || p.limit) {
          const lines = content.split('\n');
          const start = Math.max(1, Number(p.line) || 1);
          content = lines.slice(start - 1, p.limit ? start - 1 + Number(p.limit) : undefined).join('\n');
        }
        return { content };
      }
      case CLIENT_FS_TERMINAL.writeTextFile: {
        const p = params as WriteTextFileRequest;
        let rel: string;
        try {
          rel = relOf(ws, String(p.path ?? ''));
        } catch (e) {
          throw new RpcError(ErrorCode.InvalidParams, (e as Error).message);
        }
        busy(`写入 ${rel}`);
        rt.activity('tool_call', `写入 ${rel}`, { ...act, data: { name: 'write_file', args: { path: rel }, guest: launch.id } });
        const r = await executeTool(ctx, 'write_file', { path: rel, content: String(p.content ?? '') });
        count('write_file');
        rt.activity('tool_result', truncate(r.output, 2000), { ...act, data: { ok: r.ok, name: 'write_file' } });
        if (!r.ok) throw new RpcError(ErrorCode.InternalError, r.output);
        return {};
      }
      case CLIENT_FS_TERMINAL.terminalCreate: {
        const p = params as CreateTerminalRequest;
        const command = terminalCommand(p, ws.root);
        const id = `term-${++termSeq}`;
        const abort = new AbortController();
        const tctx: ToolContext = { ...ctx, signal: AbortSignal.any([o.signal, abort.signal]) };
        busy(`$ ${truncate(command, 80)}`);
        const call = rt.activity('tool_call', `$ ${truncate(command, 160)}`, { ...act, data: { name: 'run_command', args: { command: truncate(command, 2000) }, guest: launch.id } });
        count('run_command');
        const term: Term = { abort, limit: p.outputByteLimit ?? undefined, promise: executeTool(tctx, 'run_command', { command, timeout_sec: 600 }) };
        term.promise = term.promise.then((r) => {
          term.result = r;
          rt.activity('tool_result', truncate(r.output, 5000), { ...act, data: { ok: r.ok, name: 'run_command', callId: call.id } });
          return r;
        });
        terms.set(id, term);
        return { terminalId: id };
      }
      case CLIENT_FS_TERMINAL.terminalOutput: {
        const term = terms.get(String((params as TerminalRef).terminalId));
        if (!term) throw RpcError.notFound('没有这个终端');
        const r = term.result;
        const out = r ? (r.exec ? `${r.exec.stdout}${r.exec.stderr ? `${r.exec.stdout ? '\n' : ''}${r.exec.stderr}` : ''}` : r.output) : '';
        const limited = term.limit && Buffer.byteLength(out) > term.limit ? out.slice(-term.limit) : out;
        return { output: limited, truncated: limited.length < out.length, ...(r ? { exitStatus: { exitCode: r.exec ? r.exec.exitCode : r.ok ? 0 : 1, signal: r.exec?.signal ?? null } } : {}) };
      }
      case CLIENT_FS_TERMINAL.terminalWaitForExit: {
        const term = terms.get(String((params as TerminalRef).terminalId));
        if (!term) throw RpcError.notFound('没有这个终端');
        const r = await term.promise;
        return { exitCode: r.exec ? r.exec.exitCode : r.ok ? 0 : 1, signal: r.exec?.signal ?? null };
      }
      case CLIENT_FS_TERMINAL.terminalKill: {
        terms.get(String((params as TerminalRef).terminalId))?.abort.abort();
        return {};
      }
      case CLIENT_FS_TERMINAL.terminalRelease: {
        const id = String((params as TerminalRef).terminalId);
        const term = terms.get(id);
        if (term && !term.result) term.abort.abort();
        terms.delete(id);
        return {};
      }
      case CLIENT_METHODS.sessionRequestPermission:
        return answerPermission(params as RequestPermissionRequest);
      default:
        throw RpcError.methodNotFound(method);
    }
  };

  /** The guest asks before one of its own actions: Edict's rules decide, a card asks the emperor when needed. */
  const answerPermission = async (p: RequestPermissionRequest): Promise<RequestPermissionResponse> => {
    const u = p.toolCall ?? ({} as ToolCallUpdate);
    const opts = Array.isArray(p.options) ? p.options : [];
    const pick = (kinds: PermissionOption['kind'][]) => opts.find((x) => x.kind === kinds[0]) ?? opts.find((x) => kinds.includes(x.kind));
    const allow = (): RequestPermissionResponse => {
      const x = pick(ALLOW);
      return x ? { outcome: { outcome: 'selected', optionId: x.optionId } } : { outcome: { outcome: 'cancelled' } };
    };
    const reject = (): RequestPermissionResponse => {
      const x = pick(REJECT);
      return x ? { outcome: { outcome: 'selected', optionId: x.optionId } } : { outcome: { outcome: 'cancelled' } };
    };
    const kind = u.kind ?? 'other';
    const title = u.title ?? kind;
    if (kind === 'read' || kind === 'search' || kind === 'think' || kind === 'switch_mode') return allow();
    if (kind === 'fetch') return rt.settings.web?.fetch === 'off' ? reject() : allow();
    const command = commandOf(u);
    const where = u.locations?.[0]?.path;
    let tool: ToolName;
    let args: Record<string, unknown>;
    if (kind === 'execute' || command) {
      tool = 'run_command';
      args = { command: command || title };
    } else {
      let rel = '';
      try {
        rel = where ? relOf(ws, where) : '';
      } catch {
        rel = '';
      }
      if (where && !rel) return reject(); // outside the worktree
      tool = kind === 'delete' ? 'delete_file' : 'write_file';
      args = { path: rel || title, content: truncate(JSON.stringify(u.rawInput ?? {}, null, 1), 3000) };
    }
    busy(`请示：${truncate(title, 60)}`);
    const r = await permit(ctx, ws, tool, args);
    if (!r.ok) {
      rt.activity('log', `${who}的请求未获准：${truncate(title, 120)}`, act);
      return reject();
    }
    const key = permKey(ws, tool, args);
    if (key) preApproved.add(key);
    if (tool === 'run_command' && !isLookCommand(String(args.command))) node.sideEffects = true;
    return allow();
  };

  // ── what the guest says while it works ──
  const onNotification = (method: string, params: unknown) => {
    if (method !== CLIENT_METHODS.sessionUpdate) return;
    rt.heartbeat(agentId, t.id);
    const up = (params as SessionNotification)?.update;
    if (!up) return;
    switch (up.sessionUpdate) {
      case 'agent_message_chunk': {
        const d = up.content?.type === 'text' ? up.content.text : '';
        if (!d) return;
        turnText += d;
        if (!textAct) {
          textAct = rt.activity('text', '', { ...act, streaming: true, data: { guest: launch.id } });
          busy('撰写中…', 'writing');
        }
        textAct.content += d;
        rt.appendActivity(textAct.id, d);
        return;
      }
      case 'agent_thought_chunk': {
        const d = up.content?.type === 'text' ? up.content.text : '';
        if (!d) return;
        if (!thinkAct) {
          thinkAct = rt.activity('thinking', '', { ...act, streaming: true, data: { guest: launch.id } });
          busy('思考中…', 'thinking');
        }
        thinkAct.content += d;
        rt.appendActivity(thinkAct.id, d);
        return;
      }
      case 'tool_call': {
        endStreams();
        if (up.kind === 'execute') count('guest:execute');
        if (up.kind === 'edit' || up.kind === 'delete' || up.kind === 'move') count('guest:edit');
        busy(truncate(up.title ?? '调用工具', 60));
        toolActs.set(up.toolCallId, rt.activity('tool_call', `${who} · ${truncate(up.title ?? up.kind ?? '工具', 200)}`, { ...act, data: { name: `guest:${up.kind ?? 'other'}`, args: { title: up.title ?? '' }, guest: launch.id } }));
        return;
      }
      case 'tool_call_update': {
        if (up.status !== 'completed' && up.status !== 'failed') return;
        const call = toolActs.get(up.toolCallId);
        const body = (up.content ?? []).map((c) => (c.type === 'content' && c.content.type === 'text' ? c.content.text : c.type === 'diff' ? `改动 ${c.path}` : '')).filter(Boolean).join('\n');
        rt.activity('tool_result', truncate(body || (up.status === 'completed' ? '完成' : '失败'), 3000), { ...act, data: { ok: up.status === 'completed', name: `guest:${up.kind ?? 'other'}`, callId: call?.id } });
        return;
      }
      case 'plan': {
        const lines = (up.entries ?? []).map((e) => `${e.status === 'completed' ? '✓' : e.status === 'in_progress' ? '…' : '○'} ${e.content}`);
        if (lines.length) rt.activity('log', `${who}的计划：\n${lines.join('\n')}`, act);
        return;
      }
      default:
        return;
    }
  };

  // ── start, snapshot, prompt ──
  busy('启动中…', 'thinking');
  const lanePorts = laneOf(t, node)?.worktree?.ports;
  const { proc, init } = await startGuest({ exe: launch.exe, args: launch.args, alt: launch.alt, cwd: ws.root, env: { ...commandEnv(t, lanePorts), EDICT_TASK_ID: t.id }, onRequest, onNotification, version: rt.opts.version, log: (m) => rt.audit.record('system', 'guest_log', { guest: launch.id, msg: truncate(m, 300) }, t.id) });
  let before: ShadowSnap | null = null;
  try {
    const session = await proc.newSession(ws.root);
    const agent = init.agentInfo ? `${init.agentInfo.title ?? init.agentInfo.name} ${init.agentInfo.version}` : launch.name;
    rt.audit.record(agentId, 'guest_start', { guest: launch.id, agent, exe: launch.exe, args: launch.args, cwd: ws.root, node: node.id }, t.id);
    rt.activity('log', `${who}（${agent}）接手「${node.label}」，在 ${ws.root} 里办差`, act);
    try {
      before = await rt.snapshots.take(ws.root);
    } catch {
      before = null;
    }
    if (!before) rt.activity('log', `⚠ 没能给工作树拍快照（${rt.snapshots.disabled(ws.root) ?? '快照不可用'}）：${who}用自带工具改的文件可能记不全`, act);
    const ask = async (p: string): Promise<string> => {
      turnText = '';
      const run = proc.prompt(session.sessionId, [text(p)] as ContentBlock[]);
      const onAbort = () => {
        proc.cancel(session.sessionId);
        setTimeout(() => proc.kill('SIGTERM'), 3000).unref?.();
      };
      o.signal.addEventListener('abort', onAbort, { once: true });
      try {
        const r = await Promise.race([run, proc.exited.then((x) => Promise.reject(new Error(`${who}的进程意外退出（${x.signal ?? `退出码 ${x.code}`}）${proc.stderrTail(3) ? `：${proc.stderrTail(3)}` : ''}`)))]);
        endStreams();
        if (o.signal.aborted) throw new TaskAbortedError();
        if (r.stopReason === 'refusal') throw new Error(`${who}拒绝了这个任务`);
        stop = r.stopReason;
        return turnText;
      } catch (e) {
        endStreams();
        if (o.signal.aborted) throw new TaskAbortedError();
        throw e;
      } finally {
        o.signal.removeEventListener('abort', onAbort);
      }
    };
    let stop = 'end_turn';
    let answer = await ask(o.prompt);
    if (!o.isStructured(answer)) {
      rt.activity('log', `${who}没有按格式交结论，请它补交一次`, act);
      const again = await ask(o.repairPrompt);
      if (o.isStructured(again) || again.trim()) answer = again.trim() ? again : answer;
    }
    const direct = await recordDirect(rt, t, node, agentId, ws, before, launch);
    return { text: answer, toolCounts: { ...toolCounts, run_command: Math.max(toolCounts.run_command ?? 0, toolCounts['guest:execute'] ?? 0) }, direct, stopReason: stop };
  } finally {
    for (const term of terms.values()) if (!term.result) term.abort.abort();
    await proc.close().catch(() => {});
    if (before) await rt.snapshots.release(before).catch(() => {});
    rt.setAgent(agentId, { status: 'idle', activity: '', taskId: undefined, nodeId: undefined });
  }
}

/** Files that differ after the guest's run and were not recorded by Edict's own tools: record them as 'guest'. */
async function recordDirect(rt: Runtime, t: Task, node: RunNode, agentId: AgentId, ws: Workspace, before: ShadowSnap | null, launch: GuestLaunch): Promise<FileChange[]> {
  if (!before) return [];
  let after: ShadowSnap | null = null;
  try {
    after = await rt.snapshots.take(ws.root);
    if (!after) return [];
    const d = await rt.snapshots.diff(before, after);
    const out: FileChange[] = [];
    for (const c of d.changes) {
      let rel: string;
      try {
        rel = ws.rel(ws.resolve(c.path));
      } catch {
        continue;
      }
      const big = c.before === OVERSIZE || c.after === OVERSIZE;
      const afterHash = Buffer.isBuffer(c.after) ? sha256(c.after) : c.after === null ? null : undefined;
      // already recorded by write_file / run_command in this node, ending in the same content
      const last = [...rt.changesFor(t, node)].reverse().find((x) => x.path === rel && x.nodeId === node.id && !x.reverted);
      if (last && afterHash !== undefined && last.afterHash === afterHash) continue;
      const buf = (x: typeof c.before) => (Buffer.isBuffer(x) ? x : null);
      out.push(rt.recordChange(t, agentId, node.id, rel, buf(c.before), buf(c.after), { via: 'guest', command: launch.name, op: c.before === null ? 'create' : c.after === null ? 'delete' : 'modify', oversize: big }));
    }
    if (out.length) rt.activity('log', `${who(launch)}用自带工具改了 ${out.length} 个文件（已记录，可撤回）：${out.slice(0, 8).map((c) => c.path).join('、')}${out.length > 8 ? ' 等' : ''}${d.truncated ? `；实际改动 ${d.total} 个，只记录了前 ${out.length} 个` : ''}`, { taskId: t.id, agentId, nodeId: node.id });
    return out;
  } catch (e) {
    rt.activity('log', `⚠ 核对${who(launch)}的改动时快照失败：${(e as Error).message}`, { taskId: t.id, agentId, nodeId: node.id });
    return [];
  } finally {
    if (after) await rt.snapshots.release(after).catch(() => {});
  }
}

const who = (l: GuestLaunch) => `客卿 ${l.name}`;
