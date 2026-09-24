// 旨意看板 · Kanban
import { useState } from 'react';
import { useStore, selectTask, openTaskTab } from '../store';
import { KANBAN_COLUMNS, AGENTS, AGENT_MAP, TIER_SHORT } from '../../shared/court';
import type { Task } from '../../shared/types';
import { Icon } from '../common/Icon';
import { StateChip, fmtAgo, fmtTokens, fmtCost, usageTokens } from '../common/format';
import { TaskControls } from './TaskWidgets';

export function heartbeatOf(t: Task): { label: string; color: string } {
  if (['Done', 'Cancelled'].includes(t.state)) return { label: '已结', color: '#6b7280' };
  if (t.gate || t.paused) return { label: t.paused ? '叫停' : '待批', color: '#e8b64c' };
  if (t.state === 'Blocked') return { label: '告警', color: '#ef4444' };
  const idle = Date.now() - t.lastActivityAt;
  if (idle < 60_000) return { label: '活跃', color: '#22c55e' };
  if (idle < 180_000) return { label: '停滞', color: '#eab308' };
  return { label: '告警', color: '#ef4444' };
}

export function Kanban() {
  const tasks = useStore((s) => s.tasks);
  const [q, setQ] = useState('');
  const [dept, setDept] = useState('');
  const [showDone, setShowDone] = useState(true);
  const filtered = tasks.filter((t) => {
    if (q && !(t.title + t.edict + t.id).toLowerCase().includes(q.toLowerCase())) return false;
    if (dept && !(t.plan?.subtasks.some((s) => s.dept === dept) || t.nodes.some((n) => n.agentId === dept))) return false;
    return true;
  });
  const cols = KANBAN_COLUMNS.filter((c) => showDone || c.key !== 'done');
  return (
    <div className="panel kanban-panel">
      <div className="panel-head">
        <h2><Icon name="kanban" size={18} /> 旨意看板</h2>
        <div className="panel-tools">
          <div className="search-input-wrap small">
            <Icon name="search" size={13} />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="全文搜索旨意" />
          </div>
          <select className="input sm" value={dept} onChange={(e) => setDept(e.target.value)}>
            <option value="">全部省部</option>
            {AGENTS.filter((a) => a.id !== 'solo').map((a) => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </select>
          <label className="chk small"><input type="checkbox" checked={showDone} onChange={(e) => setShowDone(e.target.checked)} /> 显示已结</label>
        </div>
      </div>
      <div className="kanban" data-testid="kanban">
        {cols.map((c) => {
          const list = filtered.filter((t) => c.states.includes(t.state)).sort((a, b) => b.updatedAt - a.updatedAt);
          return (
            <div key={c.key} className={`kcol kcol-${c.key}`}>
              <div className="kcol-head">
                {c.label} <span className="count">{list.length}</span>
              </div>
              <div className="kcol-body">
                {list.map((t) => (
                  <TaskCard key={t.id} t={t} />
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function TaskCard({ t }: { t: Task }) {
  const hb = heartbeatOf(t);
  const running = t.nodes.filter((n) => n.status === 'running');
  const doneSubs = t.plan ? t.plan.subtasks.filter((s) => t.nodes.some((n) => n.subtaskId === s.id && n.status === 'done')).length : 0;
  return (
    <div className="kcard" onClick={() => selectTask(t.id)} onDoubleClick={() => openTaskTab(t.id)} data-testid="kcard">
      <div className="kcard-top">
        <span className="hb" style={{ color: hb.color }}><span className="dot" style={{ background: hb.color }} /> {hb.label}</span>
        <code className="muted small">{t.id.slice(-7)}</code>
        <span className="tier-tag">{TIER_SHORT[t.tier]}</span>
      </div>
      <div className="kcard-title">{t.title}</div>
      <div className="kcard-meta">
        <StateChip state={t.state} small />
        {t.gate && <span className="chip chip-sm warn">待御批</span>}
        {t.reviews.some((r) => r.verdict === 'reject') && <span className="chip chip-sm danger">封驳×{t.reviews.filter((r) => r.verdict === 'reject').length}</span>}
      </div>
      {t.plan && (
        <div className="kcard-subs">
          {t.plan.subtasks.map((s) => {
            const n = [...t.nodes].reverse().find((x) => x.subtaskId === s.id);
            return <span key={s.id} className={`sub-dot st-${n?.status ?? 'none'}`} title={`${s.id} ${AGENT_MAP[s.dept].name}：${s.title}（${n?.status ?? '未开始'}）`} style={{ borderColor: AGENT_MAP[s.dept].color }} />;
          })}
          <span className="muted small">{doneSubs}/{t.plan.subtasks.length}</span>
        </div>
      )}
      {running.length > 0 && <div className="kcard-running">{running.map((n) => `${AGENT_MAP[n.agentId]?.emoji ?? ''} ${n.label}`).join(' · ')}</div>}
      <div className="kcard-foot">
        <span className="muted small">{fmtTokens(usageTokens(t.usage))} · {fmtCost(t.usage.costUsd)}</span>
        <span className="muted small">{fmtAgo(t.updatedAt)}</span>
      </div>
      <div className="kcard-actions" onClick={(e) => e.stopPropagation()}>
        <TaskControls task={t} compact />
      </div>
    </div>
  );
}
