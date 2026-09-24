// 省部调度 Monitor + 官员总览 Officials
import { useStore, setUI, selectTask } from '../store';
import { AGENTS, AGENT_MAP, KANBAN_COLUMNS, MINISTRIES, STATE_COLOR } from '../../shared/court';
import { call } from '../api';
import { Icon } from '../common/Icon';
import { HealthDot, fmtAgo, fmtCost, fmtTokens, usageTokens } from '../common/format';
import type { AgentId, ModelRef } from '../../shared/types';

export function Monitor() {
  const tasks = useStore((s) => s.tasks);
  const agents = useStore((s) => s.agents);
  const counts = KANBAN_COLUMNS.map((c) => ({ ...c, n: tasks.filter((t) => c.states.includes(t.state)).length }));
  const max = Math.max(1, ...counts.map((c) => c.n));
  const deptLoad = MINISTRIES.map((m) => ({
    id: m,
    total: tasks.reduce((n, t) => n + (t.plan?.subtasks.filter((s) => s.dept === m).length ?? 0), 0),
    running: tasks.reduce((n, t) => n + t.nodes.filter((x) => x.agentId === m && x.status === 'running').length, 0),
  }));
  const dmax = Math.max(1, ...deptLoad.map((d) => d.total));
  return (
    <div className="panel">
      <div className="panel-head"><h2><Icon name="monitor" size={18} /> 省部调度</h2></div>
      <div className="grid-2">
        <section className="card">
          <h3>各状态旨意</h3>
          {counts.map((c) => (
            <div key={c.key} className="hbar">
              <span className="hbar-label">{c.label}</span>
              <div className="hbar-track"><div className="hbar-fill" style={{ width: `${(c.n / max) * 100}%`, background: STATE_COLOR[c.states[0]] }} /></div>
              <span className="hbar-val">{c.n}</span>
            </div>
          ))}
        </section>
        <section className="card">
          <h3>六部负载（子任务数 · 执行中）</h3>
          {deptLoad.map((d) => (
            <div key={d.id} className="hbar">
              <span className="hbar-label">{AGENT_MAP[d.id].emoji} {AGENT_MAP[d.id].name}</span>
              <div className="hbar-track"><div className="hbar-fill" style={{ width: `${(d.total / dmax) * 100}%`, background: AGENT_MAP[d.id].color }} /></div>
              <span className="hbar-val">{d.total}{d.running ? ` · ${d.running}▶` : ''}</span>
            </div>
          ))}
        </section>
      </div>
      <h3 className="section-title">Agent 健康（心跳）</h3>
      <div className="agent-cards" data-testid="agent-cards">
        {AGENTS.map((m) => {
          const a = agents.find((x) => x.id === m.id);
          if (!a) return null;
          const task = a.taskId ? tasks.find((t) => t.id === a.taskId) : undefined;
          return (
            <div key={m.id} className={`agent-card st-${a.status} h-${a.health}`} onClick={() => task && selectTask(task.id)}>
              <div className="agent-card-head">
                <span className="agent-emoji" style={{ background: m.color + '22', color: m.color }}>{m.emoji}</span>
                <div>
                  <div className="agent-name">{m.name} <span className="muted small">{m.official}</span></div>
                  <div className="muted small">{m.duty}</div>
                </div>
                <HealthDot health={a.health} status={a.status} />
              </div>
              <div className="agent-activity">{a.status === 'idle' ? '空闲' : `${statusLabel(a.status)}：${a.activity || '…'}`}</div>
              {task && <div className="muted small ellipsis">📜 {task.title}</div>}
              <div className="agent-foot muted small">
                <span>心跳 {a.lastHeartbeat ? fmtAgo(a.lastHeartbeat) : '—'}</span>
                <span>{fmtTokens(usageTokens(a.usage))} tok</span>
                <span>完成 {a.completed}</span>
                {a.errors > 0 && <span style={{ color: '#d0453a' }}>错误 {a.errors}</span>}
              </div>
              <button className="link small" onClick={(e) => { e.stopPropagation(); setUI({ mode: 'court', courtScene: 'liubu', courtDept: m.id, agentDialog: m.id }); }}>在朝堂中召见 →</button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export const statusLabel = (s: string) => ({ idle: '空闲', thinking: '思考', writing: '撰写', tool: '调用工具', waiting: '等待批准', error: '出错', paused: '叫停' })[s] ?? s;

export function Officials() {
  const agents = useStore((s) => s.agents);
  const settings = useStore((s) => s.settings);
  const providers = useStore((s) => s.providers);
  const rows = AGENTS.map((m) => ({ m, a: agents.find((x) => x.id === m.id)! })).filter((r) => r.a);
  const ranked = [...rows].sort((x, y) => usageTokens(y.a.usage) - usageTokens(x.a.usage));
  const max = Math.max(1, ...rows.map((r) => usageTokens(r.a.usage)));
  const modelLabel = (id: AgentId) => {
    const r: ModelRef | undefined = settings.agentModels?.[id] ?? (AGENT_MAP[id].modelClass === 'strong' ? settings.routing?.strong : settings.routing?.economy) ?? undefined;
    if (!r) return '未配置';
    const p = providers.find((x) => x.id === r.providerId);
    return `${r.model}${p ? ` @${p.name}` : ''}${settings.agentModels?.[id] ? '（独立）' : ''}`;
  };
  return (
    <div className="panel">
      <div className="panel-head"><h2><Icon name="users" size={18} /> 官员总览</h2></div>
      <section className="card">
        <h3>Token 消耗排行</h3>
        {ranked.map(({ m, a }, i) => (
          <div key={m.id} className="hbar">
            <span className="hbar-label">{i + 1}. {m.emoji} {m.name}</span>
            <div className="hbar-track"><div className="hbar-fill" style={{ width: `${(usageTokens(a.usage) / max) * 100}%`, background: m.color }} /></div>
            <span className="hbar-val">{fmtTokens(usageTokens(a.usage))} · {fmtCost(a.usage.costUsd)}</span>
          </div>
        ))}
      </section>
      <table className="table">
        <thead><tr><th>官员</th><th>职责</th><th>状态</th><th>完成</th><th>会话</th><th>调用</th><th>缓存命中</th><th>费用</th><th>模型</th></tr></thead>
        <tbody>
          {rows.map(({ m, a }) => (
            <tr key={m.id}>
              <td>{m.emoji} {m.name}<div className="muted small">{m.official}</div></td>
              <td className="small">{m.duty}</td>
              <td><HealthDot health={a.health} status={a.status} /> {statusLabel(a.status)}</td>
              <td>{a.completed}</td>
              <td>{a.sessions}</td>
              <td>{a.usage.calls}</td>
              <td>{fmtTokens(a.usage.cachedTokens)}</td>
              <td>{fmtCost(a.usage.costUsd)}</td>
              <td className="small">{modelLabel(m.id)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted small">每位官员的模型可在「模型配置 → 官员独立模型」中热切换，下一次调用即生效。</p>
      <button className="link" onClick={() => void call('snapshot')}>刷新</button>
    </div>
  );
}
