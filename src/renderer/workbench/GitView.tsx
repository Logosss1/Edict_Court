import { useEffect, useState } from 'react';
import { useStore, openTab, toast } from '../store';
import { call } from '../api';
import { Icon } from '../common/Icon';
import { useGitStatus } from './Explorer';

export async function openGitDiff(path: string) {
  try {
    const [head, cur] = await Promise.all([call<string | null>('gitHead', path), call<string>('readFile', path).catch(() => '')]);
    openTab({ id: `diff:git:${path}`, kind: 'diff', title: `${path.split('/').pop()} (HEAD ↔ 工作区)`, diff: { original: head ?? '', modified: cur, path, label: 'Git 差异' } });
  } catch (e) {
    toast((e as Error).message, 'error');
  }
}

export function GitView() {
  const ws = useStore((s) => s.workspace);
  const fsVersion = useStore((s) => s.ui.fsVersion);
  const st = useGitStatus();
  const [msg, setMsg] = useState('');
  const [log, setLog] = useState<{ hash: string; author: string; when: string; subject: string }[]>([]);
  useEffect(() => {
    if (ws) call('gitLog').then(setLog).catch(() => setLog([]));
  }, [ws, fsVersion]);
  if (!ws) return <div className="side-view"><div className="side-title">源代码管理</div><div className="empty-side">请先打开工作区</div></div>;
  if (st && !st.isRepo)
    return (
      <div className="side-view">
        <div className="side-title">源代码管理</div>
        <div className="empty-side">
          <p>当前文件夹不是 Git 仓库。</p>
          <button className="btn" onClick={() => call('gitInit').then(() => toast('已初始化 Git 仓库', 'success'))}>初始化仓库</button>
        </div>
      </div>
    );
  const staged = st?.files.filter((f) => f.staged) ?? [];
  const unstaged = st?.files.filter((f) => !f.staged || (f as { worktree?: string }).worktree !== ' ') ?? [];
  const commit = async () => {
    if (!msg.trim()) return toast('请填写提交信息', 'warn');
    const r = await call<{ code: number; out: string; err: string }>('gitCommit', msg);
    if (r.code === 0) {
      toast('已提交', 'success');
      setMsg('');
    } else toast(r.err || r.out, 'error');
  };
  const row = (f: { path: string; status: string }, stagedList: boolean) => (
    <div key={(stagedList ? 's:' : 'u:') + f.path} className="git-row" onClick={() => openGitDiff(f.path)} title={f.path}>
      <span className={`git-badge git-${f.status}`}>{f.status[0].toUpperCase()}</span>
      <span className="tree-name">{f.path.split('/').pop()}</span>
      <span className="muted small ellipsis">{f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : ''}</span>
      <button className="icon-btn" title={stagedList ? '取消暂存' : '暂存'} onClick={(e) => { e.stopPropagation(); void call(stagedList ? 'gitUnstage' : 'gitStage', [f.path]); }}>
        <Icon name={stagedList ? 'minus' : 'plus'} size={13} />
      </button>
    </div>
  );
  return (
    <div className="side-view">
      <div className="side-title">
        <span>源代码管理</span>
        <span className="muted small"><Icon name="git" size={12} /> {st?.branch || '—'}</span>
      </div>
      <div className="git-commit">
        <textarea value={msg} onChange={(e) => setMsg(e.target.value)} placeholder="提交信息（⌘↵ 提交）" onKeyDown={(e) => e.key === 'Enter' && (e.metaKey || e.ctrlKey) && commit()} />
        <button className="btn primary" disabled={!staged.length} onClick={commit}>
          <Icon name="check" size={14} /> 提交 {staged.length ? `(${staged.length})` : ''}
        </button>
      </div>
      <div className="git-section">暂存的更改 · {staged.length}</div>
      {staged.map((f) => row(f, true))}
      <div className="git-section">
        更改 · {unstaged.length}
        {unstaged.length > 0 && <button className="link" onClick={() => call('gitStage', unstaged.map((f) => f.path))}>全部暂存</button>}
      </div>
      {unstaged.map((f) => row(f, false))}
      <div className="git-section">最近提交</div>
      {log.slice(0, 15).map((c) => (
        <div key={c.hash} className="git-log" title={`${c.author} · ${c.when}`}>
          <code>{c.hash}</code> {c.subject}
        </div>
      ))}
    </div>
  );
}
