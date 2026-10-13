// 方案 card at the top of the agent stream: each subtask with its effect (只读 / 写入 / 验证) and live status.
import { useState } from 'react';
import { useStore } from '../store';
import { Icon } from '../common/Icon';
import { AGENT_MAP, TERMINAL } from '../../shared/court';
import type { RunNode, SubtaskEffect, Task } from '../../shared/types';
import { verdictOf } from './ActivityStream';

const EFFECT: Record<SubtaskEffect, { label: string; cls: string; tip: string }> = {
  read: { label: '只读', cls: '', tip: '只读文件与分析，和其他只读子任务并行' },
  write: { label: '写入', cls: 'w', tip: '会改文件或执行命令：开工前请你定夺，同一时间只有一个写任务在跑' },
  verify: { label: '验证', cls: 'v', tip: '跑测试 / 构建 / 预览来核验成果' },
};

const latestExec = (t: Task, subId: string): RunNode | undefined => [...t.nodes].reverse().find((n) => n.kind === 'exec' && n.subtaskId === subId);

function statusOf(n: RunNode | undefined, waitingApproval: boolean): { text: string; cls: string } {
  if (waitingApproval) return { text: '待你定夺', cls: 'gold' };
  if (!n) return { text: '待派发', cls: 'muted' };
  const suffix = n.grant === 'readonly' ? ' · 只读执行' : n.grant === 'write_free' ? ' · 免询问' : '';
  switch (n.status) {
    case 'running':
      return { text: `执行中${n.attempts > 1 ? ` · 第 ${n.attempts} 次` : ''}${suffix}`, cls: 'live' };
    case 'done': {
      const v = verdictOf(n);
      return v && v.status !== 'done' ? { text: `成果存疑${suffix}`, cls: 'warn' } : { text: `✓ 完成${suffix}`, cls: 'ok' };
    }
    case 'failed':
      return n.exitStatus === 'rejected' ? { text: '已驳回', cls: 'bad' } : { text: '失败', cls: 'bad' };
    case 'cancelled':
      return { text: '中断', cls: 'bad' };
    case 'skipped':
      return { text: '跳过', cls: 'muted' };
    default:
      return { text: '等待', cls: 'muted' };
  }
}

export function PlanCard({ task }: { task: Task }) {
  const pendingNodes = useStore((s) => s.approvals.filter((a) => a.taskId === task.id && a.status === 'pending' && a.nodeId).map((a) => a.nodeId!));
  const [open, setOpen] = useState<boolean | null>(null);
  const plan = task.plan;
  if (!plan?.subtasks.length || task.tier === 'solo') return null;
  const rows = plan.subtasks.map((s) => {
    const n = latestExec(task, s.id);
    return { s, n, st: statusOf(n, !!n && pendingNodes.includes(n.id)) };
  });
  const done = rows.filter((r) => r.n?.status === 'done').length;
  const shown = open ?? !TERMINAL.includes(task.state);
  return (
    <div className={`plan-card ${shown ? '' : 'closed'}`} data-testid="plan-card">
      <div className="h clickable" onClick={() => setOpen(!shown)}>
        <Icon name={shown ? 'chevronDown' : 'chevronRight'} size={11} />
        <Icon name="scroll" size={12} /> 方案 · {plan.subtasks.length} 个子任务
        <span className="muted">{done}/{plan.subtasks.length} 完成{task.planHistory.length > 1 ? ` · 第 ${task.planHistory.length} 版` : ''}</span>
      </div>
      {shown && (
        <>
          {plan.summary && <div className="pc-sum muted">{plan.summary}</div>}
          {rows.map(({ s, st }) => {
            const eff = EFFECT[s.effect ?? 'read'];
            return (
              <div key={s.id} className="sub-row" data-testid={`plan-sub-${s.id}`}>
                <code className="sid">{s.id}</code>
                <span className="ellipsis st-title" title={`${s.title}\n${s.detail}`}>{s.title}</span>
                <span className={`eff ${eff.cls}`} title={eff.tip}>{eff.label}</span>
                <span className="muted dept">{AGENT_MAP[s.dept]?.name}</span>
                <span className={`st ${st.cls}`}>{st.text}</span>
              </div>
            );
          })}
        </>
      )}
    </div>
  );
}
