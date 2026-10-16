// 需求说明与对照检查 (2.1). 中书省 writes a 需求说明 (goal, what is out of scope, numbered acceptance criteria,
// constraints) before splitting the work, and each subtask names the criteria it delivers. After the ministries
// finish, 门下省 checks every criterion against the record: met needs evidence (a file and lines, a command's
// output, a preview), "done" alone is not evidence. Unmet criteria go back to the ministry that owned them as
// make-up subtasks, at most maxSupplement rounds; whatever is still unmet after that is 成果存疑 and waits for
// the emperor.
import type { AgentId, ModelRef, Plan, Requirement, RequirementCheck, RequirementVerdict, Requirements, RunNode, Subtask, SubtaskEffect, Task, Tier } from '../../shared/types';
import { VERDICT_LABEL, VERDICT_MARK, checkTally, coverage, normReqId, reqLabel } from '../../shared/requirements';
import type { Runtime } from './runtime';
import { runAgent, type RoleRun } from './agentLoop';
import type { ToolName } from './tools';
import { extractJson, now, truncate } from './util';
import { edictBlock } from './oral';

export function requirementCheckOn(rt: Runtime, tier: Tier): boolean {
  const s = rt.settings.requirementCheck as Runtime['settings']['requirementCheck'] | undefined;
  if (tier === 'full') return s?.full !== false;
  if (tier === 'lite') return s?.lite !== false;
  return false;
}

export const maxSupplementRounds = (rt: Runtime) => {
  const n = Number(rt.settings.requirementCheck?.maxSupplement);
  return Number.isFinite(n) ? Math.max(0, Math.min(3, Math.round(n))) : 1;
};

/** Added to the planner's prompt when the requirement check is on. */
export const REQUIREMENTS_PROMPT = `先写《需求说明》，再按需求拆子任务：在方案 JSON 里加 requirements 字段，并给每个子任务加 covers（它负责满足哪几条验收标准）。
"requirements":{"goal":"一两句话说清要达成什么","outOfScope":["明确不做的事"],"criteria":[{"id":"R1","text":"验收标准"}],"constraints":["从典章、项目规约里摘出与本旨意相关的约束"]}
子任务写法：{"id":"S1",……,"covers":["R1","R2"]}
- 验收标准逐条编号，一条只说一件事，写成做完后能核对的事实（文件内容、程序行为、命令输出、页面显示），不要写“代码质量好”这类无法核对的话。
- 每条验收标准都要有子任务覆盖；旨意没提、你也不打算做的，写进 outOfScope。
- R1 写旨意的核心要求，尽量用皇上原话；其余标准不能盖过它。
- 验收标准只写硬要求：旨意原话的核心、明确的约束、问答纪要里皇上定下的决定。你自己补充的细节不要写成验收标准。
- 验收标准只写对成品的要求：验收报告、复验记录、需求说明文件这类流程文书，旨意没要就不写；数量按【忠于旨意】给的范围写。`;

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
const strList = (v: unknown) => (Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? x.trim() : str((x as { text?: unknown })?.text))).filter(Boolean) : typeof v === 'string' && v.trim() ? [v.trim()] : []);

/**
 * The 需求说明 from a planner's JSON, ids normalised to R1, R2 …; sets each subtask's `covers` (unknown ids
 * dropped). `rawSubs` are the subtasks as the model wrote them, in the same order as `subs`.
 */
export function parseRequirements(raw: unknown, rawSubs: { covers?: unknown }[], subs: Subtask[]): Requirements | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const list = Array.isArray(r.criteria) ? r.criteria : [];
  const criteria: Requirement[] = [];
  const alias = new Map<string, string>();
  for (const c of list) {
    const text = typeof c === 'string' ? c.trim() : str((c as { text?: unknown })?.text);
    if (!text) continue;
    const given = typeof c === 'object' && c ? String((c as { id?: unknown }).id ?? '').trim() : '';
    let id = normReqId(given);
    if (!id || criteria.some((x) => x.id === id)) id = `R${criteria.length + 1}`;
    while (criteria.some((x) => x.id === id)) id = `R${Number(id.slice(1)) + 1}`;
    if (given) alias.set(given.toLowerCase(), id);
    criteria.push({ id, text: truncate(text, 400) });
  }
  if (!criteria.length) return undefined;
  const ids = new Set(criteria.map((c) => c.id));
  subs.forEach((s, i) => {
    const given = Array.isArray(rawSubs[i]?.covers) ? (rawSubs[i].covers as unknown[]) : [];
    const covers = [...new Set(given.map((g) => alias.get(String(g).trim().toLowerCase()) ?? normReqId(g)).filter((g): g is string => !!g && ids.has(g)))];
    if (covers.length) s.covers = covers;
  });
  return { goal: truncate(str(r.goal), 400), outOfScope: strList(r.outOfScope).slice(0, 12), criteria: criteria.slice(0, 30), constraints: strList(r.constraints).slice(0, 12) };
}

