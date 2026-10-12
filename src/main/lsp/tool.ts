// Agent tool `lsp`: semantic navigation and checks through the installed language servers.
// Output is compact Chinese text for the model; missing servers come back with install hints.
import type { ToolSpec } from '../llm/types';
import { PathBoundaryError, type Workspace } from '../services/workspace';
import { LspUnavailableError, type LspDiagnostic, type LspLocation, type LspManager, type LspSymbol } from './manager';

export const LSP_OPERATIONS = ['diagnostics', 'definition', 'references', 'hover', 'symbols', 'workspace_symbols'] as const;
export type LspOperation = (typeof LSP_OPERATIONS)[number];

const MAX_LIST = 60;
const MAX_SYMBOLS = 200;

export const LSP_TOOL_SPEC: ToolSpec = {
  name: 'lsp',
  description:
    '调用本机已安装的语言服务器（LSP）做语义级代码分析，比全文搜索更准确：diagnostics 文件诊断（类型/语法错误，改完代码后用它自检）、definition 跳转定义、references 查找所有引用、hover 查看类型签名与文档、symbols 文件符号大纲、workspace_symbols 按名称搜索全工作区符号。行号列号从 1 开始；可用 symbol 代替 column（自动定位该行上的标识符）。未安装对应语言服务器时返回安装提示，此时请改用 search / outline。',
  parameters: {
    type: 'object',
    properties: {
      operation: { type: 'string', enum: [...LSP_OPERATIONS], description: '操作：diagnostics | definition | references | hover | symbols | workspace_symbols' },
      path: { type: 'string', description: '相对工作区的文件路径（workspace_symbols 以外的操作必填）' },
      line: { type: 'integer', description: '行号（从 1 开始），definition / references / hover 必填' },
      column: { type: 'integer', description: '列号（从 1 开始，指向标识符中任一字符）；与 symbol 二选一' },
      symbol: { type: 'string', description: '该行上的标识符名称，用于自动定位列号（代替 column）' },
      query: { type: 'string', description: 'workspace_symbols 的符号名称（可为部分名称）' },
      language: { type: 'string', description: 'workspace_symbols 可选：限定语言，如 python、typescript、go、rust' },
      wait_ms: { type: 'integer', description: 'diagnostics 等待语言服务器分析的最长毫秒数，默认 4000，最大 30000' },
    },
    required: ['operation'],
    additionalProperties: false,
  },
};

type Out = { ok: boolean; output: string };

export function describeLspCall(args: Record<string, unknown>): string {
  const op = String(args.operation ?? '');
  const label: Record<string, string> = { diagnostics: '诊断', definition: '定义', references: '引用', hover: '悬停', symbols: '符号', workspace_symbols: '全局符号' };
  if (op === 'workspace_symbols') return `LSP 全局符号 “${String(args.query ?? '')}”`;
  return `LSP ${label[op] ?? op} ${String(args.path ?? '')}${args.line ? `:${args.line}` : ''}`;
}

