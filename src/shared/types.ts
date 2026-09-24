// Shared domain types — used by main process runtime and renderer (both modes).
// Single source of truth: the runtime in the main process owns all state; the
// workbench and the pixel court are two projections of the same data.

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

export interface Subtask {
  id: string;
  title: string;
  dept: MinistryId;
  detail: string;
  acceptance: string;
  dependsOn: string[];
}

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
  | 'solo';

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
  output?: string; // structured conclusion (JSON string or text)
  usage?: Usage;
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
  debateId?: string;
  withDebate?: boolean;
  progress?: TaskProgress;
  lastActivityAt: number;
  sessionId?: string; // solo conversation
  templateId?: string;
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
  key: 'edict' | 'zhongshu' | 'menxia' | 'ministries' | 'report';
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
}

export interface ErrorInfo {
  kind: 'auth' | 'config' | 'param' | 'billing' | 'rate' | 'server' | 'network' | 'timeout' | 'other';
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
  agents: AgentId[] | 'all';
  path: string;
  source: 'builtin' | 'local' | 'remote';
  sourceUrl?: string;
  enabled: boolean;
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
  previewAllowNetwork?: boolean; // HTML 预览可加载外部网络资源（默认仅本地） // last 思考程度 slider value ('default' | 'top' | level)
  language: 'zh';
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
  | { type: 'mcp'; servers: McpServerState[] };

export const emptyUsage = (): Usage => ({ inputTokens: 0, outputTokens: 0, cachedTokens: 0, costUsd: 0, calls: 0 });

export interface ProbeCell { ok: boolean; skipped?: boolean; kind?: ErrorInfo['kind']; status?: number; message: string; hint?: string; latencyMs: number; level?: string }
export interface ProbeRow { protocol: Protocol; plain: ProbeCell; reasoning: ProbeCell }

/** Result of rendering a page in the hidden preview browser (agent tool `preview_page`). */
export interface PreviewResult {
  url: string;
  ok: boolean;
  title: string;
  text: string;
  console: { level: string; message: string; source?: string; line?: number }[];
  failed: string[];
  blocked: string[];
  screenshot?: string; // blob hash (PNG)
  width: number;
  height: number;
  loadMs: number;
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
  disabled?: boolean;
}
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

export interface McpServerState {
  name: string;
  transport: 'stdio' | 'http' | 'sse';
  target: string; // command line or URL (secrets already masked)
  status: 'disabled' | 'untrusted' | 'stopped' | 'starting' | 'ok' | 'error';
  error?: string;
  serverInfo?: { name: string; version?: string };
  protocolVersion?: string;
  instructions?: string;
  tools: McpToolInfo[];
  policy: McpServerPolicy;
  logs: { at: number; level: 'info' | 'error' | 'stderr'; text: string }[];
  startedAt?: number;
}
