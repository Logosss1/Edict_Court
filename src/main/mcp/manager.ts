// MCP 管理：Cursor-compatible mcp.json (data dir), per-tool policy, trust for local commands,
// secret extraction into the keychain-backed SecretStore, connection lifecycle and agent tool exposure.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentId, McpConfig, McpPolicy, McpRisk, McpServerEntry, McpServerPolicy, McpServerState, McpToolInfo, McpToolPolicy } from '../../shared/types';
import type { ToolSpec } from '../llm/types';
import type { Runtime } from '../runtime/runtime';
import { sha256, truncate } from '../runtime/util';
import { safeEnv, userShell } from '../services/exec';
import { McpClient, McpHttpError, SseTransport, StdioTransport, StreamableHttpTransport, type McpTool, type Transport } from './client';

const SECRET_NAME = /(key|token|secret|password|passwd|auth|credential|cookie|bearer)/i;
const SECRET_VALUE = /^(sk-|sk_|ghp_|gho_|github_pat_|xox[abpr]-|glpat-|AKIA|AIza|Bearer\s+\S{12,}|Basic\s+\S{8,})/;
const MAX_LOGS = 300;

export function sanitizeName(s: string) {
  return s.replace(/[^a-zA-Z0-9_-]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '') || 'x';
}

/** Agent-visible tool name (`mcp__server__tool`, ≤ 64 chars, API-safe). */
export function exposedName(server: string, tool: string): string {
  const s = sanitizeName(server).slice(0, 20);
  let n = `mcp__${s}__${sanitizeName(tool)}`;
  if (n.length > 64) n = `${n.slice(0, 55)}_${sha256(`${server}/${tool}`).slice(0, 8)}`;
  return n;
}

/** Accepts Cursor `{mcpServers}` and VS Code `{servers}` shapes; validates entries. */
export function parseMcpConfig(text: string): McpConfig {
  let j: unknown;
  try {
    j = JSON.parse(text || '{}');
  } catch (e) {
    throw new Error(`mcp.json 不是合法 JSON：${(e as Error).message}`);
  }
  const root = (j ?? {}) as { mcpServers?: unknown; servers?: unknown };
  const raw = (root.mcpServers ?? root.servers ?? {}) as Record<string, unknown>;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('mcpServers 必须是对象');
  const out: McpConfig = { mcpServers: {} };
  for (const [name, v] of Object.entries(raw)) {
    if (!/^[\w.-]{1,48}$/.test(name)) throw new Error(`服务名不合法：${name}（仅字母数字 _ . -，≤48）`);
    const e = (v ?? {}) as McpServerEntry;
    if (!e.command && !e.url) throw new Error(`${name}：需要 command（本地进程）或 url（远程服务）`);
    if (e.url && !/^https?:\/\//.test(e.url)) throw new Error(`${name}：url 必须是 http(s)`);
    const clean: McpServerEntry = {};
    if (e.type) clean.type = e.type;
    if (e.command) {
      clean.command = String(e.command);
      clean.args = Array.isArray(e.args) ? e.args.map(String) : [];
      if (e.env) clean.env = Object.fromEntries(Object.entries(e.env).map(([k, x]) => [k, String(x)]));
      if (e.envFile) clean.envFile = String(e.envFile);
      if (e.cwd) clean.cwd = String(e.cwd);
    } else {
      clean.url = String(e.url);
      if (e.headers) clean.headers = Object.fromEntries(Object.entries(e.headers).map(([k, x]) => [k, String(x)]));
    }
    if (e.disabled) clean.disabled = true;
    out.mcpServers[name] = clean;
  }
  return out;
}

export interface InterpCtx { workspace: string | null; secret: (id: string) => string | null }

/** Cursor-style variables: ${env:NAME} ${userHome} ${workspaceFolder} ${workspaceFolderBasename} ${pathSeparator} ${/} + ${secret:ID}. */
export function interpolate(s: string, ctx: InterpCtx): string {
  return s.replace(/\$\{([^}]+)\}/g, (m, key: string) => {
    if (key.startsWith('env:')) return process.env[key.slice(4)] ?? '';
    if (key.startsWith('secret:')) return ctx.secret(key.slice(7)) ?? '';
    switch (key) {
      case 'userHome':
        return os.homedir();
      case 'workspaceFolder':
        return ctx.workspace ?? '';
      case 'workspaceFolderBasename':
        return ctx.workspace ? path.basename(ctx.workspace) : '';
      case 'pathSeparator':
      case '/':
        return path.sep;
      default:
        return m;
    }
  });
}

