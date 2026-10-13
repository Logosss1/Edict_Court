// 「需要你处理」: everything waiting on the emperor, in one list (inbox side view, Kanban lane, badges).
import type { ApprovalRequest, Task } from '../../shared/types';
import { TERMINAL, agentName } from '../../shared/court';
import { useStore } from '../store';

export type AttentionKind = 'write_task' | 'question' | 'approval' | 'risk' | 'plan' | 'final' | 'decide' | 'blocked' | 'merge' | 'schedule' | 'attempt';

export interface AttentionItem {
  key: string;
  kind: AttentionKind;
  taskId?: string;
  /** short kind label, e.g. 写任务开工 */
  label: string;
  /** colour family: gold (approve), blue (review), danger, jade (merge) */
  tone: 'gold' | 'blue' | 'danger' | 'jade';
  title: string;
  sub: string;
  who?: string;
  at: number;
  approval?: ApprovalRequest;
  task?: Task;
}

const GATE_LABEL: Record<string, string> = { plan: '方案御览', final: '回奏待御批', budget: '预算待裁决', reject_limit: '封驳超限', risk: '风险待裁决' };

export function attentionItems(tasks: Task[], approvals: ApprovalRequest[]): AttentionItem[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const out: AttentionItem[] = [];
  for (const a of approvals) {
    if (a.status !== 'pending') continue;
    const t = a.taskId ? byId.get(a.taskId) : undefined;
    const who = agentName(a.agentId);
    const base = { key: `ap:${a.id}`, taskId: a.taskId, at: a.at, approval: a, task: t, who };
    if (a.kind === 'write_task') out.push({ ...base, kind: 'write_task', label: '写任务开工', tone: 'gold', title: t?.title ?? a.summary, sub: a.summary });
    else if (a.kind === 'question') out.push({ ...base, kind: 'question', label: '请旨', tone: 'blue', title: a.summary.replace(/^.*?请旨：/, ''), sub: t ? t.title : who });
    else if (a.kind === 'schedule') out.push({ ...base, kind: 'schedule', label: '定时提议', tone: 'blue', title: a.summary.replace(/^.*?提议定时旨意：/, ''), sub: `${who}：${a.reason}` });
    else if (a.kind === 'attempt') out.push({ ...base, kind: 'attempt', label: '比试待选', tone: 'blue', title: t?.title ?? a.summary, sub: a.summary });
    else if ((a.kind as string) === 'worktree') out.push({ ...base, kind: 'merge', label: '结案合并', tone: 'jade', title: t?.title ?? a.summary, sub: a.summary });
    else if (a.risk === 'high') out.push({ ...base, kind: 'risk', label: '高风险操作', tone: 'danger', title: a.summary, sub: t ? `${t.title} · ${a.reason}` : a.reason });
    else out.push({ ...base, kind: 'approval', label: a.kind === 'escalate' ? '请求加权限' : a.kind === 'loop' ? '重复操作' : a.kind === 'guest' ? '客卿改动' : '操作待批', tone: 'gold', title: a.summary, sub: t ? `${t.title} · ${a.reason}` : a.reason });
  }
  for (const t of tasks) {
    if (TERMINAL.includes(t.state)) continue;
    if (t.gate) {
      const k = t.gate.kind === 'plan' ? 'plan' : t.gate.kind === 'final' ? 'final' : 'decide';
      out.push({ key: `gate:${t.id}`, kind: k, taskId: t.id, task: t, label: GATE_LABEL[t.gate.kind] ?? '待御批', tone: k === 'decide' ? 'gold' : 'blue', title: t.title, sub: t.gate.message, at: t.gate.since });
    } else if (t.state === 'Blocked') {
      out.push({ key: `blocked:${t.id}`, kind: 'blocked', taskId: t.id, task: t, label: '阻塞', tone: 'danger', title: t.title, sub: t.blockedReason ?? '旨意阻塞，等待处理', at: t.updatedAt });
    }
  }
  return out.sort((a, b) => b.at - a.at);
}

// recomputed only when the task or approval list changes (the store keeps both references otherwise)
let memo: { tasks?: Task[]; approvals?: ApprovalRequest[]; items: AttentionItem[] } = { items: [] };
function cached(tasks: Task[], approvals: ApprovalRequest[]) {
  if (memo.tasks !== tasks || memo.approvals !== approvals) memo = { tasks, approvals, items: attentionItems(tasks, approvals) };
  return memo.items;
}

/** Pending items for the emperor, newest first. */
export function useAttention(): AttentionItem[] {
  return useStore((s) => cached(s.tasks, s.approvals));
}

export function useAttentionCount(): number {
  return useStore((s) => cached(s.tasks, s.approvals).length);
}
