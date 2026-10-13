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
  /** 需求说明: ids of the acceptance criteria this subtask delivers */
  covers?: string[];
  /** added by the requirement check to make up an unmet requirement */
  supplement?: boolean;
  /** 客卿 (2.1): who does it: 'self' = the ministry's own official, a guest id = that outside agent; absent = the ministry's default */
  executor?: string;
  /** 排班 (2.1): 2–3 lanes do it side by side, each in its own worktree; the emperor picks one. Absent = one lane */
  lanes?: LaneSpec[];
  /** 中书省 thinks it is worth trying more than once (only a suggestion; the emperor decides) */
  suggestAttempts?: string;
}

/** One lane of a multi-attempt subtask: who does it, optionally with which model (Edict officials only). */
export interface LaneSpec {
  executor: string;
  model?: ModelRef | null;
}

/** What the emperor granted one exec node: write (normal permission mode), write_free (no asks except high risk), readonly. */
export type NodeGrant = 'write' | 'write_free' | 'readonly';

export interface Plan {
  summary: string;
  subtasks: Subtask[];
  risks: string[];
  /** 需求说明 (2.1): written by 中书省 before the subtasks; absent on older plans */
  requirements?: Requirements;
}

/** One numbered acceptance criterion of the 需求说明 (ids R1, R2 … shown as 需1, 需2 …). */
export interface Requirement {
  id: string;
  text: string;
}
export interface Requirements {
  goal: string;
  outOfScope: string[];
  criteria: Requirement[];
  constraints: string[];
  /** the planner gave none: criteria were taken from the subtasks' acceptance lines */
  derived?: boolean;
}

export type RequirementVerdict = 'met' | 'unmet' | 'unknown';
/** 对照检查: every criterion judged against the recorded evidence after the ministries finish. */
export interface RequirementCheck {
  round: number;
  at: number;
  nodeId: string;
  items: { id: string; text: string; verdict: RequirementVerdict; evidence: string; note?: string }[];
  /** make-up subtasks this check added */
  supplements: string[];
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
  | 'check'
  | 'solo'
  | 'step'
  | 'lane' // 2.1 排班: one lane's run of a multi-attempt subtask
  | 'judge'; // 2.1 排班: 门下省 scores the lanes

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
  guest?: { id: string; name: string }; // 2.1: done by this outside agent (客卿) instead of the ministry's own official
  laneId?: string; // 2.1: one lane of a multi-attempt subtask (works in that lane's worktree)
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
  /** how the file changed: a file tool (also every record without this field), a side effect of run_command, or a 客卿's own built-in tool (2.1) */
  via?: 'tool' | 'command' | 'guest';
  /** the run_command text, when via === 'command'; the guest's name when via === 'guest' */
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
  repoRoot?: string | null; // worktree edicts: the main checkout the worktree was made from (permission rules stay keyed by it)
  worktree?: EdictWorktree; // per-edict git worktree (absent = works in the open workspace)
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
  /** 联网: the emperor chose 「只用抓取」 or declined setting up search for this edict (asked once per edict) */
  webSearchDeclined?: boolean;
  /** 需求对照检查 results, newest last */
  requirementChecks?: RequirementCheck[];
  /** 定时旨意: the schedule that issued this edict (absent = issued by hand) */
  schedule?: TaskScheduleRef;
  /** permission mode for this edict only (a schedule's cap); absent = the global setting */
  permissionMode?: PermissionMode;
  /** 排班 (2.1): subtasks done by several lanes side by side */
  attempts?: SubtaskAttempts[];
  execRound?: number; // 1 = first execution; >1 = rework rounds
  rework?: { round: number; targets: string[]; feedback: string; by: 'menxia' | 'emperor' };
}

// ───────────── 定时旨意 (2.1) ─────────────
/** When a schedule fires (local time). `court` = each morning court (06:00). */
export type ScheduleRule =
  | { kind: 'daily'; time: string }
  | { kind: 'weekly'; days: number[]; time: string }
  | { kind: 'interval'; hours: number }
  | { kind: 'court' }
  | { kind: 'once'; at: number };
