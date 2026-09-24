// Global high-risk confirmation dock — visible in BOTH modes so no approval is ever missed.
import { useState } from 'react';
import { useStore } from '../store';
import { call } from '../api';
import { Icon } from '../common/Icon';
import { AGENT_MAP } from '../../shared/court';

export function ApprovalsDock() {
  const aps = useStore((s) => s.approvals.filter((a) => a.status === 'pending'));
  const mode = useStore((s) => s.ui.mode);
  const [open, setOpen] = useState<string | null>(null);
  if (!aps.length) return null;
  return (
    <div className={`approvals-dock ${mode}`} data-testid="approvals-dock">
      {aps.slice(0, 4).map((a) => (
        <div key={a.id} className={`approval-card ${a.risk}`}>
          <div className="ac-head">
            <Icon name={a.risk === 'high' ? 'alert' : 'shield'} size={14} />
            <b>{a.risk === 'high' ? '高风险操作 · 须皇上确认' : '操作待批准'}</b>
            <span className="muted small">{AGENT_MAP[a.agentId]?.name} · {a.taskId}</span>
          </div>
          <div className="ac-summary">{a.summary}</div>
          <div className="muted small">{a.reason}</div>
          {open === a.id && <pre className="ac-detail">{a.detail}</pre>}
          <div className="gate-actions">
            <button className="link" onClick={() => setOpen(open === a.id ? null : a.id)}>{open === a.id ? '收起' : '详情'}</button>
            <span style={{ flex: 1 }} />
            <button className="btn sm danger" onClick={() => call('decideApproval', a.id, false)} data-testid="approval-deny">驳回</button>
            <button className="btn sm primary" onClick={() => call('decideApproval', a.id, true)} data-testid="approval-approve">准许</button>
          </div>
        </div>
      ))}
      {aps.length > 4 && <div className="muted small">另有 {aps.length - 4} 项待批…</div>}
    </div>
  );
}
