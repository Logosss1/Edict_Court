// ACP agent side: protocol logic (initialize, sessions, prompt turns, cancellation, permission
// options) against an abstract AcpHost. Knows nothing about Edict's runtime — see runtimeHost.ts.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JsonRpcConnection, RpcError, type RequestContext } from './connection';
import {
  AGENT_METHODS, CANCEL_REQUEST, CLIENT_METHODS, ErrorCode, PROTOCOL_VERSION, text,
  type ClientCapabilities, type ContentBlock, type Implementation, type InitializeResponse, type McpServer,
  type PermissionOption, type RequestId, type RequestPermissionResponse, type SessionMode, type SessionModeState,
  type SessionUpdate, type StopReason, type ToolCallUpdate,
} from './protocol';

export interface AcpClientInfo {
  name: string; // clientInfo.name (self-reported; 'unknown' when absent)
  title?: string;
  version?: string;
  protocolVersion: number;
  capabilities: ClientCapabilities;
}

/** allow / reject: the user's answer. cancelled: the turn was cancelled. detached: the editor could not answer (gone, error). */
export type PermissionDecision = 'allow' | 'reject' | 'cancelled' | 'detached';

export interface PermissionAsk {
  toolCall: ToolCallUpdate;
  risk: 'normal' | 'high';
  /** Key for "always" answers within this session (e.g. the tool name). Never consulted for high risk allows. */
  key: string;
  /** Human label of what an "always" answer covers. */
  scope?: string;
}

export interface TurnContext {
  sessionId: string;
  client: AcpClientInfo;
  /** session/update for this turn; silently dropped once the turn has ended or the editor is gone. */
  update(u: SessionUpdate): void;
  requestPermission(ask: PermissionAsk): Promise<PermissionDecision>;
  /** Aborted with reason 'cancelled' (session/cancel) or 'detached' (connection closed). */
  signal: AbortSignal;
}

export interface HostSession {
  sessionId: string;
  modeId: string;
}

export interface AcpHost {
  readonly agentInfo: Implementation;
  readonly supportsLoad: boolean;
  modes(): SessionMode[];
  newSession(req: { cwd: string; mcpServers: McpServer[]; client: AcpClientInfo }): Promise<HostSession>;
  /** Must call `replay` for the whole conversation before resolving. */
  loadSession?(req: { sessionId: string; cwd: string; mcpServers: McpServer[]; client: AcpClientInfo }, replay: (u: SessionUpdate) => void): Promise<HostSession>;
  setMode(sessionId: string, modeId: string): Promise<void> | void;
  /** One prompt turn. `modeId` overrides the session mode for this turn only (slash command). */
  prompt(req: { sessionId: string; text: string; blocks: ContentBlock[]; modeId?: string }, ctx: TurnContext): Promise<StopReason>;
}

export interface AcpAgentOptions {
  host: AcpHost;
  /** Consent gate, called once with the client's self-description during initialize. false → refuse and close. */
  authorize?: (client: AcpClientInfo) => Promise<boolean>;
  /** How long a cancelled turn may take to wind down before `cancelled` is returned anyway (default 15 s). */
  cancelGraceMs?: number;
  log?: (msg: string) => void;
}

interface SessionState {
  modeId: string;
  allow: Set<string>;
  reject: Set<string>;
}

interface Turn {
  sessionId: string;
  requestId: RequestId;
  controller: AbortController;
  done: boolean;
  cancelled: boolean;
}

const STOP_REASONS: StopReason[] = ['end_turn', 'max_tokens', 'max_turn_requests', 'refusal', 'cancelled'];

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

function reqString(p: Record<string, unknown>, key: string): string {
  const v = p[key];
  if (typeof v !== 'string' || !v) throw RpcError.invalidParams(`${key} must be a non-empty string`);
  return v;
}

function absPath(p: Record<string, unknown>, key: string): string {
  const v = reqString(p, key);
  if (v.includes('\0') || !path.isAbsolute(v)) throw RpcError.invalidParams(`${key} must be an absolute path`);
  return path.resolve(v);
}

function mcpList(p: Record<string, unknown>): McpServer[] {
  const v = p.mcpServers;
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw RpcError.invalidParams('mcpServers must be an array');
  return v.filter((x) => x && typeof x === 'object' && typeof (x as { name?: unknown }).name === 'string') as McpServer[];
}

