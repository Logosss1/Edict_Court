// 「查看原因」: a small window explaining why an edict is blocked and what to do about it.
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Task } from '../../shared/types';
import { explainBlock, type FixAction } from '../../shared/blocked';
import { openSettings, toast } from '../store';
import { call } from '../api';
import { Icon } from '../common/Icon';

export function BlockedReasonDialog({ task, onClose, onOpenTask }: { task: Task; onClose: () => void; onOpenTask: () => void }) {
  const { reason, causes, failed } = explainBlock(task);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, []);
  const act = async (id: FixAction, nodeId?: string) => {
    if (id === 'open') return (onClose(), onOpenTask());
    if (id.startsWith('settings:')) return (onClose(), openSettings(id.slice(9) as 'permissions' | 'providers' | 'runtime'));
    setBusy(true);
    try {
      if (id === 'retry') {
        const n = failed.find((x) => x.id === nodeId) ?? failed[failed.length - 1];
        await call('retryNode', task.id, n.id);
        toast(`局部重试：${n.label}`, 'success');
      } else {
        await call('unblock', task.id);
        toast('已解除阻塞', 'success');
      }
      onClose();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  const last = failed[failed.length - 1];
  return createPortal(
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal block-dlg" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label="阻塞原因" data-testid="blocked-reason-dialog">
        <div className="block-h"><Icon name="alert" size={15} /> 为什么阻塞 <button className="icon-btn" onClick={onClose} aria-label="关闭"><Icon name="x" size={12} /></button></div>
        <div className="block-title">{task.title}</div>
        <div className="block-reason">{reason}</div>
        {causes.map((c, i) => (
          <div key={i} className="block-cause" data-testid="blocked-cause">
            <div className="block-cause-t">{c.title}</div>
            {c.detail && <div className="block-cause-d">{c.detail}</div>}
            <div className="block-fix-h">可以这样解决</div>
            <ul className="block-fixes">{c.fixes.map((f) => <li key={f}>{f}</li>)}</ul>
            {c.action && c.action.id !== 'unblock' && <button className="btn sm" onClick={() => act(c.action!.id)}>{c.action.label}</button>}
          </div>
        ))}
        <div className="block-actions">
          {last ? (
            <button className="btn sm primary" disabled={busy} onClick={() => act('retry', last.id)} data-testid="blocked-retry">局部重试</button>
          ) : (
            <button className="btn sm primary" disabled={busy} onClick={() => act('unblock')} data-testid="blocked-unblock">继续</button>
          )}
          <button className="btn sm" onClick={() => act('open')} data-testid="blocked-open">打开旨意</button>
          <button className="btn sm" onClick={onClose}>关闭</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
