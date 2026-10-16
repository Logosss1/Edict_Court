// 细问: before the first plan, the official who plans (中书省, or a 协同设计's plan-step
// role) interviews the emperor in rounds. Each round asks every question whose prerequisites are settled, each
// with a recommended answer, and lists the facts the official looked up itself; facts are used only once the
// emperor confirms them. There is no cap on rounds: it ends with 问答纪要 the emperor confirms (就这样办), or at
// once when he says 「不必再问」. Every later prompt quotes the outcome right after the edict (oral.ts grillBlock).
// 全自动: an unanswered round times out to the recommendations, but those questions stay open; a later answer
// reaches the edict as a 口谕 and sends the work done before it back for rework.
import type { AgentId, ApprovalChoice, ApprovalRequest, GrillAnswer, GrillFact, GrillQuestion, GrillState, RunNode, Task } from '../../shared/types';
import { TERMINAL } from '../../shared/court';
import { runAgent, type RoleRun } from './agentLoop';
import type { Runtime } from './runtime';
import type { ToolName } from './tools';
import { decideGate, ensureNode, guidance, repoContext, runNode } from './orchestrator';
import { invitesQuestions } from './faithful';
import { edictBlock, giveOralOrder } from './oral';
import { extractJson, now, truncate } from './util';

/** Who asks: the planning official of this edict. */
export interface Asker {
  by: AgentId;
  name: string;
  roleId?: string;
  role?: RoleRun;
  tools?: ToolName[];
}

const MAX_OPTIONS = 5;
const MAX_PER_ROUND = 12;

/** Whether this edict gets 细问: Court Lite / Full and designs (not Solo, not scheduled), before its first plan. */
export function grillWanted(rt: Runtime, t: Task): boolean {
  if (t.tier === 'solo' || t.schedule || t.noGrill || t.planHistory.length) return false;
  // the emperor said 「不清楚可以问我」: asked even with 细问 switched off
  return rt.settings.grillAsk !== false || invitesQuestions(t.edict);
}

// cards are not persisted: the ones live in this process (a restart puts the open round to the emperor again)
const openByRt = new WeakMap<Runtime, Set<string>>();
const openCards = (rt: Runtime) => {
  let s = openByRt.get(rt);
  if (!s) openByRt.set(rt, (s = new Set()));
  return s;
};
// what the emperor filled in on a round card, until the card's decision is applied
const payloadByRt = new WeakMap<Runtime, Map<string, GrillAnswer>>();
const payloads = (rt: Runtime) => {
  let m = payloadByRt.get(rt);
  if (!m) payloadByRt.set(rt, (m = new Map()));
  return m;
};

/** 全自动 mode only: minutes after which an unanswered 细问 card goes on with the recommendations (0 = wait). */
const askTimeout = (rt: Runtime, t: Task) => (rt.modeFor(t) === 'auto' ? rt.settings.askTimeoutMin ?? 0 : 0);

/**
 * Called before the first plan. 'go': plan now (细问 is done, skipped or not wanted). 'wait': a card is out, or
 * the round failed (the edict is blocked); the emperor's answer drives the edict on.
 */
