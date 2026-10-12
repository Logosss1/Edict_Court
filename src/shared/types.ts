// Shared domain types — used by main process runtime and renderer (both modes).
// Single source of truth: the runtime in the main process owns all state; the
// workbench and the pixel court are two projections of the same data.

import type { CollabDesign, DesignPin, DesignInfo } from './design';
export type { CollabDesign, DesignPin, DesignInfo } from './design';

/** Interpreter state of a non-native design run. */
export interface FlowRun {
  cursor: number; // index of the step (group) currently executing
  iter: Record<string, number>; // per-step iteration (bumped when a review loops back)
  rejections: Record<string, number>; // per review/gate step
  skipped?: string[];
  lastReview?: Record<string, string>; // review step id → node whose verdict was applied
}

export type TaskState =
  | 'Pending'
  | 'Taizi'
  | 'Zhongshu'
  | 'Menxia'
  | 'Assigned'
  | 'Next'
  | 'Doing'
  | 'Review'
  | 'PendingConfirm'
  | 'Done'
  | 'Blocked'
  | 'Cancelled';

export type Tier = 'solo' | 'lite' | 'full';

export type AgentId =
  | 'taizi'
  | 'zhongshu'
  | 'menxia'
  | 'shangshu'
  | 'hubu'
  | 'libu'
  | 'bingbu'
  | 'xingbu'
  | 'gongbu'
  | 'libu_hr'
  | 'zaochao'
  | 'solo';

export type MinistryId = 'hubu' | 'libu' | 'bingbu' | 'xingbu' | 'gongbu' | 'libu_hr';

export type ModelClass = 'strong' | 'economy';

export interface ModelRef {
  providerId: string;
  model: string;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  costUsd: number;
  calls: number;
  estimated?: boolean; // true when provider did not report usage and we estimated
}

export interface FlowEntry {
  at: number;
  from: string; // 部门/角色 display
  to: string;
  remark: string;
  state?: TaskState;
}

/** What a subtask does to the workspace: read (research / review, runs in parallel), write (changes files), verify (runs tests / builds). */
export type SubtaskEffect = 'read' | 'write' | 'verify';

export interface Subtask {
  id: string;
  title: string;
  dept: MinistryId;
  detail: string;
  acceptance: string;
  dependsOn: string[];
  /** missing = read */
  effect?: SubtaskEffect;
}

/** What the emperor granted one exec node: write (normal permission mode), write_free (no asks except high risk), readonly. */
export type NodeGrant = 'write' | 'write_free' | 'readonly';

export interface Plan {
  summary: string;
  subtasks: Subtask[];
  risks: string[];
}

export interface PlanVersion {
  version: number;
  plan: Plan;
  author: 'zhongshu' | 'emperor';
  at: number;
  note?: string;
}

export interface Review {
  round: number;
  stage: 'plan' | 'result';
  verdict: 'approve' | 'reject';
  issues: string[];
  comment: string;
  reviewer: 'menxia' | 'emperor';
  at: number;
}

export type NodeKind =
  | 'triage'
  | 'debate'
  | 'plan'
  | 'review'
  | 'gate'
  | 'dispatch'
  | 'exec'
  | 'summary'
  | 'result_review'
  | 'solo'
  | 'step';

export type NodeStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped' | 'waiting' | 'cancelled';

export interface RunNode {
  id: string;
  kind: NodeKind;
  agentId: AgentId;
  label: string;
  status: NodeStatus;
  subtaskId?: string;
  attempts: number;
  runId?: string;
  model?: string;
  providerId?: string;
  protocol?: string;
  startedAt?: number;
  endedAt?: number;
  exitStatus?: 'ok' | 'error' | 'cancelled' | 'interrupted' | 'rejected';
  error?: string;
  errorInfo?: ErrorInfo;
  effort?: string; // thinking level actually sent
  stepId?: string; // 协同设计 step this node runs (interpreter)
  iter?: number; // loop iteration of that step
  roleId?: string; // custom role id (agentId then holds the role's court avatar)
  roleName?: string;
  output?: string; // structured conclusion (JSON string or text)
  usage?: Usage;
  effect?: SubtaskEffect; // exec nodes: the subtask's declared effect
  grant?: NodeGrant; // exec nodes: what the emperor allowed (write-task dialog / escalation)
  grantNote?: string; // the emperor's note given with the grant
  sideEffects?: boolean; // a write, command or non-read MCP call ran in this node (not auto-resumed after restart)
}

