// Execution policy shared by the native 三省六部 engine and 协同设计 fan-outs:
// effect-aware scheduling (read subtasks in parallel, write / verify alone), the
// write-task approval card, and the evidence check on each ministry's conclusion.
import type { ApprovalChoice, PermissionMode, RunNode, Subtask, SubtaskEffect, Task } from '../../shared/types';
import { TaskAbortedError, type Runtime } from './runtime';
import { PERMISSION_LABEL } from './permissions';
import { READ_TOOLS, type ToolName } from './tools';
import type { Workspace } from '../services/workspace';
import { extractJson, now, sha256, truncate } from './util';
import { laneOf } from './attempts';

export const effectOf = (sub?: { effect?: unknown }): SubtaskEffect => (sub?.effect === 'write' || sub?.effect === 'verify' ? sub.effect : 'read');

export const EFFECT_LABEL: Record<SubtaskEffect, string> = { read: '只读', write: '写入', verify: '验证' };

/**
 * Run exec nodes in plan order once their dependencies are done. Read nodes run side by side
 * (up to `limit`); a write or verify node waits for the running ones to finish and then runs alone.
 */
export async function scheduleExec(nodes: RunNode[], o: { ready: (n: RunNode) => boolean; limit: number; run: (n: RunNode) => Promise<void> }): Promise<void> {
  const running = new Map<string, { p: Promise<void>; alone: boolean }>();
  while (true) {
    if (![...running.values()].some((r) => r.alone)) {
      for (const n of nodes) {
        if (n.status !== 'pending' || running.has(n.id) || !o.ready(n)) continue;
        const alone = (n.effect ?? 'read') !== 'read';
        if (alone ? running.size > 0 : running.size >= o.limit) break;
        const p = o.run(n).finally(() => running.delete(n.id));
        running.set(n.id, { p, alone });
        if (alone) break;
      }
    }
    if (!running.size) break;
    await Promise.race([...running.values()].map((r) => r.p));
  }
}

export class WriteTaskRejected extends Error {}

function writeTaskChoices(mode: PermissionMode): ApprovalChoice[] {
  return [
    { id: 'write', label: '准许开工', hint: `按当前权限「${PERMISSION_LABEL[mode === 'readonly' ? 'ask' : mode]}」`, approve: true, tone: 'primary', comment: 'optional' },
    { id: 'write_free', label: '准许，本子任务内写入与命令免询问', hint: '高风险操作仍会询问', approve: true, comment: 'optional' },
    { id: 'readonly', label: '改为只读执行', hint: '只分析、给修改建议，不改文件', approve: true, comment: 'optional' },
    { id: 'deny', label: '驳回', hint: '写明理由；旨意会停下等你处理', approve: false, tone: 'danger', comment: 'optional' },
  ];
}

/**
 * Before a write subtask starts, ask the emperor once (unless the mode is 全自动, the setting is off,
 * the node already has a grant, or there is no workspace to write to). Rejection fails the node.
 */