export async function grillStep(rt: Runtime, t: Task, a: Asker): Promise<'go' | 'wait'> {
  let g = t.grill;
  if (!g) {
    if (!grillWanted(rt, t)) return 'go';
    g = t.grill = { by: a.by, ...(a.roleId ? { roleId: a.roleId } : {}), name: a.name, status: 'asking', rounds: 0, questions: [], facts: [], notes: [] };
    rt.audit.record(a.by, 'grill_started', { by: a.by, role: a.roleId ?? null, invited: invitesQuestions(t.edict) }, t.id);
    rt.touch(t);
  }
  if (g.status === 'done' || g.status === 'skipped') return 'go';
  if (g.status === 'waiting' || g.status === 'confirming') {
    if (!openCards(rt).has(t.id)) {
      rt.activity('log', `${g.name}再次呈上细问（此前未获答复）`, { taskId: t.id, agentId: g.by });
      if (g.status === 'waiting') putRoundCard(rt, t);
      else putMinutesCard(rt, t);
    }
    return 'wait';
  }
  const n = g.rounds + 1;
  const node = ensureNode(t, `grill-${n}`, { kind: 'grill', agentId: a.by, label: `${a.name}细问${n > 1 ? `（第 ${n} 轮）` : ''}`, ...(a.roleId ? { roleId: a.roleId, roleName: a.name } : {}) });
  if (node.status === 'failed' || node.status === 'cancelled') return 'wait';
  // a round finished before a restart is not asked again
  const out = node.status === 'done' && node.output ? (JSON.parse(node.output) as RoundOut) : (JSON.parse(await runNode(rt, t, node, async () => JSON.stringify(await runRound(rt, t, a, node, n)))) as RoundOut);
  applyRound(rt, t, n, out);
  return t.grill?.status === 'done' ? 'go' : 'wait';
}

type RoundOut =
  | { type: 'ask'; questions: { title: string; body: string; options: string[]; recommend: string }[]; facts: { text: string; source?: string }[] }
  | { type: 'done'; minutes: string; fallback?: boolean };

export const GRILL_FORMAT = '还要问：{"type":"ask","facts":[{"text":"你自己查到的事实","source":"出处"}],"questions":[{"title":"一句话问题","body":"为什么问、各选项差在哪","options":["推荐答案","其他答案"],"recommend":"推荐答案"}]}\n问清楚了：{"type":"done","minutes":"问答纪要（Markdown）"}';

function grillRules(name: string): string {
  return [
    `【细问】动手规划之前，${name}要先把这道旨意向皇上问清楚，直到双方对要做成什么样没有分歧。`,
    '1. 顺着「要做成什么样」逐层问：先问会影响后面决定的问题；一个决定定了，再问依赖它的。这一轮只问前提已经定下的问题，可以一次问几个，每个问题单独成条。',
    '2. 每个问题都写出你的推荐答案（recommend），再给 2~4 个选项（options，推荐答案放第一个）。皇上答「是」或不改，就按推荐办。',
    '3. 能自己查到的（文件、代码、资料、网页）先自己查，不要拿来问皇上。查到的事实写进 facts 并注明出处，皇上确认后才用；皇上说不对的，不要再用。',
    '4. 只问会改变成品的事：无关紧要、能自己合理判断的，不问。问题以臣子口吻写，简短，不写称呼。',
    '5. 没有要问的了，就写问答纪要：皇上定下的每一个决定、确认过的事实、皇上的补充，逐条写清，后面各部按纪要办事。',
  ].join('\n');
}

const HOW_LABEL: Record<NonNullable<GrillQuestion['how']>, string> = { recommend: '按推荐', option: '皇上选定', free: '皇上答复', timeout: '皇上未答，暂按推荐' };

/** Everything asked and answered so far, for the next round's prompt ('' before round 1). */
function historyText(g: GrillState): string {
  if (!g.questions.length && !g.facts.length && !g.notes.length) return '';
  const qs = g.questions.map((q) => `- ${q.id}（第 ${q.round} 轮）${q.title}\n  推荐：${q.recommend || '无'}\n  答复：${q.answeredAt ? `${q.answer}（${HOW_LABEL[q.how ?? 'free']}）` : '未答'}`);
  const fs = g.facts.map((f) => `- ${f.id} ${f.text}：${factStatus(f)}`);
  return [
    '【已经问过的】',
    qs.length ? qs.join('\n') : '（还没有问题）',
    fs.length ? `【查到的事实】\n${fs.join('\n')}` : '',
    g.notes.length ? `【皇上的补充】\n${g.notes.map((x) => `- ${x}`).join('\n')}` : '',
    g.minutes ? `【你上次写的问答纪要】\n${g.minutes}\n皇上看了纪要后又补充了上面最后一条，请据此再问，或改好纪要。` : '',
    '已经问过的不要再问；只问因这些答复而新冒出来的问题。',
  ].filter(Boolean).join('\n');
}