/** A plan with no 需求说明 gets one from its subtasks' acceptance lines (one criterion per subtask). */
export function withRequirements(plan: Plan): Plan {
  if (plan.requirements?.criteria.length) return plan;
  const subtasks = plan.subtasks.map((s, i) => ({ ...s, covers: [`R${i + 1}`] }));
  return {
    ...plan,
    subtasks,
    requirements: { goal: plan.summary, outOfScope: [], criteria: plan.subtasks.map((s, i) => ({ id: `R${i + 1}`, text: s.acceptance.trim() || s.title })), constraints: [], derived: true },
  };
}

/** The 需求说明 as prompt text; `withCoverage` adds which subtasks deliver each criterion. */
export function requirementsText(plan: Plan, withCoverage = false): string {
  const r = plan.requirements;
  if (!r) return '';
  const cov = coverage(plan);
  const lines = [`【需求说明${r.derived ? '（由各子任务的验收标准整理）' : ''}】`];
  if (r.goal) lines.push(`目标：${r.goal}`);
  lines.push('验收标准：');
  for (const c of cov) lines.push(`${c.id} ${c.text}${withCoverage ? (c.by.length ? `（由 ${c.by.join('、')} 负责）` : '（没有子任务负责）') : ''}`);
  if (r.outOfScope.length) lines.push(`不做：${r.outOfScope.join('；')}`);
  if (r.constraints.length) lines.push(`约束：${r.constraints.join('；')}`);
  return lines.join('\n');
}

/** For an executing official: the criteria its subtask is responsible for. */
export function ownedRequirementsText(plan: Plan, sub: Subtask): string {
  const own = (plan.requirements?.criteria ?? []).filter((c) => sub.covers?.includes(c.id));
  return own.length ? `【你负责满足的需求】\n${own.map((c) => `${c.id} ${c.text}`).join('\n')}\n结论的 verification 里请逐条写明每条需求是怎么满足、怎么验证的。` : '';
}

/** Criteria no subtask delivers (shown to 门下 when it reviews the plan). */
export const uncovered = (plan: Plan) => coverage(plan).filter((c) => !c.by.length).map((c) => c.id);

const VERDICTS: Record<string, RequirementVerdict> = {
  met: 'met', pass: 'met', passed: 'met', yes: 'met', done: 'met', ok: 'met', 满足: 'met', 已满足: 'met', 符合: 'met',
  unmet: 'unmet', fail: 'unmet', failed: 'unmet', no: 'unmet', missing: 'unmet', 未满足: 'unmet', 不满足: 'unmet', 未完成: 'unmet',
};
/** Evidence that only restates the claim. */
const BARE = /^(已经?|均已|全部)?(完成|实现|满足|符合|做了|做完|通过|处理)(了)?[。.!！\s]*$|^(done|ok|yes|completed?|implemented|see above|as above|见上|如上|同上|无|—|-)?[。.!！\s]*$/i;

export function parseCheckItems(text: string, criteria: Requirement[]): { items: RequirementCheck['items']; parsed: boolean } {
  const j = extractJson<{ items?: unknown } | unknown[]>(text);
  const raw = Array.isArray(j) ? j : Array.isArray((j as { items?: unknown })?.items) ? ((j as { items: unknown[] }).items) : null;
  const got = new Map<string, { verdict: RequirementVerdict; evidence: string; note: string }>();
  for (const x of raw ?? []) {
    const o = x as Record<string, unknown>;
    const id = normReqId(o?.id);
    if (!id || got.has(id)) continue;
    got.set(id, { verdict: VERDICTS[String(o.verdict ?? '').trim().toLowerCase()] ?? 'unknown', evidence: truncate(str(o.evidence), 600), note: truncate(str(o.note), 300) });
  }
  const items = criteria.map((c) => {
    const g = got.get(c.id);
    if (!g) return { id: c.id, text: c.text, verdict: 'unknown' as const, evidence: '', note: '检查没有对这条作出判定' };
    if (g.verdict === 'met' && BARE.test(g.evidence)) return { id: c.id, text: c.text, verdict: 'unknown' as const, evidence: g.evidence, note: '只说已完成，没有给出证据' };
    return { id: c.id, text: c.text, verdict: g.verdict, evidence: g.evidence, ...(g.note ? { note: g.note } : {}) };
  });
  return { items, parsed: !!raw };
}

