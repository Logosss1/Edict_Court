// Edict runtime: owns every task, agent, debate, approval and audit record. Both the
// workbench and the pixel court are projections of this single state (bidirectional sync
// = both send commands here and both render the same events).
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {
  Activity, ActivityKind, AgentId, AgentRuntime, Annotation, ApprovalRequest, AllowRule, Debate, Gate, Memorial, ModelRef, NewsItem, Plan,
  ProviderConfig, RuntimeEvent, Session, Settings, SkillInfo, Snapshot, Task, TaskState, Tier, Usage, FileChange, RunNode, Protocol, ReasoningConfig, ProbeRow, ProbeCell, ModelClass, ReasoningStyle, ReasoningDetectResult, ErrorInfo, RevertResult,
} from '../../shared/types';
import { emptyUsage } from '../../shared/types';
import { AGENTS, AGENT_MAP, STATE_LABEL, agentName, TERMINAL } from '../../shared/court';
import { AuditLog, BlobStore, JsonlLog } from './persist';
import { openStateStore, type DocKind, type PersistedSettingsLike, type PersistedStateLike, type SqliteStore } from './sqliteStore';
import { assertTransition, IllegalTransitionError } from './stateMachine';
import { addUsage, estimateTokens, now, sha256, uid, ymd, redactSecrets, truncate } from './util';
import { defaultSettings, TEMPLATES } from './defaults';
import { DETECT_CANDIDATES, LEVEL_RANK, STYLE_LABEL, clampLevel, effectiveConfig, fallbackLadder, levelLabel, presetFor, reasoningParams } from '../../shared/reasoning';
import { classifyLlmError } from '../llm/types';
import { Workspace } from '../services/workspace';
import { ShadowSnapshots } from '../services/shadowSnapshot';
import type { PreviewHostResult, PreviewRenderOptions } from '../services/previewActions';
import { McpManager } from '../mcp/manager';
import { LspManager, loadLspConfig, saveLspConfig, type LspConfig } from '../lsp/manager';
import { DesignStore } from './designs';
import { edictDir, raiseWorktreeCard, recoverWorktrees } from './worktrees';
import { previewHostFor, taskIdFromPreviewHost } from '../services/preview';
import type { FetchLike, ProviderRuntime } from '../llm/types';
import { listRemoteModels, streamLlm } from '../llm/adapters';
import { PROVIDER_PRESETS } from '../llm/presets';

export interface SecretStore {
  get(id: string): string | null;
  set(id: string, value: string): void;
  delete(id: string): void;
  readonly encrypted: boolean;
}

export interface RuntimeOptions {
  dataDir: string;
  fetchImpl: FetchLike;
  secrets: SecretStore;
  version: string;
  platform: string;
  resourcesDir: string; // for builtin skills
  notify?: (title: string, body: string) => void;
  /** Render a page in a hidden sandboxed browser (desktop only; undefined in node tests). */
  previewPage?: (url: string, o: PreviewRenderOptions) => Promise<PreviewHostResult>;
  /** Open an https (or loopback http) URL in the system browser — MCP OAuth login (desktop: shell.openExternal). */
  openExternal?: (url: string) => void | Promise<void>;
}

type PersistedState = PersistedStateLike;

type PersistedSettings = PersistedSettingsLike;

export interface ApprovalDecision {
  approve: boolean;
  choice: string;
  comment?: string;
}

export class TaskAbortedError extends Error {
  constructor(msg = '任务已取消') {
    super(msg);
    this.name = 'TaskAbortedError';
  }
}

const STYLES = ['none', 'openai', 'anthropic', 'anthropic-budget', 'qwen', 'glm', 'custom'];
function sanitizeReasoning(r: unknown): ReasoningConfig | undefined {
  if (!r || typeof r !== 'object') return undefined;
  const x = r as ReasoningConfig;
  if (!STYLES.includes(x.style)) return undefined;
  const levels = Array.isArray(x.levels) ? x.levels.filter((l) => typeof l === 'string' && /^[a-z0-9_-]{1,24}$/i.test(l)).slice(0, 12) : [];
  const out: ReasoningConfig = { style: x.style, levels, default: levels.includes(x.default) ? x.default : levels[Math.floor(levels.length / 2)] ?? '' };
  if (x.budgets && typeof x.budgets === 'object') out.budgets = Object.fromEntries(Object.entries(x.budgets).filter(([k, v]) => levels.includes(k) && Number.isFinite(+v) && +v > 0).map(([k, v]) => [k, Math.round(+v)]));
  if (x.style === 'custom' && x.custom && typeof x.custom === 'object') out.custom = JSON.parse(JSON.stringify(x.custom));
  const d = x.detected;
  if (d && typeof d === 'object' && Number.isFinite(+d.at)) {
    const names = (a: unknown) => (Array.isArray(a) ? a.filter((l) => typeof l === 'string' && /^[a-z0-9_-]{1,24}$/i.test(l)).slice(0, 12) : []);
    out.detected = { at: +d.at, reliable: !!d.reliable, accepted: names(d.accepted), rejected: names(d.rejected) };
  }
  return out;
}

export class Runtime {
  readonly opts: RuntimeOptions;
  tasks = new Map<string, Task>();
  agents = new Map<AgentId, AgentRuntime>();
  debates = new Map<string, Debate>();
  sessions = new Map<string, Session>();
  memorials = new Map<string, Memorial>();
  annotations: Annotation[] = [];
  approvals = new Map<string, ApprovalRequest>();
  news: NewsItem[] = [];
  settings: Settings;
  providers: ProviderConfig[];
  skills: SkillInfo[] = [];
  readonly mcp: McpManager = new McpManager(this);
  readonly designs: DesignStore = new DesignStore(this);
  totals: Usage = emptyUsage();
  seqByDay: Record<string, number> = {};
  workspace: Workspace | null = null;

  readonly audit: AuditLog;
  readonly blobs: BlobStore;
  /** edict.db (SQLite); 1.x state.json / settings.json are migrated on first open with a backup */
  readonly store: SqliteStore;
  /** language servers found on this machine (auto-detected; missing ones show install hints) */
  readonly lsp: LspManager;
  /** R7: shadow snapshots per workspace root — what run_command changed on disk */
  readonly snapshots: ShadowSnapshots;
  /** Workspace objects for edict worktrees (and other folders an edict works in), by root */
  private wsCache = new Map<string, Workspace>();
  /** language servers for edict worktrees (the editor's diagnostics stay on `lsp`) */
  private lspByRoot = new Map<string, LspManager>();
  private listeners = new Set<(e: RuntimeEvent) => void>();
  private activityBuf = new Map<string, Activity[]>(); // taskId|'_global' → recent
  private activityLogs = new Map<string, JsonlLog<Activity>>();
  private pendingDeltas = new Map<string, string>();
  private deltaTimer: NodeJS.Timeout | null = null;
  private dirtyTasks = new Set<string>();
  private flushScheduled = false;
  private waiters = new Map<string, Set<() => void>>();
  private approvalResolvers = new Map<string, (d: ApprovalDecision) => void>();
  /** per-node abort (wall-clock timeout) — key taskId/nodeId */
  readonly nodeControllers = new Map<string, AbortController>();
  /** one writer per edict: taskId → holder nodeId + waiters */
  private writeLocks = new Map<string, { holder: string; queue: { nodeId: string; resolve: () => void }[] }>();
  readonly controllers = new Map<string, AbortController>();
  healthTimer: NodeJS.Timeout | null = null;
  private alerted = new Set<string>();

  // hooks wired by orchestrator module (avoid circular imports)
  driveHook: (taskId: string) => void = () => {};
  private agentLocks = new Map<string, Promise<void>>();

  /** One official handles one piece of work at a time (keeps per-agent observability truthful). */
  async acquireAgent(id: string, signal?: AbortSignal): Promise<() => void> {
    const prev = this.agentLocks.get(id) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((r) => (release = r));
    const chained = prev.then(() => mine);
    this.agentLocks.set(id, chained);
    await Promise.race([
      prev,
      new Promise<void>((_, rej) => signal?.addEventListener('abort', () => rej(new TaskAbortedError()), { once: true })),
    ]).catch((e) => {
      release();
      throw e;
    });
    return () => {
      release();
      if (this.agentLocks.get(id) === chained) this.agentLocks.delete(id);
    };
  }

