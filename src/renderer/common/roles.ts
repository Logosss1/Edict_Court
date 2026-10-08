// Role names / colours for a task: built-in 三省六部 officials, or the roles of the task's 协同设计.
import { AGENT_MAP, MINISTRIES } from '../../shared/court';
import type { Task } from '../../shared/types';

export interface RoleOption { id: string; name: string; color: string; emoji: string }

const PALETTE = ['#8b5cf6', '#ef4444', '#3b82f6', '#f59e0b', '#10b981', '#dc2626', '#6366f1', '#0ea5e9', '#a855f7', '#14b8a6'];

export function roleInfo(task: Task | undefined, id: string): RoleOption {
  const r = task?.designSpec?.roles.find((x) => x.id === id);
  if (r) {
    const av = AGENT_MAP[r.avatar];
    return { id, name: r.name, color: av?.color ?? PALETTE[task!.designSpec!.roles.indexOf(r) % PALETTE.length], emoji: av?.emoji ?? '👤' };
  }
  const a = AGENT_MAP[id as keyof typeof AGENT_MAP];
  return { id, name: a?.name ?? id, color: a?.color ?? '#94a3b8', emoji: a?.emoji ?? '👤' };
}

/** Who a plan's subtasks may be assigned to. */
export function deptOptions(task?: Task): RoleOption[] {
  const d = task?.designSpec;
  if (d) {
    const planStep = d.steps.find((s) => s.type === 'plan');
    const ids = planStep?.executors?.length ? planStep.executors : d.roles.map((r) => r.id);
    return ids.map((id) => roleInfo(task, id));
  }
  return MINISTRIES.map((m) => roleInfo(undefined, m));
}
