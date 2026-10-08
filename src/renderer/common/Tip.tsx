// Hover descriptions: any element with data-tip="名称" (plus optional data-tip-desc="一句话说明"
// and data-tip-key="⌘J") shows a small card after a short pause. One listener for the whole app.
import { useEffect, useRef, useState } from 'react';

const DELAY = 450;

interface Shown { title: string; desc?: string; kbd?: string; x: number; y: number; side: 'right' | 'below' }

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
        const side = el.dataset.tipSide === 'below' ? 'below' : 'right';
        setTip({
          title: el.dataset.tip ?? '', desc: el.dataset.tipDesc || undefined, kbd: el.dataset.tipKey || undefined,
          x: side === 'right' ? r.right + 8 : r.left + r.width / 2, y: side === 'right' ? r.top + r.height / 2 : r.bottom + 6, side,
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
export function tip(title: string, desc?: string, kbd?: string, side?: 'right' | 'below') {
  return { 'data-tip': title, 'data-tip-desc': desc, 'data-tip-key': kbd, 'data-tip-side': side, 'aria-label': title };
}
