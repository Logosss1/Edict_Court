// Model and thinking-level pickers shared by 模型配置 and the 协同设计 role form.
import { useStore } from '../store';
import type { ModelRef } from '../../shared/types';
import { levelLabel } from '../../shared/reasoning';

export const EFFORT_CHOICES = ['off', 'low', 'medium', 'high', 'xhigh', 'max'];

/** "label · provider" for a model ref, '未设置' when empty */
export function useModelName() {
  const providers = useStore((s) => s.providers);
  return (r?: ModelRef | null) => {
    if (!r) return '未设置';
    const p = providers.find((x) => x.id === r.providerId);
    return `${p?.models.find((m) => m.id === r.model)?.label || r.model}${p ? ` · ${p.name}` : ''}`;
  };
}

/** just the model's label (no service), for compact "跟随…" options */
export function useModelShort() {
  const providers = useStore((s) => s.providers);
  return (r?: ModelRef | null) => (!r ? '未设置' : providers.find((x) => x.id === r.providerId)?.models.find((m) => m.id === r.model)?.label || r.model);
}

/** what "default" means for a thinking level: strong-class calls follow the edict's slider, economy ones the model default */
export const effortDefaultLabel = (cls: 'strong' | 'economy') => (cls === 'strong' ? '跟随旨意' : '模型默认');

/** true when the ref still points at a configured provider and model */
export function useModelExists() {
  const providers = useStore((s) => s.providers);
  return (r?: ModelRef | null) => !!r && !!providers.find((p) => p.id === r.providerId)?.models.some((m) => m.id === r.model);
}

export function ModelSelect({ value, onChange, allowDefault, testid, className = 'input sm' }: { value: ModelRef | null | undefined; onChange: (r: ModelRef | null) => void; allowDefault?: string; testid?: string; className?: string }) {
  const providers = useStore((s) => s.providers);
  const exists = useModelExists();
  const name = useModelName();
  const v = value ? `${value.providerId}::${value.model}` : '';
  return (
    <select className={className} value={v} data-testid={testid} title={value ? name(value) : allowDefault} onChange={(e) => { const [providerId, model] = e.target.value.split('::'); onChange(e.target.value ? { providerId, model } : null); }}>
      <option value="">{allowDefault ?? '（未设置）'}</option>
      {value && !exists(value) && <option value={v}>{value.model}（已不可用）</option>}
      {providers.map((p) => (
        <optgroup key={p.id} label={p.name}>
          {p.models.map((m) => <option key={m.id} value={`${p.id}::${m.id}`}>{m.label || m.id}</option>)}
        </optgroup>
      ))}
    </select>
  );
}

export function EffortSelect({ value, onChange, defaultLabel = '跟随旨意 / 模型默认', testid, className = 'input sm' }: { value: string | undefined; onChange: (v: string | undefined) => void; defaultLabel?: string; testid?: string; className?: string }) {
  return (
    <select className={className} value={value ?? ''} data-testid={testid} onChange={(e) => onChange(e.target.value || undefined)}>
      <option value="">{defaultLabel}</option>
      {EFFORT_CHOICES.map((l) => <option key={l} value={l}>{levelLabel(l)}</option>)}
      <option value="top">该模型最高档</option>
    </select>
  );
}

export const effortText = (e?: string) => (!e ? '' : e === 'top' ? '最高档' : levelLabel(e));

/** how a design role's model reads in lists: short (chip) and full (table / tooltip) */
export function useRoleModelText() {
  const providers = useStore((s) => s.providers);
  const routing = useStore((s) => s.settings.routing);
  const full = useModelName();
  return (role: { modelClass: 'strong' | 'economy'; model?: ModelRef; effort?: string }) => {
    const tier = role.modelClass === 'strong' ? '强' : '经济';
    const eff = effortText(role.effort);
    if (role.model) {
      const p = providers.find((x) => x.id === role.model!.providerId);
      const m = p?.models.find((x) => x.id === role.model!.model);
      const short = m?.label || role.model.model;
      return { short: [short, eff].filter(Boolean).join(' · '), full: `${full(role.model)}${m ? '' : '（已不可用，改用' + tier + '模型路由）'}${eff ? ` · 思考 ${eff}` : ''}`, missing: !m };
    }
    const route = role.modelClass === 'strong' ? routing?.strong : routing?.economy;
    return { short: [tier, eff].filter(Boolean).join(' · '), full: `跟随${tier}模型路由（${full(route)}）${eff ? ` · 思考 ${eff}` : ''}`, missing: false };
  };
}
