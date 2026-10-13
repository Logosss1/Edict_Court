import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../store';
import { call } from '../api';
import { openPreview } from './PreviewView';
import { Icon } from '../common/Icon';
import { Explorer } from './Explorer';
import { SearchView } from './SearchView';
import { GitView } from './GitView';
import { EditorArea } from './EditorArea';
import { BottomPanel } from './BottomPanel';
import { AgentPane } from './AgentPane';
import { ActivityBar } from './ActivityBar';
import { InboxView } from './Attention';

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
            {sideView === 'inbox' && <InboxView />}
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
