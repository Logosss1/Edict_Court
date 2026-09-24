// 天下要闻 · News
import { useState } from 'react';
import { useStore, toast } from '../store';
import { call } from '../api';
import { Icon } from '../common/Icon';
import { fmtTime } from '../common/format';

export function News() {
  const news = useStore((s) => s.news);
  const feeds = useStore((s) => s.settings.newsFeeds ?? []);
  const [busy, setBusy] = useState(false);
  const [url, setUrl] = useState('');
  const [cat, setCat] = useState('科技');
  const [filter, setFilter] = useState('全部');
  const cats = ['全部', ...new Set(news.map((n) => n.category))];
  const refresh = async () => {
    setBusy(true);
    try {
      const r = await call<{ fetched: number; errors: string[] }>('newsRefresh');
      toast(`采集 ${r.fetched} 条${r.errors.length ? `，${r.errors.length} 个源失败` : ''}`, r.errors.length ? 'warn' : 'success');
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  const saveFeeds = (f: typeof feeds) => call('updateSettings', { newsFeeds: f });
  return (
    <div className="panel">
      <div className="panel-head">
        <h2><Icon name="news" size={18} /> 天下要闻</h2>
        <div className="panel-tools">
          {cats.map((c) => <button key={c} className={`pill ${filter === c ? 'on' : ''}`} onClick={() => setFilter(c)}>{c}</button>)}
          <button className="btn sm" disabled={busy} onClick={refresh}><Icon name="refresh" size={12} /> {busy ? '采集中…' : '采集'}</button>
        </div>
      </div>
      <div className="grid-2 wide-left">
        <div className="news-list">
          {!news.length && <div className="muted pad">暂无要闻。朝廷捷报（旨意完成）会自动张贴；也可在右侧订阅 RSS/Atom 新闻源。</div>}
          {news.filter((n) => filter === '全部' || n.category === filter).map((n) => (
            <div key={n.id} className="news-item">
              <div className="news-title">
                {n.link ? <a href={n.link} target="_blank" rel="noreferrer">{n.title}</a> : n.title}
              </div>
              {n.summary && <div className="muted small">{n.summary}</div>}
              <div className="muted small"><span className="chip chip-sm">{n.category}</span> {n.source} · {fmtTime(n.at)}</div>
            </div>
          ))}
        </div>
        <section className="card">
          <h3>订阅管理</h3>
          <p className="muted small">新闻源为你主动添加的地址，仅在点击「采集」时请求。不预置任何外部服务。</p>
          {feeds.map((f, i) => (
            <div key={i} className="feed-row">
              <input type="checkbox" checked={f.enabled} onChange={(e) => saveFeeds(feeds.map((x, k) => (k === i ? { ...x, enabled: e.target.checked } : x)))} />
              <span className="chip chip-sm">{f.category}</span>
              <span className="ellipsis small">{f.url}</span>
              <button className="icon-btn" onClick={() => saveFeeds(feeds.filter((_, k) => k !== i))}><Icon name="trash" size={12} /></button>
            </div>
          ))}
          <div className="row-gap">
            <input className="input" placeholder="https://…/feed.xml" value={url} onChange={(e) => setUrl(e.target.value)} />
            <input className="input" style={{ width: 80 }} value={cat} onChange={(e) => setCat(e.target.value)} />
            <button className="btn sm" onClick={() => { if (!/^https?:\/\//.test(url)) return toast('请输入 http(s) 链接', 'warn'); void saveFeeds([...feeds, { url, category: cat || '综合', enabled: true }]); setUrl(''); }}>添加</button>
          </div>
        </section>
      </div>
    </div>
  );
}
