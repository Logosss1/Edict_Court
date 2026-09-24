// Click any official → see what they are doing right now and interact (朱批 / 叫停 / 召见).
import { useState } from 'react';
import { useStore, setUI, toast, openTaskTab, selectTask } from '../store';
import { call } from '../api';
import { AGENT_MAP, MINISTRIES, STATE_LABEL } from '../../shared/court';
import type { AgentId } from '../../shared/types';
import { ActivityStream } from '../workbench/ActivityStream';
import { TaskControls } from '../panels/TaskWidgets';
import { fmtAgo, fmtCost, fmtTokens, usageTokens } from '../common/format';
import { statusLabel } from '../panels/Monitor';

export function Portrait({ id, scale = 3, frame = 0 }: { id: string; scale?: number; frame?: number }) {
  return (
    <div
      className="portrait"
      style={{
        width: 32 * scale,
        height: 48 * scale,
        backgroundImage: `url(../assets/pixel/chars/${id}.png)`,
        backgroundSize: `${352 * scale}px ${96 * scale}px`,
        backgroundPosition: `-${(frame % 11) * 32 * scale}px -${Math.floor(frame / 11) * 48 * scale}px`,
      }}
    />
  );
}

export function AgentDialog({ id }: { id: AgentId }) {
  const meta = AGENT_MAP[id];
  const a = useStore((s) => s.agents.find((x) => x.id === id));
  const task = useStore((s) => (a?.taskId ? s.tasks.find((t) => t.id === a.taskId) : undefined));
  const recent = useStore((s) => s.tasks.filter((t) => t.nodes.some((n) => n.agentId === id)).sort((x, y) => y.updatedAt - x.updatedAt)[0]);
  const anns = useStore((s) => s.annotations.filter((n) => n.agentId === id).slice(-4));
  const [text, setText] = useState('');
  if (!meta) return null;
  const t = task ?? recent;
  const close = () => setUI({ agentDialog: null });
  const annotate = async () => {
    if (!text.trim()) return;
    await call('annotate', id, text, t && !['Done', 'Cancelled'].includes(t.state) ? t.id : undefined);
    setText('');
    toast(`朱批已下达${meta.name}，其下一轮必读并回应`, 'success');
  };
  const frame = a?.status === 'thinking' || a?.status === 'tool' ? 16 : a?.status === 'writing' ? 14 : a?.status === 'waiting' ? 18 : 0;
  return (
    <div className="px-modal-backdrop" onMouseDown={close}>
      <div className="px-modal pixel-panel pixel agent-dialog" onMouseDown={(e) => e.stopPropagation()} data-testid="agent-dialog">
        <div className="ad-left">
          <Portrait id={id} frame={frame} />
          <div className="px-name">{meta.official}</div>
          <div className="px-muted">{meta.name} · {meta.duty}</div>
          {a && (
            <div className="ad-stats">
              <div>状态：{statusLabel(a.status)}{a.health !== 'ok' ? `（${a.health === 'alert' ? '告警' : '停滞'}）` : ''}</div>
              <div>心跳：{a.lastHeartbeat ? fmtAgo(a.lastHeartbeat) : '—'}</div>
              <div>用度：{fmtTokens(usageTokens(a.usage))} · {fmtCost(a.usage.costUsd)}</div>
              <div>办结：{a.completed} 件</div>
            </div>
          )}
          {MINISTRIES.includes(id as never) && <button className="px-btn" onClick={() => setUI({ courtScene: 'liubu', courtDept: id, agentDialog: null })}>前往值房</button>}
        </div>
        <div className="ad-right">
          <div className="px-title">
            {a && a.status !== 'idle' ? `正在：${a.activity || statusLabel(a.status)}` : '当前空闲'}
            <button className="px-x" onClick={close}>×</button>
          </div>
          {t && (
            <div className="ad-task">
              <span className="px-chip">{STATE_LABEL[t.state]}</span> <b>{t.title}</b>
              <div className="row-gap">
                <TaskControls task={t} />
                <button className="px-btn sm" onClick={() => setUI({ review: { taskId: t.id }, agentDialog: null })}>奏折批阅</button>
                <button className="px-btn sm" onClick={() => { selectTask(t.id); openTaskTab(t.id); }}>工作台详情</button>
              </div>
            </div>
          )}
          <div className="ad-stream">
            <ActivityStream taskId={t?.id} agentFilter={id} includeGlobal compact limit={200} />
          </div>
          {anns.length > 0 && (
            <div className="ad-anns">
              {anns.map((n) => (
                <div key={n.id} className="px-muted">朱批「{n.text}」→ {n.response ? `回应：${n.response.slice(0, 60)}` : n.consumedAt ? '已阅' : '待阅'}</div>
              ))}
            </div>
          )}
          <div className="eb-input">
            <input value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && !e.nativeEvent.isComposing && annotate()} placeholder={`给${meta.name}留朱批（其下一轮必须读到并回应）`} data-testid="agent-annotate" />
            <button className="px-btn on" onClick={annotate}>朱批</button>
          </div>
        </div>
      </div>
    </div>
  );
}
