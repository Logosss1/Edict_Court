import { useEffect, useLayoutEffect, useRef, useState, memo } from 'react';
import { useStore } from '../store';
import type { Activity } from '../../shared/types';
import { AGENT_MAP } from '../../shared/court';
import { Icon } from '../common/Icon';
import { Markdown } from '../common/Markdown';
import { fmtTime } from '../common/format';

export function ActivityStream({ taskId, compact, includeGlobal, agentFilter, limit = 600 }: { taskId?: string; compact?: boolean; includeGlobal?: boolean; agentFilter?: string; limit?: number }) {
  const list = useStore((s) => {
    const a = taskId ? s.activities[taskId] ?? [] : [];
    const g = includeGlobal || !taskId ? s.activities._global ?? [] : [];
    return { a, g };
  });
  let items = [...list.a, ...list.g];
  if (includeGlobal && taskId) items.sort((x, y) => x.at - y.at);
  if (agentFilter) items = items.filter((x) => x.agentId === agentFilter);
  items = items.slice(-limit);
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  });
  // pair tool results with calls
  const results = new Map<string, Activity>();
  for (const it of items) if (it.kind === 'tool_result' && it.data?.callId) results.set(String(it.data.callId), it);
  return (
    <div
      ref={ref}
      className={`activity-stream ${compact ? 'compact' : ''}`}
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
      }}
      data-testid="activity-stream"
    >
      {!items.length && <div className="muted pad small">暂无活动。下旨后，这里实时显示每位官员的思考、工具调用、结果与状态流转。</div>}
      {items.map((a) => (a.kind === 'tool_result' && a.data?.callId ? null : <ActivityItem key={a.id} a={a} result={results.get(a.id)} compact={compact} />))}
    </div>
  );
}

const ActivityItem = memo(function ActivityItem({ a, result, compact }: { a: Activity; result?: Activity; compact?: boolean }) {
  const meta = a.agentId ? AGENT_MAP[a.agentId] : undefined;
  const who = meta ? (
    <span className="act-who" style={{ color: meta.color }}>
      {meta.emoji} {meta.name}
    </span>
  ) : null;
  const time = <span className="act-time">{fmtTime(a.at)}</span>;
  switch (a.kind) {
    case 'thinking':
      return <Thinking a={a} who={who} time={time} />;
    case 'text':
      return (
        <div className="act act-text">
          <div className="act-head">{who}{time}{a.streaming && <span className="typing" />}</div>
          <Markdown text={a.content || '…'} />
        </div>
      );
    case 'tool_call':
      return <ToolCall a={a} result={result} who={who} time={time} />;
    case 'tool_result':
      return (
        <div className="act act-log">
          {who} <pre className="tool-out">{a.content}</pre>
        </div>
      );
    case 'state':
      return (
        <div className="act act-state">
          <Icon name="chevronRight" size={11} /> {a.content} {time}
        </div>
      );
    case 'gate':
      return (
        <div className="act act-gate">
          <Icon name="scroll" size={13} /> {a.content} {time}
        </div>
      );
    case 'human':
    case 'annotation':
      return (
        <div className="act act-human">
          <span className="act-who" style={{ color: '#e8b64c' }}>👑</span> {a.content} {time}
        </div>
      );
    case 'error':
      return (
        <div className="act act-error">
          <Icon name="alert" size={13} /> {who} {a.content} {time}
        </div>
      );
    default:
      return (
        <div className={`act act-log ${compact ? '' : ''}`}>
          {who} <span className="act-logtext">{a.content}</span> {time}
        </div>
      );
  }
});

function Thinking({ a, who, time }: { a: Activity; who: React.ReactNode; time: React.ReactNode }) {
  const [open, setOpen] = useState(!!a.streaming);
  useEffect(() => {
    if (!a.streaming) setOpen(false);
  }, [a.streaming]);
  return (
    <div className="act act-thinking">
      <div className="act-head clickable" onClick={() => setOpen(!open)}>
        <Icon name={open ? 'chevronDown' : 'chevronRight'} size={11} /> {who} <span className="muted">思考{a.streaming ? '中' : ''} · {a.content.length} 字</span> {time}
        {a.streaming && <span className="typing" />}
      </div>
      {open && <div className="thinking-body">{a.content}</div>}
    </div>
  );
}

function ToolCall({ a, result, who, time }: { a: Activity; result?: Activity; who: React.ReactNode; time: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const ok = result?.data?.ok;
  return (
    <div className={`act act-tool ${result ? (ok ? 'ok' : 'fail') : 'pending'}`}>
      <div className="act-head clickable" onClick={() => setOpen(!open)}>
        <Icon name={open ? 'chevronDown' : 'chevronRight'} size={11} />
        {who}
        <span className="tool-name">{String(a.data?.name ?? '')}</span>
        <span className="tool-desc">{a.content}</span>
        <span className={`tool-status ${result ? (ok ? 'ok' : 'fail') : ''}`}>{result ? (ok ? '✓' : '✗') : '…'}</span>
        {time}
      </div>
      {open && (
        <div className="tool-detail">
          <pre className="tool-args">{JSON.stringify(a.data?.args ?? {}, null, 2)}</pre>
          {result && <pre className="tool-out">{result.content}</pre>}
        </div>
      )}
    </div>
  );
}
