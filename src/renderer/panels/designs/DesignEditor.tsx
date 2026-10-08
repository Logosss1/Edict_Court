// 协同设计编辑器 — edit a user design as a draft (flow canvas, forms, court layout, JSON) and save it
// as a new immutable version. The built-in 三省六部 is never edited here: it is copied first.
import { useEffect, useMemo, useRef, useState } from 'react';
import { AGENT_MAP } from '../../../shared/court';
import { AVATARS, PHASE_LABEL, validateDesign, type RoleSpec, type StepSpec, type StepType } from '../../../shared/design';
import type { AgentId } from '../../../shared/types';
import { call } from '../../api';
import { onMenu, toast, useStore } from '../../store';
import { askConfirm } from '../../common/Prompt';
import { tip } from '../../common/Tip';
import { Icon } from '../../common/Icon';
import { EffortSelect, ModelSelect, effortDefaultLabel, useModelExists, useModelShort } from '../../common/ModelPick';
import { FlowCanvas } from './FlowCanvas';
import { CourtLayoutEditor } from './CourtLayoutEditor';
import { clearStash, useDraftHistory, writeStash } from './draftState';
import {
  OUTPUTS, OUTPUT_LABEL, PHASES, STEP_TYPES, STEP_TYPE_HINT, STEP_TYPE_LABEL, clone, newRole, newStep, removeRole, removeStep, renameRole, renameStep, type Draft,
} from './edit';

type Tab = 'canvas' | 'form';
const TABS: [Tab, string][] = [['canvas', '流程画布'], ['form', '表单编辑']];
const ID_RE = /^[a-z][a-z0-9_-]{0,31}$/;

const editable = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName));
const MOD = navigator.platform.toLowerCase().includes('mac') ? '⌘' : 'Ctrl+';