export async function confirmWriteTask(rt: Runtime, t: Task, node: RunNode, sub: Subtask, who: string, hasWorkspace: boolean): Promise<void> {
  const mode = rt.modeFor(t);
  if (node.effect !== 'write' || node.grant || !hasWorkspace) return;
  // a read-only scheduled edict: write subtasks run read-only, nobody is asked (the cap was set when it was scheduled)
  if (t.schedule?.permission === 'readonly') {
    node.grant = 'readonly';
    node.grantNote = '定时旨意按「只读」排定';
    rt.audit.record('system', 'node_grant', { node: node.id, grant: 'readonly', via: 'schedule' }, t.id);
    rt.activity('log', `定时旨意按「只读」排定：${node.label} 改为只读执行，把修改建议写进结论`, { taskId: t.id, nodeId: node.id });
    rt.touch(t);
    return;
  }
  if (mode === 'auto' || rt.settings.confirmWriteTasks === false) return;
  node.status = 'waiting';
  rt.touch(t);
  const d = await rt.requestDecision({
    kind: 'write_task', taskId: t.id, agentId: node.agentId, nodeId: node.id, tool: 'write_task',
    summary: `${who}要开工写任务：${sub.title}`,
    detail: `做法：${sub.detail || '（未写明）'}\n验收标准：${sub.acceptance || '（未写明）'}`,
    risk: 'normal', reason: '这个子任务会修改工作区文件。每个写任务开工前问一次（可在「权限」里关闭）。',
    choices: writeTaskChoices(mode),
  });
  if (t.state === 'Cancelled' || rt.controllers.get(t.id)?.signal.aborted) throw new TaskAbortedError();
  if (!d.approve) {
    node.status = 'failed';
    node.exitStatus = 'rejected';
    node.error = `皇上驳回了这个写任务${d.comment ? `：${d.comment}` : ''}`;
    node.endedAt = now();
    rt.activity('human', `皇上驳回写任务：${node.label}${d.comment ? `（${d.comment}）` : ''}`, { taskId: t.id, nodeId: node.id });
    rt.audit.record('emperor', 'write_task_rejected', { node: node.id, comment: d.comment ?? null }, t.id);
    rt.touch(t);
    throw new WriteTaskRejected(node.error);
  }
  node.status = 'pending';
  node.grant = d.choice === 'write_free' ? 'write_free' : d.choice === 'readonly' ? 'readonly' : 'write';
  node.grantNote = d.comment;
  rt.audit.record('emperor', 'node_grant', { node: node.id, grant: node.grant, via: 'write_task', comment: d.comment ?? null }, t.id);
  rt.activity('human', `${node.grant === 'readonly' ? '皇上命只读执行' : '皇上准许开工'}：${node.label}${d.comment ? `（${d.comment}）` : ''}`, { taskId: t.id, nodeId: node.id });
  rt.touch(t);
}

/** Prompt lines telling the agent what it was granted. */
export function grantPrompt(node: RunNode): string {
  const note = node.grantNote ? `\n皇上批示：${node.grantNote}` : '';
  if (node.grant === 'readonly') return `【皇上旨意】本子任务改为只读执行：只阅读与分析，不要写文件或执行会改动东西的命令；把具体修改建议写进结论。${note}`;
  if (node.grant === 'write_free') return `【权限】皇上已准许本子任务内写入与命令免询问（高风险操作仍须确认）。${note}`;
  if (node.grant === 'write') return node.grantNote ? `【皇上批示】${node.grantNote}` : '';
  return (node.effect ?? 'read') === 'read' ? '【权限】本子任务按只读开工。确需改文件或执行命令时，系统会先请示皇上。' : '';
}

/** Tools for an exec node: a read-only grant only gets the read tools. */
export function toolsForNode(node: RunNode, tools: ToolName[] | undefined): ToolName[] | undefined {
  if (!tools) return undefined;
  return node.grant === 'readonly' ? tools.filter((x) => READ_TOOLS.includes(x) || x === 'ask_emperor') : tools;
}

// ───────────────────────── conclusions & evidence ─────────────────────────
export interface ExecConclusion {
  status: 'done' | 'partial' | 'failed';
  summary: string;
  artifacts: string[];
  verification: string;
  issues: string[];
}

/** Parse a ministry's structured conclusion. Unknown or missing status, or no JSON at all, counts as partial. */
export function parseConclusion(text: string): ExecConclusion & { structured: boolean } {
  const j = extractJson<Partial<ExecConclusion>>(text);
  if (j && typeof j === 'object' && 'summary' in j) {
    const st = String(j.status ?? '');
    const issues = Array.isArray(j.issues) ? j.issues.map(String) : [];
    const ok = ['done', 'partial', 'failed'].includes(st);
    if (!ok) issues.push(st ? `结论 status 无效：${st}` : '结论缺少 status');
    return { status: (ok ? st : 'partial') as ExecConclusion['status'], summary: String(j.summary ?? ''), artifacts: Array.isArray(j.artifacts) ? j.artifacts.map(String) : [], verification: String(j.verification ?? '未说明'), issues, structured: true };
  }
  return { status: 'partial', summary: truncate(text.trim(), 600), artifacts: [], verification: '未提供结构化结论', issues: ['未按格式输出结构化结论'], structured: false };
}

