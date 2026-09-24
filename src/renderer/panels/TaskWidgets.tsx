// Task widgets shared by the workbench and the court overlays (same actions, same data).
import { useEffect, useState } from 'react';
import type { MinistryId, Plan, Subtask, Task, TaskState } from '../../shared/types';
import { AGENT_MAP, MINISTRIES, STATE_LABEL, TERMINAL } from '../../shared/court';
import { call } from '../api';
import { toast, useStore, openTab } from '../store';
import { Icon } from '../common/Icon';
import { Markdown } from '../common/Markdown';
import { fmtCost, fmtTokens, usageTokens } from '../common/format';

export const PIPE: { key: string; label: string; states: TaskState[] }[] = [
  { key: 'edict', label: '下旨', states: ['Pending'] },
  { key: 'taizi', label: '太子', states: ['Taizi'] },
  { key: 'zhongshu', label: '中书', states: ['Zhongshu'] },
  { key: 'menxia', label: '门下', states: ['Menxia'] },
  { key: 'shangshu', label: '尚书', states: ['Assigned', 'Next'] },
  { key: 'liubu', label: '六部', states: ['Doing'] },
  { key: 'report', label: '回奏', states: ['Review', 'PendingConfirm'] },
  { key: 'done', label: '结案', states: ['Done'] },
];

export function Pipeline({ task }: { task: Task }) {
  const pipe = task.tier === 'solo' ? PIPE.filter((p) => ['edict', 'liubu', 'done'].includes(p.key)).map((p) => (p.key === 'liubu' ? { ...p, label: '独相执行' } : p)) : PIPE;
  const state = task.state === 'Blocked' ? task.resumeState ?? 'Doing' : task.state;
  const idx = pipe.findIndex((p) => p.states.includes(state));
  const rejects = task.reviews.filter((r) => r.verdict === 'reject').length;
  return (
    <div className="pipeline">
      {pipe.map((p, i) => (
        <div key={p.key} className={`pipe-step ${i < idx || task.state === 'Done' ? 'done' : ''} ${i === idx && task.state !== 'Done' ? (task.state === 'Blocked' ? 'blocked' : task.gate ? 'gate' : 'active') : ''} ${task.state === 'Cancelled' ? 'cancelled' : ''}`}>
          <span className="pipe-dot" />
          <span className="pipe-label">
            {p.label}
            {p.key === 'menxia' && rejects > 0 && <sup className="reject-count" title="封驳次数">驳{rejects}</sup>}
          </span>
        </div>
      ))}
    </div>
  );
}

export function TaskControls({ task, compact }: { task: Task; compact?: boolean }) {
  const terminal = TERMINAL.includes(task.state);
  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  return (
    <div className="task-controls">
      {!terminal && !task.paused && (
        <button className="btn sm" onClick={() => act(() => call('pause', task.id))} title="叫停：所有官员在下一步前停下">
          <Icon name="pause" size={12} /> {compact ? '' : '叫停'}
        </button>
      )}
      {!terminal && task.paused && (
        <button className="btn sm primary" onClick={() => act(() => call('resume', task.id))}>
          <Icon name="play" size={12} /> {compact ? '' : '恢复'}
        </button>
      )}
      {task.state === 'Blocked' && (
        <button className="btn sm" onClick={() => act(() => call('unblock', task.id))} title="重试全部失败节点并恢复">
          <Icon name="retry" size={12} /> 恢复执行
        </button>
      )}
      {!terminal && (
        <button className="btn sm danger" onClick={() => act(async () => {
          if (await call<boolean>('confirm', `确定取消旨意「${task.title}」？`, task.state === 'Doing' || task.state === 'Menxia' ? '此为高风险流转（执行中/审议中取消），需皇上亲自确认。已产生的文件改动不会自动撤回。' : undefined)) await call('cancel', task.id, '皇上取消');
        })}>
          <Icon name="stop" size={12} /> {compact ? '' : '取消'}
        </button>
      )}
    </div>
  );
}

export function UsageLine({ task }: { task: Task }) {
  const used = usageTokens(task.usage);
  const pct = task.budget.maxTokens ? Math.min(100, (used / task.budget.maxTokens) * 100) : 0;
  return (
    <div className="usage-line" title={`输入 ${task.usage.inputTokens} · 输出 ${task.usage.outputTokens} · 缓存命中 ${task.usage.cachedTokens} · 调用 ${task.usage.calls} 次${task.usage.estimated ? '（部分为估算）' : ''}`}>
      <Icon name="zap" size={12} /> {fmtTokens(used)} / {fmtTokens(task.budget.maxTokens)} tokens · {fmtCost(task.usage.costUsd)}
      {task.estimate && <span className="muted"> · 预估 {fmtTokens(task.estimate.tokens)} / {fmtCost(task.estimate.costUsd)}</span>}
      <div className="budget-bar"><div style={{ width: `${pct}%`, background: pct > 90 ? '#d0453a' : pct > 70 ? '#d8a84e' : '#4fa38a' }} /></div>
    </div>
  );
}