/** What a scheduled edict may do: read only / ask for every change / change freely inside its own worktree. */
export type SchedulePermission = 'readonly' | 'ask' | 'worktree';
export type ScheduleStop = { kind: 'never' } | { kind: 'count'; n: number } | { kind: 'until'; at: number };
export interface ScheduleRun {
  at: number;
  outcome: 'started' | 'skipped' | 'failed';
  taskId?: string;
  /** fired late, for a time Edict was closed or the Mac asleep */
  catchUp?: boolean;
  note?: string;
}
export interface EdictSchedule {
  id: string;
  title: string;
  /** the edict text issued each time */
  text: string;
  workspace: string | null;
  tier: Tier;
  designId?: string;
  model?: ModelRef | null;
  effort?: string;
  rule: ScheduleRule;
  permission: SchedulePermission;
  stop: ScheduleStop;
  /** a time missed while Edict was closed or the Mac asleep: run once when back, or skip it */
  missed: 'once' | 'skip';
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  /** who set it up; an official's proposal only takes effect once the emperor approves it */
  origin: { by: 'emperor' } | { by: 'official'; agentId: AgentId; taskId?: string; reason?: string };
  /** an official's proposal still waiting for the emperor (not scheduled until approved) */
  proposal?: 'pending';
  runs: number;
  nextAt: number | null;
  lastRunAt?: number;
  lastTaskId?: string;
  /** set when the stop rule ended it */
  ended?: string;
  history: ScheduleRun[];
}
export interface TaskScheduleRef {
  id: string;
  title: string;
  permission: SchedulePermission;
  firedAt: number;
  catchUp?: boolean;
}

export type WorktreeStatus = 'active' | 'merged' | 'kept' | 'discarded';
export type WorktreeAction = 'merge' | 'keep' | 'discard';

/** An edict's own git worktree on branch edict/<taskId>, made from the repo's HEAD when it leaves triage. */
export interface EdictWorktree {
  path: string; // worktree root (<dataDir>/worktrees/<repo hash>/<taskId>)
  branch: string; // edict/<taskId>
  base: string; // commit the branch started from
  baseBranch?: string; // branch checked out in the main checkout at creation
  repoRoot: string; // git toplevel of the main checkout (merge target)
  sub?: string; // the opened folder relative to repoRoot (absent = repo root)
  status: WorktreeStatus;
  createdAt: number;
  links?: string[]; // dependency folders symlinked from the main checkout (never committed)
  dirtyBase?: number; // uncommitted files in the main checkout at creation (not included)
  finishedAt?: number;
  commit?: string; // last commit made on the branch when finishing
  mergeCommit?: string;
  conflicts?: string[]; // files that blocked the last merge attempt
  error?: string; // last finish failure
  ports?: PortBlock; // 2.1: ports this edict's commands should use (EDICT_PORT)
  setup?: WorktreeSetupRun; // 2.1: the 工作树准备 run
}

/** Outcome of worktreeFinish (also what the 结案 card's choice did). */
export interface WorktreeFinishResult {
  ok: boolean;
  action: WorktreeAction;
  status: WorktreeStatus;
  message: string;
  branch: string;
  path: string;
  commit?: string;
  mergeCommit?: string;
  conflicts?: string[];
}

/** One entry of `git worktree list` for the open repository. */
export interface WorktreeInfo {
  path: string;
  head: string;
  branch: string | null; // null = detached
  main: boolean; // the repository's main working tree
  current: boolean; // the open workspace
  managed: boolean; // lives under <dataDir>/worktrees (made by Edict)
  kind: 'main' | 'edict' | 'manual' | 'external';
  taskId?: string; // edict worktrees: the edict using / owning it
  taskTitle?: string;
  taskState?: TaskState;
  status?: WorktreeStatus;
  locked?: boolean;
  prunable?: boolean; // directory is gone (git worktree prune cleans it up)
  exists: boolean;
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

export type ApprovalKind = 'action' | 'write_task' | 'escalate' | 'loop' | 'question' | 'worktree' | 'search_setup' | 'sandbox' | 'web_domain' | 'schedule' | 'attempt' | 'guest';

export interface EdictQuestion {
  id: string;
  agentId: AgentId;
  nodeId?: string;
  question: string;
  options: string[];
  /** 太子追问: what the prince goes with on 「不必问，照办」 or when nobody answers */
  assume?: string;
  answer?: string;
  how?: 'option' | 'free' | 'self' | 'timeout' | 'none';
  at: number;
  answeredAt?: number;
}

/** One button on an approval card (proceed / proceed and don't ask again / no, and say what to do instead). */
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
  /** the edict (and official) whose approval card granted it */
  source?: { taskId: string; title: string; agentId?: string };
}

export interface WorkspacePerms {
  rules: AllowRule[];
  /** release / deploy commands (git push, npm publish, deploy CLIs) run without asking in this workspace */
  releaseAlways?: boolean;
  /** 命令沙箱: extra folders commands in this workspace may write */
  sandboxWritable?: string[];
  /** 工作树准备 (2.1): what runs in each new edict worktree of this workspace */
  worktreeSetup?: WorktreeSetup;
}