/** Move literal secrets (env / headers) into the SecretStore; the config keeps `${secret:server/KEY}`. */
export function extractSecrets(cfg: McpConfig, put: (id: string, v: string) => void): string[] {
  const moved: string[] = [];
  for (const [name, e] of Object.entries(cfg.mcpServers)) {
    for (const field of ['env', 'headers'] as const) {
      const obj = e[field];
      if (!obj) continue;
      for (const [k, v] of Object.entries(obj)) {
        if (!v || v.includes('${')) continue;
        if (SECRET_NAME.test(k) || SECRET_VALUE.test(v)) {
          const id = `${name}/${field}/${k}`;
          put(id, v);
          obj[k] = `\${secret:${id}}`;
          moved.push(`${name}.${field}.${k}`);
        }
      }
    }
    if (e.args) {
      e.args = e.args.map((a, i) => {
        const m = a.match(/^(--?[\w-]*(?:key|token|secret|password)[\w-]*=)(.+)$/i);
        if (!m || m[2].includes('${')) return a;
        const id = `${name}/args/${i}`;
        put(id, m[2]);
        moved.push(`${name}.args[${i}]`);
        return `${m[1]}\${secret:${id}}`;
      });
    }
  }
  return moved;
}

export function trustKey(name: string, e: McpServerEntry) {
  return sha256(JSON.stringify({ name, command: e.command, args: e.args ?? [], cwd: e.cwd ?? '', envFile: e.envFile ?? '' })).slice(0, 32);
}

export function defaultToolPolicy(t: McpTool): McpToolPolicy {
  const a = (t.annotations ?? {}) as { readOnlyHint?: boolean; destructiveHint?: boolean };
  const risk: McpRisk = a.readOnlyHint ? 'read' : a.destructiveHint === false ? 'write' : a.destructiveHint ? 'high' : 'write';
  return { enabled: true, risk, autoApprove: false };
}

function maskArgs(args: string[]) {
  return args.map((a) => a.replace(/((?:key|token|secret|password)[\w-]*=)(?!\$\{).+/i, '$1***'));
}

function readEnvFile(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][\w]*)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

export class McpManager {
  config: McpConfig = { mcpServers: {} };
  policy: McpPolicy = { servers: {}, trusted: [] };
  states = new Map<string, McpServerState>();
  private clients = new Map<string, McpClient>();
  private exposed = new Map<string, { server: string; tool: string }>();
  private disposed = false;

  constructor(private rt: Runtime) {}

  get configPath() {
    return path.join(this.rt.opts.dataDir, 'mcp.json');
  }
  get policyPath() {
    return path.join(this.rt.opts.dataDir, 'mcp-policy.json');
  }

  load(autoStart = true) {
    try {
      this.config = fs.existsSync(this.configPath) ? parseMcpConfig(fs.readFileSync(this.configPath, 'utf8')) : { mcpServers: {} };
    } catch (e) {
      this.config = { mcpServers: {} };
      this.rt.toast('warn', `mcp.json 解析失败：${(e as Error).message}`);
    }
    try {
      const p = fs.existsSync(this.policyPath) ? JSON.parse(fs.readFileSync(this.policyPath, 'utf8')) : {};
      this.policy = { servers: p.servers ?? {}, trusted: Array.isArray(p.trusted) ? p.trusted : [] };
    } catch {
      this.policy = { servers: {}, trusted: [] };
    }
    this.sync(autoStart);
  }

  rawConfig(): string {
    return JSON.stringify(this.config, null, 2);
  }

  /** stdio servers in `cfg` whose exact command line has not been trusted yet. */
  untrustedIn(cfg: McpConfig): { name: string; commandLine: string }[] {
    return Object.entries(cfg.mcpServers)
      .filter(([n, e]) => e.command && !this.policy.trusted.includes(trustKey(n, e)))
      .map(([n, e]) => ({ name: n, commandLine: [e.command, ...maskArgs(e.args ?? [])].join(' ') }));
  }

