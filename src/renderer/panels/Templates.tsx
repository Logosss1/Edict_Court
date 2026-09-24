// 旨库 · Template Library
import { useState } from 'react';
import { useStore, selectTask, toast } from '../store';
import { call } from '../api';
import { Icon } from '../common/Icon';
import { fmtCost, fmtTokens } from '../common/format';
import { TIER_SHORT } from '../../shared/court';
import type { Template, Tier } from '../../shared/types';
import { draftToComposer } from '../workbench/AgentPane';

export function Templates() {
  const templates = useStore((s) => s.templates);
  const [cat, setCat] = useState('全部');
  const [sel, setSel] = useState<Template | null>(null);
  const cats = ['全部', ...new Set(templates.map((t) => t.cat))];
  return (
    <div className="panel">
      <div className="panel-head">
        <h2><Icon name="book" size={18} /> 旨库</h2>
        <div className="tpl-cats">
          {cats.map((c) => (
            <button key={c} className={`pill ${cat === c ? 'on' : ''}`} onClick={() => setCat(c)}>{c}</button>
          ))}
        </div>
      </div>
      {sel ? (
        <TemplateForm t={sel} onBack={() => setSel(null)} />
      ) : (
        <div className="tpl-grid">
          {templates.filter((t) => cat === '全部' || t.cat === cat).map((t) => (
            <div key={t.id} className="tpl-card" onClick={() => setSel(t)}>
              <div className="tpl-top"><span className="tpl-icon">{t.icon}</span><b>{t.name}</b><span className="tier-tag">{TIER_SHORT[t.tier]}</span></div>
              <div className="muted small">{t.desc}</div>
              <div className="tpl-foot">{t.depts.map((d) => <span key={d} className="chip chip-sm">{d}</span>)}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function TemplateForm({ t, onBack }: { t: Template; onBack: () => void }) {
  const [vals, setVals] = useState<Record<string, string>>(Object.fromEntries(t.params.map((p) => [p.key, p.default ?? (p.options?.[0] ?? '')])));
  const [tier, setTier] = useState<Tier>(t.tier);
  const [est, setEst] = useState<{ tokens: number; costUsd: number } | null>(null);
  const cmd = t.command.replace(/\{(\w+)\}/g, (_, k) => vals[k] ?? '');
  const missing = t.params.filter((p) => p.required && !vals[p.key]?.trim());
  const estimate = () => call('estimate', cmd, tier, null).then(setEst);
  const issue = async () => {
    if (missing.length) return toast(`请填写：${missing.map((m) => m.label).join('、')}`, 'warn');
    try {
      const r = await call('submit', { text: cmd, tier, multiAgent: tier !== 'solo', forceEdict: true, templateId: t.id });
      if (r.kind === 'task') {
        selectTask(r.taskId);
        toast('旨意已下达', 'success');
      }
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  return (
    <div className="card tpl-form">
      <button className="link" onClick={onBack}>← 返回旨库</button>
      <h3>{t.icon} {t.name}</h3>
      <p className="muted">{t.desc}</p>
      {t.params.map((p) => (
        <div key={p.key} className="form-row">
          <label>{p.label}{p.required && <span style={{ color: '#d0453a' }}> *</span>}</label>
          {p.type === 'select' ? (
            <select className="input" value={vals[p.key]} onChange={(e) => setVals({ ...vals, [p.key]: e.target.value })}>{p.options!.map((o) => <option key={o}>{o}</option>)}</select>
          ) : p.type === 'textarea' ? (
            <textarea className="input" rows={3} value={vals[p.key]} onChange={(e) => setVals({ ...vals, [p.key]: e.target.value })} />
          ) : (
            <input className="input" value={vals[p.key]} onChange={(e) => setVals({ ...vals, [p.key]: e.target.value })} />
          )}
        </div>
      ))}
      <div className="form-row">
        <label>协同档位</label>
        <select className="input" value={tier} onChange={(e) => setTier(e.target.value as Tier)}>
          <option value="solo">Solo 单 Agent</option>
          <option value="lite">Court Lite</option>
          <option value="full">Full Court</option>
        </select>
      </div>
      <div className="preview-edict"><div className="muted small">旨意预览</div>{cmd}</div>
      <div className="row-gap">
        <button className="btn" onClick={estimate}>预估费用</button>
        {est && <span className="muted">约 {fmtTokens(est.tokens)} tokens · {fmtCost(est.costUsd)}</span>}
        <span style={{ flex: 1 }} />
        <button className="btn" onClick={() => draftToComposer(cmd)}>放入输入框</button>
        <button className="btn primary" onClick={issue}><Icon name="send" size={13} /> 下旨</button>
      </div>
    </div>
  );
}
