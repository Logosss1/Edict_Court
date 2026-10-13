// Agent tools with permission control and workspace path boundaries.
import path from 'node:path';
import type { AgentId, ApprovalChoice, FileChange, PermissionMode, PreviewResult, RunNode, Task } from '../../shared/types';
import type { ToolSpec } from '../llm/types';
import type { Runtime } from './runtime';
import { allowedByRules, classifyCommand, decide, effectiveMode, isLookCommand, PERMISSION_LABEL, ruleFor, type RiskVerdict, type ToolClass } from './permissions';
import { runCommand } from '../services/exec';
import { sha256, truncate } from './util';
import { PathBoundaryError, type Workspace } from '../services/workspace';
import { OVERSIZE, type ShadowChange } from '../services/shadowSnapshot';
import { isAllowedPreviewUrl, previewHostFor, previewUrlFor } from '../services/preview';
import { PREVIEW_LIMITS, parsePreviewPlan, storePreviewShots } from '../services/previewActions';
import { executeMcpResourceTool, isMcpResourceTool } from '../mcp/resourceTools';
import { skillRole } from '../../shared/skills';
import { LSP_TOOL_SPEC, describeLspCall, runLspTool } from '../lsp/tool';
import { ASK_EMPEROR_SPEC, askEmperor } from './askEmperor';

export type ToolName = 'list_dir' | 'read_file' | 'search' | 'outline' | 'lsp' | 'write_file' | 'edit_file' | 'delete_file' | 'run_command' | 'load_skill' | 'view_changes' | 'preview_page' | 'ask_emperor';

export const READ_TOOLS: ToolName[] = ['list_dir', 'read_file', 'search', 'outline', 'lsp', 'load_skill'];
export const ALL_TOOLS: ToolName[] = ['list_dir', 'read_file', 'search', 'outline', 'lsp', 'write_file', 'edit_file', 'delete_file', 'run_command', 'load_skill', 'preview_page', 'ask_emperor'];

const S = (props: Record<string, unknown>, required: string[]) => ({ type: 'object', properties: props, required, additionalProperties: false });

/** One preview_page step: exactly one action field per step (parsePreviewActions enforces it). */
const PREVIEW_STEP_SCHEMA = {
  type: 'object',
  description: '每步只写一个动作，如 {"click":"#start"}',
  properties: {
    click: { type: 'string', description: 'CSS 选择器：点击' },
    fill: { type: 'string', description: 'CSS 选择器：向输入框填入 value（触发 input/change）' },
    select: { type: 'string', description: '<select> 的 CSS 选择器：按 value（选项值或文字）选择' },
    value: { type: 'string' },
    check: { type: 'string', description: '复选框/单选框的 CSS 选择器' },
    checked: { type: 'boolean', description: 'check 的目标状态，默认 true' },
    press: { type: 'string', description: 'Enter / Tab / Escape / Space / Backspace / ArrowDown 等或单个字符，可加 Shift+ 前缀' },
    selector: { type: 'string', description: 'press 的目标元素（默认当前焦点）；assertText 的查找范围' },
    wait: { type: 'integer', description: `等待毫秒，最多 ${PREVIEW_LIMITS.waitMs}` },
    waitFor: { type: 'string', description: 'CSS 选择器：等它出现且可见' },
    timeoutMs: { type: 'integer', description: `找元素/断言最多等多久，默认 ${PREVIEW_LIMITS.autoWaitMs}（waitFor 默认 ${PREVIEW_LIMITS.waitForMs}），最多 ${PREVIEW_LIMITS.timeoutMs}` },
    scroll: { type: 'string', description: 'CSS 选择器（滚到该元素）、纵坐标数字，或 top / bottom' },
    screenshot: { type: 'boolean', description: '单独一步 = 此刻截图；附在其它动作上 = 该步后截图' },
    assertText: { type: 'string', description: '断言页面（或 selector 内）包含该文本，否则该步失败' },
    assertVisible: { type: 'string', description: 'CSS 选择器：断言元素存在且可见' },
    optional: { type: 'boolean', description: '该步失败时继续执行后续步骤' },
  },
  additionalProperties: false,
};
const VIEWPORT_SCHEMA = { type: 'object', properties: { width: { type: 'integer' }, height: { type: 'integer' } }, required: ['width', 'height'], additionalProperties: false };

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
  preview_page: {
    name: 'preview_page',
    description: '在内置无头浏览器中打开工作区内的 HTML 页面（或本机 localhost 开发服务器）并截图，返回标题、可见文本、控制台错误与加载失败的资源。可用 actions 按顺序点击、填写、按键、选择、断言，真正操作一遍页面（遇到失败的步骤即停，结果逐步列出）；viewports 可在操作后再截手机等尺寸检查响应式布局。用于验证网页产物能否正常运行。',
    parameters: S({
      path: { type: 'string', description: '工作区内的 HTML 相对路径，如 index.html' },
      url: { type: 'string', description: '或本机开发服务器地址，如 http://localhost:5173/' },
      wait_ms: { type: 'integer', description: '加载后额外等待毫秒数（动画/异步渲染），默认 800，最大 10000' },
      width: { type: 'integer', description: '视口宽度，默认 1280' },
      height: { type: 'integer', description: '视口高度，默认 800' },
      actions: { type: 'array', maxItems: PREVIEW_LIMITS.steps, description: `交互步骤，按顺序执行（最多 ${PREVIEW_LIMITS.steps} 步、共 ${PREVIEW_LIMITS.totalMs / 1000} 秒）。例：[{"fill":"#name","value":"张三"},{"click":"button[type=submit]"},{"assertText":"提交成功"}]`, items: PREVIEW_STEP_SCHEMA },
      viewport: { ...VIEWPORT_SCHEMA, description: '主视口尺寸（等同 width/height）' },
      viewports: { type: 'array', maxItems: PREVIEW_LIMITS.viewports, description: '操作完成后再按这些尺寸各截一张图并检查横向溢出，如 [{"width":375,"height":812}]', items: VIEWPORT_SCHEMA },
    }, []),
  },
  lsp: LSP_TOOL_SPEC,
  ask_emperor: ASK_EMPEROR_SPEC,
  view_changes: { name: 'view_changes', description: '查看本旨意迄今所有文件改动（统一 diff 摘要，系统记录，非 Agent 自述）', parameters: S({ path: { type: 'string', description: '可选：只看某文件' } }, []) },
};

