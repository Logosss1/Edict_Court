// 方案 card at the top of the agent stream: each subtask with its effect (只读 / 写入 / 验证) and live status.
import { useState } from 'react';
import { useStore } from '../store';
import { Icon } from '../common/Icon';
import { AGENT_MAP, TERMINAL } from '../../shared/court';
import type { RunNode, SubtaskAttempts, SubtaskEffect, Task } from '../../shared/types';
import { verdictOf } from './ActivityStream';
import { VERDICT_LABEL, VERDICT_MARK, checkTally, coverage, reqLabel } from '../../shared/requirements';
import { openAttempts } from '../panels/Lanes';

const EFFECT: Record<SubtaskEffect, { label: string; cls: string; tip: string }> = {
  read: { label: '只读', cls: '', tip: '只读文件与分析，和其他只读子任务并行' },
  write: { label: '写入', cls: 'w', tip: '会改文件或执行命令：开工前请你定夺，同一时间只有一个写任务在跑' },
  verify: { label: '验证', cls: 'v', tip: '跑测试 / 构建 / 预览来核验成果' },
};

const latestExec = (t: Task, subId: string): RunNode | undefined => [...t.nodes].reverse().find((n) => n.kind === 'exec' && n.subtaskId === subId);

const LANE_STATE: Record<SubtaskAttempts['status'], string> = { running: '同时办差中', judging: '门下评比中', choosing: '待你选一路', applied: '已合入', failed: '没有采用' };

/** 排班 on this subtask: the plan's lanes before it runs, then the latest 比试 record. */
function lanesText(t: Task, subId: string, planned?: number): { text: string; tip: string } | null {
  const rec = [...(t.attempts ?? [])].reverse().find((a) => a.subtaskId === subId);
  if (rec) {
    const picked = rec.lanes.find((l) => l.id === rec.pick);
    return { text: `排班 ${rec.lanes.length} 路 · ${rec.status === 'applied' && picked ? `采用${picked.label}路` : LANE_STATE[rec.status]}`, tip: '点开「比试」并排看各路的改动和门下省的评分' };
  }
  return planned ? { text: `排班 ${planned} 路`, tip: '开工时各路在自己的工作树里同时办，门下省评分后你选一路' } : null;
}

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
          {plan.requirements && <RequirementRows task={task} />}
          {rows.map(({ s, n, st }) => {
            const eff = EFFECT[s.effect ?? 'read'];
            const lanes = lanesText(task, s.id, s.lanes?.length);
            return (
              <div key={s.id} className="sub-row" data-testid={`plan-sub-${s.id}`}>
                <code className="sid">{s.id}</code>
                <span className="ellipsis st-title" title={`${s.title}\n${s.detail}${s.covers?.length ? `\n负责：${s.covers.map(reqLabel).join('、')}` : ''}`}>{s.title}</span>
                <span className={`eff ${eff.cls}`} title={eff.tip}>{eff.label}</span>
                <span className="muted dept" title={n?.guest ? `${AGENT_MAP[s.dept]?.name}请客卿 ${n.guest.name} 代办` : undefined}>{AGENT_MAP[s.dept]?.name}{n?.guest ? <span className="pc-guest" data-testid={`plan-guest-${s.id}`}> · {n.guest.name}</span> : null}</span>
                {lanes && <span className="pc-lanes clickable" title={lanes.tip} onClick={() => openAttempts(task.id)} data-testid={`plan-lanes-${s.id}`}>{lanes.text}</span>}
                <span className={`st ${st.cls}`}>{st.text}</span>
              </div>
            );
          })}
        </>
      )}
    </div>
  );
}

/** 需求说明 rows: each criterion, who delivers it, and the latest 对照检查 verdict with its evidence. */
function RequirementRows({ task }: { task: Task }) {
  const [open, setOpen] = useState(false);
  const plan = task.plan!;
  const chk = task.requirementChecks?.at(-1);
  const k = chk ? checkTally(chk) : null;
  const cov = coverage(plan);
  return (
    <div className="pc-req" data-testid="plan-req">
      <div className="pc-req-h clickable" onClick={() => setOpen(!open)}>
        <Icon name={open ? 'chevronDown' : 'chevronRight'} size={10} />
        需求说明 · {cov.length} 条
        <span className={`muted ${k?.unmet ? 'bad' : ''}`}>
          {k ? `对照检查${chk!.round > 1 ? `第 ${chk!.round} 轮` : ''}：满足 ${k.met}/${k.total}${k.unmet ? `，未满足 ${k.unmet}` : ''}${k.unknown ? `，无法判断 ${k.unknown}` : ''}` : '待对照检查'}
        </span>
      </div>
      {open && (
        <>
          {plan.requirements!.goal && <div className="pc-sum muted">目标：{plan.requirements!.goal}</div>}
          {cov.map((c) => {
            const v = chk?.items.find((i) => i.id === c.id);
            return (
              <div key={c.id} className="sub-row" data-testid={`plan-req-${c.id}`}>
                <code className="sid">{reqLabel(c.id)}</code>
                <span className="ellipsis st-title" title={[c.text, v?.evidence && `证据：${v.evidence}`, v?.note].filter(Boolean).join('\n')}>{c.text}</span>
                <span className="muted dept">{c.by.join('、') || '无人负责'}</span>
                <span className={`st ${v ? (v.verdict === 'met' ? 'ok' : v.verdict === 'unmet' ? 'bad' : 'muted') : 'muted'}`}>{v ? `${VERDICT_MARK[v.verdict]} ${VERDICT_LABEL[v.verdict]}` : '—'}</span>
              </div>
            );
          })}
        </>
      )}
    </div>
  );
}