/** The economy model for 门下's checklist pass, unless 门下 has a model of its own. */
function checkModel(rt: Runtime, t: Task): ModelRef | undefined {
  if (t.agentModels?.menxia || rt.settings.agentModels?.menxia) return undefined;
  const e = rt.settings.routing?.economy;
  return e && rt.modelInfo(e) && !rt.badModels.has(`${e.providerId}/${e.model}`) ? e : undefined;
}

export interface CheckRun {
  plan: Plan;
  /** the ministries' latest conclusions, as prompt text */
  conclusions: string;
  changes: string;
  guidance: string;
  /** a 协同设计 role doing the check (default: 门下省) */
  role?: RoleRun;
  agentId?: AgentId;
  tools?: ToolName[];
}

/** Run one 对照检查 and record it on the edict. */
export async function runRequirementCheck(rt: Runtime, t: Task, node: RunNode, round: number, o: CheckRun): Promise<RequirementCheck> {
  const criteria = o.plan.requirements?.criteria ?? [];
  const prev = t.requirementChecks?.at(-1);
  const prompt = [
    '【对照检查】',
    edictBlock(t, 2000),
    requirementsText(o.plan, true),
    `【各部结论】\n${o.conclusions || '无'}`,
    `【系统记录的文件改动】\n${o.changes || '无'}`,
    prev ? `【上一轮对照检查】\n${prev.items.map((i) => `${i.id} ${VERDICT_LABEL[i.verdict]}${i.note ? `（${i.note}）` : ''}`).join('\n')}` : '',
    o.guidance,
    `请逐条对照上面的验收标准，判定 met（满足）、unmet（未满足）或 unknown（无法判断）。
- met 必须写出证据：改了哪个文件的哪几行（用 view_changes / read_file 看过的）、哪条命令的输出、哪张预览截图。只写“已完成”不算证据，会按无法判断处理。
- unmet 在 note 里写清还缺什么，让负责的部能照着补。
- 只判定这些验收标准，不评价方案，不提新需求。
- 按【忠于旨意】判定：数量是约数时落在范围内即 met；流程文书（报告、记录）没写或没回填，不算成品未满足。
- 做法和字面不同、但达到了这条标准的目的，判 met，并在 note 写明出入；只有成品违背了它才判 unmet。
只输出 JSON：{"items":[{"id":"R1","verdict":"met"|"unmet"|"unknown","evidence":"证据","note":"还缺什么"}]}`,
  ].filter(Boolean).join('\n\n');
  const agentId: AgentId = o.agentId ?? 'menxia';
  const model = o.role ? undefined : checkModel(rt, t);
  const r = await runAgent({ rt, agentId, role: o.role, task: t, node, prompt, tools: o.tools, model, maxSteps: o.tools?.length ? 8 : 1, maxTokens: 2500, temperature: 0.1, label: node.label });
  let res = parseCheckItems(r.text, criteria);
  if (!res.parsed) {
    const r2 = await runAgent({ rt, agentId, role: o.role, task: t, node, history: r.messages, model, prompt: '请只输出检查结果 JSON：{"items":[{"id":"R1","verdict":"met"|"unmet"|"unknown","evidence":"证据","note":"还缺什么"}]}', maxTokens: 1500, temperature: 0, label: `${node.label}（格式修正）` });
    res = parseCheckItems(r2.text, criteria);
  }
  const chk: RequirementCheck = { round, at: now(), nodeId: node.id, items: res.items, supplements: [] };
  t.requirementChecks = [...(t.requirementChecks ?? []).filter((c) => c.nodeId !== node.id), chk];
  const k = checkTally(chk);
  rt.audit.record(agentId, 'requirement_check', { round, met: k.met, unmet: k.unmet, unknown: k.unknown, items: chk.items.map((i) => `${i.id}:${i.verdict}`) }, t.id);
  rt.activity('log', `📋 对照检查：${k.total} 条需求，满足 ${k.met}${k.unmet ? `，未满足 ${k.unmet}` : ''}${k.unknown ? `，无法判断 ${k.unknown}` : ''}${res.parsed ? '' : '（检查结果无法解析，全部按无法判断）'}\n${chk.items.map((i) => `${VERDICT_MARK[i.verdict]} ${reqLabel(i.id)} ${truncate(i.text, 60)}${i.verdict === 'met' ? '' : i.note ? ` — ${truncate(i.note, 80)}` : ''}`).join('\n')}`, { taskId: t.id, agentId, nodeId: node.id, data: { check: k } });
  rt.touch(t);
  return chk;
}

