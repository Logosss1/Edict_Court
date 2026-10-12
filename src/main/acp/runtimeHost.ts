// AcpHost over Edict's Runtime: an ACP prompt becomes an edict (orchestrator.submit); the task's
// activities stream back as session/update, its pending approvals become session/request_permission,
// and the turn ends when the task is Done / Cancelled / Blocked or waits at a gate for the emperor.
import fs from 'node:fs';
import path from 'node:path';
import type { Runtime } from '../runtime/runtime';
import { submit } from '../runtime/orchestrator';
import { JsonFile } from '../runtime/persist';
import { now, truncate, uid } from '../runtime/util';
import { AGENT_MAP, STATE_LABEL, TERMINAL, TIER_LABEL, agentName } from '../../shared/court';
import type { Activity, AgentId, ApprovalRequest, RuntimeEvent, Task, Tier } from '../../shared/types';
import { RpcError } from './connection';
import type { AcpClientInfo, AcpHost, HostSession, TurnContext } from './agent';
import { text, type ContentBlock, type McpServer, type PlanEntry, type SessionMode, type SessionUpdate, type StopReason, type ToolCallContent, type ToolCallLocation, type ToolKind } from './protocol';

/** ACP session modes = Edict collaboration tiers. Solo is the default. */
export const ACP_MODES: { id: Tier; description: string }[] = [
  { id: 'solo', description: '单 Agent 直接读写工作区、执行命令，适合日常小改动（默认）' },
  { id: 'lite', description: '中书规划 → 门下审议 → 六部执行；回奏后在 Edict 御批结案' },
  { id: 'full', description: '完整三省六部：尚书派发、六部并行执行、门下审议成果；须在 Edict 御批' },
];
const DEFAULT_MODE: Tier = 'solo';

export interface RuntimeHostOptions {
  /**
   * Asked when the editor's cwd is not the folder open in Edict. true → Edict opens that folder as its
   * workspace. Without this hook a mismatching cwd is refused.
   */
  confirmWorkspace?: (req: { cwd: string; current: string | null; client: AcpClientInfo }) => Promise<boolean>;
  /** Never forward high-risk approvals to the editor; they can then only be decided inside Edict. Default false. */
  highRiskInEdictOnly?: boolean;
  /** Session index file (default `<dataDir>/acp-sessions.json`). */
  storeFile?: string;
  log?: (msg: string) => void;
}

interface TurnRecord {
  at: number;
  user: string;
  agent?: string;
  taskId?: string;
  tier: Tier;
  stopReason?: StopReason;
}

interface SessionRecord {
  id: string;
  cwd: string;
  modeId: Tier;
  client: string;
  createdAt: number;
  updatedAt: number;
  edictSessionId?: string; // Solo conversation that keeps the chat history across turns
  turns: TurnRecord[];
  mcpIgnored?: string[]; // editor-provided MCP servers not started (reported once)
}

interface Store {
  version: 1;
  sessions: SessionRecord[];
}

const MAX_SESSIONS = 200;
const MAX_TURNS = 100;
const MAX_TEXT = 20_000;

const TOOL_KIND: Record<string, ToolKind> = {
  list_dir: 'read', read_file: 'read', outline: 'read', view_changes: 'read', load_skill: 'read',
  search: 'search', write_file: 'edit', edit_file: 'edit', delete_file: 'delete', run_command: 'execute', preview_page: 'fetch',
};
export const toolKind = (name: string): ToolKind => TOOL_KIND[name] ?? 'other';

const SCOPE: Record<string, string> = { write_file: '写入文件', edit_file: '编辑文件', delete_file: '删除文件', run_command: '执行命令', read_file: '读取文件' };
const scopeOf = (tool: string) => SCOPE[tool] ?? (tool.startsWith('mcp__') ? `MCP ${tool.slice(5).replace('__', ' / ')}` : tool);