  constructor(opts: RuntimeOptions) {
    this.opts = opts;
    fs.mkdirSync(opts.dataDir, { recursive: true });
    this.audit = new AuditLog(path.join(opts.dataDir, 'audit.jsonl'));
    this.blobs = new BlobStore(path.join(opts.dataDir, 'blobs'));
    this.snapshots = new ShadowSnapshots(path.join(opts.dataDir, 'snapshots'), { audit: (action, detail) => this.audit.record('system', action, detail) });
    this.store = openStateStore(opts.dataDir);
    const s: PersistedSettings = this.store.loadSettings() ?? { settings: defaultSettings(), providers: [] };
    this.settings = { ...defaultSettings(), ...s.settings };
    this.providers = (s.providers ?? []).map((p) => ({ ...p, hasKey: !!opts.secrets.get(`provider:${p.id}`) }));
    const st = this.store.loadState();
    for (const t of st.tasks ?? []) this.tasks.set(t.id, t);
    for (const d of st.debates ?? []) this.debates.set(d.id, d);
    for (const x of st.sessions ?? []) this.sessions.set(x.id, x);
    for (const m of st.memorials ?? []) this.memorials.set(m.taskId, m);
    this.annotations = st.annotations ?? [];
    this.news = st.news ?? [];
    this.totals = st.totals ?? emptyUsage();
    this.seqByDay = st.seqByDay ?? {};
    for (const a of AGENTS) {
      const stats = st.agentStats?.[a.id];
      this.agents.set(a.id, {
        id: a.id, status: 'idle', activity: '', lastHeartbeat: 0, health: 'ok',
        usage: stats?.usage ?? emptyUsage(), completed: stats?.completed ?? 0, sessions: stats?.sessions ?? 0, errors: stats?.errors ?? 0,
      });
    }
    this.store.bind({ state: () => this.persistedState(), settings: () => ({ settings: this.settings, providers: this.providers }) });
    let lspTimer: ReturnType<typeof setTimeout> | undefined;
    this.lsp = new LspManager({
      workspace: () => this.workspace,
      config: loadLspConfig(path.join(opts.dataDir, 'lsp.json')),
      clientVersion: opts.version,
      onDiagnostics: (e) => this.emit({ type: 'lsp_diagnostics', path: e.path, server: e.server, diagnostics: e.diagnostics }),
      onStatusChange: () => {
        if (lspTimer) return;
        lspTimer = setTimeout(() => {
          lspTimer = undefined;
          this.emit({ type: 'lsp_status' });
        }, 300);
        lspTimer.unref?.();
      },
    });
    const rep = this.store.openReport;
    if (rep?.imported) this.audit.record('system', 'storage_migrated', { from: rep.imported.from, counts: rep.imported.counts as unknown as Record<string, unknown>, backupDir: rep.backupDir ?? null });
    this.designs.load();
    this.recoverInterrupted();
    if (this.settings.lastWorkspace && fs.existsSync(this.settings.lastWorkspace)) {
      try {
        this.workspace = new Workspace(this.settings.lastWorkspace);
      } catch {
        this.workspace = null;
      }
    }
    recoverWorktrees(this);
    this.persist();
    this.healthTimer = setInterval(() => this.healthCheck(), 5000);
    this.healthTimer.unref?.();
  }