  /** Validate + save; literal secrets move to the keychain-backed store. Returns what moved and what awaits trust. */
  saveConfig(text: string, trustNames: string[] = []): { moved: string[]; untrusted: string[] } {
    const cfg = parseMcpConfig(text);
    const moved = extractSecrets(cfg, (id, v) => this.rt.opts.secrets.set(`mcp:${id}`, v));
    for (const n of trustNames) {
      const e = cfg.mcpServers[n];
      if (e?.command) this.policy.trusted = [...new Set([...this.policy.trusted, trustKey(n, e)])];
    }
    // drop secrets of removed servers
    for (const n of Object.keys(this.config.mcpServers)) if (!cfg.mcpServers[n]) delete this.policy.servers[n];
    const before = this.config;
    this.config = cfg;
    fs.mkdirSync(path.dirname(this.configPath), { recursive: true });
    fs.writeFileSync(this.configPath, JSON.stringify(cfg, null, 2));
    this.savePolicy();
    this.rt.audit.record('emperor', 'mcp_config_saved', { servers: Object.keys(cfg.mcpServers), secretsMovedToKeychain: moved.length, trusted: trustNames });
    // restart servers whose entry changed
    for (const n of new Set([...Object.keys(before.mcpServers), ...Object.keys(cfg.mcpServers)])) {
      if (JSON.stringify(before.mcpServers[n]) !== JSON.stringify(cfg.mcpServers[n])) this.stop(n, true);
    }
    this.sync(true);
    return { moved, untrusted: this.untrustedIn(cfg).map((u) => u.name) };
  }

  trust(name: string) {
    const e = this.config.mcpServers[name];
    if (!e?.command) return;
    this.policy.trusted = [...new Set([...this.policy.trusted, trustKey(name, e)])];
    this.savePolicy();
    this.rt.audit.record('emperor', 'mcp_trusted', { server: name, command: [e.command, ...maskArgs(e.args ?? [])].join(' ') });
    void this.start(name);
  }

  setServerPolicy(name: string, patch: Partial<McpServerPolicy>) {
    const cur = this.serverPolicy(name);
    this.policy.servers[name] = { ...cur, ...patch, tools: patch.tools ?? cur.tools };
    this.savePolicy();
    const st = this.states.get(name);
    if (st) st.policy = this.policy.servers[name];
    if (patch.enabled === false) this.stop(name);
    else if (patch.enabled === true) void this.start(name);
    this.emit();
  }

  setToolPolicy(name: string, tool: string, patch: Partial<McpToolPolicy>) {
    const sp = this.serverPolicy(name);
    const cur = sp.tools[tool] ?? { enabled: true, risk: 'write' as McpRisk, autoApprove: false };
    sp.tools[tool] = { ...cur, ...patch };
    if (sp.tools[tool].risk === 'high') sp.tools[tool].autoApprove = false; // high risk always asks
    this.policy.servers[name] = sp;
    this.savePolicy();
    const st = this.states.get(name);
    const t = st?.tools.find((x) => x.name === tool);
    if (t) t.policy = sp.tools[tool];
    this.rt.audit.record('emperor', 'mcp_tool_policy', { server: name, tool, ...sp.tools[tool] });
    this.emit();
  }

  list(): McpServerState[] {
    return [...this.states.values()];
  }

