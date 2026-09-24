// Agent tools with permission control and workspace path boundaries.
import path from 'node:path';
import type { AgentId, RunNode, Task } from '../../shared/types';
import type { ToolSpec } from '../llm/types';
import type { Runtime } from './runtime';
import { decide, type ToolClass } from './permissions';
import { runCommand } from '../services/exec';
import { truncate } from './util';
import { PathBoundaryError } from '../services/workspace';

export type ToolName = 'list_dir' | 'read_file' | 'search' | 'outline' | 'write_file' | 'edit_file' | 'delete_file' | 'run_command' | 'load_skill' | 'view_changes';

export const READ_TOOLS: ToolName[] = ['list_dir', 'read_file', 'search', 'outline', 'load_skill'];
export const ALL_TOOLS: ToolName[] = ['list_dir', 'read_file', 'search', 'outline', 'write_file', 'edit_file', 'delete_file', 'run_command', 'load_skill'];

const S = (props: Record<string, unknown>, required: string[]) => ({ type: 'object', properties: props, required, additionalProperties: false });

export const TOOL_SPECS: Record<ToolName, ToolSpec> = {
  list_dir: { name: 'list_dir', description: '列出工作区内某目录的文件与子目录', parameters: S({ path: { type: 'string', description: '相对工作区的目录，默认 .' } }, []) },
  read_file: { name: 'read_file', description: '读取文件内容（带行号）。大文件请指定行范围。', parameters: S({ path: { type: 'string' }, start_line: { type: 'integer' }, end_line: { type: 'integer' } }, ['path']) },
  search: { name: 'search', description: '在工作区内全文搜索（默认字面量，可选正则），返回 文件:行号: 内容', parameters: S({ query: { type: 'string' }, regex: { type: 'boolean' }, include: { type: 'string', description: 'glob，如 *.ts,src/**' } }, ['query']) },
  outline: { name: 'outline', description: '获取文件的符号大纲（函数/类/类型及行号），用于按需定位而非整文件读取', parameters: S({ path: { type: 'string' } }, ['path']) },
  write_file: { name: 'write_file', description: '创建或覆盖文件（完整内容）', parameters: S({ path: { type: 'string' }, content: { type: 'string' } }, ['path', 'content']) },
  edit_file: { name: 'edit_file', description: '精确字符串替换编辑文件：old_string 必须在文件中唯一出现（或设置 replace_all）', parameters: S({ path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' }, replace_all: { type: 'boolean' } }, ['path', 'old_string', 'new_string']) },
  delete_file: { name: 'delete_file', description: '删除文件（高风险，需要皇上确认）', parameters: S({ path: { type: 'string' } }, ['path']) },
  run_command: { name: 'run_command', description: '在工作区根目录执行 shell 命令（运行测试、构建、检查）。高风险命令需确认。', parameters: S({ command: { type: 'string' }, timeout_sec: { type: 'integer' } }, ['command']) },
  load_skill: { name: 'load_skill', description: '加载一项技能（Skill）的完整说明', parameters: S({ name: { type: 'string' } }, ['name']) },
  view_changes: { name: 'view_changes', description: '查看本旨意迄今所有文件改动（统一 diff 摘要，系统记录，非 Agent 自述）', parameters: S({ path: { type: 'string', description: '可选：只看某文件' } }, []) },
};

const CLASS: Record<ToolName, ToolClass> = {
  list_dir: 'read', read_file: 'read', search: 'read', outline: 'read', load_skill: 'meta', view_changes: 'meta',
  write_file: 'write', edit_file: 'write', delete_file: 'write', run_command: 'command',
};

export interface ToolContext {
  rt: Runtime;
  task?: Task;
  node?: RunNode;
  agentId: AgentId;
  signal?: AbortSignal;
}

function numbered(text: string, start: number): string {
  return text
    .split('\n')
    .map((l, i) => `${String(start + i).padStart(5)}│${l}`)
    .join('\n');
}

export function simpleDiff(before: string, after: string, maxLines = 120): string {
  const a = before.split('\n');
  const b = after.split('\n');
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let ea = a.length - 1;
  let eb = b.length - 1;
  while (ea >= s && eb >= s && a[ea] === b[eb]) {
    ea--;
    eb--;
  }
  const out = [`@@ -${s + 1},${ea - s + 1} +${s + 1},${eb - s + 1} @@`];
  for (let i = s; i <= ea; i++) out.push(`-${a[i]}`);
  for (let i = s; i <= eb; i++) out.push(`+${b[i]}`);
  if (out.length > maxLines) return out.slice(0, maxLines).join('\n') + `\n…（共 ${out.length} 行差异，已截断）`;
  return out.join('\n');
}

export async function executeTool(ctx: ToolContext, name: string, args: Record<string, unknown>): Promise<{ ok: boolean; output: string }> {
  const { rt, task, agentId } = ctx;
  const tool = name as ToolName;
  if (!TOOL_SPECS[tool]) return { ok: false, output: `未知工具：${name}` };
  if (args.__unparsed) return { ok: false, output: `参数不是合法 JSON：${String(args.__unparsed).slice(0, 200)}` };
  const str = (k: string) => (typeof args[k] === 'string' ? (args[k] as string) : args[k] === undefined ? '' : String(args[k]));

  if (tool === 'load_skill') {
    const sk = rt.skills.find((s) => s.name === str('name'));
    if (!sk) return { ok: false, output: `技能不存在：${str('name')}；可用：${rt.skills.map((s) => s.name).join(', ')}` };
    try {
      const fs = await import('node:fs');
      return { ok: true, output: truncate(fs.readFileSync(sk.path, 'utf8'), 12000) };
    } catch (e) {
      return { ok: false, output: String(e) };
    }
  }
  if (tool === 'view_changes') {
    if (!task) return { ok: true, output: '（无旨意上下文）' };
    const filter = str('path');
    const latest = new Map<string, { first: string | null; last: string | null }>();
    for (const c of task.changes) {
      if (c.reverted) continue;
      if (filter && c.path !== filter) continue;
      const e = latest.get(c.path);
      if (!e) latest.set(c.path, { first: c.beforeHash, last: c.afterHash });
      else e.last = c.afterHash;
    }
    if (!latest.size) return { ok: true, output: '本旨意尚无文件改动记录。' };
    const parts: string[] = [];
    for (const [p, { first, last }] of latest) {
      const before = first ? rt.blobs.get(first)?.toString('utf8') ?? '' : '';
      const after = last ? rt.blobs.get(last)?.toString('utf8') ?? '' : '';
      parts.push(`### ${p} ${first ? (last ? '(修改)' : '(删除)') : '(新建)'}\n${simpleDiff(before, after, 80)}`);
    }
    return { ok: true, output: truncate(parts.join('\n\n'), 14000) };
  }

  let ws;
  try {
    ws = rt.requireWorkspace();
  } catch (e) {
    return { ok: false, output: (e as Error).message };
  }

  // permission decision
  const target = str('path');
  let verdict;
  try {
    verdict = decide(rt.settings.permissionMode, CLASS[tool], {
      command: tool === 'run_command' ? str('command') : undefined,
      sensitive: target ? ws.isSensitive(target) : false,
      deleting: tool === 'delete_file',
    });
  } catch (e) {
    return { ok: false, output: String(e) };
  }
  if (verdict.decision === 'deny') {
    rt.audit.record(agentId, 'tool_denied', { tool, reason: verdict.reason, path: target || undefined }, task?.id);
    return { ok: false, output: `权限拒绝：${verdict.reason}` };
  }
  if (verdict.decision === 'ask') {
    const summary = tool === 'run_command' ? `执行命令：${str('command').slice(0, 160)}` : tool === 'delete_file' ? `删除文件：${target}` : `${tool === 'read_file' ? '读取' : '写入'}文件：${target}`;
    const detail = tool === 'write_file' ? truncate(str('content'), 4000) : tool === 'edit_file' ? `- ${truncate(str('old_string'), 1500)}\n+ ${truncate(str('new_string'), 1500)}` : JSON.stringify(args, null, 2).slice(0, 3000);
    const ok = await rt.requestApproval({ taskId: task?.id, agentId, nodeId: ctx.node?.id, tool, summary, detail, risk: verdict.risk, reason: verdict.reason });
    rt.setAgent(agentId, { status: 'tool', activity: ok ? `已获准：${summary}` : `被驳回：${summary}` });
    if (!ok) return { ok: false, output: `皇上未批准此操作（${verdict.reason}）。请调整方案（例如改用更安全的做法）或在结论中说明。` };
  }

  try {
    switch (tool) {
      case 'list_dir': {
        const items = ws.listDir(target || '.');
        return { ok: true, output: items.map((i) => (i.dir ? `${i.name}/` : `${i.name} (${i.size}B)`)).join('\n') || '（空目录）' };
      }
      case 'read_file': {
        const text = ws.read(target);
        const lines = text.split('\n');
        const start = Math.max(1, Number(args.start_line) || 1);
        const end = Math.min(lines.length, Number(args.end_line) || start + 399);
        const body = numbered(lines.slice(start - 1, end).join('\n'), start);
        const more = end < lines.length ? `\n…（共 ${lines.length} 行，已显示 ${start}-${end}，可指定 start_line 继续）` : '';
        return { ok: true, output: truncate(body, 14000) + more };
      }
      case 'search': {
        const res = ws.search(str('query'), { regex: !!args.regex, include: str('include') || undefined, maxResults: 80 });
        return { ok: true, output: res.length ? res.map((r) => `${r.path}:${r.line}: ${r.preview.trim()}`).join('\n') : '无匹配' };
      }
      case 'outline': {
        const o = ws.outline(target);
        return { ok: true, output: o.length ? o.join('\n') : '（未识别到符号）' };
      }
      case 'write_file': {
        const before = ws.readBuffer(target);
        const content = str('content');
        ws.write(target, content);
        rt.recordChange(task, agentId, ctx.node?.id, ws.rel(ws.resolve(target)), before, Buffer.from(content));
        return { ok: true, output: `已写入 ${target}（${Buffer.byteLength(content)} 字节，${before ? '覆盖' : '新建'}）` };
      }
      case 'edit_file': {
        const before = ws.read(target);
        const oldS = str('old_string');
        const newS = str('new_string');
        if (!oldS) return { ok: false, output: 'old_string 不能为空；新建文件请用 write_file' };
        const count = before.split(oldS).length - 1;
        if (count === 0) return { ok: false, output: `未找到 old_string，请先 read_file 确认原文（注意空白与缩进）` };
        if (count > 1 && !args.replace_all) return { ok: false, output: `old_string 出现 ${count} 次，不唯一；请扩大上下文或设置 replace_all` };
        const after = args.replace_all ? before.split(oldS).join(newS) : before.replace(oldS, () => newS);
        ws.write(target, after);
        rt.recordChange(task, agentId, ctx.node?.id, ws.rel(ws.resolve(target)), Buffer.from(before), Buffer.from(after));
        return { ok: true, output: `已编辑 ${target}（替换 ${args.replace_all ? count : 1} 处）\n${simpleDiff(before, after, 40)}` };
      }
      case 'delete_file': {
        const before = ws.readBuffer(target);
        if (!before) return { ok: false, output: '文件不存在' };
        ws.remove(target);
        rt.recordChange(task, agentId, ctx.node?.id, ws.rel(ws.resolve(target)), before, null);
        return { ok: true, output: `已删除 ${target}` };
      }
      case 'run_command': {
        const cmd = str('command');
        const timeout = Math.min(600, Math.max(5, Number(args.timeout_sec) || 120)) * 1000;
        const r = await runCommand(cmd, ws.root, { timeoutMs: timeout, signal: ctx.signal });
        rt.audit.record(agentId, 'command', { command: cmd, exitCode: r.exitCode, timedOut: r.timedOut, durationMs: r.durationMs }, task?.id);
        rt.emit({ type: 'fs_changed', paths: [] });
        const out = [`$ ${cmd}`, `exit=${r.exitCode}${r.timedOut ? '（超时被终止）' : ''} · ${r.durationMs}ms`, r.stdout && `stdout:\n${truncate(r.stdout, 8000)}`, r.stderr && `stderr:\n${truncate(r.stderr, 4000)}`].filter(Boolean).join('\n');
        return { ok: r.exitCode === 0 && !r.timedOut, output: out };
      }
    }
  } catch (e) {
    if (e instanceof PathBoundaryError) rt.audit.record(agentId, 'path_boundary_violation', { tool, path: target, error: e.message }, task?.id);
    return { ok: false, output: `错误：${(e as Error).message}` };
  }
  return { ok: false, output: '未处理的工具' };
}

export const describeToolCall = (name: string, args: Record<string, unknown>): string => {
  const p = typeof args.path === 'string' ? args.path : '';
  switch (name) {
    case 'run_command':
      return `$ ${String(args.command ?? '').slice(0, 120)}`;
    case 'search':
      return `搜索 “${String(args.query ?? '')}”`;
    case 'write_file':
      return `写入 ${p}`;
    case 'edit_file':
      return `编辑 ${p}`;
    case 'read_file':
      return `读取 ${p}${args.start_line ? `:${args.start_line}-${args.end_line ?? ''}` : ''}`;
    case 'list_dir':
      return `列目录 ${p || '.'}`;
    case 'outline':
      return `大纲 ${p}`;
    case 'delete_file':
      return `删除 ${p}`;
    case 'load_skill':
      return `加载技能 ${String(args.name ?? '')}`;
    case 'view_changes':
      return `查看改动${p ? ' ' + p : ''}`;
    default:
      return `${name} ${path.basename(p)}`;
  }
};