  // ───────────────────────── events & persistence ─────────────────────────
  on(fn: (e: RuntimeEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(e: RuntimeEvent) {
    for (const l of this.listeners) {
      try {
        l(e);
      } catch (err) {
        console.error('[runtime] listener error', err);
      }
    }
  }

  toast(level: 'info' | 'warn' | 'error', message: string) {
    this.emit({ type: 'toast', level, message });
  }

  /** Write-behind: one row when `kind`/`id` are given, otherwise everything that changed. */
  persist(kind?: DocKind, id?: string) {
    if (kind) return this.store.markDirty(kind, id);
    this.store.markStateDirty();
    // tasks are compared by identity; live ones are re-checked by content (cheap: few are active)
    for (const t of this.tasks.values()) if (!TERMINAL.includes(t.state)) this.store.markDirty('tasks', t.id);
  }

  private persistedState(): PersistedState {
    const agentStats: PersistedState['agentStats'] = {};
    for (const a of this.agents.values()) agentStats[a.id] = { usage: a.usage, completed: a.completed, sessions: a.sessions, errors: a.errors };
    return {
      tasks: [...this.tasks.values()],
      debates: [...this.debates.values()],
      sessions: [...this.sessions.values()].slice(-300),
      memorials: [...this.memorials.values()],
      annotations: this.annotations.slice(-1000),
      news: this.news.slice(0, 200),
      agentStats,
      totals: this.totals,
      seqByDay: this.seqByDay,
    };
  }

  saveSettings() {
    this.store.markSettingsDirty();
  }

  flushAll() {
    this.store.flush({ full: true });
  }

  touch(task: Task) {
    task.updatedAt = now();
    this.store.markDirty('tasks', task.id);
    this.dirtyTasks.add(task.id);
    if (!this.flushScheduled) {
      this.flushScheduled = true;
      setImmediate(() => {
        this.flushScheduled = false;
        for (const id of this.dirtyTasks) {
          const t = this.tasks.get(id);
          if (t) this.emit({ type: 'task', task: t });
        }
        this.dirtyTasks.clear();
        this.persist();
      });
    }
  }

  snapshot(): Snapshot {
    return {
      tasks: [...this.tasks.values()],
      agents: [...this.agents.values()],
      debates: [...this.debates.values()],
      sessions: [...this.sessions.values()].slice(-200),
      memorials: [...this.memorials.values()],
      approvals: [...this.approvals.values()],
      annotations: this.annotations.slice(-300),
      news: this.news.slice(0, 100),
      settings: this.settings,
      providers: this.providers,
      skills: this.skills,
      mcp: this.mcp.list(),
      designs: this.designs.list(),
      templates: TEMPLATES,
      workspace: this.workspace?.root ?? null,
      dataDir: this.opts.dataDir,
      version: this.opts.version,
      platform: this.opts.platform,
      totals: this.totals,
    };
  }

  // ───────────────────────── activities (live observability) ─────────────────────────
  private activityLog(key: string) {
    let l = this.activityLogs.get(key);
    if (!l) {
      l = new JsonlLog<Activity>(path.join(this.opts.dataDir, 'activity', `${key.replace(/[^\w-]/g, '_')}.jsonl`));
      this.activityLogs.set(key, l);
    }
    return l;
  }

  activity(kind: ActivityKind, content: string, o: { taskId?: string; agentId?: AgentId; nodeId?: string; data?: Record<string, unknown>; streaming?: boolean } = {}): Activity {
    const a: Activity = { id: uid('ac'), at: now(), kind, content: redactSecrets(content), taskId: o.taskId, agentId: o.agentId, nodeId: o.nodeId, data: o.data, streaming: o.streaming };
    const key = o.taskId ?? '_global';
    let buf = this.activityBuf.get(key);
    if (!buf) {
      buf = [];
      this.activityBuf.set(key, buf);
    }
    buf.push(a);
    if (buf.length > 3000) buf.splice(0, buf.length - 3000);
    if (!a.streaming) this.activityLog(key).append(a);
    this.emit({ type: 'activity', activity: a });
    return a;
  }

  appendActivity(id: string, text: string) {
    if (!text) return;
    this.pendingDeltas.set(id, (this.pendingDeltas.get(id) ?? '') + text);
    if (!this.deltaTimer) this.deltaTimer = setTimeout(() => this.flushDeltas(), 60);
  }

  private flushDeltas() {
    this.deltaTimer = null;
    for (const [id, append] of this.pendingDeltas) this.emit({ type: 'activity_delta', id, append });
    this.pendingDeltas.clear();
  }

  finishActivity(a: Activity, finalContent: string) {
    this.pendingDeltas.delete(a.id);
    a.content = redactSecrets(finalContent);
    a.streaming = false;
    this.activityLog(a.taskId ?? '_global').append(a);
    this.emit({ type: 'activity', activity: a });
  }

  activities(taskId?: string, limit = 800): Activity[] {
    const key = taskId ?? '_global';
    const mem = this.activityBuf.get(key);
    if (mem && mem.length) return mem.slice(-limit);
    const disk = this.activityLog(key).readAll(limit);
    this.activityBuf.set(key, disk);
    return disk;
  }

  // ───────────────────────── agents & health ─────────────────────────
  setAgent(id: AgentId, patch: Partial<AgentRuntime>) {
    const a = this.agents.get(id);
    if (!a) return;
    Object.assign(a, patch);
    if (patch.status && patch.status !== 'idle') a.lastHeartbeat = now();
    if (patch.lastHeartbeat) {
      a.health = 'ok';
      this.alerted.delete(id);
    }
    this.emit({ type: 'agent', agent: a });
  }

  heartbeat(id: AgentId, taskId?: string) {
    const a = this.agents.get(id);
    if (!a) return;
    const t = now();
    const wasUnhealthy = a.health !== 'ok';
    a.lastHeartbeat = t;
    a.health = 'ok';
    this.alerted.delete(id);
    if (taskId) {
      const task = this.tasks.get(taskId);
      if (task) task.lastActivityAt = t;
    }
    // throttle agent events on heartbeat to 1/s
    if (wasUnhealthy || !(a as AgentRuntime & { _hbEmit?: number })._hbEmit || t - (a as AgentRuntime & { _hbEmit?: number })._hbEmit! > 1000) {
      (a as AgentRuntime & { _hbEmit?: number })._hbEmit = t;
      this.emit({ type: 'agent', agent: a });
    }
  }

  private healthCheck() {
    const t = now();
    for (const a of this.agents.values()) {
      if (!['thinking', 'writing', 'tool'].includes(a.status)) {
        if (a.health !== 'ok') this.setAgent(a.id, { health: 'ok' });
        continue;
      }
      const idle = t - a.lastHeartbeat;
      const h = idle > 120_000 ? 'alert' : idle > 45_000 ? 'stale' : 'ok';
      if (h !== a.health) {
        a.health = h;
        this.emit({ type: 'agent', agent: a });
        if (h === 'alert' && !this.alerted.has(a.id)) {
          this.alerted.add(a.id);
          this.activity('error', `${agentName(a.id)} 已 ${Math.round(idle / 1000)} 秒无心跳`, { taskId: a.taskId, agentId: a.id });
          this.opts.notify?.('Agent 健康告警', `${agentName(a.id)} 长时间无响应`);
        }
      }
    }
  }

  // ───────────────────────── model routing & accounting ─────────────────────────
  providerRuntime(providerId: string): ProviderRuntime {
    const cfg = this.providers.find((p) => p.id === providerId);
    if (!cfg) throw new Error(`模型服务 ${providerId} 不存在，请在「模型配置」中检查`);
    if (!cfg.enabled) throw new Error(`模型服务 ${cfg.name} 已停用`);
    return { config: cfg, apiKey: this.opts.secrets.get(`provider:${cfg.id}`) ?? '' };
  }

  /** Model for a call. `role` = a custom collaboration-design role (per-official overrides do not apply to it). */
  resolveModel(agentId: AgentId, task?: Task, role?: { id: string; modelClass: ModelClass; model?: ModelRef }): ModelRef {
    const valid = (r?: ModelRef | null): r is ModelRef => !!r && !!r.model && this.providers.some((p) => p.id === r.providerId && p.enabled) && !this.badModels.has(`${r.providerId}/${r.model}`);
    if (role) {
      const tr = task?.roleModels?.[role.id];
      if (valid(tr)) return tr;
      if (valid(role.model) && this.modelInfo(role.model)) return role.model;
    } else {
      const taskOverride = task?.agentModels?.[agentId];
      if (valid(taskOverride)) return taskOverride;
      const override = this.settings.agentModels[agentId];
      if (valid(override)) return override;
    }
    const cls = role ? role.modelClass : (AGENT_MAP[agentId]?.modelClass ?? 'economy');
    if ((cls === 'strong' || (!role && agentId === 'solo')) && valid(task?.strongModel)) return task!.strongModel!;
    const r = this.settings.routing;
    if (valid(r[cls])) return r[cls]!;
    if (valid(r.strong)) return r.strong!;
    if (valid(r.economy)) return r.economy!;
    if (valid(task?.strongModel)) return task!.strongModel!;
    const p = this.providers.find((x) => x.enabled && x.models.length);
    if (p) return { providerId: p.id, model: p.models[0].id };
    throw new Error('尚未配置可用模型：请在「模型配置」中添加模型服务（base_url、API Key、模型 id）');
  }

  /** task/role pairs already told that their chosen model is unavailable (one notice per edict, not per call) */
  roleModelWarned = new Set<string>();

  /** Models the service said it does not offer (wrong id, relay group, protocol) during this session: routing skips them. */
  badModels = new Set<string>();

  /** A working stand-in for a model the service rejected: the edict's main model first, then the routing defaults. */
  fallbackModel(failed: ModelRef, task?: Task): ModelRef | null {
    const ok = (r?: ModelRef | null): r is ModelRef => !!r && !!r.model && !(r.providerId === failed.providerId && r.model === failed.model)
      && this.providers.some((p) => p.id === r.providerId && p.enabled) && !this.badModels.has(`${r.providerId}/${r.model}`);
    for (const r of [task?.strongModel, this.settings.routing.strong, this.settings.routing.economy]) if (ok(r)) return r;
    return null;
  }

  /** Models whose service rejected reasoning params during this session (param error → auto fallback). */
  noReasoning = new Set<string>();

  /** 思考程度 for one call: per-agent override › task slider (strong-class / solo) › model default, clamped to the model's ladder. */
  resolveEffort(agentId: AgentId, model: ModelRef, task?: Task, roleClass?: ModelClass, roleEffort?: string): { level?: string; cfg: ReasoningConfig; protocol: Protocol } {
    const p = this.providers.find((x) => x.id === model.providerId);
    const protocol = (p?.protocol ?? 'openai-chat') as Protocol;
    const cfg = effectiveConfig(this.modelInfo(model)?.reasoning, model.model, protocol);
    if (this.noReasoning.has(`${model.providerId}/${model.model}`)) return { cfg, protocol };
    const cls = roleClass ?? AGENT_MAP[agentId]?.modelClass ?? 'economy';
    const want = (roleClass ? roleEffort : this.settings.agentEffort?.[agentId]) || ((cls === 'strong' || (!roleClass && agentId === 'solo')) ? task?.effort : undefined) || 'default';
    return { level: clampLevel(cfg, want), cfg, protocol };
  }

  modelInfo(ref: ModelRef) {
    const p = this.providers.find((x) => x.id === ref.providerId);
    return p?.models.find((m) => m.id === ref.model);
  }

  costOf(ref: ModelRef, u: { input: number; output: number; cached: number }): number {
    const m = this.modelInfo(ref);
    if (!m) return 0;
    const cachedPrice = m.cachedInputPrice ?? m.inputPrice;
    return ((u.input - u.cached) * m.inputPrice + u.cached * cachedPrice + u.output * m.outputPrice) / 1_000_000;
  }

  recordUsage(ref: ModelRef, u: { input: number; output: number; cached: number }, estimated: boolean, o: { task?: Task; node?: RunNode; agentId: AgentId; session?: Session }) {
    const delta: Usage = { inputTokens: u.input, outputTokens: u.output, cachedTokens: u.cached, costUsd: this.costOf(ref, u), calls: 1, estimated };
    if (o.task) {
      o.task.usage = addUsage(o.task.usage, delta);
      this.touch(o.task);
    }
    if (o.node) o.node.usage = addUsage(o.node.usage ?? emptyUsage(), delta);
    const a = this.agents.get(o.agentId);
    if (a) {
      a.usage = addUsage(a.usage, delta);
      this.emit({ type: 'agent', agent: a });
    }
    if (o.session) o.session.usage = addUsage(o.session.usage, delta);
    this.totals = addUsage(this.totals, delta);
    this.emit({ type: 'totals', totals: this.totals });
    this.persist();
    return delta;
  }

  /** Pre-dispatch estimate (tokens & cost) by tier. Used by the composer and stored on tasks. */
  estimate(text: string, tier: Tier, model?: ModelRef | null): { tokens: number; costUsd: number; breakdown: string } {
    const prompt = estimateTokens(text);
    const ctx = this.workspace ? 1800 : 300;
    const sys = 900;
    type Call = { in: number; out: number; strong: boolean };
    const calls: Call[] = [];
    const add = (n: number, c: Call) => {
      for (let i = 0; i < n; i++) calls.push(c);
    };
    if (tier === 'solo') add(6, { in: sys + ctx + prompt + 2500, out: 700, strong: true });
    else {
      add(1, { in: sys + prompt + 200, out: 120, strong: false }); // triage
      const subtasks = tier === 'full' ? 4 : 2;
      add(tier === 'full' ? 2 : 1, { in: sys + ctx + prompt + 1500, out: 1200, strong: true }); // plan (+ revision)
      add(tier === 'full' ? 2 : 1, { in: sys + prompt + 1800, out: 400, strong: true }); // review
      if (tier === 'full') add(1, { in: sys + 2000, out: 600, strong: false }); // dispatch
      add(subtasks * 5, { in: sys + ctx + 3000, out: 700, strong: false }); // exec loops
      add(1, { in: sys + 2500, out: 600, strong: false }); // summary
      if (tier === 'full') {
        add(1, { in: sys + 5000, out: 500, strong: true }); // result review
        if (this.settings.debateBeforePlan) add(this.settings.debateRounds * 4 + 1, { in: sys + 1500, out: 160, strong: false });
      }
    }
    let tokens = 0;
    let cost = 0;
    let strongRef: ModelRef | null = null;
    let econRef: ModelRef | null = null;
    try {
      strongRef = model ?? this.resolveModel('zhongshu');
      econRef = this.resolveModel('bingbu');
    } catch {
      /* no models configured */
    }
    for (const c of calls) {
      tokens += c.in + c.out;
      const ref = c.strong ? strongRef : econRef;
      if (ref) cost += this.costOf(ref, { input: c.in, output: c.out, cached: Math.round(c.in * 0.3) });
    }
    return { tokens, costUsd: +cost.toFixed(4), breakdown: `${calls.length} 次模型调用（强模型 ${calls.filter((c) => c.strong).length} 次）` };
  }

  // ───────────────────────── tasks & state machine ─────────────────────────
  newTaskId(): string {
    const d = ymd();
    this.seqByDay[d] = (this.seqByDay[d] ?? 0) + 1;
    return `JJC-${d}-${String(this.seqByDay[d]).padStart(3, '0')}`;
  }

  transition(task: Task, to: TaskState, actor: string, remark: string): void {
    const from = task.state;
    try {
      assertTransition(from, to, task.tier, actor);
    } catch (e) {
      if (e instanceof IllegalTransitionError) {
        this.audit.record(actor, 'transition_rejected', { from, to, reason: e.reason }, task.id);
        this.activity('error', `拒绝非法流转 ${STATE_LABEL[from]} → ${STATE_LABEL[to]}：${e.reason}`, { taskId: task.id });
      }
      throw e;
    }
    task.state = to;
    task.flow.push({ at: now(), from: STATE_LABEL[from], to: STATE_LABEL[to], remark, state: to });
    this.audit.record(actor, 'transition', { from, to, remark }, task.id);
    this.activity('state', `${STATE_LABEL[from]} → ${STATE_LABEL[to]}${remark ? `：${remark}` : ''}`, { taskId: task.id, data: { from, to, actor } });
    this.touch(task);
    if (TERMINAL.includes(to)) this.onTerminal(task);
  }

  getTask(id: string): Task {
    const t = this.tasks.get(id);
    if (!t) throw new Error(`任务 ${id} 不存在`);
    return t;
  }

  controller(taskId: string): AbortController {
    let c = this.controllers.get(taskId);
    if (!c || c.signal.aborted) {
      c = new AbortController();
      this.controllers.set(taskId, c);
    }
    return c;
  }

  setGate(task: Task, gate: Omit<Gate, 'since'>) {
    task.gate = { ...gate, since: now() };
    this.audit.record('system', 'gate_open', { kind: gate.kind, message: gate.message }, task.id);
    this.activity('gate', `⏸ 待皇上御批：${gate.message}`, { taskId: task.id, data: { kind: gate.kind } });
    this.opts.notify?.('奏折待批', `${task.title}：${gate.message}`);
    this.touch(task);
  }

  clearGate(task: Task) {
    task.gate = undefined;
    this.touch(task);
    this.wake(task.id);
  }

  // Pause / resume / budget checkpoints: agents call this before every LLM call and tool call.
  async checkpoint(task: Task | undefined, agentId?: AgentId): Promise<void> {
    if (!task) return;
    const signal = this.controllers.get(task.id)?.signal;
    let announced = false;
    while (true) {
      if (signal?.aborted || task.state === 'Cancelled') throw new TaskAbortedError();
      const budgetGate = task.gate?.kind === 'budget';
      if (!task.paused && !budgetGate) {
        if (task.budget.maxTokens && task.usage.inputTokens + task.usage.outputTokens > task.budget.maxTokens && !budgetGate) {
          this.setGate(task, { kind: 'budget', message: `Token 用量 ${task.usage.inputTokens + task.usage.outputTokens} 超过预算 ${task.budget.maxTokens}，是否追加预算继续？` });
          continue;
        }
        if (task.budget.maxCostUsd && task.usage.costUsd > task.budget.maxCostUsd) {
          this.setGate(task, { kind: 'budget', message: `费用 $${task.usage.costUsd.toFixed(3)} 超过上限 $${task.budget.maxCostUsd}，是否追加预算继续？` });
          continue;
        }
        if (announced && agentId) this.setAgent(agentId, { status: 'thinking', activity: '恢复执行' });
        return;
      }
      if (!announced && agentId) {
        this.setAgent(agentId, { status: 'paused', activity: task.paused ? '已叫停，等待恢复' : '预算超限，等待御批' });
        announced = true;
      }
      await new Promise<void>((resolve) => {
        let set = this.waiters.get(task.id);
        if (!set) {
          set = new Set();
          this.waiters.set(task.id, set);
        }
        set.add(resolve);
        signal?.addEventListener('abort', () => resolve(), { once: true });
      });
    }
  }

  wake(taskId: string) {
    const set = this.waiters.get(taskId);
    if (set) {
      this.waiters.delete(taskId);
      for (const r of set) r();
    }
  }

  pause(taskId: string) {
    const t = this.getTask(taskId);
    if (TERMINAL.includes(t.state)) throw new Error('任务已终结');
    t.paused = true;
    this.audit.record('emperor', 'pause', {}, t.id);
    this.activity('human', '皇上叫停此旨意', { taskId });
    this.touch(t);
  }

  resume(taskId: string) {
    const t = this.getTask(taskId);
    t.paused = false;
    this.audit.record('emperor', 'resume', {}, t.id);
    this.activity('human', '皇上恢复此旨意', { taskId });
    this.touch(t);
    this.wake(taskId);
    this.driveHook(taskId);
  }

  cancel(taskId: string, reason = '皇上取消') {
    const t = this.getTask(taskId);
    if (TERMINAL.includes(t.state)) return;
    this.transition(t, 'Cancelled', 'emperor', reason);
    this.controllers.get(taskId)?.abort();
    for (const n of t.nodes) if (n.status === 'running' || n.status === 'pending' || n.status === 'waiting') {
      n.status = 'cancelled';
      n.exitStatus = 'cancelled';
      n.endedAt = now();
    }
    for (const ap of this.approvals.values()) if (ap.taskId === taskId && ap.status === 'pending') this.decideApproval(ap.id, false, 'system');
    t.gate = undefined;
    this.touch(t);
    this.wake(taskId);
  }

  // ───────────────────────── approvals (high-risk confirmation) ─────────────────────────
  requestApproval(req: Omit<ApprovalRequest, 'id' | 'at' | 'status'>): Promise<boolean> {
    return this.requestDecision(req).then((d) => d.approve);
  }

  /** Ask the emperor; with `choices` the card offers those buttons (Codex-style) and the note box. */
  requestDecision(req: Omit<ApprovalRequest, 'id' | 'at' | 'status'>, o: { onId?: (id: string) => void } = {}): Promise<ApprovalDecision> {
    const ap: ApprovalRequest = { ...req, id: uid('ap'), at: now(), status: 'pending' };
    o.onId?.(ap.id);
    this.approvals.set(ap.id, ap);
    this.audit.record(req.agentId, 'approval_requested', { tool: req.tool, summary: req.summary, risk: req.risk, reason: req.reason, kind: req.kind ?? 'action' }, req.taskId);
    this.emit({ type: 'approval', approval: ap });
    this.opts.notify?.(req.risk === 'high' ? '高风险操作待确认' : req.kind === 'write_task' ? '写任务待批准' : '操作待批准', `${agentName(req.agentId)}：${req.summary}`);
    if (req.taskId) this.setAgent(req.agentId, { status: 'waiting', activity: `等待批准：${req.summary}` });
    const signal = req.taskId ? this.controllers.get(req.taskId)?.signal : undefined;
    return new Promise<ApprovalDecision>((resolve) => {
      this.approvalResolvers.set(ap.id, resolve);
      signal?.addEventListener('abort', () => this.decideApproval(ap.id, false, 'system'), { once: true });
    });
  }

  decideApproval(id: string, approve: boolean, actor = 'emperor', choice?: string, comment?: string) {
    const ap = this.approvals.get(id);
    if (!ap || ap.status !== 'pending') return;
    const note = (comment ?? '').trim() || undefined;
    if (ap.choices?.length && choice && actor !== 'system') {
      const c = ap.choices.find((x) => x.id === choice);
      if (!c) throw new Error(`无效的选项：${choice}`);
      if (c.comment === 'required' && !note) throw new Error('请先写明理由或要求');
      approve = c.approve;
    }
    const picked = choice && ap.choices?.some((x) => x.id === choice) && actor !== 'system' ? choice : approve ? 'once' : 'deny';
    ap.status = approve ? 'approved' : 'denied';
    ap.decidedAt = now();
    ap.choice = picked;
    ap.comment = note;
    this.audit.record(actor, approve ? 'approval_granted' : 'approval_denied', { tool: ap.tool, summary: ap.summary, choice: picked, comment: note ?? null }, ap.taskId);
    this.emit({ type: 'approval', approval: ap });
    const r = this.approvalResolvers.get(id);
    this.approvalResolvers.delete(id);
    r?.({ approve, choice: picked, comment: note });
    // keep list bounded
    if (this.approvals.size > 300) {
      for (const [k, v] of this.approvals) if (v.status !== 'pending') {
        this.approvals.delete(k);
        if (this.approvals.size <= 200) break;
      }
    }
  }

  // ───────────────────────── always-allow rules (R5) ─────────────────────────
  /** The workspace root permission rules are keyed by (a worktree maps back to its repository). */
  permRoot(task?: Task): string | null {
    return task?.repoRoot ?? task?.workspace ?? this.workspace?.root ?? null;
  }

  rulesFor(task?: Task): AllowRule[] {
    const root = this.permRoot(task);
    return [...(task?.allowRules ?? []), ...((root && this.settings.workspacePerms?.[root]?.rules) || [])];
  }

  releaseAllowed(task?: Task): boolean {
    const root = this.permRoot(task);
    return !!(root && this.settings.workspacePerms?.[root]?.releaseAlways);
  }

  addAllowRules(scope: 'task' | 'workspace', task: Task | undefined, keys: string[], label: string) {
    const rules = keys.map((key) => ({ key, label, at: now() }));
    if (scope === 'task') {
      if (!task) return;
      task.allowRules = [...(task.allowRules ?? []).filter((r) => !keys.includes(r.key)), ...rules];
      this.touch(task);
    } else {
      const root = this.permRoot(task);
      if (!root) return;
      const perms = { ...(this.settings.workspacePerms ?? {}) };
      const cur = perms[root] ?? { rules: [] };
      perms[root] = { ...cur, rules: [...cur.rules.filter((r) => !keys.includes(r.key)), ...rules] };
      this.settings = { ...this.settings, workspacePerms: perms };
      this.saveSettings();
      this.emit({ type: 'settings', settings: this.settings });
    }
    this.audit.record('emperor', 'allow_rule_added', { scope, keys, label, root: scope === 'workspace' ? this.permRoot(task) : null }, task?.id);
  }

  removeAllowRule(root: string, key: string) {
    const perms = { ...(this.settings.workspacePerms ?? {}) };
    const cur = perms[root];
    if (!cur) return;
    perms[root] = { ...cur, rules: cur.rules.filter((r) => r.key !== key) };
    this.settings = { ...this.settings, workspacePerms: perms };
    this.audit.record('emperor', 'allow_rule_removed', { root, key });
    this.saveSettings();
    this.emit({ type: 'settings', settings: this.settings });
  }

  setReleaseAlways(root: string, on: boolean) {
    const perms = { ...(this.settings.workspacePerms ?? {}) };
    perms[root] = { rules: perms[root]?.rules ?? [], releaseAlways: on };
    this.settings = { ...this.settings, workspacePerms: perms };
    this.audit.record('emperor', 'release_policy', { root, releaseAlways: on });
    this.saveSettings();
    this.emit({ type: 'settings', settings: this.settings });
  }

  // ───────────────────────── node signals & write lock ─────────────────────────
  /** Abort signal for work inside a node: the edict's cancel plus the node's own timeout. */
  signalFor(taskId: string, nodeId?: string): AbortSignal {
    const t = this.controller(taskId).signal;
    const n = nodeId ? this.nodeControllers.get(`${taskId}/${nodeId}`)?.signal : undefined;
    return n ? AbortSignal.any([t, n]) : t;
  }

  /** Wait until `nodeId` is the only writer of this edict (released when the node ends). */
  async acquireWriteLock(taskId: string, nodeId: string, signal?: AbortSignal): Promise<void> {
    const l = this.writeLocks.get(taskId);
    if (!l) {
      this.writeLocks.set(taskId, { holder: nodeId, queue: [] });
      return;
    }
    if (l.holder === nodeId) return;
    await new Promise<void>((resolve, reject) => {
      const entry = { nodeId, resolve };
      l.queue.push(entry);
      signal?.addEventListener('abort', () => {
        l.queue = l.queue.filter((q) => q !== entry);
        reject(new TaskAbortedError());
      }, { once: true });
    });
  }

  releaseWriteLock(taskId: string, nodeId: string) {
    const l = this.writeLocks.get(taskId);
    if (!l) return;
    l.queue = l.queue.filter((q) => q.nodeId !== nodeId);
    if (l.holder !== nodeId) return;
    const next = l.queue.shift();
    if (next) {
      l.holder = next.nodeId;
      next.resolve();
    } else this.writeLocks.delete(taskId);
  }

  // ───────────────────────── annotations (朱批) ─────────────────────────
  annotate(agentId: AgentId, text: string, taskId?: string): Annotation {
    const a: Annotation = { id: uid('an'), agentId, text, taskId, at: now() };
    this.annotations.push(a);
    this.audit.record('emperor', 'annotation', { agentId, text }, taskId);
    this.activity('annotation', `皇上朱批 → ${agentName(agentId)}：${text}`, { taskId, agentId });
    this.emit({ type: 'annotation', annotation: a });
    this.persist();
    return a;
  }

  pendingAnnotations(agentId: AgentId, taskId?: string): Annotation[] {
    return this.annotations.filter((a) => a.agentId === agentId && !a.consumedAt && (!a.taskId || a.taskId === taskId));
  }

  markAnnotationsConsumed(list: Annotation[]) {
    for (const a of list) {
      a.consumedAt = now();
      this.emit({ type: 'annotation', annotation: a });
    }
    this.persist();
  }

  respondAnnotations(list: Annotation[], response: string) {
    for (const a of list) {
      a.response = response.slice(0, 600);
      a.respondedAt = now();
      this.audit.record(a.agentId, 'annotation_response', { annotationId: a.id, response: a.response }, a.taskId);
      this.emit({ type: 'annotation', annotation: a });
    }
    this.persist();
  }

  // ───────────────────────── file changes & artifacts ─────────────────────────
  /**
   * Record one file change. `via: 'command'` marks a run_command side effect (R7). An oversize change passes
   * `op`: its content was not kept, so a null before / after there does not mean the file was absent.
   */
  recordChange(task: Task | undefined, agentId: AgentId, nodeId: string | undefined, rel: string, before: Buffer | null, after: Buffer | null, meta: { via?: 'tool' | 'command'; command?: string; op?: FileChange['op']; oversize?: boolean } = {}) {
    const ch: FileChange = {
      id: uid('fc'), taskId: task?.id ?? '', path: rel,
      op: meta.op ?? (before === null ? 'create' : after === null ? 'delete' : 'modify'),
      beforeHash: before === null ? null : this.blobs.put(before),
      afterHash: after === null ? null : this.blobs.put(after),
      agentId, nodeId, at: now(), via: meta.via ?? 'tool',
    };
    if (meta.command !== undefined) ch.command = meta.command.slice(0, 2000);
    if (meta.oversize) ch.oversize = true;
    if (looksBinary(before) || looksBinary(after)) ch.binary = true;
    if (task) {
      task.changes.push(ch);
      this.touch(task);
    }
    this.audit.record(agentId, 'file_change', { path: rel, op: ch.op, beforeHash: ch.beforeHash, afterHash: ch.afterHash, via: ch.via, ...(ch.command ? { command: truncate(ch.command, 300) } : {}), ...(ch.oversize ? { oversize: true } : {}) }, task?.id);
    const ws = task ? this.workspaceFor(task) : this.workspace;
    // a write inside an edict's worktree leaves the open workspace untouched
    if (!ws || ws === this.workspace) this.emit({ type: 'fs_changed', paths: [rel] });
    // (a worktree's language servers exist only once its agent used the lsp tool)
    void (!ws || ws === this.workspace ? this.lsp : this.lspByRoot.get(ws.root))?.notifyFilesChanged([rel]).catch(() => {});
    return ch;
  }

  /** Change LSP settings and persist them (lsp.json). */
  setLspConfig(patch: Partial<LspConfig>) {
    this.lsp.setConfig(patch);
    for (const m of this.lspByRoot.values()) m.setConfig(patch);
    saveLspConfig(path.join(this.opts.dataDir, 'lsp.json'), this.lsp.config);
    this.audit.record('emperor', 'lsp_config', { keys: Object.keys(patch) });
  }

  revertChange(taskId: string, changeId: string, force = false) {
    const t = this.getTask(taskId);
    const ch = t.changes.find((c) => c.id === changeId);
    if (!ch) throw new Error('改动记录不存在');
    if (ch.reverted) throw new Error('该改动已撤回');
    const ws = this.revertWorkspace(t);
    if (!this.revertable(ch)) throw new Error(ch.oversize ? '该文件超过快照大小上限，改动前的内容没有保存，无法撤回' : '改动前的内容已丢失，无法撤回');
    if (!force && this.diskHash(ws, ch.path) !== ch.afterHash) throw new Error('文件在此改动之后又被修改，撤回可能覆盖新内容（可强制撤回）');
    this.undoChange(ws, ch);
    this.audit.record('emperor', 'revert_change', { path: ch.path, changeId, via: ch.via ?? 'tool', force }, taskId);
    this.activity('human', `皇上撤回改动：${ch.path}`, { taskId });
    this.touch(t);
    this.changedOnDisk(ws, [ch.path]);
  }

  /** E3: revert every unreverted change one node made, newest first (see revertChanges). */
  revertNode(taskId: string, nodeId: string, o: { force?: boolean } = {}): RevertResult {
    const t = this.getTask(taskId);
    const n = t.nodes.find((x) => x.id === nodeId);
    if (!n) throw new Error('节点不存在');
    if (n.status === 'running') throw new Error(`「${n.label}」正在执行，不能撤回它的改动`);
    return this.revertChanges(t, t.changes.filter((c) => c.nodeId === nodeId), { force: !!o.force, scope: 'node', nodeId, label: n.label });
  }

  /** E3: revert every unreverted change of the edict, newest first (see revertChanges). */
  revertTask(taskId: string, o: { force?: boolean } = {}): RevertResult {
    const t = this.getTask(taskId);
    const busy = t.nodes.find((n) => n.status === 'running');
    if (busy) throw new Error(`「${busy.label}」正在执行，请先叫停或等它结束再整旨撤回`);
    return this.revertChanges(t, t.changes, { force: !!o.force, scope: 'task', label: t.title });
  }

  /**
   * Revert `list` newest first through the single-change logic. All-or-nothing on conflicts: a dry run first
   * replays the reverts against the disk state, and when any file no longer matches what the agent (or its
   * command) left there, nothing is touched and the conflicting files come back. `force` overwrites them.
   * Oversize changes (no stored content) are skipped and reported.
   */
  private revertChanges(t: Task, list: FileChange[], o: { force: boolean; scope: 'node' | 'task'; nodeId?: string; label: string }): RevertResult {
    const ws = this.revertWorkspace(t);
    const todo = list.filter((c) => !c.reverted).reverse(); // records are appended in order: reversed = newest first
    const uniq = (a: string[]) => [...new Set(a)];
    const virt = new Map<string, string | null>(); // path → content hash after the reverts planned so far
    const cur = (p: string) => (virt.has(p) ? virt.get(p)! : this.diskHash(ws, p));
    const plan: FileChange[] = [];
    const conflicts: string[] = [];
    const skipped: string[] = [];
    for (const ch of todo) {
      if (!this.revertable(ch)) {
        skipped.push(ch.path);
        continue;
      }
      if (!o.force && cur(ch.path) !== ch.afterHash) {
        conflicts.push(ch.path);
        continue;
      }
      virt.set(ch.path, ch.beforeHash);
      plan.push(ch);
    }
    const res: RevertResult = { reverted: [], conflicts: uniq(conflicts), skipped: uniq(skipped) };
    if (!conflicts.length) {
      for (const ch of plan) {
        this.undoChange(ws, ch);
        this.audit.record('emperor', 'revert_change', { path: ch.path, changeId: ch.id, via: ch.via ?? 'tool', scope: o.scope, force: o.force }, t.id);
      }
      res.reverted = uniq(plan.map((c) => c.path));
    }
    this.audit.record('emperor', o.scope === 'node' ? 'revert_node' : 'revert_task', { nodeId: o.nodeId ?? null, changes: plan.length, reverted: res.reverted, conflicts: res.conflicts, skipped: res.skipped, force: o.force }, t.id);
    const what = o.scope === 'node' ? `「${o.label}」的改动` : '本旨意的全部改动';
    if (res.conflicts.length) this.activity('human', `撤回${what}未执行：${res.conflicts.join('、')} 在之后又被修改（可强制撤回）`, { taskId: t.id, nodeId: o.nodeId });
    else if (res.reverted.length) this.activity('human', `皇上撤回${what}：${res.reverted.length} 个文件${res.skipped.length ? `；${res.skipped.length} 个大文件无法撤回` : ''}`, { taskId: t.id, nodeId: o.nodeId });
    if (res.reverted.length) {
      this.touch(t);
      this.changedOnDisk(ws, res.reverted);
    }
    return res;
  }

  /** The workspace a revert writes to: the edict's own (the open folder, or its active worktree). */
  private revertWorkspace(t: Task): Workspace {
    const ws = this.workspaceFor(t);
    if (!ws) throw new Error(t.worktree && t.worktree.status !== 'active' ? '本旨意的工作树已结案处理（合并 / 保留 / 丢弃），不能在此撤回改动' : '本旨意的工作区当前不可用（已切换到别的文件夹，或独立工作树已不存在）');
    return ws;
  }

  /** fs_changed only for the open workspace (an edict worktree is not on screen); LSP of whichever root changed. */
  private changedOnDisk(ws: Workspace, paths: string[]) {
    if (ws === this.workspace) this.emit({ type: 'fs_changed', paths });
    void (ws === this.workspace ? this.lsp : this.lspByRoot.get(ws.root))?.notifyFilesChanged(paths).catch(() => {});
  }

  private revertable(ch: FileChange): boolean {
    return !ch.oversize && (ch.beforeHash === null || this.blobs.has(ch.beforeHash));
  }

  private diskHash(ws: Workspace, rel: string): string | null {
    const b = ws.readBuffer(rel);
    return b ? sha256(b) : null;
  }

  /** Put back the content from before `ch` (binary-safe) and mark it reverted. */
  private undoChange(ws: Workspace, ch: FileChange) {
    if (ch.beforeHash === null) ws.remove(ch.path);
    else ws.write(ch.path, this.blobs.get(ch.beforeHash)!);
    ch.reverted = true;
  }

  requireWorkspace(): Workspace {
    if (!this.workspace) throw new Error('尚未打开工作区：请先选择项目文件夹');
    return this.workspace;
  }

  /**
   * The folder an edict reads and writes: its active worktree, else the open workspace when it is the one the
   * edict was submitted on, else null. Without a task (chat, the editor) it is the open workspace.
   */
  workspaceFor(task?: Task | null): Workspace | null {
    if (!task) return this.workspace;
    const w = task.worktree;
    if (w?.status === 'active') {
      const dir = edictDir(w);
      return fs.existsSync(dir) ? this.wsAt(dir) : null;
    }
    return this.workspace && task.workspace === this.workspace.root ? this.workspace : null;
  }

  /** Cached Workspace for a folder (the open one is reused). */
  wsAt(dir: string): Workspace {
    const root = path.resolve(dir);
    if (this.workspace?.root === root) return this.workspace;
    let w = this.wsCache.get(root);
    if (!w) {
      w = new Workspace(root);
      this.wsCache.set(root, w);
    }
    return w;
  }

  /** A folder went away (worktree removed): drop its Workspace and stop its language servers. */
  forgetWorkspace(dir: string) {
    const root = path.resolve(dir);
    this.wsCache.delete(root);
    const m = this.lspByRoot.get(root);
    if (m) {
      this.lspByRoot.delete(root);
      void m.dispose();
    }
  }

  /** Language servers for a workspace: the editor's manager for the open one, a separate one per worktree. */
  lspFor(ws: Workspace): LspManager {
    if (this.workspace && ws.root === this.workspace.root) return this.lsp;
    let m = this.lspByRoot.get(ws.root);
    if (!m) {
      m = new LspManager({ workspace: ws, config: this.lsp.config, clientVersion: this.opts.version });
      this.lspByRoot.set(ws.root, m);
    }
    return m;
  }

  /** Folder behind a preview:// host: `ws` = the open workspace, `wt-<task id>` = that edict's worktree. */
  previewRoot(host: string): string | null {
    const h = host.toLowerCase();
    if (h === 'ws') return this.workspace?.root ?? null;
    const t = taskIdFromPreviewHost(h) ? [...this.tasks.values()].find((x) => previewHostFor(x.id) === h) : undefined;
    return t?.worktree?.status === 'active' ? (this.workspaceFor(t)?.root ?? null) : null;
  }

  setWorkspace(dir: string | null) {
    this.workspace = dir ? new Workspace(dir) : null;
    this.settings.lastWorkspace = this.workspace?.root ?? null;
    this.saveSettings();
    this.audit.record('emperor', 'open_workspace', { path: this.workspace?.root ?? null });
    this.emit({ type: 'workspace', workspace: this.workspace?.root ?? null });
  }

  // ───────────────────────── memorials (奏折阁) ─────────────────────────
  onTerminal(task: Task) {
    this.controllers.delete(task.id);
    // verified artifacts: recompute hashes from disk (never trust the model's claim)
    const ws = this.workspaceFor(task);
    if (ws) {
      const seen = new Map<string, FileChange>();
      for (const c of task.changes) if (!c.reverted) seen.set(c.path, c);
      const arts = [];
      for (const [p, c] of seen) {
        // oversize files (command side effects past the snapshot cap) are hashed in chunks, not loaded whole
        let d: { sha256: string; bytes: number } | null = null;
        try {
          const buf = c.oversize ? null : ws.readBuffer(p);
          d = c.oversize ? fileDigest(ws, p) : buf && { sha256: sha256(buf), bytes: buf.length };
        } catch {
          /* path no longer inside the workspace */
        }
        if (d) arts.push({ path: p, ...d, agentId: c.agentId, nodeId: c.nodeId, at: now() });
      }
      task.result = { summary: task.result?.summary ?? '', artifacts: arts };
    }
    const m = buildMemorial(task);
    this.memorials.set(task.id, m);
    this.audit.record('system', 'memorial_archived', { state: task.state, artifacts: m.artifacts.map((a) => ({ path: a.path, sha256: a.sha256 })), usage: task.usage }, task.id);
    this.emit({ type: 'memorial', memorial: m });
    if (task.state === 'Done') {
      this.pushNews({ title: `捷报：「${task.title}」已完成`, source: '军机处', category: '朝廷', summary: task.result?.summary?.slice(0, 120) });
      this.opts.notify?.('旨意完成', task.title);
    }
    // 结案 dialog for an edict's own worktree (after the caller finished, e.g. cancel() closing its cards)
    if (task.worktree?.status === 'active') setImmediate(() => raiseWorktreeCard(this, task));
    this.persist();
  }

  pushNews(n: Omit<NewsItem, 'id' | 'at'> & { at?: number }) {
    const item: NewsItem = { id: uid('nw'), at: n.at ?? now(), ...n } as NewsItem;
    this.news.unshift(item);
    this.news = this.news.slice(0, 200);
    this.emit({ type: 'news', news: this.news.slice(0, 100) });
    this.persist();
  }

  memorialMarkdown(taskId: string): string {
    const m = this.memorials.get(taskId);
    if (!m) throw new Error('奏折不存在');
    const lines = [`# 奏折 · ${m.title}`, '', `- 旨意编号：${m.taskId}`, `- 协同档位：${m.tier}`, `- 终态：${STATE_LABEL[m.finalState]}`, `- 归档时间：${new Date(m.archivedAt).toLocaleString()}`, `- Token：输入 ${m.usage.inputTokens} / 输出 ${m.usage.outputTokens}（缓存 ${m.usage.cachedTokens}），费用 $${m.usage.costUsd.toFixed(4)}`, `- 模型：${m.models.join(', ') || '—'}`, '', '## 原旨', '', m.edict, ''];
    for (const s of m.stages) {
      lines.push(`## ${s.label}${s.at ? `（${new Date(s.at).toLocaleString()}）` : ''}`, '');
      for (const i of s.items) lines.push(`- ${i.replace(/\n/g, ' ')}`);
      lines.push('');
    }
    lines.push('## 产物（系统核验哈希）', '');
    for (const a of m.artifacts) lines.push(`- \`${a.path}\` sha256=${a.sha256.slice(0, 16)}… ${a.bytes}B`);
    lines.push('', '## 运行记录', '');
    for (const r of m.runs) lines.push(`- ${r.label} · run=${r.runId ?? '—'} · model=${r.model ?? '—'} · exit=${r.exitStatus ?? '—'}`);
    return lines.join('\n');
  }

  // ───────────────────────── providers & settings ─────────────────────────
  updateSettings(patch: Partial<Settings>) {
    this.settings = { ...this.settings, ...patch };
    this.audit.record('emperor', 'settings_update', { keys: Object.keys(patch) });
    this.saveSettings();
    this.emit({ type: 'settings', settings: this.settings });
  }

  setAgentModel(agentId: AgentId, ref: ModelRef | null) {
    const m = { ...this.settings.agentModels };
    if (ref) m[agentId] = ref;
    else delete m[agentId];
    this.settings = { ...this.settings, agentModels: m };
    this.audit.record('emperor', 'agent_model_switch', { agentId, model: ref ? `${ref.providerId}/${ref.model}` : 'default' });
    this.activity('human', `模型热切换：${agentName(agentId)} → ${ref ? ref.model : '默认路由'}`, { agentId });
    this.saveSettings();
    this.emit({ type: 'settings', settings: this.settings });
  }

  upsertProvider(cfg: Omit<ProviderConfig, 'hasKey'> & { hasKey?: boolean }, apiKey?: string | null) {
    const id = cfg.id || uid('pv');
    const clean: ProviderConfig = {
      id, name: cfg.name || '未命名服务', preset: cfg.preset || 'custom', protocol: cfg.protocol, baseUrl: (cfg.baseUrl || '').trim(),
      models: (cfg.models || []).filter((m) => m.id?.trim()).map((m) => ({ id: m.id.trim(), label: m.label, inputPrice: +m.inputPrice || 0, outputPrice: +m.outputPrice || 0, cachedInputPrice: m.cachedInputPrice === undefined || m.cachedInputPrice === null || (m.cachedInputPrice as unknown) === '' ? undefined : +m.cachedInputPrice, contextWindow: +m.contextWindow || 128000, maxOutputTokens: m.maxOutputTokens ? Math.max(256, +m.maxOutputTokens) : undefined, reasoning: sanitizeReasoning(m.reasoning) })),
      hasKey: false, extraHeaders: cfg.extraHeaders, replayReasoning: !!cfg.replayReasoning, enabled: cfg.enabled !== false,
    };
    if (apiKey !== undefined && apiKey !== null) {
      if (apiKey === '') this.opts.secrets.delete(`provider:${id}`);
      else this.opts.secrets.set(`provider:${id}`, apiKey);
    }
    clean.hasKey = !!this.opts.secrets.get(`provider:${id}`);
    const i = this.providers.findIndex((p) => p.id === id);
    if (i >= 0) this.providers[i] = clean;
    else this.providers.push(clean);
    // first provider → default routing
    if (!this.settings.routing.strong && clean.models[0]) this.settings.routing.strong = { providerId: id, model: clean.models[0].id };
    if (!this.settings.routing.economy && clean.models[0]) this.settings.routing.economy = { providerId: id, model: clean.models[clean.models.length > 1 ? 1 : 0].id };
    this.audit.record('emperor', 'provider_upsert', { id, name: clean.name, protocol: clean.protocol, baseUrl: clean.baseUrl, models: clean.models.map((m) => m.id), keyChanged: apiKey !== undefined && apiKey !== null });
    this.saveSettings();
    this.emit({ type: 'providers', providers: this.providers });
    this.emit({ type: 'settings', settings: this.settings });
    return clean;
  }

  deleteProvider(id: string) {
    this.providers = this.providers.filter((p) => p.id !== id);
    this.opts.secrets.delete(`provider:${id}`);
    const r = this.settings.routing;
    if (r.strong?.providerId === id) r.strong = null;
    if (r.economy?.providerId === id) r.economy = null;
    for (const [k, v] of Object.entries(this.settings.agentModels)) if (v?.providerId === id) delete this.settings.agentModels[k as AgentId];
    this.audit.record('emperor', 'provider_delete', { id });
    this.saveSettings();
    this.emit({ type: 'providers', providers: this.providers });
    this.emit({ type: 'settings', settings: this.settings });
  }

  async testProvider(id: string, model: string): Promise<{ ok: boolean; message: string; latencyMs: number; hint?: string }> {
    const started = now();
    try {
      const p = this.providerRuntime(id);
      const r = await streamLlm(p, model, { system: '你是连接测试助手。', messages: [{ role: 'user', content: '只回复两个字：在线' }], maxTokens: 20, idleTimeoutMs: 30000 }, this.opts.fetchImpl);
      return { ok: true, message: `连接成功：${(r.text || r.reasoning).slice(0, 60)}（输入 ${r.usage.input} / 输出 ${r.usage.output} tokens）`, latencyMs: now() - started };
    } catch (e) {
      const info = classifyLlmError(e);
      return { ok: false, message: redactSecrets(info.raw).slice(0, 600), hint: info.hint, latencyMs: now() - started };
    }
  }

  /**
   * 协议探测：same base_url / key / model, tried as Chat Completions, Responses and Messages,
   * each plain and with a reasoning level. Requests go only to the configured base_url.
   */
  async probeProvider(id: string, model: string, level?: string): Promise<ProbeRow[]> {
    const base = this.providerRuntime(id);
    const protocols: Protocol[] = ['openai-chat', 'openai-responses', 'anthropic-messages'];
    const one = async (protocol: Protocol, withReasoning: boolean): Promise<ProbeCell> => {
      const p: ProviderRuntime = { ...base, config: { ...base.config, protocol } };
      const cfg = effectiveConfig(this.modelInfo({ providerId: id, model })?.reasoning, model, protocol);
      let extraBody: Record<string, unknown> | undefined;
      let dropTemperature = false;
      let lv: string | undefined;
      if (withReasoning) {
        lv = clampLevel(cfg, level ?? 'low');
        if (!lv) return { ok: false, skipped: true, message: '该模型未配置思考档位', latencyMs: 0 };
        const rp = reasoningParams(cfg, lv, protocol);
        extraBody = rp.body;
        dropTemperature = !!rp.dropTemperature;
      }
      const started = now();
      try {
        const r = await streamLlm(p, model, { system: '你是连接测试助手。', messages: [{ role: 'user', content: '只回复两个字：在线' }], maxTokens: withReasoning ? 2048 : 20, idleTimeoutMs: 30000, extraBody, dropTemperature }, this.opts.fetchImpl);
        return { ok: true, message: `${(r.text || r.reasoning || '（空回复）').slice(0, 40)}${r.reasoning ? ' · 有思考输出' : ''}`, latencyMs: now() - started, level: lv };
      } catch (e) {
        const info = classifyLlmError(e);
        return { ok: false, kind: info.kind, status: info.status, message: redactSecrets(info.raw).slice(0, 300), hint: info.hint, latencyMs: now() - started, level: lv };
      }
    };
    const rows = await Promise.all(protocols.map(async (protocol) => {
      const plain = await one(protocol, false);
      const reasoning = plain.ok ? await one(protocol, true) : { ok: false, skipped: true, message: '基础请求未通过，跳过', latencyMs: 0 };
      return { protocol, plain, reasoning };
    }));
    this.audit.record('emperor', 'provider_probe', { providerId: id, model, result: rows.map((r) => `${r.protocol}:${r.plain.ok ? 'ok' : r.plain.status ?? r.plain.kind}/${r.reasoning.ok ? 'ok' : r.reasoning.skipped ? '-' : r.reasoning.status ?? r.reasoning.kind}`) });
    return rows;
  }

  /**
   * 检测思考档位：ask the service which reasoning levels this model accepts — one tiny request per level name.
   * A made-up level is sent first: a service that accepts that too doesn't validate levels, so the result is a guess
   * (name preset, or the five-step fallback ladder). The outcome is saved on the model.
   */
  async detectReasoning(providerId: string, modelId: string): Promise<ReasoningDetectResult> {
    const base = this.providerRuntime(providerId);
    const info = this.modelInfo({ providerId, model: modelId });
    if (!info) return { ok: false, message: `模型 ${modelId} 还没保存到「${base.config.name}」，请先保存` };
    const protocol = base.config.protocol;
    const preset = presetFor(modelId, protocol);
    const current = info.reasoning ?? preset;
    const valueStyles: ReasoningStyle[] = ['openai', 'anthropic'];
    const style: ReasoningStyle = valueStyles.includes(current.style) ? current.style : current.style === 'none' ? (protocol === 'anthropic-messages' ? 'anthropic' : 'openai') : current.style;
    if (!valueStyles.includes(style)) return { ok: false, message: `${STYLE_LABEL[style]} 的档位不能逐个检测，保留现有设置` };
    const probeCfg: ReasoningConfig = { style, levels: [], default: '' };
    const ask = async (level?: string): Promise<'ok' | 'rejected' | ErrorInfo> => {
      const rp = level ? reasoningParams(probeCfg, level, protocol) : { body: undefined, dropTemperature: false };
      try {
        await streamLlm(base, modelId, { system: '你是连接测试助手。', messages: [{ role: 'user', content: '回复：在' }], maxTokens: 16, idleTimeoutMs: 30000, extraBody: rp.body, dropTemperature: !!rp.dropTemperature }, this.opts.fetchImpl);
        return 'ok';
      } catch (e) {
        const er = classifyLlmError(e);
        return level && (er.kind === 'param' || er.status === 400 || er.status === 422) ? 'rejected' : er;
      }
    };
    const fail = (er: ErrorInfo, what: string) => ({ ok: false, message: `检测中断（${what}）：${er.hint}`.slice(0, 300) });
    const plain = await ask();
    if (plain !== 'ok') return fail(plain as ErrorInfo, '基础请求失败');
    const bogus = await ask('edict-made-up');
    if (bogus !== 'ok' && bogus !== 'rejected') return fail(bogus, '服务出错');
    const accepted: string[] = [];
    const rejected: string[] = [];
    if (bogus === 'rejected') {
      for (const l of DETECT_CANDIDATES) {
        const r = await ask(l);
        if (r === 'ok') accepted.push(l);
        else if (r === 'rejected') rejected.push(l);
        else return fail(r, `检测 ${levelLabel(l)} 时出错`);
      }
    }
    const reliable = bogus === 'rejected';
    const detected = { at: now(), reliable, accepted, rejected };
    let next: ReasoningConfig;
    // unconfirmed: keep what the user set by hand, else the name guess, else the five-step fallback
    const guess = info.reasoning ?? (preset.style !== 'none' ? preset : fallbackLadder(protocol));
    if (!reliable) next = { ...guess, detected };
    else if (!accepted.length) next = { style: 'none', levels: [], default: '', detected };
    else {
      const levels = LEVEL_RANK.filter((l) => accepted.includes(l));
      const def = [current.default, 'medium', 'high'].find((l) => l && levels.includes(l)) ?? levels[Math.floor(levels.length / 2)];
      next = { style, levels, default: def, detected };
    }
    const p = this.providers.find((x) => x.id === providerId)!;
    this.upsertProvider({ ...p, models: p.models.map((m) => (m.id === modelId ? { ...m, reasoning: next } : m)) });
    const saved = this.modelInfo({ providerId, model: modelId })?.reasoning;
    this.audit.record('emperor', 'reasoning_detect', { providerId, model: modelId, reliable, accepted, rejected });
    const names = (a: string[]) => a.map(levelLabel).join(' · ');
    const message = !reliable
      ? `这个服务不校验思考档位（乱写的档位也被接受），无法确认；${info.reasoning ? '保留现有设置' : preset.style !== 'none' ? '暂按模型名推测' : '暂按通用五档'}：${names(saved?.levels ?? []) || '不发送'}`
      : accepted.length ? `检测到 ${accepted.length} 档：${names(saved?.levels ?? [])}` : '这个模型不接受思考档位参数，将不发送思考参数';
    return { ok: true, reasoning: saved, message };
  }

  async fetchModels(id: string): Promise<string[]> {
    return listRemoteModels(this.providerRuntime(id), this.opts.fetchImpl);
  }

  presets() {
    return PROVIDER_PRESETS;
  }

  // ───────────────────────── recovery ─────────────────────────
  private recoverInterrupted() {
    // nodes that only read or talk can simply run again; anything that may have changed files waits for the emperor
    const NO_TOOLS_KINDS = ['triage', 'debate', 'plan', 'review', 'dispatch', 'summary', 'result_review'];
    const resumable = (n: RunNode) => this.settings.autoResumeSafe !== false && (n.sideEffects === false || (n.sideEffects === undefined && NO_TOOLS_KINDS.includes(n.kind)));
    for (const t of this.tasks.values()) {
      if (TERMINAL.includes(t.state)) continue;
      let interrupted = false;
      const resumed: string[] = [];
      for (const n of t.nodes) {
        // an exec node waiting on its write-task dialog had not started: ask again after the restart
        if (n.status === 'waiting' && n.kind === 'exec') n.status = 'pending';
        if (n.status !== 'running') continue;
        if (resumable(n)) {
          n.status = 'pending';
          n.endedAt = undefined;
          resumed.push(n.label);
          continue;
        }
        n.status = 'failed';
        n.exitStatus = 'interrupted';
        n.error = '应用退出导致运行中断';
        n.endedAt = now();
        interrupted = true;
      }
      if (resumed.length || interrupted) this.store.markDirty('tasks', t.id);
      if (resumed.length) {
        this.audit.record('system', 'node_auto_resume', { nodes: resumed }, t.id);
        this.activity('log', `应用重启：${resumed.join('、')} 中断时没有改动过文件，已自动续跑`, { taskId: t.id });
      }
      if (interrupted && t.state !== 'Blocked') {
        t.resumeState = t.state;
        const from = t.state;
        t.state = 'Blocked';
        t.blockedReason = '应用重启：运行中的节点可能已改动文件，已中断；可「重试失败节点」局部恢复';
        t.flow.push({ at: now(), from: STATE_LABEL[from], to: STATE_LABEL.Blocked, remark: t.blockedReason, state: 'Blocked' });
        this.audit.record('system', 'transition', { from, to: 'Blocked', remark: t.blockedReason }, t.id);
      }
    }
    for (const d of this.debates.values()) if (d.status === 'running') d.status = 'paused';
  }

  dispose() {
    this.mcp.dispose();
    void this.lsp.dispose();
    for (const m of this.lspByRoot.values()) void m.dispose();
    this.lspByRoot.clear();
    if (this.healthTimer) clearInterval(this.healthTimer);
    for (const c of this.controllers.values()) c.abort();
    this.flushAll();
    this.store.close();
  }
}

function fileDigest(ws: Workspace, rel: string): { sha256: string; bytes: number } | null {
  let fd: number | undefined;
  try {
    fd = fs.openSync(ws.resolve(rel), 'r');
    const h = createHash('sha256');
    const chunk = Buffer.alloc(1 << 20);
    let bytes = 0;
    for (let n; (n = fs.readSync(fd, chunk, 0, chunk.length, null)) > 0; bytes += n) h.update(chunk.subarray(0, n));
    return { sha256: h.digest('hex'), bytes };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** NUL bytes near the start: treat as binary (no text diff). */
export const looksBinary = (b: Buffer | null | undefined): boolean => !!b && b.subarray(0, 8000).includes(0);

export function buildMemorial(task: Task): Memorial {
  const nodes = task.nodes;
  const byKind = (k: string) => nodes.filter((n) => n.kind === k);
  const firstAt = (arr: RunNode[]) => arr.map((n) => n.startedAt).filter(Boolean).sort()[0];
  const stages: Memorial['stages'] = [
    { key: 'edict', label: '圣旨', at: task.createdAt, items: [task.edict.slice(0, 500), `档位：${task.tier}`] },
    { key: 'zhongshu', label: '中书规划', at: firstAt(byKind('plan')), items: task.planHistory.map((p) => `v${p.version}（${p.author === 'emperor' ? '皇上涂改' : '中书省'}）：${p.plan.summary}；子任务 ${p.plan.subtasks.map((s) => `${s.id}[${s.dept}]${s.title}`).join('、')}`) },
    { key: 'menxia', label: '门下审议', at: firstAt(byKind('review')), items: task.reviews.map((r) => `${r.stage === 'plan' ? '方案' : '成果'}第 ${r.round} 轮 · ${r.reviewer === 'emperor' ? '皇上' : '门下省'}：${r.verdict === 'approve' ? '✅ 准奏' : '❌ 封驳'} ${r.comment}${r.issues.length ? ' — ' + r.issues.join('；') : ''}`) },
    { key: 'ministries', label: '六部执行', at: firstAt([...byKind('exec'), ...byKind('solo')]), items: [...byKind('exec'), ...byKind('solo')].map((n) => `${agentName(n.agentId)}「${n.label}」：${n.status}${n.output ? ' — ' + n.output.slice(0, 200) : ''}`) },
    { key: 'report', label: '回奏', at: task.updatedAt, items: [task.result?.summary || '（无回奏正文）'] },
  ];
  // E8: skills the officials actually loaded (with the text hash, so the exact version is on record)
  if (task.skillsUsed?.length) stages.splice(stages.length - 1, 0, { key: 'skills', label: '所用技能', at: task.skillsUsed[0].at, items: task.skillsUsed.map((u) => `${agentName(u.agentId)} 加载 ${u.name}（sha256:${u.sha256.slice(0, 12)}）`) });
  // E1: what the officials asked the emperor, and the answers they worked from
  if (task.questions?.length) stages.splice(stages.length - 1, 0, { key: 'questions', label: '请旨记录', at: task.questions[0].at, items: task.questions.map((q) => `${agentName(q.agentId)} 问：${q.question} —— ${q.answer ? `答：${q.answer}` : '未答复'}`) });
  return {
    taskId: task.id, title: task.title, edict: task.edict, tier: task.tier, finalState: task.state, archivedAt: now(), stages,
    artifacts: task.result?.artifacts ?? [], usage: task.usage,
    models: [...new Set(nodes.map((n) => n.model).filter(Boolean) as string[])],
    runs: nodes.map((n) => ({ nodeId: n.id, label: n.label, runId: n.runId, model: n.model, exitStatus: n.exitStatus, startedAt: n.startedAt, endedAt: n.endedAt })),
    flow: task.flow,
    skillsUsed: task.skillsUsed,
  };
}

export type { Plan };
