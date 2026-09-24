// 六部值房 embedded screen: the ministry's live thinking, tool calls and latest diff,
// positioned exactly over the hanging scroll in the pixel scene.
import { openPanel } from '../store';
import { useStore, setUI } from '../store';
import type { AgentId } from '../../shared/types';
import { AGENT_MAP } from '../../shared/court';
import { ActivityStream } from '../workbench/ActivityStream';
import { ChangesList } from '../panels/TaskWidgets';
import { statusLabel } from '../panels/Monitor';

export function LiubuScreen({ dept, zoom }: { dept: AgentId; zoom: number }) {
  const a = useStore((s) => s.agents.find((x) => x.id === dept));
  const task = useStore((s) => {
    if (a?.taskId) return s.tasks.find((t) => t.id === a.taskId);
    return [...s.tasks].filter((t) => t.nodes.some((n) => n.agentId === dept)).sort((x, y) => y.updatedAt - x.updatedAt)[0];
  });
  const [x, y, w, h] = [194, 36, 422, 206];
  const mine = task ? { ...task, changes: task.changes.filter((c) => c.agentId === dept) } : undefined;
  return (
    <div className="liubu-screen pixel" style={{ left: x * zoom, top: y * zoom, width: w * zoom, height: h * zoom }} data-testid="liubu-screen">
      <div className="ls-head">
        <b>{AGENT_MAP[dept].official}</b>
        <span className="px-muted">{a ? statusLabel(a.status) : ''}{a?.activity ? ` · ${a.activity}` : ''}</span>
        <span style={{ flex: 1 }} />
        <button className="px-btn sm" onClick={() => setUI({ agentDialog: dept })}>召见</button>
        {dept === 'libu_hr' && <button className="px-btn sm" title="吏部掌官员之能：技能与 MCP 工具" onClick={() => { setUI({ mode: 'workbench' }); openPanel('skills'); }}>技能与 MCP</button>}
      </div>
      {task ? <div className="px-muted ls-task">差事：{task.title}（{task.id}）</div> : <div className="px-muted ls-task">暂无差事</div>}
      <div className="ls-body">
        <div className="ls-stream"><ActivityStream taskId={task?.id} agentFilter={dept} compact limit={150} /></div>
        {mine && mine.changes.length > 0 && <div className="ls-changes"><ChangesList task={mine} /></div>}
      </div>
    </div>
  );
}