export type GateKind = 'plan' | 'final' | 'budget' | 'reject_limit' | 'risk';

export interface Gate {
  kind: GateKind;
  message: string;
  since: number;
  nodeId?: string;
}

export interface Artifact {
  path: string; // relative to workspace
  sha256: string;
  bytes: number;
  agentId: AgentId;
  nodeId?: string;
  at: number;
}

export interface FileChange {
  id: string;
  taskId: string;
  path: string; // relative to workspace
  op: 'create' | 'modify' | 'delete';
  beforeHash: string | null;
  afterHash: string | null;
  agentId: AgentId;
  nodeId?: string;
  at: number;
  reverted?: boolean;
  /** how the file changed: a file tool (also every record without this field) or a side effect of run_command */
  via?: 'tool' | 'command';
  /** the run_command text, when via === 'command' */
  command?: string;
  /** over the snapshot size cap: listed without content (hashes null), no diff, cannot be reverted */
  oversize?: boolean;
  /** before or after content looks binary (NUL bytes): show sizes, not a text diff */
  binary?: boolean;
}

/** Result of reverting a node's or an edict's changes (E3). Paths are workspace-relative. */
export interface RevertResult {
  reverted: string[];
  /** files changed on disk after the agent wrote them: nothing was reverted (unless forced) */
  conflicts: string[];
  /** changes that cannot be reverted (content over the size cap was never stored) */
  skipped: string[];
}

export interface Annotation {
  id: string;
  taskId?: string;
  agentId: AgentId;
  text: string;
  at: number;
  consumedAt?: number;
  response?: string;
  respondedAt?: number;
}

export interface TaskProgress {
  text: string;
  steps: { label: string; done: boolean; active?: boolean }[];
}

export interface Task {
  id: string;
  title: string;
  edict: string; // 原始旨意
  tier: Tier;
  state: TaskState;
  createdAt: number;
  updatedAt: number;
  workspace: string | null;
  repoRoot?: string | null; // worktree edicts: the repository the worktree was made from (permissions, merge)
  flow: FlowEntry[];
  plan?: Plan;
  planHistory: PlanVersion[];
  reviews: Review[];
  nodes: RunNode[];
  gate?: Gate;
  paused: boolean;
  blockedReason?: string;
  resumeState?: TaskState; // state to return to when unblocking
  result?: { summary: string; artifacts: Artifact[] };
  changes: FileChange[];
  usage: Usage;
  budget: { maxTokens: number; maxRejections: number; maxCostUsd: number };
  estimate?: { tokens: number; costUsd: number };
  strongModel?: ModelRef; // chosen in the composer
  effort?: string; // 思考程度 chosen in the composer (applies to strong-class agents & Solo)
  agentModels?: Partial<Record<AgentId, ModelRef>>; // task-scoped model overrides (e.g. 换模型重试)
  roleModels?: Record<string, ModelRef>; // same, for custom collaboration-design roles
  design?: DesignPin; // 协同设计 pinned at creation (absent = built-in 三省六部, native engine)
  designSpec?: CollabDesign; // frozen snapshot of a non-native design (switch / rollback never affects this task)
  flowRun?: FlowRun; // interpreter cursor for non-native designs
  debateId?: string;
  withDebate?: boolean;
  progress?: TaskProgress;
  lastActivityAt: number;
  sessionId?: string; // solo conversation
  templateId?: string;
  allowRules?: AllowRule[]; // 「本旨意内不再询问」 rules granted on approvals
  skillsUsed?: SkillUse[]; // load_skill calls during this edict
  canonUsed?: string[]; // 典章 entries injected into this edict's prompts
  questions?: EdictQuestion[]; // 请旨 (ask_emperor) asked during this edict
  execRound?: number; // 1 = first execution; >1 = rework rounds
  rework?: { round: number; targets: string[]; feedback: string; by: 'menxia' | 'emperor' };
}