  async start(name: string): Promise<void> {
    const e = this.config.mcpServers[name];
    const st = this.states.get(name);
    if (!e || !st || this.disposed) return;
    if (!st.policy.enabled || e.disabled) {
      st.status = 'disabled';
      return this.emit();
    }
    if (e.command && !this.policy.trusted.includes(trustKey(name, e))) {
      st.status = 'untrusted';
      st.error = '本地命令尚未获准运行：请核对命令后点「信任并启动」';
      return this.emit();
    }
    this.stop(name, true);
    st.status = 'starting';
    st.error = undefined;
    st.startedAt = Date.now();
    this.emit();
    const log = (level: 'info' | 'error' | 'stderr', text: string) => this.log(name, level, text);
    const ctx: InterpCtx = { workspace: this.rt.workspace?.root ?? null, secret: (id) => this.rt.opts.secrets.get(`mcp:${id}`) };
    const roots = () => (this.rt.workspace ? [{ uri: `file://${this.rt.workspace.root}`, name: path.basename(this.rt.workspace.root) }] : []);
    const mk = (kind: 'stdio' | 'http' | 'sse'): Transport => {
      if (kind === 'stdio') {
        let env: Record<string, string> = {};
        if (e.envFile) {
          const f = interpolate(e.envFile, ctx);
          const abs = path.isAbsolute(f) ? f : path.join(ctx.workspace ?? os.homedir(), f);
          if (fs.existsSync(abs)) env = { ...env, ...readEnvFile(abs) };
          else log('error', `envFile 不存在：${f}`);
        }
        for (const [k, v] of Object.entries(e.env ?? {})) env[k] = interpolate(v, ctx);
        const cwd = e.cwd ? interpolate(e.cwd, ctx) : ctx.workspace ?? os.homedir();
        return new StdioTransport({ command: interpolate(e.command!, ctx), args: (e.args ?? []).map((a) => interpolate(a, ctx)), env: safeEnv(env), cwd, shell: process.platform === 'win32' ? undefined : userShell(), log });
      }
      const headers = Object.fromEntries(Object.entries(e.headers ?? {}).map(([k, v]) => [k, interpolate(v, ctx)]));
      const url = interpolate(e.url!, ctx);
      return kind === 'sse' ? new SseTransport({ url, headers, fetch: this.rt.opts.fetchImpl, log }) : new StreamableHttpTransport({ url, headers, fetch: this.rt.opts.fetchImpl, log });
    };
    const order: ('stdio' | 'http' | 'sse')[] = e.command ? ['stdio'] : e.type === 'sse' ? ['sse'] : e.type === 'http' || e.type === 'streamable-http' ? ['http'] : ['http', 'sse'];
    let lastErr: unknown;
    for (const kind of order) {
      const client = new McpClient(mk(kind), { roots, version: this.rt.opts.version, log });
      try {
        await client.connect();
        const tools = await client.listTools();
        if (this.disposed) return client.close();
        this.clients.set(name, client);
        st.transport = kind;
        st.serverInfo = client.serverInfo;
        st.protocolVersion = client.protocolVersion;
        st.instructions = client.instructions;
        this.applyTools(name, tools);
        st.status = 'ok';
        log('info', `已连接（${kind}）：${client.serverInfo?.name ?? name} ${client.serverInfo?.version ?? ''} · 协议 ${client.protocolVersion} · ${tools.length} 个工具`);
        client.onToolsChanged = () => void client.listTools().then((t) => { this.applyTools(name, t); this.emit(); }).catch(() => undefined);
        client.onClose = (why) => {
          if (this.clients.get(name) !== client) return;
          this.clients.delete(name);
          st.status = 'error';
          st.error = why;
          log('error', why);
          this.emit();
        };
        this.rt.audit.record('system', 'mcp_connected', { server: name, transport: kind, tools: tools.length, serverInfo: client.serverInfo?.name ?? null });
        return this.emit();
      } catch (err) {
        client.close();
        lastErr = err;
        const fallback = kind === 'http' && order.includes('sse') && err instanceof McpHttpError && [400, 404, 405].includes(err.status);
        log('error', `${kind} 连接失败：${(err as Error).message}${fallback ? '（改试旧版 SSE）' : ''}`);
        if (!fallback) break;
      }
    }
    st.status = 'error';
    st.error = (lastErr as Error)?.message ?? '连接失败';
    this.emit();
  }

  stop(name: string, silent = false) {
    const c = this.clients.get(name);
    this.clients.delete(name);
    c?.close();
    const st = this.states.get(name);
    if (st && !silent) {
      st.status = 'stopped';
      this.emit();
    }
  }

  restart(name: string) {
    this.stop(name, true);
    void this.start(name);
  }

  /** Tool specs an agent may use. `readOnly` limits to tools marked read risk (planning/review agents). */
  toolSpecsFor(agentId: AgentId, readOnly: boolean): ToolSpec[] {
    const out: ToolSpec[] = [];
    for (const st of this.states.values()) {
      if (st.status !== 'ok' || !st.policy.enabled) continue;
      if (st.policy.agents !== 'all' && !st.policy.agents.includes(agentId)) continue;
      for (const t of st.tools) {
        if (!t.policy.enabled || (readOnly && t.policy.risk !== 'read')) continue;
        const schema = t.inputSchema && typeof t.inputSchema === 'object' && t.inputSchema.type === 'object' ? t.inputSchema : { type: 'object', properties: {} };
        out.push({ name: t.exposed, description: truncate(`[MCP ${st.name}] ${t.title ?? ''} ${t.description}`.replace(/\s+/g, ' ').trim(), 1000), parameters: schema });
      }
    }
    return out.slice(0, 96);
  }