function factStatus(f: GrillFact): string {
  switch (f.status) {
    case 'confirmed':
      return '皇上确认';
    case 'corrected':
      return `皇上更正为：${f.correction}`;
    case 'wrong':
      return '皇上说不对，不要用';
    case 'unconfirmed':
      return '未经确认，不作依据';
    default:
      return '待确认';
  }
}

async function runRound(rt: Runtime, t: Task, a: Asker, node: RunNode, n: number): Promise<RoundOut> {
  const g = t.grill!;
  const forced = n === 1 && invitesQuestions(t.edict);
  const prompt = [
    edictBlock(t),
    a.tools ? repoContext(rt, t) : '',
    guidance(rt, t),
    grillRules(a.name),
    historyText(g),
    forced ? '皇上在旨意里明说了不清楚可以问：这一轮至少问一个问题（写作类：重点写什么、风格或尺度；其他：最可能做错的那一点）。' : '',
    `只输出一个 JSON：\n${GRILL_FORMAT}`,
  ].filter(Boolean).join('\n\n');
  const r = await runAgent({ rt, agentId: a.by, role: a.role, task: t, node, prompt, tools: a.tools, maxSteps: a.tools ? 8 : 1, maxTokens: 3000, temperature: 0.3, label: node.label });
  let out = parseRound(r.text);
  if (!out || (forced && out.type === 'done')) {
    const fix = !out ? `请只输出规定的 JSON：\n${GRILL_FORMAT}` : `皇上明说了可以问，请至少问一个最影响成品的问题。只输出 type=ask 的 JSON：\n${GRILL_FORMAT.split('\n')[0]}`;
    const r2 = await runAgent({ rt, agentId: a.by, role: a.role, task: t, node, history: r.messages, prompt: fix, maxTokens: 2000, temperature: 0, label: `${a.name}细问（格式修正）` });
    out = parseRound(r2.text) ?? out;
  }
  if (!out) {
    rt.activity('log', `${a.name}细问的回答无法解析，直接整理问答纪要请皇上过目`, { taskId: t.id, agentId: a.by, nodeId: node.id });
    return { type: 'done', minutes: '', fallback: true };
  }
  return out;
}

/** The model's round JSON; null unless it asks something (or lists facts) or writes minutes. */
export function parseRound(text: string): RoundOut | null {
  const j = extractJson<{ type?: unknown; questions?: unknown; facts?: unknown; minutes?: unknown }>(text);
  if (!j || typeof j !== 'object') return null;
  const str = (x: unknown) => (typeof x === 'string' ? x.trim() : typeof x === 'number' ? String(x) : '');
  const questions = (Array.isArray(j.questions) ? j.questions : []).flatMap((x) => {
    const q = (typeof x === 'string' ? { title: x } : x ?? {}) as Record<string, unknown>;
    const title = truncate(str(q.title ?? q.question), 300);
    if (!title) return [];
    let options = (Array.isArray(q.options) ? q.options : []).map(str).filter(Boolean).map((o) => truncate(o, 200));
    let recommend = truncate(str(q.recommend ?? q.recommended ?? q.default), 300) || options[0] || '';
    if (recommend && !options.includes(recommend)) options = [recommend, ...options];
    else if (recommend) options = [recommend, ...options.filter((o) => o !== recommend)];
    options = [...new Set(options)].slice(0, MAX_OPTIONS);
    if (!recommend) recommend = '';
    return [{ title, body: truncate(str(q.body ?? q.why ?? q.context), 800), options, recommend }];
  }).slice(0, MAX_PER_ROUND);
  const facts = (Array.isArray(j.facts) ? j.facts : []).flatMap((x) => {
    const f = (typeof x === 'string' ? { text: x } : x ?? {}) as Record<string, unknown>;
    const text = truncate(str(f.text ?? f.fact), 500);
    return text ? [{ text, ...(str(f.source) ? { source: truncate(str(f.source), 200) } : {}) }] : [];
  }).slice(0, MAX_PER_ROUND);
  const type = str(j.type).toLowerCase();
  if (type === 'done' || (type !== 'ask' && !questions.length && !facts.length && str(j.minutes))) return { type: 'done', minutes: truncate(str(j.minutes), 6000) };
  if (!questions.length && !facts.length) return null;
  return { type: 'ask', questions, facts };
}

