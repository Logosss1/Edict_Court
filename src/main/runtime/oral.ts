// 口谕: the emperor corrects an edict while it runs. The words reach the officials working on it at their
// next step (as an annotation), and every later prompt that quotes the edict (review, 对照检查, 回奏) carries
// them too, so a reviewer does not hold the ministries to a requirement the emperor has since dropped.
import type { AgentId, Task } from '../../shared/types';
import { TERMINAL, agentName } from '../../shared/court';
import type { Runtime } from './runtime';
import { now, truncate } from './util';

/** The 口谕 given so far, as a prompt block ('' when none). */
export function oralText(t: Task): string {
  const list = t.orals ?? [];
  if (!list.length) return '';
  return `【皇上口谕】（办理途中追加，优先于上面的旨意；与旨意或验收标准冲突时以口谕为准）\n${list.map((o) => `- ${o.text}`).join('\n')}`;
}

/** 细问纪要 once 细问 is over, as a prompt block ('' before that, or when there was none). */
export function grillBlock(t: Task): string {
  const g = t.grill;
  if (!g || g.status !== 'done' || !g.minutes) return '';
  const head = `【细问纪要】（规划前${g.name}向皇上问清的事，与旨意同等效力；没经皇上确认的事实不作依据）`;
  return `${head}\n${g.minutes.trim()}`;
}

/** 【旨意】 block for prompts: title, the edict (optionally cut), then 细问纪要 and any 口谕. */
export function edictBlock(t: Task, max?: number): string {
  const oral = oralText(t);
  const grill = grillBlock(t);
  return `【旨意】${t.title}\n${max ? truncate(t.edict, max) : t.edict}${grill ? `\n\n${grill}` : ''}${oral ? `\n\n${oral}` : ''}`;
}

export interface OralResult {
  /** officials it was handed to right away; empty = the next official to start reads it */
  to: string[];
  /** why nobody reads it at once: paused, waiting on the emperor, blocked */
  waiting?: 'paused' | 'gate' | 'blocked' | 'idle';
}

export function giveOralOrder(rt: Runtime, taskId: string, text: string): OralResult {
  const t = rt.tasks.get(taskId);
  if (!t) throw new Error('旨意不存在');
  const words = text.trim();
  if (!words) throw new Error('口谕是空的');
  if (TERMINAL.includes(t.state)) throw new Error('这道旨意已经结束，请新下一道旨意');
  t.orals = [...(t.orals ?? []), { text: truncate(words, 2000), at: now() }];
  const running = [...new Set(t.nodes.filter((n) => n.status === 'running').map((n) => n.agentId))] as AgentId[];
  // hand it to whoever is working now; with nobody at work, the next official to start on this edict reads it
  if (running.length) for (const agentId of running) rt.annotate(agentId, words, t.id, { oral: true });
  else rt.annotate(t.tier === 'solo' ? 'solo' : 'zhongshu', words, t.id, { oral: true, anyAgent: true });
  rt.audit.record('emperor', 'oral_order', { text: truncate(words, 300), to: running }, t.id);
  rt.touch(t);
  const waiting: OralResult['waiting'] = t.paused ? 'paused' : t.gate ? 'gate' : t.state === 'Blocked' ? 'blocked' : running.length ? undefined : 'idle';
  return { to: running.map(agentName), waiting };
}