export function DesignEditor({ initial, resume, onClose, onSaved, startWithCourt }: { initial: Draft; resume?: { draft: Draft; note: string }; onClose: () => void; onSaved: (id: string) => void; startWithCourt?: boolean }) {
  const { draft, setDraft, undo, redo, canUndo, canRedo } = useDraftHistory(clone(resume?.draft ?? initial));
  const [tab, setTab] = useState<Tab>('canvas');
  const [sel, setSel] = useState<string | null>(null);
  const [note, setNote] = useState(resume?.note ?? '');
  const [saving, setSaving] = useState(false);
  const [showIssues, setShowIssues] = useState(false);
  const [rules, setRules] = useState(false);
  const [side, setSide] = useState<'court' | 'json' | null>(startWithCourt ? 'court' : null);
  const isNew = !initial.id;
  const isDefault = useStore((s) => s.settings.defaultDesign) === initial.id && !!initial.id;
  // a new (or copied) design is always saveable; an existing one once something changed
  const changed = useMemo(() => JSON.stringify(draft) !== JSON.stringify(initial), [draft, initial]);
  const dirty = isNew || changed;
  // keep an autosaved copy while there are unsaved changes (restored from the 协同设计 list)
  useEffect(() => {
    if (!changed) return clearStash();
    const t = setTimeout(() => writeStash({ base: initial, draft, note, at: Date.now() }), 300);
    return () => clearTimeout(t);
  }, [draft, note, changed, initial]);
  const check = useMemo(() => validateDesign({ ...draft, version: 1, createdAt: 0 }), [draft]);
  const stepErrors = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const s of draft.steps) {
      const mine = check.errors.filter((e) => e.includes(`「${s.label || s.id}」`) || e.includes(`：${s.id}`));
      if (mine.length) m.set(s.id, mine);
    }
    return m;
  }, [check, draft.steps]);

  const save = async () => {
    if (!check.ok) {
      setShowIssues(true);
      return toast(`还有 ${check.errors.length} 处问题需要修改`, 'error');
    }
    setSaving(true);
    try {
      const { version: _v, createdAt: _c, ...body } = draft;
      void _v; void _c;
      const saved = await call<{ id: string; version: number }>('designSave', { ...body, id: draft.id || undefined }, note.trim() || '在编辑器中修改');
      clearStash();
      toast(isDefault ? `已保存为 v${saved.version}，新下的旨意会按它办理（进行中的不受影响）` : `已保存为 v${saved.version}。要让新旨意按它办理，点「设为默认」`, 'success');
      onSaved(saved.id);
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  };
  const close = async () => {
    if (changed && !(await askConfirm('放弃修改？', isNew ? '这份设计还没保存，放弃后不会留下。' : '这次的修改还没保存。', { ok: '放弃修改', danger: true }))) return;
    clearStash();
    onClose();
  };
  const selStep = draft.steps.find((s) => s.id === sel);

  // keyboard: ⌘S save · ⌘Z / ⇧⌘Z undo / redo · Esc closes the sheet or inspector · Delete removes the selected step
  const keys = useRef({ save, undo, redo, side, sel, rules, tab, draft });
  keys.current = { save, undo, redo, side, sel, rules, tab, draft };
  const lastSave = useRef(0);
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const savingRef = useRef(saving);
  savingRef.current = saving;
  useEffect(() => {
    const trySave = () => {
      if (Date.now() - lastSave.current < 400) return; // the key and the menu accelerator can both fire
      lastSave.current = Date.now();
      if (dirtyRef.current && !savingRef.current) void keys.current.save();
    };
    const down = (e: KeyboardEvent) => {
      if (document.querySelector('.modal-backdrop')) return;
      const k = keys.current;
      const mod = e.metaKey || e.ctrlKey;
      const key = e.key.toLowerCase();
      if (mod && key === 's') {
        e.preventDefault();
        trySave();
      } else if (mod && (key === 'z' || key === 'y') && !editable(e.target)) {
        e.preventDefault();
        if (key === 'y' || e.shiftKey) k.redo();
        else k.undo();
      } else if (e.key === 'Escape') {
        if (k.side) setSide(null);
        else if (k.sel || k.rules) { setSel(null); setRules(false); }
        else return;
        e.preventDefault();
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && !mod && k.tab === 'canvas' && k.sel && !k.side && !editable(e.target)) {
        const idx = k.draft.steps.findIndex((s) => s.id === k.sel);
        if (idx < 0) return;
        e.preventDefault();
        setDraft(removeStep(k.draft, idx));
        setSel(null);
        toast(`已删除步骤，${MOD}Z 可撤销`, 'info');
      }
    };
    window.addEventListener('keydown', down);
    const off = onMenu((cmd) => cmd === 'save' && trySave());
    return () => {
      window.removeEventListener('keydown', down);
      off();
    };
  }, [setDraft]);

  return (
    <div className="de" data-testid="design-editor">
      <div className="de-head">
        <input className="input de-name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="设计名称" data-testid="de-name" />
        <div className="seg">
          {TABS.map(([k, l]) => <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)} data-testid={`de-tab-${k}`}>{l}</button>)}
        </div>
        <button className="btn sm ghost" onClick={() => { setTab('canvas'); setSel(null); setRules(true); }} {...tip('规则', '预算、封驳上限、并行度、结案前御批')} data-testid="de-rules"><Icon name="settings" size={12} /> 规则</button>
        <span className="de-undo">
          <button className="icon-btn" disabled={!canUndo} onClick={undo} {...tip('撤销', undefined, `${MOD}Z`, 'below')} data-testid="de-undo"><Icon name="undo" size={14} /></button>
          <button className="icon-btn" disabled={!canRedo} onClick={redo} {...tip('重做', undefined, `⇧${MOD}Z`, 'below')} data-testid="de-redo"><Icon name="redo" size={14} /></button>
        </span>
        <span style={{ flex: 1 }} />
        <button className={`chip ${check.ok ? 'ok' : 'bad'}`} onClick={() => setShowIssues(!showIssues)} data-testid="de-issues">
          {check.ok ? `✓ 校验通过${check.warnings.length ? ` · ${check.warnings.length} 条提醒` : ''}` : `✕ ${check.errors.length} 处问题`}
        </button>
        <div className="de-corner">
          <button className="link small" onClick={() => setSide('court')} {...tip('朝堂站位', '角色在像素朝堂里站哪、做什么（只影响画面）')} data-testid="de-court"><Icon name="crown" size={11} /> 朝堂站位{draft.court ? ` · ${draft.court.seats.length}` : ''}</button>
          <button className="link small" onClick={() => setSide('json')} {...tip('JSON', '高级：直接查看或修改设计的原始数据')} data-testid="de-json"><Icon name="code" size={11} /> JSON</button>
        </div>
      </div>
      <div className="de-head">
        <input className="input de-desc" value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} placeholder="一句话说明这套协作适合做什么" />
        <input className="input de-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="这次改了什么（可选）" />
        <button className="btn" onClick={close} data-testid="de-close">{changed ? '放弃' : '返回'}</button>
        <button className="btn primary" disabled={saving || !dirty} onClick={save} {...tip(isNew ? '保存' : '保存为新版本', '旧版本会保留，可随时回滚', `${MOD}S`, 'below')} data-testid="de-save"><Icon name="check" size={13} /> {isNew ? '保存' : '保存为新版本'}</button>
      </div>
      {showIssues && (check.errors.length > 0 || check.warnings.length > 0) && (
        <div className="de-issues" data-testid="de-issue-list">
          {check.errors.map((e, i) => <div key={`e${i}`} className="danger small">✕ {e}</div>)}
          {check.warnings.map((w, i) => <div key={`w${i}`} className="warn small">! {w}</div>)}
        </div>
      )}
      {tab === 'canvas' && (
        <div className="de-canvas">
          <FlowCanvas draft={draft} onChange={setDraft} selected={sel} onSelect={setSel} errors={stepErrors} />
          {selStep || rules ? (
            <div className="de-inspector" data-testid="de-inspector">
              <div className="row-gap de-insp-h">
                <b>{selStep ? `步骤 · ${selStep.label}` : '规则'}</b>
                <span style={{ flex: 1 }} />
                <button className="icon-btn" title="收起" onClick={() => { setSel(null); setRules(false); }}><Icon name="x" size={14} /></button>
              </div>
              {selStep ? (
                <StepForm draft={draft} step={selStep} onChange={setDraft} onRenamed={setSel} onRemoved={() => setSel(null)} errors={stepErrors.get(selStep.id)} />
              ) : (
                <PoliciesForm draft={draft} onChange={setDraft} />
              )}
            </div>
          ) : null}
        </div>
      )}
      {tab === 'form' && <FormView draft={draft} onChange={setDraft} errors={stepErrors} />}
      {side && (
        <div className="de-sheet-backdrop" onMouseDown={() => setSide(null)}>
          <div className="de-sheet" onMouseDown={(e) => e.stopPropagation()} data-testid={`de-sheet-${side}`}>
            <div className="row-gap de-sheet-h">
              <b>{side === 'court' ? '朝堂站位' : 'JSON'}</b>
              <span className="muted small">{side === 'court' ? '只影响像素朝堂里的画面，不影响旨意怎么执行。随设计一起保存。' : '高级：改完点「应用」，再保存设计。'}</span>
              <span style={{ flex: 1 }} />
              <button className="btn sm primary" onClick={() => setSide(null)} data-testid="de-sheet-done">完成</button>
            </div>
            {side === 'court' ? <CourtLayoutEditor draft={draft} onChange={setDraft} /> : <JsonView draft={draft} onChange={setDraft} />}
          </div>
        </div>
      )}
    </div>
  );
}

