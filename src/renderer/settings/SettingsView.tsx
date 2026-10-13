// 设置中心 (2.0): every setting in one editor tab — left nav with groups and search, one page at a time.
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useStore, openSettings, type SettingsSection } from '../store';
import { Icon } from '../common/Icon';
import { SETTINGS_GROUPS, SECTIONS } from './sections';
import { AppearancePage } from './pages/Appearance';
import { StoragePage } from './pages/Storage';
import { ProvidersPage } from './pages/Providers';
import { RoutingPage } from './pages/Routing';
import { RunPolicyPage } from './pages/RunPolicy';
import { PermissionsPage } from './pages/Permissions';
import { CanonPage } from './pages/Canon';
import { McpPage } from './pages/Mcp';
import { WebPage } from './pages/Web';
import { SkillsPage } from './pages/Skills';
import { LspPage } from './pages/Lsp';
import { AcpPage } from './pages/Acp';
import { WorktreesPage } from './pages/Worktrees';
import { AuditPanel } from '../panels/Audit';
import { Help } from '../panels/Help';
import './settings.css';

// 新 tags disappear once the page has been opened (kept per install, like the activity bar pins)
const SEEN_KEY = 'edict.settings.seenNew';
function loadSeen(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(SEEN_KEY) ?? '[]') as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function pageFor(id: SettingsSection): ReactNode {
  switch (id) {
    case 'appearance': return <AppearancePage />;
    case 'storage': return <StoragePage />;
    case 'providers': return <ProvidersPage />;
    case 'routing': return <RoutingPage />;
    case 'runtime': return <RunPolicyPage />;
    case 'permissions': return <PermissionsPage />;
    case 'canon': return <CanonPage />;
    case 'web': return <WebPage />;
    case 'mcp': return <McpPage />;
    case 'skills': return <SkillsPage />;
    case 'lsp': return <LspPage />;
    case 'acp': return <AcpPage />;
    case 'worktrees': return <WorktreesPage />;
    case 'audit': return <AuditPanel />;
    case 'help': return <Help />;
  }
}

export function SettingsView() {
  const section = useStore((s) => s.ui.settingsSection);
  const mcpBad = useStore((s) => s.mcp.filter((m) => m.status === 'error' || m.status === 'needs_auth' || m.status === 'untrusted').length);
  const [q, setQ] = useState('');
  const [seen, setSeen] = useState(loadSeen);
  useEffect(() => {
    if (!SECTIONS.find((x) => x.id === section)?.isNew || seen.includes(section)) return;
    const next = [...seen, section];
    setSeen(next);
    try {
      localStorage.setItem(SEEN_KEY, JSON.stringify(next));
    } catch {
      /* ignore */
    }
  }, [section, seen]);
  const query = q.trim().toLowerCase();
  const hits = useMemo(() => (query ? SECTIONS.filter((x) => `${x.label} ${x.keywords}`.toLowerCase().includes(query)) : null), [query]);
  const badge = (id: SettingsSection, isNew?: boolean) => {
    if (id === 'mcp' && mcpBad) return <span className="sn-b">{mcpBad}</span>;
    if (isNew && !seen.includes(id)) return <span className="sn-b n">新</span>;
    return null;
  };
  const item = (x: (typeof SECTIONS)[number]) => (
    <button key={x.id} className={`sn-i ${section === x.id ? 'on' : ''}`} onClick={() => openSettings(x.id)} data-testid={`sn-${x.id}`}>
      <Icon name={x.icon} size={14} />
      <span className="ellipsis">{x.label}</span>
      {badge(x.id, x.isNew)}
    </button>
  );
  return (
    <div className="setc" data-testid="settings">
      <nav className="setc-nav">
        <label className="sn-search">
          <Icon name="search" size={13} />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索设置" data-testid="settings-search" onKeyDown={(e) => { if (e.key === 'Enter' && hits?.[0]) openSettings(hits[0].id); if (e.key === 'Escape') setQ(''); }} />
          {q && <button className="icon-btn" onClick={() => setQ('')} aria-label="清空"><Icon name="x" size={12} /></button>}
        </label>
        {hits ? (
          <>
            <div className="sn-g">搜索结果</div>
            {hits.length ? hits.map(item) : <div className="muted small sn-none">没有匹配的设置</div>}
          </>
        ) : (
          SETTINGS_GROUPS.map((g) => (
            <div key={g.title} className="sn-group">
              <div className="sn-g">{g.title}</div>
              {g.items.map(item)}
            </div>
          ))
        )}
      </nav>
      <div className="setc-main" key={section}>
        {pageFor(section)}
      </div>
    </div>
  );
}
