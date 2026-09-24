// 朝堂模式 — the pixel court. Same runtime, same data as the workbench; only the projection differs.
import { useEffect, useMemo, useRef, useState } from 'react';
import { EffortSlider } from '../common/EffortSlider';
import { useStore, setUI, getState, selectTask, toast, openTaskTab } from '../store';
import { call } from '../api';
import { createCourtGame, type CourtGame } from './game';
import type { CourtModel, SceneKey } from './game/model';
import type { Activity, AgentId, Tier } from '../../shared/types';
import { AGENT_MAP, MINISTRIES, TIER_SHORT } from '../../shared/court';
import { AgentDialog } from './AgentDialog';
import { MemorialReview } from './MemorialReview';
import { LiubuScreen } from './LiubuScreen';
import { DebateView } from '../panels/Debate';
import { useTodayStats } from '../panels/Ceremony';
import { fmtTokens } from '../common/format';

const SCENES: { key: SceneKey; label: string; kbd: string }[] = [
  { key: 'taihe', label: '太和殿', kbd: '⌘1' },
  { key: 'junjichu', label: '军机处值房', kbd: '⌘2' },
  { key: 'liubu', label: '六部值房', kbd: '⌘3' },
  { key: 'chengtian', label: '承天门', kbd: '⌘4' },
];

function latestPerAgent(acts: Record<string, Activity[]>): Record<string, Activity | undefined> {
  const out: Record<string, Activity | undefined> = {};
  for (const list of Object.values(acts)) {
    for (let i = list.length - 1, n = 0; i >= 0 && n < 60; i--, n++) {
      const a = list[i];
      if (!a.agentId || !['thinking', 'text', 'tool_call'].includes(a.kind)) continue;
      const cur = out[a.agentId];
      if (!cur || cur.at < a.at) out[a.agentId] = a;
    }
  }
  return out;
}