// ───────────────────────── 表单 ─────────────────────────
function FormView({ draft, onChange, errors }: { draft: Draft; onChange: (d: Draft) => void; errors: Map<string, string[]> }) {
  const [open, setOpen] = useState<string | null>(null);
  const moveStep = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= draft.steps.length) return;
    const out = clone(draft);
    [out.steps[i], out.steps[j]] = [out.steps[j], out.steps[i]];
    if (out.steps[0]) delete out.steps[0].parallel;
    onChange(out);
  };
  const moveRole = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= draft.roles.length) return;
    const out = clone(draft);
    [out.roles[i], out.roles[j]] = [out.roles[j], out.roles[i]];
    onChange(out);
  };
  return (
    <div className="de-form" data-testid="de-form">
      <section className="card">
        <div className="row-gap"><h4>角色（{draft.roles.length}）</h4><span style={{ flex: 1 }} />
          <button className="btn sm" onClick={() => { const r = newRole(draft); onChange({ ...clone(draft), roles: [...draft.roles, r] }); setOpen(`r:${r.id}`); }} data-testid="de-add-role"><Icon name="plus" size={12} /> 添加角色</button>
        </div>
        {draft.roles.map((r, i) => (
          <div key={i} className={`de-item ${open === `r:${r.id}` ? 'open' : ''}`}>
            <div className="de-item-h" onClick={() => setOpen(open === `r:${r.id}` ? null : `r:${r.id}`)}>
              <span>{AGENT_MAP[r.avatar]?.emoji}</span><b>{r.name}</b><code className="muted">{r.id}</code>
              <span className="muted small ellipsis">{r.duty}</span>
              <span style={{ flex: 1 }} />
              <button className="icon-btn" title="上移" onClick={(e) => { e.stopPropagation(); moveRole(i, -1); }}>↑</button>
              <button className="icon-btn" title="下移" onClick={(e) => { e.stopPropagation(); moveRole(i, 1); }}>↓</button>
            </div>
            {open === `r:${r.id}` && <RoleForm draft={draft} role={r} onChange={onChange} onRenamed={(id) => setOpen(`r:${id}`)} />}
          </div>
        ))}
      </section>
      <section className="card">
        <div className="row-gap wrap"><h4>步骤（{draft.steps.length}）</h4><span style={{ flex: 1 }} />
          {STEP_TYPES.map((t) => (
            <button key={t} className="btn sm" title={STEP_TYPE_HINT[t]} onClick={() => { const s = newStep(draft, t); onChange({ ...clone(draft), steps: [...draft.steps, s] }); setOpen(`s:${s.id}`); }} data-testid={`de-add-step-${t}`}>
              <Icon name="plus" size={11} /> {STEP_TYPE_LABEL[t].replace(/（.*）/, '')}
            </button>
          ))}
        </div>
        {draft.steps.map((s, i) => (
          <div key={i} className={`de-item ${open === `s:${s.id}` ? 'open' : ''} ${errors.has(s.id) ? 'bad' : ''}`}>
            <div className="de-item-h" onClick={() => setOpen(open === `s:${s.id}` ? null : `s:${s.id}`)}>
              <span className="de-idx">{i + 1}</span><b>{s.label}</b>
              <span className="chip chip-sm">{PHASE_LABEL[s.phase]}</span>
              <span className="muted small">{STEP_TYPE_LABEL[s.type]}{s.parallel ? ' · 与上一步并行' : ''}</span>
              {errors.has(s.id) && <span className="danger small">✕ {errors.get(s.id)!.length}</span>}
              <span style={{ flex: 1 }} />
              <button className="icon-btn" title="上移" onClick={(e) => { e.stopPropagation(); moveStep(i, -1); }}>↑</button>
              <button className="icon-btn" title="下移" onClick={(e) => { e.stopPropagation(); moveStep(i, 1); }}>↓</button>
            </div>
            {open === `s:${s.id}` && <StepForm draft={draft} step={s} onChange={onChange} onRenamed={(id) => setOpen(`s:${id}`)} onRemoved={() => setOpen(null)} errors={errors.get(s.id)} />}
          </div>
        ))}
      </section>
      <section className="card"><h4>规则</h4><PoliciesForm draft={draft} onChange={onChange} /></section>
    </div>
  );
}