export type AgentStatus = 'idle' | 'thinking' | 'writing' | 'tool' | 'waiting' | 'error' | 'paused';
export type Health = 'ok' | 'stale' | 'alert';

export interface AgentRuntime {
  id: AgentId;
  status: AgentStatus;
  taskId?: string;
  nodeId?: string;
  activity: string;
  lastHeartbeat: number;
  health: Health;
  usage: Usage;
  completed: number;
  sessions: number;
  errors: number;
}

export type ActivityKind =
  | 'thinking'
  | 'text'
  | 'tool_call'
  | 'tool_result'
  | 'log'
  | 'error'
  | 'state'
  | 'gate'
  | 'human'
  | 'annotation'
  | 'debate'
  | 'preview';

export interface Activity {
  id: string;
  at: number;
  taskId?: string;
  agentId?: AgentId;
  nodeId?: string;
  kind: ActivityKind;
  content: string;
  data?: Record<string, unknown>;
  streaming?: boolean;
}

export type ApprovalKind = 'action' | 'write_task' | 'escalate' | 'loop' | 'question';

export interface EdictQuestion {
  id: string;
  agentId: AgentId;
  nodeId?: string;
  question: string;
  options: string[];
  answer?: string;
  how?: 'option' | 'free' | 'self' | 'timeout' | 'none';
  at: number;
  answeredAt?: number;
}

/** One button on an approval card (Codex-style: proceed / proceed and don't ask again / no, and say what to do instead). */
export interface ApprovalChoice {
  id: string;
  label: string;
  hint?: string;
  approve: boolean;
  tone?: 'primary' | 'danger' | 'default';
  /** 'optional' shows a note box; 'required' needs one */
  comment?: 'optional' | 'required';
}

export interface ApprovalRequest {
  id: string;
  taskId?: string;
  agentId: AgentId;
  nodeId?: string;
  tool: string;
  summary: string;
  detail: string;
  risk: 'normal' | 'high';
  reason: string;
  at: number;
  status: 'pending' | 'approved' | 'denied';
  decidedAt?: number;
  kind?: ApprovalKind;
  /** when present the card shows these instead of 准许 / 驳回 */
  choices?: ApprovalChoice[];
  choice?: string; // picked choice id
  comment?: string; // the emperor's note
  ruleLabel?: string; // what an always-allow choice would allow, e.g. 「npm test」
}

/** An always-allow rule: `key` like cmd:npm test · tool:write · mcp:server/tool. */
export interface AllowRule {
  key: string;
  label: string;
  at: number;
}

export interface WorkspacePerms {
  rules: AllowRule[];
  /** release / deploy commands (git push, npm publish, deploy CLIs) run without asking in this workspace */
  releaseAlways?: boolean;
}

export interface DebateMessage {
  id: string;
  speaker: AgentId | 'emperor' | 'system';
  content: string;
  at: number;
  round: number;
  kind: 'official' | 'emperor' | 'system' | 'conclusion';
  repliesTo?: string; // id of emperor message responded to
}

export interface Debate {
  id: string;
  topic: string;
  taskId?: string;
  participants: AgentId[];
  messages: DebateMessage[];
  round: number;
  maxRounds: number;
  status: 'idle' | 'running' | 'paused' | 'concluded';
  conclusion?: string;
  createdAt: number;
  updatedAt: number;
  speaking?: AgentId;
  pendingInterjections: string[]; // ids of emperor messages not yet answered
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  at: number;
}

