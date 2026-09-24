// 朝堂议政 — multi-official LLM debate with live emperor interjections (L2).
import type { AgentId, Debate, DebateMessage } from '../../shared/types';
import { AGENT_MAP, agentName } from '../../shared/court';
import { runAgent } from './agentLoop';
import { DEBATE_RULE } from './souls';
import type { Runtime } from './runtime';
import { now, truncate, uid } from './util';

const running = new Set<string>();

export function createDebate(rt: Runtime, o: { topic: string; participants?: AgentId[]; taskId?: string; maxRounds?: number }): Debate {
  const participants = (o.participants?.length ? o.participants : (['zhongshu', 'menxia', 'shangshu', 'bingbu', 'xingbu'] as AgentId[])).filter((p) => AGENT_MAP[p] && p !== 'solo');
  const d: Debate = {
    id: uid('db'), topic: o.topic, taskId: o.taskId, participants, messages: [], round: 0, maxRounds: Math.max(1, o.maxRounds ?? rt.settings.debateRounds),
    status: 'idle', createdAt: now(), updatedAt: now(), pendingInterjections: [],
  };
  d.messages.push({ id: uid('dm'), speaker: 'system', content: `朝堂议政开始。议题：${o.topic}`, at: now(), round: 0, kind: 'system' });
  rt.debates.set(d.id, d);
  rt.audit.record('emperor', 'debate_created', { debateId: d.id, topic: truncate(o.topic, 200), participants }, o.taskId);
  emitDebate(rt, d);
  return d;
}

let emitTimers = new Map<string, NodeJS.Timeout>();
function emitDebate(rt: Runtime, d: Debate, throttle = false) {
  d.updatedAt = now();
  if (!throttle) {
    const tm = emitTimers.get(d.id);
    if (tm) clearTimeout(tm);
    emitTimers.delete(d.id);
    rt.emit({ type: 'debate', debate: d });
    rt.persist();
    return;
  }
  if (emitTimers.has(d.id)) return;
  emitTimers.set(
    d.id,
    setTimeout(() => {
      emitTimers.delete(d.id);
      rt.emit({ type: 'debate', debate: d });
    }, 120),
  );
}

function getDebate(rt: Runtime, id: string): Debate {
  const d = rt.debates.get(id);
  if (!d) throw new Error('议政不存在');
  return d;
}

function transcript(d: Debate, max = 14): string {
  return d.messages
    .slice(-max)
    .map((m) => (m.kind === 'emperor' ? `【皇上口谕】${m.content}` : m.kind === 'system' ? `（${m.content}）` : `${agentName(m.speaker)}：${m.content}`))
    .join('\n');
}

async function speak(rt: Runtime, d: Debate, speaker: AgentId): Promise<void> {
  const task = d.taskId ? rt.tasks.get(d.taskId) : undefined;
  const pendingEmperor = d.messages.filter((m) => d.pendingInterjections.includes(m.id));
  const meta = AGENT_MAP[speaker];
  const prompt = [
    `【议题】${d.topic}`,
    `【你的身份】${meta.official}（${meta.name}），职责：${meta.duty}`,
    `【朝堂记录（最近）】\n${transcript(d) || '（尚无发言）'}`,
    pendingEmperor.length ? `【皇上口谕 · 须先回应】\n${pendingEmperor.map((m) => m.content).join('\n')}` : '',
    `第 ${d.round} 轮发言。${DEBATE_RULE}`,
  ].filter(Boolean).join('\n\n');
  const msg: DebateMessage = { id: uid('dm'), speaker, content: '', at: now(), round: d.round, kind: 'official', repliesTo: pendingEmperor.at(-1)?.id };
  d.messages.push(msg);
  d.speaking = speaker;
  emitDebate(rt, d);
  const r = await runAgent({
    rt, agentId: speaker, task, prompt, maxTokens: 500, temperature: 0.7, label: '朝堂议政',
    onText: (delta) => {
      msg.content += delta;
      emitDebate(rt, d, true);
    },
  });
  msg.content = r.text.trim() || msg.content || '（臣无异议）';
  d.speaking = undefined;
  // an interjection is considered answered once two officials (or everyone) have responded to it
  for (const id of [...d.pendingInterjections]) {
    const n = d.messages.filter((m) => m.repliesTo === id).length;
    if (n >= Math.min(2, d.participants.length)) d.pendingInterjections = d.pendingInterjections.filter((x) => x !== id);
  }
  emitDebate(rt, d);
}