function IdInput({ value, onCommit, testid }: { value: string; onCommit: (v: string) => void; testid?: string }) {
  const [v, setV] = useState(value);
  const ok = ID_RE.test(v);
  return (
    <input
      className={`input mono ${ok ? '' : 'bad'}`} value={v} data-testid={testid}
      onChange={(e) => setV(e.target.value.toLowerCase())}
      onBlur={() => (ok && v !== value ? onCommit(v) : setV(value))}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      title="小写字母开头，只能用 a-z 0-9 _ -"
    />
  );
}

function RoleForm({ draft, role, onChange, onRenamed }: { draft: Draft; role: RoleSpec; onChange: (d: Draft) => void; onRenamed: (id: string) => void }) {
  // undefined fields are dropped so "跟随路由 / 跟随旨意" leaves no key behind in the saved design
  const patch = (p: Partial<RoleSpec>) => onChange({ ...clone(draft), roles: draft.roles.map((r) => (r.id === role.id ? JSON.parse(JSON.stringify({ ...r, ...p })) : r)) });
  const routing = useStore((s) => s.settings.routing);
  const short = useModelShort();
  const exists = useModelExists();
  const route = role.modelClass === 'strong' ? routing?.strong : routing?.economy;
  const tier = role.modelClass === 'strong' ? '强' : '经济';
  const used = draft.steps.filter((s) => s.role === role.id || s.executors?.includes(role.id)).map((s) => s.label);
  return (
    <div className="de-fields" data-testid={`role-form-${role.id}`}>
      <div className="field"><label>名称</label><input className="input" value={role.name} onChange={(e) => patch({ name: e.target.value })} /></div>
      <div className="field"><label>id</label><IdInput key={role.id} value={role.id} onCommit={(v) => {
        if (draft.roles.some((r) => r.id === v)) return toast('这个 id 已被其他角色使用', 'error');
        onChange(renameRole(draft, role.id, v));
        onRenamed(v);
      }} /></div>
      <div className="field wide"><label>职责（一句话）</label><input className="input" value={role.duty} onChange={(e) => patch({ duty: e.target.value })} /></div>
      <div className="field"><label>朝堂形象</label>
        <select className="input" value={role.avatar} onChange={(e) => patch({ avatar: e.target.value as AgentId })}>
          {AVATARS.map((a) => <option key={a} value={a}>{AGENT_MAP[a]?.emoji} {AGENT_MAP[a]?.name}</option>)}
        </select>
      </div>
      <div className="field"><label>模型档</label>
        <select className="input" value={role.modelClass} onChange={(e) => patch({ modelClass: e.target.value as RoleSpec['modelClass'] })}>
          <option value="strong">强模型</option><option value="economy">经济模型</option>
        </select>
      </div>
      <div className="field span2"><label>模型</label>
        <ModelSelect className="input" testid="role-model" value={role.model} allowDefault={`跟随${tier}路由（${short(route)}）`} onChange={(r) => patch({ model: r ?? undefined })} />
        {role.model && !exists(role.model) && <span className="small warn-text" data-testid="role-model-missing">这个模型已不在模型配置里，运行时会改用{tier}模型路由。</span>}
      </div>
      <div className="field"><label>思考程度</label>
        <EffortSelect className="input" testid="role-effort" model={role.model && exists(role.model) ? role.model : route} defaultLabel={effortDefaultLabel(role.modelClass)} value={role.effort} onChange={(v) => patch({ effort: v })} />
      </div>
      <div className="field"><label>工具权限（上限）</label>
        <select className="input" value={role.toolAccess} onChange={(e) => patch({ toolAccess: e.target.value as RoleSpec['toolAccess'] })}>
          <option value="none">无工具</option><option value="read">只读</option><option value="write">读写（仍受权限模式约束）</option>
        </select>
      </div>
      <div className="field wide"><label>人设 / 提示词</label><textarea className="input" rows={4} value={role.prompt} onChange={(e) => patch({ prompt: e.target.value })} /></div>
      <div className="field wide row-gap">
        <span className="muted small">{used.length ? `用于：${used.join('、')}` : '还没有步骤使用这个角色'}</span>
        <span style={{ flex: 1 }} />
        <button className="btn sm danger" disabled={draft.roles.length <= 1} onClick={async () => { if (!used.length || (await askConfirm(`删除角色「${role.name}」？`, `它正被 ${used.length} 个步骤使用（${used.join('、')}），删除后这些步骤需要重新指派。`, { ok: '删除', danger: true }))) onChange(removeRole(draft, role.id)); }}>
          <Icon name="trash" size={12} /> 删除角色
        </button>
      </div>
    </div>
  );
}