export async function runLspTool(manager: LspManager, workspace: Workspace, args: Record<string, unknown>): Promise<Out> {
  const op = String(args.operation ?? '') as LspOperation;
  if (!LSP_OPERATIONS.includes(op)) return { ok: false, output: `未知操作：${op || '（空）'}；可用：${LSP_OPERATIONS.join(' | ')}` };
  const str = (k: string) => (typeof args[k] === 'string' ? (args[k] as string).trim() : '');
  const int = (k: string) => (args[k] === undefined || args[k] === null || args[k] === '' ? NaN : Math.trunc(Number(args[k])));
  const file = str('path');
  const lines = new LineCache(workspace);
  try {
    if (op === 'workspace_symbols') {
      const query = str('query') || str('symbol');
      if (!query) return { ok: false, output: 'workspace_symbols 需要 query（符号名称）' };
      return formatWorkspaceSymbols(query, await manager.workspaceSymbols(query, str('language') || undefined));
    }
    if (!file) return { ok: false, output: `${op} 需要 path（相对工作区的文件路径）` };
    const rel = workspace.rel(workspace.resolve(file));
    if (!workspace.exists(rel)) return { ok: false, output: `文件不存在：${rel}` };

    if (op === 'diagnostics') {
      const waitMs = Math.min(30000, Math.max(0, Number.isFinite(int('wait_ms')) ? int('wait_ms') : 4000));
      const r = await manager.diagnostics(rel, waitMs);
      return { ok: true, output: formatDiagnostics(r.path, r.serverName, r.diagnostics, r.fresh, waitMs) };
    }
    if (op === 'symbols') {
      const r = await manager.documentSymbols(rel);
      if (!r.symbols.length) return { ok: true, output: `${rel}：未识别到符号（${r.serverName}）` };
      const body = r.symbols.slice(0, MAX_SYMBOLS).map(symbolLine);
      const more = r.symbols.length > MAX_SYMBOLS || r.truncated ? `\n…（符号过多，仅列出前 ${Math.min(MAX_SYMBOLS, r.symbols.length)} 个）` : '';
      return { ok: true, output: `${rel} 符号大纲（${r.serverName}，${r.symbols.length} 个）：\n${body.join('\n')}${more}` };
    }

    // position-based operations
    const line = int('line');
    if (!Number.isFinite(line) || line < 1) return { ok: false, output: `${op} 需要 line（从 1 开始的行号）` };
    let column = int('column');
    const sym = str('symbol');
    const text = lines.get(rel);
    if (text && line > text.length) return { ok: false, output: `行号 ${line} 超出范围（${rel} 共 ${text.length} 行）` };
    if (sym) {
      const c = findColumn(text?.[line - 1] ?? '', sym);
      if (!c) return { ok: false, output: `第 ${line} 行未找到标识符 “${sym}”：${(text?.[line - 1] ?? '').trim().slice(0, 160)}` };
      column = c;
    }
    if (!Number.isFinite(column) || column < 1) return { ok: false, output: `${op} 需要 column（从 1 开始的列号）或 symbol（该行上的标识符名称）` };
    const at = `${rel}:${line}:${column}`;

    if (op === 'hover') {
      const r = await manager.hover(rel, line, column);
      if (!r.text) return { ok: true, output: `${at} 处没有悬停信息（可能不是符号；可用 read_file 确认行列号）` };
      return { ok: true, output: `${at} 悬停信息（${r.serverName}）：\n${clip(r.text, 4000)}` };
    }
    const r = op === 'definition' ? await manager.definition(rel, line, column) : await manager.references(rel, line, column);
    if (!r.locations.length) return { ok: true, output: `${at} 未找到${op === 'definition' ? '定义' : '引用'}（${r.serverName}；该位置可能不是符号，可用 read_file 确认行列号）` };
    const locs = sortLocations(r.locations);
    const files = new Set(locs.map((l) => l.path)).size;
    const head = op === 'definition' ? `定义（${locs.length} 处，${r.serverName}）：` : `引用 ${locs.length} 处（${files} 个文件，${r.serverName}）：`;
    const body = locs.slice(0, MAX_LIST).map((l) => locationLine(l, lines));
    const more = locs.length > MAX_LIST ? `\n…另有 ${locs.length - MAX_LIST} 处未列出` : '';
    return { ok: true, output: `${head}\n${body.join('\n')}${more}` };
  } catch (e) {
    if (e instanceof LspUnavailableError) return { ok: false, output: unavailableText(e) };
    if (e instanceof PathBoundaryError) return { ok: false, output: `错误：${e.message}` };
    return { ok: false, output: `LSP 错误：${(e as Error).message}` };
  }
}

// ───────────────────────── formatting ─────────────────────────
const SEV: Record<LspDiagnostic['severity'], string> = { error: '错误', warning: '警告', info: '信息', hint: '提示' };
const SEV_RANK: Record<LspDiagnostic['severity'], number> = { error: 0, warning: 1, info: 2, hint: 3 };

function formatDiagnostics(rel: string, server: string, diags: LspDiagnostic[], fresh: boolean, waitMs: number): string {
  const shown = diags.filter((d) => d.severity !== 'hint').sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity] || a.line - b.line || a.column - b.column);
  const hints = diags.length - shown.length;
  const count = (s: LspDiagnostic['severity']) => shown.filter((d) => d.severity === s).length;
  const stale = fresh ? '' : `\n（注意：${Math.round(waitMs / 100) / 10}s 内未收到语言服务器的最新诊断，结果可能不完整；可增大 wait_ms 重试）`;
  if (!shown.length) return `${rel}（${server}）：未发现错误或警告${hints ? `（另有 ${hints} 条提示）` : ''}${stale}`;
  const parts = [`${count('error')} 个错误`, `${count('warning')} 个警告`, count('info') ? `${count('info')} 条信息` : '', hints ? `另有 ${hints} 条提示未列出` : ''].filter(Boolean);
  const body = shown.slice(0, 80).map((d) => `${rel}:${d.line}:${d.column} ${SEV[d.severity]}${d.code ? ` [${d.code}]` : ''} ${oneLine(d.message, 300)}${d.source && d.source !== server ? `（${d.source}）` : ''}`);
  const more = shown.length > 80 ? `\n…另有 ${shown.length - 80} 条未列出` : '';
  return `${rel}（${server}）：${parts.join('，')}\n${body.join('\n')}${more}${stale}`;
}