/** Permission options offered to the editor. High risk never offers an "always allow". */
export function permissionOptions(risk: 'normal' | 'high', scope?: string): PermissionOption[] {
  const s = scope ? `「${scope}」` : '';
  if (risk === 'high') {
    return [
      { optionId: 'allow_once', name: '允许本次（高风险，每次都需确认）', kind: 'allow_once' },
      { optionId: 'reject_once', name: '拒绝', kind: 'reject_once' },
      { optionId: 'reject_always', name: `本会话始终拒绝${s}`, kind: 'reject_always' },
    ];
  }
  return [
    { optionId: 'allow_once', name: '允许本次', kind: 'allow_once' },
    { optionId: 'allow_always', name: `本会话始终允许${s}（高风险操作仍逐次确认）`, kind: 'allow_always' },
    { optionId: 'reject_once', name: '拒绝', kind: 'reject_once' },
    { optionId: 'reject_always', name: `本会话始终拒绝${s}`, kind: 'reject_always' },
  ];
}

function fence(body: string): string {
  const runs = body.match(/`{3,}/g) ?? [];
  const n = Math.max(3, ...runs.map((r) => r.length + 1));
  return '`'.repeat(n);
}

function displayUri(uri: string): string {
  if (uri.startsWith('file://')) {
    try {
      return fileURLToPath(uri);
    } catch {
      return uri;
    }
  }
  return uri;
}

const MAX_RESOURCE_CHARS = 200_000;
const MAX_CONTEXT_CHARS = 600_000;

/**
 * Flatten a prompt into the text an Edict edict carries. Text blocks stay inline; resource links and
 * embedded resources are referenced inline as `@name` and listed / embedded in an appendix.
 */
export function promptToText(blocks: ContentBlock[]): string {
  const main: string[] = [];
  const links: string[] = [];
  const embedded: string[] = [];
  const omitted: string[] = [];
  let budget = MAX_CONTEXT_CHARS;
  const push = (s: string, inline: boolean) => {
    if (!main.length) return main.push(s);
    const prev = main[main.length - 1];
    const sep = inline ? (/\s$/.test(prev) || /^\s/.test(s) ? '' : ' ') : '\n';
    main.push(sep + s);
  };
  let lastInline = false;
  for (const raw of blocks) {
    const b = raw as ContentBlock;
    if (!b || typeof b !== 'object') continue;
    switch (b.type) {
      case 'text': {
        const t = typeof b.text === 'string' ? b.text : '';
        if (t) push(t, lastInline);
        lastInline = false;
        break;
      }
      case 'resource_link': {
        const where = displayUri(String(b.uri ?? ''));
        const label = String(b.title || b.name || path.basename(where) || where);
        push(`@${label}`, true);
        lastInline = true;
        links.push(`- ${label}：${where}${b.mimeType ? `（${b.mimeType}）` : ''}${b.description ? ` — ${b.description}` : ''}`);
        break;
      }
      case 'resource': {
        const r = obj(b.resource) as { uri?: string; text?: string; blob?: string; mimeType?: string };
        const where = displayUri(String(r.uri ?? ''));
        push(`@${path.basename(where) || where || '附件'}`, true);
        lastInline = true;
        if (typeof r.text === 'string') {
          let body = r.text;
          const cap = Math.min(MAX_RESOURCE_CHARS, Math.max(0, budget));
          const cut = body.length > cap;
          if (cut) body = body.slice(0, cap);
          budget -= body.length;
          const f = fence(body);
          embedded.push(`### ${where}${cut ? `（内容过长，已截取前 ${cap} 字符）` : ''}\n${f}\n${body}\n${f}`);
        } else {
          omitted.push(`${where}（二进制内容${r.mimeType ? ` ${r.mimeType}` : ''}，已省略）`);
        }
        break;
      }
      case 'image':
      case 'audio':
        omitted.push(`${b.type === 'image' ? '图片' : '音频'}附件（${b.mimeType ?? '未知类型'}；Edict 暂不支持，已忽略）`);
        break;
      default:
        break; // unknown block types are ignored (forward compatibility)
    }
  }
  const out = [main.join('')];
  if (links.length) out.push(`【引用的文件 / 资源（未附带内容，需要时请自行读取）】\n${links.join('\n')}`);
  if (embedded.length) out.push(`【附带上下文】\n${embedded.join('\n\n')}`);
  if (omitted.length) out.push(`【已省略的附件】\n${omitted.map((o) => `- ${o}`).join('\n')}`);
  return out.filter((s) => s.trim()).join('\n\n');
}

export class AcpAgent {
  private client: AcpClientInfo | null = null;
  private state: 'new' | 'authorizing' | 'ready' | 'refused' = 'new';
  private sessions = new Map<string, SessionState>();
  private turns = new Map<string, Turn>();
  private readonly log: (msg: string) => void;

  constructor(
    readonly conn: JsonRpcConnection,
    private readonly opts: AcpAgentOptions,
  ) {
    this.log = opts.log ?? (() => {});
    conn.onRequest((m, p, ctx) => this.handle(m, p, ctx));
    conn.onNotification((m, p) => this.notification(m, p));
    conn.onClose(() => this.detachAll());
  }

  get clientInfo(): AcpClientInfo | null {
    return this.client;
  }

  get host(): AcpHost {
    return this.opts.host;
  }

  // ───────────────────────── requests ─────────────────────────
  private async handle(method: string, params: unknown, ctx: RequestContext): Promise<unknown> {
    if (method === AGENT_METHODS.initialize) return this.initialize(obj(params), ctx);
    if (this.state !== 'ready') throw RpcError.invalidRequest('必须先调用 initialize / initialize must be called first');
    const p = obj(params);
    switch (method) {
      case AGENT_METHODS.authenticate:
        throw RpcError.invalidParams('Edict 不需要认证（authMethods 为空） / No authentication methods are offered');
      case AGENT_METHODS.sessionNew:
        return this.newSession(p, ctx);
      case AGENT_METHODS.sessionLoad:
        if (!this.host.supportsLoad || !this.host.loadSession) throw RpcError.methodNotFound(method);
        return this.loadSession(p, ctx);
      case AGENT_METHODS.sessionSetMode:
        return this.setMode(p);
      case AGENT_METHODS.sessionPrompt:
        return this.prompt(p, ctx);
      default:
        throw RpcError.methodNotFound(method);
    }
  }

  private async initialize(p: Record<string, unknown>, ctx: RequestContext): Promise<InitializeResponse> {
    if (this.state !== 'new') throw RpcError.invalidRequest('initialize 只能调用一次 / initialize was already called');
    const v = p.protocolVersion;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) throw RpcError.invalidParams('protocolVersion must be a non-negative integer');
    const ci = obj(p.clientInfo);
    const str = (x: unknown, n: number) => (typeof x === 'string' && x.trim() ? x.trim().slice(0, n) : undefined);
    const client: AcpClientInfo = { name: str(ci.name, 100) ?? 'unknown', title: str(ci.title, 100), version: str(ci.version, 50), protocolVersion: v, capabilities: obj(p.clientCapabilities) as ClientCapabilities };
    this.state = 'authorizing';
    if (this.opts.authorize) {
      let ok = false;
      try {
        ok = await this.opts.authorize(client);
      } catch (e) {
        this.log(`[acp] authorize failed: ${(e as Error).message}`);
      }
      if (!ok || this.conn.closed) {
        this.state = 'refused';
        ctx.after(() => this.conn.close());
        throw new RpcError(ErrorCode.ConnectionRefused, 'Edict 用户拒绝了此编辑器的连接 / The Edict user declined this connection');
      }
    }
    this.client = client;
    this.state = 'ready';
    // We implement exactly protocol version 1: echo it when requested, otherwise answer with our latest (1).
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: !!(this.host.supportsLoad && this.host.loadSession),
        promptCapabilities: { image: false, audio: false, embeddedContext: true },
        mcpCapabilities: { http: false, sse: false },
      },
      authMethods: [],
      agentInfo: this.host.agentInfo,
    };
  }

  private modeState(modeId: string): SessionModeState {
    return { currentModeId: modeId, availableModes: this.host.modes() };
  }

  private register(sessionId: string, modeId: string) {
    const prev = this.sessions.get(sessionId);
    if (prev) prev.modeId = modeId;
    else this.sessions.set(sessionId, { modeId, allow: new Set(), reject: new Set() });
  }

  private session(p: Record<string, unknown>): [string, SessionState] {
    const id = reqString(p, 'sessionId');
    const s = this.sessions.get(id);
    if (!s) throw RpcError.notFound(`会话不存在 / Session not found: ${id}`);
    return [id, s];
  }

  private async newSession(p: Record<string, unknown>, ctx: RequestContext) {
    const cwd = absPath(p, 'cwd');
    const mcpServers = mcpList(p);
    const s = await this.host.newSession({ cwd, mcpServers, client: this.client! });
    this.register(s.sessionId, s.modeId);
    ctx.after(() => this.sendCommands(s.sessionId));
    return { sessionId: s.sessionId, modes: this.modeState(s.modeId) };
  }

  private async loadSession(p: Record<string, unknown>, ctx: RequestContext) {
    const sessionId = reqString(p, 'sessionId');
    const cwd = absPath(p, 'cwd');
    const mcpServers = mcpList(p);
    if (this.turns.has(sessionId)) throw RpcError.invalidRequest('该会话正在进行一轮对话 / A prompt turn is running in this session');
    const s = await this.host.loadSession!({ sessionId, cwd, mcpServers, client: this.client! }, (u) => {
      if (!this.conn.closed) this.conn.notify(CLIENT_METHODS.sessionUpdate, { sessionId, update: u });
    });
    this.register(s.sessionId, s.modeId);
    ctx.after(() => this.sendCommands(s.sessionId));
    return { modes: this.modeState(s.modeId) };
  }

  private async setMode(p: Record<string, unknown>) {
    const [id, s] = this.session(p);
    const modeId = reqString(p, 'modeId');
    if (!this.host.modes().some((m) => m.id === modeId)) throw RpcError.invalidParams(`未知模式 / Unknown mode: ${modeId}`);
    await this.host.setMode(id, modeId);
    s.modeId = modeId;
    return {};
  }

  private sendCommands(sessionId: string) {
    if (this.conn.closed) return;
    const availableCommands = this.host.modes().map((m) => ({
      name: m.id,
      description: `以「${m.name}」执行这条内容；不带内容则把本会话切换为该模式`,
      input: { hint: '要交办的事（留空 = 切换模式）' },
    }));
    this.conn.notify(CLIENT_METHODS.sessionUpdate, { sessionId, update: { sessionUpdate: 'available_commands_update', availableCommands } });
  }

  /** `/solo …`, `/lite …`, `/full …` — the session modes double as slash commands. */
  private parseCommand(blocks: ContentBlock[]): { modeId: string; blocks: ContentBlock[] } | null {
    const i = blocks.findIndex((b) => b && typeof b === 'object');
    const first = blocks[i];
    if (!first || first.type !== 'text' || typeof first.text !== 'string') return null;
    const m = first.text.match(/^\s*\/([A-Za-z][\w-]*)(?:\s+([\s\S]*))?$/);
    if (!m || !this.host.modes().some((x) => x.id === m[1])) return null;
    const rest = blocks.slice();
    rest[i] = { ...first, text: m[2] ?? '' };
    return { modeId: m[1], blocks: rest };
  }

  private async prompt(p: Record<string, unknown>, ctx: RequestContext) {
    const [sessionId, s] = this.session(p);
    if (!Array.isArray(p.prompt)) throw RpcError.invalidParams('prompt must be an array of content blocks');
    if (this.turns.has(sessionId)) throw RpcError.invalidRequest('该会话已有一轮对话在进行 / A prompt turn is already running in this session');
    const blocks = p.prompt as ContentBlock[];
    const cmd = this.parseCommand(blocks);
    const turn: Turn = { sessionId, requestId: ctx.id, controller: new AbortController(), done: false, cancelled: false };
    this.turns.set(sessionId, turn);
    try {
      const body = cmd ? cmd.blocks : blocks;
      const textIn = promptToText(body);
      if (cmd && !textIn.trim()) {
        await this.host.setMode(sessionId, cmd.modeId);
        s.modeId = cmd.modeId;
        const name = this.host.modes().find((m) => m.id === cmd.modeId)?.name ?? cmd.modeId;
        this.send(turn, { sessionUpdate: 'current_mode_update', currentModeId: cmd.modeId });
        this.send(turn, { sessionUpdate: 'agent_message_chunk', content: text(`已切换为「${name}」模式。`) });
        return { stopReason: 'end_turn' as StopReason };
      }
      if (!textIn.trim()) throw RpcError.invalidParams('提示内容为空 / The prompt is empty');
      const tctx: TurnContext = {
        sessionId,
        client: this.client!,
        signal: turn.controller.signal,
        update: (u) => this.send(turn, u),
        requestPermission: (a) => this.askPermission(turn, s, a),
      };
      let reason: StopReason;
      const work = this.host.prompt({ sessionId, text: textIn, blocks: body, modeId: cmd?.modeId }, tctx);
      work.catch(() => {}); // may lose the race below
      try {
        reason = await Promise.race([work, this.cancelGrace(turn)]);
      } catch (e) {
        // spec: errors caused by cancellation must surface as the `cancelled` stop reason
        if (!turn.cancelled) throw e instanceof RpcError ? e : RpcError.internal((e as Error)?.message || String(e));
        reason = 'cancelled';
      }
      if (turn.cancelled) reason = 'cancelled';
      if (!STOP_REASONS.includes(reason)) reason = 'end_turn';
      return { stopReason: reason };
    } finally {
      // set before the response is written: nothing from this turn may follow the prompt response
      turn.done = true;
      if (this.turns.get(sessionId) === turn) this.turns.delete(sessionId);
    }
  }

  /** Resolves 'cancelled' a while after session/cancel, so a stuck host can never hold the turn open. */
  private cancelGrace(turn: Turn): Promise<StopReason> {
    return new Promise((resolve) => {
      const sig = turn.controller.signal;
      const arm = () => {
        if (sig.reason !== 'cancelled') return;
        const t = setTimeout(() => resolve('cancelled'), this.opts.cancelGraceMs ?? 15_000);
        t.unref?.();
      };
      if (sig.aborted) arm();
      else sig.addEventListener('abort', arm, { once: true });
    });
  }

  private send(turn: Turn, update: SessionUpdate) {
    if (turn.done || this.conn.closed) return;
    this.conn.notify(CLIENT_METHODS.sessionUpdate, { sessionId: turn.sessionId, update });
  }

  private async askPermission(turn: Turn, s: SessionState, ask: PermissionAsk): Promise<PermissionDecision> {
    const sig = turn.controller.signal;
    const abortDecision = (): PermissionDecision => (sig.reason === 'detached' ? 'detached' : 'cancelled');
    if (sig.aborted) return abortDecision();
    if (turn.done || this.conn.closed) return 'detached';
    const high = ask.risk === 'high';
    if (s.reject.has(ask.key)) return 'reject';
    if (!high && s.allow.has(ask.key)) return 'allow';
    const options = permissionOptions(ask.risk, ask.scope);
    const aborted = new Promise<PermissionDecision>((resolve) => sig.addEventListener('abort', () => resolve(abortDecision()), { once: true }));
    let res: RequestPermissionResponse | PermissionDecision;
    try {
      res = await Promise.race([this.conn.request<RequestPermissionResponse>(CLIENT_METHODS.sessionRequestPermission, { sessionId: turn.sessionId, toolCall: ask.toolCall, options }), aborted]);
    } catch (e) {
      this.log(`[acp] request_permission failed: ${(e as Error).message}`);
      return sig.aborted ? abortDecision() : 'detached';
    }
    if (typeof res === 'string') return res;
    const outcome = obj(res).outcome as { outcome?: string; optionId?: unknown } | undefined;
    if (!outcome || outcome.outcome === 'cancelled') return 'cancelled';
    if (outcome.outcome !== 'selected') return 'reject';
    switch (outcome.optionId) {
      case 'allow_once':
        return 'allow';
      case 'allow_always':
        // high risk: Edict always asks — an "always" answer only covers this one operation
        if (!high) s.allow.add(ask.key);
        return 'allow';
      case 'reject_always':
        s.reject.add(ask.key);
        return 'reject';
      default:
        return 'reject'; // reject_once or an option we never offered
    }
  }

  // ───────────────────────── notifications ─────────────────────────
  private notification(method: string, params: unknown) {
    if (this.state !== 'ready') return;
    const p = obj(params);
    if (method === AGENT_METHODS.sessionCancel) {
      const t = typeof p.sessionId === 'string' ? this.turns.get(p.sessionId) : undefined;
      if (t) this.cancelTurn(t);
      return;
    }
    if (method === CANCEL_REQUEST) {
      for (const t of this.turns.values()) if (t.requestId === p.requestId) this.cancelTurn(t);
      return;
    }
    // unknown notifications (including `_` extensions) are ignored, as the spec requires
  }

  private cancelTurn(t: Turn) {
    if (t.done || t.controller.signal.aborted) return;
    t.cancelled = true;
    t.controller.abort('cancelled');
  }

  private detachAll() {
    for (const t of this.turns.values()) if (!t.controller.signal.aborted) t.controller.abort('detached');
  }
}
