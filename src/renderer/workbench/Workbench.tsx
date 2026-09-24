import { useRef, useState } from 'react';
import { useStore, setUI, openPanel, type PanelId } from '../store';
import { Icon } from '../common/Icon';
import { Explorer } from './Explorer';
import { SearchView } from './SearchView';
import { GitView } from './GitView';
import { EditorArea } from './EditorArea';
import { BottomPanel } from './BottomPanel';
import { AgentPane } from './AgentPane';

const PANELS: { id: PanelId; label: string; icon: string }[] = [
  { id: 'kanban', label: '旨意看板', icon: 'kanban' },
  { id: 'monitor', label: '省部调度', icon: 'monitor' },
  { id: 'memorials', label: '奏折阁', icon: 'scroll' },
  { id: 'templates', label: '旨库', icon: 'book' },
  { id: 'officials', label: '官员总览', icon: 'users' },
  { id: 'news', label: '天下要闻', icon: 'news' },
  { id: 'models', label: '模型配置', icon: 'cpu' },
  { id: 'skills', label: '技能配置', icon: 'sparkles' },
  { id: 'sessions', label: '小任务 Sessions', icon: 'message' },
  { id: 'ceremony', label: '上朝仪式', icon: 'flag' },
  { id: 'debate', label: '朝堂议政', icon: 'gavel' },
  { id: 'audit', label: '审计日志', icon: 'shield' },
  { id: 'help', label: '使用说明', icon: 'book' },
];

export function Workbench() {
  const sideView = useStore((s) => s.ui.sideView);
  const bottomOpen = useStore((s) => s.ui.bottomOpen);
  const [sideW, setSideW] = useState(250);
  const [rightW, setRightW] = useState(410);
  const [bottomH, setBottomH] = useState(240);
  return (
    <div className="wb">
      <ActivityBar />
      {sideView && (
        <>
          <aside className="sidebar" style={{ width: sideW }}>
            {sideView === 'explorer' && <Explorer />}
            {sideView === 'search' && <SearchView />}
            {sideView === 'git' && <GitView />}
            {sideView === 'court' && <CourtNav />}
          </aside>
          <Splitter dir="v" onDrag={(d) => setSideW((w) => Math.min(520, Math.max(180, w + d)))} />
        </>
      )}
      <main className="wb-main">
        <div className="wb-editor">
          <EditorArea />
        </div>
        {bottomOpen && (
          <>
            <Splitter dir="h" onDrag={(d) => setBottomH((h) => Math.min(640, Math.max(120, h - d)))} />
            <div className="wb-bottom" style={{ height: bottomH }}>
              <BottomPanel />
            </div>
          </>
        )}
      </main>
      <Splitter dir="v" onDrag={(d) => setRightW((w) => Math.min(760, Math.max(320, w - d)))} />
      <aside className="agent-pane" style={{ width: rightW }}>
        <AgentPane />
      </aside>
    </div>
  );
}

function ActivityBar() {
  const sideView = useStore((s) => s.ui.sideView);
  const bottomOpen = useStore((s) => s.ui.bottomOpen);
  const git = useStore((s) => s.ui.fsVersion);
  void git;
  const item = (id: 'explorer' | 'search' | 'git' | 'court', icon: string, label: string) => (
    <button className={`ab-item ${sideView === id ? 'on' : ''}`} title={label} onClick={() => setUI({ sideView: sideView === id ? null : id })}>
      <Icon name={icon} size={21} stroke={1.6} />
    </button>
  );
  return (
    <nav className="activitybar">
      {item('explorer', 'files', '资源管理器')}
      {item('search', 'search', '全局搜索（⇧⌘F）')}
      {item('git', 'git', '源代码管理')}
      {item('court', 'court', '军机处')}
      <div className="ab-spacer" />
      <button className={`ab-item ${bottomOpen ? 'on' : ''}`} title="终端 / 问题 / 输出（⌃`）" onClick={() => setUI({ bottomOpen: !bottomOpen })}>
        <Icon name="terminal" size={20} stroke={1.6} />
      </button>
      <button className="ab-item" title="模型配置" onClick={() => openPanel('models')}>
        <Icon name="settings" size={20} stroke={1.6} />
      </button>
    </nav>
  );
}

function CourtNav() {
  const counts = useStore((s) => ({
    kanban: s.tasks.filter((t) => !['Done', 'Cancelled'].includes(t.state)).length,
    memorials: s.memorials.length,
    sessions: s.sessions.length,
    news: s.news.length,
    debate: s.debates.filter((d) => d.status !== 'concluded').length,
  }));
  return (
    <div className="side-view">
      <div className="side-title">军机处</div>
      <div className="court-nav">
        {PANELS.map((p) => (
          <button key={p.id} className="court-nav-item" onClick={() => openPanel(p.id)}>
            <Icon name={p.icon} size={15} />
            <span>{p.label}</span>
            {(counts as Record<string, number>)[p.id] ? <span className="count">{(counts as Record<string, number>)[p.id]}</span> : null}
          </button>
        ))}
      </div>
    </div>
  );
}

export function Splitter({ dir, onDrag }: { dir: 'v' | 'h'; onDrag: (delta: number) => void }) {
  const last = useRef(0);
  return (
    <div
      className={`splitter splitter-${dir}`}
      onMouseDown={(e) => {
        last.current = dir === 'v' ? e.clientX : e.clientY;
        const move = (ev: MouseEvent) => {
          const p = dir === 'v' ? ev.clientX : ev.clientY;
          onDrag(p - last.current);
          last.current = p;
        };
        const up = () => {
          window.removeEventListener('mousemove', move);
          window.removeEventListener('mouseup', up);
          document.body.classList.remove('resizing');
        };
        document.body.classList.add('resizing');
        window.addEventListener('mousemove', move);
        window.addEventListener('mouseup', up);
      }}
    />
  );
}