function applyRound(rt: Runtime, t: Task, n: number, out: RoundOut) {
  const g = t.grill!;
  g.rounds = n;
  if (out.type === 'done') {
    g.minutes = out.minutes || mechanicalMinutes(g);
    g.status = 'confirming';
    rt.activity('log', `${g.name}整理好问答纪要，请皇上过目`, { taskId: t.id, agentId: g.by, nodeId: `grill-${n}` });
    rt.audit.record(g.by, 'grill_minutes', { round: n, chars: g.minutes.length, fallback: !!out.fallback }, t.id);
    rt.touch(t);
    putMinutesCard(rt, t);
    return;
  }
  const qs: GrillQuestion[] = out.questions.map((q, i) => ({ id: `Q${g.questions.length + i + 1}`, round: n, ...q }));
  const fs: GrillFact[] = out.facts.map((f, i) => ({ id: `F${g.facts.length + i + 1}`, round: n, status: 'pending', ...f }));
  g.questions.push(...qs);
  g.facts.push(...fs);
  g.status = 'waiting';
  rt.activity('log', `${g.name}细问（第 ${n} 轮）：${[...qs.map((q) => `${q.id} ${q.title}`), ...fs.map((f) => `${f.id} 待确认：${truncate(f.text, 60)}`)].join('；')}`, { taskId: t.id, agentId: g.by, nodeId: `grill-${n}` });
  rt.audit.record(g.by, 'grill_round', { round: n, questions: qs.map((q) => ({ id: q.id, title: q.title, recommend: q.recommend })), facts: fs.map((f) => ({ id: f.id, text: f.text })) }, t.id);
  rt.touch(t);
  putRoundCard(rt, t);
}

/** The questions and facts of the latest round still waiting for the emperor. */
export function openRound(g: GrillState) {
  return { questions: g.questions.filter((q) => q.round === g.rounds && !q.answeredAt), facts: g.facts.filter((f) => f.round === g.rounds && f.status === 'pending') };
}

const ROUND_CHOICES: ApprovalChoice[] = [
  { id: 'answer', label: '答复', hint: '按卡片上选好的答复', approve: true, tone: 'primary', comment: 'optional' },
  { id: 'recommend', label: '都按推荐', hint: '每个问题都按推荐答案，查到的事实都算对', approve: true, comment: 'optional' },
  { id: 'stop', label: '不必再问，开始规划', hint: '已答的照答复，没答的按推荐，没确认的事实不用', approve: true, comment: 'optional' },
];

function putRoundCard(rt: Runtime, t: Task) {
  const g = t.grill!;
  const { questions, facts } = openRound(g);
  if (!questions.length && !facts.length) {
    // nothing left on this round (e.g. answered just before a restart): go on to the next one
    g.status = 'asking';
    rt.touch(t);
    rt.driveHook(t.id);
    return;
  }
  const timeoutMin = askTimeout(rt, t);
  const parts = [questions.length ? `${questions.length} 个问题` : '', facts.length ? `${facts.length} 条事实待确认` : ''].filter(Boolean).join('，');
  const summary = `${g.name}细问（第 ${g.rounds} 轮）：${parts}`;
  putCard(rt, t, {
    summary, choices: ROUND_CHOICES, timeoutMin,
    reason: timeoutMin > 0 ? `全自动模式：${timeoutMin} 分钟内未答复将先按推荐答案办，问题留着可以补答` : '规划之前先把旨意问清楚',
    grill: { phase: 'round', round: g.rounds, questions, facts },
  }, (d, timedOut) => {
    if (timedOut) return endByTimeout(rt, t, timeoutMin);
    applyAnswers(rt, t, d.choice, payloads(rt).get(d.apId), d.comment);
  });
}

