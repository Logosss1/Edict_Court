// Small helpers shared by the 权限与审批 / 运行策略 / 存储与备份 pages.
import { useEffect, useState } from 'react';
import './numField.css';

/** Number input that commits on blur / Enter (not on every keystroke), clamped to [min, max]. */
export function NumField({ value, onCommit, min = 0, max, step = 1, unit, label, testid, width }: {
  value: number | undefined;
  onCommit: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  label: string;
  testid?: string;
  width?: number;
}) {
  const [text, setText] = useState(String(value ?? ''));
  useEffect(() => setText(String(value ?? '')), [value]);
  const commit = () => {
    const n = Number(text);
    if (text.trim() === '' || !Number.isFinite(n)) return setText(String(value ?? ''));
    let v = Math.max(min, n);
    if (max !== undefined) v = Math.min(max, v);
    if (step >= 1) v = Math.round(v);
    setText(String(v));
    if (v !== value) onCommit(v);
  };
  return (
    <span className="numf">
      <input
        className="input num"
        type="number"
        inputMode="decimal"
        min={min}
        max={max}
        step={step}
        value={text}
        aria-label={label}
        data-testid={testid}
        style={width ? { width } : undefined}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          if (e.key === 'Escape') {
            setText(String(value ?? ''));
            (e.target as HTMLInputElement).blur();
          }
        }}
      />
      {unit && <span className="numf-u">{unit}</span>}
    </span>
  );
}

const p2 = (n: number) => String(n).padStart(2, '0');

/** 10-12 17:44 (with the year when it is not this year). */
export function fmtStamp(ts?: number): string {
  if (!ts) return '—';
  const d = new Date(ts);
  const y = d.getFullYear() !== new Date().getFullYear() ? `${d.getFullYear()}-` : '';
  return `${y}${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** Last path segment of a workspace root. */
export const baseName = (p: string) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;
