// 旨意详情 — nodes (with local retry), plan versions, reviews, changes, flow chain, annotations.
import { useState } from 'react';
import { useStore, useTask, setUI, toast } from '../store';
import { call } from '../api';
import { Icon } from '../common/Icon';
import { Markdown } from '../common/Markdown';
import { AgentChip, StateChip, fmtCost, fmtDur, fmtTime, fmtTokens, usageTokens } from '../common/format';
import { AGENTS, AGENT_MAP, TIER_LABEL } from '../../shared/court';
import type { AgentId, Task } from '../../shared/types';
import { ChangesList, GateCard, Pipeline, PlanEditor, TaskControls, UsageLine } from './TaskWidgets';
import { ActivityStream } from '../workbench/ActivityStream';

type TabKey = 'nodes' | 'plan' | 'changes' | 'flow' | 'notes' | 'report' | 'live';

export function TaskDetail({ taskId }: { taskId: string }) {
  const task = useTask(taskId);
  const [tab, setTab] = useState<TabKey>('nodes');
  if (!task) return <div className="panel muted">旨意不存在（可能已从看板移除，奏折阁中仍有归档）</div>;
  const tabs: [TabKey, string][] = [['nodes', `执行节点 ${task.nodes.length}`], ['plan', `方案与审议 ${task.planHistory.length}/${task.reviews.length}`], ['changes', `改动与产物 ${task.changes.length}`], ['flow', `流转链 ${task.flow.length}`], ['notes', '朱批'], ['report', '回奏'], ['live', '实时活动']];
  return (
    <div className="panel task-detail" data-testid="task-detail">
      <div className="td-head">
        <div className="row-gap">
          <StateChip state={task.state} />
          <h2 className="ellipsis">{task.title}</h2>
          <code className="muted">{task.id}</code>
        </div>
        <div className="muted small">{TIER_LABEL[task.tier]} · 下旨 {fmtTime(task.createdAt)} · 工作区 {task.workspace ?? '（无）'}</div>
        <Pipeline task={task} />
        <UsageLine task={task} />
        <div className="row-gap">
          <TaskControls task={task} />
          <button className="btn sm" onClick={() => setUI({ mode: 'court', review: { taskId: task.id }, courtScene: 'taihe' })}><Icon name="crown" size={12} /> 朝堂批阅</button>
          {['Done', 'Cancelled'].includes(task.state) && <button className="btn sm" onClick={async () => { await navigator.clipboard.writeText(await call<string>('memorialMarkdown', task.id)); toast('奏折已复制为 Markdown', 'success'); }}><Icon name="copy" size={12} /> 复制奏折</button>}
        </div>
        {task.state === 'Blocked' && <div className="notice warn">⚠ 阻塞：{task.blockedReason}</div>}
      </div>
      <div className="edict-text"><span className="muted small">原旨</span><div>{task.edict}</div></div>
      {task.gate && <GateCard task={task} />}
      <div className="subtabs">
        {tabs.map(([k, l]) => <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>)}
      </div>
      {tab === 'nodes' && <Nodes task={task} />}
      {tab === 'plan' && <PlanHistory task={task} />}
      {tab === 'changes' && <ChangesList task={task} />}
      {tab === 'flow' && (
        <div className="flow-chain">
          {task.flow.map((f, i) => <div key={i} className="flow-item"><span className="muted small">{fmtTime(f.at)}</span> {f.from} → <b>{f.to}</b> <span className="muted">{f.remark}</span></div>)}
        </div>
      )}
      {tab === 'notes' && <Annotations task={task} />}
      {tab === 'report' && <div className="card"><Markdown text={task.result?.summary || '（尚未回奏）'} /></div>}
      {tab === 'live' && <div className="td-live"><ActivityStream taskId={task.id} /></div>}
    </div>
  );
}