function StepForm({ draft, step, onChange, onRenamed, onRemoved, errors }: { draft: Draft; step: StepSpec; onChange: (d: Draft) => void; onRenamed: (id: string) => void; onRemoved: () => void; errors?: string[] }) {
  const idx = draft.steps.findIndex((s) => s.id === step.id);
  const before = draft.steps.slice(0, idx);
  const patch = (p: Partial<StepSpec>) => onChange({ ...clone(draft), steps: draft.steps.map((s) => (s.id === step.id ? clean({ ...s, ...p }) : s)) });
  const setType = (type: StepType) => {
    const fresh = newStep({ ...draft, steps: before }, type);
    patch({ type, output: OUTPUTS[type][0], role: type === 'fanout' || type === 'gate' ? undefined : step.role ?? fresh.role, executors: fresh.executors, planStep: fresh.planStep, onReject: fresh.onReject, gate: fresh.gate, parallel: ['review', 'gate', 'plan', 'fanout'].includes(type) ? undefined : step.parallel });
  };
  const toggleExec = (id: string) => {
    const ex = new Set(step.executors ?? []);
    if (ex.has(id)) ex.delete(id);
    else ex.add(id);
    patch({ executors: [...ex] });
  };
  return (
    <div className="de-fields" data-testid={`step-form-${step.id}`}>
      {errors && <div className="field wide">{errors.map((e, i) => <div key={i} className="danger small">✕ {e}</div>)}</div>}
      <div className="field"><label>名称</label><input className="input" value={step.label} onChange={(e) => patch({ label: e.target.value })} data-testid="sf-label" /></div>
      <div className="field"><label>id</label><IdInput key={step.id} value={step.id} onCommit={(v) => {
        if (draft.steps.some((s) => s.id === v)) return toast('这个 id 已被其他步骤使用', 'error');
        onChange(renameStep(draft, step.id, v));
        onRenamed(v);
      }} /></div>
      <div className="field"><label>类型</label>
        <select className="input" value={step.type} onChange={(e) => setType(e.target.value as StepType)} data-testid="sf-type">
          {STEP_TYPES.map((t) => <option key={t} value={t}>{STEP_TYPE_LABEL[t]}</option>)}
        </select>
      </div>
      <div className="field"><label>阶段</label>
        <select className="input" value={step.phase} onChange={(e) => patch({ phase: e.target.value as StepSpec['phase'] })} data-testid="sf-phase">
          {PHASES.map((p) => <option key={p} value={p}>{PHASE_LABEL[p]}</option>)}
        </select>
      </div>
      {step.type !== 'fanout' && step.type !== 'gate' && (
        <div className="field"><label>由谁来做</label>
          <select className="input" value={step.role ?? ''} onChange={(e) => patch({ role: e.target.value || undefined })} data-testid="sf-role">
            <option value="">（请选择）</option>
            {draft.roles.map((r) => <option key={r.id} value={r.id}>{AGENT_MAP[r.avatar]?.emoji} {r.name}</option>)}
          </select>
        </div>
      )}
      {OUTPUTS[step.type].length > 1 && (
        <div className="field"><label>产出</label>
          <select className="input" value={step.output} onChange={(e) => patch({ output: e.target.value as StepSpec['output'] })}>
            {OUTPUTS[step.type].map((o) => <option key={o} value={o}>{OUTPUT_LABEL[o]}</option>)}
          </select>
        </div>
      )}
      {(step.type === 'plan' || step.type === 'fanout') && (
        <div className="field wide"><label>{step.type === 'plan' ? '可以分派给' : '执行角色'}</label>
          <div className="de-checks">
            {draft.roles.map((r) => (
              <label key={r.id} className="row-gap small"><input type="checkbox" checked={!!step.executors?.includes(r.id)} onChange={() => toggleExec(r.id)} /> {AGENT_MAP[r.avatar]?.emoji} {r.name}</label>
            ))}
          </div>
        </div>
      )}
      {step.type === 'fanout' && (
        <div className="field"><label>按哪个规划分派</label>
          <select className="input" value={step.planStep ?? ''} onChange={(e) => patch({ planStep: e.target.value || undefined })}>
            <option value="">（请选择）</option>
            {before.filter((s) => s.type === 'plan').map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>
        </div>
      )}
      {(step.type === 'review' || step.type === 'gate') && (
        <>
          <div className="field"><label>封驳时退回到</label>
            <select className="input" value={step.onReject?.goto ?? ''} onChange={(e) => patch({ onReject: e.target.value ? { goto: e.target.value, max: step.onReject?.max ?? 2 } : undefined })} data-testid="sf-reject">
              <option value="">{step.type === 'review' ? '（请选择）' : '不退回'}</option>
              {before.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
            </select>
          </div>
          {step.onReject && (
            <div className="field"><label>最多封驳几次</label>
              <input className="input" type="number" min={0} max={10} value={step.onReject.max} onChange={(e) => patch({ onReject: { ...step.onReject!, max: Math.max(0, Math.min(10, Number(e.target.value) || 0)) } })} />
            </div>
          )}
        </>
      )}
      {step.type === 'review' && (
        <label className="field row-gap small"><input type="checkbox" checked={step.gate === 'plan'} onChange={(e) => patch({ gate: e.target.checked ? 'plan' : undefined })} /> 准奏后再请皇上御览方案</label>
      )}
      {step.type === 'gate' && (
        <div className="field"><label>关卡类型</label>
          <select className="input" value={step.gate ?? 'final'} onChange={(e) => patch({ gate: e.target.value as 'plan' | 'final' })}>
            <option value="plan">方案御览</option><option value="final">御批</option>
          </select>
        </div>
      )}
      <div className="field wide"><label>这一步要做什么（给 AI 的说明）</label><textarea className="input" rows={3} value={step.instruction} onChange={(e) => patch({ instruction: e.target.value })} data-testid="sf-instruction" /></div>
      <div className="field wide"><label>参考哪些前面步骤的产出</label>
        <div className="de-checks">
          <label className="row-gap small"><input type="checkbox" checked={!step.inputs} onChange={(e) => patch({ inputs: e.target.checked ? undefined : [] })} /> 全部前面的步骤</label>
          {step.inputs && before.map((s) => (
            <label key={s.id} className="row-gap small"><input type="checkbox" checked={step.inputs!.includes(s.id)} onChange={() => patch({ inputs: step.inputs!.includes(s.id) ? step.inputs!.filter((x) => x !== s.id) : [...step.inputs!, s.id] })} /> {s.label}</label>
          ))}
        </div>
      </div>
      <div className="field wide row-gap wrap">
        {!['review', 'gate', 'plan', 'fanout'].includes(step.type) && idx > 0 && (
          <label className="row-gap small"><input type="checkbox" checked={!!step.parallel} onChange={(e) => patch({ parallel: e.target.checked || undefined })} data-testid="sf-parallel" /> 与上一步同时进行</label>
        )}
        <label className="row-gap small"><input type="checkbox" checked={!!step.optional} onChange={(e) => patch({ optional: e.target.checked || undefined })} /> 可选（卡住时允许跳过）</label>
        <label className="row-gap small">超时（秒）<input className="input sm-num" type="number" min={0} max={7200} value={step.timeoutSec ?? ''} placeholder="不限" onChange={(e) => patch({ timeoutSec: Number(e.target.value) > 0 ? Math.min(7200, Number(e.target.value)) : undefined })} /></label>
        <span style={{ flex: 1 }} />
        <button className="btn sm danger" onClick={() => { onChange(removeStep(draft, idx)); onRemoved(); }} data-testid="sf-delete"><Icon name="trash" size={12} /> 删除步骤</button>
      </div>
    </div>
  );
}

/** drop keys whose value is undefined so the JSON (and the no-op check) stays tidy */
function clean<T extends object>(o: T): T {
  for (const k of Object.keys(o) as (keyof T)[]) if (o[k] === undefined) delete o[k];
  return o;
}

function PoliciesForm({ draft, onChange }: { draft: Draft; onChange: (d: Draft) => void }) {
  const p = draft.policies;
  const patch = (x: Partial<typeof p>) => onChange({ ...clone(draft), policies: { ...p, ...x } });
  const num = (v: string, lo: number, hi: number) => Math.max(lo, Math.min(hi, Number(v) || 0));
  return (
    <div className="de-fields" data-testid="policies-form">
      <div className="field"><label>预算档</label>
        <select className="input" value={p.tier} onChange={(e) => patch({ tier: e.target.value as typeof p.tier })}>
          <option value="lite">Court Lite（省）</option><option value="full">Full Court（足）</option>
        </select>
      </div>
      <div className="field"><label>Token 预算（0 = 按档位）</label><input className="input" type="number" min={0} value={p.tokenBudget} onChange={(e) => patch({ tokenBudget: num(e.target.value, 0, 1e9) })} /></div>
      <div className="field"><label>封驳总上限</label><input className="input" type="number" min={0} max={10} value={p.maxRejections} onChange={(e) => patch({ maxRejections: num(e.target.value, 0, 10) })} /></div>
      <div className="field"><label>并行度（0 = 全局设置）</label><input className="input" type="number" min={0} max={8} value={p.parallelism} onChange={(e) => patch({ parallelism: num(e.target.value, 0, 8) })} /></div>
      <label className="field row-gap small"><input type="checkbox" checked={p.finalGate} onChange={(e) => patch({ finalGate: e.target.checked })} /> 结案前请皇上御批</label>
      <label className="field row-gap small"><input type="checkbox" checked={p.resilience.enabled} onChange={(e) => patch({ resilience: { ...p.resilience, enabled: e.target.checked } })} /> 卡住时允许自愈（重试、跳过可选步骤）</label>
      {p.resilience.enabled && (
        <>
          <div className="field"><label>自愈动作上限</label><input className="input" type="number" min={0} max={30} value={p.resilience.maxHealActions} onChange={(e) => patch({ resilience: { ...p.resilience, maxHealActions: num(e.target.value, 0, 30) } })} /></div>
          <div className="field"><label>自愈额外花费比例</label><input className="input" type="number" min={0} max={2} step={0.1} value={p.resilience.maxExtraCostRatio} onChange={(e) => patch({ resilience: { ...p.resilience, maxExtraCostRatio: Math.max(0, Math.min(2, Number(e.target.value) || 0)) } })} /></div>
        </>
      )}
    </div>
  );
}

function JsonView({ draft, onChange }: { draft: Draft; onChange: (d: Draft) => void }) {
  const [text, setText] = useState(() => JSON.stringify(draft, null, 2));
  const [err, setErr] = useState('');
  return (
    <div className="de-json">
      <div className="row-gap"><span className="muted small">高级：直接改 JSON，点「应用」后回到画布查看。</span><span style={{ flex: 1 }} />
        <button className="btn sm" onClick={() => setText(JSON.stringify(draft, null, 2))}>重新载入</button>
        <button className="btn sm primary" onClick={() => {
          try {
            const v = JSON.parse(text);
            if (!v || typeof v !== 'object' || !Array.isArray(v.roles) || !Array.isArray(v.steps) || !v.policies) throw new Error('缺少 roles / steps / policies');
            onChange({ ...v, id: draft.id, schema: draft.schema, origin: draft.origin });
            setErr('');
            toast('已应用', 'success');
          } catch (e) {
            setErr((e as Error).message);
          }
        }}>应用</button>
      </div>
      {err && <div className="danger small">JSON 有误：{err}</div>}
      <textarea className="input mono" spellCheck={false} value={text} onChange={(e) => setText(e.target.value)} />
    </div>
  );
}
