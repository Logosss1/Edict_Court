// Court constants: agents (三省六部), state labels, and the protected state machine.
import type { AgentId, MinistryId, TaskState, Tier, ModelClass } from './types';

export interface AgentMeta {
  id: AgentId;
  name: string; // 太子 / 中书省 ...
  official: string; // 官职称谓 used in court scenes
  duty: string;
  emoji: string;
  color: string; // UI accent
  robe: 'yellow' | 'purple' | 'crimson' | 'green' | 'blue' | 'teal' | 'black';
  modelClass: ModelClass;
  group: 'prince' | 'sansheng' | 'liubu' | 'other';
}

export const AGENTS: AgentMeta[] = [
  { id: 'taizi', name: '太子', official: '太子殿下', duty: '消息分拣、旨意提炼', emoji: '🤴', color: '#e0a526', robe: 'crimson', modelClass: 'economy', group: 'prince' },
  { id: 'zhongshu', name: '中书省', official: '中书令', duty: '接旨、规划、拆解子任务', emoji: '📜', color: '#8b5cf6', robe: 'purple', modelClass: 'strong', group: 'sansheng' },
  { id: 'menxia', name: '门下省', official: '侍中', duty: '审议方案、准奏 / 封驳', emoji: '🔍', color: '#ef4444', robe: 'purple', modelClass: 'strong', group: 'sansheng' },
  { id: 'shangshu', name: '尚书省', official: '尚书令', duty: '派发任务、协调六部、汇总回奏', emoji: '📮', color: '#3b82f6', robe: 'purple', modelClass: 'economy', group: 'sansheng' },
  { id: 'hubu', name: '户部', official: '户部尚书', duty: '数据、资源、核算', emoji: '💰', color: '#f59e0b', robe: 'crimson', modelClass: 'economy', group: 'liubu' },
  { id: 'libu', name: '礼部', official: '礼部尚书', duty: '文档、规范、报告', emoji: '📝', color: '#10b981', robe: 'crimson', modelClass: 'economy', group: 'liubu' },
  { id: 'bingbu', name: '兵部', official: '兵部尚书', duty: '代码、算法、功能实现', emoji: '⚔️', color: '#dc2626', robe: 'crimson', modelClass: 'economy', group: 'liubu' },
  { id: 'xingbu', name: '刑部', official: '刑部尚书', duty: '安全、合规、测试与审计', emoji: '⚖️', color: '#6366f1', robe: 'green', modelClass: 'economy', group: 'liubu' },
  { id: 'gongbu', name: '工部', official: '工部尚书', duty: 'CI/CD、部署、工具与基建', emoji: '🔧', color: '#0ea5e9', robe: 'green', modelClass: 'economy', group: 'liubu' },
  { id: 'libu_hr', name: '吏部', official: '吏部尚书', duty: 'Agent 管理、技能与权限维护', emoji: '📋', color: '#a855f7', robe: 'teal', modelClass: 'economy', group: 'liubu' },
  { id: 'zaochao', name: '早朝官', official: '鸿胪寺卿', duty: '早朝仪式、天下要闻汇总', emoji: '🌅', color: '#f97316', robe: 'blue', modelClass: 'economy', group: 'other' },
  { id: 'solo', name: '独相', official: '同中书门下平章事', duty: 'Solo 单 Agent：直接对话、读写文件、执行命令', emoji: '🧑‍💻', color: '#14b8a6', robe: 'purple', modelClass: 'strong', group: 'other' },
];

export const AGENT_MAP: Record<AgentId, AgentMeta> = Object.fromEntries(AGENTS.map((a) => [a.id, a])) as Record<AgentId, AgentMeta>;

export const MINISTRIES: MinistryId[] = ['hubu', 'libu', 'bingbu', 'xingbu', 'gongbu', 'libu_hr'];

