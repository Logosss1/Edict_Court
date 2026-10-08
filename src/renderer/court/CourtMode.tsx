// 朝堂模式 — the pixel court. Same runtime, same data as the workbench; only the projection differs.
import { useEffect, useMemo, useRef, useState } from 'react';
import { EffortSlider } from '../common/EffortSlider';
import { BUILTIN_DESIGN_ID, type CollabDesign } from '../../shared/design';
import { useStore, setUI, getState, selectTask, toast, openTaskTab, openPanel } from '../store';
import { call } from '../api';
import { createCourtGame, type CourtGame } from './game';
import type { CourtModel, CourtView, SceneKey, Weather } from './game/model';
import type { Activity, AgentId, Task, Tier } from '../../shared/types';
import { AGENT_MAP, MINISTRIES, STATE_LABEL, TERMINAL, TIER_SHORT } from '../../shared/court';
import { statusLabel } from '../panels/Monitor';
import { cue, setSound } from './ambient';
import { AgentDialog } from './AgentDialog';
import { MemorialReview } from './MemorialReview';
import { LiubuScreen } from './LiubuScreen';
import { DebateView } from '../panels/Debate';
import { useTodayStats } from '../panels/Ceremony';
import { fmtTokens, fmtTime } from '../common/format';
import { tip } from '../common/Tip';

const WEATHERS: { key: Weather; label: string }[] = [
  { key: 'clear', label: '晴' },
  { key: 'rain', label: '雨' },
  { key: 'snow', label: '雪' },
  { key: 'petals', label: '落花' },
];
const WALK_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'KeyW', 'KeyA', 'KeyS', 'KeyD']);

// 恩宠: a purely cosmetic tally of 赏赐 / 训诫, kept in this browser only
const FAVOR_KEY = 'edict.court.favor';
function readFavor(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(FAVOR_KEY) || '{}');
  } catch {
    return {};
  }
}
function bumpFavor(id: string, d: number) {
  const f = readFavor();
  f[id] = (f[id] ?? 0) + d;
  try {
    localStorage.setItem(FAVOR_KEY, JSON.stringify(f));
  } catch {
    /* private mode */
  }
  return f[id];
}
function readPref(key: string, fallback: string) {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}
function writePref(key: string, v: string) {
  try {
    localStorage.setItem(key, v);
  } catch {
    /* ignore */
  }
}

