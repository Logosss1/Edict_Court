// Court model: the slice of runtime state the pixel scenes render. Built from the same
// store as the workbench, so both modes always show identical progress.
import type { AgentId, AgentRuntime, ApprovalRequest, Debate, NewsItem, Task, Memorial, Activity } from '../../../shared/types';
import type { PanelId } from '../../store';

export type SceneKey = 'taihe' | 'junjichu' | 'liubu' | 'chengtian';
export type Weather = 'clear' | 'rain' | 'snow' | 'petals';
export type SoundCue = 'drum' | 'bell' | 'meow' | 'chirp' | 'chime' | 'gong';

/** the world is 640×360 units; art is drawn at 2× detail */
export const WORLD_W = 640;
export const WORLD_H = 360;
export const DETAIL = 2;

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
  /** pointer over / off an official — world coords of the head */
  hoverAgent: (h: { id: AgentId; x: number; y: number } | null) => void;
  /** official clicked: open the little action menu at world coords */
  agentMenu: (id: AgentId, x: number, y: number) => void;
  openPanel: (id: PanelId) => void;
  showHistory: (id: AgentId) => void;
  gotoScene: (key: SceneKey) => void;
  sound: (cue: SoundCue) => void;
  replayDone: () => void;
}

export const FONT = 'FusionPixel, "PingFang SC", monospace';
