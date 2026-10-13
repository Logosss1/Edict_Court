// 旨意看板 (2.0): what needs you first, then every edict by phase (分拣·规划 → 审议 → 执行 → 回奏·御批 → 已结).
import { useMemo, useRef, useState } from 'react';
import { useStore, selectTask, openTaskTab, openPanel, setUI, toast } from '../store';
import { call } from '../api';
import { AGENT_MAP, TIER_SHORT, TERMINAL } from '../../shared/court';
import type { AgentRuntime, Task, TaskState, Tier } from '../../shared/types';
import { Icon } from '../common/Icon';
import { roleInfo } from '../common/roles';
import { StateChip, fmtAgo, fmtTokens, fmtCost, usageTokens, fmtTime } from '../common/format';
import { useAttention, type AttentionItem } from '../common/attention';
import { AttnCard } from '../workbench/Attention';
import { tip } from '../common/Tip';

export function heartbeatOf(t: Task): { label: string; color: string } {
  if (['Done', 'Cancelled'].includes(t.state)) return { label: '已结', color: '#6b7280' };
  if (t.gate || t.paused) return { label: t.paused ? '叫停' : '待批', color: '#e8b64c' };
  if (t.state === 'Blocked') return { label: '阻塞', color: '#ef4444' };
  const idle = Date.now() - t.lastActivityAt;
  if (idle < 60_000) return { label: '活跃', color: '#22c55e' };
  if (idle < 180_000) return { label: '停滞', color: '#eab308' };
  return { label: '告警', color: '#ef4444' };
}

type Phase = 'plan' | 'review' | 'exec' | 'report';
const PHASES: { key: Phase; label: string; who: string; states: TaskState[]; hint: [string, string] }[] = [
  { key: 'plan', label: '分拣 · 规划', who: '太子 · 中书', states: ['Pending', 'Taizi', 'Zhongshu'], hint: ['太子分拣 → 中书规划', '太子判断是不是旨意，中书省拆成子任务并标明只读 / 写入 / 验证'] },
  { key: 'review', label: '审议', who: '门下', states: ['Menxia'], hint: ['门下审议', '准奏后进入执行；封驳会带着理由退回中书重拟'] },
  { key: 'exec', label: '执行', who: '尚书 · 六部', states: ['Assigned', 'Next', 'Doing'], hint: ['尚书派发 → 六部执行', '只读的子任务并行；写文件的子任务开工前先问你'] },
  { key: 'report', label: '回奏 · 御批', who: '门下 · 皇上', states: ['Review', 'PendingConfirm'], hint: ['回奏 · 御批', '门下核验成果，再由你准奏结案或封驳返工'] },
];

/** The column a task sits in; a blocked task stays in the phase it was blocked in. */
export function phaseOf(t: Task): Phase | 'done' {
  if (TERMINAL.includes(t.state)) return 'done';
  const s = t.state === 'Blocked' ? t.resumeState ?? 'Doing' : t.state;
  return PHASES.find((p) => p.states.includes(s))?.key ?? 'exec';
}

/** Branch of the edict's own git worktree, when it has one. */
/** The edict's own git worktree branch, while the worktree is in use or awaiting its 结案 choice. */
export function wtBranch(t: Task): string | undefined {
  return t.worktree?.status === 'active' ? t.worktree.branch : undefined;
}

const startOfDay = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

type Filter = 'all' | 'mine' | 'running' | 'blocked' | 'worktree';

