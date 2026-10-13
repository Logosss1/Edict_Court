// 定时旨意 (2.1): edicts the emperor has Edict issue at set times, with what each may do; officials' proposals
// wait here (and in 待办) for his word. Edict issues them while it runs: closing the window is fine, quitting is not.
import { useEffect, useMemo, useState } from 'react';
import { useStore, setUI, toast, openTaskTab } from '../store';
import { call } from '../api';
import { Icon } from '../common/Icon';
import { StateChip, fmtAgo } from '../common/format';
import { ModelSelect, useModelName } from '../common/ModelPick';
import { askConfirm } from '../common/Prompt';
import { tip } from '../common/Tip';
import { Toggle } from '../settings/ui';
import { AGENT_MAP, TIER_SHORT } from '../../shared/court';
import { BUILTIN_DESIGN_ID } from '../../shared/design';
import { COURT_HOUR, PERMISSION_TEXT, WEEKDAY, describeRule, describeStop, fmtDate, fmtDateTime, fmtTime, isLive, permissionsFor, ruleProblem, upcoming } from '../../shared/schedule';
import type { EdictSchedule, ModelRef, ScheduleRule, SchedulePermission, ScheduleStop, Tier } from '../../shared/types';

type Kind = ScheduleRule['kind'];
const KINDS: { id: Kind; label: string }[] = [
  { id: 'daily', label: '每天' },
  { id: 'weekly', label: '每周' },
  { id: 'interval', label: '每隔几小时' },
  { id: 'court', label: '每次早朝' },
  { id: 'once', label: '指定一次' },
];
/** Monday first */
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];
const OUTCOME: Record<string, { label: string; cls: string }> = { started: { label: '已下旨', cls: 'ok' }, skipped: { label: '跳过', cls: 'warn' }, failed: { label: '没下成', cls: 'danger' } };

interface Form {
  id?: string;
  title: string;
  text: string;
  workspace: string | null;
  tier: Tier;
  designId: string;
  model: ModelRef | null;
  kind: Kind;
  time: string;
  days: number[];
  hours: number;
  onceAt: string; // datetime-local
  permission: SchedulePermission;
  stopKind: ScheduleStop['kind'];
  stopN: number;
  stopUntil: string; // date
  missed: 'once' | 'skip';
  enabled: boolean;
}