const CLASS: Record<ToolName, ToolClass> = {
  list_dir: 'read', read_file: 'read', search: 'read', outline: 'read', lsp: 'read', load_skill: 'meta', view_changes: 'meta', ask_emperor: 'meta',
  write_file: 'write', edit_file: 'write', delete_file: 'write', run_command: 'command', preview_page: 'read',
};

export interface ToolContext {
  rt: Runtime;
  task?: Task;
  node?: RunNode;
  agentId: AgentId;
  signal?: AbortSignal;
  /** files this run has read: workspace-relative path → sha256 when read (read-before-overwrite guard) */
  reads?: Map<string, string>;
}

/**
 * Last content this edict itself wrote to `rel` with a file tool (unreverted), or undefined. Command side
 * effects (R7) do not count: the agent never saw what `sed -i` or a formatter left there.
 */
function ownHash(task: Task | undefined, rel: string): string | null | undefined {
  if (!task) return undefined;
  for (let i = task.changes.length - 1; i >= 0; i--) {
    const c = task.changes[i];
    if (c.path === rel && !c.reverted && c.via !== 'command') return c.afterHash;
  }
  return undefined;
}

/**
 * Editing or overwriting an existing file requires that this run read it first and that it has not
 * changed since — unless the file is still exactly what this edict last wrote. Returns an error or null.
 */