export function Kanban() {
  const tasks = useStore((s) => s.tasks);
  const agents = useStore((s) => s.agents);
  const memorials = useStore((s) => s.memorials.length);
  const view = useStore((s) => s.ui.kanbanView);
  const attn = useAttention();
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const today = startOfDay();

  const mineIds = useMemo(() => new Set(attn.map((a) => a.taskId).filter(Boolean) as string[]), [attn]);
  const live = tasks.filter((t) => !TERMINAL.includes(t.state));
  const counts = {
    all: tasks.length,
    mine: mineIds.size,
    running: live.filter((t) => t.state !== 'Blocked').length,
    blocked: live.filter((t) => t.state === 'Blocked').length,
    worktree: tasks.filter((t) => wtBranch(t)).length,
  };
  const match = (t: Task) => {
    if (q && !`${t.title}\n${t.edict}\n${t.id}\n${wtBranch(t) ?? ''}\n${t.nodes.map((n) => n.label).join(' ')}`.toLowerCase().includes(q.toLowerCase())) return false;
    if (filter === 'mine') return mineIds.has(t.id);
    if (filter === 'running') return !TERMINAL.includes(t.state) && t.state !== 'Blocked';
    if (filter === 'blocked') return t.state === 'Blocked';
    if (filter === 'worktree') return !!wtBranch(t);
    return true;
  };
  const shown = tasks.filter(match);
  const lane = attn.filter((a) => !a.taskId || shown.some((t) => t.id === a.taskId));

  if (!tasks.length) return <EmptyBoard />;
  return (
    <div className="kb2" data-testid="kanban">
      <div className="kb2-head">
        <h2><Icon name="kanban" size={18} /> 旨意看板</h2>
        <div className="seg2" role="tablist" aria-label="看板视图">
          <button role="tab" aria-selected={view === 'board'} className={view === 'board' ? 'on' : ''} onClick={() => setUI({ kanbanView: 'board' })} data-testid="kb-view-board"><Icon name="kanban" size={12} /> 看板</button>
          <button role="tab" aria-selected={view === 'list'} className={view === 'list' ? 'on' : ''} onClick={() => setUI({ kanbanView: 'list' })} data-testid="kb-view-list"><Icon name="list" size={12} /> 列表</button>
        </div>
        <div className="filters">
          {([['all', '全部'], ['mine', '我需处理'], ['running', '进行中'], ['blocked', '阻塞'], ['worktree', '工作树']] as [Filter, string][]).map(([k, l]) => (
            <button key={k} className={`fchip ${filter === k ? 'on' : ''}`} onClick={() => setFilter(filter === k && k !== 'all' ? 'all' : k)} data-testid={`kb-filter-${k}`}>{l} <b>{counts[k]}</b></button>
          ))}
        </div>
        <span className="grow" />
        <label className="kb2-search">
          <Icon name="search" size={13} />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索旨意、官员、文件" data-testid="kb-search" />
        </label>
        <button className="btn primary" onClick={focusComposer} data-testid="kb-new"><Icon name="plus" size={13} /> 下旨</button>
      </div>
      <Stats tasks={tasks} attn={attn} today={today} />
      {lane.length > 0 && (
        <div className="attn-lane" data-testid="attn-lane">
          <div className="lane-h"><Icon name="inbox" size={14} /> 需要你处理 <span className="muted">· {lane.length} 件 · 点按钮直接处理，不必打开旨意</span></div>
          <div className="lane-row">
            {lane.slice(0, 4).map((it) => <AttnCard key={it.key} it={it} />)}
          </div>
          {lane.length > 4 && <button className="link more-link" onClick={() => setUI({ sideView: 'inbox' })}>还有 {lane.length - 4} 件，在「待办」里查看 →</button>}
        </div>
      )}
      {view === 'board' ? <Board tasks={shown} agents={agents} attn={attn} today={today} memorials={memorials} /> : <ListView tasks={shown} />}
    </div>
  );
}

export function focusComposer() {
  selectTask(null);
  setUI({ composerHidden: false, lastChat: null, mode: 'workbench' });
  setTimeout(() => document.querySelector<HTMLTextAreaElement>('#composer-input')?.focus(), 40);
}