export function CourtMode({ active }: { active: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const game = useRef<CourtGame | null>(null);
  const [zoom, setZoom] = useState(2);
  const [ready, setReady] = useState(false);
  const scene = useStore((s) => s.ui.courtScene);
  const dept = useStore((s) => s.ui.courtDept);
  const review = useStore((s) => s.ui.review);
  const agentDialog = useStore((s) => s.ui.agentDialog);
  const tasks = useStore((s) => s.tasks);
  const agents = useStore((s) => s.agents);
  const approvals = useStore((s) => s.approvals);
  const debates = useStore((s) => s.debates);
  const news = useStore((s) => s.news);
  const memorials = useStore((s) => s.memorials);
  const activities = useStore((s) => s.activities);
  const selectedTaskId = useStore((s) => s.ui.selectedTaskId);
  const ceremony = useStore((s) => s.ui.ceremony);
  const stats = useTodayStats();

  const debate = useMemo(() => {
    const live = debates.filter((d) => d.status === 'running' || d.status === 'idle' || d.status === 'paused').sort((a, b) => b.updatedAt - a.updatedAt);
    return live[0] ?? null;
  }, [debates]);

  const model: CourtModel = useMemo(() => {
    const human = [...(activities._global ?? []), ...Object.values(activities).flat()].filter((a) => a.kind === 'human').sort((a, b) => b.at - a.at)[0];
    return {
      tasks, approvals, debate, news, memorials, selectedTaskId, dept, ceremony,
      agents: Object.fromEntries(agents.map((a) => [a.id, a])),
      lastActivity: latestPerAgent(activities),
      emperorSaid: human ? { text: human.content.replace(/^皇上/, '').replace(/^(下旨（\w+）：|于朝堂插话：)/, ''), at: human.at } : null,
      totalsText: `今日下旨 ${stats.issued} · 结案 ${stats.done} · 待批 ${stats.gates} · ${fmtTokens(stats.tokens)} tok`,
    };
  }, [tasks, agents, approvals, debate, news, memorials, activities, selectedTaskId, dept, ceremony, stats.issued, stats.done, stats.gates, stats.tokens]);

  // boot Phaser once
  useEffect(() => {
    let disposed = false;
    const ui = getState().ui;
    createCourtGame(stage.current!, model, {
      clickAgent: (id: AgentId) => setUI({ agentDialog: id }),
      clickTask: (id: string) => {
        selectTask(id);
        setUI({ review: { taskId: id, tab: 'timeline' } });
      },
      openReview: (id: string) => setUI({ review: { taskId: id } }),
      clickApproval: () => toast('请在右下角「高风险操作」卡片中准许或驳回', 'info'),
      clickNotice: (i: number) => {
        const n = getState().news[i];
        if (n?.link) void call('openExternal', n.link);
        else if (n) toast(n.title, 'info');
      },
      ceremonyDone: () => setUI({ ceremony: false, courtScene: 'taihe' }),
      sceneChanged: () => {},
    }, ui.courtScene).then((g) => {
      if (disposed) return g.destroy();
      game.current = g;
      (window as unknown as { __court: CourtGame }).__court = g;
      setReady(true);
      fit();
    });
    return () => {
      disposed = true;
      game.current?.destroy();
      game.current = null;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const fit = () => {
    const el = host.current;
    if (!el || !game.current) return;
    const z = game.current.resize(el.clientWidth, el.clientHeight);
    setZoom(z);
  };
  useEffect(() => {
    const ro = new ResizeObserver(fit);
    if (host.current) ro.observe(host.current);
    return () => ro.disconnect();
  }, [ready]);

  useEffect(() => {
    game.current?.setModel(model);
  }, [model, ready]);

  useEffect(() => {
    if (ready) game.current?.show(scene);
  }, [scene, ready]);

  useEffect(() => {
    if (!ready) return;
    game.current?.sleep(!active);
    if (active) setTimeout(fit, 30);
  }, [active, ready]);

  useEffect(() => {
    if (ceremony && active && scene !== 'chengtian') setUI({ courtScene: 'chengtian' });
  }, [ceremony, active, scene]);

  const gates = tasks.filter((t) => t.gate);
  const W = 640 * zoom;
  const H = 360 * zoom;
  return (
    <div className="court" data-testid="court">
      <div className="court-hud pixel">
        {SCENES.map((s) => (
          <button key={s.key} className={`px-btn ${scene === s.key ? 'on' : ''}`} onClick={() => setUI({ courtScene: s.key })} title={s.kbd}>
            {s.label}
          </button>
        ))}
        {scene === 'liubu' && (
          <span className="px-sub">
            {MINISTRIES.map((m) => (
              <button key={m} className={`px-btn sm ${dept === m ? 'on' : ''}`} onClick={() => setUI({ courtDept: m })}>
                {AGENT_MAP[m].name}
              </button>
            ))}
          </span>
        )}
        <span style={{ flex: 1 }} />
        {gates.length > 0 && (
          <button className="px-btn warn" onClick={() => setUI({ review: { taskId: gates[0].id } })} data-testid="court-gates">
            奏折待批 ×{gates.length}
          </button>
        )}
        <button className="px-btn" onClick={() => setUI({ ceremony: true, courtScene: 'chengtian' })}>上朝</button>
        <button className="px-btn" onClick={() => setUI({ mode: 'workbench' })}>回工作台 ⌘J</button>
      </div>
      <div className="court-stage-host" ref={host}>
        <div className="court-stage" style={{ width: W, height: H }}>
          <div ref={stage} className="court-canvas" />
          {!ready && <div className="court-loading pixel">朝堂布置中…</div>}
          {ready && scene === 'liubu' && <LiubuScreen dept={dept} zoom={zoom} />}
          {ready && scene === 'taihe' && debate && (
            <div className="court-debate pixel-panel" style={{ right: 6 * zoom, top: 6 * zoom, width: Math.min(360, 150 * zoom), maxHeight: 210 * zoom }}>
              <div className="px-title">朝堂议政 · {debate.topic.slice(0, 18)}</div>
              <DebateView d={debate} compact />
            </div>
          )}
        </div>
      </div>
      <EmperorBox debateId={scene === 'taihe' && debate && debate.status !== 'concluded' ? debate.id : null} />
      {agentDialog && <AgentDialog id={agentDialog} />}
      {review && <MemorialReview taskId={review.taskId} tab={review.tab} />}
    </div>
  );
}

function EmperorBox({ debateId }: { debateId: string | null }) {
  const [text, setText] = useState('');
  const [mode, setMode] = useState<'edict' | 'interject'>('edict');
  const [tier, setTier] = useState<Tier>('lite');
  const [busy, setBusy] = useState(false);
  const providers = useStore((s) => s.providers);
  const settings = useStore((s) => s.settings);
  const [effort, setEffortState] = useState<string>(settings.composerEffort ?? 'default');
  const setEffort = (v: string) => { setEffortState(v); void call('updateSettings', { composerEffort: v }); };
  const strong = settings.routing?.strong ?? (providers[0]?.models[0] ? { providerId: providers[0].id, model: providers[0].models[0].id } : null);
  useEffect(() => setMode(debateId ? 'interject' : 'edict'), [debateId]);
  const send = async () => {
    const t = text.trim();
    if (!t || busy) return;
    setBusy(true);
    try {
      if (mode === 'interject' && debateId) {
        await call('debateInterject', debateId, t);
      } else {
        if (!providers.length) throw new Error('尚未配置模型：请回工作台「模型配置」');
        const r = await call('submit', { text: t, tier, multiAgent: tier !== 'solo', effort });
        if (r.kind === 'chat') toast(`太子：${r.reply}`, 'info');
        else {
          selectTask(r.taskId);
          toast(`旨意已下：${r.taskId}`, 'success');
        }
      }
      setText('');
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="emperor-box pixel-panel pixel" data-testid="emperor-box">
      <div className="eb-face" />
      <div className="eb-main">
        <div className="eb-head">
          <span className="px-name">皇上口谕</span>
          {debateId && (
            <span className="px-sub">
              <button className={`px-btn sm ${mode === 'interject' ? 'on' : ''}`} onClick={() => setMode('interject')}>插话议政</button>
              <button className={`px-btn sm ${mode === 'edict' ? 'on' : ''}`} onClick={() => setMode('edict')}>下旨</button>
            </span>
          )}
          {mode === 'edict' && (
            <span className="px-sub">
              {(['solo', 'lite', 'full'] as Tier[]).map((t) => (
                <button key={t} className={`px-btn sm ${tier === t ? 'on' : ''}`} onClick={() => setTier(t)}>{TIER_SHORT[t]}</button>
              ))}
            </span>
          )}
          {mode === 'edict' && <EffortSlider model={strong} value={effort} onChange={setEffort} variant="pixel" />}
        </div>
        <div className="eb-input">
          <input value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && !e.nativeEvent.isComposing && send()} placeholder={mode === 'interject' ? '朕以为……（回车插话，百官将针对皇上之言继续辩论）' : '传朕旨意……（回车下旨；闲聊由太子直答）'} data-testid="emperor-input" />
          <button className="px-btn on" disabled={busy} onClick={send}>{busy ? '…' : mode === 'interject' ? '口谕' : '下旨'}</button>
        </div>
      </div>
    </div>
  );
}

export { openTaskTab };
