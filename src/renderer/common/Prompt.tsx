// In-app text prompt and confirm (window.prompt is unavailable in Electron; native confirm looks out of place).
import { useEffect, useRef, useState } from 'react';

type Req = { title: string; placeholder?: string; initial?: string; multiline?: boolean; confirm?: { message: string; ok: string; danger?: boolean }; resolve: (v: string | null) => void };
let current: Req | null = null;
const subs = new Set<() => void>();

export function askText(title: string, o: { placeholder?: string; initial?: string; multiline?: boolean } = {}): Promise<string | null> {
  return new Promise((resolve) => {
    current?.resolve(null);
    current = { title, ...o, resolve };
    subs.forEach((s) => s());
  });
}

/** a yes / no question; resolves true on OK */
export function askConfirm(title: string, message: string, o: { ok?: string; danger?: boolean } = {}): Promise<boolean> {
  return new Promise((resolve) => {
    current?.resolve(null);
    current = { title, confirm: { message, ok: o.ok ?? '确定', danger: o.danger }, resolve: (v) => resolve(v !== null) };
    subs.forEach((s) => s());
  });
}

export function PromptHost() {
  const [, force] = useState(0);
  const ref = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  useEffect(() => {
    const f = () => force((x) => x + 1);
    subs.add(f);
    return () => {
      subs.delete(f);
    };
  }, []);
  useEffect(() => {
    ref.current?.focus();
  });
  if (!current) return null;
  const req = current;
  const done = (v: string | null) => {
    current = null;
    req.resolve(v);
    force((x) => x + 1);
  };
  return (
    <div className="modal-backdrop" onMouseDown={() => done(null)} onKeyDown={(e) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      done(null);
    }}>
      <div className="modal small" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-title">{req.title}</div>
        {req.confirm ? (
          <div className="modal-msg" data-testid="confirm-msg">{req.confirm.message}</div>
        ) : req.multiline ? (
          <textarea ref={ref} className="input" rows={5} defaultValue={req.initial} placeholder={req.placeholder} onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) done((e.target as HTMLTextAreaElement).value);
            if (e.key === 'Escape') done(null);
          }} />
        ) : (
          <input ref={ref} className="input" defaultValue={req.initial} placeholder={req.placeholder} onKeyDown={(e) => {
            if (e.key === 'Enter') done((e.target as HTMLInputElement).value);
            if (e.key === 'Escape') done(null);
          }} />
        )}
        <div className="modal-actions">
          <button className="btn" onClick={() => done(null)}>取消</button>
          {req.confirm ? (
            <button className={`btn ${req.confirm.danger ? 'danger-fill' : 'primary'}`} onClick={() => done('ok')} data-testid="confirm-ok" autoFocus>{req.confirm.ok}</button>
          ) : (
            <button className="btn primary" onClick={() => done(ref.current?.value ?? '')}>确定</button>
          )}
        </div>
      </div>
    </div>
  );
}