function staleGuard(ctx: ToolContext, ws: { readBuffer(p: string): Buffer | null; rel(p: string): string; resolve(p: string): string }, target: string): string | null {
  if (!ctx.reads) return null;
  const buf = ws.readBuffer(target);
  if (!buf) return null;
  const rel = ws.rel(ws.resolve(target));
  const cur = sha256(buf);
  const seen = ctx.reads.get(rel);
  if (seen === cur || ownHash(ctx.task, rel) === cur) return null;
  return seen
    ? `${rel} 在你读取之后已被修改（可能是皇上或其他官员改的）。请重新 read_file 看最新内容后再改。`
    : `${rel} 已存在，本轮还没读过它。编辑或覆盖已有文件前请先 read_file，免得改坏没看过的内容。`;
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
  if (isMcpResourceTool(name)) return args.__unparsed ? { ok: false, output: `参数不是合法 JSON：${String(args.__unparsed).slice(0, 200)}` } : executeMcpResourceTool(ctx, name, args);
  if (name.startsWith('mcp__')) return args.__unparsed ? { ok: false, output: `参数不是合法 JSON：${String(args.__unparsed).slice(0, 200)}` } : mcpTool(ctx, name, args);
  if (!TOOL_SPECS[tool]) return { ok: false, output: `未知工具：${name}` };
  if (args.__unparsed) return { ok: false, output: `参数不是合法 JSON：${String(args.__unparsed).slice(0, 200)}` };
  const str = (k: string) => (typeof args[k] === 'string' ? (args[k] as string) : args[k] === undefined ? '' : String(args[k]));

  if (tool === 'load_skill') {
    const sk = rt.skills.find((s) => s.name === str('name') && skillRole(s, agentId));
    if (!sk) return { ok: false, output: `技能不存在或未配备给你：${str('name')}；你可用的：${rt.skills.filter((s) => skillRole(s, agentId)).map((s) => s.name).join(', ') || '（无）'}` };
    try {
      const fs = await import('node:fs');
      const text = fs.readFileSync(sk.path, 'utf8');
      // E8: which skill text (by hash) each official actually loaded during this edict
      if (task) {
        const used = task.skillsUsed ?? [];
        if (!used.some((u) => u.name === sk.name && u.agentId === agentId && u.sha256 === sk.sha256)) task.skillsUsed = [...used, { name: sk.name, agentId, sha256: sk.sha256, at: Date.now() }];
        rt.touch(task);
      }
      rt.audit.record(agentId, 'skill_loaded', { name: sk.name, sha256: sk.sha256, role: skillRole(sk, agentId) }, task?.id);
      return { ok: true, output: truncate(text, 12000) };
    } catch (e) {
      return { ok: false, output: String(e) };
    }
  }
  if (tool === 'view_changes') {
    if (!task) return { ok: true, output: '（无旨意上下文）' };
    const filter = str('path');
    const chains = new Map<string, FileChange[]>();
    for (const c of task.changes) {
      if (c.reverted) continue;
      if (filter && c.path !== filter) continue;
      chains.set(c.path, [...(chains.get(c.path) ?? []), c]);
    }
    if (!chains.size) return { ok: true, output: '本旨意尚无文件改动记录。' };
    const parts: string[] = [];
    for (const [p, list] of chains) {
      const first = list[0];
      const last = list[list.length - 1];
      const label = first.op === 'create' ? (last.op === 'delete' ? '(新建后又删除)' : '(新建)') : last.op === 'delete' ? '(删除)' : '(修改)';
      const cmds = [...new Set(list.filter((c) => c.via === 'command').map((c) => `\`${clip(c.command ?? '', 80)}\``))];
      const head = `### ${p} ${label}${cmds.length ? ` · 由命令 ${cmds.join('、')} 改动` : ''}`;
      if (list.some((c) => c.oversize)) {
        parts.push(`${head}\n（超过 ${fmtSize(rt.snapshots.limits.maxFileBytes)}，只记录了文件名，没有内容与差异）`);
        continue;
      }
      const before = first.beforeHash ? rt.blobs.get(first.beforeHash) : null;
      const after = last.afterHash ? rt.blobs.get(last.afterHash) : null;
      if (list.some((c) => c.binary)) parts.push(`${head}\n（二进制文件：${before?.length ?? 0} → ${after?.length ?? 0} 字节）`);
      else parts.push(`${head}\n${simpleDiff(before?.toString('utf8') ?? '', after?.toString('utf8') ?? '', 80)}`);
    }
    return { ok: true, output: truncate(parts.join('\n\n'), 14000) };
  }

  if (tool === 'preview_page') return previewPage(ctx, args);
  if (tool === 'ask_emperor') return askEmperor(ctx, args);

  // an edict works in its own worktree (or the workspace it was submitted on); chat in the open workspace
  const ws = rt.workspaceFor(task);
  if (!ws) return { ok: false, output: noWorkspace(task) };

  // permission decision
  const target = str('path');
  const cls = CLASS[tool];
  const node = ctx.node;
  const base = rt.settings.permissionMode;
  const cmd = tool === 'run_command' ? str('command') : '';
  let verdict: RiskVerdict;
  try {
    verdict = decide(effectiveMode(base, node?.grant), cls, {
      command: tool === 'run_command' ? cmd : undefined,
      sensitive: target ? ws.isSensitive(target) : false,
      deleting: tool === 'delete_file',
    });
  } catch (e) {
    return { ok: false, output: String(e) };
  }
  const summary = tool === 'run_command' ? `执行命令：${cmd.slice(0, 160)}` : tool === 'delete_file' ? `删除文件：${target}` : `${cls === 'read' ? '读取' : '写入'}文件：${target}`;
  const detail = tool === 'write_file' ? truncate(str('content'), 4000) : tool === 'edit_file' ? `- ${truncate(str('old_string'), 1500)}\n+ ${truncate(str('new_string'), 1500)}` : JSON.stringify(args, null, 2).slice(0, 3000);
  // does this call change anything? (writes, and commands beyond plain looking)
  const acting = cls === 'write' || (cls === 'command' && !isLookCommand(cmd));
  let preApproved = false;
  // R1: a subtask that started read-only asks to be upgraded the first time it wants to write or run a non-safe
  // command (high-risk actions skip this and go straight to their own confirmation)
  if (acting && node && readOnlyNode(node) && base !== 'auto' && verdict.risk !== 'high' && !(cls === 'command' && classifyCommand(cmd).safe)) {
    const d = await rt.requestDecision({
      kind: 'escalate', taskId: task?.id, agentId, nodeId: node.id, tool,
      summary: `只读子任务要${cls === 'write' ? '改文件' : '执行命令'}：${summary.replace(/^[^：]+：/, '')}`,
      detail, risk: 'normal', reason: `「${node.label}」按只读子任务开工，现在要${cls === 'write' ? '写入文件' : '执行命令'}。`,
      choices: escalateChoices(base),
    });
    rt.setAgent(agentId, { status: 'tool', activity: d.approve ? `已获准：${summary}` : `被驳回：${summary}` });
    if (!d.approve) return { ok: false, output: deniedText('只读子任务未获准写入', d.comment) };
    if (d.choice === 'write' || d.choice === 'write_free') {
      node.grant = d.choice;
      node.grantNote = d.comment;
      rt.audit.record('emperor', 'node_grant', { node: node.id, grant: d.choice, via: 'escalate', comment: d.comment ?? null }, task?.id);
      if (task) rt.touch(task);
    }
    preApproved = true;
  }
  if (!preApproved) {
    if (verdict.decision === 'deny') {
      rt.audit.record(agentId, 'tool_denied', { tool, reason: verdict.reason, path: target || undefined }, task?.id);
      if (node?.grant === 'readonly') return { ok: false, output: '皇上要求本子任务只读执行：不能写文件或执行会改动东西的命令。请只做分析，在结论里给出修改建议。' };
      return { ok: false, output: `权限拒绝：${verdict.reason}` };
    }
    if (verdict.decision === 'ask') {
      const d = await askAction(ctx, tool, args, verdict, summary, detail);
      rt.setAgent(agentId, { status: 'tool', activity: d.approve ? `已获准：${summary}` : `被驳回：${summary}` });
      if (!d.approve) return { ok: false, output: deniedText(verdict.reason, d.comment) };
    }
  }
  // one writer per edict at a time; nodes that change things are not auto-resumed after a restart
  if (acting && node) {
    node.sideEffects = true;
    if (task) await rt.acquireWriteLock(task.id, node.id, ctx.signal);
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
        const buf = ws.readBuffer(target);
        if (buf) ctx.reads?.set(ws.rel(ws.resolve(target)), sha256(buf));
        return { ok: true, output: truncate(body, 14000) + more };
      }
      case 'search': {
        // key files are never searched by agents (read_file asks first; search must not leak them silently)
        const res = ws.search(str('query'), { regex: !!args.regex, include: str('include') || undefined, maxResults: 80, skipSensitive: true });
        return { ok: true, output: res.length ? res.map((r) => `${r.path}:${r.line}: ${r.preview.trim()}`).join('\n') : '无匹配（.env、密钥等敏感文件不在搜索范围内）' };
      }
      case 'outline': {
        const o = ws.outline(target);
        return { ok: true, output: o.length ? o.join('\n') : '（未识别到符号）' };
      }
      case 'lsp': {
        if (target) ws.resolve(target); // boundary check (audited below on violation)
        return runLspTool(rt.lspFor(ws), ws, args);
      }
      case 'write_file': {
        const stale = staleGuard(ctx, ws, target);
        if (stale) return { ok: false, output: stale };
        const before = ws.readBuffer(target);
        const content = str('content');
        ws.write(target, content);
        const rel = ws.rel(ws.resolve(target));
        rt.recordChange(task, agentId, ctx.node?.id, rel, before, Buffer.from(content));
        ctx.reads?.set(rel, sha256(Buffer.from(content)));
        return { ok: true, output: `已写入 ${target}（${Buffer.byteLength(content)} 字节，${before ? '覆盖' : '新建'}）` };
      }
      case 'edit_file': {
        const stale = staleGuard(ctx, ws, target);
        if (stale) return { ok: false, output: stale };
        const before = ws.read(target);
        const oldS = str('old_string');
        const newS = str('new_string');
        if (!oldS) return { ok: false, output: 'old_string 不能为空；新建文件请用 write_file' };
        const count = before.split(oldS).length - 1;
        if (count === 0) return { ok: false, output: `未找到 old_string，请先 read_file 确认原文（注意空白与缩进）` };
        if (count > 1 && !args.replace_all) return { ok: false, output: `old_string 出现 ${count} 次，不唯一；请扩大上下文或设置 replace_all` };
        const after = args.replace_all ? before.split(oldS).join(newS) : before.replace(oldS, () => newS);
        ws.write(target, after);
        const rel = ws.rel(ws.resolve(target));
        rt.recordChange(task, agentId, ctx.node?.id, rel, Buffer.from(before), Buffer.from(after));
        ctx.reads?.set(rel, sha256(Buffer.from(after)));
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
        const exec = () => runCommand(cmd, ws.root, { timeoutMs: timeout, signal: ctx.signal });
        // R7: a command that may change files runs between two shadow snapshots; what differs is recorded like a
        // file-tool change (revertable). The edict's write lock is held here, so its own writes never interleave.
        const track = rt.settings.commandSnapshots !== false && !isLookCommand(cmd);
        const s = track ? await rt.snapshots.around(ws.root, exec) : null;
        const r = s ? s.result : await exec();
        const rec = s?.tracked ? recordCommandChanges(ctx, ws, cmd, s.changes) : null;
        rt.audit.record(agentId, 'command', { command: cmd, exitCode: r.exitCode, timedOut: r.timedOut, durationMs: r.durationMs, ...(rec ? { changed: rec.count } : {}) }, task?.id);
        if (s && !s.tracked) rt.audit.record('system', 'command_snapshot_skipped', { command: truncate(cmd, 300), reason: s.note ?? '' }, task?.id);
        if (ws === rt.workspace) rt.emit({ type: 'fs_changed', paths: [] });
        let note = '';
        if (s && !s.tracked) note = `（未能记录命令的文件改动：${s.note ?? '快照不可用'}）`;
        else if (s && rec?.count) {
          const big = rec.oversize ? `；其中 ${rec.oversize} 个超过 ${fmtSize(rt.snapshots.limits.maxFileBytes)}，只记了文件名，不能撤回` : '';
          note = `（命令改动了 ${rec.count} 个文件，已记录，可撤回${big}${s.truncated ? `；实际改动 ${s.total} 个，只记录了前 ${rec.count} 个` : ''}）`;
        }
        const out = [`$ ${cmd}`, `exit=${r.exitCode}${r.timedOut ? '（超时被终止）' : ''} · ${r.durationMs}ms`, r.stdout && `stdout:\n${truncate(r.stdout, 8000)}`, r.stderr && `stderr:\n${truncate(r.stderr, 4000)}`, note].filter(Boolean).join('\n');
        return { ok: r.exitCode === 0 && !r.timedOut, output: out };
      }
    }
  } catch (e) {
    if (e instanceof PathBoundaryError) rt.audit.record(agentId, 'path_boundary_violation', { tool, path: target, error: e.message }, task?.id);
    return { ok: false, output: `错误：${(e as Error).message}` };
  }
  return { ok: false, output: '未处理的工具' };
}

