// Court model: the slice of runtime state the pixel scenes render. Built from the same
// store as the workbench, so both modes always show identical progress.
import type { AgentId, AgentRuntime, ApprovalRequest, Debate, NewsItem, Task, Memorial, Activity } from '../../../shared/types';

export type SceneKey = 'taihe' | 'junjichu' | 'liubu' | 'chengtian';

export interface CourtModel {
  tasks: Task[];
  agents: Record<string, AgentRuntime>;
  approvals: ApprovalRequest[];
  debate: Debate | null;
  news: NewsItem[];
  memorials: Memorial[];
  selectedTaskId: string | null;
  dept: AgentId;
  ceremony: boolean;
  lastActivity: Record<string, Activity | undefined>; // per agent latest activity
  emperorSaid: { text: string; at: number } | null;
  totalsText: string;
}

export interface CourtEvents {
  clickAgent: (id: AgentId) => void;
  clickTask: (taskId: string) => void;
  openReview: (taskId: string) => void;
  clickApproval: (id: string) => void;
  clickNotice: (index: number) => void;
  ceremonyDone: () => void;
  sceneChanged: (key: SceneKey) => void;
}

export const FONT = 'FusionPixel, "PingFang SC", monospace';
