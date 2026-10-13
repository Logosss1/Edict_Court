// 连接服务（MCP） page, pure part: turn the two add cards' fields into Cursor-compatible mcp.json entries (the shapes
// parseMcpConfig in src/main/mcp/manager.ts accepts), validate them, merge them into the config text, and tell the
// user which typed values would be written to mcp.json as plain text (the rest move to the keychain on save).
import type { McpServerEntry } from '../../../shared/types';
import { movesToKeychain } from '../../../shared/mcpSecrets';

/** Same rule as parseMcpConfig. */
export const NAME_RE = /^[\w.-]{1,48}$/;

export type RemoteAuth = 'auto' | 'oauth' | 'bearer' | 'none';
export interface RemoteDraft { name: string; url: string; transport: 'auto' | 'http' | 'sse'; auth: RemoteAuth; token: string; clientId: string; headers: string }
export interface LocalDraft { name: string; command: string; args: string; env: string }
export const EMPTY_REMOTE: RemoteDraft = { name: '', url: '', transport: 'auto', auth: 'auto', token: '', clientId: '', headers: '' };
export const EMPTY_LOCAL: LocalDraft = { name: '', command: '', args: '', env: '' };

export interface KV { key: string; value: string }
export type FieldErrors<K extends string> = Partial<Record<K, string>>;

const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,100}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,100}$/;
const unquote = (v: string) => (v.length >= 2 && /^(["']).*\1$/.test(v) ? v.slice(1, -1) : v);

/** `Key: value` (or `Key=value`) per line; the first `:` / `=` separates. */
export function parseHeaderLines(text: string): { pairs: KV[]; error?: string } {
  const pairs: KV[] = [];
  const seen = new Set<string>();
  for (const [i, raw] of text.split('\n').entries()) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^([^:=\s]+)\s*[:=]\s*(.*)$/);
    if (!m || !HEADER_NAME.test(m[1])) return { pairs, error: `第 ${i + 1} 行应为「名称: 值」，如 X-Api-Version: 2` };
    if (seen.has(m[1].toLowerCase())) return { pairs, error: `请求头 ${m[1]} 重复` };
    seen.add(m[1].toLowerCase());
    pairs.push({ key: m[1], value: m[2].trim() });
  }
  return { pairs };
}

/** `KEY=VALUE` per line (`export ` prefix and surrounding quotes allowed, like a .env file). */
export function parseEnvLines(text: string): { pairs: KV[]; error?: string } {
  const pairs: KV[] = [];
  const seen = new Set<string>();
  for (const [i, raw] of text.split('\n').entries()) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(?:export\s+)?([^=\s]+)\s*=\s*(.*)$/);
    if (!m || !ENV_NAME.test(m[1])) return { pairs, error: `第 ${i + 1} 行应为 KEY=VALUE（变量名仅字母数字下划线）` };
    if (seen.has(m[1])) return { pairs, error: `环境变量 ${m[1]} 重复` };
    seen.add(m[1]);
    pairs.push({ key: m[1], value: unquote(m[2].trim()) });
  }
  return { pairs };
}

/** Shell-like split of a pasted command line (quotes and backslash escapes; no expansion). */
export function splitCommandLine(s: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  let has = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"' && i + 1 < s.length) cur += s[++i];
      else cur += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      has = true;
    } else if (c === '\\' && i + 1 < s.length) {
      cur += s[++i];
      has = true;
    } else if (/\s/.test(c)) {
      if (has || cur) out.push(cur);
      cur = '';
      has = false;
    } else {
      cur += c;
      has = true;
    }
  }
  if (has || cur) out.push(cur);
  return out;
}

/** One argument per line. */
export const argLines = (text: string) => text.split('\n').map((l) => l.trim()).filter(Boolean);

function nameError(name: string, existing: string[]): string | undefined {
  const n = name.trim();
  if (!n) return '请填写名称';
  if (!NAME_RE.test(n)) return '名称仅限字母、数字与 _ . -（≤48 个字符）';
  const clash = existing.find((x) => x.toLowerCase() === n.toLowerCase());
  if (clash) return `已有同名服务「${clash}」`;
  return undefined;
}