export interface Session {
  id: string;
  title: string;
  source: 'solo' | 'taizi-chat' | 'debate';
  agentId: AgentId;
  taskId?: string;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
  status: 'active' | 'done' | 'error';
  usage: Usage;
}

export interface MemorialStage {
  key: 'edict' | 'zhongshu' | 'menxia' | 'ministries' | 'questions' | 'skills' | 'report';
  label: string;
  at?: number;
  items: string[];
}

export interface Memorial {
  taskId: string;
  title: string;
  edict: string;
  tier: Tier;
  finalState: TaskState;
  archivedAt: number;
  stages: MemorialStage[];
  artifacts: Artifact[];
  usage: Usage;
  models: string[];
  runs: { nodeId: string; label: string; runId?: string; model?: string; exitStatus?: string; startedAt?: number; endedAt?: number }[];
  flow: FlowEntry[];
  skillsUsed?: SkillUse[];
}

export interface NewsItem {
  id: string;
  title: string;
  link?: string;
  source: string;
  category: string;
  at: number;
  summary?: string;
}

export interface AuditEntry {
  seq: number;
  at: number;
  actor: string; // 'emperor' | agentId | 'system'
  action: string;
  taskId?: string;
  detail: Record<string, unknown>;
  prevHash: string;
  hash: string;
}

export type Protocol = 'openai-chat' | 'anthropic-messages' | 'openai-responses';

export interface ModelInfo {
  id: string;
  label?: string;
  inputPrice: number; // USD per 1M tokens
  outputPrice: number;
  cachedInputPrice?: number;
  contextWindow: number;
  maxOutputTokens?: number; // hard output cap for this model (used when raising effort)
  reasoning?: ReasoningConfig; // 思考程度配置（见 shared/reasoning.ts）
}

export type ReasoningStyle = 'none' | 'openai' | 'anthropic' | 'anthropic-budget' | 'qwen' | 'glm' | 'custom';

export interface ReasoningConfig {
  style: ReasoningStyle;
  levels: string[]; // ordered low → high; the right end of the slider is the model's top level
  default: string;
  budgets?: Record<string, number>; // thinking token budgets (anthropic-budget / qwen)
  custom?: Record<string, Record<string, unknown>>; // style=custom: JSON merged into the request body per level
  /** set by 检测思考档位: levels the service actually accepted. reliable=false → it accepted a made-up level too, so levels are a guess */
  detected?: { at: number; reliable: boolean; accepted: string[]; rejected: string[] };
}

export interface ReasoningDetectResult {
  ok: boolean;
  /** the config now saved on the model (unchanged when ok=false) */
  reasoning?: ReasoningConfig;
  message: string;
}

export interface ErrorInfo {
  kind: 'auth' | 'config' | 'param' | 'billing' | 'rate' | 'server' | 'network' | 'timeout' | 'context' | 'other';
  status?: number;
  hint: string;
  raw: string;
  providerId?: string;
  model?: string;
  protocol?: string;
}

export interface ProviderConfig {
  id: string;
  name: string;
  preset: string; // 'custom' | 'deepseek' | ...
  protocol: Protocol;
  baseUrl: string;
  models: ModelInfo[];
  hasKey: boolean; // key itself never leaves main process
  extraHeaders?: Record<string, string>;
  replayReasoning?: boolean; // pass reasoning_content back (DeepSeek thinking etc.)
  enabled: boolean;
}

export type PermissionMode = 'readonly' | 'ask' | 'auto-edit' | 'auto';

export interface SkillInfo {
  name: string;
  description: string;
  /** extra skills the emperor equipped (like browser extensions); 'all' = every official */
  agents: AgentId[] | 'all';
  /** officials that hold this as a fixed duty skill (职责技能) */
  duty: AgentId[];
  path: string;
  source: 'builtin' | 'local' | 'remote';
  sourceUrl?: string;
  enabled: boolean;
  title?: string; // short Chinese name
  category?: string; // plan | review | investigate | qa | design | release | deploy | safety | everyday
  icon?: string;
  risk?: 'release' | 'deploy';
  version?: number; // built-in pack version
  /** sha256 of the skill body as loaded (which text an agent actually read) */
  sha256: string;
  /** remote skills: sha256 of the body when it was downloaded */
  remoteSha256?: string;
}

