// Cursor-style agent pane: task switcher, live activity, gates, and the 下旨 composer.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore, setUI, selectTask, openTaskTab, openPanel, toast, getState } from '../store';
import { call } from '../api';
import { Icon } from '../common/Icon';
import { Markdown } from '../common/Markdown';
import { StateChip, fmtCost, fmtTokens, fmtAgo } from '../common/format';
import { TIER_LABEL, TIER_SHORT, TERMINAL } from '../../shared/court';
import type { ModelRef, Tier } from '../../shared/types';
import { ActivityStream } from './ActivityStream';
import { EffortSlider } from '../common/EffortSlider';
import { GateCard, ModelErrorCard, Pipeline, TaskControls, UsageLine, failedModelNode, useSelectedTask } from '../panels/TaskWidgets';

export function AgentPane() {
  const task = useSelectedTask();
  const tasks = useStore((s) => s.tasks);
  const composerHidden = useStore((s) => s.ui.composerHidden);
  const lastChat = useStore((s) => s.ui.lastChat);
  const [pickerOpen, setPickerOpen] = useState(false);
  const recent = useMemo(() => [...tasks].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 30), [tasks]);
  return (
    <div className="ap">
      <div className="ap-head">
        <button className="ap-picker" onClick={() => setPickerOpen(!pickerOpen)} data-testid="task-picker">
          <Icon name="scroll" size={14} />
          <span className="ellipsis">{task ? task.title : '新旨意'}</span>
          <Icon name="chevronDown" size={12} />
        </button>
        <button className="icon-btn" title="新旨意" onClick={() => { selectTask(null); setUI({ composerHidden: false, lastChat: null }); setTimeout(() => document.querySelector<HTMLTextAreaElement>('#composer-input')?.focus(), 30); }}>
          <Icon name="plus" size={15} />
        </button>
        {task && (
          <button className="icon-btn" title="旨意详情" onClick={() => openTaskTab(task.id)}>
            <Icon name="external" size={14} />
          </button>
        )}
        {task && (
          <button className="icon-btn" title="在朝堂中查看" onClick={() => setUI({ mode: 'court', courtScene: task.state === 'Doing' ? 'liubu' : 'taihe' })}>
            <Icon name="crown" size={14} />
          </button>
        )}
      </div>
      {pickerOpen && (
        <div className="ap-picklist" onMouseLeave={() => setPickerOpen(false)}>
          {recent.length === 0 && <div className="muted pad small">尚无旨意</div>}
          {recent.map((t) => (
            <div key={t.id} className={`ap-pick ${t.id === task?.id ? 'on' : ''}`} onClick={() => { selectTask(t.id); setPickerOpen(false); }}>
              <StateChip state={t.state} small />
              <span className="ellipsis">{t.title}</span>
              <span className="muted small">{TIER_SHORT[t.tier]} · {fmtAgo(t.updatedAt)}</span>
            </div>
          ))}
        </div>
      )}
      {task ? (
        <div className="ap-task">
          <div className="ap-task-head">
            <div className="ap-title-row">
              <StateChip state={task.state} />
              <span className="tier-tag">{TIER_SHORT[task.tier]}</span>
              <code className="muted small">{task.id}</code>
              {task.paused && <span className="chip chip-sm warn">已叫停</span>}
            </div>
            <Pipeline task={task} />
            <UsageLine task={task} />
            <div className="ap-controls">
              <TaskControls task={task} />
              {task.state === 'Blocked' && !failedModelNode(task) && <span className="muted small ellipsis" title={task.blockedReason}>⚠ {task.blockedReason}</span>}
              {task.nodes.some((n) => n.status === 'failed') && !failedModelNode(task) && (
                <button className="btn sm" onClick={() => openTaskTab(task.id)}>
                  <Icon name="retry" size={12} /> 局部重试…
                </button>
              )}
            </div>
          </div>
          {task.state === 'Blocked' && failedModelNode(task) && <ModelErrorCard task={task} node={failedModelNode(task)!} />}
          {task.gate && <GateCard key={task.gate.since} task={task} />}
          <PendingApprovals taskId={task.id} />
          <div className="ap-stream">
            <ActivityStream taskId={task.id} />
          </div>
          {task.state === 'Done' && task.result?.summary && task.tier === 'solo' && null}
        </div>
      ) : (
        <div className="ap-empty">
          {lastChat ? (
            <div className="chat-reply">
              <div className="act-who" style={{ color: '#e0a526' }}>🤴 太子</div>
              <Markdown text={lastChat.reply} />
              <div className="muted small">太子判定为闲聊，未建旨意。若需动手，请勾选「直接下旨」。</div>
            </div>
          ) : (
            <Intro />
          )}
        </div>
      )}
      {composerHidden ? (
        <button className="composer-pill" onClick={() => { setUI({ composerHidden: false }); void call('updateSettings', { composerHidden: false }); }} data-testid="composer-show">
          <Icon name="send" size={13} /> 下旨 <kbd>⌘L</kbd>
        </button>
      ) : (
        <Composer />
      )}
    </div>
  );
}

