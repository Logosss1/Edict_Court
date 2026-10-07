import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore, setUI, openPanel, type PanelId } from '../store';
import { call } from '../api';
import { openPreview } from './PreviewView';
import { Icon } from '../common/Icon';
import { Explorer } from './Explorer';
import { SearchView } from './SearchView';
import { GitView } from './GitView';
import { EditorArea } from './EditorArea';
import { BottomPanel } from './BottomPanel';
import { AgentPane } from './AgentPane';

// what this release added — a 新 badge until the entry is opened once
const NEW_PANELS: PanelId[] = ['designs'];
const seenKey = (id: string) => `edict.seen.${id}`;
function isNew(id: PanelId) {
  if (!NEW_PANELS.includes(id)) return false;
  try {
    return !localStorage.getItem(seenKey(id));
  } catch {
    return false;
  }
}
function markSeen(id: string) {
  try {
    localStorage.setItem(seenKey(id), '1');
  } catch {
    /* ignore */
  }
}
const NAV_GROUPS: { title: string; ids: PanelId[] }[] = [
  { title: '政务', ids: ['kanban', 'monitor', 'memorials', 'debate', 'ceremony', 'sessions'] },
  { title: '配置', ids: ['models', 'designs', 'skills', 'templates', 'officials'] },
  { title: '记录', ids: ['news', 'audit', 'help'] },
];

const PANELS: { id: PanelId; label: string; icon: string }[] = [
  { id: 'kanban', label: '旨意看板', icon: 'kanban' },
  { id: 'monitor', label: '省部调度', icon: 'monitor' },
  { id: 'memorials', label: '奏折阁', icon: 'scroll' },
  { id: 'templates', label: '旨库', icon: 'book' },
  { id: 'officials', label: '官员总览', icon: 'users' },
  { id: 'news', label: '天下要闻', icon: 'news' },
  { id: 'models', label: '模型配置', icon: 'cpu' },
  { id: 'designs', label: '协同设计', icon: 'layers' },
  { id: 'skills', label: '技能与 MCP', icon: 'plug' },
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
            {sideView === 'preview' && <PreviewSide />}
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
  const mcpBad = useStore((s) => s.mcp.filter((m) => m.status === 'error' || m.status === 'untrusted').length);
  const [, bump] = useState(0);
  const item = (id: 'explorer' | 'search' | 'git' | 'court' | 'preview', icon: string, label: string) => (
    <button className={`ab-item ${sideView === id ? 'on' : ''}`} title={label} onClick={() => setUI({ sideView: sideView === id ? null : id })} data-testid={`ab-${id}`}>
      <Icon name={icon} size={21} stroke={1.6} />
    </button>
  );
  return (
    <nav className="activitybar">
      {item('explorer', 'files', '资源管理器')}
      {item('search', 'search', '全局搜索（⇧⌘F）')}
      {item('git', 'git', '源代码管理')}
      {item('court', 'court', '军机处')}
      {item('preview', 'globe', '网页预览')}
      <button className="ab-item" title="协同设计" onClick={() => { markSeen('designs'); bump((n) => n + 1); openPanel('designs'); }} data-testid="ab-designs">
        <Icon name="layers" size={20} stroke={1.6} />
        {isNew('designs') && <span className="ab-badge new">新</span>}
      </button>
      <button className="ab-item ab-court" title="进入朝堂（⌘J）" onClick={() => setUI({ mode: 'court' })} data-testid="ab-court-mode">
        <Icon name="crown" size={20} stroke={1.6} />
      </button>
      <div className="ab-spacer" />
      <button className="ab-item" title="技能与 MCP" onClick={() => openPanel('skills')} data-testid="ab-skills">
        <Icon name="plug" size={20} stroke={1.6} />
        {mcpBad > 0 && <span className="ab-badge" title={`${mcpBad} 个 MCP 服务异常或待信任`}>{mcpBad}</span>}
      </button>
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
  const [, bump] = useState(0);
  const byId = Object.fromEntries(PANELS.map((p) => [p.id, p]));
  return (
    <div className="side-view">
      <div className="side-title">军机处</div>
      <div className="court-nav">
        <button className="court-nav-item court-nav-enter" onClick={() => setUI({ mode: 'court' })} data-testid="nav-enter-court">
          <Icon name="crown" size={15} />
          <span>进入朝堂</span>
          <span className="kbd">⌘J</span>
        </button>
        {NAV_GROUPS.map((g) => (
          <div key={g.title} className="court-nav-group">
            <div className="court-nav-h">{g.title}</div>
            {g.ids.map((id) => {
              const p = byId[id];
              const n = (counts as Record<string, number>)[id];
              return (
                <button key={id} className="court-nav-item" onClick={() => { markSeen(id); bump((x) => x + 1); openPanel(id); }}>
                  <Icon name={p.icon} size={15} />
                  <span>{p.label}</span>
                  {isNew(id) && <span className="nav-new">新</span>}
                  {n ? <span className="count">{n}</span> : null}
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

/** 网页预览: open any HTML file of the workspace or a URL (dev server) in a preview tab */
function PreviewSide() {
  const workspace = useStore((s) => s.workspace);
  const [files, setFiles] = useState<string[]>([]);
  const [q, setQ] = useState('');
  const [url, setUrl] = useState('http://localhost:5173');
  useEffect(() => {
    if (!workspace) return setFiles([]);
    call<string[]>('listFiles').then((all) => setFiles(all.filter((f) => /\.html?$/i.test(f) && !/(^|\/)(node_modules|dist|build|\.git)\//.test(f)))).catch(() => setFiles([]));
  }, [workspace]);
  const shown = useMemo(() => files.filter((f) => f.toLowerCase().includes(q.toLowerCase())).slice(0, 300), [files, q]);
  const go = () => {
    const t = url.trim();
    if (!t) return;
    void openPreview(/^https?:\/\//.test(t) ? t : `http://${t}`);
  };
  return (
    <div className="side-view preview-side" data-testid="preview-side">
      <div className="side-title">网页预览</div>
      <div className="ps-url">
        <input className="input" value={url} onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && go()} placeholder="http://localhost:5173" data-testid="preview-url" />
        <button className="btn sm" onClick={go}>打开</button>
      </div>
      <div className="ps-quick">
        {['http://localhost:3000', 'http://localhost:5173', 'http://localhost:8080'].map((u) => (
          <button key={u} className="chip" onClick={() => { setUrl(u); void openPreview(u); }}>{u.replace('http://', '')}</button>
        ))}
      </div>
      <div className="ps-h">工作区 HTML 文件（{files.length}）</div>
      {files.length > 8 && <input className="input ps-filter" value={q} onChange={(e) => setQ(e.target.value)} placeholder="筛选…" />}
      <div className="ps-list">
        {!workspace && <div className="muted ps-empty">尚未打开工作区。</div>}
        {workspace && !files.length && <div className="muted ps-empty">工作区里没有 .html 文件，可在上方输入开发服务器地址。</div>}
        {shown.map((f) => (
          <button key={f} className="ps-file" onClick={() => void openPreview(f)} title={f}>
            <Icon name="globe" size={13} />
            <span className="ps-name">{f.split('/').pop()}</span>
            <span className="ps-dir">{f.split('/').slice(0, -1).join('/')}</span>
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