/** A load_skill call recorded on the edict (shown in the memorial). */
export interface SkillUse {
  name: string;
  agentId: AgentId;
  sha256: string;
  at: number;
}

export interface Template {
  id: string;
  cat: string;
  icon: string;
  name: string;
  desc: string;
  depts: string[];
  tier: Tier;
  params: { key: string; label: string; type: 'text' | 'textarea' | 'select'; options?: string[]; default?: string; required?: boolean }[];
  command: string;
}

export interface Settings {
  permissionMode: PermissionMode;
  defaultTier: Tier;
  multiAgent: boolean;
  routing: { strong: ModelRef | null; economy: ModelRef | null };
  agentModels: Partial<Record<AgentId, ModelRef>>; // per-agent hot-switch overrides
  agentEffort: Partial<Record<AgentId, string>>; // per-agent 思考程度 overrides
  budgets: Record<Tier, number>; // default max tokens per task by tier
  maxCostUsd: number; // per task, 0 = unlimited
  maxRejections: { lite: number; full: number };
  planGate: { lite: boolean; full: boolean };
  finalGate: boolean;
  debateBeforePlan: boolean; // Full Court: 朝堂议政 before planning
  debateRounds: number;
  parallelism: number;
  contextWindowTokens: number; // compression threshold base
  newsFeeds: { url: string; category: string; enabled: boolean }[];
  theme: 'system' | 'dark' | 'light';
  lastWorkspace: string | null;
  ceremonyShownOn?: string; // yyyy-mm-dd
  composerHidden: boolean;
  composerEffort?: string;
  defaultDesign?: string; // design id preselected in the composer
  previewAllowNetwork?: boolean; // HTML 预览可加载外部网络资源（默认仅本地） // last 思考程度 slider value ('default' | 'top' | level)
  language: 'zh';
  /** ask before each write subtask starts (Codex-style), unless permissionMode is auto */
  confirmWriteTasks: boolean;
  /** after a restart, resume interrupted nodes that had no side effects instead of blocking */
  autoResumeSafe: boolean;
  /** wall-clock limit per node, minutes (0 = none) */
  nodeTimeoutMin: number;
  /** per workspace root: 「本工作区永久允许」 rules */
  workspacePerms: Record<string, WorkspacePerms>;
  /** editors (Zed …) may connect over ACP through a local socket */
  acpEnabled: boolean;
  /** high-risk approvals from ACP edicts are answered in Edict only, never in the editor */
  acpHighRiskInEdictOnly: boolean;
  /** 全自动 mode only: an unanswered 请旨 (ask_emperor) continues on the default after this many minutes (0 = wait) */
  askTimeoutMin: number;
  /** 典章: the emperor's standing rules, preferences and lessons, injected into prompts by keyword */
  canon: CanonEntry[];
  /** record files changed by run_command (shadow git snapshots before / after each command) */
  commandSnapshots: boolean;
}

export type CanonKind = 'forbid' | 'rule' | 'preference' | 'lesson';
export interface CanonEntry {
  id: string;
  kind: CanonKind;
  text: string;
  /** injected when the edict mentions any of these; empty = every edict */
  keywords: string[];
  /** workspace root it applies to; absent = every workspace */
  root?: string;
  enabled: boolean;
  at: number;
  /** where it came from (e.g. a 门下 rejection collected into the canon) */
  source?: { taskId: string; label: string };
}