/** 工作树准备 (2.1): files copied from the main folder and a script run in every new edict worktree. */
export interface WorktreeSetup {
  /** shell script run in the new worktree (empty = none), as the emperor, outside the command sandbox */
  script: string;
  /** untracked files copied over (relative paths; * and ? in the last part), e.g. .env */
  copy: string[];
  /** symlink node_modules / .venv / venv from the main folder (default on) */
  linkDeps: boolean;
  /** minutes before the script is stopped */
  timeoutMin: number;
}

/** 排班 (2.1): one lane's run of a multi-attempt subtask. */
export interface AttemptLane {
  id: string;
  /** 甲 / 乙 / 丙 */
  label: string;
  executor: string;
  model?: ModelRef | null;
  nodeId: string;
  /** its own worktree, branched from the edict worktree as it was when the lanes started */
  worktree?: EdictWorktree;
  /** 门下省's score 0–100 and reasons */
  score?: number;
  comment?: string;
  diff?: { files: number; added: number; removed: number };
  /** blob: the lane's whole diff against the base (kept after its worktree is gone, for 比试 and the 奏折) */
  diffHash?: string;
  /** git tree of the lane's worktree when it finished (what goes in when it is picked) */
  tree?: string;
  /** file changes the lane made in its own worktree (not the edict's: they go in only when it is picked) */
  changes?: FileChange[];
}

/** 排班 (2.1): a subtask done by several lanes; the emperor (or 门下省 in 全自动) picks the one that goes in. */
export interface SubtaskAttempts {
  id: string;
  subtaskId: string;
  /** the subtask's exec node the lanes stand in for */
  nodeId: string;
  /** exec round (返工 rounds run the lanes again) */
  round: number;
  /** commit holding the edict worktree's state when the lanes started */
  base: string;
  lanes: AttemptLane[];
  status: 'running' | 'judging' | 'choosing' | 'applied' | 'failed';
  judgeNodeId?: string;
  /** 门下省's pick and why */
  recommended?: string;
  judgeNote?: string;
  /** the lane whose changes went into the edict worktree */
  pick?: string;
  pickedBy?: 'emperor' | 'menxia';
  /** the other lanes' branches were kept (edict/<id>-<lane>) */
  keptOthers?: boolean;
  /** asked for on the 比试 page before picking */
  keepOthersRequested?: boolean;
  /** files a 3-way merge could not combine (the edict's own version was kept) */
  conflicts?: string[];
  error?: string;
  at: number;
}

/** 客卿 (2.1): outside coding agents Edict drives over ACP to do ministries' subtasks. */
export type GuestKind = 'claude' | 'codex' | 'gemini' | 'opencode' | 'custom';
export interface GuestConfig {
  id: string;
  name: string;
  kind: GuestKind;
  enabled: boolean;
  /** custom: the program; built-in: an override path (empty = look for it) */
  command?: string;
  args?: string[];
}
export interface GuestSettings {
  /** built-ins the emperor changed, and custom ones */
  agents: GuestConfig[];
  /** ministry → guest id that does its subtasks unless the plan says otherwise */
  deptDefault: Partial<Record<MinistryId, string>>;
  /** 排班 buttons on the Court Lite plan card too (Full Court always has them) */
  attemptsInLite: boolean;
}
/** What the settings page shows about one guest. */
export interface GuestStatus {
  id: string;
  name: string;
  kind: GuestKind;
  builtIn: boolean;
  /** a built-in the emperor gave his own command line */
  overridden?: boolean;
  enabled: boolean;
  found: boolean;
  path?: string;
  args?: string[];
  installHint?: string;
  loginHint?: string;
  note?: string;
  homepage?: string;
}
export interface GuestTestResult {
  ok: boolean;
  message: string;
  agentName?: string;
  agentVersion?: string;
  needsLogin?: boolean;
  ms: number;
}

/** A block of ports one worktree has to itself (EDICT_PORT = from). */
export interface PortBlock {
  from: number;
  to: number;
}

