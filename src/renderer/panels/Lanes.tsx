// 排班 (2.1): the plan card's lanes editor (2–3 lanes for one write subtask) and the 比试 page (each lane's
// work side by side, 门下省's scores, pick one).
import { useEffect, useState } from 'react';
import type { AttemptLane, LaneSpec, MinistryId, ModelRef, RunNode, Subtask, SubtaskAttempts, Task } from '../../shared/types';
import { AGENT_MAP } from '../../shared/court';
import { call } from '../api';
import { openTab, setUI, toast, openTaskTab, useStore } from '../store';
import { Icon } from '../common/Icon';
import { ModelSelect, useModelShort } from '../common/ModelPick';
import { guestLabel, useGuests, type GuestInfo } from '../common/guests';
import { fmtCost, fmtDur } from '../common/format';

export const LANE_LABELS = ['甲', '乙', '丙'];

/** 排班 buttons on the plan card: Full Court always, Court Lite when switched on in settings; never Solo. */
export const lanesOffered = (task: Task | undefined, gi: GuestInfo | null) => !!task && (task.tier === 'full' || (task.tier === 'lite' && !!gi?.settings.attemptsInLite));

function whoText(gi: GuestInfo | null, dept: string, l: { executor: string; model?: ModelRef | null }, short: (r: ModelRef) => string) {
  if (l.executor && l.executor !== 'self') return `客卿 ${guestLabel(gi, l.executor)}`;
  return `${AGENT_MAP[dept as MinistryId]?.name ?? dept}官员${l.model ? `（${short(l.model)}）` : ''}`;
}

interface Estimate { lanes: { who: string; costUsd: number | null }[]; judgeUsd: number; totalUsd: number }

