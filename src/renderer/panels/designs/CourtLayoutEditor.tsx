// 朝堂布局编辑 — drag this design's roles onto the four court scenes and choose how each one stands
// and what it does while idle. The stage is the real scene art at world scale (640×360), so a seat
// lands in the court exactly where it was dropped.
import { useEffect, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import { AGENT_MAP } from '../../../shared/court';
import { COURT_IDLE, COURT_SCENES, COURT_SCENE_LABEL, type CourtFacing, type CourtPose, type CourtScene, type CourtSeat } from '../../../shared/design';
import { autoLayout, clone, poseFrame, spriteStyle, type Draft } from './edit';

const W = 640;
const H = 360;
const FACINGS: [CourtFacing, string][] = [['front', '朝前'], ['back', '背身'], ['left', '朝左'], ['right', '朝右']];
const POSES: [CourtPose, string][] = [['stand', '站立'], ['sit', '坐案'], ['kneel', '跪奏']];
const clampX = (x: number) => Math.round(Math.max(10, Math.min(W - 10, x)));
const clampY = (y: number) => Math.round(Math.max(56, Math.min(H - 4, y)));

export function CourtLayoutEditor({ draft, onChange }: { draft: Draft; onChange: (d: Draft) => void }) {
  const [scene, setScene] = useState<CourtScene>(draft.court?.seats[0]?.scene ?? 'taihe');
  const [sel, setSel] = useState<string | null>(null);
  const [drag, setDrag] = useState<{ role: string; fresh: boolean } | null>(null);
  const [ghost, setGhost] = useState<{ x: number; y: number } | null>(null);
  const stage = useRef<HTMLDivElement>(null);
  const layout = draft.court;
  const roleOf = (id: string) => draft.roles.find((r) => r.id === id);

  const setLayout = (fn: (seats: CourtSeat[]) => CourtSeat[], hide = layout?.hideBuiltin ?? true) => {
    const next = clone(draft);
    next.court = { seats: fn(clone(layout?.seats ?? [])), hideBuiltin: hide };
    onChange(next);
  };
  const patchSeat = (role: string, p: Partial<CourtSeat>) => setLayout((seats) => seats.map((s) => (s.role === role ? { ...s, ...p } : s)));

  const toWorld = (e: { clientX: number; clientY: number }) => {
    const r = stage.current!.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - r.top) / r.height) * H, inside: e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom };
  };

  useEffect(() => {
    if (!drag) return;
    const move = (e: PointerEvent) => {
      const p = toWorld(e);
      setGhost({ x: clampX(p.x), y: clampY(p.y + 20) });
    };
    const up = (e: PointerEvent) => {
      const p = toWorld(e);
      if (p.inside) {
        const x = clampX(p.x);
        const y = clampY(p.y + 20); // the pointer grabs the sprite's middle; seats are stored at the feet
        if (drag.fresh) setLayout((seats) => [...seats.filter((s) => s.role !== drag.role), { role: drag.role, scene, x, y, facing: 'front', pose: 'stand' }]);
        else patchSeat(drag.role, { x, y, scene });
        setSel(drag.role);
      }
      setDrag(null);
      setGhost(null);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
  });

  if (!layout) {
    return (
      <div className="cl-empty" data-testid="court-layout-empty">
        <p>这套设计还没有自己的朝堂布局，朝堂里沿用内置三省六部的站位（角色借用所选“朝堂形象”的位置）。</p>
        <div className="row-gap">
          <button className="btn primary" onClick={() => onChange({ ...clone(draft), court: autoLayout(draft) })} data-testid="court-layout-auto">按角色自动排班</button>
          <button className="btn" onClick={() => onChange({ ...clone(draft), court: { seats: [], hideBuiltin: true } })}>从空白开始</button>
        </div>
      </div>
    );
  }

  const here = layout.seats.filter((s) => s.scene === scene);
  const unplaced = draft.roles.filter((r) => !layout.seats.some((s) => s.role === r.id));
  const seat = layout.seats.find((s) => s.role === sel);
  const press = (e: RPointerEvent, role: string, fresh: boolean) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    setSel(role);
    const start = { x: e.clientX, y: e.clientY };
    const arm = (ev: PointerEvent) => {
      if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 3) return;
      window.removeEventListener('pointermove', arm);
      setDrag({ role, fresh });
    };
    window.addEventListener('pointermove', arm);
    window.addEventListener('pointerup', () => window.removeEventListener('pointermove', arm), { once: true });
  };

  return (
    <div className="cl" data-testid="court-layout">
      <div className="cl-bar">
        <div className="seg">
          {COURT_SCENES.map((k) => (
            <button key={k} className={k === scene ? 'on' : ''} onClick={() => setScene(k)} data-testid={`cl-scene-${k}`}>
              {COURT_SCENE_LABEL[k]}{layout.seats.some((s) => s.scene === k) ? ` · ${layout.seats.filter((s) => s.scene === k).length}` : ''}
            </button>
          ))}
        </div>
        <label className="row-gap small">
          <input type="checkbox" checked={layout.hideBuiltin} onChange={(e) => setLayout((s) => s, e.target.checked)} data-testid="cl-hide-builtin" />
          只显示本设计的角色（隐藏内置官员）
        </label>
        <span style={{ flex: 1 }} />
        <button className="btn sm" onClick={() => onChange({ ...clone(draft), court: autoLayout(draft) })}>重新自动排班</button>
        <button className="btn sm" onClick={() => { const n = clone(draft); delete n.court; onChange(n); }}>恢复内置站位</button>
      </div>
      <div className="cl-main">
        <div className="cl-stage-wrap">
          <div className="cl-stage" ref={stage} style={{ width: W, height: H }} onPointerDown={() => setSel(null)} data-testid="cl-stage">
            <img className="cl-bg" src={`../assets/pixel/scenes/${scene}.png`} width={W} height={H} alt={COURT_SCENE_LABEL[scene]} draggable={false} />
            {[...here].sort((a, b) => a.y - b.y).map((s) => {
              const r = roleOf(s.role);
              if (!r) return null;
              const moving = drag?.role === s.role && ghost;
              const x = moving ? ghost!.x : s.x;
              const y = moving ? ghost!.y : s.y;
              return (
                <div key={s.role} className={`cl-seat ${sel === s.role ? 'on' : ''}`} style={{ left: x - 16, top: y - 48, zIndex: Math.round(y) }} onPointerDown={(e) => press(e, s.role, false)} data-testid={`cl-seat-${s.role}`}>
                  {s.pose === 'sit' && s.desk && <img className="cl-desk" src="../assets/pixel/props/desk.png" alt="" draggable={false} onLoad={(e) => { const im = e.currentTarget; im.style.width = `${im.naturalWidth / 2}px`; }} />}
                  <div className="cl-sprite" style={spriteStyle(r.avatar, poseFrame(s), s.facing === 'left' && s.pose === 'stand')} />
                  <div className="cl-name">{r.name}</div>
                </div>
              );
            })}
            {drag?.fresh && ghost && (() => {
              const r = roleOf(drag.role)!;
              return (
                <div className="cl-seat ghost" style={{ left: ghost.x - 16, top: ghost.y - 48 }}>
                  <div className="cl-sprite" style={spriteStyle(r.avatar, 0)} />
                </div>
              );
            })()}
          </div>
          <div className="muted small">拖动人物调整站位；从右边把未上朝的角色拖进来。位置就是朝堂里的实际位置。</div>
        </div>
        <div className="cl-side">
          {seat && roleOf(seat.role) ? (
            <div className="card cl-inspect" data-testid="cl-inspect">
              <h4>{AGENT_MAP[roleOf(seat.role)!.avatar]?.emoji} {roleOf(seat.role)!.name}</h4>
              <div className="field"><label>所在场景</label>
                <select className="input" value={seat.scene} onChange={(e) => { patchSeat(seat.role, { scene: e.target.value as CourtScene }); setScene(e.target.value as CourtScene); }}>
                  {COURT_SCENES.map((k) => <option key={k} value={k}>{COURT_SCENE_LABEL[k]}</option>)}
                </select>
              </div>
              <div className="field"><label>朝向</label>
                <div className="seg">{FACINGS.map(([f, l]) => <button key={f} className={seat.facing === f ? 'on' : ''} onClick={() => patchSeat(seat.role, { facing: f })}>{l}</button>)}</div>
              </div>
              <div className="field"><label>姿态</label>
                <div className="seg">{POSES.map(([p, l]) => <button key={p} className={seat.pose === p ? 'on' : ''} onClick={() => patchSeat(seat.role, { pose: p, desk: p === 'sit' ? seat.desk ?? true : undefined })} data-testid={`cl-pose-${p}`}>{l}</button>)}</div>
              </div>
              {seat.pose === 'sit' && (
                <label className="row-gap small"><input type="checkbox" checked={!!seat.desk} onChange={(e) => patchSeat(seat.role, { desk: e.target.checked })} /> 面前摆案几</label>
              )}
              <div className="field"><label>空闲时在做什么</label>
                <select className="input" value={seat.idle ?? ''} onChange={(e) => patchSeat(seat.role, { idle: e.target.value || undefined })} data-testid="cl-idle">
                  {Object.entries(COURT_IDLE).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                </select>
              </div>
              <div className="muted small">有差事时，会按实际在做的事播放动作（思考、书写、查资料、跪奏请旨等）。</div>
              <div className="muted small">位置：{seat.x}, {seat.y}</div>
              <button className="btn sm danger" onClick={() => { setLayout((seats) => seats.filter((s) => s.role !== seat.role)); setSel(null); }}>移出朝堂</button>
            </div>
          ) : (
            <div className="muted small pad">点选一个人物，设置朝向、姿态和空闲动作。</div>
          )}
          <div className="card">
            <h4>未上朝的角色（{unplaced.length}）</h4>
            {!unplaced.length && <div className="muted small">所有角色都已安排站位。</div>}
            <div className="cl-pool">
              {unplaced.map((r) => (
                <div key={r.id} className="cl-token" onPointerDown={(e) => press(e, r.id, true)} title="拖进左侧场景，或双击放到场景中央" onDoubleClick={() => setLayout((seats) => [...seats, { role: r.id, scene, x: 320, y: 300, facing: 'front', pose: 'stand' }])} data-testid={`cl-token-${r.id}`}>
                  <div className="cl-sprite" style={spriteStyle(r.avatar, 0)} />
                  <span>{r.name}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