function Stats({ tasks, attn, today }: { tasks: Task[]; attn: AttentionItem[]; today: number }) {
  const live = tasks.filter((t) => !TERMINAL.includes(t.state));
  const running = live.filter((t) => t.state !== 'Blocked');
  const blocked = live.filter((t) => t.state === 'Blocked');
  const doneToday = tasks.filter((t) => t.state === 'Done' && t.updatedAt >= today);
  const week = today - 6 * 86400_000;
  const doneWeek = tasks.filter((t) => t.state === 'Done' && t.updatedAt >= week);
  const rejWeek = tasks.filter((t) => t.updatedAt >= week).reduce((n, t) => n + t.reviews.filter((r) => r.verdict === 'reject').length, 0);
  const todays = tasks.filter((t) => t.createdAt >= today || t.updatedAt >= today);
  const tok = todays.reduce((n, t) => n + usageTokens(t.usage), 0);
  const cost = todays.reduce((n, t) => n + (t.usage.costUsd ?? 0), 0);
  const input = todays.reduce((n, t) => n + t.usage.inputTokens, 0);
  const cached = todays.reduce((n, t) => n + (t.usage.cachedTokens ?? 0), 0);
  const kinds = (k: AttentionItem['kind'][]) => attn.filter((a) => k.includes(a.kind)).length;
  const breakdown = [
    [kinds(['write_task']), '开工'], [kinds(['approval', 'risk']), '操作'], [kinds(['question']), '请旨'], [kinds(['plan', 'final', 'decide']), '御批'], [kinds(['blocked']), '阻塞'], [kinds(['merge']), '合并'],
  ].filter(([n]) => n).map(([n, l]) => `${n} ${l}`).join(' · ');
  const wt = running.filter((t) => wtBranch(t)).length;
  const subsRunning = running.reduce((n, t) => n + t.nodes.filter((x) => x.status === 'running').length, 0);
  return (
    <div className="stats" data-testid="kb-stats">
      <div className="stat"><div className="k"><Icon name="zap" size={13} /> 进行中</div><div className="v">{running.length}</div><div className="s">{wt ? `${wt} 个在独立工作树并行` : subsRunning ? `${subsRunning} 个子任务在跑` : running.length ? '等待下一步' : '没有进行中的旨意'}</div></div>
      <div className={`stat ${attn.length ? 'attn' : ''} clickable`} onClick={() => setUI({ sideView: 'inbox' })} {...tip('待你处理', '在「待办」里逐件处理')}><div className="k"><Icon name="inbox" size={13} /> 待你处理</div><div className="v">{attn.length}</div><div className="s">{breakdown || '都处理完了'}</div></div>
      <div className={`stat ${blocked.length ? 'bad' : ''}`}><div className="k"><Icon name="alert" size={13} /> 阻塞</div><div className="v">{blocked.length}</div><div className="s" title={blocked[0]?.blockedReason}>{blocked.length ? `${blocked[0].title.slice(0, 10)}：${blocked[0].blockedReason ?? ''}` : '一切顺畅'}</div></div>
      <div className={`stat ${doneToday.length ? 'okv' : ''}`}><div className="k"><Icon name="check" size={13} /> 今日结案</div><div className="v">{doneToday.length}</div><div className="s">本周 {doneWeek.length} · 封驳 {rejWeek} 次</div></div>
      <div className="stat"><div className="k"><Icon name="bolt" size={13} /> 今日用量</div><div className="v">{fmtTokens(tok)}</div><div className="s">{fmtCost(cost)}{input ? ` · 缓存命中 ${Math.round((cached / input) * 100)}%` : ''}</div></div>
    </div>
  );
}

