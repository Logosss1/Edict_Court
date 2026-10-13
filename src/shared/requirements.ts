// 需求说明与对照检查 (2.1): helpers shared by the runtime and the UI.
import type { Plan, RequirementCheck, RequirementVerdict, Task } from './types';

/** Criteria ids are R1, R2 … everywhere in data and prompts; people see 需1, 需2 … */
export const reqLabel = (id: string) => id.replace(/^R(\d+)$/i, '需$1');

/** R3, r3, 需3, "3" → R3; anything without a number → null. */
export function normReqId(x: unknown): string | null {
  const m = String(x ?? '').match(/\d+/);
  return m ? `R${Number(m[0])}` : null;
}

export const VERDICT_LABEL: Record<RequirementVerdict, string> = { met: '满足', unmet: '未满足', unknown: '无法判断' };
export const VERDICT_MARK: Record<RequirementVerdict, string> = { met: '✅', unmet: '❌', unknown: '❔' };

/** Each criterion with the subtasks that deliver it. */
export function coverage(plan: Plan): { id: string; text: string; by: string[] }[] {
  return (plan.requirements?.criteria ?? []).map((c) => ({ ...c, by: plan.subtasks.filter((s) => s.covers?.includes(c.id)).map((s) => s.id) }));
}

export const latestCheck = (checks: RequirementCheck[] | undefined): RequirementCheck | undefined => checks?.at(-1);

export function checkTally(c: RequirementCheck) {
  const n = (v: RequirementVerdict) => c.items.filter((i) => i.verdict === v).length;
  return { met: n('met'), unmet: n('unmet'), unknown: n('unknown'), total: c.items.length };
}

/** The memorial's checklist: each criterion, its verdict and the evidence. */
export function checklistItems(t: Task): string[] {
  const chk = t.requirementChecks?.at(-1);
  const req = t.plan?.requirements;
  if (!chk && !req) return [];
  const out: string[] = [];
  if (req?.goal) out.push(`目标：${req.goal}`);
  if (chk) {
    const k = checkTally(chk);
    out.push(`对照检查第 ${chk.round} 轮：满足 ${k.met} / ${k.total}${k.unmet ? `，未满足 ${k.unmet}` : ''}${k.unknown ? `，无法判断 ${k.unknown}` : ''}${(t.requirementChecks ?? []).some((c) => c.supplements.length) ? `；补办过 ${(t.requirementChecks ?? []).flatMap((c) => c.supplements).join('、')}` : ''}`);
    for (const i of chk.items) out.push(`${VERDICT_MARK[i.verdict]} ${reqLabel(i.id)} ${i.text} — ${VERDICT_LABEL[i.verdict]}${i.evidence ? `；证据：${i.evidence}` : ''}${i.note ? `；${i.note}` : ''}`);
  } else for (const c of req?.criteria ?? []) out.push(`${reqLabel(c.id)} ${c.text}（未做对照检查）`);
  if (req?.outOfScope.length) out.push(`不做：${req.outOfScope.join('；')}`);
  return out;
}