function Intro() {
  const providers = useStore((s) => s.providers);
  const ws = useStore((s) => s.workspace);
  return (
    <div className="intro">
      <h3>皇上请下旨</h3>
      <ul>
        <li><b>Solo</b>：独相直接干活，最省 token。</li>
        <li><b>Court Lite</b>：分拣 → 规划 → 门下一次封驳审奏 → 执行，日常首选。</li>
        <li><b>Full Court</b>：三省六部全流程，并行执行、封驳循环、朝堂议政、御批关卡。</li>
      </ul>
      {!providers.length && (
        <div className="notice">
          尚未配置模型。<button className="link" onClick={() => openPanel('models')}>前往「模型配置」</button>填写 base_url、API Key 与模型 id。
        </div>
      )}
      {!ws && (
        <div className="notice">
          未打开工作区：Agent 将无法读写文件。<button className="link" onClick={() => call('openFolder')}>打开文件夹</button>
        </div>
      )}
      <button className="link" onClick={() => openPanel('templates')}>从「旨库」选择模板下旨 →</button>
    </div>
  );
}

function PendingApprovals({ taskId }: { taskId: string }) {
  const aps = useStore((s) => s.approvals.filter((a) => a.taskId === taskId && a.status === 'pending'));
  if (!aps.length) return null;
  return (
    <div className="inline-approvals">
      {aps.map((a) => (
        <div key={a.id} className={`approval ${a.risk}`}>
          <div>
            <b>{a.risk === 'high' ? '⚠ 高风险' : '待批准'}</b> {a.summary} <span className="muted small">— {a.reason}</span>
          </div>
          <div className="gate-actions">
            <button className="btn sm primary" onClick={() => call('decideApproval', a.id, true)}>准</button>
            <button className="btn sm danger" onClick={() => call('decideApproval', a.id, false)}>驳</button>
          </div>
        </div>
      ))}
    </div>
  );
}