function Board({ tasks, agents, attn, today, memorials }: { tasks: Task[]; agents: AgentRuntime[]; attn: AttentionItem[]; today: number; memorials: number }) {
  const selected = useStore((s) => s.ui.selectedTaskId);
  const done = tasks.filter((t) => TERMINAL.includes(t.state)).sort((a, b) => b.updatedAt - a.updatedAt);
  const doneToday = done.filter((t) => t.updatedAt >= today);
  const doneShown = doneToday.length ? doneToday : done.slice(0, 8);
  return (
    <div className="cols">
      {PHASES.map((p) => {
        const list = tasks.filter((t) => phaseOf(t) === p.key).sort((a, b) => Number(b.state === 'Blocked') - Number(a.state === 'Blocked') || b.updatedAt - a.updatedAt);
        return (
          <div key={p.key} className={`col2 col-${p.key}`} data-testid={`kb-col-${p.key}`}>
            <div className="col2-h"><span className="t">{p.label}</span><span className="who">{p.who}</span><span className="count">{list.length}</span></div>
            <div className="col2-b">
              {list.map((t) => <KCard key={t.id} t={t} agents={agents} attn={attn} sel={selected === t.id} />)}
              {list.length <= 1 && <div className="col-hint"><b>{p.hint[0]}</b>{p.hint[1]}</div>}
            </div>
          </div>
        );
      })}
      <div className="col2 col-done" data-testid="kb-col-done">
        <div className="col2-h"><span className="t">已结</span><span className="who">{doneToday.length ? '今日' : '最近'}</span><span className="count">{doneShown.length}</span></div>
        <div className="col2-b">
          {doneShown.map((t) => (
            <div key={t.id} className={`done-row ${selected === t.id ? 'sel' : ''}`} onClick={() => selectTask(t.id)} onDoubleClick={() => openTaskTab(t.id)} title={t.title} data-testid="kcard">
              <Icon name={t.state === 'Done' ? 'check' : 'x'} size={12} className={t.state === 'Done' ? 'ok' : 'muted'} />
              <span className={`t ${t.state === 'Cancelled' ? 'muted' : ''}`}>{t.title}</span>
              {t.schedule && <span className="mini sch" title={`定时旨意「${t.schedule.title}」`} data-testid="kc-schedule"><Icon name="clock" size={10} /></span>}
              <span className="muted">{fmtTime(t.updatedAt).slice(0, 5)}</span>
            </div>
          ))}
          {!doneShown.length && <div className="col-hint"><b>结案</b>准奏后的旨意归档到奏折阁</div>}
          <button className="link more-link" onClick={() => openPanel('memorials')}>奏折阁查看全部 {memorials} 件 →</button>
        </div>
      </div>
    </div>
  );
}

/** One line on who is doing what right now (or what the edict waits on). */
function nowLine(t: Task, agents: AgentRuntime[], attn: AttentionItem[]): { icon: string; text: string; tone: 'live' | 'wait' | 'bad' } | null {
  const mine = attn.find((a) => a.taskId === t.id && a.approval);
  if (mine) return { icon: AGENT_MAP[mine.approval!.agentId]?.emoji ?? '⏳', text: `${mine.who} ${mine.kind === 'write_task' ? '等你准许开工' : mine.kind === 'question' ? '向你请旨' : '等你批准'}：${mine.approval!.summary.replace(/^.*?[：:]/, '')}`, tone: 'wait' };
  if (t.gate) return { icon: '📮', text: t.gate.kind === 'final' ? '回奏已到，等你御批' : t.gate.kind === 'plan' ? '方案已拟好，等你御览' : t.gate.message, tone: 'wait' };
  if (t.state === 'Blocked') {
    const f = [...t.nodes].reverse().find((n) => n.status === 'failed');
    return { icon: f ? AGENT_MAP[f.agentId]?.emoji ?? '⚠' : '⚠', text: f ? `${f.label} 失败：${t.blockedReason ?? f.error ?? ''}` : t.blockedReason ?? '阻塞', tone: 'bad' };
  }
  const a = agents.find((x) => x.taskId === t.id && x.status !== 'idle');
  if (a) return { icon: AGENT_MAP[a.id]?.emoji ?? '•', text: `${AGENT_MAP[a.id]?.name ?? a.id} ${a.activity || '办理中'}`, tone: 'live' };
  return null;
}

