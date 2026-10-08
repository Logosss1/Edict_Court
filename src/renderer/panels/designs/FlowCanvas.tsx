// 拖拽式流程画布 — swimlanes by phase (rows), steps in run order (columns); parallel steps share a
// column. Drag a card to reorder / change phase / run in parallel, drag a new step in from the
// palette, drag a role onto a step to assign it, and drag a review's ↺ knob onto an earlier step to
// set where a rejection sends the flow. Pure pointer events (no HTML5 DnD) so it works the same
// with mouse, trackpad and the e2e driver.
import { useEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import { AGENT_MAP } from '../../../shared/court';
import { PHASE_LABEL, type DesignPhase, type StepType } from '../../../shared/design';
import { Icon } from '../../common/Icon';
import { PHASES, STEP_TYPES, STEP_TYPE_HINT, STEP_TYPE_LABEL, groupsOf, newStep, placeStep, type Draft, type Drop } from './edit';

const LABEL_W = 62;
const COL_W = 176;
const CARD_W = 150;
const CARD_H = 64;
const GAP = 8;
const PAD = 10;
const TYPE_ICON: Record<StepType, string> = { agent: 'play', plan: 'scroll', review: 'gavel', fanout: 'users', summary: 'book', gate: 'flag' };

type Drag =
  | { kind: 'move'; idx: number }
  | { kind: 'new'; type: StepType }
  | { kind: 'reject'; idx: number }
  | { kind: 'role'; role: string };

interface Props {
  draft: Draft;
  onChange: (d: Draft) => void;
  selected: string | null;
  onSelect: (id: string | null) => void;
  errors: Map<string, string[]>;
}

export function FlowCanvas({ draft, onChange, selected, onSelect, errors }: Props) {
  const content = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [pt, setPt] = useState<{ x: number; y: number } | null>(null);
  const pending = useRef<{ drag: Drag; x: number; y: number; id?: string } | null>(null);
  const steps = draft.steps;
  const groups = useMemo(() => groupsOf(steps), [steps]);

  // ── layout: lane heights from the tallest stack, card positions ──
  const layout = useMemo(() => {
    const stack: Record<string, number> = {};
    const pos = new Map<number, { x: number; y: number; col: number }>();
    const k = new Map<number, number>();
    groups.forEach((g, col) => {
      const per: Record<string, number> = {};
      for (const i of g) {
        const p = steps[i].phase;
        k.set(i, per[p] ?? 0);
        per[p] = (per[p] ?? 0) + 1;
        stack[p] = Math.max(stack[p] ?? 0, per[p]);
      }
    });
    const laneTop: Record<string, number> = {};
    const laneH: Record<string, number> = {};
    let y = 0;
    for (const p of PHASES) {
      laneTop[p] = y;
      laneH[p] = Math.max(1, stack[p] ?? 0) * (CARD_H + GAP) + 2 * GAP;
      y += laneH[p];
    }
    const finalGate = !!draft.policies.finalGate;
    groups.forEach((g, col) => g.forEach((i) => pos.set(i, { x: LABEL_W + PAD + col * COL_W, y: laneTop[steps[i].phase] + GAP + (k.get(i) ?? 0) * (CARD_H + GAP), col })));
    const cols = groups.length + (finalGate ? 1 : 0);
    return { pos, laneTop, laneH, height: y, width: LABEL_W + PAD + (cols + 1) * COL_W, finalGate };
  }, [groups, steps, draft.policies.finalGate]);

  const local = (e: { clientX: number; clientY: number }) => {
    const r = content.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const laneAt = (y: number): DesignPhase => PHASES.find((p) => y >= layout.laneTop[p] && y < layout.laneTop[p] + layout.laneH[p]) ?? (y < 0 ? 'plan' : 'confirm');
  const dropAt = (x: number): Drop => {
    const rel = (x - LABEL_W - PAD) / COL_W;
    const c = Math.floor(rel);
    const frac = rel - c;
    if (c < 0) return { mode: 'insert', col: 0 };
    if (c >= groups.length) return { mode: 'insert', col: groups.length };
    if (frac < 0.22) return { mode: 'insert', col: c };
    if (frac > 0.78) return { mode: 'insert', col: c + 1 };
    return { mode: 'join', col: c };
  };
  const cardAt = (x: number, y: number) => {
    for (const [i, p] of layout.pos) if (x >= p.x && x <= p.x + CARD_W && y >= p.y && y <= p.y + CARD_H) return i;
    return -1;
  };

  // ── pointer plumbing (a press becomes a drag after 4px; otherwise it is a click) ──
  useEffect(() => {
    const move = (e: PointerEvent) => {
      const pd = pending.current;
      if (pd && !drag) {
        if (Math.hypot(e.clientX - pd.x, e.clientY - pd.y) < 4) return;
        setDrag(pd.drag);
      }
      if (pd || drag) setPt(local(e));
      // dragging near an edge scrolls the canvas, so far-apart steps can still be connected
      const sc = scroller.current;
      if (drag && sc) {
        const r = sc.getBoundingClientRect();
        const edge = 36;
        if (e.clientX > r.right - edge) sc.scrollLeft += 18;
        else if (e.clientX < r.left + edge) sc.scrollLeft -= 18;
        if (e.clientY > r.bottom - edge) sc.scrollTop += 14;
        else if (e.clientY < r.top + edge) sc.scrollTop -= 14;
      }
    };
    const up = (e: PointerEvent) => {
      const pd = pending.current;
      pending.current = null;
      if (!drag) {
        if (pd?.id !== undefined) onSelect(pd.id);
        setPt(null);
        return;
      }
      const p = local(e);
      finish(drag, p.x, p.y);
      setDrag(null);
      setPt(null);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
  }); // re-bound each render so the handlers see the latest layout / draft

  function finish(d: Drag, x: number, y: number) {
    if (x < 0 || y < -20 || x > layout.width + 40 || y > layout.height + 40) return; // dropped outside
    if (d.kind === 'move' || d.kind === 'new') {
      const step = d.kind === 'move' ? steps[d.idx] : newStep(draft, d.type);
      const next = placeStep(draft, step, d.kind === 'move' ? d.idx : null, dropAt(x), laneAt(y));
      onChange(next);
      onSelect(step.id);
      return;
    }
    const target = cardAt(x, y);
    if (target < 0) return;
    const out: Draft = JSON.parse(JSON.stringify(draft));
    if (d.kind === 'reject') {
      if (target >= d.idx) return;
      const s = out.steps[d.idx];
      s.onReject = { goto: out.steps[target].id, max: s.onReject?.max ?? 2 };
    } else {
      const s = out.steps[target];
      if (s.type === 'plan' || s.type === 'fanout') {
        const ex = new Set(s.executors ?? []);
        if (ex.has(d.role)) ex.delete(d.role);
        else ex.add(d.role);
        s.executors = [...ex];
      } else if (s.type !== 'gate') s.role = d.role;
      onSelect(s.id);
    }
    onChange(out);
  }

  const press = (e: RPointerEvent, dragSpec: Drag, id?: string) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    pending.current = { drag: dragSpec, x: e.clientX, y: e.clientY, id };
  };

  const roleName = (id?: string) => draft.roles.find((r) => r.id === id);
  const indicator = drag && pt && (drag.kind === 'move' || drag.kind === 'new') ? { drop: dropAt(pt.x), lane: laneAt(pt.y) } : null;
  const hoverCard = drag && pt && (drag.kind === 'reject' || drag.kind === 'role') ? cardAt(pt.x, pt.y) : -1;

  // ── edges ──
  const edges: any[] = [];
  groups.forEach((g, c) => {
    const next = groups[c + 1];
    if (!next) return;
    for (const a of g) for (const b of next) {
      const p = layout.pos.get(a)!;
      const q = layout.pos.get(b)!;
      const x1 = p.x + CARD_W;
      const y1 = p.y + CARD_H / 2;
      const x2 = q.x;
      const y2 = q.y + CARD_H / 2;
      const mx = (x1 + x2) / 2;
      edges.push(<path key={`e${a}-${b}`} d={`M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2 - 6},${y2}`} className="fc-edge" markerEnd="url(#fc-arrow)" />);
    }
  });
  if (layout.finalGate && groups.length) {
    const last = groups[groups.length - 1];
    const gx = LABEL_W + PAD + groups.length * COL_W;
    const gy = layout.laneTop.confirm + GAP;
    for (const a of last) {
      const p = layout.pos.get(a)!;
      const mx = (p.x + CARD_W + gx) / 2;
      edges.push(<path key={`fg${a}`} d={`M${p.x + CARD_W},${p.y + CARD_H / 2} C${mx},${p.y + CARD_H / 2} ${mx},${gy + CARD_H / 2} ${gx - 6},${gy + CARD_H / 2}`} className="fc-edge" markerEnd="url(#fc-arrow)" />);
    }
  }
  steps.forEach((s, i) => {
    if (!s.onReject) return;
    const t = steps.findIndex((x) => x.id === s.onReject!.goto);
    if (t < 0) return;
    const p = layout.pos.get(i)!;
    const q = layout.pos.get(t)!;
    const x1 = p.x + CARD_W / 2;
    const y1 = p.y + CARD_H;
    const x2 = q.x + CARD_W / 2 + 10;
    const y2 = q.y + CARD_H;
    const dip = Math.max(y1, y2) + 26;
    edges.push(
      <g key={`r${i}`}>
        <path d={`M${x1},${y1} C${x1},${dip} ${x2},${dip} ${x2},${y2 + 6}`} className="fc-reject" markerEnd="url(#fc-arrow-r)" />
        <text x={(x1 + x2) / 2} y={dip - 4} className="fc-reject-t" textAnchor="middle">封驳 ≤{s.onReject.max}</text>
      </g>,
    );
  });
  if (drag?.kind === 'reject' && pt) {
    const p = layout.pos.get(drag.idx)!;
    edges.push(<path key="live" d={`M${p.x + CARD_W / 2},${p.y + CARD_H} L${pt.x},${pt.y}`} className="fc-reject live" />);
  }

  return (
    <div className="fc" data-testid="flow-canvas">
      <div className="fc-palette">
        <span className="muted small">拖入新步骤：</span>
        {STEP_TYPES.map((t) => (
          <button key={t} className={`fc-chip t-${t}`} onPointerDown={(e) => press(e, { kind: 'new', type: t })} onClick={() => { if (!drag) { const s = newStep(draft, t); onChange({ ...draft, steps: [...draft.steps, s] }); onSelect(s.id); } }} title={STEP_TYPE_HINT[t]} data-testid={`fc-new-${t}`}>
            <Icon name={TYPE_ICON[t]} size={12} /> {STEP_TYPE_LABEL[t].replace(/（.*）/, '')}
          </button>
        ))}
        <span className="fc-sep" />
        <span className="muted small">拖角色到步骤上指派：</span>
        {draft.roles.map((r) => (
          <button key={r.id} className="fc-chip role" onPointerDown={(e) => press(e, { kind: 'role', role: r.id })} title={`${r.name}：${r.duty}`} data-testid={`fc-role-${r.id}`}>
            {AGENT_MAP[r.avatar]?.emoji} {r.name}
          </button>
        ))}
      </div>
      <div className="fc-scroll" ref={scroller}>
        <div className="fc-content" ref={content} style={{ width: layout.width, height: layout.height + 30 }} onPointerDown={(e) => { if (e.target === e.currentTarget) onSelect(null); }}>
          {PHASES.map((p) => (
            <div key={p} className={`fc-lane ${indicator && indicator.drop.mode === 'insert' && indicator.lane === p ? 'hot' : ''}`} style={{ top: layout.laneTop[p], height: layout.laneH[p] }}>
              <div className="fc-lane-h">{PHASE_LABEL[p]}</div>
            </div>
          ))}
          <svg className="fc-svg" width={layout.width} height={layout.height + 30}>
            <defs>
              <marker id="fc-arrow" viewBox="0 0 10 10" refX="2" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" className="fc-arrow" /></marker>
              <marker id="fc-arrow-r" viewBox="0 0 10 10" refX="2" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" className="fc-arrow-r" /></marker>
            </defs>
            {edges}
          </svg>
          {indicator && indicator.drop.mode === 'insert' && (
            <div className="fc-insert" style={{ left: LABEL_W + PAD + indicator.drop.col * COL_W - (COL_W - CARD_W) / 2 - 1, top: layout.laneTop[indicator.lane] + 4, height: layout.laneH[indicator.lane] - 8 }} />
          )}
          {indicator && indicator.drop.mode === 'join' && (
            <div className="fc-join" style={{ left: LABEL_W + PAD + indicator.drop.col * COL_W - 4, top: 2, width: CARD_W + 8, height: layout.height - 4 }}><span>并行</span></div>
          )}
          {steps.map((s, i) => {
            const p = layout.pos.get(i)!;
            const r = roleName(s.role);
            const errs = errors.get(s.id);
            const moving = drag?.kind === 'move' && drag.idx === i;
            const execs = s.type === 'plan' || s.type === 'fanout' ? (s.executors ?? []).map((id) => roleName(id)?.name ?? id) : [];
            return (
              <div
                key={s.id}
                className={`fc-card t-${s.type} ${selected === s.id ? 'on' : ''} ${errs ? 'bad' : ''} ${moving ? 'moving' : ''} ${hoverCard === i ? 'target' : ''}`}
                style={{ left: p.x, top: p.y, width: CARD_W, height: CARD_H }}
                onPointerDown={(e) => press(e, { kind: 'move', idx: i }, s.id)}
                title={errs ? errs.join('\n') : STEP_TYPE_HINT[s.type]}
                data-testid={`fc-card-${s.id}`}
              >
                <div className="fc-card-h">
                  <Icon name={TYPE_ICON[s.type]} size={12} />
                  <b className="ellipsis">{s.label || s.id}</b>
                  {s.parallel && <span className="fc-tag">并行</span>}
                  {s.optional && <span className="fc-tag">可选</span>}
                  {s.gate && <span className="fc-tag gate">⚑</span>}
                </div>
                <div className="fc-card-b ellipsis">
                  {s.type === 'gate' ? '皇上亲自批' : r ? `${AGENT_MAP[r.avatar]?.emoji ?? ''} ${r.name}` : s.type === 'fanout' ? '' : <span className="danger">未指派角色</span>}
                  {execs.length > 0 && <span className="muted"> → {execs.join('、')}</span>}
                </div>
                <div className="fc-card-t muted">{STEP_TYPE_LABEL[s.type]}</div>
                {(s.type === 'review' || s.type === 'gate') && (
                  <span className="fc-knob" onPointerDown={(e) => press(e, { kind: 'reject', idx: i })} title="拖到前面的步骤上：封驳时退回到那一步" data-testid={`fc-knob-${s.id}`}>↺</span>
                )}
              </div>
            );
          })}
          {layout.finalGate && (
            <div className="fc-card t-gate fixed" style={{ left: LABEL_W + PAD + groups.length * COL_W, top: layout.laneTop.confirm + GAP, width: CARD_W, height: CARD_H }} title="在「规则」里可以关闭">
              <div className="fc-card-h"><Icon name="crown" size={12} /><b>皇上御批结案</b></div>
              <div className="fc-card-b muted">准奏结案 / 封驳返工</div>
            </div>
          )}
          {drag && pt && (drag.kind === 'move' || drag.kind === 'new') && (
            <div className="fc-ghost" style={{ left: pt.x - CARD_W / 2, top: pt.y - CARD_H / 2, width: CARD_W, height: CARD_H }}>
              {drag.kind === 'move' ? steps[drag.idx].label : STEP_TYPE_LABEL[drag.type]}
            </div>
          )}
          {drag?.kind === 'role' && pt && <div className="fc-ghost role" style={{ left: pt.x + 8, top: pt.y + 8 }}>{roleName(drag.role)?.name}</div>}
        </div>
      </div>
      <div className="muted small fc-help">拖卡片换顺序或阶段；拖到另一张卡片正上方表示与它并行；审议卡右下角的 ↺ 拖到前面的步骤上，设定封驳退回到哪里。点卡片在右侧编辑详情。</div>
    </div>
  );
}