/** May this check still send unmet criteria back for a make-up round? */
export function canSupplement(rt: Runtime, t: Task, chk: RequirementCheck): boolean {
  const used = (t.requirementChecks ?? []).filter((c) => c.supplements.length).length;
  return !chk.supplements.length && chk.items.some((i) => i.verdict === 'unmet') && used < maxSupplementRounds(rt);
}

/**
 * Make-up subtasks for a check's unmet criteria: one per ministry (or role) that owned them, appended to the
 * plan. Returns the new plan, the ids added and the feedback for the officials.
 */
export function supplementPlan(plan: Plan, chk: RequirementCheck): { plan: Plan; ids: string[]; feedback: string } {
  const unmet = chk.items.filter((i) => i.verdict === 'unmet');
  const owners = (id: string) => plan.subtasks.filter((s) => s.covers?.includes(id));
  const fallback = plan.subtasks.find((s) => s.effect === 'write') ?? plan.subtasks[0];
  const groups = new Map<string, { items: typeof unmet; owners: Subtask[] }>();
  for (const it of unmet) {
    const os = owners(it.id);
    const lead = os.find((s) => !s.supplement) ?? os[0] ?? fallback;
    const g = groups.get(lead.dept) ?? { items: [], owners: [] };
    g.items.push(it);
    for (const s of os.length ? os : [lead]) if (!g.owners.includes(s)) g.owners.push(s);
    groups.set(lead.dept, g);
  }
  const taken = new Set(plan.subtasks.map((s) => s.id));
  let n = 1;
  const added: Subtask[] = [];
  for (const [dept, g] of groups) {
    while (taken.has(`B${n}`)) n++;
    const id = `B${n}`;
    taken.add(id);
    const effects = g.owners.map((s) => s.effect ?? 'read');
    const effect: SubtaskEffect = effects.includes('write') ? 'write' : effects.includes('verify') ? 'verify' : 'read';
    added.push({
      id,
      title: `补办 ${g.items.map((i) => reqLabel(i.id)).join('、')}`,
      dept: dept as Subtask['dept'],
      detail: `对照检查（第 ${chk.round} 轮）发现以下需求还没有满足，请补齐（原先由 ${g.owners.map((s) => s.id).join('、')} 负责）：\n${g.items.map((i) => `- ${i.id} ${i.text}${i.note ? `\n  还缺：${i.note}` : ''}${i.evidence ? `\n  检查所见：${i.evidence}` : ''}`).join('\n')}`,
      acceptance: g.items.map((i) => `${i.id} ${i.text}`).join('；'),
      dependsOn: [],
      effect,
      covers: g.items.map((i) => i.id),
      supplement: true,
    });
  }
  const feedback = `对照检查（第 ${chk.round} 轮）：${unmet.length} 条需求未满足，追加补办子任务 ${added.map((s) => s.id).join('、')}。\n${unmet.map((i) => `${i.id} ${i.text}${i.note ? `：${i.note}` : ''}`).join('\n')}`;
  return { plan: { ...plan, subtasks: [...plan.subtasks, ...added] }, ids: added.map((s) => s.id), feedback };
}

/** Criteria still unmet at the latest check (after any make-up round): 成果存疑. */
export function unmetRequirements(t: Task): RequirementCheck['items'] {
  return t.requirementChecks?.at(-1)?.items.filter((i) => i.verdict === 'unmet') ?? [];
}

export const unmetText = (items: RequirementCheck['items']) => items.map((i) => `${reqLabel(i.id)} ${truncate(i.text, 40)}`).join('；');

/** Tools the checker may use: look at the recorded changes and read files (never write or run). */
export const CHECK_TOOLS = (hasWs: boolean): ToolName[] => (hasWs ? ['view_changes', 'read_file', 'list_dir', 'search', 'outline', 'load_skill'] : ['view_changes', 'load_skill']);