// ───────── Plan editor (L2: 皇上朱笔涂改中书省方案) ─────────
export function PlanEditor({ plan, onChange, readOnly }: { plan: Plan; onChange?: (p: Plan) => void; readOnly?: boolean }) {
  const set = (patch: Partial<Plan>) => onChange?.({ ...plan, ...patch });
  const setSub = (i: number, patch: Partial<Subtask>) => set({ subtasks: plan.subtasks.map((s, k) => (k === i ? { ...s, ...patch } : s)) });
  const nextId = () => {
    let n = plan.subtasks.length + 1;
    while (plan.subtasks.some((s) => s.id === `S${n}`)) n++;
    return `S${n}`;
  };
  return (
    <div className={`plan-editor ${readOnly ? 'ro' : ''}`}>
      <label className="pe-label">方案概述</label>
      <textarea className="input" rows={2} value={plan.summary} readOnly={readOnly} onChange={(e) => set({ summary: e.target.value })} />
      <label className="pe-label">子任务（{plan.subtasks.length}）</label>
      {plan.subtasks.map((s, i) => (
        <div key={i} className="pe-sub" style={{ borderLeftColor: AGENT_MAP[s.dept]?.color }}>
          <div className="pe-row">
            <span className="pe-id">{s.id}</span>
            <input className="input" value={s.title} readOnly={readOnly} onChange={(e) => setSub(i, { title: e.target.value })} placeholder="标题" />
            <select className="input" value={s.dept} disabled={readOnly} onChange={(e) => setSub(i, { dept: e.target.value as MinistryId })}>
              {MINISTRIES.map((m) => (
                <option key={m} value={m}>{AGENT_MAP[m].name}</option>
              ))}
            </select>
            {!readOnly && (
              <button className="icon-btn" title="删去此子任务" onClick={() => set({ subtasks: plan.subtasks.filter((_, k) => k !== i).map((x) => ({ ...x, dependsOn: x.dependsOn.filter((d) => d !== s.id) })) })}>
                <Icon name="trash" size={13} />
              </button>
            )}
          </div>
          <textarea className="input" rows={2} value={s.detail} readOnly={readOnly} onChange={(e) => setSub(i, { detail: e.target.value })} placeholder="做法" />
          <div className="pe-row">
            <span className="muted small">验收</span>
            <input className="input" value={s.acceptance} readOnly={readOnly} onChange={(e) => setSub(i, { acceptance: e.target.value })} />
            <span className="muted small">依赖</span>
            <input className="input pe-deps" value={s.dependsOn.join(',')} readOnly={readOnly} onChange={(e) => setSub(i, { dependsOn: e.target.value.split(/[,，\s]+/).filter(Boolean) })} placeholder="S1,S2" />
          </div>
        </div>
      ))}
      {!readOnly && (
        <button className="btn sm" onClick={() => set({ subtasks: [...plan.subtasks, { id: nextId(), title: '', dept: 'bingbu', detail: '', acceptance: '', dependsOn: [] }] })}>
          <Icon name="plus" size={12} /> 增补子任务
        </button>
      )}
      <label className="pe-label">风险</label>
      <textarea className="input" rows={2} value={plan.risks.join('\n')} readOnly={readOnly} onChange={(e) => set({ risks: e.target.value.split('\n').filter(Boolean) })} />
    </div>
  );
}

