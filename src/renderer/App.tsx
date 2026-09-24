import { useEffect, useState, lazy, Suspense, Component, type ReactNode } from 'react';
import { useStore, setUI, onMenu, getState, openPanel, toast } from './store';
import { call, isMac } from './api';
import { Icon } from './common/Icon';
import { fmtCost, fmtTokens, usageTokens } from './common/format';
import { Workbench } from './workbench/Workbench';
import { ApprovalsDock } from './workbench/Approvals';
import { CommandPalette } from './workbench/CommandPalette';
import { CeremonyOverlay } from './panels/Ceremony';
import { PromptHost } from './common/Prompt';
import type { CourtScene } from './store';

const CourtMode = lazy(() => import('./court/CourtMode').then((m) => ({ default: m.CourtMode })));

export function App() {
  const mode = useStore((s) => s.ui.mode);
  const ready = useStore((s) => s.ready);
  const [courtMounted, setCourtMounted] = useState(false);

  useEffect(() => {
    if (mode === 'court') setCourtMounted(true);
  }, [mode]);

  useEffect(
    () =>
      onMenu((cmd, arg) => {
        const ui = getState().ui;
        switch (cmd) {
          case 'toggle-mode':
            setUI({ mode: ui.mode === 'workbench' ? 'court' : 'workbench' });
            break;
          case 'toggle-composer': {
            const hidden = !ui.composerHidden;
            setUI({ composerHidden: hidden, mode: 'workbench' });
            void call('updateSettings', { composerHidden: hidden });
            break;
          }
          case 'focus-composer':
            setUI({ composerHidden: false, mode: 'workbench' });
            setTimeout(() => document.querySelector<HTMLTextAreaElement>('#composer-input')?.focus(), 50);
            break;
          case 'open-panel':
            openPanel(arg as never);
            break;
          case 'toggle-terminal':
            setUI({ bottomOpen: !(ui.bottomOpen && ui.bottomTab === 'terminal'), bottomTab: 'terminal', mode: 'workbench' });
            break;
          case 'toggle-sidebar':
            setUI({ sideView: ui.sideView ? null : 'explorer' });
            break;
          case 'global-search':
            setUI({ sideView: 'search', mode: 'workbench' });
            setTimeout(() => document.querySelector<HTMLInputElement>('#search-input')?.focus(), 50);
            break;
          case 'command-palette':
          case 'quick-open':
            setUI({ palette: true });
            break;
          case 'ceremony':
            setUI({ ceremony: true });
            break;
          case 'court-scene':
            setUI({ mode: 'court', courtScene: arg as CourtScene });
            break;
        }
      }),
    [],
  );

  if (!ready) return <div className="boot">三省六部 · 上朝中…</div>;
  return (
    <div className={`app mode-${mode}`}>
      <TitleBar />
      <div className="app-body">
        <div className="mode-layer" style={{ display: mode === 'workbench' ? 'flex' : 'none' }}>
          <Workbench />
        </div>
        {courtMounted && (
          <div className="mode-layer" style={{ display: mode === 'court' ? 'flex' : 'none' }}>
            <ErrorBoundary>
              <Suspense fallback={<div className="boot">朝堂布置中…</div>}>
                <CourtMode active={mode === 'court'} />
              </Suspense>
            </ErrorBoundary>
          </div>
        )}
      </div>
      <ApprovalsDock />
      <Toasts />
      <CommandPalette />
      <CeremonyOverlay />
      <PromptHost />
    </div>
  );
}

function TitleBar() {
  const mode = useStore((s) => s.ui.mode);
  const workspace = useStore((s) => s.workspace);
  const totals = useStore((s) => s.totals);
  const running = useStore((s) => s.tasks.filter((t) => !['Done', 'Cancelled', 'Blocked'].includes(t.state)).length);
  const gates = useStore((s) => s.tasks.filter((t) => t.gate).length + s.approvals.filter((a) => a.status === 'pending').length);
  const theme = useStore((s) => s.settings.theme);
  const wsName = workspace ? workspace.split(/[\\/]/).pop() : null;
  return (
    <div className={`titlebar ${isMac() ? 'mac' : ''}`}>
      <div className="tb-brand">
        <span className="tb-seal">敕</span>
        <span className="tb-name">Edict</span>
        <span className="tb-sub">三省六部</span>
      </div>
      <button className="tb-ws no-drag" onClick={() => call('openFolder').catch((e) => toast(e.message, 'error'))} title={workspace ?? '打开工作区文件夹（⌘O）'}>
        <Icon name="folder" size={14} /> {wsName ?? '打开工作区…'}
      </button>
      <div className="tb-center no-drag">
        <div className="seg" role="tablist" aria-label="模式切换">
          <button role="tab" aria-selected={mode === 'workbench'} className={mode === 'workbench' ? 'on' : ''} onClick={() => setUI({ mode: 'workbench' })}>
            <Icon name="layers" size={14} /> 工作台
          </button>
          <button role="tab" aria-selected={mode === 'court'} className={mode === 'court' ? 'on' : ''} onClick={() => setUI({ mode: 'court' })} data-testid="to-court">
            <Icon name="crown" size={14} /> 朝堂
          </button>
        </div>
        <kbd className="tb-kbd">⌘J</kbd>
      </div>
      <div className="tb-right no-drag">
        {running > 0 && (
          <span className="tb-pill" title="进行中的旨意">
            <span className="dot dot-pulse" style={{ background: '#f97316' }} /> {running} 进行中
          </span>
        )}
        {gates > 0 && (
          <button className="tb-pill warn" onClick={() => openPanel('kanban')} title="待御批的奏折与操作">
            <Icon name="scroll" size={13} /> {gates} 待批
          </button>
        )}
        <span className="tb-pill" title={`累计：输入 ${totals.inputTokens} · 输出 ${totals.outputTokens} · 缓存命中 ${totals.cachedTokens}`}>
          <Icon name="zap" size={13} /> {fmtTokens(usageTokens(totals))} · {fmtCost(totals.costUsd)}
        </span>
        <button className="icon-btn" title="切换主题" onClick={() => call('updateSettings', { theme: theme === 'dark' ? 'light' : theme === 'light' ? 'system' : 'dark' })}>
          <Icon name={theme === 'light' ? 'sparkles' : 'eye'} size={15} />
        </button>
        <button className="icon-btn" title="模型配置（⌘,）" onClick={() => openPanel('models')}>
          <Icon name="settings" size={15} />
        </button>
      </div>
    </div>
  );
}

function Toasts() {
  const toasts = useStore((s) => s.ui.toasts);
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.level}`}>
          {t.message}
        </div>
      ))}
    </div>
  );
}

class ErrorBoundary extends Component<{ children: ReactNode }, { err: Error | null }> {
  state = { err: null as Error | null };
  static getDerivedStateFromError(err: Error) {
    return { err };
  }
  render() {
    if (this.state.err)
      return (
        <div className="boot" style={{ flexDirection: 'column', gap: 12 }}>
          <div>朝堂出错：{this.state.err.message}</div>
          <button className="btn" onClick={() => this.setState({ err: null })}>重试</button>
        </div>
      );
    return this.props.children;
  }
}
