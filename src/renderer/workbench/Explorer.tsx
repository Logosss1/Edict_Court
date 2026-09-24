import { PREVIEWABLE, openPreview } from './PreviewView';
import { useEffect, useState, useCallback } from 'react';
import { useStore, openTab, toast } from '../store';
import { call } from '../api';
import { Icon } from '../common/Icon';

interface Node {
  name: string;
  path: string;
  dir: boolean;
}

export function openFile(path: string, preview = true) {
  openTab({ id: `file:${path}`, kind: 'file', title: path.split('/').pop() ?? path, path, preview });
}

export function useGitStatus() {
  const fsVersion = useStore((s) => s.ui.fsVersion);
  const ws = useStore((s) => s.workspace);
  const [status, setStatus] = useState<{ isRepo: boolean; branch: string; files: { path: string; status: string; staged: boolean }[] } | null>(null);
  useEffect(() => {
    if (!ws) return setStatus(null);
    const t = setTimeout(() => call('gitStatus').then(setStatus).catch(() => setStatus(null)), 250);
    return () => clearTimeout(t);
  }, [fsVersion, ws]);
  return status;
}

const GIT_COLOR: Record<string, string> = { modified: '#d8a84e', added: '#4fa38a', untracked: '#4fa38a', deleted: '#d0453a', renamed: '#5b8cd6', conflict: '#ef4444' };