function putMinutesCard(rt: Runtime, t: Task) {
  const g = t.grill!;
  const timeoutMin = askTimeout(rt, t);
  putCard(rt, t, {
    summary: `${g.name}呈上问答纪要，请皇上过目`,
    timeoutMin,
    reason: timeoutMin > 0 ? `全自动模式：${timeoutMin} 分钟内未答复将照此纪要规划` : '纪要定了，各部就照纪要办',
    choices: [
      { id: 'ok', label: '就这样办', approve: true, tone: 'primary', comment: 'optional' },
      { id: 'more', label: '还有要补充', hint: '写下要补充或更正的地方', approve: true, comment: 'required' },
    ],
    grill: { phase: 'minutes', round: g.rounds, questions: [], facts: [], minutes: g.minutes },
  }, (d, timedOut) => {
    const note = (d.comment ?? '').trim();
    if (!timedOut && d.choice === 'more' && note) {
      g.notes.push(truncate(note, 2000));
      g.status = 'asking';
      rt.activity('human', `皇上补充：${truncate(note, 200)}`, { taskId: t.id, agentId: g.by });
      rt.audit.record('emperor', 'grill_more', { round: g.rounds, note: truncate(note, 300) }, t.id);
      return;
    }
    if (note) {
      g.notes.push(truncate(note, 2000));
      g.minutes = `${g.minutes ?? ''}\n\n皇上批示：${truncate(note, 2000)}`.trim();
    }
    finishGrill(rt, t, timedOut ? 'timeout' : 'confirmed');
    rt.activity(timedOut ? 'log' : 'human', timedOut ? `${timeoutMin} 分钟未答复，照问答纪要规划` : `皇上准了问答纪要${note ? `：${truncate(note, 200)}` : ''}`, { taskId: t.id, agentId: g.by });
  });
}

interface CardDecision { apId: string; choice: string; comment?: string }

function putCard(rt: Runtime, t: Task, c: { summary: string; reason: string; timeoutMin: number; choices: ApprovalChoice[]; grill: NonNullable<ApprovalRequest['grill']> }, apply: (d: CardDecision, timedOut: boolean) => void) {
  const g = t.grill!;
  const open = openCards(rt);
  open.add(t.id);
  let apId = '';
  const decision = rt.requestDecision({
    kind: 'grill', taskId: t.id, agentId: g.by, nodeId: `grill-${g.rounds}`, tool: 'grill', summary: c.summary, detail: '', risk: 'normal', reason: c.reason, choices: c.choices, grill: c.grill,
  }, { onId: (id) => (apId = id) });
  let fired = false;
  const timer = c.timeoutMin > 0
    ? setTimeout(() => {
        if (rt.approvals.get(apId)?.status !== 'pending') return;
        fired = true;
        rt.decideApproval(apId, true, 'system');
      }, c.timeoutMin * 60_000)
    : undefined;
  timer?.unref?.();
  void decision.then((d) => {
    if (timer) clearTimeout(timer);
    open.delete(t.id);
    const payload = payloads(rt).get(apId);
    payloads(rt).delete(apId);
    const ag = rt.agents.get(g.by);
    if (ag?.status === 'waiting' && ag.activity === `等待批准：${c.summary}`) rt.setAgent(g.by, { status: 'idle', activity: '' });
    // cancelled, stopped or the app is closing: nothing moves (a live edict puts the card again when driven)
    if (rt.tasks.get(t.id) !== t || TERMINAL.includes(t.state) || rt.controllers.get(t.id)?.signal.aborted || !d.approve || t.grill !== g) return;
    if (payload) payloads(rt).set(apId, payload);
    apply({ apId, choice: d.choice, comment: d.comment }, fired);
    payloads(rt).delete(apId);
    rt.touch(t);
    rt.driveHook(t.id);
  });
}