/** http(s) URL with a host; `warn` for plain http to a non-local host. */
export function checkUrl(url: string): { error?: string; warn?: string } {
  const u = url.trim();
  if (!u) return { error: '请填写服务地址' };
  if (!/^https?:\/\//i.test(u)) return { error: '地址须以 https:// 或 http:// 开头' };
  let p: URL;
  try {
    p = new URL(u);
  } catch {
    return { error: '地址格式不对' };
  }
  if (!p.hostname) return { error: '地址缺少主机名' };
  if (p.protocol === 'http:' && !/^(localhost|127\.0\.0\.1|\[::1\])$/i.test(p.hostname)) return { warn: 'http 明文连接：请求头与令牌可能被截获，能用 https 就用 https' };
  return {};
}

export function buildRemote(d: RemoteDraft, existing: string[]): { entry?: McpServerEntry; errors: FieldErrors<'name' | 'url' | 'token' | 'headers'>; warn?: string } {
  const errors: FieldErrors<'name' | 'url' | 'token' | 'headers'> = {};
  const ne = nameError(d.name, existing);
  if (ne) errors.name = ne;
  const u = checkUrl(d.url);
  if (u.error) errors.url = u.error;
  const h = parseHeaderLines(d.headers);
  if (h.error) errors.headers = h.error;
  const hasAuthHeader = h.pairs.some((p) => p.key.toLowerCase() === 'authorization');
  const token = d.token.trim();
  if (d.auth === 'bearer') {
    if (!token) errors.token = '请填写令牌（或 ${env:变量名}）';
    else if (/\s/.test(token.replace(/^Bearer\s+/i, ''))) errors.token = '令牌里不应有空格';
    if (hasAuthHeader) errors.headers = '已选「请求头 Bearer token」，请求头里不要再写 Authorization';
  }
  if (d.auth === 'oauth' && hasAuthHeader) errors.headers = '用 OAuth 登录时不要再写 Authorization 请求头';
  if (Object.keys(errors).length) return { errors, warn: u.warn };
  const entry: McpServerEntry = { url: d.url.trim() };
  if (d.transport !== 'auto') entry.type = d.transport;
  const headers: Record<string, string> = {};
  if (d.auth === 'bearer') headers.Authorization = /^Bearer\s+/i.test(token) ? token : `Bearer ${token}`;
  for (const p of h.pairs) headers[p.key] = p.value;
  if (Object.keys(headers).length) entry.headers = headers;
  if (d.auth === 'oauth') entry.auth = d.clientId.trim() ? { type: 'oauth', clientId: d.clientId.trim() } : { type: 'oauth' };
  if (d.auth === 'none') entry.auth = { type: 'none' };
  return { entry, errors, warn: u.warn };
}

export function buildLocal(d: LocalDraft, existing: string[]): { entry?: McpServerEntry; errors: FieldErrors<'name' | 'command' | 'env'> } {
  const errors: FieldErrors<'name' | 'command' | 'env'> = {};
  const ne = nameError(d.name, existing);
  if (ne) errors.name = ne;
  let command = d.command.trim();
  let args = argLines(d.args);
  // a whole pasted command line (`npx -y @scope/server ~/dir`) when no separate arguments were given
  if (command && !args.length && /\s/.test(command)) {
    const parts = splitCommandLine(command);
    command = parts[0] ?? '';
    args = parts.slice(1);
  }
  if (!command) errors.command = '请填写要运行的命令，如 npx、uvx、node';
  const env = parseEnvLines(d.env);
  if (env.error) errors.env = env.error;
  if (Object.keys(errors).length) return { errors };
  const entry: McpServerEntry = { command, args };
  if (env.pairs.length) entry.env = Object.fromEntries(env.pairs.map((p) => [p.key, p.value]));
  return { entry, errors };
}

export type ValueFate = 'keychain' | 'reference' | 'plain';
/** What saving does with a typed `key: value` (env or header): keychain, left as a ${…} reference, or plain text in mcp.json. */
export function valueFate(key: string, value: string): ValueFate | null {
  if (!value) return null;
  if (value.includes('${')) return 'reference';
  return movesToKeychain(key, value) ? 'keychain' : 'plain';
}

/** Same rule as extractSecrets for `--api-key=…` style arguments. */
export const argMovesToKeychain = (a: string) => /^--?[\w-]*(?:key|token|secret|password)[\w-]*=(.+)$/i.test(a) && !a.includes('${');

/** The `{ mcpServers }` object of a config text (Cursor or VS Code shape). */
function serversOf(text: string): { root: Record<string, unknown>; box: Record<string, unknown> } {
  const root = JSON.parse(text.trim() || '{}') as Record<string, unknown>;
  if (!root || typeof root !== 'object' || Array.isArray(root)) throw new Error('mcp.json 顶层必须是对象');
  const key = root.mcpServers === undefined && root.servers !== undefined ? 'servers' : 'mcpServers';
  const box = (root[key] ??= {}) as Record<string, unknown>;
  if (typeof box !== 'object' || Array.isArray(box)) throw new Error(`${key} 必须是对象`);
  return { root, box };
}

export function serverNames(text: string): string[] {
  try {
    return Object.keys(serversOf(text).box);
  } catch {
    return [];
  }
}

export function addToConfig(text: string, name: string, entry: McpServerEntry): string {
  const { root, box } = serversOf(text);
  if (box[name]) throw new Error(`已有同名服务「${name}」`);
  box[name] = entry;
  return JSON.stringify(root, null, 2);
}

export function removeFromConfig(text: string, name: string): string {
  const { root, box } = serversOf(text);
  delete box[name];
  return JSON.stringify(root, null, 2);
}

/** One line per entry for the import preview. */
export function entrySummary(e: McpServerEntry): { local: boolean; target: string } {
  return e.command ? { local: true, target: [e.command, ...(e.args ?? [])].join(' ') } : { local: false, target: e.url ?? '' };
}

/** `{name: entry}` of a config text, or null when it does not parse. */
export function entriesOf(text: string): Record<string, McpServerEntry> | null {
  try {
    return serversOf(text).box as Record<string, McpServerEntry>;
  } catch {
    return null;
  }
}
