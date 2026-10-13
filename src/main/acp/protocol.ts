// Agent Client Protocol (ACP) v1 — the subset of the official schema that Edict speaks as an agent.
// Source of truth: schema/schema.json of @agentclientprotocol/sdk (protocol version 1).
// Keys are camelCase, discriminator values snake_case, as in the spec. Unstable/draft parts of the
// schema (session config options, notices, compaction, usage, NES, providers…) are intentionally omitted.

export const PROTOCOL_VERSION = 1;

export const AGENT_METHODS = {
  initialize: 'initialize',
  authenticate: 'authenticate',
  sessionNew: 'session/new',
  sessionLoad: 'session/load',
  sessionSetMode: 'session/set_mode',
  sessionPrompt: 'session/prompt',
  sessionCancel: 'session/cancel', // notification
} as const;

export const CLIENT_METHODS = {
  sessionUpdate: 'session/update', // notification
  sessionRequestPermission: 'session/request_permission',
} as const;

/** `$/cancel_request` (protocol-level notification): cancel one in-flight request by id. */
export const CANCEL_REQUEST = '$/cancel_request';

export const ErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  RequestCancelled: -32800,
  AuthRequired: -32000,
  ResourceNotFound: -32002,
  /** Edict-specific (implementation-defined range): the Edict user refused this editor's connection. */
  ConnectionRefused: -32001,
} as const;

// ───────────────────────── JSON-RPC 2.0 ─────────────────────────
export type RequestId = string | number | null;
export interface RpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

type Meta = { _meta?: Record<string, unknown> | null };

// ───────────────────────── initialization ─────────────────────────
export interface Implementation extends Meta {
  name: string;
  title?: string | null;
  version: string;
}

export interface FileSystemCapabilities extends Meta {
  readTextFile?: boolean;
  writeTextFile?: boolean;
}

export interface ClientCapabilities extends Meta {
  fs?: FileSystemCapabilities;
  terminal?: boolean;
  [k: string]: unknown;
}

export interface InitializeRequest extends Meta {
  protocolVersion: number;
  clientCapabilities?: ClientCapabilities;
  clientInfo?: Implementation | null;
}

export interface PromptCapabilities extends Meta {
  image?: boolean;
  audio?: boolean;
  embeddedContext?: boolean;
}

export interface McpCapabilities extends Meta {
  http?: boolean;
  sse?: boolean;
}

export interface AgentCapabilities extends Meta {
  loadSession?: boolean;
  promptCapabilities?: PromptCapabilities;
  mcpCapabilities?: McpCapabilities;
}

export interface AuthMethod extends Meta {
  id: string;
  name: string;
  description?: string | null;
}

export interface InitializeResponse extends Meta {
  protocolVersion: number;
  agentCapabilities?: AgentCapabilities;
  authMethods?: AuthMethod[];
  agentInfo?: Implementation | null;
}

export interface AuthenticateRequest extends Meta {
  methodId: string;
}

// ───────────────────────── sessions ─────────────────────────
export interface EnvVariable extends Meta {
  name: string;
  value: string;
}
export interface HttpHeader extends Meta {
  name: string;
  value: string;
}
export interface McpServerStdio extends Meta {
  name: string;
  command: string;
  args: string[];
  env: EnvVariable[];
}
export interface McpServerHttp extends Meta {
  type: 'http' | 'sse';
  name: string;
  url: string;
  headers: HttpHeader[];
}
export type McpServer = McpServerStdio | McpServerHttp;

export interface NewSessionRequest extends Meta {
  cwd: string;
  mcpServers: McpServer[];
}

export interface SessionMode extends Meta {
  id: string;
  name: string;
  description?: string | null;
}

export interface SessionModeState extends Meta {
  currentModeId: string;
  availableModes: SessionMode[];
}

export interface NewSessionResponse extends Meta {
  sessionId: string;
  modes?: SessionModeState | null;
}

export interface LoadSessionRequest extends Meta {
  sessionId: string;
  cwd: string;
  mcpServers: McpServer[];
}

export interface LoadSessionResponse extends Meta {
  modes?: SessionModeState | null;
}

export interface SetSessionModeRequest extends Meta {
  sessionId: string;
  modeId: string;
}

export interface CancelNotification extends Meta {
  sessionId: string;
}

// ───────────────────────── content ─────────────────────────
export interface Annotations extends Meta {
  audience?: ('user' | 'assistant')[] | null;
  lastModified?: string | null;
  priority?: number | null;
}

export interface TextContent extends Meta {
  type: 'text';
  text: string;
  annotations?: Annotations | null;
}
export interface ImageContent extends Meta {
  type: 'image';
  data: string;
  mimeType: string;
  uri?: string | null;
  annotations?: Annotations | null;
}
export interface AudioContent extends Meta {
  type: 'audio';
  data: string;
  mimeType: string;
  annotations?: Annotations | null;
}
export interface ResourceLink extends Meta {
  type: 'resource_link';
  uri: string;
  name: string;
  title?: string | null;
  description?: string | null;
  mimeType?: string | null;
  size?: number | null;
  annotations?: Annotations | null;
}
export interface TextResourceContents extends Meta {
  uri: string;
  text: string;
  mimeType?: string | null;
}
export interface BlobResourceContents extends Meta {
  uri: string;
  blob: string;
  mimeType?: string | null;
}
export interface EmbeddedResource extends Meta {
  type: 'resource';
  resource: TextResourceContents | BlobResourceContents;
  annotations?: Annotations | null;
}
export type ContentBlock = TextContent | ImageContent | AudioContent | ResourceLink | EmbeddedResource;

