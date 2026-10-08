// Hover descriptions: any element with data-tip="名称" (plus optional data-tip-desc="一句话说明"
// and data-tip-key="⌘J") shows a small card after a short pause. One listener for the whole app.
import { useEffect, useRef, useState } from 'react';

const DELAY = 450;

type Side = 'right' | 'below' | 'above';
interface Shown { title: string; desc?: string; kbd?: string; x: number; y: number; side: Side }

export function TipLayer() {
  const [tip, setTip] = useState<Shown | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const target = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const clear = () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      target.current = null;
      setTip(null);
    };
    const over = (e: PointerEvent) => {
      const el = (e.target as HTMLElement | null)?.closest?.('[data-tip]') as HTMLElement | null;
      if (el === target.current) return;
      clear();
      if (!el) return;
      target.current = el;
      timer.current = setTimeout(() => {
        if (target.current !== el || !el.isConnected) return;
        const r = el.getBoundingClientRect();
        let side: Side = el.dataset.tipSide === 'below' || el.dataset.tipSide === 'above' ? el.dataset.tipSide : 'right';
        // near the bottom of the window a card below would be cut off: show it above instead
        if (side === 'below' && r.bottom + 80 > window.innerHeight) side = 'above';
        // centred cards stay inside the window (cards are at most 260px wide)
        const cx = Math.max(136, Math.min(window.innerWidth - 136, r.left + r.width / 2));
        setTip({
          title: el.dataset.tip ?? '', desc: el.dataset.tipDesc || undefined, kbd: el.dataset.tipKey || undefined,
          x: side === 'right' ? r.right + 8 : cx, y: side === 'right' ? r.top + r.height / 2 : side === 'below' ? r.bottom + 6 : r.top - 6, side,
        });
      }, DELAY);
    };
    window.addEventListener('pointerover', over);
    window.addEventListener('pointerdown', clear, true);
    window.addEventListener('wheel', clear, { passive: true });
    window.addEventListener('blur', clear);
    document.addEventListener('mouseleave', clear);
    return () => {
      window.removeEventListener('pointerover', over);
      window.removeEventListener('pointerdown', clear, true);
      window.removeEventListener('wheel', clear);
      window.removeEventListener('blur', clear);
      document.removeEventListener('mouseleave', clear);
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);
  if (!tip) return null;
  return (
    <div className={`tip tip-${tip.side}`} style={{ left: tip.x, top: tip.y }} role="tooltip" data-testid="tip">
      <div className="tip-h">
        <b>{tip.title}</b>
        {tip.kbd && <span className="kbd">{tip.kbd}</span>}
      </div>
      {tip.desc && <div className="tip-d">{tip.desc}</div>}
    </div>
  );
}

/** spread onto an element: tip('旨意看板', '所有旨意按状态分列', '⌘1') */
export function tip(title: string, desc?: string, kbd?: string, side?: Side) {
  return { 'data-tip': title, 'data-tip-desc': desc, 'data-tip-key': kbd, 'data-tip-side': side, 'aria-label': title };
}
