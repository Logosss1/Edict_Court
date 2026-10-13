// 运行策略: budgets, 封驳 limits, approval gates, 朝堂议政, parallelism and the compression base.
// (Permission mode lives on 权限与审批, the theme on 外观与通知.)
import { useStore, openSettings } from '../../store';
import { call } from '../../api';
import { fmtTokens } from '../../common/format';
import type { Settings, Tier } from '../../../shared/types';
import { Page, Row, Sec, Toggle } from '../ui';
import { NumField } from './numField';
import './runPolicy.css';

const TIERS: { id: Tier; label: string; desc: string }[] = [
  { id: 'solo', label: 'Solo', desc: '独相一人' },
  { id: 'lite', label: 'Court Lite', desc: '简化三省' },
  { id: 'full', label: 'Full Court', desc: '完整三省六部' },
];

export function RunPolicyPage() {
  const s = useStore((st) => st.settings);
  const up = (p: Partial<Settings>) => call('updateSettings', p);
  const budgets = s.budgets ?? { solo: 0, lite: 0, full: 0 };
  const rc = { ...{ lite: true, full: true, maxSupplement: 1 }, ...s.requirementCheck };
  return (
    <Page icon="zap" title="运行策略" lead="每道旨意花多少、走几道审批、几位官员同时开工。预算和封驳上限在下旨时定下，其余改动立即生效。" testid="settings-runtime">
      <div className="runp">
        <Sec title="预算" note="· 用到上限时旨意会停下，等你决定是否追加">
          <div className="runp-tiers">
            {TIERS.map((t) => (
              <div key={t.id} className="runp-tier">
                <div className="runp-tier-h"><b>{t.label}</b><span className="muted">{t.desc}</span></div>
                <NumField value={budgets[t.id]} min={0} step={10000} width={110} unit="tokens" label={`${t.label} 单旨 Token 预算`} testid={`budget-${t.id}`} onCommit={(v) => void up({ budgets: { ...budgets, [t.id]: v } })} />
                <div className="runp-tier-s">{budgets[t.id] ? `约 ${fmtTokens(budgets[t.id])}` : '不限'}</div>
              </div>
            ))}
          </div>
          <Row label="单旨费用上限" desc="按模型单价估算的美元费用；0 = 不限">
            <span className="runp-usd">$</span>
            <NumField value={s.maxCostUsd} min={0} step={0.1} label="单旨费用上限（美元）" testid="max-cost" onCommit={(v) => void up({ maxCostUsd: v })} />
          </Row>
        </Sec>

        <Sec title="门下封驳" note="· 门下省驳回方案或成果的次数上限，超过就升级为皇上裁决">
          <Row label="Court Lite 封驳上限" desc="简化三省：门下只审方案（默认 1 次）">
            <NumField value={s.maxRejections?.lite} min={0} max={10} unit="次" label="Court Lite 封驳上限" testid="max-rej-lite" onCommit={(v) => void up({ maxRejections: { ...s.maxRejections, lite: v } })} />
          </Row>
          <Row label="Full Court 封驳上限" desc="完整三省六部：方案与成果都要过门下（默认 3 次）">
            <NumField value={s.maxRejections?.full} min={0} max={10} unit="次" label="Full Court 封驳上限" testid="max-rej-full" onCommit={(v) => void up({ maxRejections: { ...s.maxRejections, full: v } })} />
          </Row>
        </Sec>

        <Sec title="审批门" note="· 旨意在哪些关口停下来等你御批">
          <Row label="Full Court：方案御览" desc="中书省方案过了门下后先呈给你，可以朱笔涂改再准奏">
            <Toggle on={!!s.planGate?.full} onChange={(v) => void up({ planGate: { ...s.planGate, full: v } })} label="Full Court 方案御览" testid="plan-gate-full" />
          </Row>
          <Row label="Court Lite：方案御览" desc="简化三省也先给你过目方案；关掉则门下准奏后直接开工">
            <Toggle on={!!s.planGate?.lite} onChange={(v) => void up({ planGate: { ...s.planGate, lite: v } })} label="Court Lite 方案御览" testid="plan-gate-lite" />
          </Row>
          <Row label="回奏须御批结案" desc="尚书省回奏后由你确认才结案；关掉则回奏后自动结案">
            <Toggle on={!!s.finalGate} onChange={(v) => void up({ finalGate: v })} label="回奏须御批结案" testid="final-gate" />
          </Row>
        </Sec>

        <Sec title="需求对照" note="· 中书省先写需求说明，六部做完后门下省逐条检查，满足的要有证据">
          <Row label="Full Court：需求说明与对照检查" desc="规划时列出目标、不做的事和逐条验收标准；执行完对照检查，没做到的交回原部补办">
            <Toggle on={s.requirementCheck?.full !== false} onChange={(v) => void up({ requirementCheck: { ...rc, full: v } })} label="Full Court 需求说明与对照检查" testid="req-check-full" />
          </Row>
          <Row label="Court Lite：需求说明与对照检查" desc="多一次规划内容和一次检查，会多花一些 token">
            <Toggle on={s.requirementCheck?.lite !== false} onChange={(v) => void up({ requirementCheck: { ...rc, lite: v } })} label="Court Lite 需求说明与对照检查" testid="req-check-lite" />
          </Row>
          <Row label="补办轮数" desc="检查出没做到的需求，最多交回补办几轮（0–3）；补完仍没做到的，御批时标为成果存疑">
            <NumField value={rc.maxSupplement} min={0} max={3} unit="轮" label="补办轮数" testid="req-check-rounds" onCommit={(v) => void up({ requirementCheck: { ...rc, maxSupplement: v } })} />
          </Row>
        </Sec>

        <Sec title="朝堂议政">
          <Row label="Full Court 默认规划前议政" desc="中书省动笔前，相关官员先在朝堂议几轮，结论交给中书；下旨时也可以单独勾选">
            <Toggle on={!!s.debateBeforePlan} onChange={(v) => void up({ debateBeforePlan: v })} label="Full Court 默认规划前议政" testid="debate-before-plan" />
          </Row>
          <Row label="议政轮数" desc="每位官员每轮发言一次，1–5 轮">
            <NumField value={s.debateRounds} min={1} max={5} unit="轮" label="议政轮数" testid="debate-rounds" onCommit={(v) => void up({ debateRounds: v })} />
          </Row>
        </Sec>

        <Sec title="执行">
          <Row label="六部并行度" desc="没有依赖关系的子任务最多几个同时开工（1–6）；同一道旨意里同一时刻只有一个在写文件">
            <NumField value={s.parallelism} min={1} max={6} label="六部并行度" testid="parallelism" onCommit={(v) => void up({ parallelism: v })} />
          </Row>
          <Row label="压缩阈值基准" desc={<>上下文超过它（与模型窗口取小者）的 60% 时，滚动压缩较早的对话；当前最晚约 {fmtTokens(Math.round((s.contextWindowTokens ?? 0) * 0.6))} 触发</>}>
            <NumField value={s.contextWindowTokens} min={8000} step={1000} width={96} unit="tokens" label="压缩阈值基准（tokens）" testid="context-window" onCommit={(v) => void up({ contextWindowTokens: v })} />
          </Row>
        </Sec>

        <div className="runp-moved">
          权限模式在 <button className="link" onClick={() => openSettings('permissions')}>权限与审批</button>，主题在 <button className="link" onClick={() => openSettings('appearance')}>外观与通知</button>。
        </div>
      </div>
    </Page>
  );
}