/**
 * Never trust self-reports: hash the claimed artifacts, list the changes the system recorded, and
 * downgrade "done" to "partial" when the evidence is missing (no such file, a write task that changed
 * nothing, a verify task that ran nothing).
 */
export function checkEvidence(t: Task, node: RunNode, c: ExecConclusion, toolCounts: Record<string, number>, ws?: Workspace): { conclusion: ExecConclusion; systemCheck: string[] } {
  const checks: string[] = [];
  if (!ws) return { conclusion: c, systemCheck: checks };
  const issues = [...c.issues];
  let status = c.status;
  const missing: string[] = [];
  let present = 0;
  for (const a of c.artifacts) {
    try {
      const buf = ws.readBuffer(a);
      if (buf) present++;
      else missing.push(a);
      checks.push(buf ? `${a} ✓ sha256:${sha256(buf).slice(0, 12)}` : `${a} ✗ 不存在`);
    } catch (e) {
      missing.push(a);
      checks.push(`${a} ✗ ${(e as Error).message}`);
    }
  }
  // file-tool writes and run_command side effects (R7) both count as evidence of work
  const touched = (laneOf(t, node)?.changes ?? t.changes).filter((ch) => ch.nodeId === node.id && !ch.reverted).map((ch) => `${ch.op}:${ch.path}${ch.via === 'command' ? '（命令）' : ''}`);
  checks.push(`系统记录的改动：${touched.length ? touched.join(', ') : '无'}`);
  const cmds = toolCounts.run_command ?? 0;
  const previews = toolCounts.preview_page ?? 0;
  const previewFails = toolCounts['preview_page:failed'] ?? 0;
  checks.push(`本节点执行命令 ${cmds} 次${previews ? `、预览页面 ${previews} 次${previewFails ? `（其中 ${previewFails} 次未通过）` : ''}` : ''}`);
  if (status === 'done') {
    const effect = node.effect ?? 'read';
    if (missing.length) issues.push(`声称的产物不存在：${missing.join('、')}`);
    if (effect === 'write' && node.grant !== 'readonly' && !touched.length && !present) issues.push('标为写任务，但系统没有记录到任何文件改动');
    if (effect === 'verify' && !cmds && !previews) issues.push('标为验证任务，但本轮没有执行任何命令或预览');
    if (issues.length > c.issues.length) status = 'partial';
  }
  return { conclusion: { ...c, status, issues }, systemCheck: checks };
}

/** Status recorded in a done exec node's output (JSON written by runExec / execSubtask). */
export function nodeConclusion(n: RunNode | undefined): (ExecConclusion & { systemCheck?: string[] }) | null {
  if (!n?.output) return null;
  try {
    const j = JSON.parse(n.output);
    return j && typeof j === 'object' && 'status' in j ? j : null;
  } catch {
    return null;
  }
}

/** Block reason for exec nodes that failed, were rejected or never started. */
export function execBlockReason(bad: RunNode[], stuck: RunNode[]): string {
  const rej = bad.filter((n) => n.exitStatus === 'rejected');
  const fail = bad.filter((n) => n.exitStatus !== 'rejected');
  return [
    rej.length ? `${rej.map((n) => n.label).join('、')} 被皇上驳回` : '',
    fail.length ? `${fail.map((n) => n.label).join('、')} 执行失败` : '',
    stuck.length ? `${stuck.length} 个子任务因依赖未完成而未启动` : '',
  ].filter(Boolean).join('；') + '。可对节点「局部重试」';
}