/**
 * Record what a command changed (R7): before = the shadow snapshot, after = disk now, marked via 'command'.
 * Edits a human made on disk while the command ran land here too (the snapshot pair cannot tell them apart).
 */
function recordCommandChanges(ctx: ToolContext, ws: Workspace, cmd: string, changes: ShadowChange[]): { count: number; oversize: number } {
  let count = 0;
  let oversize = 0;
  for (const c of changes) {
    let rel: string;
    try {
      rel = ws.rel(ws.resolve(c.path));
    } catch {
      continue; // outside the boundary (symlink swap): never recorded, never reverted
    }
    const big = c.before === OVERSIZE || c.after === OVERSIZE;
    const op: FileChange['op'] = c.before === null ? 'create' : c.after === null ? 'delete' : 'modify';
    const buf = (x: ShadowChange['before']) => (Buffer.isBuffer(x) ? x : null);
    ctx.rt.recordChange(ctx.task, ctx.agentId, ctx.node?.id, rel, buf(c.before), buf(c.after), { via: 'command', command: cmd, op, oversize: big });
    count++;
    if (big) oversize++;
  }
  return { count, oversize };
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
const fmtSize = (n: number) => (n >= 1024 * 1024 ? `${+(n / 1024 / 1024).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`);

const readOnlyNode = (n: RunNode) => n.kind === 'exec' && (n.effect ?? 'read') === 'read' && !n.grant;

const noWorkspace = (task?: Task) => (task ? '本旨意的工作区当前不可用（已切换到别的文件夹，或独立工作树已不存在）' : '尚未打开工作区：请先选择项目文件夹');

const deniedText = (reason: string, comment?: string) => `皇上未批准此操作（${reason}）。${comment ? `皇上的话：${comment}\n` : ''}请调整方案（例如改用更安全的做法）或在结论中说明。`;

function escalateChoices(base: PermissionMode): ApprovalChoice[] {
  return [
    { id: 'write', label: '准许，本子任务改为写任务', hint: `之后按当前权限「${PERMISSION_LABEL[base === 'readonly' ? 'ask' : base]}」处理`, approve: true, tone: 'primary', comment: 'optional' },
    { id: 'write_free', label: '准许，本子任务内写入与命令免询问', hint: '高风险操作仍会询问', approve: true, comment: 'optional' },
    { id: 'once', label: '只准这一次', approve: true },
    { id: 'deny', label: '驳回', hint: '可写明要它怎么做', approve: false, tone: 'danger', comment: 'optional' },
  ];
}

/**
 * Ask about one action on an approval card. Release / deploy commands run without asking only when the workspace
 * opted in; other normal-risk actions can be allowed for this edict or this workspace. High risk always asks.
 */
async function askAction(ctx: ToolContext, tool: string, args: Record<string, unknown>, verdict: RiskVerdict, summary: string, detail: string): Promise<{ approve: boolean; comment?: string }> {
  const { rt, task, agentId, node } = ctx;
  const release = tool === 'run_command' && classifyCommand(String(args.command ?? '')).release;
  if (release && rt.releaseAllowed(task)) {
    rt.audit.record(agentId, 'approval_auto', { tool, summary, by: 'releaseAlways' }, task?.id);
    rt.activity('log', `本工作区已设为发版/部署永久允许，直接执行：${summary}`, { taskId: task?.id, agentId, nodeId: node?.id });
    return { approve: true };
  }
  const rule = verdict.risk === 'high' ? null : ruleFor(tool, args);
  if (rule && allowedByRules(rule.keys, rt.rulesFor(task))) {
    rt.audit.record(agentId, 'approval_auto', { tool, summary, keys: rule.keys }, task?.id);
    return { approve: true };
  }
  const root = rt.permRoot(task);
  const choices: ApprovalChoice[] = [
    { id: 'once', label: '准许', approve: true, tone: 'primary' },
    ...(rule && task ? [{ id: 'task', label: '准许，本旨意内不再询问', hint: rule.label, approve: true }] : []),
    ...(rule && root ? [{ id: 'workspace', label: '准许，本工作区永久允许', hint: rule.label, approve: true }] : []),
    { id: 'deny', label: '驳回', hint: '可写明要它怎么做', approve: false, tone: 'danger', comment: 'optional' },
  ];
  const d = await rt.requestDecision({
    kind: 'action', taskId: task?.id, agentId, nodeId: node?.id, tool, summary, detail, risk: verdict.risk,
    reason: release ? `${verdict.reason}（发版/部署每次确认；可在「权限」里为本工作区开启永久允许）` : verdict.reason,
    choices, ruleLabel: rule?.label,
  });
  if (d.approve && rule && (d.choice === 'task' || d.choice === 'workspace')) rt.addAllowRules(d.choice, task, rule.keys, rule.label, agentId);
  return d;
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
    case 'lsp':
      return describeLspCall(args);
    case 'delete_file':
      return `删除 ${p}`;
    case 'load_skill':
      return `加载技能 ${String(args.name ?? '')}`;
    case 'view_changes':
      return `查看改动${p ? ' ' + p : ''}`;
    case 'preview_page': {
      const n = (v: unknown) => (Array.isArray(v) ? v.length : 0);
      const steps = n(args.actions);
      const vps = n(args.viewports);
      return `预览 ${p || String(args.url ?? '') || 'index.html'}${steps ? ` · 交互 ${steps} 步` : ''}${vps ? ` · 另截 ${vps} 种尺寸` : ''}`;
    }
    case 'ask_emperor':
      return `请旨：${String(args.question ?? '').slice(0, 80)}`;
    case 'mcp_list_resources':
      return '列出 MCP 资源';
    case 'mcp_read_resource':
      return `读取 MCP 资源 ${String(args.server ?? '')}/${String(args.uri ?? '')}`;
    default:
      if (name.startsWith('mcp__')) return `MCP ${name.slice(5).replace('__', ' / ')}`;
      return `${name} ${path.basename(p)}`;
  }
};