/** The emperor's card for a round: his answers, the recommendations for the rest, then the next round or the end. */
function applyAnswers(rt: Runtime, t: Task, choice: string, p: GrillAnswer | undefined, comment?: string) {
  const g = t.grill!;
  const { questions, facts } = openRound(g);
  const stop = choice === 'stop' || !!p?.stop;
  const at = now();
  for (const q of questions) {
    const a = p?.answers.find((x) => x.id === q.id && x.answer.trim());
    if (a && choice !== 'recommend') {
      q.answer = truncate(a.answer.trim(), 2000);
      q.how = a.answer.trim() === q.recommend ? 'recommend' : a.how;
    } else {
      q.answer = q.recommend || '（皇上未答，由臣酌定）';
      q.how = 'recommend';
    }
    q.answeredAt = at;
  }
  for (const f of facts) {
    const a = p?.facts.find((x) => x.id === f.id);
    if (choice === 'recommend') f.status = 'confirmed';
    else if (a?.status === 'corrected' && a.correction?.trim()) {
      f.status = 'corrected';
      f.correction = truncate(a.correction.trim(), 1000);
    } else if (a?.status === 'confirmed' || a?.status === 'wrong') f.status = a.status;
    else f.status = 'unconfirmed';
  }
  const note = (p?.note ?? comment ?? '').trim();
  if (note) g.notes.push(truncate(note, 2000));
  const said = [...questions.map((q) => `${q.id} ${truncate(q.title, 40)}：${truncate(q.answer ?? '', 80)}`), ...facts.map((f) => `${f.id} ${factStatus(f)}`)];
  rt.activity('human', `皇上答复${g.name}细问（第 ${g.rounds} 轮）${choice === 'recommend' ? '：都按推荐' : ''}\n${said.map((x) => `· ${x}`).join('\n')}${note ? `\n· 补充：${truncate(note, 200)}` : ''}`, { taskId: t.id, agentId: g.by });
  rt.audit.record('emperor', 'grill_answered', { round: g.rounds, choice, answers: questions.map((q) => ({ id: q.id, how: q.how, answer: truncate(q.answer ?? '', 200) })), facts: facts.map((f) => ({ id: f.id, status: f.status })), stop }, t.id);
  if (stop) {
    finishGrill(rt, t, 'stopped');
    rt.activity('human', '皇上：不必再问，开始规划', { taskId: t.id, agentId: g.by });
  } else g.status = 'asking';
}

/** 全自动, nobody answered: the recommendations stand for now and the questions stay open for a late answer. */
function endByTimeout(rt: Runtime, t: Task, min: number) {
  const g = t.grill!;
  const { questions, facts } = openRound(g);
  const at = now();
  for (const q of questions) {
    q.answer = q.recommend || '（皇上未答，由臣酌定）';
    q.how = 'timeout';
    q.answeredAt = at;
  }
  for (const f of facts) f.status = 'unconfirmed';
  finishGrill(rt, t, 'timeout');
  rt.activity('log', `${min} 分钟未答复：${questions.length ? `${questions.map((q) => q.id).join('、')} 先按推荐答案办，这些问题仍可补答，补答后会返工调整` : '照现有答复规划'}${facts.length ? `；${facts.map((f) => f.id).join('、')} 未经确认，不作依据` : ''}`, { taskId: t.id, agentId: g.by });
  rt.audit.record('system', 'grill_timeout', { round: g.rounds, minutes: min, questions: questions.map((q) => q.id), facts: facts.map((f) => f.id) }, t.id);
}

function finishGrill(rt: Runtime, t: Task, ended: NonNullable<GrillState['ended']>) {
  const g = t.grill!;
  // a written 纪要 the emperor approved stands as written; otherwise the system writes it from the answers
  if (ended !== 'confirmed' || !g.minutes) g.minutes = mechanicalMinutes(g);
  g.status = 'done';
  g.ended = ended;
  g.endedAt = now();
  rt.audit.record(ended === 'timeout' ? 'system' : 'emperor', 'grill_done', { ended, rounds: g.rounds, questions: g.questions.length, facts: g.facts.length }, t.id);
}