/** What the 工作树准备 did in one worktree. */
export interface WorktreeSetupRun {
  at: number;
  copied: string[];
  /** copy entries that matched nothing */
  missing?: string[];
  /** no script configured */
  noScript?: boolean;
  ok: boolean;
  exitCode?: number | null;
  timedOut?: boolean;
  durationMs?: number;
  /** last part of the script's output */
  output?: string;
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
  key: 'edict' | 'zhongshu' | 'menxia' | 'ministries' | 'questions' | 'skills' | 'requirements' | 'attempts' | 'report';
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
  /** extra skills the emperor equipped (switched on per official); 'all' = every official */
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
  /** ask before each write subtask starts, unless permissionMode is auto */
  confirmWriteTasks: boolean;
  /** after a restart, resume interrupted nodes that had no side effects instead of blocking */
  autoResumeSafe: boolean;
  /** wall-clock limit per node, minutes (0 = none) */
  nodeTimeoutMin: number;
  /** per workspace root: 「本工作区永久允许」 rules */
  workspacePerms: Record<string, WorkspacePerms>;
  /** external editors may connect over ACP through a local socket */
  acpEnabled: boolean;
  /** high-risk approvals from ACP edicts are answered in Edict only, never in the editor */
  acpHighRiskInEdictOnly: boolean;
  /** 全自动 mode only: an unanswered 请旨 (ask_emperor) continues on the default after this many minutes (0 = wait) */
  askTimeoutMin: number;
  /** 太子追问: at triage the prince may ask one short question when the edict is unclear (default on) */
  taiziAsk?: boolean;
  /** 典章: the emperor's standing rules, preferences and lessons, injected into prompts by keyword */
  canon: CanonEntry[];
  /** record files changed by run_command (shadow git snapshots before / after each command) */
  commandSnapshots: boolean;
  /** each court edict on a git repository works in its own worktree (branch edict/<id>), merged on 结案 */
  worktreePerEdict: boolean;
  /** first port handed to edict worktrees; each gets a block of 10 (2.1) */
  worktreePortBase: number;
  /** 客卿 and 排班 (2.1) */
  guests: GuestSettings;
  /** desktop notifications (window not focused): all · only what needs the emperor · none */
  notify: NotifyPref;
  /** 联网: web_fetch policy and the search service officials use */
  web: WebSettings;
  /** 命令沙箱: officials' commands run under macOS sandbox-exec */
  sandbox: SandboxSettings;
  /** 需求说明与对照检查, per tier; maxSupplement = rounds of make-up subtasks for unmet requirements */
  requirementCheck: { lite: boolean; full: boolean; maxSupplement: number };
}

export type NotifyPref = 'all' | 'attention' | 'off';

/** 联网 (2.1): web_fetch is on by default; web_search works once a search service is set. */
export type WebFetchPolicy = 'allow' | 'ask' | 'off';
export type SearchProviderKind = 'brave' | 'tavily' | 'searxng' | 'model';
export interface SearchConfig {
  provider: SearchProviderKind;
  /** SearXNG base URL */
  url?: string;
  /** 模型自带搜索: which configured model searches */
  model?: ModelRef;
}
export interface WebSettings {
  fetch: WebFetchPolicy;
  search: SearchConfig | null;
  /** fetch = 'ask': domains the emperor allowed permanently */
  domains: string[];
}
/** What the renderer may know about the search setup (never the keys themselves). */
export interface WebStatus {
  web: WebSettings;
  hasKey: Record<SearchProviderKind, boolean>;
  /** a search service is chosen and has what it needs */
  searchReady: boolean;
}

/** 命令沙箱 (2.1): what officials' commands may write and read; network on by default. */
export interface SandboxSettings {
  enabled: boolean;
  network: boolean;
  /** extra writable folders for every workspace (besides the workspace, temp and package caches) */
  writable: string[];
  /** package-manager caches that stay writable (editable) */
  caches: string[];
  /** folders commands may not read */
  denyRead: string[];
}

/** 存储与备份: where the data lives and the copies made of it. */
export interface StorageBackup {
  name: string;
  at: number;
  bytes: number;
}
export interface StorageInfo {
  dataDir: string;
  dbFile: string;
  dbBytes: number;
  walBytes: number;
  /** meta.origin: fresh | import:1.x | import:backup | unknown */
  origin: string;
  /** backup-1.x-<stamp> folder made when 1.x JSON data was imported */
  importBackup?: string;
  /** rows per table (tasks, memorials …) */
  counts: Record<string, number>;
  backups: StorageBackup[];
  /** API keys are encrypted with the system keychain (safeStorage) */
  encrypted: boolean;
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
  schedules: EdictSchedule[];
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
  | { type: 'schedules'; schedules: EdictSchedule[] }
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
/** One server entry in the standard `mcp.json` format (`{ "mcpServers": { name: entry } }`). */
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