function KCard({ t, agents, attn, sel }: { t: Task; agents: AgentRuntime[]; attn: AttentionItem[]; sel: boolean }) {
  const hb = heartbeatOf(t);
  const subs = t.plan?.subtasks ?? [];
  const st = (id: string) => [...t.nodes].reverse().find((x) => x.subtaskId === id)?.status;
  const doneSubs = subs.filter((s) => st(s.id) === 'done').length;
  const rejects = t.reviews.filter((r) => r.verdict === 'reject').length;
  const now = nowLine(t, agents, attn);
  const branch = wtBranch(t);
  const depts = [...new Set(subs.map((s) => s.dept))];
  return (
    <div className={`kc ${sel ? 'sel' : ''} ${t.state === 'Blocked' ? 'blocked' : ''}`} onClick={() => selectTask(t.id)} onDoubleClick={() => openTaskTab(t.id)} data-testid="kcard">
      <div className="kc-top">
        <span className="hb" style={{ color: hb.color }}><i style={{ background: hb.color }} /> {hb.label}</span>
        <span className="tier-tag">{t.design && !t.design.native ? t.design.name : TIER_SHORT[t.tier]}</span>
        {t.schedule && <span className="mini sch" title={`定时旨意「${t.schedule.title}」按时下达${t.schedule.catchUp ? '（补跑错过的一次）' : ''}`} data-testid="kc-schedule"><Icon name="clock" size={10} /> 定时</span>}
        <span className="r">{fmtAgo(t.createdAt)}</span>
      </div>
      <div className="kc-title">{t.title}</div>
      {t.edict && t.edict.trim() !== t.title.trim() && <div className="kc-ex">{t.edict}</div>}
      {subs.length > 0 && (
        <>
          <div className="prog">
            {subs.map((s) => {
              const v = st(s.id);
              return <span key={s.id} className={v === 'done' ? 'done' : v === 'running' ? 'run' : v === 'failed' ? 'fail' : ''} style={{ ['--c' as string]: roleInfo(t, s.dept).color }} title={`${s.id} ${roleInfo(t, s.dept).name}：${s.title}`} />;
            })}
          </div>
          <div className="prog-l"><span>{depts.map((d) => roleInfo(t, d).emoji).join('')}</span><span>{doneSubs}/{subs.length} 子任务</span></div>
        </>
      )}
      {now && <div className={`now ${now.tone}`}><span className="pulse" />{now.icon} {now.text}</div>}
      <div className="kc-foot">
        {branch && <span className="mini wt" title={`工作树分支 ${branch}`}><Icon name="branch" size={10} /> {branch.length > 18 ? `${branch.slice(0, 7)}…${branch.slice(-6)}` : branch}</span>}
        {rejects > 0 && <span className="mini rej">封驳×{rejects}</span>}
        {t.paused && <span className="mini">已叫停</span>}
        <span className="sp">{fmtTokens(usageTokens(t.usage))} · {fmtCost(t.usage.costUsd)}</span>
      </div>
    </div>
  );
}

const PHASE_LABEL: Record<Phase | 'done', string> = { plan: '分拣 · 规划', review: '审议', exec: '执行', report: '回奏 · 御批', done: '已结' };

