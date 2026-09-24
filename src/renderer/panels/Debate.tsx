// 朝堂议政 — multi-official debate with emperor interjections (L2).
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useStore, setUI, toast } from '../store';
import { call } from '../api';
import { Icon } from '../common/Icon';
import { Markdown } from '../common/Markdown';
import { AGENTS, AGENT_MAP } from '../../shared/court';
import type { AgentId, Debate } from '../../shared/types';
import { draftToComposer } from '../workbench/AgentPane';
import { fmtTime } from '../common/format';

export function DebatePanel() {
  const debates = useStore((s) => [...s.debates].sort((a, b) => b.updatedAt - a.updatedAt));
  const selId = useStore((s) => s.ui.debateId);
  const sel = debates.find((d) => d.id === selId) ?? debates[0];
  const [creating, setCreating] = useState(!debates.length);
  return (
    <div className="panel split-panel">
      <div className="split-list">
        <div className="panel-head">
          <h2><Icon name="gavel" size={18} /> 朝堂议政</h2>
          <button className="btn sm" onClick={() => setCreating(true)}><Icon name="plus" size={12} /> 新议题</button>
        </div>
        {debates.map((d) => (
          <div key={d.id} className={`list-item ${sel?.id === d.id && !creating ? 'on' : ''}`} onClick={() => { setUI({ debateId: d.id }); setCreating(false); }}>
            <b className="ellipsis">{d.topic}</b>
            <div className="muted small">{d.status === 'running' ? '🟢 议政中' : d.status === 'concluded' ? '✅ 已定议' : d.status === 'paused' ? '⏸ 暂停' : '⏳ 待续'} · 第 {d.round} 轮 · {d.messages.length} 条{d.taskId ? ` · ${d.taskId}` : ''}</div>
          </div>
        ))}
      </div>
      <div className="split-detail">{creating ? <NewDebate onCreated={(id) => { setUI({ debateId: id }); setCreating(false); }} /> : sel ? <DebateView d={sel} /> : null}</div>
    </div>
  );
}

function NewDebate({ onCreated }: { onCreated: (id: string) => void }) {
  const [topic, setTopic] = useState('');
  const [parts, setParts] = useState<AgentId[]>(['zhongshu', 'menxia', 'shangshu', 'bingbu', 'xingbu']);
  const [rounds, setRounds] = useState(2);
  const start = async () => {
    if (!topic.trim()) return toast('请填写议题', 'warn');
    try {
      const d = await call<Debate>('debateCreate', topic, parts, rounds);
      await call('debateRun', d.id);
      onCreated(d.id);
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  return (
    <div className="card">
      <h3>召集朝堂议政</h3>
      <textarea className="input" rows={3} value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="议题，如：是否将状态管理从 Redux 迁移到 Zustand？" data-testid="debate-topic" />
      <div className="muted small" style={{ margin: '8px 0 4px' }}>与议官员</div>
      <div className="row-gap wrap">
        {AGENTS.filter((a) => !['solo', 'zaochao'].includes(a.id)).map((a) => (
          <label key={a.id} className="chk small"><input type="checkbox" checked={parts.includes(a.id)} onChange={(e) => setParts(e.target.checked ? [...parts, a.id] : parts.filter((x) => x !== a.id))} /> {a.emoji} {a.name}</label>
        ))}
      </div>
      <div className="row-gap" style={{ marginTop: 8 }}>
        <label className="small">轮数 <input className="input num" type="number" min={1} max={5} value={rounds} onChange={(e) => setRounds(+e.target.value)} /></label>
        <span style={{ flex: 1 }} />
        <button className="btn primary" onClick={start} data-testid="debate-start"><Icon name="gavel" size={13} /> 开议</button>
      </div>
    </div>
  );
}

export function DebateView({ d, compact }: { d: Debate; compact?: boolean }) {
  const [say, setSay] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [d.messages.length, d.messages[d.messages.length - 1]?.content]);
  const interject = async () => {
    if (!say.trim()) return;
    try {
      await call('debateInterject', d.id, say);
      setSay('');
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  return (
    <div className={`debate-view ${compact ? 'compact' : ''}`} data-testid="debate-view">
      {!compact && (
        <div className="debate-head">
          <h3>{d.topic}</h3>
          <div className="muted small">与议：{d.participants.map((p) => AGENT_MAP[p].name).join('、')} · 第 {d.round}/{d.maxRounds} 轮 · {d.status}{d.speaking ? ` · ${AGENT_MAP[d.speaking].name}发言中` : ''}</div>
        </div>
      )}
      <div className="debate-msgs" ref={ref}>
        {d.messages.map((m) =>
          m.kind === 'system' ? (
            <div key={m.id} className="debate-sys">— {m.content} —</div>
          ) : m.kind === 'emperor' ? (
            <div key={m.id} className="debate-msg emperor">
              <div className="dm-who">👑 皇上 <span className="muted small">{fmtTime(m.at)}</span>{d.pendingInterjections.includes(m.id) && <span className="chip chip-sm warn">待回应</span>}</div>
              <div className="dm-body">{m.content}</div>
            </div>
          ) : (
            <div key={m.id} className={`debate-msg ${m.kind}`} style={{ borderLeftColor: AGENT_MAP[m.speaker as AgentId]?.color }}>
              <div className="dm-who" style={{ color: AGENT_MAP[m.speaker as AgentId]?.color }}>
                {AGENT_MAP[m.speaker as AgentId]?.emoji} {AGENT_MAP[m.speaker as AgentId]?.official} {m.repliesTo && <span className="chip chip-sm">回应皇上</span>} {m.kind === 'conclusion' && <span className="chip chip-sm">议政结论</span>}
              </div>
              {m.kind === 'conclusion' ? <Markdown text={m.content || '…'} /> : <div className="dm-body">{m.content || <span className="typing" />}</div>}
            </div>
          ),
        )}
      </div>
      {d.status !== 'concluded' && (
        <div className="debate-input">
          <input className="input" value={say} onChange={(e) => setSay(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && interject()} placeholder="皇上插话（回车）——官员将针对你的发言继续辩论" data-testid="debate-interject" />
          <button className="btn primary" onClick={interject}><Icon name="mic" size={13} /> 口谕</button>
        </div>
      )}
      <div className="row-gap debate-actions">
        {d.status !== 'concluded' && d.status !== 'running' && <button className="btn sm" onClick={() => call('debateRun', d.id, 1)}><Icon name="play" size={12} /> 再议一轮</button>}
        {d.status === 'running' && <button className="btn sm" onClick={() => call('debatePause', d.id)}><Icon name="pause" size={12} /> 暂停</button>}
        {d.status !== 'concluded' && <button className="btn sm" onClick={() => call('debateConclude', d.id).catch((e) => toast(e.message, 'error'))}><Icon name="check" size={12} /> 中书令总结</button>}
        {d.conclusion && !d.taskId && <button className="btn sm primary" onClick={() => draftToComposer(`${d.topic}\n\n【朝堂议政结论】\n${d.conclusion}`)}><Icon name="send" size={12} /> 以此下旨</button>}
      </div>
    </div>
  );
}

export function useDebateTick() {
  const [, set] = useState(0);
  useEffect(() => {
    const t = setInterval(() => set((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, []);
}