const pad = (n: number) => String(n).padStart(2, '0');
const localInput = (at: number) => {
  const d = new Date(at);
  return `${fmtDate(at)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

function blank(workspace: string | null): Form {
  return {
    title: '', text: '', workspace, tier: 'lite', designId: BUILTIN_DESIGN_ID, model: null, kind: 'daily', time: '09:00', days: [1, 2, 3, 4, 5], hours: 6,
    onceAt: localInput(Date.now() + 3_600_000), permission: 'readonly', stopKind: 'never', stopN: 10, stopUntil: fmtDate(Date.now() + 30 * 86_400_000), missed: 'once', enabled: true,
  };
}

function toForm(s: EdictSchedule): Form {
  const r = s.rule;
  return {
    ...blank(s.workspace), id: s.id, title: s.title, text: s.text, tier: s.tier, designId: s.designId ?? BUILTIN_DESIGN_ID, model: s.model ?? null, kind: r.kind,
    ...(r.kind === 'daily' ? { time: r.time } : r.kind === 'weekly' ? { time: r.time, days: r.days } : r.kind === 'interval' ? { hours: r.hours } : r.kind === 'once' ? { onceAt: localInput(r.at) } : {}),
    permission: s.permission, stopKind: s.stop.kind, ...(s.stop.kind === 'count' ? { stopN: s.stop.n } : s.stop.kind === 'until' ? { stopUntil: fmtDate(s.stop.at) } : {}),
    missed: s.missed, enabled: s.proposal ? true : s.enabled,
  };
}

function ruleOf(f: Form): ScheduleRule {
  switch (f.kind) {
    case 'daily':
      return { kind: 'daily', time: f.time };
    case 'weekly':
      return { kind: 'weekly', days: f.days, time: f.time };
    case 'interval':
      return { kind: 'interval', hours: Number(f.hours) };
    case 'court':
      return { kind: 'court' };
    case 'once':
      return { kind: 'once', at: new Date(f.onceAt).getTime() };
  }
}

function stopOf(f: Form): ScheduleStop {
  if (f.stopKind === 'count') return { kind: 'count', n: Math.max(1, Math.floor(Number(f.stopN) || 1)) };
  // until the end of that day
  if (f.stopKind === 'until') return { kind: 'until', at: new Date(`${f.stopUntil}T23:59:59`).getTime() };
  return { kind: 'never' };
}

const statusOf = (s: EdictSchedule): { label: string; cls: string } =>
  s.proposal ? { label: '待准奏', cls: 'warn' } : s.ended ? { label: '已结束', cls: '' } : isLive(s) ? { label: '启用中', cls: 'on' } : { label: '已停用', cls: '' };

export function Schedules() {
  const list = useStore((s) => s.schedules);
  const focus = useStore((s) => s.ui.scheduleFocus);
  const workspace = useStore((s) => s.workspace);
  const [sel, setSel] = useState<string | null>(focus ?? list[0]?.id ?? null);
  const [form, setForm] = useState<Form | null>(null);
  useEffect(() => {
    if (!focus) return;
    setSel(focus);
    setForm(null);
    setUI({ scheduleFocus: null });
  }, [focus]);
  const cur = list.find((s) => s.id === sel) ?? null;
  const groups: { title: string; items: EdictSchedule[] }[] = [
    { title: '官员的提议', items: list.filter((s) => s.proposal) },
    { title: '已排定', items: list.filter((s) => !s.proposal && !s.ended) },
    { title: '已结束', items: list.filter((s) => !s.proposal && s.ended) },
  ];
  const toggle = (s: EdictSchedule, on: boolean) => call('scheduleSetEnabled', s.id, on).catch((e) => toast((e as Error).message, 'warn'));

  return (
    <div className="panel split-panel sch-panel" data-testid="schedules-panel">
      <div className="split-list">
        <div className="panel-head">
          <h2><Icon name="clock" size={18} /> 定时旨意</h2>
          <span style={{ flex: 1 }} />
          <button className="btn sm primary" onClick={() => setForm(blank(workspace))} data-testid="sch-new"><Icon name="plus" size={12} /> 新建</button>
        </div>
        <p className="muted small pad">到点自动下旨，比如每天早上跑一遍测试并汇报。Edict 开着才会按时下旨：关掉窗口不要紧，退出 Edict 就不会。</p>
        {!list.length && <div className="muted small pad" data-testid="sch-empty">还没有定时旨意。点「新建」排一道，或者等官员上疏提议。</div>}
        {groups.map((g) =>
          g.items.length ? (
            <div key={g.title} className="sch-group">
              <div className="sch-group-h">{g.title} <span className="muted">{g.items.length}</span></div>
              {g.items.map((s) => {
                const st = statusOf(s);
                return (
                  <div key={s.id} className={`list-item sch-row ${sel === s.id && !form ? 'on' : ''} ${isLive(s) || s.proposal ? '' : 'off'}`} onClick={() => { setSel(s.id); setForm(null); }} data-testid={`sch-item-${s.id}`}>
                    <div className="row-gap">
                      <b className="ellipsis">{s.title}</b>
                      <span style={{ flex: 1 }} />
                      {!s.proposal && !s.ended && (
                        <span onClick={(e) => e.stopPropagation()}>
                          <Toggle on={s.enabled} onChange={(v) => void toggle(s, v)} label={s.enabled ? '停用' : '启用'} testid={`sch-toggle-${s.id}`} />
                        </span>
                      )}
                      {(s.proposal || s.ended) && <span className={`chip chip-sm ${st.cls}`}>{st.label}</span>}
                    </div>
                    <div className="muted small ellipsis">
                      {describeRule(s.rule)} · {PERMISSION_TEXT[s.permission].label}
                      {isLive(s) && s.nextAt ? ` · 下次 ${fmtDateTime(s.nextAt).slice(5)}` : ''}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : null,
        )}
      </div>
      <div className="split-detail">
        {form ? (
          <ScheduleForm initial={form} onClose={() => setForm(null)} onSaved={(id) => { setForm(null); setSel(id); }} />
        ) : cur ? (
          <ScheduleDetail s={cur} onEdit={() => setForm(toForm(cur))} onDeleted={() => setSel(null)} />
        ) : (
          <div className="sch-intro card">
            <h3><Icon name="clock" size={16} /> 让官员按时办事</h3>
            <ul className="small">
              <li>时间可以是每天、每周几、每隔几小时、每次早朝（每天 {fmtTime(COURT_HOUR, 0)}），或者指定某个时间办一次。</li>
              <li>排定时就定好它能做什么：只读、每次改动都问你，或者在旨意自己的 git 工作树里放手改。</li>
              <li>Edict 没开或电脑睡眠时错过的时间，回来后补跑一次（不会每个错过的时间都跑），也可以设成跳过。</li>
              <li>上一次还没办完时，这一次跳过并记一笔。</li>
              <li>官员觉得某件事值得定期做，会上疏提议；你准奏后才生效。</li>
            </ul>
            <button className="btn primary" onClick={() => setForm(blank(workspace))} data-testid="sch-new-2"><Icon name="plus" size={12} /> 排一道定时旨意</button>
          </div>
        )}
      </div>
    </div>
  );
}

function ScheduleDetail({ s, onEdit, onDeleted }: { s: EdictSchedule; onEdit: () => void; onDeleted: () => void }) {
  const tasks = useStore((st) => st.tasks);
  const designs = useStore((st) => st.designs);
  const card = useStore((st) => st.approvals.find((a) => a.status === 'pending' && a.tool === `schedule:${s.id}`));
  const modelName = useModelName();
  const [busy, setBusy] = useState(false);
  const st = statusOf(s);
  const next = useMemo(() => (isLive(s) && s.nextAt ? [s.nextAt, ...upcoming(s.rule, s.nextAt, 2, s.nextAt)] : []), [s]);
  const running = s.lastTaskId ? tasks.find((t) => t.id === s.lastTaskId && !['Done', 'Cancelled', 'Failed'].includes(t.state)) : undefined;
  const design = s.designId && s.designId !== BUILTIN_DESIGN_ID ? designs.find((d) => d.id === s.designId) : undefined;
  const fromId = s.origin.by === 'official' ? s.origin.taskId : undefined;
  const from = fromId ? tasks.find((t) => t.id === fromId) : undefined;
  const runNow = async () => {
    setBusy(true);
    try {
      const r = await call<{ taskId?: string }>('scheduleRunNow', s.id);
      toast('已下旨', 'success', r.taskId ? { label: '查看', run: () => openTaskTab(r.taskId!) } : undefined);
    } catch (e) {
      toast((e as Error).message, 'warn');
    }
    setBusy(false);
  };
  const remove = async () => {
    if (!(await askConfirm(`删除「${s.title}」？`, s.proposal ? '这条提议会作废。' : '以后不再按时下旨。已经下的旨意不受影响。', { ok: '删除', danger: true }))) return;
    try {
      await call('scheduleDelete', s.id);
      onDeleted();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  const decide = (choice: 'approve' | 'paused' | 'deny') => card && call('decideApproval', card.id, choice !== 'deny', choice).then(() => toast(choice === 'approve' ? '已准奏，按时下旨' : choice === 'paused' ? '已排上，先停用' : '提议作废', 'success'), (e) => toast((e as Error).message, 'error'));

  return (
    <div className="sch-detail" data-testid="sch-detail">
      <div className="card">
        <div className="row-gap">
          <h3 className="ellipsis" style={{ margin: 0 }}>{s.title}</h3>
          <span className={`chip chip-sm ${st.cls}`} data-testid="sch-status">{st.label}</span>
          <span style={{ flex: 1 }} />
          {!s.proposal && (
            <button className="btn sm" disabled={busy || !!running} onClick={runNow} {...tip('立即执行一次', running ? '上一次还没办完' : '现在就下这道旨意，平常的时间不变')} data-testid="sch-run-now"><Icon name="play" size={12} /> 立即执行一次</button>
          )}
          <button className="btn sm primary" onClick={onEdit} data-testid="sch-edit"><Icon name="edit" size={12} /> 修改</button>
          <button className="btn sm" onClick={remove} data-testid="sch-delete"><Icon name="trash" size={12} /></button>
        </div>
        {s.proposal && s.origin.by === 'official' && (
          <div className="sch-proposal" data-testid="sch-proposal">
            <div>
              <b>{AGENT_MAP[s.origin.agentId]?.emoji} {AGENT_MAP[s.origin.agentId]?.name ?? s.origin.agentId}上疏提议</b>
              {s.origin.reason && <span>：{s.origin.reason}</span>}
            </div>
            {from && <div className="muted small">提议自旨意 <button className="link small" onClick={() => openTaskTab(from.id)}>{from.title}</button></div>}
            <div className="row-gap" style={{ marginTop: 8 }}>
              <button className="btn sm primary" disabled={!card} onClick={() => decide('approve')} data-testid="sch-approve">准奏，按此排定</button>
              <button className="btn sm" disabled={!card} onClick={() => decide('paused')} data-testid="sch-paused">排上，但先停用</button>
              <button className="btn sm" disabled={!card} onClick={() => decide('deny')} data-testid="sch-deny">不必</button>
            </div>
            <div className="muted small" style={{ marginTop: 6 }}>也可以先「修改」，保存即准奏。</div>
          </div>
        )}
        {s.ended && <div className="muted small" style={{ marginTop: 6 }}>已结束：{s.ended}</div>}
        <table className="table small sch-kv">
          <tbody>
            <tr><th>每次下的旨意</th><td className="pre">{s.text}</td></tr>
            <tr><th>时间</th><td data-testid="sch-rule">{describeRule(s.rule)}</td></tr>
            {next.length > 0 && <tr><th>接下来</th><td data-testid="sch-next">{next.map((t) => fmtDateTime(t).slice(5)).join(' · ')}</td></tr>}
            <tr><th>权限</th><td><b>{PERMISSION_TEXT[s.permission].label}</b> <span className="muted">{PERMISSION_TEXT[s.permission].hint}</span></td></tr>
            <tr><th>工作区</th><td className="mono">{s.workspace ?? '（不用工作区）'}</td></tr>
            <tr><th>模式</th><td>{design ? `协同设计「${design.name}」` : TIER_SHORT[s.tier]}{s.model ? ` · ${modelName(s.model)}` : ''}</td></tr>
            <tr><th>停止</th><td>{describeStop(s.stop)}</td></tr>
            <tr><th>错过时</th><td>{s.missed === 'once' ? '回来后补跑一次' : '跳过'}</td></tr>
            <tr><th>已执行</th><td>{s.runs} 次{s.lastRunAt ? `，上次 ${fmtDateTime(s.lastRunAt)}` : ''}</td></tr>
          </tbody>
        </table>
      </div>
      <div className="card">
        <h4>执行记录</h4>
        {!s.history.length && <div className="muted small">还没有执行过。</div>}
        <div className="sch-history" data-testid="sch-history">
          {s.history.map((h, i) => {
            const t = h.taskId ? tasks.find((x) => x.id === h.taskId) : undefined;
            const o = OUTCOME[h.outcome];
            return (
              <div key={`${h.at}-${i}`} className="sch-h-row">
                <span className="muted small" title={fmtDateTime(h.at)}>{fmtDateTime(h.at).slice(5)}</span>
                <span className={`chip chip-sm ${o.cls}`}>{o.label}</span>
                {t && h.outcome === 'started' && (
                  <>
                    <button className="link small ellipsis" onClick={() => openTaskTab(t.id)}>{t.title}</button>
                    <StateChip state={t.state} small />
                  </>
                )}
                {h.note && <span className="muted small ellipsis" title={h.note}>{h.note}</span>}
                <span style={{ flex: 1 }} />
                <span className="muted small">{fmtAgo(h.at)}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function ScheduleForm({ initial, onClose, onSaved }: { initial: Form; onClose: () => void; onSaved: (id: string) => void }) {
  const [f, setF] = useState<Form>(initial);
  const [saving, setSaving] = useState(false);
  const designs = useStore((s) => s.designs.filter((d) => !d.native && d.status === 'active'));
  const open = useStore((s) => s.workspace);
  const set = (p: Partial<Form>) => setF((x) => ({ ...x, ...p }));
  const rule = ruleOf(f);
  const problem = ruleProblem(rule, Date.now());
  const preview = problem ? [] : upcoming(rule, Date.now(), 3, f.kind === 'interval' ? Date.now() : undefined);
  const perms = permissionsFor(f.tier);
  useEffect(() => {
    if (!perms.includes(f.permission)) set({ permission: 'ask' });
  }, [f.tier]); // eslint-disable-line react-hooks/exhaustive-deps
  const pick = async () => {
    const dir = await call<string | null>('pickFolder', '选择定时旨意的工作区');
    if (dir) set({ workspace: dir });
  };
  const save = async () => {
    if (!f.text.trim()) return toast('先写好每次要下的旨意', 'warn');
    if (problem) return toast(problem, 'warn');
    setSaving(true);
    try {
      const s = await call<EdictSchedule>('scheduleSave', {
        id: f.id, title: f.title, text: f.text, workspace: f.workspace, tier: f.tier, designId: f.tier !== 'solo' && f.designId !== BUILTIN_DESIGN_ID ? f.designId : undefined, model: f.model,
        rule, permission: f.permission, stop: stopOf(f), missed: f.missed, enabled: f.enabled,
      });
      toast(f.id ? '已保存' : `已排定：${describeRule(s.rule)}`, 'success');
      onSaved(s.id);
    } catch (e) {
      toast((e as Error).message, 'error');
    }
    setSaving(false);
  };
  const toggleDay = (d: number) => set({ days: f.days.includes(d) ? f.days.filter((x) => x !== d) : [...f.days, d] });

  return (
    <div className="card sch-form" data-testid="sch-form">
      <div className="row-gap">
        <h3 style={{ margin: 0 }}>{f.id ? '修改定时旨意' : '新的定时旨意'}</h3>
        <span style={{ flex: 1 }} />
        <button className="btn sm" onClick={onClose}>取消</button>
        <button className="btn sm primary" disabled={saving} onClick={save} data-testid="sch-save">保存</button>
      </div>

      <div className="form-row">
        <label>每次下的旨意</label>
        <textarea className="input" rows={4} value={f.text} placeholder="例如：跑一遍全部测试，把失败的列出来，说明可能的原因" onChange={(e) => set({ text: e.target.value })} data-testid="sch-text" />
      </div>
      <div className="form-row">
        <label>名称（可不填，默认取旨意开头）</label>
        <input className="input" value={f.title} maxLength={40} onChange={(e) => set({ title: e.target.value })} data-testid="sch-title" />
      </div>

      <div className="form-row">
        <label>时间</label>
        <div className="seg sch-kinds">
          {KINDS.map((k) => <button key={k.id} type="button" className={f.kind === k.id ? 'on' : ''} onClick={() => set({ kind: k.id })} data-testid={`sch-kind-${k.id}`}>{k.label}</button>)}
        </div>
        <div className="row-gap sch-when">
          {f.kind === 'weekly' && (
            <span className="sch-days">
              {WEEK_ORDER.map((d) => <button key={d} type="button" className={`pill ${f.days.includes(d) ? 'on' : ''}`} onClick={() => toggleDay(d)} data-testid={`sch-day-${d}`}>周{WEEKDAY[d]}</button>)}
            </span>
          )}
          {(f.kind === 'daily' || f.kind === 'weekly') && <input type="time" className="input sm" value={f.time} onChange={(e) => set({ time: e.target.value })} data-testid="sch-time" />}
          {f.kind === 'interval' && (
            <>
              每隔 <input type="number" className="input sm-num" min={1} max={720} value={f.hours} onChange={(e) => set({ hours: Number(e.target.value) })} data-testid="sch-hours" /> 小时
            </>
          )}
          {f.kind === 'court' && <span className="muted small">每天 {fmtTime(COURT_HOUR, 0)}，和朝堂的早朝同时</span>}
          {f.kind === 'once' && <input type="datetime-local" className="input sm" value={f.onceAt} onChange={(e) => set({ onceAt: e.target.value })} data-testid="sch-once" />}
        </div>
        <div className={`small ${problem ? 'warn-text' : 'muted'}`} data-testid="sch-preview">
          {problem ?? `接下来：${preview.map((t) => fmtDateTime(t).slice(5)).join(' · ')}`}
        </div>
      </div>

      <div className="form-row">
        <label>能做什么（排定时就定好，到点没人看着也照此办）</label>
        <div className="sch-perms">
          {(['readonly', 'ask', 'worktree'] as SchedulePermission[]).map((p) => {
            const ok = perms.includes(p);
            return (
              <label key={p} className={`sch-perm ${f.permission === p ? 'on' : ''} ${ok ? '' : 'off'}`} data-testid={`sch-perm-${p}`}>
                <input type="radio" name="sch-perm" disabled={!ok} checked={f.permission === p} onChange={() => set({ permission: p })} />
                <span>
                  <b>{PERMISSION_TEXT[p].label}</b>
                  <span className="muted small">{ok ? PERMISSION_TEXT[p].hint : 'Solo 没有独立工作树，选不了这一项'}</span>
                </span>
              </label>
            );
          })}
        </div>
      </div>

      <div className="form-row">
        <label>工作区</label>
        <div className="row-gap">
          <span className="mono small ellipsis sch-ws" title={f.workspace ?? ''} data-testid="sch-ws">{f.workspace ?? '（不用工作区：只能联网查资料、写结论）'}</span>
          <span style={{ flex: 1 }} />
          {open && f.workspace !== open && <button className="btn sm" onClick={() => set({ workspace: open })}>用当前打开的</button>}
          <button className="btn sm" onClick={pick}>选择文件夹…</button>
          {f.workspace && <button className="btn sm" onClick={() => set({ workspace: null })}>不用</button>}
        </div>
        <span className="muted small">到点时不管 Edict 打开的是哪个文件夹，都在这里办。</span>
      </div>

      <div className="sch-grid">
        <div className="form-row">
          <label>模式</label>
          <select className="input" value={f.tier} onChange={(e) => set({ tier: e.target.value as Tier })} data-testid="sch-tier">
            <option value="solo">Solo 单 Agent</option>
            <option value="lite">Court Lite</option>
            <option value="full">Full Court</option>
          </select>
        </div>
        {f.tier !== 'solo' && designs.length > 0 && (
          <div className="form-row">
            <label>协同设计</label>
            <select className="input" value={f.designId} onChange={(e) => set({ designId: e.target.value })}>
              <option value={BUILTIN_DESIGN_ID}>三省六部（内置）</option>
              {designs.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </div>
        )}
        <div className="form-row">
          <label>模型</label>
          <ModelSelect value={f.model} onChange={(m) => set({ model: m })} allowDefault="跟随设置" className="input" />
        </div>
        <div className="form-row">
          <label>停止</label>
          <div className="row-gap">
            <select className="input sm" value={f.stopKind} onChange={(e) => set({ stopKind: e.target.value as ScheduleStop['kind'] })} data-testid="sch-stop">
              <option value="never">一直执行</option>
              <option value="count">执行几次后停</option>
              <option value="until">到某天为止</option>
            </select>
            {f.stopKind === 'count' && <><input type="number" className="input sm-num" min={1} value={f.stopN} onChange={(e) => set({ stopN: Number(e.target.value) })} data-testid="sch-stop-n" /> 次</>}
            {f.stopKind === 'until' && <input type="date" className="input sm" value={f.stopUntil} onChange={(e) => set({ stopUntil: e.target.value })} />}
          </div>
        </div>
        <div className="form-row">
          <label>错过时（Edict 没开或电脑睡眠）</label>
          <select className="input" value={f.missed} onChange={(e) => set({ missed: e.target.value as 'once' | 'skip' })} data-testid="sch-missed">
            <option value="once">回来后补跑一次</option>
            <option value="skip">跳过</option>
          </select>
        </div>
        <div className="form-row">
          <label>启用</label>
          <Toggle on={f.enabled} onChange={(v) => set({ enabled: v })} testid="sch-enabled" />
        </div>
      </div>
    </div>
  );
}