/** 问答纪要 written from the answers themselves (stop, timeout, or when the official's own could not be read). */
export function mechanicalMinutes(g: GrillState): string {
  const qs = g.questions.filter((q) => q.answeredAt).map((q) => `- ${q.id} ${q.title}：${q.answer}（${q.lateAt ? '皇上补答' : HOW_LABEL[q.how ?? 'free']}）`);
  const fs = g.facts.filter((f) => f.status !== 'pending').map((f) => `- ${f.id} ${f.status === 'corrected' ? `${f.correction}（皇上更正，原为：${f.text}）` : `${f.text}（${factStatus(f)}）`}`);
  const parts = [
    qs.length ? `问答：\n${qs.join('\n')}` : '',
    fs.length ? `查到的事实：\n${fs.join('\n')}` : '',
    g.notes.length ? `皇上补充：\n${g.notes.map((x) => `- ${x}`).join('\n')}` : '',
  ].filter(Boolean);
  return parts.length ? parts.join('\n\n') : '（旨意已清楚，无须细问）';
}

// ───────────────────────── answers from the renderer ─────────────────────────
function cleanAnswer(a: GrillAnswer): GrillAnswer {
  const hows = ['recommend', 'option', 'free'] as const;
  const st = ['confirmed', 'corrected', 'wrong'] as const;
  return {
    answers: (Array.isArray(a?.answers) ? a.answers : []).filter((x) => x && typeof x.id === 'string' && typeof x.answer === 'string').map((x) => ({ id: x.id, answer: truncate(x.answer, 2000), how: hows.includes(x.how) ? x.how : 'free' })),
    facts: (Array.isArray(a?.facts) ? a.facts : []).filter((x) => x && typeof x.id === 'string' && st.includes(x.status)).map((x) => ({ id: x.id, status: x.status, ...(typeof x.correction === 'string' && x.correction.trim() ? { correction: truncate(x.correction, 1000) } : {}) })),
    ...(typeof a?.note === 'string' && a.note.trim() ? { note: truncate(a.note.trim(), 2000) } : {}),
    ...(a?.stop ? { stop: true } : {}),
  };
}

/** The emperor answers a round card (what he picked or wrote per question, and 对 / 不对 per fact). */
export function answerGrill(rt: Runtime, approvalId: string, a: GrillAnswer) {
  const ap = rt.approvals.get(approvalId);
  if (!ap || ap.kind !== 'grill' || ap.status !== 'pending') throw new Error('这张细问卡片已经答过或已失效');
  if (ap.grill?.phase !== 'round') throw new Error('这张卡片是问答纪要：请选「就这样办」或「还有要补充」');
  const p = cleanAnswer(a);
  for (const f of p.facts) if (f.status === 'corrected' && !f.correction) throw new Error(`${f.id} 选了「不对」并要更正：请写明正确的说法`);
  payloads(rt).set(approvalId, p);
  rt.decideApproval(approvalId, true, 'emperor', p.stop ? 'stop' : 'answer', p.note);
}

/**
 * A late answer to questions that timed out (and facts left unconfirmed). It updates the 纪要; on a live edict it
 * is also given as a 口谕, and work done before it is sent back for rework (at the final gate: at once). On an
 * edict that is already finished it is only kept on record.
 */
