import { useState } from 'react';
import { useStore, toast } from '../store';
import { call } from '../api';
import { Icon } from '../common/Icon';
import { openFile } from './Explorer';
import { requestReveal } from './editorBus';

interface Hit {
  path: string;
  line: number;
  col: number;
  preview: string;
}

export function SearchView() {
  const ws = useStore((s) => s.workspace);
  const [q, setQ] = useState('');
  const [rep, setRep] = useState('');
  const [showRep, setShowRep] = useState(false);
  const [opts, setOpts] = useState({ regex: false, caseSensitive: false, wholeWord: false, include: '' });
  const [hits, setHits] = useState<Hit[]>([]);
  const [busy, setBusy] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const run = async () => {
    if (!q) return setHits([]);
    setBusy(true);
    try {
      setHits(await call<Hit[]>('search', q, { ...opts, include: opts.include || undefined }));
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const replaceAll = async () => {
    const files = new Set(hits.map((h) => h.path)).size;
    if (!(await call<boolean>('confirm', `在 ${files} 个文件中替换 ${hits.length} 处？`, `“${q}” → “${rep}”`))) return;
    try {
      const r = await call<{ path: string; count: number }[]>('replaceAll', q, rep, { ...opts, include: opts.include || undefined });
      toast(`已替换 ${r.reduce((n, x) => n + x.count, 0)} 处（${r.length} 个文件）`, 'success');
      void run();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  const grouped = new Map<string, Hit[]>();
  for (const h of hits) grouped.set(h.path, [...(grouped.get(h.path) ?? []), h]);
  const toggle = (k: keyof typeof opts) => setOpts((o) => ({ ...o, [k]: !o[k] }));

  return (
    <div className="side-view">
      <div className="side-title">搜索</div>
      {!ws ? (
        <div className="empty-side">请先打开工作区</div>
      ) : (
        <div className="search-box">
          <div className="search-row">
            <button className="icon-btn" onClick={() => setShowRep(!showRep)} title="切换替换">
              <Icon name={showRep ? 'chevronDown' : 'chevronRight'} size={13} />
            </button>
            <div className="search-input-wrap">
              <input id="search-input" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && run()} placeholder="搜索（回车）" />
              <button className={`opt ${opts.caseSensitive ? 'on' : ''}`} onClick={() => toggle('caseSensitive')} title="区分大小写">Aa</button>
              <button className={`opt ${opts.wholeWord ? 'on' : ''}`} onClick={() => toggle('wholeWord')} title="全字匹配">ab</button>
              <button className={`opt ${opts.regex ? 'on' : ''}`} onClick={() => toggle('regex')} title="正则">.*</button>
            </div>
          </div>
          {showRep && (
            <div className="search-row">
              <span style={{ width: 22 }} />
              <div className="search-input-wrap">
                <input value={rep} onChange={(e) => setRep(e.target.value)} placeholder="替换为" />
                <button className="opt" disabled={!hits.length} onClick={replaceAll} title="全部替换">
                  <Icon name="check" size={13} />
                </button>
              </div>
            </div>
          )}
          <div className="search-row">
            <span style={{ width: 22 }} />
            <input className="search-include" value={opts.include} onChange={(e) => setOpts({ ...opts, include: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && run()} placeholder="包含文件（如 *.ts, src/**）" />
          </div>
          <div className="muted small" style={{ padding: '4px 10px' }}>
            {busy ? '搜索中…' : q ? `${hits.length} 个结果，${grouped.size} 个文件` : ''}
          </div>
          <div className="search-results">
            {[...grouped.entries()].map(([p, hs]) => (
              <div key={p}>
                <div className="sr-file" onClick={() => setCollapsed((c) => { const n = new Set(c); n.has(p) ? n.delete(p) : n.add(p); return n; })}>
                  <Icon name={collapsed.has(p) ? 'chevronRight' : 'chevronDown'} size={12} />
                  <Icon name="file" size={13} /> <span>{p.split('/').pop()}</span>
                  <span className="muted small">{p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : ''}</span>
                  <span className="count">{hs.length}</span>
                </div>
                {!collapsed.has(p) &&
                  hs.map((h, i) => (
                    <div key={i} className="sr-hit" onClick={() => { requestReveal(h.path, h.line, h.col); openFile(h.path); }}>
                      <span className="muted small">{h.line}</span> {h.preview.trim()}
                    </div>
                  ))}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
