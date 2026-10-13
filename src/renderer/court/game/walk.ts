// Walkable floor of a top-down scene: a union of rectangles (feet positions, world units). Rooms
// joined by doorways are separate rectangles that touch, so a route goes through the doorway.
export interface Rect { x0: number; x1: number; y0: number; y1: number }
export type Pt = [number, number];

export function walkRects(spots: Record<string, any>): Rect[] {
  const w = spots.walk;
  if (!w) return [{ x0: 12, x1: 628, y0: 200, y1: 352 }];
  return (Array.isArray(w) ? w : [w]).filter((r: Rect) => r && r.x1 > r.x0 && r.y1 > r.y0);
}

export const inRect = (r: Rect, x: number, y: number, pad = 0) => x >= r.x0 - pad && x <= r.x1 + pad && y >= r.y0 - pad && y <= r.y1 + pad;
export const onFloor = (rects: Rect[], x: number, y: number, pad = 0) => rects.some((r) => inRect(r, x, y, pad));
const clamp = (r: Rect, x: number, y: number): Pt => [Math.max(r.x0, Math.min(r.x1, x)), Math.max(r.y0, Math.min(r.y1, y))];

/** index of the rectangle nearest to (x, y) (0 distance when inside) */
function nearestIndex(rects: Rect[], x: number, y: number): number {
  let best = 0;
  let bd = Infinity;
  rects.forEach((r, i) => {
    const [cx, cy] = clamp(r, x, y);
    const d = Math.hypot(cx - x, cy - y);
    if (d < bd) { bd = d; best = i; }
  });
  return best;
}

/** the floor point nearest to (x, y) */
export function nearestFloor(rects: Rect[], x: number, y: number): Pt {
  if (!rects.length) return [x, y];
  return clamp(rects[nearestIndex(rects, x, y)], x, y);
}

/** where two rectangles meet (null when they do not touch) */
function joint(a: Rect, b: Rect): Rect | null {
  const x0 = Math.max(a.x0, b.x0), x1 = Math.min(a.x1, b.x1), y0 = Math.max(a.y0, b.y0), y1 = Math.min(a.y1, b.y1);
  if (x0 > x1 + 2 || y0 > y1 + 2) return null;
  return { x0: Math.min(x0, x1), x1: Math.max(x0, x1), y0: Math.min(y0, y1), y1: Math.max(y0, y1) };
}

/**
 * Waypoints from `from` to `to` over the floor (the start point itself excluded). Straight when both
 * ends are in the same rectangle; otherwise through the middle of each doorway on the way.
 */
export function route(rects: Rect[], from: Pt, to: Pt): Pt[] {
  if (!rects.length) return [to];
  const end = nearestFloor(rects, to[0], to[1]);
  const a = rects.findIndex((r) => inRect(r, from[0], from[1], 1));
  const ia = a >= 0 ? a : nearestIndex(rects, from[0], from[1]);
  const ib = rects.findIndex((r) => inRect(r, end[0], end[1], 0.5));
  const target = ib >= 0 ? ib : nearestIndex(rects, end[0], end[1]);
  const pts: Pt[] = [];
  if (a < 0) pts.push(nearestFloor([rects[ia]], from[0], from[1]));
  if (ia === target || inRect(rects[ia], end[0], end[1])) return [...pts, end];
  // breadth-first over touching rectangles
  const prev = new Map<number, number>();
  const seen = new Set([ia]);
  const q = [ia];
  while (q.length) {
    const k = q.shift()!;
    if (k === target) break;
    rects.forEach((r, i) => {
      if (seen.has(i) || !joint(rects[k], r)) return;
      seen.add(i);
      prev.set(i, k);
      q.push(i);
    });
  }
  if (!seen.has(target)) return [...pts, end];
  const chain: number[] = [target];
  while (chain[0] !== ia) chain.unshift(prev.get(chain[0])!);
  for (let i = 0; i + 1 < chain.length; i++) {
    const j = joint(rects[chain[i]], rects[chain[i + 1]])!;
    pts.push([Math.round((j.x0 + j.x1) / 2), Math.round((j.y0 + j.y1) / 2)]);
  }
  pts.push(end);
  return pts;
}

/** one keyboard step: move if the new spot is on the floor, else slide along the wall */
export function stepOnFloor(rects: Rect[], x: number, y: number, dx: number, dy: number): Pt {
  if (onFloor(rects, x + dx, y + dy)) return [x + dx, y + dy];
  if (dx && onFloor(rects, x + dx, y)) return [x + dx, y];
  if (dy && onFloor(rects, x, y + dy)) return [x, y + dy];
  if (!onFloor(rects, x, y)) return nearestFloor(rects, x + dx, y + dy);
  return [x, y];
}
