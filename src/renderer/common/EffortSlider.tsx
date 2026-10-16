// 思考程度 slider — always the same six positions; the ones the selected model has no level for are greyed and skipped.
import { useStore } from '../store';
import { tip } from './Tip';
import { TIERS, TIER_LABEL, availableTiers, defaultTier, effectiveConfig, nearestTier, resolveTier, tierHint, type Tier } from '../../shared/reasoning';
import type { ModelRef, ProviderConfig, ReasoningConfig } from '../../shared/types';

export function reasoningFor(providers: ProviderConfig[], ref: ModelRef | null): ReasoningConfig | null {
  if (!ref) return null;
  const p = providers.find((x) => x.id === ref.providerId);
  if (!p) return null;
  const m = p.models.find((x) => x.id === ref.model);
  return effectiveConfig(m?.reasoning, ref.model, p.protocol);
}

/** value: one of the six (TIERS), 'default' (model default) or 'top' (model's highest level). */
export function EffortSlider({ model, value, onChange, variant = 'ui' }: { model: ModelRef | null; value: string; onChange: (v: string) => void; variant?: 'ui' | 'pixel' }) {
  const providers = useStore((s) => s.providers);
  const cfg = reasoningFor(providers, model);
  if (!cfg || !availableTiers(cfg).length) {
    return (
      <span className={`effort none ${variant}`} {...tip('思考程度 · 不适用', cfg?.detected?.reliable ? '检测结果：这个模型不接受思考档位参数，不会发送。' : '这个模型还没有思考档位，不会发送思考参数。可在「模型配置」里点「检测思考档位」确认。', undefined, 'above')} data-testid="effort-none">
        思考 · 不适用
      </span>
    );
  }
  const av = availableTiers(cfg);
  const shown = resolveTier(cfg, value) ?? av[0];
  const idx = TIERS.indexOf(shown);
  const last = TIERS.length - 1;
  const def = defaultTier(cfg);
  const defIdx = def ? TIERS.indexOf(def) : -1;
  const now = `当前：${TIER_LABEL[shown]}${value === 'default' ? '（模型默认）' : ''}`;
  const source = cfg.detected?.reliable ? '对应关系来自对当前模型的检测' : cfg.detected ? '这个服务不校验档位，对应关系按模型名推测' : '对应关系按模型名推测，还没检测（可在「模型服务」里点「检测思考档位」）';
  const desc = `模型想得越深结果越好，但更慢、更费 token。${tierHint(cfg)}。${source}。${now}`;
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
          aria-valuetext={TIER_LABEL[shown]}
          onChange={(e) => {
            const i = Number(e.target.value);
            // greyed positions: move on to the next level this model has, in the direction of the drag
            const dir = i >= idx ? 1 : -1;
            let t: Tier | undefined;
            for (let j = i; j >= 0 && j <= last && !t; j += dir) if (av.includes(TIERS[j])) t = TIERS[j];
            t = t ?? nearestTier(cfg, TIERS[i])!;
            if (t === shown) return;
            onChange(t === def ? 'default' : t);
          }}
          style={{ ['--pct' as string]: `${(idx / last) * 100}%` }}
        />
        {TIERS.map((t, i) => !av.includes(t) && <i key={t} className="effort-off" style={{ left: `${(i / last) * 100}%` }} />)}
        {defIdx >= 0 && <i className="effort-def" style={{ left: `calc(${(defIdx / last) * 100}% )` }} />}
      </span>
      <b className={`effort-v l${Math.round((idx / last) * 4)}`}>{TIER_LABEL[shown]}</b>
    </span>
  );
}