export function answerGrillLate(rt: Runtime, taskId: string, a: GrillAnswer): { rework: boolean; changed: number } {
  const t = rt.getTask(taskId);
  const g = t.grill;
  if (!g) throw new Error('这道旨意没有细问');
  const p = cleanAnswer(a);
  const at = now();
  const lines: string[] = []; // what changed: given as a 口谕 and reworked
  const kept: string[] = []; // the recommendation confirmed: on record only
  for (const x of p.answers) {
    const q = g.questions.find((y) => y.id === x.id && y.how === 'timeout');
    const ans = x.answer.trim();
    if (!q || !ans) continue;
    q.lateAt = at;
    if (ans === q.answer) {
      q.how = 'recommend';
      kept.push(q.id);
      continue;
    }
    q.answer = ans;
    q.how = x.how;
    lines.push(`${q.id} ${q.title}：${ans}`);
  }
  for (const x of p.facts) {
    const f = g.facts.find((y) => y.id === x.id && y.status === 'unconfirmed');
    if (!f) continue;
    if (x.status === 'corrected' && !x.correction) throw new Error(`${f.id} 要更正：请写明正确的说法`);
    f.status = x.status;
    if (x.correction) f.correction = x.correction;
    f.lateAt = at;
    // a fact confirmed late was not used before: the work may now rely on it, so it counts as a change too
    lines.push(`${f.id} ${truncate(f.text, 80)}：${factStatus(f)}`);
  }
  if (p.note) {
    g.notes.push(p.note);
    lines.push(`补充：${p.note}`);
  }
  if (!lines.length && !kept.length) throw new Error('没有补答任何问题');
  if (g.ended !== 'confirmed') g.minutes = mechanicalMinutes(g);
  rt.audit.record('emperor', 'grill_late_answer', { lines: lines.map((x) => truncate(x, 200)), kept, state: t.state }, t.id);
  if (!lines.length) {
    rt.activity('human', `皇上确认细问的推荐答案：${kept.join('、')}`, { taskId: t.id, agentId: g.by });
    rt.touch(t);
    return { rework: false, changed: 0 };
  }
  const text = `皇上补答细问：\n${lines.map((x) => `- ${x}`).join('\n')}`;
  if (TERMINAL.includes(t.state)) {
    rt.activity('human', `${text}\n（旨意已结束，只记录在案，不再返工）`, { taskId: t.id, agentId: g.by });
    rt.touch(t);
    return { rework: false, changed: lines.length };
  }
  giveOralOrder(rt, t.id, text);
  rt.activity('human', text, { taskId: t.id, agentId: g.by });
  const planned = t.planHistory.length > 0;
  if (planned) g.lateRework = { at, text: g.lateRework ? `${g.lateRework.text}\n${text}` : text };
  rt.touch(t);
  // waiting at the final 御批 (or a 成果 ruling): the late answer is the rejection
  if (planned && t.gate && ((t.state === 'PendingConfirm' && t.gate.kind === 'final') || (t.state === 'Review' && t.gate.kind === 'reject_limit'))) {
    const latest = latestExecByStart(t);
    const ids = (t.plan?.subtasks ?? []).filter((s) => (latest.get(s.id)?.startedAt ?? 0) < at).map((s) => s.id);
    g.lateRework = undefined;
    decideGate(rt, t.id, { approve: false, comment: reworkFeedback(text), reworkTargets: ids });
  }
  return { rework: planned, changed: lines.length };
}

const reworkFeedback = (text: string) => `${text}\n请按皇上补答调整成品：已经符合的部分不必重做，不符合的改过来，并在结论里写明改了什么。`;

/** The latest finished exec / fan-out node per subtask. */
function latestExecByStart(t: Task): Map<string, RunNode> {
  const m = new Map<string, RunNode>();
  for (const n of t.nodes) if (n.kind === 'exec' && n.subtaskId && n.status === 'done') {
    const prev = m.get(n.subtaskId);
    if (!prev || (n.startedAt ?? 0) >= (prev.startedAt ?? 0)) m.set(n.subtaskId, n);
  }
  return m;
}

/**
 * Before the result is reported: a late answer that came after some subtasks had started sends those back for
 * rework. Null when there is none, or when every subtask started after it (they already worked from it).
 */
export function takeLateRework(rt: Runtime, t: Task, latest: (subtaskId: string) => RunNode | undefined): { ids: string[]; feedback: string } | null {
  const lr = t.grill?.lateRework;
  if (!lr) return null;
  t.grill!.lateRework = undefined;
  rt.touch(t);
  const ids = (t.plan?.subtasks ?? []).filter((s) => {
    const n = latest(s.id);
    return !!n && (n.startedAt ?? 0) < lr.at;
  }).map((s) => s.id);
  if (!ids.length) return null;
  rt.audit.record('emperor', 'grill_late_rework', { targets: ids }, t.id);
  return { ids, feedback: reworkFeedback(lr.text) };
}
