// 思考程度 slider — the ladder is the selected model's own levels (detected from the service where possible).
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
      <span className={`effort none ${variant}`} {...tip('思考程度 · 不适用', cfg?.detected?.reliable ? '检测结果：这个模型不接受思考档位参数，不会发送。' : '这个模型还没有思考档位，不会发送思考参数。可在「模型配置」里点「检测思考档位」确认。', undefined, 'above')} data-testid="effort-none">
        思考 · 不适用
      </span>
    );
  }
  const shown = clampLevel(cfg, value)!;
  const idx = Math.max(0, cfg.levels.indexOf(shown));
  const last = cfg.levels.length - 1;
  const defIdx = cfg.levels.indexOf(cfg.default);
  const now = `当前：${levelLabel(shown)}${value === 'default' ? '（模型默认）' : ''}`;
  const source = cfg.detected?.reliable ? '档位来自对当前模型的检测' : cfg.detected ? '这个服务不校验档位，档位按模型名推测' : '档位按模型名推测，还没检测（可在「模型配置」里点「检测思考档位」）';
  const desc = `模型想得越深结果越好，但更慢、更费 token。${source}。${now}`;
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
