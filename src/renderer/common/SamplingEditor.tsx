// 回答参数 sliders (Temperature / Top P / Frequency / Presence penalty): tick one to send it, untick to leave it to
// the service. Parameters the protocol has no field for are greyed out. Used per model (模型服务) and per official.
import { Icon } from './Icon';
import { tip } from './Tip';
import { SAMPLING_SPECS, samplingUnsupported, type SamplingKey } from '../../shared/sampling';
import type { Protocol, SamplingParams } from '../../shared/types';

export function SamplingEditor({ value, onChange, protocol, inherited, inheritedLabel, testid }: {
  value?: SamplingParams;
  onChange: (v: SamplingParams | undefined) => void;
  protocol?: Protocol;
  /** what applies when a parameter is left unticked (shown as the placeholder value) */
  inherited?: SamplingParams;
  inheritedLabel?: string;
  testid?: string;
}) {
  const v = value ?? {};
  const set = (k: SamplingKey, x: number | undefined) => {
    const next = { ...v };
    if (x === undefined) delete next[k];
    else next[k] = x;
    onChange(Object.keys(next).length ? next : undefined);
  };
  return (
    <div className="sampling" data-testid={testid ?? 'sampling'}>
      {SAMPLING_SPECS.map((s) => {
        const why = protocol ? samplingUnsupported(s.key, protocol) : '';
        const on = v[s.key] !== undefined && !why;
        const cur = on ? v[s.key]! : inherited?.[s.key];
        return (
          <div key={s.key} className={`smp-row ${on ? 'on' : ''} ${why ? 'off' : ''}`} {...(why ? tip(s.label, why) : {})} data-testid={`smp-${s.key}`}>
            <span className="smp-ic"><Icon name={s.icon} size={14} /></span>
            <span className="smp-l">
              <b>{s.label}</b>
              <span className="muted small">{why || s.desc}</span>
            </span>
            <input type="checkbox" className="smp-chk" checked={on} disabled={!!why} onChange={(e) => set(s.key, e.target.checked ? (inherited?.[s.key] ?? s.initial) : undefined)} aria-label={`发送 ${s.label}`} data-testid={`smp-${s.key}-on`} />
            <input type="range" className="smp-range" min={s.min} max={s.max} step={s.step} value={cur ?? s.initial} disabled={!on} onChange={(e) => set(s.key, +e.target.value)} aria-label={s.label} />
            <input
              type="number"
              className="input num smp-num"
              min={s.min}
              max={s.max}
              step={s.step}
              value={on ? v[s.key] : ''}
              placeholder={why ? '—' : cur !== undefined ? String(cur) : '默认'}
              disabled={!on}
              onChange={(e) => {
                const x = e.target.value === '' ? undefined : Math.min(s.max, Math.max(s.min, +e.target.value));
                if (x === undefined || Number.isFinite(x)) set(s.key, x);
              }}
              data-testid={`smp-${s.key}-num`}
            />
          </div>
        );
      })}
      {inheritedLabel && <div className="muted small smp-foot">{inheritedLabel}</div>}
    </div>
  );
}
