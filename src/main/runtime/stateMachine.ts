import { BASE_TRANSITIONS, TIER_EXTRA, HUMAN_ONLY, TERMINAL } from '../../shared/court';
import type { TaskState, Tier } from '../../shared/types';

export class IllegalTransitionError extends Error {
  constructor(
    public from: TaskState,
    public to: TaskState,
    public reason: string,
  ) {
    super(`非法状态流转 ${from} → ${to}：${reason}`);
    this.name = 'IllegalTransitionError';
  }
}

export function allowedTargets(from: TaskState, tier: Tier): TaskState[] {
  const base = BASE_TRANSITIONS[from] ?? [];
  const extra = TIER_EXTRA[tier]?.[from] ?? [];
  return [...new Set([...base, ...extra])];
}

/**
 * Validate a transition. Throws IllegalTransitionError when not allowed.
 * `actor` = 'emperor' for human actions; anything else is treated as automatic.
 */
export function assertTransition(from: TaskState, to: TaskState, tier: Tier, actor: string): void {
  if (TERMINAL.includes(from)) throw new IllegalTransitionError(from, to, '任务已终结，不可再流转');
  if (from === to) throw new IllegalTransitionError(from, to, '状态未变化');
  const allowed = allowedTargets(from, tier);
  if (!allowed.includes(to)) throw new IllegalTransitionError(from, to, `允许的目标：${allowed.join(', ') || '无'}`);
  const humanOnly = HUMAN_ONLY.some(([f, t]) => f === from && t === to);
  if (humanOnly && actor !== 'emperor') throw new IllegalTransitionError(from, to, '此流转属高风险操作，须皇上亲自确认');
}

export function canTransition(from: TaskState, to: TaskState, tier: Tier, actor: string): boolean {
  try {
    assertTransition(from, to, tier, actor);
    return true;
  } catch {
    return false;
  }
}
