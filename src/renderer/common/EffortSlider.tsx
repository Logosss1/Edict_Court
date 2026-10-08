// 思考程度 slider — the ladder is the selected model's own levels; the right end is always the model's top level.
import { useStore } from '../store';
import { tip } from './Tip';
import { clampLevel, effectiveConfig, levelLabel } from '../../shared/reasoning';
import type { ModelRef, ProviderConfig, ReasoningConfig } from '../../shared/types';

export function reasoningFor(providers: ProviderConfig[], ref: ModelRef | null): ReasoningConfig | null {
  if (!ref) return null;
  const p = providers.find((x) => x.id === ref.providerId);
  if (!p) return null;
  const m = p.models.find((x) => x.id === ref.model);
  return effectiveConfig(m?.reasoning, ref.model, p.protocol);
}

/** value: a level name, 'default' (model default) or 'top' (model's highest level). */
export function EffortSlider({ model, value, onChange, variant = 'ui' }: { model: ModelRef | null; value: string; onChange: (v: string) => void; variant?: 'ui' | 'pixel' }) {
  const providers = useStore((s) => s.providers);
  const cfg = reasoningFor(providers, model);
  if (!cfg || !cfg.levels.length) {
    return (
      <span className={`effort none ${variant}`} {...tip('思考程度 · 不适用', '这个模型没有设置思考档位，不会发送思考参数。可在「模型配置 → 思考程度」里设置。', undefined, 'above')} data-testid="effort-none">
        思考 · 不适用
      </span>
    );
  }
  const shown = clampLevel(cfg, value)!;
  const idx = Math.max(0, cfg.levels.indexOf(shown));
  const last = cfg.levels.length - 1;
  const defIdx = cfg.levels.indexOf(cfg.default);
  const desc = `模型想得越深越准，但更慢、更费 token。可选：${cfg.levels.map(levelLabel).join(' · ')}（最右是该模型最高档）${value === 'default' ? '；当前为模型默认' : ''}`;
  return (
    <span className={`effort ${variant}`} {...tip('思考程度', desc, undefined, 'above')} data-testid="effort">
      <span className="effort-k">思考</span>
      <span className="effort-track">
        <input
          type="range"
          min={0}
          max={last}
          step={1}
          value={idx}
          aria-label="思考程度"
          aria-valuetext={levelLabel(shown)}
          onChange={(e) => {
            const i = Number(e.target.value);
            onChange(i === last ? 'top' : i === defIdx ? 'default' : cfg.levels[i]);
          }}
          style={{ ['--pct' as string]: `${last ? (idx / last) * 100 : 100}%` }}
        />
        {defIdx >= 0 && last > 0 && <i className="effort-def" style={{ left: `calc(${(defIdx / last) * 100}% )` }} />}
      </span>
      <b className={`effort-v l${Math.round((idx / Math.max(1, last)) * 4)}`}>{levelLabel(shown)}</b>
    </span>
  );
}