export interface Snapshot {
  tasks: Task[];
  agents: AgentRuntime[];
  debates: Debate[];
  sessions: Session[];
  memorials: Memorial[];
  approvals: ApprovalRequest[];
  annotations: Annotation[];
  news: NewsItem[];
  settings: Settings;
  providers: ProviderConfig[];
  skills: SkillInfo[];
  mcp: McpServerState[];
  designs: DesignInfo[];
  templates: Template[];
  workspace: string | null;
  dataDir: string;
  version: string;
  platform: string;
  totals: Usage;
}

// Runtime → renderer events
export type RuntimeEvent =
  | { type: 'snapshot'; snapshot: Snapshot }
  | { type: 'task'; task: Task }
  | { type: 'task_removed'; id: string }
  | { type: 'agent'; agent: AgentRuntime }
  | { type: 'activity'; activity: Activity }
  | { type: 'activity_delta'; id: string; append: string }
  | { type: 'debate'; debate: Debate }
  | { type: 'session'; session: Session }
  | { type: 'memorial'; memorial: Memorial }
  | { type: 'approval'; approval: ApprovalRequest }
  | { type: 'annotation'; annotation: Annotation }
  | { type: 'news'; news: NewsItem[] }
  | { type: 'settings'; settings: Settings }
  | { type: 'providers'; providers: ProviderConfig[] }
  | { type: 'skills'; skills: SkillInfo[] }
  | { type: 'totals'; totals: Usage }
  | { type: 'workspace'; workspace: string | null }
  | { type: 'fs_changed'; paths: string[] }
  | { type: 'toast'; level: 'info' | 'warn' | 'error'; message: string }
  | { type: 'menu'; command: string; arg?: unknown }
  | { type: 'preview_blocked'; url: string }
  | { type: 'mcp'; servers: McpServerState[] }
  | { type: 'designs'; designs: DesignInfo[] }
  | { type: 'lsp_diagnostics'; path: string; server: string; diagnostics: LspDiagnostic[] }
  | { type: 'lsp_status' };

/** One diagnostic from a language server (1-based lines / columns, end exclusive). */
export interface LspDiagnostic {
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  severity: 'error' | 'warning' | 'info' | 'hint';
  message: string;
  source?: string;
  code?: string;
  unnecessary?: boolean;
  deprecated?: boolean;
}

export const emptyUsage = (): Usage => ({ inputTokens: 0, outputTokens: 0, cachedTokens: 0, costUsd: 0, calls: 0 });

export interface ProbeCell { ok: boolean; skipped?: boolean; kind?: ErrorInfo['kind']; status?: number; message: string; hint?: string; latencyMs: number; level?: string }
export interface ProbeRow { protocol: Protocol; plain: ProbeCell; reasoning: ProbeCell }

/** Result of rendering a page in the hidden preview browser (agent tool `preview_page`). */
export interface PreviewResult {
  url: string;
  ok: boolean;
  title: string;
  text: string;
  /** step: 1-based index of the interactive step that was running when the line was logged */
  console: { level: string; message: string; source?: string; line?: number; step?: number }[];
  failed: string[];
  blocked: string[];
  screenshot?: string; // blob hash (PNG)
  width: number;
  height: number;
  loadMs: number;
  /** interactive steps (preview_page `actions`), in order */
  steps?: PreviewStepResult[];
  /** extra viewport screenshots taken after the steps (preview_page `viewports`) */
  viewports?: PreviewViewportResult[];
}

/** One step of an interactive preview check (click / fill / press / assert …). */
export interface PreviewStepResult {
  index: number; // 1-based
  action: string; // e.g. 点击 #start
  ok: boolean;
  note: string;
  ms: number;
  /** a failure here does not stop the run */
  optional?: boolean;
  /** not run: an earlier step failed, the page hung or the time budget ran out */
  skipped?: boolean;
  screenshot?: string; // blob hash (PNG), when the step asked for one
}

export interface PreviewViewportResult {
  width: number;
  height: number;
  screenshot?: string; // blob hash (PNG)
  /** page content is wider than the viewport (horizontal scrollbar) */
  overflowX?: boolean;
  contentWidth?: number;
  note?: string;
}