  resolve(exposed: string): { server: string; tool: McpToolInfo } | null {
    const r = this.exposed.get(exposed);
    if (!r) return null;
    const t = this.states.get(r.server)?.tools.find((x) => x.name === r.tool);
    return t ? { server: r.server, tool: t } : null;
  }

  async call(server: string, tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<{ ok: boolean; output: string; images: string[] }> {
    const c = this.clients.get(server);
    if (!c) throw new Error(`MCP 服务 ${server} 未连接`);
    const r = await c.callTool(tool, args, 180000, signal);
    const parts: string[] = [];
    const images: string[] = [];
    for (const b of r.content ?? []) {
      if (b.type === 'text' && b.text) parts.push(b.text);
      else if ((b.type === 'image' || b.type === 'audio') && b.data) {
        const h = this.rt.blobs.put(Buffer.from(b.data, 'base64'));
        images.push(h);
        parts.push(`[${b.type} ${b.mimeType ?? ''} 已保存 · ${h.slice(0, 12)}]`);
      } else if (b.type === 'resource' && b.resource) parts.push(b.resource.text ?? `[resource ${b.resource.uri ?? ''}]`);
      else if (b.type === 'resource_link') parts.push(`[resource_link ${b.uri ?? ''} ${b.name ?? ''}]`);
    }
    if (!parts.length && r.structuredContent !== undefined) parts.push(JSON.stringify(r.structuredContent, null, 2));
    return { ok: !r.isError, output: truncate(parts.join('\n') || '（无输出）', 12000), images };
  }

  dispose() {
    this.disposed = true;
    for (const n of [...this.clients.keys()]) this.stop(n, true);
  }

  // ── internals
  private serverPolicy(name: string): McpServerPolicy {
    const p = this.policy.servers[name];
    return p ? { enabled: p.enabled !== false, agents: p.agents ?? 'all', tools: p.tools ?? {} } : { enabled: true, agents: 'all', tools: {} };
  }

  private sync(autoStart: boolean) {
    for (const n of [...this.states.keys()]) {
      if (!this.config.mcpServers[n]) {
        this.stop(n, true);
        this.states.delete(n);
      }
    }
    for (const [n, e] of Object.entries(this.config.mcpServers)) {
      const policy = this.serverPolicy(n);
      const prev = this.states.get(n);
      const target = e.command ? [e.command, ...maskArgs(e.args ?? [])].join(' ') : (e.url ?? '');
      const st: McpServerState = prev ?? { name: n, transport: e.command ? 'stdio' : e.type === 'sse' ? 'sse' : 'http', target, status: 'stopped', tools: [], policy, logs: [] };
      st.target = target;
      st.policy = policy;
      this.states.set(n, st);
      if (autoStart && (!prev || !this.clients.has(n))) void this.start(n);
    }
    this.emit();
  }

  private applyTools(name: string, tools: McpTool[]) {
    const st = this.states.get(name)!;
    const sp = this.serverPolicy(name);
    for (const [k, v] of [...this.exposed]) if (v.server === name) this.exposed.delete(k);
    st.tools = tools.slice(0, 200).map((t) => {
      const exposed = exposedName(name, t.name);
      this.exposed.set(exposed, { server: name, tool: t.name });
      return { name: t.name, exposed, title: t.title ?? (t.annotations as { title?: string } | undefined)?.title, description: String(t.description ?? '').slice(0, 2000), inputSchema: (t.inputSchema as Record<string, unknown>) ?? { type: 'object' }, annotations: t.annotations as McpToolInfo['annotations'], policy: sp.tools[t.name] ?? defaultToolPolicy(t) };
    });
  }

  private log(name: string, level: 'info' | 'error' | 'stderr', text: string) {
    const st = this.states.get(name);
    if (!st) return;
    st.logs.push({ at: Date.now(), level, text: text.replace(/(sk-|ghp_|xox[abpr]-)[\w-]{6,}/g, '$1***') });
    if (st.logs.length > MAX_LOGS) st.logs.splice(0, st.logs.length - MAX_LOGS);
    this.emitSoon();
  }

  private savePolicy() {
    fs.writeFileSync(this.policyPath, JSON.stringify(this.policy, null, 2));
  }

  private timer: NodeJS.Timeout | null = null;
  private emitSoon() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.emit();
    }, 200);
    this.timer.unref?.();
  }
  emit() {
    this.rt.emit({ type: 'mcp', servers: this.list() });
  }
}