function ListView({ tasks }: { tasks: Task[] }) {
  const selected = useStore((s) => s.ui.selectedTaskId);
  const list = [...tasks].sort((a, b) => Number(TERMINAL.includes(a.state)) - Number(TERMINAL.includes(b.state)) || b.updatedAt - a.updatedAt);
  return (
    <div className="kb-list" data-testid="kb-list">
      <table className="kb-tbl">
        <thead><tr><th>状态</th><th>旨意</th><th>档位</th><th>阶段</th><th>子任务</th><th>用量</th><th>更新</th></tr></thead>
        <tbody>
          {list.map((t) => {
            const subs = t.plan?.subtasks ?? [];
            const done = subs.filter((s) => [...t.nodes].reverse().find((x) => x.subtaskId === s.id)?.status === 'done').length;
            return (
              <tr key={t.id} className={selected === t.id ? 'sel' : ''} onClick={() => selectTask(t.id)} onDoubleClick={() => openTaskTab(t.id)} data-testid="kcard">
                <td><StateChip state={t.state} small /></td>
                <td className="tt"><span className="ellipsis">{t.title}</span>{t.schedule && <span className="mini sch"><Icon name="clock" size={10} /> 定时</span>}{wtBranch(t) && <span className="mini wt"><Icon name="branch" size={10} /> {wtBranch(t)}</span>}</td>
                <td className="muted">{TIER_SHORT[t.tier]}</td>
                <td className="muted">{PHASE_LABEL[phaseOf(t)]}</td>
                <td className="muted">{subs.length ? `${done}/${subs.length}` : '—'}</td>
                <td className="muted">{fmtTokens(usageTokens(t.usage))} · {fmtCost(t.usage.costUsd)}</td>
                <td className="muted">{fmtAgo(t.updatedAt)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {!list.length && <div className="sp-empty">没有符合条件的旨意。</div>}
    </div>
  );
}

/** No edicts yet: an inline 下旨 box and a few templates. */
function EmptyBoard() {
  const templates = useStore((s) => s.templates);
  const settings = useStore((s) => s.settings);
  const providers = useStore((s) => s.providers);
  const ws = useStore((s) => s.workspace);
  const [text, setText] = useState('');
  const [tier, setTier] = useState<Tier>(settings.defaultTier ?? 'lite');
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  const wsName = ws?.split(/[\\/]/).pop();
  const issue = async () => {
    const t = text.trim();
    if (!t || busy) return;
    if (!providers.length) {
      toast('请先在「设置 · 模型服务」里添加模型服务', 'warn');
      openPanel('models');
      return;
    }
    setBusy(true);
    try {
      const r = await call<{ kind: 'chat'; reply: string; sessionId: string } | { kind: 'task'; taskId: string }>('submit', { text: t, tier, multiAgent: tier !== 'solo', forceEdict: true });
      setText('');
      if (r.kind === 'task') selectTask(r.taskId);
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  const flow = [['🤴', '太子分拣'], ['📜', '中书规划'], ['🔍', '门下审议'], ['⚔️', '六部执行'], ['📮', '回奏'], ['👑', '你御批']];
  return (
    <div className="kb2" data-testid="kanban">
      <div className="kb2-head"><h2><Icon name="kanban" size={18} /> 旨意看板</h2></div>
      <div className="empty-board" data-testid="kb-empty">
        <div className="eb-left">
          <h3>还没有旨意。写下第一道吧</h3>
          <div className="flowline">
            {flow.map(([e, l], i) => (
              <span key={l} className="fl-step"><span className="st">{e} {l}</span>{i < flow.length - 1 && <Icon name="chevronRight" size={12} className="ar" />}</span>
            ))}
          </div>
          <textarea
            ref={box}
            className="eb-input"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void issue(); } }}
            placeholder={`例如：给 ${wsName ?? '项目'} 加一个 greet(name) 函数，并写测试`}
            data-testid="kb-empty-input"
          />
          <div className="eb-row">
            <div className="tier-seg" role="radiogroup" aria-label="协同档位">
              {(['solo', 'lite', 'full'] as Tier[]).map((x) => (
                <button key={x} role="radio" aria-checked={tier === x} className={tier === x ? 'on' : ''} onClick={() => setTier(x)}>{TIER_SHORT[x]}</button>
              ))}
            </div>
            <span className="muted small">⌘↵ 下旨</span>
            <span className="grow" />
            <button className="btn primary" disabled={busy || !text.trim()} onClick={issue} data-testid="kb-empty-send"><Icon name="send" size={13} /> {busy ? '下旨中…' : '下旨'}</button>
          </div>
          {!ws && <div className="eb-note"><Icon name="folder" size={13} /> 还没打开工作区，官员将无法读写文件。<button className="link" onClick={() => call('openFolder')}>打开文件夹</button></div>}
          {!providers.length && <div className="eb-note"><Icon name="cpu" size={13} /> 还没配置模型。<button className="link" onClick={() => openPanel('models')}>去添加模型服务</button></div>}
          <div className="eb-note muted">每道旨意都有完整记录：方案、审议、每位官员做了什么、改了哪些文件，结案后归档到奏折阁。</div>
        </div>
        <div className="eb-right">
          <div className="eb-h"><Icon name="book" size={14} /> 从旨库挑一个 <span className="muted">· 常用旨意模板</span></div>
          {templates.slice(0, 6).map((t) => (
            <button key={t.id} className="tplc" onClick={() => { setText(t.command.replace(/\{(\w+)\}/g, (_, k) => `【${t.params.find((p) => p.key === k)?.label ?? k}】`)); setTier(t.tier); box.current?.focus(); }} data-testid={`kb-tpl-${t.id}`}>
              <span className="e">{t.icon}</span>
              <span className="tx"><span className="t">{t.name}</span><span className="d">{t.desc}</span></span>
              <span className="tier-tag">{TIER_SHORT[t.tier]}</span>
            </button>
          ))}
          <button className="link more-link" onClick={() => openPanel('templates')}>打开旨库 →</button>
        </div>
      </div>
    </div>
  );
}


