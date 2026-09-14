import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

interface Props {
  title: string;
  message: string;
  okLabel: string;
  okClass?: string;
  onOk: (reason: string) => void;
  onCancel: () => void;
}

export default function ConfirmDialog({ title, message, okLabel, okClass, onOk, onCancel }: Props) {
  const [reason, setReason] = useState('');
  const box = useRef<HTMLDivElement>(null);
  const cancel = useRef(onCancel);
  cancel.current = onCancel;
  useEffect(() => {
    const trigger = document.activeElement as HTMLElement | null;
    box.current?.querySelector('textarea')?.focus();
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopImmediatePropagation(); cancel.current();
      }
      if (event.key !== 'Tab') return;
      const controls = Array.from(box.current?.querySelectorAll<HTMLElement>('textarea, button:not(:disabled)') || []);
      const first = controls[0], last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', handleKey, true);
    return () => { document.removeEventListener('keydown', handleKey, true); if (trigger?.isConnected) trigger.focus(); };
  }, []);

  // A hovered card is transformed, which otherwise becomes the containing
  // block for this fixed overlay and moves it under the pointer. Keep the
  // modal at the document root; React events still need propagation stopped.
  return createPortal(
    <div className="confirm-bg open" role="presentation" onClick={(e) => { e.stopPropagation(); onCancel(); }}>
      <div ref={box} className="confirm-box" role="dialog" aria-modal="true" aria-labelledby="confirm-dialog-title" onClick={(e) => e.stopPropagation()}>
        <h2 id="confirm-dialog-title" className="confirm-title">{title}</h2>
        <p className="confirm-msg">{message}</p>
        <textarea
          className="confirm-reason"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="输入原因（可留空）"
          rows={2}
          aria-label="操作原因"
        />
        <div className="confirm-btns">
          <button type="button" className="btn btn-g" onClick={onCancel}>返回</button>
          <button type="button" className={`btn btn-action ${okClass || ''}`} onClick={() => onOk(reason)}>
            {okLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