// ───────── Gate card: 准奏 / 封驳 / 涂改 ─────────
export function GateCard({ task, variant = 'pane', onDecided }: { task: Task; variant?: 'pane' | 'court'; onDecided?: (approve: boolean) => void }) {
  const g = task.gate!;
  const [plan, setPlan] = useState<Plan | null>(task.plan ? JSON.parse(JSON.stringify(task.plan)) : null);
  const [comment, setComment] = useState('');
  const [targets, setTargets] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => setPlan(task.plan ? JSON.parse(JSON.stringify(task.plan)) : null), [task.plan, g.since]);
  const planGate = task.state === 'Menxia' && (g.kind === 'plan' || g.kind === 'reject_limit');
  const edited = planGate && plan && JSON.stringify(plan) !== JSON.stringify(task.plan);
  const decide = async (approve: boolean) => {
    if (!approve && !comment.trim() && g.kind !== 'budget') return toast('封驳须附朱批理由', 'warn');
    setBusy(true);
    try {
      await call('decideGate', task.id, { approve, comment, plan: planGate && edited ? plan : undefined, reworkTargets: targets });
      toast(approve ? (edited ? '已朱笔涂改并准奏' : '准奏') : '已封驳', approve ? 'success' : 'warn');
      onDecided?.(approve);
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  const lastMenxia = [...task.reviews].reverse().find((r) => r.reviewer === 'menxia');
  return (
    <div className={`gate-card gate-${g.kind} ${variant}`} data-testid="gate-card">
      <div className="gate-head">
        <Icon name="scroll" size={15} /> <b>{g.kind === 'plan' ? '御览方案' : g.kind === 'final' ? '回奏待御批' : g.kind === 'budget' ? '预算超限' : g.kind === 'reject_limit' ? '封驳超限 · 请裁决' : '待批'}</b>
        <span className="muted small">{g.message}</span>
      </div>
      {lastMenxia && planGate && (
        <div className={`review-note ${lastMenxia.verdict}`}>
          门下省{lastMenxia.verdict === 'approve' ? '准奏' : '封驳'}（第 {lastMenxia.round} 轮）：{lastMenxia.comment}
          {lastMenxia.issues.length > 0 && <ul>{lastMenxia.issues.map((x, i) => <li key={i}>{x}</li>)}</ul>}
        </div>
      )}
      {planGate && plan && <PlanEditor plan={plan} onChange={setPlan} />}
      {g.kind === 'final' && (
        <div className="gate-report">
          <Markdown text={task.result?.summary || '（无回奏正文）'} />
          <ChangesList task={task} />
          {task.plan && task.tier !== 'solo' && (
            <div className="rework-pick">
              <span className="muted small">若封驳，发回返工的子任务：</span>
              {task.plan.subtasks.map((s) => (
                <label key={s.id} className="chk">
                  <input type="checkbox" checked={targets.includes(s.id)} onChange={(e) => setTargets(e.target.checked ? [...targets, s.id] : targets.filter((x) => x !== s.id))} /> {s.id} {AGENT_MAP[s.dept].name}
                </label>
              ))}
              <span className="muted small">（不选则全部返工）</span>
            </div>
          )}
        </div>
      )}
      {g.kind !== 'budget' && <textarea className="input" rows={2} placeholder="朱批（封驳时必填；准奏时可选）" value={comment} onChange={(e) => setComment(e.target.value)} />}
      <div className="gate-actions">
        <button className="btn primary zhunzou" disabled={busy} onClick={() => decide(true)} data-testid="gate-approve">
          <Icon name="check" size={13} /> {g.kind === 'budget' ? '追加预算，继续' : edited ? '朱笔涂改 · 放行' : '准奏'}
        </button>
        <button className="btn danger fengbo" disabled={busy} onClick={() => decide(false)} data-testid="gate-reject">
          <Icon name="x" size={13} /> {g.kind === 'budget' ? '取消旨意' : '封驳'}
        </button>
      </div>
    </div>
  );
}

export function ChangesList({ task, onOpen }: { task: Task; onOpen?: (path: string) => void }) {
  const latest = new Map<string, (typeof task.changes)[number][]>();
  for (const c of task.changes) latest.set(c.path, [...(latest.get(c.path) ?? []), c]);
  if (!latest.size) return <div className="muted small">（本旨意无文件改动）</div>;
  const openDiff = async (path: string) => {
    const list = latest.get(path)!;
    const first = list.find((c) => !c.reverted) ?? list[0];
    const last = [...list].reverse().find((c) => !c.reverted) ?? list[list.length - 1];
    const [before, after] = await Promise.all([first.beforeHash ? call<string>('blob', first.beforeHash) : '', last.afterHash ? call<string>('blob', last.afterHash) : '']);
    if (onOpen) onOpen(path);
    openTab({ id: `diff:task:${task.id}:${path}`, kind: 'diff', title: `${path.split('/').pop()} · ${task.id}`, diff: { original: before ?? '', modified: after ?? '', path, label: `旨意 ${task.id} 的改动` } });
  };
  return (
    <div className="changes-list">
      <div className="muted small">文件改动（系统记录）· {latest.size} 个文件</div>
      {[...latest.entries()].map(([p, list]) => {
        const last = list[list.length - 1];
        const reverted = list.every((c) => c.reverted);
        return (
          <div key={p} className={`change-row ${reverted ? 'reverted' : ''}`}>
            <span className={`git-badge git-${last.op === 'create' ? 'added' : last.op === 'delete' ? 'deleted' : 'modified'}`}>{last.op === 'create' ? 'A' : last.op === 'delete' ? 'D' : 'M'}</span>
            <span className="tree-name clickable" onClick={() => openDiff(p)}>{p}</span>
            <span className="muted small">{AGENT_MAP[last.agentId]?.name} · {list.length} 次</span>
            <code className="muted small">{last.afterHash?.slice(0, 8) ?? '—'}</code>
            {!reverted && (
              <button className="icon-btn" title="撤回此文件的最近一次改动" onClick={async () => {
                const c = [...list].reverse().find((x) => !x.reverted)!;
                try {
                  await call('revertChange', task.id, c.id);
                  toast(`已撤回 ${p}`, 'success');
                } catch (e) {
                  if (await call<boolean>('confirm', (e as Error).message, '仍要强制撤回吗？')) await call('revertChange', task.id, c.id, true);
                }
              }}>
                <Icon name="retry" size={12} />
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function StateLabel({ task }: { task: Task }) {
  return <>{STATE_LABEL[task.state]}{task.paused ? ' · 已叫停' : ''}{task.gate ? ' · 待御批' : ''}</>;
}

export function useSelectedTask() {
  const id = useStore((s) => s.ui.selectedTaskId);
  return useStore((s) => (id ? s.tasks.find((t) => t.id === id) : undefined));
}
