// 审计日志 — append-only, SHA-256 hash-chained.
import { useEffect, useState } from 'react';
import { useStore, toast } from '../store';
import { call } from '../api';
import { Icon } from '../common/Icon';
import { fmtTime } from '../common/format';
import { agentName } from '../../shared/court';
import type { AuditEntry } from '../../shared/types';

export function AuditPanel() {
  const tasks = useStore((s) => s.tasks);
  const version = useStore((s) => s.tasks.reduce((n, t) => n + t.updatedAt, 0));
  const [taskId, setTaskId] = useState('');
  const [q, setQ] = useState('');
  const [list, setList] = useState<AuditEntry[]>([]);
  const [verify, setVerify] = useState<string | null>(null);
  useEffect(() => {
    call<AuditEntry[]>('auditList', taskId || undefined, 1000).then((l) => setList(l.reverse()));
  }, [taskId, version]);
  const shown = list.filter((e) => !q || (e.action + JSON.stringify(e.detail) + e.actor).toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="panel">
      <div className="panel-head">
        <h2><Icon name="shield" size={18} /> 审计日志</h2>
        <div className="panel-tools">
          <select className="input sm" value={taskId} onChange={(e) => setTaskId(e.target.value)}>
            <option value="">全部</option>
            {tasks.map((t) => <option key={t.id} value={t.id}>{t.id} {t.title.slice(0, 16)}</option>)}
          </select>
          <input className="input sm" placeholder="过滤" value={q} onChange={(e) => setQ(e.target.value)} />
          <button className="btn sm" onClick={async () => { const r = await call<{ ok: boolean; count: number; brokenAt?: number }>('auditVerify'); setVerify(r.ok ? `✅ 哈希链完整（${r.count} 条）` : `❌ 哈希链在 #${r.brokenAt} 处断裂`); toast(r.ok ? '审计链校验通过' : '审计链校验失败', r.ok ? 'success' : 'error'); }}>校验哈希链</button>
          {verify && <span className="small">{verify}</span>}
        </div>
      </div>
      <table className="table small audit-table">
        <thead><tr><th>#</th><th>时间</th><th>主体</th><th>动作</th><th>旨意</th><th>详情</th><th>哈希</th></tr></thead>
        <tbody>
          {shown.slice(0, 800).map((e) => (
            <tr key={e.seq}>
              <td>{e.seq}</td>
              <td className="nowrap">{fmtTime(e.at)}</td>
              <td className="nowrap">{agentName(e.actor)}</td>
              <td><code>{e.action}</code></td>
              <td className="nowrap">{e.taskId ?? ''}</td>
              <td className="audit-detail">{JSON.stringify(e.detail)}</td>
              <td><code className="muted">{e.hash.slice(0, 10)}</code></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