function fenced(body: string): string {
  const runs = body.match(/`{3,}/g) ?? [];
  const f = '`'.repeat(Math.max(3, ...runs.map((r) => r.length + 1)));
  return `${f}\n${body}\n${f}`;
}

function realDir(p: string): string | null {
  try {
    return fs.statSync(p).isDirectory() ? fs.realpathSync(p) : null;
  } catch {
    return null;
  }
}

export class RuntimeAcpHost implements AcpHost {
  readonly supportsLoad = true;
  private records = new Map<string, SessionRecord>();
  private file: JsonFile<Store>;
  private active = new Map<string, PromptTurn>();
  readonly log: (msg: string) => void;

  constructor(
    readonly rt: Runtime,
    readonly opts: RuntimeHostOptions = {},
  ) {
    this.log = opts.log ?? (() => {});
    this.file = new JsonFile<Store>(opts.storeFile ?? path.join(rt.opts.dataDir, 'acp-sessions.json'), () => ({ version: 1, sessions: [] }));
    for (const s of this.file.load().sessions ?? []) if (s && typeof s.id === 'string' && Array.isArray(s.turns)) this.records.set(s.id, s);
  }

  get agentInfo() {
    return { name: 'edict', title: 'Edict · 三省六部', version: this.rt.opts.version };
  }

  modes(): SessionMode[] {
    return ACP_MODES.map((m) => ({ id: m.id, name: TIER_LABEL[m.id], description: m.description }));
  }

  /** ACP sessions known to this host (newest first) — for UI listings. */
  listSessions(): Readonly<SessionRecord>[] {
    return [...this.records.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** Session ids whose prompt turn is currently running. */
  activeSessions(): string[] {
    return [...this.active.keys()];
  }

  save() {
    this.file.saveDebounced(() => this.snapshot());
  }

  dispose() {
    for (const t of this.active.values()) t.detach();
    try {
      this.file.flush(() => this.snapshot());
    } catch (e) {
      this.log(`[acp] session index flush failed: ${(e as Error).message}`);
    }
  }

  private snapshot(): Store {
    const sessions = [...this.records.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_SESSIONS);
    return { version: 1, sessions };
  }

  record(id: string): SessionRecord {
    const r = this.records.get(id);
    if (!r) throw RpcError.notFound(`会话不存在 / Session not found: ${id}`);
    return r;
  }

  /** The runtime has one open workspace: the editor's cwd must be it (or the user lets Edict switch to it). */
  async ensureWorkspace(cwd: string, client: AcpClientInfo): Promise<string> {
    const real = realDir(cwd);
    if (!real) throw RpcError.invalidParams(`工作目录不存在或不是文件夹 / cwd is not a directory: ${cwd}`);
    const cur = this.rt.workspace?.root ?? null;
    if (cur && realDir(cur) === real) return cur;
    const busy = [...this.rt.tasks.values()].filter((t) => !TERMINAL.includes(t.state) && t.state !== 'Blocked' && !t.gate && !t.paused);
    if (busy.length) {
      throw RpcError.internal(`Edict 正在执行其他旨意（${busy.slice(0, 3).map((t) => t.id).join('、')}），暂不能把工作区切换到 ${cwd}；请稍后再试或在 Edict 中打开该文件夹 / Edict is busy in ${cur ?? 'another workspace'}`);
    }
    let ok = false;
    try {
      ok = !!this.opts.confirmWorkspace && (await this.opts.confirmWorkspace({ cwd, current: cur, client }));
    } catch {
      ok = false;
    }
    if (!ok) {
      throw RpcError.internal(`Edict 当前${cur ? `打开的工作区是 ${cur}` : '没有打开工作区'}，与编辑器目录 ${cwd} 不一致；请先在 Edict 中打开该文件夹 / Open ${cwd} in Edict first`);
    }
    this.rt.setWorkspace(cwd);
    this.rt.audit.record(`acp:${client.name}`, 'acp_workspace_switch', { from: cur, to: this.rt.workspace?.root ?? cwd });
    return this.rt.workspace!.root;
  }

  async newSession(req: { cwd: string; mcpServers: McpServer[]; client: AcpClientInfo }): Promise<HostSession> {
    const root = await this.ensureWorkspace(req.cwd, req.client);
    const names = req.mcpServers.map((m) => String(m.name)).slice(0, 20);
    const rec: SessionRecord = { id: `acp-${uid()}`, cwd: root, modeId: DEFAULT_MODE, client: req.client.name, createdAt: now(), updatedAt: now(), turns: [], mcpIgnored: names.length ? names : undefined };
    this.records.set(rec.id, rec);
    this.save();
    this.rt.audit.record(`acp:${req.client.name}`, 'acp_session_new', { sessionId: rec.id, cwd: root, mcpServers: names });
    return { sessionId: rec.id, modeId: rec.modeId };
  }

  async loadSession(req: { sessionId: string; cwd: string; mcpServers: McpServer[]; client: AcpClientInfo }, replay: (u: SessionUpdate) => void): Promise<HostSession> {
    const rec = this.record(req.sessionId);
    if (this.active.has(rec.id)) throw RpcError.invalidRequest('该会话正在进行一轮对话 / A prompt turn is running in this session');
    rec.cwd = await this.ensureWorkspace(req.cwd, req.client);
    for (const t of rec.turns) {
      replay({ sessionUpdate: 'user_message_chunk', content: text(t.user) });
      const reply = t.agent || this.replyFromTask(t.taskId);
      if (reply) replay({ sessionUpdate: 'agent_message_chunk', content: text(reply) });
    }
    const names = req.mcpServers.map((m) => String(m.name)).slice(0, 20);
    rec.mcpIgnored = names.length ? names : undefined;
    rec.updatedAt = now();
    this.save();
    this.rt.audit.record(`acp:${req.client.name}`, 'acp_session_load', { sessionId: rec.id, cwd: rec.cwd, turns: rec.turns.length });
    return { sessionId: rec.id, modeId: rec.modeId };
  }

  private replyFromTask(taskId?: string): string {
    if (!taskId) return '';
    const t = this.rt.tasks.get(taskId);
    if (t) return t.result?.summary || `（旨意 ${t.id}：${STATE_LABEL[t.state]}）`;
    const m = this.rt.memorials.get(taskId);
    return m ? m.stages.find((s) => s.key === 'report')?.items[0] ?? '' : '';
  }

  setMode(sessionId: string, modeId: string) {
    const rec = this.record(sessionId);
    if (!ACP_MODES.some((m) => m.id === modeId)) throw RpcError.invalidParams(`未知模式 / Unknown mode: ${modeId}`);
    rec.modeId = modeId as Tier;
    rec.updatedAt = now();
    this.save();
  }

  async prompt(req: { sessionId: string; text: string; blocks: ContentBlock[]; modeId?: string }, ctx: TurnContext): Promise<StopReason> {
    const rec = this.record(req.sessionId);
    if (this.active.has(rec.id)) throw RpcError.invalidRequest('该会话已有一轮对话在进行 / A prompt turn is already running in this session');
    const tier = (ACP_MODES.some((m) => m.id === req.modeId) ? req.modeId : rec.modeId) as Tier;
    const turn = new PromptTurn(this, rec, tier, ctx);
    this.active.set(rec.id, turn);
    try {
      rec.cwd = await this.ensureWorkspace(rec.cwd, ctx.client);
      return await turn.run(req.text);
    } finally {
      this.active.delete(rec.id);
      rec.updatedAt = now();
      this.save();
    }
  }
}

interface ToolState {
  name: string;
  args: Record<string, unknown>;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  awaiting: boolean; // waiting for an approval
  nodeId?: string;
}

/** One prompt turn: follows a single task and translates its runtime events into session updates. */
class PromptTurn {
  private readonly rt: Runtime;
  private readonly court: boolean;
  private taskId: string | null = null;
  private buffer: RuntimeEvent[] | null = [];
  private streams = new Map<string, { kind: 'text' | 'thinking'; sent: string }>();
  private finished = new Set<string>();
  private skip = new Set<string>();
  private tools = new Map<string, ToolState>();
  private openTool = new Map<string, string>(); // agentId|nodeId → toolCallId
  private approvals = new Map<string, string>(); // approval id → toolCallId
  private lastPlan = '';
  private headerKey = '';
  private reply = '';
  private done = false;
  private resolve!: (r: StopReason) => void;
  private readonly result = new Promise<StopReason>((r) => (this.resolve = r));
  private turnRec: TurnRecord | null = null;

  constructor(
    private readonly host: RuntimeAcpHost,
    private readonly rec: SessionRecord,
    private readonly tier: Tier,
    private readonly ctx: TurnContext,
  ) {
    this.rt = host.rt;
    this.court = tier !== 'solo';
  }

  async run(input: string): Promise<StopReason> {
    const { rt, ctx } = this;
    const off = rt.on((e) => this.onEvent(e));
    const onAbort = () => this.onAbort();
    ctx.signal.addEventListener('abort', onAbort, { once: true });
    try {
      if (this.rec.mcpIgnored?.length) {
        this.thought(`（编辑器提供的 MCP 服务 ${this.rec.mcpIgnored.join('、')} 未启动：出于安全考虑，Edict 只使用在「技能与 MCP」中配置并信任过的服务。）\n`);
        this.rec.mcpIgnored = undefined;
      }
      let res: Awaited<ReturnType<typeof submit>>;
      try {
        res = await submit(rt, { text: input, tier: this.tier, multiAgent: this.tier !== 'solo', sessionId: this.tier === 'solo' ? this.rec.edictSessionId : undefined, model: null });
      } catch (e) {
        if (ctx.signal.aborted) return 'cancelled';
        throw RpcError.internal(`下旨失败 / Could not start the edict: ${(e as Error).message}`);
      }
      this.turnRec = { at: now(), user: truncate(input, MAX_TEXT), tier: this.tier };
      this.rec.turns.push(this.turnRec);
      if (this.rec.turns.length > MAX_TURNS) this.rec.turns.splice(0, this.rec.turns.length - MAX_TURNS);
      if (res.kind === 'chat') {
        // 太子 answered directly: no task was created
        this.buffer = null;
        if (ctx.signal.aborted) return this.end('cancelled');
        this.message(res.reply);
        return this.end('end_turn');
      }
      const id = res.taskId;
      this.taskId = id;
      this.turnRec.taskId = id;
      const task = rt.tasks.get(id);
      if (this.tier === 'solo' && task?.sessionId) this.rec.edictSessionId = task.sessionId;
      this.markOrigin(id);
      const buffered = this.buffer ?? [];
      this.buffer = null;
      for (const e of buffered) this.onEvent(e);
      // task objects are live: check the state once, after all buffered output
      if (ctx.signal.aborted) this.onAbort();
      if (task) this.onTask(task);
      return await this.result;
    } finally {
      off();
      ctx.signal.removeEventListener('abort', onAbort);
      this.host.save();
    }
  }

  /** Stop following the task without touching it (editor went away). */
  detach() {
    this.end('cancelled');
  }

  /** Provenance: who issued this edict. (When Task/Session gain an `origin` field, set it here.) */
  private markOrigin(taskId: string) {
    const c = this.ctx.client;
    this.rt.audit.record(`acp:${c.name}`, 'acp_prompt', { sessionId: this.rec.id, tier: this.tier, client: c.name, clientVersion: c.version ?? null }, taskId);
    const a = this.rt.activity('log', `📡 此旨意由编辑器「${c.title || c.name}」经 ACP 下达（会话 ${this.rec.id}）`, { taskId });
    this.skip.add(a.id);
  }

  private onAbort() {
    if (this.done) return;
    if (this.ctx.signal.reason !== 'cancelled') return this.detach(); // editor disconnected: the edict keeps running in Edict
    if (!this.taskId) return; // still in 太子 triage; handled once submit returns
    this.rt.audit.record(`acp:${this.ctx.client.name}`, 'acp_cancel', { sessionId: this.rec.id }, this.taskId);
    try {
      this.rt.cancel(this.taskId, '编辑器取消（ACP）');
    } catch (e) {
      this.host.log(`[acp] cancel failed: ${(e as Error).message}`);
    }
    const t = this.rt.tasks.get(this.taskId);
    if (t) this.onTask(t);
  }

  // ───────────────────────── output helpers ─────────────────────────
  private send(u: SessionUpdate) {
    if (!this.done) this.ctx.update(u);
  }

  private message(s: string) {
    if (!s) return;
    if (this.reply.length < MAX_TEXT) this.reply += s;
    this.send({ sessionUpdate: 'agent_message_chunk', content: text(s) });
  }

  private thought(s: string) {
    if (s) this.send({ sessionUpdate: 'agent_thought_chunk', content: text(s) });
  }

  private end(reason: StopReason): StopReason {
    if (this.done) return reason;
    for (const [id, t] of this.tools) {
      if (t.status === 'pending' || t.status === 'in_progress') {
        t.status = 'failed';
        this.send({ sessionUpdate: 'tool_call_update', toolCallId: id, status: 'failed' });
      }
    }
    this.done = true;
    if (this.turnRec) {
      this.turnRec.agent = truncate(this.reply, MAX_TEXT) || undefined;
      this.turnRec.stopReason = reason;
    }
    this.resolve(reason);
    return reason;
  }

  // ───────────────────────── runtime events ─────────────────────────
  private onEvent(e: RuntimeEvent) {
    if (this.done) return;
    if (this.buffer) {
      // until submit() returns we do not know our task id; keep only what a turn can consume
      if (e.type === 'activity' || e.type === 'activity_delta' || e.type === 'approval') this.buffer.push(e);
      return;
    }
    switch (e.type) {
      case 'activity':
        if (e.activity.taskId === this.taskId && !this.skip.has(e.activity.id)) this.onActivity(e.activity);
        return;
      case 'activity_delta': {
        const s = this.streams.get(e.id);
        if (s) this.emitStream(s, e.append);
        return;
      }
      case 'approval':
        if (e.approval.taskId === this.taskId) this.onApproval(e.approval);
        return;
      case 'task':
        if (e.task.id === this.taskId) this.onTask(e.task);
        return;
      default:
        return;
    }
  }

  private onActivity(a: Activity) {
    switch (a.kind) {
      case 'text':
      case 'thinking':
        return this.onStream(a);
      case 'tool_call':
        return this.onToolCall(a);
      case 'tool_result':
        return this.onToolResult(a);
      case 'state':
      case 'log':
        // court progress lines ("中书规划 → 门下审议", 门下 verdicts) as thoughts; Solo stays quiet
        if (this.court && a.content && !a.content.startsWith('▶')) {
          this.thought(`\n▸ ${a.content}\n`);
          this.headerKey = '';
        }
        return;
      default:
        return;
    }
  }

  private emitStream(s: { kind: 'text' | 'thinking'; sent: string }, chunk: string) {
    if (!chunk) return;
    s.sent += chunk;
    if (s.kind === 'text' && !this.court) this.message(chunk);
    else this.thought(chunk);
  }

  private onStream(a: Activity) {
    if (this.finished.has(a.id)) return;
    let s = this.streams.get(a.id);
    if (!s) {
      s = { kind: a.kind as 'text' | 'thinking', sent: '' };
      this.streams.set(a.id, s);
      this.header(a);
    }
    // a buffered "start" event may already carry final content (the activity object is mutated in place)
    const rest = a.content.startsWith(s.sent) ? a.content.slice(s.sent.length) : '';
    if (rest) this.emitStream(s, rest);
    if (!a.streaming) {
      this.finished.add(a.id);
      this.streams.delete(a.id);
    }
  }

  /** Court tiers: label each official's stream ("【门下省 · 门下审议 第 1 轮】"). */
  private header(a: Activity) {
    if (!this.court) return;
    const key = `${a.agentId ?? ''}|${a.nodeId ?? ''}`;
    if (key === this.headerKey) return;
    this.headerKey = key;
    const node = a.nodeId ? this.rt.tasks.get(this.taskId!)?.nodes.find((n) => n.id === a.nodeId) : undefined;
    const who = node?.roleName ?? agentName(a.agentId ?? '');
    this.thought(`\n【${who}${node?.label && node.label !== who ? ` · ${node.label}` : ''}】\n`);
  }

  private locations(args: Record<string, unknown>): ToolCallLocation[] | undefined {
    const ws = this.rt.workspace;
    if (!ws || typeof args.path !== 'string' || !args.path) return undefined;
    try {
      const line = Number(args.start_line);
      return [{ path: ws.resolve(args.path), line: Number.isInteger(line) && line > 0 ? line : undefined }];
    } catch {
      return undefined;
    }
  }

  private onToolCall(a: Activity) {
    const name = String(a.data?.name ?? '');
    const args = (a.data?.args && typeof a.data.args === 'object' ? a.data.args : {}) as Record<string, unknown>;
    const id = a.id;
    const st: ToolState = { name, args, status: 'pending', awaiting: false, nodeId: a.nodeId };
    this.tools.set(id, st);
    this.openTool.set(`${a.agentId ?? ''}|${a.nodeId ?? ''}`, id);
    this.send({ sessionUpdate: 'tool_call', toolCallId: id, title: a.content || name, kind: toolKind(name), status: 'pending', locations: this.locations(args), rawInput: args });
    // an approval (if any) is requested synchronously right after this activity; otherwise the tool is running
    setImmediate(() => {
      if (this.done || st.status !== 'pending' || st.awaiting) return;
      st.status = 'in_progress';
      this.send({ sessionUpdate: 'tool_call_update', toolCallId: id, status: 'in_progress' });
    });
  }

  private onToolResult(a: Activity) {
    const id = String(a.data?.callId ?? '');
    const st = this.tools.get(id);
    if (!st) return;
    const ok = !!a.data?.ok;
    st.status = ok ? 'completed' : 'failed';
    st.awaiting = false;
    const diff = ok && (st.name === 'write_file' || st.name === 'edit_file') ? this.diffFor(st) : null;
    const content: ToolCallContent[] = diff ? [diff] : a.content ? [{ type: 'content', content: text(fenced(a.content)) }] : [];
    this.send({ sessionUpdate: 'tool_call_update', toolCallId: id, status: st.status, content });
  }

  /** Real before/after from the runtime's change records (not the model's claim). */
  private diffFor(st: ToolState): ToolCallContent | null {
    const ws = this.rt.workspace;
    const task = this.taskId ? this.rt.tasks.get(this.taskId) : undefined;
    if (!ws || !task || typeof st.args.path !== 'string') return null;
    let rel: string;
    try {
      rel = ws.rel(ws.resolve(st.args.path));
    } catch {
      return null;
    }
    const ch = [...task.changes].reverse().find((c) => c.path === rel && (!st.nodeId || c.nodeId === st.nodeId));
    if (!ch?.afterHash) return null;
    const after = this.rt.blobs.get(ch.afterHash);
    const before = ch.beforeHash ? this.rt.blobs.get(ch.beforeHash) : null;
    const LIMIT = 512 * 1024;
    if (!after || after.length > LIMIT || (before && before.length > LIMIT)) return null;
    return { type: 'diff', path: path.join(ws.root, rel), oldText: before ? before.toString('utf8') : null, newText: after.toString('utf8') };
  }

  private onApproval(ap: ApprovalRequest) {
    const known = this.approvals.get(ap.id);
    if (ap.status !== 'pending') {
      // decided (by the editor, in Edict, or by cancellation): reflect it on the tool call
      const st = known ? this.tools.get(known) : undefined;
      if (st && st.awaiting) {
        st.awaiting = false;
        st.status = ap.status === 'approved' ? 'in_progress' : 'failed';
        this.send({ sessionUpdate: 'tool_call_update', toolCallId: known!, status: st.status });
      }
      return;
    }
    if (known) return;
    let toolCallId = this.openTool.get(`${ap.agentId}|${ap.nodeId ?? ''}`);
    const open = toolCallId ? this.tools.get(toolCallId) : undefined;
    if (!toolCallId || !open || open.status === 'completed' || open.status === 'failed') {
      toolCallId = `ap-${ap.id}`;
      this.tools.set(toolCallId, { name: ap.tool, args: {}, status: 'pending', awaiting: true, nodeId: ap.nodeId });
      this.send({ sessionUpdate: 'tool_call', toolCallId, title: ap.summary, kind: toolKind(ap.tool), status: 'pending' });
    }
    const st = this.tools.get(toolCallId)!;
    st.awaiting = true;
    this.approvals.set(ap.id, toolCallId);
    const high = ap.risk === 'high';
    if (high && this.host.opts.highRiskInEdictOnly) {
      this.thought(`\n⚠ 高风险操作须在 Edict 中由皇上确认：${ap.summary}（${ap.reason}）\n`);
      return;
    }
    const detail = truncate(ap.detail || '', 4000);
    const id = toolCallId;
    void this.ctx
      .requestPermission({
        toolCall: {
          toolCallId: id,
          title: `${high ? '⚠ 高风险 · ' : ''}${ap.summary}`,
          kind: toolKind(ap.tool),
          status: 'pending',
          content: [{ type: 'content', content: text(`${agentName(ap.agentId)}请求：${ap.reason || ap.summary}${detail ? `\n\n${fenced(detail)}` : ''}`) }],
          rawInput: { tool: ap.tool, risk: ap.risk, reason: ap.reason },
        },
        risk: ap.risk,
        key: ap.tool,
        scope: scopeOf(ap.tool),
      })
      .then((d) => {
        const cur = this.rt.approvals.get(ap.id);
        if (!cur || cur.status !== 'pending') return;
        const actor = `acp:${this.ctx.client.name}`;
        if (d === 'allow') this.rt.decideApproval(ap.id, true, actor);
        else if (d === 'reject' || d === 'cancelled') this.rt.decideApproval(ap.id, false, actor);
        else this.thought(`\n⏳ 编辑器未能答复，请在 Edict 中批准或驳回：${ap.summary}\n`); // detached: stays pending in Edict
      });
  }

  private planEntries(t: Task): PlanEntry[] {
    return (t.plan?.subtasks ?? []).map((s) => {
      const n = [...t.nodes].reverse().find((x) => x.kind === 'exec' && x.subtaskId === s.id);
      const status: PlanEntry['status'] = n?.status === 'done' ? 'completed' : n?.status === 'running' ? 'in_progress' : 'pending';
      const who = n?.roleName ?? AGENT_MAP[s.dept as AgentId]?.name ?? s.dept;
      return { content: `${who}·${s.title}`, priority: 'medium', status };
    });
  }

  private onTask(t: Task) {
    if (this.done) return;
    if (this.court && t.plan?.subtasks.length) {
      const entries = this.planEntries(t);
      const json = JSON.stringify(entries);
      if (json !== this.lastPlan) {
        this.lastPlan = json;
        this.send({ sessionUpdate: 'plan', entries });
      }
    }
    if (t.state === 'Cancelled') return void this.end('cancelled');
    if (t.state === 'Done') {
      const summary = t.result?.summary?.trim() ?? '';
      if (this.court) this.message(summary || '旨意已完成。');
      else if (!this.reply.trim() && summary) this.message(summary);
      return void this.end('end_turn');
    }
    if (t.state === 'Blocked') {
      this.message(`${this.reply ? '\n\n' : ''}⚠ 旨意 ${t.id} 已阻塞：${t.blockedReason ?? '原因未知'}\n请在 Edict 中处理（「重试失败节点」或「解除阻塞」）。`);
      return void this.end('end_turn');
    }
    if (t.gate) {
      this.message(this.gateText(t));
      return void this.end('end_turn');
    }
  }

  /** A gate needs the emperor; ACP cannot decide it, so the turn ends with an explanation. */
  private gateText(t: Task): string {
    const g = t.gate!;
    const parts: string[] = [];
    if (this.reply) parts.push('');
    if (g.kind === 'final' && this.court && t.result?.summary) parts.push(t.result.summary.trim());
    if (g.kind === 'plan' && t.plan) parts.push(`【中书省方案】${t.plan.summary}\n${t.plan.subtasks.map((s) => `- ${s.id} ${s.title}`).join('\n')}`);
    parts.push(`⏸ 此旨意需要在 Edict 中由皇上御批：${g.message}\n（旨意 ${t.id}「${t.title}」。本轮到此结束；请在 Edict 的旨意看板中准奏、封驳或调整，之后的进展不会再推送到这里。）`);
    return parts.join('\n\n');
  }
}