async function previewPage(ctx: ToolContext, args: Record<string, unknown>): Promise<{ ok: boolean; output: string }> {
  const { rt, task, agentId } = ctx;
  if (!rt.opts.previewPage) return { ok: false, output: '预览不可用：内置浏览器仅在桌面应用中提供（当前为无界面运行环境）。请改用 run_command 做静态检查。' };
  const plan = parsePreviewPlan(args);
  if (!plan.ok) return { ok: false, output: `preview_page 参数有误：${plan.error}` };
  let url = typeof args.url === 'string' ? args.url.trim() : '';
  if (!url) {
    const p = typeof args.path === 'string' && args.path.trim() ? args.path.trim() : 'index.html';
    const ws = rt.workspaceFor(task);
    if (!ws) return { ok: false, output: noWorkspace(task) };
    try {
      if (!ws.exists(p)) return { ok: false, output: `文件不存在：${p}` };
      // an edict's worktree is served on its own origin (same read-only, boundary-checked server)
      url = previewUrlFor(ws.rel(ws.resolve(p)), task?.worktree?.status === 'active' ? previewHostFor(task.id) : undefined);
    } catch (e) {
      return { ok: false, output: (e as Error).message };
    }
  }
  if (!isAllowedPreviewUrl(url)) return { ok: false, output: `只允许预览工作区文件或本机 localhost 开发服务器：${url}` };
  const waitMs = Math.min(10000, Math.max(0, Number(args.wait_ms) || 800));
  const width = plan.viewport?.width ?? Math.min(2560, Math.max(320, Number(args.width) || 1280));
  const height = plan.viewport?.height ?? Math.min(1600, Math.max(320, Number(args.height) || 800));
  const r = await rt.opts.previewPage(url, { waitMs, width, height, ...(plan.actions.length ? { actions: plan.actions } : {}), ...(plan.viewports.length ? { viewports: plan.viewports } : {}) });
  const res: PreviewResult = storePreviewShots(r, (png) => rt.blobs.put(png));
  const shot = res.screenshot;
  const steps = res.steps ?? [];
  const stepPassed = steps.filter((s) => s.ok).length;
  const stepsOk = steps.every((s) => s.ok || (s.optional && !s.skipped));
  const firstBad = stepsOk ? undefined : steps.find((s) => !s.ok && !s.skipped && !s.optional) ?? steps.find((s) => !s.ok && !s.skipped);
  const errors = r.console.filter((c) => c.level === 'error');
  const warns = r.console.filter((c) => c.level === 'warning' || c.level === 'warn');
  const at = (c: { step?: number }) => (c.step ? `（第 ${c.step} 步期间）` : '');
  const pass = r.ok && !errors.length && stepsOk;
  const short = (u: string) => u.replace(/^preview:\/\/[^/]+\//, '');
  rt.audit.record(agentId, 'preview_page', { url, ok: r.ok, errors: errors.length, failed: r.failed.length, blocked: r.blocked.length, screenshot: shot ?? null, ...(steps.length ? { steps: steps.length, stepsPassed: stepPassed, stepsFailed: steps.length - stepPassed } : {}), ...(res.viewports?.length ? { viewports: res.viewports.map((v) => `${v.width}x${v.height}`) } : {}) }, task?.id);
  rt.activity('preview', `${pass ? '✅' : '⚠'} 预览 ${short(url)} · ${r.title || '（无标题）'} · 错误 ${errors.length}${steps.length ? ` · 交互 ${stepPassed}/${steps.length} 步通过` : ''}${res.viewports?.length ? ` · 另截 ${res.viewports.length} 种尺寸` : ''}`, { taskId: task?.id, agentId, nodeId: ctx.node?.id, data: res as unknown as Record<string, unknown> });
  const mark = (s: (typeof steps)[number]) => (s.ok ? '✓' : s.skipped ? '·' : s.optional ? '⚠' : '✗');
  const lines = [
    `URL: ${url}`,
    `加载：${r.ok ? '成功' : '失败'}（${r.loadMs}ms，视口 ${width}×${height}）`,
    `标题：${r.title || '（无）'}`,
    steps.length
      ? `交互检查：${stepsOk ? '通过' : '未通过'}（${stepPassed}/${steps.length} 步成功${firstBad ? `；第 ${firstBad.index} 步「${firstBad.action}」失败` : ''}${steps.some((s) => s.skipped) ? (firstBad ? '，后续步骤未执行' : '，步骤未执行') : ''}）\n${steps.map((s) => `  ${mark(s)} ${s.index}. ${s.action}${s.optional ? '（可选）' : ''} — ${truncate(s.note, 300)}${s.screenshot ? ' [截图]' : ''}`).join('\n')}`
      : '',
    `控制台错误 ${errors.length} 条${errors.length ? '：\n' + errors.slice(0, 20).map((c) => `  - ${c.message}${c.source ? ` (${short(c.source)}:${c.line ?? ''})` : ''}${at(c)}`).join('\n') : ''}`,
    warns.length ? `控制台警告 ${warns.length} 条：\n${warns.slice(0, 8).map((c) => `  - ${c.message}${at(c)}`).join('\n')}` : '',
    r.failed.length ? `加载失败的资源：\n${r.failed.slice(0, 20).map((f) => `  - ${f}`).join('\n')}` : '',
    r.blocked.length ? `已拦截的外部网络请求（预览默认仅允许本地资源；如需 CDN 请改用本地文件，或由皇上在预览中允许外部网络）：\n${r.blocked.slice(0, 12).map((f) => `  - ${f}`).join('\n')}` : '',
    res.viewports?.length
      ? `其它尺寸：\n${res.viewports.map((v) => `  - ${v.width}×${v.height}：${v.screenshot ? '已截图' : v.note ?? '未截图'}${v.overflowX ? `；⚠ 出现横向滚动（内容宽 ${v.contentWidth}px，超出视口）` : v.overflowX === false ? '；无横向溢出' : ''}`).join('\n')}`
      : '',
    `可见文本（${steps.length ? '操作后，' : ''}节选）：\n${truncate(r.text, 3000)}`,
    shot ? '已截图（皇上可在活动流中查看）。' : '',
  ].filter(Boolean);
  return { ok: pass, output: lines.join('\n') };
}

/** MCP tool call, gated by the per-tool policy (read / write / high) and the global permission mode. */
async function mcpTool(ctx: ToolContext, name: string, args: Record<string, unknown>): Promise<{ ok: boolean; output: string }> {
  const { rt, task, agentId } = ctx;
  const r = rt.mcp.resolve(name);
  if (!r) return { ok: false, output: `MCP 工具不可用：${name}（服务未连接或已停用）` };
  const { server, tool } = r;
  const st = rt.mcp.states.get(server)!;
  if (st.policy.agents !== 'all' && !st.policy.agents.includes(agentId)) return { ok: false, output: `该官员未获授权使用 MCP 服务 ${server}` };
  if (!tool.policy.enabled) return { ok: false, output: `MCP 工具已停用：${server}/${tool.name}` };
  const risk = tool.policy.risk;
  const mode = effectiveMode(rt.settings.permissionMode, ctx.node?.grant);
  const summary = `调用 MCP 工具 ${server} / ${tool.name}`;
  if (mode === 'readonly' && risk !== 'read') {
    rt.audit.record(agentId, 'tool_denied', { tool: name, reason: '只读模式' }, task?.id);
    return { ok: false, output: ctx.node?.grant === 'readonly' ? '皇上要求本子任务只读执行：只能使用标记为「只读」的 MCP 工具' : '权限拒绝：只读模式下只能使用标记为「只读」的 MCP 工具' };
  }
  const needAsk = risk === 'high' || (risk === 'write' && !tool.policy.autoApprove && mode !== 'auto');
  if (needAsk) {
    const verdict: RiskVerdict = { decision: 'ask', risk: risk === 'high' ? 'high' : 'normal', reason: risk === 'high' ? 'MCP 工具标记为高风险（外部副作用）' : 'MCP 工具可能产生外部副作用' };
    const d = await askAction(ctx, name, args, verdict, summary, truncate(JSON.stringify(args, null, 2), 3000));
    rt.setAgent(agentId, { status: 'tool', activity: d.approve ? `已获准：${summary}` : `被驳回：${summary}` });
    if (!d.approve) return { ok: false, output: `皇上未批准此 MCP 调用（${server}/${tool.name}）。${d.comment ? `皇上的话：${d.comment}\n` : ''}请调整方案或在结论中说明。` };
  }
  if (risk !== 'read' && ctx.node) ctx.node.sideEffects = true;
  const started = Date.now();
  try {
    const res = await rt.mcp.call(server, tool.name, args, ctx.signal);
    rt.audit.record(agentId, 'mcp_call', { server, tool: tool.name, risk, ok: res.ok, argKeys: Object.keys(args), durationMs: Date.now() - started, images: res.images.length }, task?.id);
    return { ok: res.ok, output: res.ok ? res.output : `MCP 工具返回错误：${res.output}` };
  } catch (e) {
    rt.audit.record(agentId, 'mcp_call', { server, tool: tool.name, risk, ok: false, error: truncate((e as Error).message, 200), durationMs: Date.now() - started }, task?.id);
    return { ok: false, output: `MCP 调用失败：${(e as Error).message}` };
  }
}