export function Explorer() {
  const ws = useStore((s) => s.workspace);
  const fsVersion = useStore((s) => s.ui.fsVersion);
  const activeTab = useStore((s) => s.ui.activeTab);
  const [children, setChildren] = useState<Record<string, Node[]>>({});
  const [open, setOpen] = useState<Set<string>>(new Set(['.']));
  const [creating, setCreating] = useState<{ parent: string; dir: boolean } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; node: Node } | null>(null);
  const git = useGitStatus();
  const gitMap = new Map((git?.files ?? []).map((f) => [f.path, f.status]));

  const load = useCallback(async (dir: string) => {
    try {
      const list = await call<Node[]>('tree', dir);
      setChildren((c) => ({ ...c, [dir]: list }));
    } catch (e) {
      setChildren((c) => ({ ...c, [dir]: [] }));
    }
  }, []);

  useEffect(() => {
    if (!ws) return;
    setChildren({});
    setOpen(new Set(['.']));
  }, [ws]);

  useEffect(() => {
    if (!ws) return;
    for (const d of open) void load(d);
  }, [ws, fsVersion, open, load]);

  useEffect(() => {
    const close = () => setMenu(null);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, []);

  if (!ws)
    return (
      <div className="side-view">
        <div className="side-title">资源管理器</div>
        <div className="empty-side">
          <p>尚未打开工作区。</p>
          <button className="btn primary" onClick={() => call('openFolder')}>
            <Icon name="folder" /> 打开文件夹
          </button>
          <p className="muted small">Agent 只能在所打开的文件夹内读写文件。</p>
        </div>
      </div>
    );

  const toggle = (p: string) =>
    setOpen((o) => {
      const n = new Set(o);
      if (n.has(p)) n.delete(p);
      else n.add(p);
      return n;
    });

  const submitCreate = async (name: string) => {
    if (!creating || !name.trim()) return setCreating(null);
    const p = creating.parent === '.' ? name.trim() : `${creating.parent}/${name.trim()}`;
    try {
      if (creating.dir) await call('mkdir', p);
      else {
        await call('createFile', p);
        openFile(p, false);
      }
      setOpen((o) => new Set([...o, creating.parent]));
    } catch (e) {
      toast((e as Error).message, 'error');
    }
    setCreating(null);
  };

  const submitRename = async (node: Node, name: string) => {
    setRenaming(null);
    if (!name.trim() || name === node.name) return;
    const parent = node.path.includes('/') ? node.path.slice(0, node.path.lastIndexOf('/')) : '';
    try {
      await call('rename', node.path, parent ? `${parent}/${name}` : name);
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  const renderDir = (dir: string, depth: number): JSX.Element[] => {
    const items = children[dir] ?? [];
    const out: JSX.Element[] = [];
    if (creating?.parent === dir)
      out.push(
        <div key="__create" className="tree-row" style={{ paddingLeft: 8 + depth * 12 }}>
          <Icon name={creating.dir ? 'folder' : 'file'} size={14} />
          <input autoFocus className="tree-input" placeholder={creating.dir ? '文件夹名' : '文件名'} onBlur={(e) => submitCreate(e.target.value)} onKeyDown={(e) => {
            if (e.key === 'Enter') submitCreate((e.target as HTMLInputElement).value);
            if (e.key === 'Escape') setCreating(null);
          }} />
        </div>,
      );
    for (const n of items) {
      const isOpen = open.has(n.path);
      const gs = gitMap.get(n.path) ?? (n.dir ? [...gitMap.keys()].some((k) => k.startsWith(n.path + '/')) && 'modified' : undefined);
      out.push(
        <div
          key={n.path}
          className={`tree-row ${activeTab === `file:${n.path}` ? 'active' : ''}`}
          style={{ paddingLeft: 8 + depth * 12, color: gs ? GIT_COLOR[gs as string] : undefined }}
          onClick={() => (n.dir ? toggle(n.path) : openFile(n.path))}
          onDoubleClick={() => !n.dir && openFile(n.path, false)}
          onContextMenu={(e) => {
            e.preventDefault();
            setMenu({ x: e.clientX, y: e.clientY, node: n });
          }}
          title={n.path}
        >
          {n.dir ? <Icon name={isOpen ? 'chevronDown' : 'chevronRight'} size={12} /> : <span style={{ width: 12 }} />}
          <Icon name={n.dir ? 'folder' : 'file'} size={14} style={{ opacity: 0.75 }} />
          {renaming === n.path ? (
            <input autoFocus className="tree-input" defaultValue={n.name} onClick={(e) => e.stopPropagation()} onBlur={(e) => submitRename(n, e.target.value)} onKeyDown={(e) => {
              if (e.key === 'Enter') submitRename(n, (e.target as HTMLInputElement).value);
              if (e.key === 'Escape') setRenaming(null);
            }} />
          ) : (
            <span className="tree-name">{n.name}</span>
          )}
          {gs && !n.dir && <span className="tree-git">{String(gs)[0].toUpperCase()}</span>}
        </div>,
      );
      if (n.dir && isOpen) out.push(...renderDir(n.path, depth + 1));
    }
    return out;
  };

  return (
    <div className="side-view">
      <div className="side-title">
        <span>{ws.split(/[\\/]/).pop()}</span>
        <span className="side-actions">
          <button className="icon-btn" title="新建文件" onClick={() => setCreating({ parent: '.', dir: false })}>
            <Icon name="plus" size={14} />
          </button>
          <button className="icon-btn" title="新建文件夹" onClick={() => setCreating({ parent: '.', dir: true })}>
            <Icon name="folder" size={14} />
          </button>
          <button className="icon-btn" title="刷新" onClick={() => [...open].forEach((d) => load(d))}>
            <Icon name="refresh" size={14} />
          </button>
        </span>
      </div>
      <div className="tree" data-testid="explorer">{renderDir('.', 0)}</div>
      {menu && (
        <div className="ctx-menu" style={{ left: menu.x, top: menu.y }}>
          {menu.node.dir && <button onClick={() => { setOpen((o) => new Set([...o, menu.node.path])); setCreating({ parent: menu.node.path, dir: false }); }}>新建文件</button>}
          {menu.node.dir && <button onClick={() => { setOpen((o) => new Set([...o, menu.node.path])); setCreating({ parent: menu.node.path, dir: true }); }}>新建文件夹</button>}
          {!menu.node.dir && PREVIEWABLE.test(menu.node.path) && <button onClick={() => openPreview(menu.node.path)}>在内置浏览器预览</button>}
          <button onClick={() => setRenaming(menu.node.path)}>重命名</button>
          <button onClick={() => navigator.clipboard.writeText(menu.node.path)}>复制相对路径</button>
          <button onClick={() => call('revealInFinder', menu.node.path)}>在访达中显示</button>
          <button className="danger" onClick={() => call('deleteFile', menu.node.path).catch((e) => toast(e.message, 'error'))}>删除</button>
        </div>
      )}
    </div>
  );
}
