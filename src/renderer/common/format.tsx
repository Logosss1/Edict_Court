import type { Usage, TaskState, AgentId } from '../../shared/types';
import { STATE_COLOR, STATE_LABEL, AGENT_MAP } from '../../shared/court';

export const fmtTokens = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n)));
export const fmtCost = (usd: number) => (usd === 0 ? '$0' : usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(3)}`);
export const usageTokens = (u?: Usage) => (u ? u.inputTokens + u.outputTokens : 0);

export function fmtTime(ts?: number) {
  if (!ts) return '—';
  const d = new Date(ts);
  const now = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  const hm = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  return d.toDateString() === now.toDateString() ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm.slice(0, 5)}`;
}

export function fmtAgo(ts?: number) {
  if (!ts) return '—';
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}秒前`;
  if (s < 3600) return `${Math.round(s / 60)}分钟前`;
  if (s < 86400) return `${Math.round(s / 3600)}小时前`;
  return `${Math.round(s / 86400)}天前`;
}

export function fmtDur(a?: number, b?: number) {
  if (!a) return '';
  const ms = (b ?? Date.now()) - a;
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m${Math.round((ms % 60000) / 1000)}s`;
}

export function StateChip({ state, small }: { state: TaskState; small?: boolean }) {
  return (
    <span className={`chip ${small ? 'chip-sm' : ''}`} style={{ color: STATE_COLOR[state], borderColor: STATE_COLOR[state] + '66', background: STATE_COLOR[state] + '1a' }}>
      {STATE_LABEL[state]}
    </span>
  );
}

export function AgentChip({ id, small }: { id: AgentId | 'emperor' | 'system'; small?: boolean }) {
  if (id === 'emperor') return <span className={`chip ${small ? 'chip-sm' : ''}`} style={{ color: '#e8b64c', borderColor: '#e8b64c66' }}>👑 皇上</span>;
  if (id === 'system') return <span className={`chip ${small ? 'chip-sm' : ''}`}>⚙︎ 系统</span>;
  const a = AGENT_MAP[id];
  if (!a) return <span className="chip">{id}</span>;
  return (
    <span className={`chip ${small ? 'chip-sm' : ''}`} style={{ color: a.color, borderColor: a.color + '55', background: a.color + '14' }}>
      {a.emoji} {a.name}
    </span>
  );
}

export function HealthDot({ health, status }: { health: string; status: string }) {
  const color = status === 'idle' ? '#6b7280' : health === 'alert' ? '#ef4444' : health === 'stale' ? '#eab308' : '#22c55e';
  return <span className={`dot ${status !== 'idle' && health === 'ok' ? 'dot-pulse' : ''}`} style={{ background: color }} title={`${status} · ${health}`} />;
}
