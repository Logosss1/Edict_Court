// 上朝仪式 — daily opening ceremony (workbench overlay; the court mode plays it in 承天门).
import { useEffect, useState } from 'react';
import { useStore, setUI, getState } from '../store';
import { call } from '../api';
import { Icon } from '../common/Icon';
import { fmtCost, fmtTokens, usageTokens } from '../common/format';

function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

export function useTodayStats() {
  const tasks = useStore((s) => s.tasks);
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const t0 = start.getTime();
  return {
    issued: tasks.filter((t) => t.createdAt >= t0).length,
    done: tasks.filter((t) => t.state === 'Done' && t.updatedAt >= t0).length,
    running: tasks.filter((t) => !['Done', 'Cancelled', 'Blocked'].includes(t.state)).length,
    gates: tasks.filter((t) => t.gate).length,
    blocked: tasks.filter((t) => t.state === 'Blocked').length,
    tokens: tasks.filter((t) => t.updatedAt >= t0).reduce((n, t) => n + usageTokens(t.usage), 0),
    cost: tasks.filter((t) => t.updatedAt >= t0).reduce((n, t) => n + t.usage.costUsd, 0),
  };
}

export function CeremonyOverlay() {
  const show = useStore((s) => s.ui.ceremony);
  const mode = useStore((s) => s.ui.mode);
  const stats = useTodayStats();
  useEffect(() => {
    // first open of the day → play once (Edict: 每日首次打开播放开场动画)
    const s = getState().settings;
    if (s.ceremonyShownOn !== todayKey() && !navigator.webdriver) {
      setUI({ ceremony: true });
      void call('updateSettings', { ceremonyShownOn: todayKey() });
    }
  }, []);
  useEffect(() => {
    if (!show || mode === 'court') return;
    const t = setTimeout(() => setUI({ ceremony: false }), 3500);
    return () => clearTimeout(t);
  }, [show, mode]);
  if (!show || mode === 'court') return null;
  const d = new Date();
  return (
    <div className="ceremony" onClick={() => setUI({ ceremony: false })} data-testid="ceremony">
      <div className="ceremony-doors left" />
      <div className="ceremony-doors right" />
      <div className="ceremony-card">
        <div className="ceremony-seal">朝</div>
        <h1>上朝</h1>
        <div className="ceremony-date">{d.getFullYear()} 年 {d.getMonth() + 1} 月 {d.getDate()} 日 · 百官就位</div>
        <div className="ceremony-stats">
          <div><b>{stats.issued}</b><span>今日下旨</span></div>
          <div><b>{stats.done}</b><span>今日结案</span></div>
          <div><b>{stats.running}</b><span>进行中</span></div>
          <div><b>{stats.gates}</b><span>待御批</span></div>
          <div><b>{fmtTokens(stats.tokens)}</b><span>今日 Token</span></div>
        </div>
        <div className="muted small">点击任意处退朝 · 3.5 秒后自动退下</div>
      </div>
    </div>
  );
}

export function CeremonyPanel() {
  const stats = useTodayStats();
  const news = useStore((s) => s.news.slice(0, 6));
  return (
    <div className="panel">
      <div className="panel-head"><h2><Icon name="flag" size={18} /> 上朝仪式</h2></div>
      <div className="card ceremony-panel">
        <div className="ceremony-stats inline">
          <div><b>{stats.issued}</b><span>今日下旨</span></div>
          <div><b>{stats.done}</b><span>今日结案</span></div>
          <div><b>{stats.running}</b><span>进行中</span></div>
          <div><b>{stats.gates}</b><span>待御批</span></div>
          <div><b>{stats.blocked}</b><span>阻塞</span></div>
          <div><b>{fmtTokens(stats.tokens)}</b><span>今日 Token · {fmtCost(stats.cost)}</span></div>
        </div>
        <div className="row-gap">
          <button className="btn primary" onClick={() => setUI({ ceremony: true })}><Icon name="flag" size={13} /> 在工作台上朝</button>
          <button className="btn" onClick={() => setUI({ mode: 'court', courtScene: 'chengtian', ceremony: true })}><Icon name="crown" size={13} /> 前往承天门 · 像素上朝</button>
        </div>
        <p className="muted small">每日首次打开 Edict 会自动播放上朝仪式。</p>
      </div>
      <h3 className="section-title">早朝要闻</h3>
      {news.map((n) => <div key={n.id} className="news-item"><div className="news-title">{n.title}</div><div className="muted small">{n.source}</div></div>)}
    </div>
  );
}