// ───────────────────────── prompt turn ─────────────────────────
export interface PromptRequest extends Meta {
  sessionId: string;
  prompt: ContentBlock[];
}

export type StopReason = 'end_turn' | 'max_tokens' | 'max_turn_requests' | 'refusal' | 'cancelled';

export interface PromptResponse extends Meta {
  stopReason: StopReason;
}

// ───────────────────────── tool calls ─────────────────────────
export type ToolKind = 'read' | 'edit' | 'delete' | 'move' | 'search' | 'execute' | 'think' | 'fetch' | 'switch_mode' | 'other';
export type ToolCallStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

export interface ToolCallLocation extends Meta {
  path: string; // absolute
  line?: number | null;
}

export type ToolCallContent =
  | ({ type: 'content'; content: ContentBlock } & Meta)
  | ({ type: 'diff'; path: string; oldText?: string | null; newText: string } & Meta)
  | ({ type: 'terminal'; terminalId: string } & Meta);

export interface ToolCall extends Meta {
  toolCallId: string;
  title: string;
  kind?: ToolKind;
  status?: ToolCallStatus;
  content?: ToolCallContent[];
  locations?: ToolCallLocation[];
  rawInput?: unknown;
  rawOutput?: unknown;
}

export interface ToolCallUpdate extends Meta {
  toolCallId: string;
  title?: string | null;
  kind?: ToolKind | null;
  status?: ToolCallStatus | null;
  content?: ToolCallContent[] | null;
  locations?: ToolCallLocation[] | null;
  rawInput?: unknown;
  rawOutput?: unknown;
}

// ───────────────────────── plans & commands ─────────────────────────
export interface PlanEntry extends Meta {
  content: string;
  priority: 'high' | 'medium' | 'low';
  status: 'pending' | 'in_progress' | 'completed';
}

export interface AvailableCommand extends Meta {
  name: string;
  description: string;
  input?: { hint: string } | null;
}

// ───────────────────────── session/update ─────────────────────────
export type SessionUpdate =
  | ({ sessionUpdate: 'user_message_chunk'; content: ContentBlock } & Meta)
  | ({ sessionUpdate: 'agent_message_chunk'; content: ContentBlock } & Meta)
  | ({ sessionUpdate: 'agent_thought_chunk'; content: ContentBlock } & Meta)
  | (ToolCall & { sessionUpdate: 'tool_call' })
  | (ToolCallUpdate & { sessionUpdate: 'tool_call_update' })
  | ({ sessionUpdate: 'plan'; entries: PlanEntry[] } & Meta)
  | ({ sessionUpdate: 'available_commands_update'; availableCommands: AvailableCommand[] } & Meta)
  | ({ sessionUpdate: 'current_mode_update'; currentModeId: string } & Meta);

export interface SessionNotification extends Meta {
  sessionId: string;
  update: SessionUpdate;
}

// ───────────────────────── permissions ─────────────────────────
export type PermissionOptionKind = 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';

export interface PermissionOption extends Meta {
  optionId: string;
  name: string;
  kind: PermissionOptionKind;
}

export interface RequestPermissionRequest extends Meta {
  sessionId: string;
  toolCall: ToolCallUpdate;
  options: PermissionOption[];
}

export type RequestPermissionOutcome = { outcome: 'cancelled' } | { outcome: 'selected'; optionId: string };

export interface RequestPermissionResponse extends Meta {
  outcome: RequestPermissionOutcome;
}

/** Text helper: a plain text content block. */
export const text = (t: string): TextContent => ({ type: 'text', text: t });

// ───────────────────────── client side (2.1: Edict drives outside agents, 客卿) ─────────────────────────
/** Requests an agent sends to its client (Edict) once the client advertised fs / terminal capabilities. */
export const CLIENT_FS_TERMINAL = {
  readTextFile: 'fs/read_text_file',
  writeTextFile: 'fs/write_text_file',
  terminalCreate: 'terminal/create',
  terminalOutput: 'terminal/output',
  terminalWaitForExit: 'terminal/wait_for_exit',
  terminalKill: 'terminal/kill',
  terminalRelease: 'terminal/release',
} as const;

export interface ReadTextFileRequest extends Meta {
  sessionId: string;
  path: string;
  line?: number | null;
  limit?: number | null;
}
export interface WriteTextFileRequest extends Meta {
  sessionId: string;
  path: string;
  content: string;
}
export interface CreateTerminalRequest extends Meta {
  sessionId: string;
  command: string;
  args?: string[];
  env?: EnvVariable[];
  cwd?: string | null;
  outputByteLimit?: number | null;
}
export interface TerminalRef extends Meta {
  sessionId: string;
  terminalId: string;
}
export interface TerminalExitStatus extends Meta {
  exitCode?: number | null;
  signal?: string | null;
}
