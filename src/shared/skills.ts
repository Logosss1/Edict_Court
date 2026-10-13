// Which skills an official carries: fixed duty skills (职责技能) plus extras the emperor equipped.
import type { AgentId, SkillInfo } from './types';

/** Officials that can carry skills (太子 only triages; 早朝 is a ceremony). */
export const SKILL_AGENTS: AgentId[] = ['zhongshu', 'menxia', 'shangshu', 'libu', 'hubu', 'libu_hr', 'bingbu', 'xingbu', 'gongbu', 'solo'];

export function skillRole(s: SkillInfo, agentId: AgentId): 'duty' | 'extra' | null {
  if (s.enabled === false || !SKILL_AGENTS.includes(agentId)) return null;
  if (s.duty?.includes(agentId)) return 'duty';
  if (s.agents === 'all' || s.agents.includes(agentId)) return 'extra';
  return null;
}

export const skillsOf = (skills: SkillInfo[], agentId: AgentId) => skills.filter((s) => skillRole(s, agentId));
