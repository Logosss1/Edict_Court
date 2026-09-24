// 小任务 · Sessions — Solo conversations and 太子 chat replies.
import { useState } from 'react';
import { useStore, selectTask } from '../store';
import { Icon } from '../common/Icon';
import { Markdown } from '../common/Markdown';
import { fmtAgo, fmtCost, fmtTokens, usageTokens } from '../common/format';
import { agentName } from '../../shared/court';

export function Sessions() {
  const sessions = useStore((s) => [...s.sessions].sort((a, b) => b.updatedAt - a.updatedAt));
  const agents = useStore((s) => s.agents);
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div className="panel">
      <div className="panel-head"><h2><Icon name="message" size={18} /> 小任务 Sessions</h2><span className="muted small">Solo 会话与太子闲聊直答</span></div>
      {!sessions.length && <div className="muted pad">暂无会话</div>}
      <div className="session-list">
        {sessions.map((s) => {
          const a = agents.find((x) => x.id === s.agentId);
          const last = s.messages[s.messages.length - 1];
          const live = a && a.status !== 'idle' && (!s.taskId || a.taskId === s.taskId);
          return (
            <div key={s.id} className="card session-card">
              <div className="row-gap" onClick={() => setOpen(open === s.id ? null : s.id)} style={{ cursor: 'pointer' }}>
                <span className="dot" style={{ background: live ? '#22c55e' : '#6b7280' }} />
                <b className="ellipsis">{s.title}</b>
                <span className="chip chip-sm">{s.source === 'solo' ? 'Solo' : s.source === 'taizi-chat' ? '太子分拣' : s.source}</span>
                <span className="muted small">{agentName(s.agentId)} · {s.messages.length} 条 · {fmtTokens(usageTokens(s.usage))} tok · {fmtCost(s.usage.costUsd)} · {fmtAgo(s.updatedAt)}</span>
                {s.taskId && <button className="link small" onClick={(e) => { e.stopPropagation(); selectTask(s.taskId!); }}>旨意 →</button>}
              </div>
              {open !== s.id && last && <div className="muted small ellipsis">{last.role === 'user' ? '👑 ' : ''}{last.content.slice(0, 160)}</div>}
              {open === s.id && (
                <div className="session-msgs">
                  {s.messages.map((m, i) => (
                    <div key={i} className={`chat-msg ${m.role}`}>
                      <div className="muted small">{m.role === 'user' ? '👑 皇上' : agentName(s.agentId)}</div>
                      <Markdown text={m.content} />
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