export const STATE_LABEL: Record<TaskState, string> = {
  Pending: '待分拣',
  Taizi: '太子分拣',
  Zhongshu: '中书规划',
  Menxia: '门下审议',
  Assigned: '尚书派发',
  Next: '待执行',
  Doing: '六部执行',
  Review: '汇总待审',
  PendingConfirm: '待皇上御批',
  Done: '已完成',
  Blocked: '阻塞',
  Cancelled: '已取消',
};

export const STATE_COLOR: Record<TaskState, string> = {
  Pending: '#94a3b8',
  Taizi: '#e0a526',
  Zhongshu: '#8b5cf6',
  Menxia: '#ef4444',
  Assigned: '#3b82f6',
  Next: '#64748b',
  Doing: '#f97316',
  Review: '#14b8a6',
  PendingConfirm: '#eab308',
  Done: '#22c55e',
  Blocked: '#b91c1c',
  Cancelled: '#6b7280',
};

export const KANBAN_COLUMNS: { key: string; label: string; states: TaskState[] }[] = [
  { key: 'taizi', label: '太子分拣', states: ['Pending', 'Taizi'] },
  { key: 'zhongshu', label: '中书省', states: ['Zhongshu'] },
  { key: 'menxia', label: '门下省', states: ['Menxia'] },
  { key: 'assigned', label: '尚书派发', states: ['Assigned', 'Next'] },
  { key: 'doing', label: '六部执行', states: ['Doing'] },
  { key: 'review', label: '待审 · 御批', states: ['Review', 'PendingConfirm'] },
  { key: 'blocked', label: '阻塞', states: ['Blocked'] },
  { key: 'done', label: '已完成', states: ['Done', 'Cancelled'] },
];

// Canonical Edict transitions (mirrors edict/backend/app/models/task.py STATE_TRANSITIONS).
export const BASE_TRANSITIONS: Record<TaskState, TaskState[]> = {
  Pending: ['Taizi', 'Cancelled'],
  Taizi: ['Zhongshu', 'Cancelled'],
  Zhongshu: ['Menxia', 'Cancelled', 'Blocked'],
  Menxia: ['Assigned', 'Zhongshu', 'Cancelled', 'Blocked'],
  Assigned: ['Doing', 'Next', 'Blocked', 'Cancelled'],
  Next: ['Doing', 'Blocked', 'Cancelled'],
  Doing: ['Review', 'Done', 'Blocked', 'Cancelled'],
  Review: ['Done', 'Menxia', 'Doing', 'Cancelled', 'PendingConfirm', 'Blocked'],
  PendingConfirm: ['Done', 'Review', 'Cancelled'],
  Blocked: ['Taizi', 'Zhongshu', 'Menxia', 'Assigned', 'Next', 'Doing', 'Review', 'Cancelled'],
  Done: [],
  Cancelled: [],
};

// Tier-specific extra edges. Solo has no court: Pending → Doing directly.
export const TIER_EXTRA: Record<Tier, Partial<Record<TaskState, TaskState[]>>> = {
  solo: { Pending: ['Doing'] },
  lite: {},
  full: {},
};

// Transitions that must never be taken automatically by an agent (need a human actor).
export const HUMAN_ONLY: Array<[TaskState, TaskState]> = [
  ['PendingConfirm', 'Done'],
  ['Doing', 'Cancelled'],
  ['Menxia', 'Cancelled'],
];

export const TERMINAL: TaskState[] = ['Done', 'Cancelled'];

export const TIER_LABEL: Record<Tier, string> = { solo: 'Solo 单 Agent', lite: 'Court Lite 简化三省', full: 'Full Court 完整三省六部' };
export const TIER_SHORT: Record<Tier, string> = { solo: 'Solo', lite: 'Court Lite', full: 'Full Court' };

export function agentName(id: string): string {
  if (id === 'emperor') return '皇上';
  if (id === 'system') return '系统';
  return AGENT_MAP[id as AgentId]?.name ?? id;
}