/** Run rounds until maxRounds reached (or `extraRounds` more rounds), pausing/concluding when asked. */
export async function runDebate(rt: Runtime, id: string, extraRounds?: number): Promise<void> {
  const d = getDebate(rt, id);
  if (running.has(id)) return;
  if (d.status === 'concluded') return;
  running.add(id);
  d.status = 'running';
  emitDebate(rt, d);
  const target = extraRounds ? d.round + extraRounds : Math.max(d.maxRounds, d.round);
  try {
    while (d.round < target) {
      d.round++;
      d.messages.push({ id: uid('dm'), speaker: 'system', content: `第 ${d.round} 轮`, at: now(), round: d.round, kind: 'system' });
      emitDebate(rt, d);
      // officials who were addressed by the emperor speak first
      const order = [...d.participants];
      for (const sp of order) {
        if ((d.status as string) !== 'running') return;
        await speak(rt, d, sp);
      }
    }
    // unanswered interjections at the end of the planned rounds → one more responder
    if (d.pendingInterjections.length && (d.status as string) === 'running') await speak(rt, d, d.participants[0]);
  } finally {
    running.delete(id);
    if (d.status === 'running') d.status = 'idle';
    d.speaking = undefined;
    emitDebate(rt, d);
  }
}

export function interject(rt: Runtime, id: string, text: string): DebateMessage {
  const d = getDebate(rt, id);
  if (d.status === 'concluded') throw new Error('议政已结束');
  const m: DebateMessage = { id: uid('dm'), speaker: 'emperor', content: text.trim(), at: now(), round: d.round, kind: 'emperor' };
  d.messages.push(m);
  d.pendingInterjections.push(m.id);
  rt.audit.record('emperor', 'debate_interjection', { debateId: id, text: truncate(text, 400) }, d.taskId);
  rt.activity('human', `皇上于朝堂插话：${truncate(text, 120)}`, { taskId: d.taskId });
  emitDebate(rt, d);
  // officials respond: if idle, run one extra round so they debate the emperor's point
  if (!running.has(id) && d.status !== 'paused') void runDebate(rt, id, 1).catch((e) => rt.toast('error', `议政失败：${(e as Error).message}`));
  return m;
}

export function pauseDebate(rt: Runtime, id: string) {
  const d = getDebate(rt, id);
  if (d.status === 'running') d.status = 'paused';
  rt.audit.record('emperor', 'debate_paused', { debateId: id }, d.taskId);
  emitDebate(rt, d);
}

export async function concludeDebate(rt: Runtime, id: string): Promise<string> {
  const d = getDebate(rt, id);
  if (d.conclusion && d.status === 'concluded') return d.conclusion;
  if (d.status === 'running') d.status = 'paused';
  const task = d.taskId ? rt.tasks.get(d.taskId) : undefined;
  const msg: DebateMessage = { id: uid('dm'), speaker: 'zhongshu', content: '', at: now(), round: d.round, kind: 'conclusion' };
  d.messages.push(msg);
  d.speaking = 'zhongshu';
  emitDebate(rt, d);
  const r = await runAgent({
    rt, agentId: 'zhongshu', task, maxTokens: 1200, temperature: 0.3, label: '议政总结',
    prompt: `【议题】${d.topic}\n\n【完整朝堂记录】\n${truncate(transcript(d, 80), 12000)}\n\n请以中书令身份总结议政结论（Markdown）：## 共识 / ## 分歧与取舍 / ## 皇上口谕的落实 / ## 建议旨意（一句话，可直接下旨）。≤400字。`,
    onText: (delta) => {
      msg.content += delta;
      emitDebate(rt, d, true);
    },
  });
  msg.content = r.text.trim();
  d.conclusion = msg.content;
  d.status = 'concluded';
  d.speaking = undefined;
  rt.audit.record('zhongshu', 'debate_concluded', { debateId: id, conclusion: truncate(d.conclusion, 800) }, d.taskId);
  emitDebate(rt, d);
  return d.conclusion;
}