/** tasks an official has worked on (nodes or flow mentions), newest first */
export function tasksHandledBy(tasks: Task[], id: AgentId): Task[] {
  const name = AGENT_MAP[id]?.name;
  return tasks
    .filter((t) => t.nodes.some((n) => n.agentId === id) || (name && t.flow.some((f) => f.to === name || f.from === name)))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

const SCENES: { key: SceneKey; label: string; kbd: string; desc: string }[] = [
  { key: 'taihe', label: '太和殿', kbd: '⌘1', desc: '百官上朝，奏折在这里呈给皇上御批' },
  { key: 'guangchang', label: '太和殿广场', kbd: '', desc: '殿前广场，往南出太和门、午门到承天门' },
  { key: 'junjichu', label: '军机处值房', kbd: '⌘2', desc: '旨意折子墙和流转链' },
  { key: 'liubu', label: '六部值房', kbd: '⌘3', desc: '各部办差现场与办过的旨意' },
  { key: 'chengtian', label: '承天门', kbd: '⌘4', desc: '告示榜，击鼓上朝' },
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

/** the 朝堂布局 of the 协同设计 chosen for new edicts (null: built-in seating) */
function useCourtLayout(): CourtView | null {
  const designs = useStore((s) => s.designs);
  const id = useStore((s) => s.settings.defaultDesign) ?? BUILTIN_DESIGN_ID;
  const info = designs.find((d) => d.id === id && d.status === 'active' && !d.native);
  const [view, setView] = useState<CourtView | null>(null);
  useEffect(() => {
    if (!info) return setView(null);
    let live = true;
    call<CollabDesign | null>('designGet', info.id)
      .then((d) => live && setView(d?.court ? { layout: d.court, roles: Object.fromEntries(d.roles.map((r) => [r.id, { name: r.name, avatar: r.avatar }])) } : null))
      .catch(() => live && setView(null));
    return () => {
      live = false;
    };
  }, [info?.id, info?.activeVersion, info?.latestVersion]); // eslint-disable-line react-hooks/exhaustive-deps
  return view;
}

export function CourtMode({ active }: { active: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const game = useRef<CourtGame | null>(null);
  const [zoom, setZoom] = useState(2);
  const [ready, setReady] = useState(false);
  const [hover, setHover] = useState<{ id: AgentId; x: number; y: number } | null>(null);
  const [menu, setMenu] = useState<{ id: AgentId; x: number; y: number } | null>(null);
  const [history, setHistory] = useState<AgentId | null>(null);
  const [weather, setWeatherState] = useState<Weather>(() => readPref('edict.court.weather', 'clear') as Weather);
  const [sound, setSoundState] = useState(false);
  const [replaying, setReplaying] = useState<string | null>(null);
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
  const court = useCourtLayout();

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
      court,
    };
  }, [tasks, agents, approvals, debate, news, memorials, activities, selectedTaskId, dept, ceremony, stats.issued, stats.done, stats.gates, stats.tokens, court]);

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
      sceneChanged: () => {
        setHover(null);
        setMenu(null);
      },
      hoverAgent: (h) => setHover(h),
      agentMenu: (id, x, y) => {
        setHover(null);
        setMenu({ id, x, y });
      },
      openPanel: (id) => openPanel(id),
      showHistory: (id) => setHistory(id),
      gotoScene: (key) => setUI({ courtScene: key }),
      sound: (c) => cue(c),
      replayDone: () => setReplaying(null),
    }, ui.courtScene, { weather }).then((g) => {
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

  // the emperor walks with the arrow keys (Space = 召见, Esc = 回御座) — only while no text field or dialog has focus
  const modalOpen = !!agentDialog || !!review || !!history;
  useEffect(() => {
    if (!active || !ready) return;
    const editable = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
    const down = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || editable(e.target)) return;
      if (e.code === 'Escape' && (menu || history)) {
        setMenu(null);
        setHistory(null);
        return;
      }
      if (modalOpen) return;
      if (WALK_KEYS.has(e.code) || e.code === 'Space' || e.code === 'Escape') {
        e.preventDefault();
        setMenu(null);
        if (!e.repeat || WALK_KEYS.has(e.code)) game.current?.key(e.code, true);
      }
    };
    const up = (e: KeyboardEvent) => {
      if (WALK_KEYS.has(e.code) || e.code === 'Space' || e.code === 'Escape') game.current?.key(e.code, false);
    };
    const blur = () => WALK_KEYS.forEach((k) => game.current?.key(k, false));
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
      blur();
    };
  }, [active, ready, modalOpen, menu, history]);

  const changeWeather = (w: Weather) => {
    setWeatherState(w);
    writePref('edict.court.weather', w);
    game.current?.setWeather(w);
  };
  const toggleSound = () => {
    const on = !sound;
    setSoundState(on);
    setSound(on);
  };
  useEffect(() => () => setSound(false), []);
  useEffect(() => {
    if (!active && sound) setSound(false);
    else if (active && sound) setSound(true);
  }, [active]); // eslint-disable-line react-hooks/exhaustive-deps

  const finished = useMemo(() => tasks.filter((t) => TERMINAL.includes(t.state) && (t.nodes.length > 0 || t.flow.length > 1)).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 30), [tasks]);
  const startReplay = (id: string) => {
    if (!id) return;
    setReplaying(id);
    setMenu(null);
    setUI({ courtScene: 'taihe' });
    game.current?.replay(id);
  };

  const gates = tasks.filter((t) => t.gate);
  const W = 640 * zoom;
  const H = 360 * zoom;
  return (
    <div className="court" data-testid="court">
      <div className="court-hud pixel">
        {SCENES.map((s) => (
          <button key={s.key} className={`px-btn ${scene === s.key ? 'on' : ''}`} onClick={() => setUI({ courtScene: s.key })} {...tip(s.label, s.desc, s.kbd, 'below')}>
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
        <span className="px-hint" {...tip('皇上漫步', '方向键或点地面走动，走到门口换殿；靠近官员按空格召见，Esc 回御座', undefined, 'below')}>✦ 漫步</span>
        <select className="px-select" value={replaying ?? ''} onChange={(e) => startReplay(e.target.value)} {...tip('奏折回放', '把一道已结案旨意的流转在太和殿重演一遍', undefined, 'below')} data-testid="court-replay">
          <option value="">奏折回放…</option>
          {finished.map((t) => <option key={t.id} value={t.id}>{t.title.slice(0, 16)}</option>)}
        </select>
        <span className="px-seg" {...tip('天气', '只改变画面，不影响办差', undefined, 'below')} data-testid="court-weather">
          {WEATHERS.map((w) => (
            <button key={w.key} className={`px-btn sm ${weather === w.key ? 'on' : ''}`} onClick={() => changeWeather(w.key)}>{w.label}</button>
          ))}
        </span>
        <button className={`px-btn sm ${sound ? 'on' : ''}`} onClick={toggleSound} {...tip('声音', '钟鼓、鸟鸣和猫叫，默认关闭', undefined, 'below')} data-testid="court-sound">{sound ? '声 开' : '声 关'}</button>
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
          {ready && hover && !menu && <HoverCard h={hover} zoom={zoom} />}
          {ready && menu && (
            <AgentMenu
              m={menu}
              zoom={zoom}
              onClose={() => setMenu(null)}
              onHistory={(id) => { setMenu(null); setHistory(id); }}
              onReact={(id, kind) => {
                const shown = game.current?.react(id, kind);
                if (kind !== 'urge') {
                  const v = bumpFavor(id, kind === 'reward' ? 1 : -1);
                  toast(`${AGENT_MAP[id].name}${kind === 'reward' ? '蒙赏' : '受训诫'}，恩宠 ${v}`, 'info');
                }
                if (!shown && kind !== 'urge') toast('（此人不在本殿，动画未能呈现）', 'info');
              }}
            />
          )}
          {ready && scene === 'taihe' && debate && (
            <div className="court-debate pixel-panel" style={{ right: 6 * zoom, top: 6 * zoom, width: Math.min(360, 150 * zoom), maxHeight: 210 * zoom }}>
              <div className="px-title">朝堂议政 · {debate.topic.slice(0, 18)}</div>
              <DebateView d={debate} compact />
            </div>
          )}
        </div>
      </div>
      <EmperorBox debateId={scene === 'taihe' && debate && debate.status !== 'concluded' ? debate.id : null} />
      {history && <HistoryPop id={history} onClose={() => setHistory(null)} onReplay={(id) => { setHistory(null); startReplay(id); }} />}
      {agentDialog && <AgentDialog id={agentDialog} />}
      {review && <MemorialReview taskId={review.taskId} tab={review.tab} />}
    </div>
  );
}

/** status card shown while the pointer rests on an official */
function HoverCard({ h, zoom }: { h: { id: AgentId; x: number; y: number }; zoom: number }) {
  const a = useStore((s) => s.agents.find((x) => x.id === h.id));
  const task = useStore((s) => (a?.taskId ? s.tasks.find((t) => t.id === a.taskId) : undefined));
  const meta = AGENT_MAP[h.id];
  const node = task?.nodes.find((n) => n.id === a?.nodeId) ?? [...(task?.nodes ?? [])].reverse().find((n) => n.agentId === h.id);
  const favor = readFavor()[h.id] ?? 0;
  const left = Math.max(4, Math.min(640 * zoom - 214, h.x * zoom - 105));
  const below = h.y * zoom < 130;
  const style = below ? { left, top: (h.y + 52) * zoom } : { left, top: h.y * zoom - 6, transform: 'translateY(-100%)' };
  const tok = a ? a.usage.inputTokens + a.usage.outputTokens : 0;
  return (
    <div className="court-card pixel" style={style} data-testid="court-hover-card">
      <div className="cc-head"><b>{meta.name}</b><span>{meta.official}</span></div>
      <div className="cc-row"><span>状态</span><b className={`cc-st ${a?.status ?? 'idle'}`}>{statusLabel(a?.status ?? 'idle')}</b>{a?.activity && a.status !== 'idle' ? <em>{a.activity.slice(0, 22)}</em> : null}</div>
      <div className="cc-row"><span>旨意</span>{task ? <em>{task.title.slice(0, 20)} · {STATE_LABEL[task.state]}</em> : <em className="px-muted">无差事在身</em>}</div>
      <div className="cc-row"><span>模型</span><em>{node?.model ?? '—'}</em></div>
      <div className="cc-row"><span>用量</span><em>{fmtTokens(tok)} tok · {a?.usage.calls ?? 0} 次 · 结案 {a?.completed ?? 0}</em></div>
      <div className="cc-row"><span>恩宠</span><em>{favor > 0 ? '★'.repeat(Math.min(5, favor)) : favor < 0 ? '☆ 失宠' : '平平'}{favor ? ` (${favor > 0 ? '+' : ''}${favor})` : ''}</em></div>
      <div className="cc-foot">{meta.duty}</div>
    </div>
  );
}

function AgentMenu({ m, zoom, onClose, onHistory, onReact }: { m: { id: AgentId; x: number; y: number }; zoom: number; onClose: () => void; onHistory: (id: AgentId) => void; onReact: (id: AgentId, kind: 'reward' | 'scold' | 'urge') => void }) {
  const a = useStore((s) => s.agents.find((x) => x.id === m.id));
  const tasks = useStore((s) => s.tasks);
  const meta = AGENT_MAP[m.id];
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const away = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
    const t = setTimeout(() => window.addEventListener('mousedown', away), 0);
    return () => { clearTimeout(t); window.removeEventListener('mousedown', away); };
  }, [onClose]);
  const live = a?.taskId ? tasks.find((t) => t.id === a.taskId && !TERMINAL.includes(t.state)) : undefined;
  const urge = async () => {
    onClose();
    if (!live) return toast(`${meta.name}眼下没有在办的差事，无需催办`, 'info');
    try {
      await call('annotate', m.id, '皇上催办：此事紧要，望速速办妥回奏。', live.id);
      onReact(m.id, 'urge');
      toast(`已朱批催办${meta.name}（其下一轮会读到）`, 'success');
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  const left = Math.max(4, Math.min(640 * zoom - 150, m.x * zoom + 14));
  const top = Math.max(4, Math.min(360 * zoom - 190, m.y * zoom - 10));
  return (
    <div className="court-menu pixel" ref={ref} style={{ left, top }} data-testid="court-agent-menu">
      <div className="cm-head">{meta.name} · {meta.official}</div>
      <button onClick={() => { onClose(); setUI({ agentDialog: m.id }); }}>召见<small>对话 · 朱批</small></button>
      <button onClick={() => onHistory(m.id)}>办过的旨意<small>履历</small></button>
      <button onClick={() => { onClose(); onReact(m.id, 'reward'); }}>赏赐<small>恩宠 +1</small></button>
      <button onClick={() => { onClose(); onReact(m.id, 'scold'); }}>训诫<small>恩宠 −1</small></button>
      <button onClick={urge} disabled={!live} title={live ? `朱批催办：${live.title}` : '没有在办的差事'}>催办<small>{live ? '朱批一句' : '无差事'}</small></button>
    </div>
  );
}

function HistoryPop({ id, onClose, onReplay }: { id: AgentId; onClose: () => void; onReplay: (taskId: string) => void }) {
  const tasks = useStore((s) => s.tasks);
  const list = useMemo(() => tasksHandledBy(tasks, id).slice(0, 40), [tasks, id]);
  const meta = AGENT_MAP[id];
  return (
    <div className="px-modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="court-history pixel-panel pixel" data-testid="court-history">
        <div className="px-title">
          <span>{meta.name} · 办过的旨意（{list.length}）</span>
          <button className="px-x" onClick={onClose}>×</button>
        </div>
        {list.length === 0 && <div className="px-muted">尚无履历。</div>}
        <div className="ch-list">
          {list.map((t) => (
            <div key={t.id} className="ch-row">
              <button className="ch-title" onClick={() => { onClose(); selectTask(t.id); setUI({ review: { taskId: t.id, tab: 'timeline' } }); }}>{t.title}</button>
              <span className={`px-chip st-${t.state}`}>{STATE_LABEL[t.state]}</span>
              <span className="px-muted">{fmtTime(t.updatedAt)}</span>
              {TERMINAL.includes(t.state) && <button className="px-btn sm" onClick={() => onReplay(t.id)} title="在太和殿重演这道旨意的流转">回放</button>}
            </div>
          ))}
        </div>
      </div>
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
  const designs = useStore((s) => s.designs).filter((d) => d.status === 'active');
  const design = designs.find((d) => d.id === (settings.defaultDesign ?? BUILTIN_DESIGN_ID)) ?? designs.find((d) => d.native);
  const custom = !!design && !design.native;
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
        const r = await call('submit', { text: t, tier, multiAgent: custom || tier !== 'solo', effort, designId: custom ? design!.id : undefined });
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
          {mode === 'edict' && designs.length > 1 && (
            <select className="px-select" value={design?.id ?? BUILTIN_DESIGN_ID} onChange={(e) => call('updateSettings', { defaultDesign: e.target.value })} {...tip('协同设计', '新下的旨意按哪套协作流程办；朝堂也按它的布局摆', undefined, 'below')} data-testid="court-design-pick">
              {designs.map((d) => <option key={d.id} value={d.id}>{d.native ? '三省六部' : `${d.favorite ? '★ ' : ''}${d.name}`}</option>)}
            </select>
          )}
          {mode === 'edict' && !custom && (
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