function Nodes({ task }: { task: Task }) {
  return (
    <table className="table small">
      <thead><tr><th>节点</th><th>官员</th><th>状态</th><th>次数</th><th>模型 / run</th><th>耗时</th><th>Token · 费用</th><th>结论 / 错误</th><th /></tr></thead>
      <tbody>
        {task.nodes.map((n) => (
          <tr key={n.id} className={`node-${n.status}`}>
            <td>{n.label}<div className="muted small"><code>{n.id}</code></div></td>
            <td><AgentChip id={n.agentId} small /></td>
            <td><span className={`node-status st-${n.status}`}>{({ pending: '待执行', running: '执行中', done: '完成', failed: '失败', skipped: '跳过', waiting: '等待', cancelled: '中断' } as Record<string, string>)[n.status]}</span>{n.exitStatus && <div className="muted small">exit={n.exitStatus}</div>}</td>
            <td>{n.attempts}</td>
            <td className="small">{n.model ?? '—'}<div className="muted"><code>{n.runId ?? ''}</code></div></td>
            <td className="small">{fmtDur(n.startedAt, n.endedAt)}</td>
            <td className="small">{fmtTokens(usageTokens(n.usage))} · {fmtCost(n.usage?.costUsd ?? 0)}</td>
            <td className="small node-out">{n.error ? <span style={{ color: '#d0453a' }}>{n.error}</span> : <NodeOutput text={n.output} />}</td>
            <td>{(n.status === 'failed' || n.status === 'cancelled') && !['Done', 'Cancelled'].includes(task.state) && (
              <button className="btn sm" onClick={() => call('retryNode', task.id, n.id).then(() => toast(`局部重试：${n.label}`, 'success')).catch((e) => toast(e.message, 'error'))} data-testid="retry-node"><Icon name="retry" size={12} /> 局部重试</button>
            )}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function NodeOutput({ text }: { text?: string }) {
  const [open, setOpen] = useState(false);
  if (!text) return <span className="muted">—</span>;
  let summary = text;
  try {
    const j = JSON.parse(text);
    summary = j.summary ?? j.comment ?? j.verdict ?? text;
  } catch {
    /* plain */
  }
  return (
    <div>
      <span className="clickable" onClick={() => setOpen(!open)}>{String(summary).slice(0, 120)}{open ? '' : ' ▸'}</span>
      {open && <pre className="tool-out">{(() => { try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return text; } })()}</pre>}
    </div>
  );
}

function PlanHistory({ task }: { task: Task }) {
  const [v, setV] = useState(task.planHistory.length);
  const cur = task.planHistory.find((p) => p.version === v) ?? task.planHistory[task.planHistory.length - 1];
  return (
    <div className="grid-2 wide-left">
      <div>
        {cur ? (
          <>
            <div className="row-gap">
              {task.planHistory.map((p) => <button key={p.version} className={`pill ${p.version === cur.version ? 'on' : ''}`} onClick={() => setV(p.version)}>v{p.version}{p.author === 'emperor' ? ' 朱批' : ''}</button>)}
              <span className="muted small">{cur.author === 'emperor' ? '皇上朱笔涂改' : '中书省拟'} · {fmtTime(cur.at)}{cur.note ? ` · ${cur.note}` : ''}</span>
            </div>
            <PlanEditor plan={cur.plan} readOnly />
          </>
        ) : <div className="muted pad">中书省尚未呈上方案</div>}
      </div>
      <div>
        <h4>审议记录</h4>
        {task.reviews.map((r, i) => (
          <div key={i} className={`review-note ${r.verdict}`}>
            <b>{r.stage === 'plan' ? '方案' : '成果'}第 {r.round} 轮 · {r.reviewer === 'emperor' ? '👑 皇上' : '🔍 门下省'} · {r.verdict === 'approve' ? '✅ 准奏' : '❌ 封驳'}</b>
            <div>{r.comment}</div>
            {r.issues.length > 0 && <ul>{r.issues.map((x, k) => <li key={k}>{x}</li>)}</ul>}
            <div className="muted small">{fmtTime(r.at)}</div>
          </div>
        ))}
        {!task.reviews.length && <div className="muted small">暂无</div>}
      </div>
    </div>
  );
}

function Annotations({ task }: { task: Task }) {
  const anns = useStore((s) => s.annotations.filter((a) => a.taskId === task.id));
  const [agent, setAgent] = useState<AgentId>(task.nodes.find((n) => n.status === 'running')?.agentId ?? (task.tier === 'solo' ? 'solo' : 'zhongshu'));
  const [text, setText] = useState('');
  const send = async () => {
    if (!text.trim()) return;
    await call('annotate', agent, text, task.id);
    setText('');
    toast(`朱批已送达 ${AGENT_MAP[agent].name}，其下一轮必须读到并回应`, 'success');
  };
  return (
    <div>
      <div className="card row-gap">
        <select className="input sm" value={agent} onChange={(e) => setAgent(e.target.value as AgentId)}>
          {AGENTS.map((a) => <option key={a.id} value={a.id}>{a.emoji} {a.name}</option>)}
        </select>
        <input className="input" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && send()} placeholder="朱批：给该官员留言，其下一轮必须读到并回应" data-testid="annotation-input" />
        <button className="btn primary sm" onClick={send}>朱批</button>
      </div>
      {anns.map((a) => (
        <div key={a.id} className="annotation">
          <div><AgentChip id={a.agentId} small /> <b>{a.text}</b> <span className="muted small">{fmtTime(a.at)}</span> <span className={`chip chip-sm ${a.response ? '' : 'warn'}`}>{a.response ? '已回应' : a.consumedAt ? '已阅' : '待阅'}</span></div>
          {a.response && <div className="annotation-resp">↳ {a.response}</div>}
        </div>
      ))}
    </div>
  );
}
