// 六部院 room panel: the ministry's live thinking, tool calls and latest diff. It floats over the
// courtyard on the side away from the room the emperor walked into, and closes with ×.
import { openPanel } from '../store';
import { useStore, setUI } from '../store';
import type { AgentId } from '../../shared/types';
import { AGENT_MAP } from '../../shared/court';
import { ActivityStream } from '../workbench/ActivityStream';
import { ChangesList } from '../panels/TaskWidgets';
import { statusLabel } from '../panels/Monitor';

/** rooms on the right of the courtyard get the panel on the left, and the other way round */
const RIGHT_ROOMS = new Set<string>(['bingbu', 'libu_hr']);

export function LiubuScreen({ dept, zoom, onClose }: { dept: AgentId; zoom: number; onClose: () => void }) {
  const a = useStore((s) => s.agents.find((x) => x.id === dept));
  const task = useStore((s) => {
    if (a?.taskId) return s.tasks.find((t) => t.id === a.taskId);
    return [...s.tasks].filter((t) => t.nodes.some((n) => n.agentId === dept)).sort((x, y) => y.updatedAt - x.updatedAt)[0];
  });
  const [w, h] = [236, 196];
  const [x, y] = [RIGHT_ROOMS.has(dept) ? 8 : 640 - w - 8, 24];
  const mine = task ? { ...task, changes: task.changes.filter((c) => c.agentId === dept) } : undefined;
  return (
    <div className="liubu-screen pixel" style={{ left: x * zoom, top: y * zoom, width: w * zoom, height: h * zoom }} data-testid="liubu-screen">
      <div className="ls-head">
        <b>{AGENT_MAP[dept].official}</b>
        <span className="px-muted">{a ? statusLabel(a.status) : ''}{a?.activity ? ` · ${a.activity}` : ''}</span>
        <span style={{ flex: 1 }} />
        <button className="px-btn sm" onClick={() => setUI({ agentDialog: dept })}>召见</button>
        {dept === 'libu_hr' && <button className="px-btn sm" title="吏部掌官员之能：技能与 MCP 工具" onClick={() => { setUI({ mode: 'workbench' }); openPanel('skills'); }}>技能与 MCP</button>}
        <button className="px-x" onClick={onClose} title="收起" data-testid="liubu-screen-close">×</button>
      </div>
      {task ? <div className="px-muted ls-task">差事：{task.title}（{task.id}）</div> : <div className="px-muted ls-task">暂无差事</div>}
      <div className="ls-body">
        <div className="ls-stream"><ActivityStream taskId={task?.id} agentFilter={dept} compact limit={150} /></div>
        {mine && mine.changes.length > 0 && <div className="ls-changes"><ChangesList task={mine} /></div>}
      </div>
    </div>
  );
}