export function Composer({ variant = 'pane' }: { variant?: 'pane' | 'court' }) {
  const settings = useStore((s) => s.settings);
  const providers = useStore((s) => s.providers);
  const selected = useSelectedTask();
  const [text, setText] = useState('');
  const [tier, setTier] = useState<Tier>(settings.defaultTier ?? 'lite');
  const [multi, setMulti] = useState(settings.multiAgent ?? true);
  const [model, setModel] = useState<string>(settings.routing?.strong ? `${settings.routing.strong.providerId}::${settings.routing.strong.model}` : '');
  const [debate, setDebate] = useState(!!settings.debateBeforePlan);
  const [effort, setEffortState] = useState<string>(settings.composerEffort ?? 'default');
  const setEffort = (v: string) => { setEffortState(v); void call('updateSettings', { composerEffort: v }); };
  const [force, setForce] = useState(false);
  const [cont, setCont] = useState(false);
  const [busy, setBusy] = useState(false);
  const [est, setEst] = useState<{ tokens: number; costUsd: number; breakdown: string } | null>(null);
  const ta = useRef<HTMLTextAreaElement>(null);
  const effTier: Tier = multi ? tier : 'solo';
  const canContinue = !!selected && selected.tier === 'solo' && !!selected.sessionId && effTier === 'solo';

  useEffect(() => {
    const draft = (window as unknown as { __edictDraft?: string }).__edictDraft;
    if (draft) {
      setText(draft);
      (window as unknown as { __edictDraft?: string }).__edictDraft = undefined;
    }
  }, []);

  useEffect(() => {
    const h = setTimeout(() => {
      const ref = parseModel(model);
      call('estimate', text || '示例', effTier, ref).then(setEst).catch(() => setEst(null));
    }, 250);
    return () => clearTimeout(h);
  }, [text, effTier, model]);

  useEffect(() => {
    if (!ta.current) return;
    ta.current.style.height = 'auto';
    ta.current.style.height = Math.min(260, ta.current.scrollHeight) + 'px';
  }, [text]);

  const models = providers.flatMap((p) => p.models.map((m) => ({ key: `${p.id}::${m.id}`, label: `${m.label || m.id}`, provider: p.name })));

  const send = async () => {
    const t = text.trim();
    if (!t || busy) return;
    if (!providers.length) {
      toast('请先在「模型配置」中添加模型服务', 'warn');
      openPanel('models');
      return;
    }
    setBusy(true);
    try {
      const r = await call<{ kind: 'chat'; sessionId: string; reply: string } | { kind: 'task'; taskId: string }>('submit', {
        text: t, tier, multiAgent: multi, model: parseModel(model), effort, forceEdict: force, withDebate: tier === 'full' ? debate : false, sessionId: canContinue && cont ? selected!.sessionId : undefined,
      });
      setText('');
      if (r.kind === 'chat') {
        selectTask(null);
        setUI({ lastChat: { sessionId: r.sessionId, reply: r.reply } });
        if (variant === 'court') toast(`太子：${r.reply.slice(0, 80)}`, 'info');
      } else {
        selectTask(r.taskId);
        setUI({ lastChat: null });
        void call('updateSettings', { defaultTier: tier, multiAgent: multi });
      }
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`composer ${variant}`} data-testid="composer">
      <textarea
        id={variant === 'pane' ? 'composer-input' : 'composer-input-court'}
        ref={ta}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={multi ? '皇上请下旨…（⌘↵ 下旨；闲聊由太子直接回复）' : 'Solo：直接吩咐独相…（⌘↵ 发送）'}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void send();
          }
        }}
        rows={3}
      />
      <div className="composer-row">
        <select className="mini-select" value={model} onChange={(e) => setModel(e.target.value)} title="主模型（Solo / 中书省 / 门下省）；六部等粗活按「模型配置」中的经济模型路由">
          {!models.length && <option value="">未配置模型</option>}
          {models.map((m) => (
            <option key={m.key} value={m.key}>{m.label} · {m.provider}</option>
          ))}
        </select>
        <div className="tier-seg" role="radiogroup" aria-label="协同档位">
          {(['solo', 'lite', 'full'] as Tier[]).map((t) => (
            <button key={t} role="radio" aria-checked={effTier === t} className={effTier === t ? 'on' : ''} disabled={!multi && t !== 'solo'} title={TIER_LABEL[t]} onClick={() => { if (t === 'solo') setMulti(false); else { setMulti(true); setTier(t); } }}>
              {TIER_SHORT[t]}
            </button>
          ))}
        </div>
        <EffortSlider model={parseModel(model || models[0]?.key || "")} value={effort} onChange={setEffort} />
        <label className="switch" title="多 Agent 协同（关闭 = Solo）">
          <input type="checkbox" checked={multi} onChange={(e) => { setMulti(e.target.checked); if (e.target.checked && tier === 'solo') setTier('lite'); }} />
          <span>协同</span>
        </label>
      </div>
      <div className="composer-row">
        {effTier === 'full' && (
          <label className="chk small" title="规划前先召开朝堂议政（多官员辩论）">
            <input type="checkbox" checked={debate} onChange={(e) => setDebate(e.target.checked)} /> 朝堂议政
          </label>
        )}
        {effTier !== 'solo' && (
          <label className="chk small" title="跳过太子闲聊判断，直接建旨">
            <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} /> 直接下旨
          </label>
        )}
        {canContinue && (
          <label className="chk small">
            <input type="checkbox" checked={cont} onChange={(e) => setCont(e.target.checked)} /> 续上一会话
          </label>
        )}
        <span className="est" title={est?.breakdown}>
          {est ? `预估 ~${fmtTokens(est.tokens)} tok · ${fmtCost(est.costUsd)}` : ''}
        </span>
        <span style={{ flex: 1 }} />
        {variant === 'pane' && (
          <button className="icon-btn" title="隐藏输入框（⌘L）" onClick={() => { setUI({ composerHidden: true }); void call('updateSettings', { composerHidden: true }); }}>
            <Icon name="chevronDown" size={14} />
          </button>
        )}
        <button className="btn primary send" disabled={busy || !text.trim()} onClick={send} data-testid="composer-send">
          <Icon name="send" size={13} /> {busy ? '分拣中…' : multi ? '下旨' : '发送'}
        </button>
      </div>
    </div>
  );
}

export function parseModel(key: string): ModelRef | null {
  if (!key) return null;
  const [providerId, model] = key.split('::');
  return providerId && model ? { providerId, model } : null;
}

export function draftToComposer(text: string) {
  (window as unknown as { __edictDraft?: string }).__edictDraft = text;
  setUI({ composerHidden: false, mode: 'workbench' });
  selectTask(null);
  // remount composer to pick up draft
  setTimeout(() => {
    const el = document.querySelector<HTMLTextAreaElement>('#composer-input');
    if (el && !el.value) {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
      setter.call(el, text);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
    el?.focus();
  }, 60);
  void getState;
  void TERMINAL;
}
