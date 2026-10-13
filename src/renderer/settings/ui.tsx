// Shared building blocks for the settings center pages (2.0 look: sections, rows, toggles, tiles, badges).
import type { ReactNode } from 'react';
import { Icon } from '../common/Icon';

/** Page title + one-line lead. */
export function Page({ icon, title, lead, actions, children, testid }: { icon: string; title: string; lead?: ReactNode; actions?: ReactNode; children: ReactNode; testid?: string }) {
  return (
    <div className="sp-page" data-testid={testid}>
      <div className="sp-head">
        <h2><Icon name={icon} size={18} /> {title}</h2>
        {actions && <div className="sp-actions">{actions}</div>}
      </div>
      {lead && <div className="sp-lead">{lead}</div>}
      {children}
    </div>
  );
}

/** A bordered section card with a bold heading, an optional muted note and right-aligned actions. */
export function Sec({ title, note, right, children, className, testid }: { title?: ReactNode; note?: ReactNode; right?: ReactNode; children?: ReactNode; className?: string; testid?: string }) {
  return (
    <section className={`sp-sec ${className ?? ''}`} data-testid={testid}>
      {(title || right) && (
        <div className="sp-sec-h">
          {title && <b>{title}</b>}
          {note && <span className="muted">{note}</span>}
          {right && <span className="sp-sec-r">{right}</span>}
        </div>
      )}
      {children}
    </section>
  );
}

/** A setting row: label (+ description) on the left, the control on the right. */
export function Row({ label, desc, children, testid }: { label: ReactNode; desc?: ReactNode; children?: ReactNode; testid?: string }) {
  return (
    <div className="sp-row" data-testid={testid}>
      <div className="sp-row-l">
        <div>{label}</div>
        {desc && <div className="muted">{desc}</div>}
      </div>
      {children !== undefined && <div className="sp-row-c">{children}</div>}
    </div>
  );
}

/** Toggle switch (keyboard accessible). */
export function Toggle({ on, onChange, disabled, tone, label, testid }: { on: boolean; onChange: (v: boolean) => void; disabled?: boolean; tone?: 'red'; label?: string; testid?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      className={`tog ${on ? 'on' : ''} ${tone === 'red' ? 'red' : ''}`}
      onClick={() => onChange(!on)}
      data-testid={testid}
    />
  );
}

/** Summary tile (number + label + sub line). */
export function Tile({ icon, label, value, sub, tone, onClick, active }: { icon?: string; label: string; value: ReactNode; sub?: ReactNode; tone?: 'attn' | 'bad' | 'ok'; onClick?: () => void; active?: boolean }) {
  return (
    <div className={`stat-tile ${tone ?? ''} ${onClick ? 'clickable' : ''} ${active ? 'active' : ''}`} onClick={onClick} role={onClick ? 'button' : undefined}>
      <div className="k">{icon && <Icon name={icon} size={13} />} {label}</div>
      <div className="v">{value}</div>
      {sub && <div className="s">{sub}</div>}
    </div>
  );
}

/** Small status pill: ok / auth / err / off / trust. */
export function Badge({ tone, children, dot = true }: { tone: 'ok' | 'auth' | 'err' | 'off' | 'trust' | 'new'; children: ReactNode; dot?: boolean }) {
  return <span className={`badge2 ${tone}`}>{dot && <i />}{children}</span>;
}

/** Amber warning strip. */
export function Warn({ children }: { children: ReactNode }) {
  return (
    <div className="warnbox">
      <Icon name="alert" size={13} />
      <span>{children}</span>
    </div>
  );
}