/** One write subtask's lanes on the plan card: who does each lane (and with which model), the cost estimate. */
export function LanesEditor({ sub, readOnly, onChange }: { sub: Subtask; readOnly?: boolean; onChange: (lanes: LaneSpec[] | undefined) => void }) {
  const gi = useGuests();
  const short = useModelShort();
  const lanes = sub.lanes ?? [];
  const usable = (gi?.guests ?? []).filter((g) => g.enabled && g.found);
  const [est, setEst] = useState<Estimate | null>(null);
  const key = JSON.stringify([sub.dept, lanes]);
  useEffect(() => {
    if (!lanes.length || readOnly) return setEst(null);
    let alive = true;
    const t = setTimeout(() => void call<Estimate>('estimateLanes', sub.dept, lanes).then((r) => alive && setEst(r)).catch(() => alive && setEst(null)), 250);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [key, readOnly]); // eslint-disable-line react-hooks/exhaustive-deps
  if (readOnly) {
    if (!lanes.length) return null;
    return <div className="pe-lanes ro muted small" data-testid={`pe-lanes-${sub.id}`}>排班 {lanes.length} 路：{lanes.map((l, i) => `${LANE_LABELS[i]} ${whoText(gi, sub.dept, l, short)}`).join('、')}</div>;
  }
  if (!lanes.length) return null;
  const set = (i: number, patch: Partial<LaneSpec>) => onChange(lanes.map((l, k) => (k === i ? { ...l, ...patch } : l)));
  return (
    <div className="pe-lanes" data-testid={`pe-lanes-${sub.id}`}>
      <div className="pe-lanes-h">
        <b>排班</b>
        <span className="muted small">各路在自己的工作树里同时办，办完门下省评分，你选一路合入</span>
      </div>
      {lanes.map((l, i) => (
        <div key={i} className="pe-lane" data-testid={`pe-lane-${sub.id}-${i}`}>
          <span className="pe-lane-k">{LANE_LABELS[i]}路</span>
          <select className="input sm" value={l.executor || 'self'} onChange={(e) => set(i, { executor: e.target.value, model: e.target.value === 'self' ? l.model : undefined })} data-testid={`pe-lane-exec-${sub.id}-${i}`}>
            <option value="self">{AGENT_MAP[sub.dept]?.name ?? sub.dept}官员</option>
            {usable.map((g) => <option key={g.id} value={g.id}>客卿 {g.name}</option>)}
            {l.executor && l.executor !== 'self' && !usable.some((g) => g.id === l.executor) && <option value={l.executor}>客卿 {guestLabel(gi, l.executor)}（不可用）</option>}
          </select>
          {(l.executor || 'self') === 'self' ? (
            <ModelSelect value={l.model ?? null} onChange={(m) => set(i, { model: m })} allowDefault="本部的模型" className="input sm pe-lane-model" testid={`pe-lane-model-${sub.id}-${i}`} />
          ) : (
            <span className="muted small pe-lane-model">用它自己的模型和账号</span>
          )}
          {est?.lanes[i] && est.lanes[i].costUsd !== null && <span className="muted small nowrap">约 {fmtCost(est.lanes[i].costUsd!)}</span>}
          {lanes.length > 2 && <button className="icon-btn" title="去掉这一路" onClick={() => onChange(lanes.filter((_, k) => k !== i))}><Icon name="x" size={12} /></button>}
        </div>
      ))}
      <div className="pe-lanes-f">
        {lanes.length < 3 && <button className="btn sm" onClick={() => onChange([...lanes, { executor: 'self' }])} data-testid={`pe-lane-add-${sub.id}`}><Icon name="plus" size={12} /> 再加一路</button>}
        <button className="btn sm" onClick={() => onChange(undefined)} data-testid={`pe-lanes-off-${sub.id}`}>取消排班</button>
        {est && <span className="muted small" data-testid={`pe-lanes-est-${sub.id}`}>预估：这个子任务约 {fmtCost(est.totalUsd)}（含门下评比 {fmtCost(est.judgeUsd)}）{est.lanes.some((l) => l.costUsd === null) ? '，客卿的费用另计在它们自己的账号上' : ''}</span>}
      </div>
    </div>
  );
}

/** Start 排班 for a subtask: its current executor as 甲路, the ministry's official as 乙路 (the emperor changes either). */
export const startLanes = (sub: Subtask): LaneSpec[] => [{ executor: sub.executor || 'self' }, { executor: 'self' }];

const STATUS: Record<SubtaskAttempts['status'], string> = { running: '各路办差中', judging: '门下评比中', choosing: '等你选一路', applied: '已合入', failed: '没有采用' };

/** Open the task tab on its 比试 page. */
export function openAttempts(taskId: string) {
  setUI({ taskDetailTab: { taskId, tab: 'attempts' } });
  openTaskTab(taskId);
}

/** 比试: each 排班 of the edict, its lanes side by side; pick one while 门下省's card waits. */
export function AttemptsPanel({ task }: { task: Task }) {
  const list = [...(task.attempts ?? [])].reverse();
  if (!list.length) return <div className="muted small pad">这道旨意没有排班。御览方案时，可在写入类子任务旁点「排班」让几路人马同时各办一份。</div>;
  return (
    <div className="att-list" data-testid="attempts-panel">
      {list.map((rec) => <AttemptCard key={rec.id} task={task} rec={rec} />)}
    </div>
  );
}

function AttemptCard({ task, rec }: { task: Task; rec: SubtaskAttempts }) {
  const gi = useGuests();
  const short = useModelShort();
  const pendingAp = useStore((s) => s.approvals.find((a) => a.status === 'pending' && a.kind === 'attempt' && a.tool === `attempt:${rec.id}`));
  const [keep, setKeep] = useState(false);
  const [busy, setBusy] = useState(false);
  const sub = task.plan?.subtasks.find((s) => s.id === rec.subtaskId);
  const dept = sub?.dept ?? 'bingbu';
  const node = (l: AttemptLane): RunNode | undefined => task.nodes.find((n) => n.id === l.nodeId);
  const choosing = rec.status === 'choosing' && !!pendingAp;
  const pick = async (laneId: string | null) => {
    setBusy(true);
    try {
      await call('chooseAttempt', task.id, laneId, { keepOthers: keep, attemptsId: rec.id });
      toast(laneId ? `已采用${rec.lanes.find((l) => l.id === laneId)?.label}路` : '各路都不用，这个子任务记为失败', laneId ? 'success' : 'warn');
    } catch (e) {
      toast((e as Error).message, 'error');
    }
    setBusy(false);
  };
  const showDiff = async (l: AttemptLane) => {
    try {
      const text = await call<string>('attemptDiff', task.id, l.id);
      openTab({ id: `att:${l.id}`, kind: 'diff', title: `${sub?.title ?? rec.subtaskId} · ${l.label}路`, diff: { original: '', modified: text, path: `${l.label}路.diff`, label: `${l.label}路相对排班起点的改动` } });
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  return (
    <div className={`att-card st-${rec.status}`} data-testid={`attempt-${rec.id}`}>
      <div className="att-h">
        <b>{rec.subtaskId} · {sub?.title ?? ''}</b>
        <span className={`chip chip-sm ${rec.status === 'choosing' ? 'warn' : rec.status === 'applied' ? 'ok' : ''}`}>{STATUS[rec.status]}</span>
        <span className="muted small">排班 {rec.lanes.length} 路{rec.round > 1 ? ` · 第 ${rec.round} 轮` : ''}</span>
      </div>
      {rec.judgeNote && <div className="att-note small"><Icon name="gavel" size={12} /> 门下省：{rec.judgeNote}</div>}
      {rec.error && <div className="att-note small bad">{rec.error}</div>}
      <div className="att-lanes">
        {rec.lanes.map((l) => {
          const n = node(l);
          const isPick = rec.pick === l.id;
          const isRec = rec.recommended === l.id;
          return (
            <div key={l.id} className={`att-lane ${isPick ? 'picked' : ''} ${isRec ? 'rec' : ''}`} data-testid={`attempt-lane-${l.label}`}>
              <div className="att-lane-h">
                <b>{l.label}路</b>
                <span className="ellipsis">{whoText(gi, dept, l, short)}</span>
                {isPick && <span className="chip chip-sm ok">已采用</span>}
                {!isPick && isRec && <span className="chip chip-sm">门下推荐</span>}
              </div>
              <div className="att-score">{l.score !== undefined ? <><b>{l.score}</b><span className="muted small"> 分</span></> : <span className="muted small">{n?.status === 'failed' ? '没有办成' : n?.status === 'running' ? '办差中…' : n?.status === 'done' ? '未评分' : '待开工'}</span>}</div>
              {l.comment && <div className="small">{l.comment}</div>}
              {n?.status === 'failed' && n.error && <div className="small bad ellipsis" title={n.error}>{n.error}</div>}
              <div className="muted small att-meta">
                {l.diff ? `${l.diff.files} 个文件 +${l.diff.added} −${l.diff.removed}` : '—'}
                {n?.startedAt ? ` · ${fmtDur(n.startedAt, n.endedAt)}` : ''}
                {n?.usage?.costUsd ? ` · ${fmtCost(n.usage.costUsd)}` : n?.guest ? ' · 费用记它自己的账号' : ''}
              </div>
              <div className="att-acts">
                {l.diffHash && <button className="btn sm" onClick={() => void showDiff(l)} data-testid={`attempt-diff-${l.label}`}><Icon name="diff" size={12} /> 看改动</button>}
                {choosing && l.tree !== undefined && n?.status === 'done' && (
                  <button className={`btn sm ${isRec ? 'primary' : ''}`} disabled={busy} onClick={() => void pick(l.id)} data-testid={`attempt-pick-${l.label}`}>采用这一路</button>
                )}
                {l.worktree?.status === 'kept' && <span className="muted small" title={l.worktree.branch}>分支已保留：<code>{l.worktree.branch}</code></span>}
              </div>
            </div>
          );
        })}
      </div>
      {choosing && (
        <div className="att-foot">
          <label className="small row-gap"><input type="checkbox" checked={keep} onChange={(e) => setKeep(e.target.checked)} data-testid="attempt-keep" /> 落选的各路保留为分支（以后可在源代码管理里看）</label>
          <span className="grow" />
          <button className="btn sm" disabled={busy} onClick={() => void pick(null)} data-testid="attempt-none">都不用</button>
        </div>
      )}
      {rec.conflicts?.length ? <div className="att-note small warn">与其他子任务的改动冲突、没有合入：{rec.conflicts.join('、')}</div> : null}
    </div>
  );
}