// ───────────────────────── MCP (Model Context Protocol) ─────────────────────────
/** One server entry in Cursor-compatible `mcp.json` (`{ "mcpServers": { name: entry } }`). */
export interface McpServerEntry {
  type?: 'stdio' | 'http' | 'sse' | 'streamable-http';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  envFile?: string;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  /** Remote servers only. Omitted = OAuth on demand when the server answers 401 (unless a static Authorization header is set). */
  auth?: McpAuthConfig;
  disabled?: boolean;
}
/** `clientSecret` is moved to the SecretStore on save (`${secret:<server>/auth/clientSecret}`). */
export type McpAuthConfig = { type: 'oauth'; clientId?: string; clientSecret?: string; scopes?: string[] } | { type: 'none' };
export interface McpConfig { mcpServers: Record<string, McpServerEntry> }

export type McpRisk = 'read' | 'write' | 'high';
export interface McpToolPolicy { enabled: boolean; risk: McpRisk; autoApprove: boolean }
export interface McpServerPolicy { enabled: boolean; agents: AgentId[] | 'all'; tools: Record<string, McpToolPolicy> }
export interface McpPolicy { servers: Record<string, McpServerPolicy>; trusted: string[] }

export interface McpToolInfo {
  name: string; // tool name on the server
  exposed: string; // name the agents see: mcp__server__tool
  title?: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean; title?: string };
  policy: McpToolPolicy;
}

/** OAuth login state of a remote server (never carries token values). */
export interface McpAuthState {
  type: 'oauth';
  loggedIn: boolean; // tokens stored for this server URL
  loggingIn?: boolean; // browser login in progress
  expiresAt?: number; // access-token expiry (ms epoch), when the server said
  scopes?: string[];
  issuer?: string;
  dynamicClient?: boolean; // client registered via RFC 7591
}

export interface McpResourceInfo { uri: string; name: string; title?: string; description?: string; mimeType?: string; size?: number }
export interface McpResourceTemplateInfo { uriTemplate: string; name: string; title?: string; description?: string; mimeType?: string }
export interface McpPromptArgument { name: string; title?: string; description?: string; required?: boolean }
export interface McpPromptInfo { name: string; title?: string; description?: string; arguments: McpPromptArgument[] }

export interface McpServerState {
  name: string;
  transport: 'stdio' | 'http' | 'sse';
  target: string; // command line or URL (secrets already masked)
  status: 'disabled' | 'untrusted' | 'stopped' | 'starting' | 'ok' | 'error' | 'needs_auth';
  error?: string; // for needs_auth: a hint to log in
  serverInfo?: { name: string; version?: string };
  protocolVersion?: string;
  instructions?: string;
  tools: McpToolInfo[];
  policy: McpServerPolicy;
  logs: { at: number; level: 'info' | 'error' | 'stderr'; text: string }[];
  startedAt?: number;
  auth?: McpAuthState;
  capabilities?: { tools: boolean; resources: boolean; prompts: boolean };
  resources?: McpResourceInfo[]; // first 200; see resourceCount
  resourceCount?: number;
  resourceTemplates?: McpResourceTemplateInfo[];
  prompts?: McpPromptInfo[];
}

export interface McpResourceListItem extends McpResourceInfo { server: string }
export interface McpResourceTemplateListItem extends McpResourceTemplateInfo { server: string }
export interface McpPromptListItem extends McpPromptInfo { server: string }
/** `blob` = BlobStore hash (binary contents, or the full text when `truncated`). */
export interface McpResourceContent { uri: string; mimeType?: string; text?: string; blob?: string; bytes?: number; truncated?: boolean }
export interface McpReadResult { server: string; uri: string; contents: McpResourceContent[]; text: string }
export interface McpPromptResult { server: string; name: string; description?: string; messages: { role: 'user' | 'assistant'; text: string }[]; text: string }