function formatWorkspaceSymbols(query: string, r: Awaited<ReturnType<LspManager['workspaceSymbols']>>): Out {
  const names = r.servers.map((s) => s.name).join('、');
  const errs = r.errors.length ? `\n（${r.errors.join('；')}）` : '';
  if (!r.symbols.length) return { ok: r.errors.length < r.servers.length, output: `未找到匹配 “${query}” 的符号（${names}）${errs}` };
  // inside the workspace first, exact name matches first
  const q = query.toLowerCase();
  const syms = [...r.symbols].sort((a, b) => Number(a.location.external) - Number(b.location.external) || Number(b.name.toLowerCase() === q) - Number(a.name.toLowerCase() === q) || a.location.path.localeCompare(b.location.path) || a.location.line - b.location.line);
  const body = syms.slice(0, MAX_LIST).map((s) => `${s.kindName} ${s.name}${s.container ? ` — ${s.container}` : ''}  ${where(s.location)}`);
  const more = syms.length > MAX_LIST || r.truncated ? `\n…结果过多，仅列出前 ${Math.min(MAX_LIST, syms.length)} 个，请使用更精确的名称` : '';
  return { ok: true, output: `匹配 “${query}” 的符号 ${syms.length} 个（${names}）：\n${body.join('\n')}${more}${errs}` };
}

function unavailableText(e: LspUnavailableError): string {
  const fallback = '在此之前请改用 search / outline / read_file 工具。';
  const list = e.candidates.map((c) => `- ${c.hint}${c.note ? `（${c.note}）` : ''}`).join('\n');
  switch (e.reason) {
    case 'missing':
      return list ? `未检测到 ${e.language} 的语言服务器，无法进行 LSP 分析。可安装以下任一（安装后 Edict 会自动检测，无需重启）：\n${list}\n${fallback}` : `${e.message}。${fallback}`;
    case 'disabled':
      return `${e.message}（可在「设置 → 语言服务」中启用）。${fallback}`;
    case 'failed':
      return `${e.message}${e.detail ? `：${oneLine(e.detail, 400)}` : ''}。皇上可在「设置 → 语言服务」中重启该服务器；${fallback}`;
    default:
      return `${e.message}。${fallback}`;
  }
}

function symbolLine(s: LspSymbol): string {
  const detail = s.detail ? ` — ${oneLine(s.detail, 80)}` : '';
  return `${'  '.repeat(Math.min(s.depth, 8))}${s.kindName} ${s.name}${detail}  :${s.location.line}`;
}

function where(l: LspLocation): string {
  return l.external ? `[工作区外] ${l.path}:${l.line}:${l.column}` : `${l.path}:${l.line}:${l.column}`;
}

function locationLine(l: LspLocation, lines: LineCache): string {
  if (l.external) return where(l);
  const src = lines.get(l.path)?.[l.line - 1];
  return src === undefined ? where(l) : `${where(l)}  ${oneLine(src.trim(), 160)}`;
}

function sortLocations(locs: LspLocation[]): LspLocation[] {
  return [...locs].sort((a, b) => Number(a.external) - Number(b.external) || a.path.localeCompare(b.path) || a.line - b.line || a.column - b.column);
}

function oneLine(s: string, max: number): string {
  const t = s.split('\n').map((x) => x.trim()).filter(Boolean).join(' ⏎ ');
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}\n…（已截断，原长 ${s.length} 字符）` : s;
}

/** 1-based column of `name` on a line: whole-word match first, then any substring. */
export function findColumn(lineText: string, name: string): number | null {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`(?<![\\w$])${esc}(?![\\w$])`).exec(lineText);
  const i = m ? m.index : lineText.indexOf(name);
  return i >= 0 ? i + 1 : null;
}

/** Reads workspace files once per tool call, for line previews (never outside the workspace). */
class LineCache {
  private m = new Map<string, string[] | null>();
  constructor(private ws: Workspace) {}
  get(rel: string): string[] | null {
    if (!this.m.has(rel)) {
      let v: string[] | null = null;
      try {
        v = this.ws.read(rel).split('\n');
      } catch {
        /* unreadable / outside / too big */
      }
      this.m.set(rel, v);
    }
    return this.m.get(rel)!;
  }
}
