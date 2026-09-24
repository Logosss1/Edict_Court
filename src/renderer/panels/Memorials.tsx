// 奏折阁 · Memorials — auto-archived with a five-stage timeline.
import { useState } from 'react';
import { useStore, openTaskTab, toast } from '../store';
import { call } from '../api';
import { Icon } from '../common/Icon';
import { StateChip, fmtCost, fmtTime, fmtTokens, usageTokens } from '../common/format';
import { TIER_SHORT } from '../../shared/court';
import type { Memorial } from '../../shared/types';

export function Memorials() {
  const list = useStore((s) => [...s.memorials].sort((a, b) => b.archivedAt - a.archivedAt));
  const [filter, setFilter] = useState<'all' | 'Done' | 'Cancelled'>('all');
  const [sel, setSel] = useState<string | null>(list[0]?.taskId ?? null);
  const shown = list.filter((m) => filter === 'all' || m.finalState === filter);
  const m = list.find((x) => x.taskId === sel);
  return (
    <div className="panel split-panel">
      <div className="split-list">
        <div className="panel-head">
          <h2><Icon name="scroll" size={18} /> 奏折阁</h2>
          <select className="input sm" value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)}>
            <option value="all">全部</option>
            <option value="Done">已完成</option>
            <option value="Cancelled">已取消</option>
          </select>
        </div>
        {!shown.length && <div className="muted pad">暂无奏折。旨意结案后自动归档。</div>}
        {shown.map((x) => (
          <div key={x.taskId} className={`list-item ${sel === x.taskId ? 'on' : ''}`} onClick={() => setSel(x.taskId)}>
            <div className="ellipsis"><b>{x.title}</b></div>
            <div className="muted small"><StateChip state={x.finalState} small /> {TIER_SHORT[x.tier]} · {fmtTime(x.archivedAt)}</div>
          </div>
        ))}
      </div>
      <div className="split-detail">{m ? <MemorialView m={m} /> : <div className="muted pad">选择一份奏折</div>}</div>
    </div>
  );
}

export function MemorialView({ m }: { m: Memorial }) {
  return (
    <div className="memorial" data-testid="memorial">
      <div className="memorial-head">
        <h2>{m.title}</h2>
        <div className="muted small">
          <code>{m.taskId}</code> · {TIER_SHORT[m.tier]} · 归档 {fmtTime(m.archivedAt)} · {fmtTokens(usageTokens(m.usage))} tok · {fmtCost(m.usage.costUsd)} · 模型 {m.models.join(', ') || '—'}
        </div>
        <div className="row-gap">
          <button className="btn sm" onClick={async () => { await navigator.clipboard.writeText(await call<string>('memorialMarkdown', m.taskId)); toast('已复制为 Markdown', 'success'); }}>
            <Icon name="copy" size={12} /> 复制为 Markdown
          </button>
          <button className="btn sm" onClick={() => openTaskTab(m.taskId)}><Icon name="external" size={12} /> 旨意详情</button>
        </div>
      </div>
      <div className="timeline5">
        {m.stages.map((s, i) => (
          <div key={s.key} className="tl-stage">
            <div className="tl-node">{['旨', '中', '门', '部', '奏'][i]}</div>
            <div className="tl-body">
              <div className="tl-title">{s.label} <span className="muted small">{fmtTime(s.at)}</span></div>
              {s.items.length ? s.items.map((it, k) => <div key={k} className="tl-item">{it}</div>) : <div className="muted small">（无）</div>}
            </div>
          </div>
        ))}
      </div>
      <h3 className="section-title">产物（系统核验 SHA-256）</h3>
      {m.artifacts.length ? (
        <table className="table small">
          <thead><tr><th>路径</th><th>sha256</th><th>大小</th></tr></thead>
          <tbody>{m.artifacts.map((a) => <tr key={a.path}><td><code>{a.path}</code></td><td><code>{a.sha256.slice(0, 20)}…</code></td><td>{a.bytes}B</td></tr>)}</tbody>
        </table>
      ) : <div className="muted small">无文件产物</div>}
      <h3 className="section-title">运行记录</h3>
      <table className="table small">
        <thead><tr><th>节点</th><th>run ID</th><th>模型</th><th>退出</th><th>开始</th><th>结束</th></tr></thead>
        <tbody>{m.runs.map((r) => <tr key={r.nodeId}><td>{r.label}</td><td><code>{r.runId ?? '—'}</code></td><td>{r.model ?? '—'}</td><td>{r.exitStatus ?? '—'}</td><td>{fmtTime(r.startedAt)}</td><td>{fmtTime(r.endedAt)}</td></tr>)}</tbody>
      </table>
      <h3 className="section-title">流转链</h3>
      <div className="flow-chain">
        {m.flow.map((f, i) => (
          <div key={i} className="flow-item"><span className="muted small">{fmtTime(f.at)}</span> {f.from} → <b>{f.to}</b> <span className="muted">{f.remark}</span></div>
        ))}
      </div>
    </div>
  );
}
