// Activity bar (2.0): side views on top, screens in the middle (customisable: right-click to pin / unpin,
// drag to reorder; whatever doesn't fit goes into 更多), then 连接服务 / 技能 / 权限 / 终端 / 设置 at the bottom.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useStore, setUI, openPanel, openSettings, type PanelId, type UIState } from '../store';
import { Icon } from '../common/Icon';
import { tip } from '../common/Tip';
import { useAttentionCount } from '../common/attention';
import { useGitStatus } from './Explorer';

type SideId = Exclude<UIState['sideView'], null | 'court'>;

const SIDE: { id: SideId; icon: string; label: string; desc: string; kbd?: string }[] = [
  { id: 'explorer', icon: 'files', label: '资源管理器', desc: '浏览和打开工作区里的文件' },
  { id: 'search', icon: 'search', label: '全局搜索', desc: '在整个工作区里搜索文字', kbd: '⇧⌘F' },
  { id: 'git', icon: 'git', label: '源代码管理', desc: '查看改动、提交代码，管理工作树' },
  { id: 'inbox', icon: 'inbox', label: '待办', desc: '所有等你处理的事：开工、请旨、回奏、阻塞、合并' },
  { id: 'preview', icon: 'globe', label: '网页预览', desc: '预览网页文件或本地开发服务器' },
];

export interface ScreenDef { id: PanelId; icon: string; label: string; desc: string }
/** Screens that can sit on the bar; the rest live in 更多功能. */
export const SCREENS: ScreenDef[] = [
  { id: 'kanban', icon: 'kanban', label: '旨意看板', desc: '所有旨意的进度，需要你处理的排在最上面' },
  { id: 'memorials', icon: 'scroll', label: '奏折阁', desc: '结案旨意的回奏存档' },
  { id: 'monitor', icon: 'monitor', label: '省部调度', desc: '每位官员此刻在做什么、用量与健康' },
  { id: 'schedules', icon: 'clock', label: '定时旨意', desc: '到点自动下旨，比如每天早上跑一遍测试' },
  { id: 'designs', icon: 'layers', label: '协同设计', desc: '自己设计多个 AI 怎么分工协作' },
  { id: 'debate', icon: 'gavel', label: '朝堂议政', desc: '让几位官员就一件事辩论' },
  { id: 'templates', icon: 'book', label: '旨库', desc: '常用旨意模板，一键下旨' },
  { id: 'officials', icon: 'users', label: '官员总览', desc: '各官员的职责、模型与战绩' },
  { id: 'news', icon: 'news', label: '天下要闻', desc: '捷报与你订阅的新闻源' },
  { id: 'ceremony', icon: 'flag', label: '上朝仪式', desc: '今日统计与上朝动画' },
  { id: 'sessions', icon: 'message', label: '小任务', desc: '不走朝堂流程的单人对话' },
  { id: 'audit', icon: 'shield', label: '审计日志', desc: '关键操作的防篡改记录' },
  { id: 'help', icon: 'help', label: '使用说明', desc: '功能介绍与快捷键' },
];
const DEFAULT_PINNED: PanelId[] = ['kanban', 'schedules', 'memorials', 'monitor', 'designs', 'debate'];
const KEY = 'edict.activitybar.v2';
const ITEM_H = 37;

function loadPinned(): PanelId[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null') as PanelId[] | null;
    if (Array.isArray(v)) return v.filter((id) => SCREENS.some((s) => s.id === id));
  } catch {
    /* ignore */
  }
  return DEFAULT_PINNED;
}
function savePinned(v: PanelId[] | null) {
  try {
    if (v) localStorage.setItem(KEY, JSON.stringify(v));
    else localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

/** Keep a popup's bottom inside the window (it grows with the number of screens). */
const fitMenu = (y: number) => (el: HTMLDivElement | null) => {
  if (el) el.style.top = `${Math.max(8, Math.min(y, window.innerHeight - el.offsetHeight - 8))}px`;
};

const MODE_DOT: Record<string, { color: string; label: string }> = {
  readonly: { color: 'var(--blue)', label: '只读' },
  ask: { color: 'var(--gold)', label: '询问' },
  'auto-edit': { color: 'var(--jade)', label: '自动编辑' },
  auto: { color: 'var(--danger)', label: '全自动' },
};

export function ActivityBar() {
  const sideView = useStore((s) => s.ui.sideView);
  const bottomOpen = useStore((s) => s.ui.bottomOpen);
  const active = useStore((s) => s.ui.tabs.find((t) => t.id === s.ui.activeTab));
  const settingsSection = useStore((s) => s.ui.settingsSection);
  const mode = useStore((s) => s.settings.permissionMode);
  const mcpBad = useStore((s) => s.mcp.filter((m) => m.status === 'error' || m.status === 'untrusted' || m.status === 'needs_auth').length);
  const attn = useAttentionCount();
  const git = useGitStatus();
  const changes = git?.isRepo ? git.files.length : 0;
  const [pinned, setPinned] = useState<PanelId[]>(loadPinned);
  const [fit, setFit] = useState(99);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [more, setMore] = useState<{ y: number } | null>(null);
  const [drag, setDrag] = useState<PanelId | null>(null);
  const midRef = useRef<HTMLDivElement>(null);

  // how many pinned screens fit between the side views and the bottom group (the rest overflow into 更多)
  useLayoutEffect(() => {
    const el = midRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setFit(Math.max(0, Math.floor(el.clientHeight / ITEM_H) - 1)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    if (!menu && !more) return;
    const close = () => {
      setMenu(null);
      setMore(null);
    };
    window.addEventListener('mousedown', close);
    window.addEventListener('blur', close);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('blur', close);
    };
  }, [menu, more]);

  const update = (v: PanelId[]) => {
    setPinned(v);
    savePinned(v);
  };
  const shown = pinned.slice(0, fit);
  const overflow = [...pinned.slice(fit), ...SCREENS.filter((s) => !pinned.includes(s.id)).map((s) => s.id)];
  const screen = (id: PanelId) => SCREENS.find((s) => s.id === id)!;
  const onPanel = (id: PanelId) => active?.kind === 'panel' && active.panel === id;
  const onSettings = (s?: string) => active?.kind === 'panel' && active.panel === 'settings' && (!s || settingsSection === s);

  const side = (d: (typeof SIDE)[number]) => {
    const badge = d.id === 'git' ? changes : d.id === 'inbox' ? attn : 0;
    return (
      <button key={d.id} className={`ab-item ${sideView === d.id ? 'on' : ''}`} {...tip(d.label, d.desc, d.kbd)} onClick={() => setUI({ sideView: sideView === d.id ? null : d.id })} data-testid={`ab-${d.id}`}>
        <Icon name={d.icon} size={21} stroke={1.6} />
        {badge > 0 && <span className={`ab-badge ${d.id === 'git' ? 'gold' : ''}`}>{badge > 99 ? '99+' : badge}</span>}
      </button>
    );
  };

  return (
    <nav className="activitybar v2" onContextMenu={(e) => { e.preventDefault(); setMore(null); setMenu({ x: e.clientX, y: e.clientY }); }} data-testid="activitybar">
      {SIDE.map(side)}
      <div className="ab-sep" />
      <div className="ab-mid" ref={midRef}>
        {shown.map((id) => {
          const s = screen(id);
          return (
            <button
              key={id}
              className={`ab-item ${onPanel(id) ? 'on' : ''} ${drag === id ? 'dragging' : ''}`}
              {...tip(s.label, s.desc)}
              draggable
              onDragStart={(e) => { setDrag(id); e.dataTransfer.effectAllowed = 'move'; }}
              onDragEnd={() => setDrag(null)}
              onDragOver={(e) => { if (drag && drag !== id) e.preventDefault(); }}
              onDrop={() => {
                if (!drag || drag === id) return;
                const v = pinned.filter((x) => x !== drag);
                v.splice(v.indexOf(id), 0, drag);
                update(v);
                setDrag(null);
              }}
              onClick={() => openPanel(id)}
              data-testid={`ab-${id}`}
            >
              <Icon name={s.icon} size={20} stroke={1.6} />
            </button>
          );
        })}
        <button className={`ab-item ${more ? 'on' : ''}`} {...tip('更多功能', overflow.map((id) => screen(id).label).join('、'))} onMouseDown={(e) => e.stopPropagation()} onClick={(e) => { setMenu(null); setMore(more ? null : { y: Math.min((e.currentTarget as HTMLElement).getBoundingClientRect().top, window.innerHeight - 60 - overflow.length * 32) }); }} data-testid="ab-more">
          <Icon name="grid" size={19} stroke={1.6} />
        </button>
      </div>
      <button className={`ab-item ${onSettings('mcp') ? 'on' : ''}`} {...tip('连接服务（MCP）', mcpBad > 0 ? `外部工具；有 ${mcpBad} 个服务异常、待登录或待信任` : '让官员使用外部工具：本地命令或远程服务')} onClick={() => openSettings('mcp')} data-testid="ab-mcp">
        <Icon name="plug" size={20} stroke={1.6} />
        {mcpBad > 0 && <span className="ab-badge">{mcpBad}</span>}
      </button>
      <button className={`ab-item ${onSettings('skills') ? 'on' : ''}`} {...tip('技能', '给每位官员配技能，按官员单独开关')} onClick={() => openSettings('skills')} data-testid="ab-skills">
        <Icon name="puzzle" size={20} stroke={1.6} />
      </button>
      <button className={`ab-item ${onSettings('permissions') ? 'on' : ''}`} {...tip('权限与审批', `当前：${MODE_DOT[mode]?.label ?? mode}。官员动手前要不要先问你`)} onClick={() => openSettings('permissions')} data-testid="ab-permissions">
        <Icon name="shield" size={20} stroke={1.6} />
        <span className="ab-mode" style={{ background: MODE_DOT[mode]?.color }} />
      </button>
      <button className={`ab-item ${bottomOpen ? 'on' : ''}`} {...tip('终端 / 问题 / 输出', '打开或收起底部面板', '⌃`')} onClick={() => setUI({ bottomOpen: !bottomOpen })} data-testid="ab-terminal">
        <Icon name="terminal" size={20} stroke={1.6} />
      </button>
      <button className={`ab-item ${onSettings() && !['mcp', 'skills', 'permissions'].includes(settingsSection) ? 'on' : ''}`} {...tip('设置', '所有设置集中在一页', '⌘,')} onClick={() => openSettings()} data-testid="ab-settings">
        <Icon name="settings" size={20} stroke={1.6} />
      </button>
      {more && (
        <div className="ab-pop" style={{ top: more.y }} onMouseDown={(e) => e.stopPropagation()} data-testid="ab-more-menu">
          <div className="ab-pop-h">更多功能</div>
          {overflow.map((id) => {
            const s = screen(id);
            return (
              <button key={id} className="ab-pop-i" onClick={() => { setMore(null); openPanel(id); }}>
                <Icon name={s.icon} size={14} /> <span>{s.label}</span> <span className="muted ellipsis">{s.desc}</span>
              </button>
            );
          })}
          <div className="ab-pop-sep" />
          <button className="ab-pop-i" onClick={() => { setMore(null); setUI({ mode: 'court' }); }}>
            <Icon name="crown" size={14} /> <span>进入朝堂</span> <span className="muted">⌘J</span>
          </button>
          <div className="ab-pop-foot muted">右键活动栏可以把常用的固定上来</div>
        </div>
      )}
      {menu && (
        <div className="ab-pop ctx" ref={fitMenu(menu.y)} style={{ top: menu.y, left: 52 }} onMouseDown={(e) => e.stopPropagation()} data-testid="ab-customize">
          <div className="ab-pop-h">活动栏：固定到左侧</div>
          {SCREENS.map((s) => {
            const on = pinned.includes(s.id);
            return (
              <button key={s.id} className="ab-pop-i" onClick={() => update(on ? pinned.filter((x) => x !== s.id) : [...pinned, s.id])} data-testid={`ab-pin-${s.id}`}>
                <span className="ck">{on && <Icon name="check" size={13} />}</span> <Icon name={s.icon} size={14} /> <span>{s.label}</span>
              </button>
            );
          })}
          <div className="ab-pop-sep" />
          <div className="ab-pop-foot muted">拖动图标可以调整顺序</div>
          <button className="ab-pop-i" onClick={() => { setPinned(DEFAULT_PINNED); savePinned(null); setMenu(null); }} data-testid="ab-reset">
            <span className="ck" /> <Icon name="undo" size={14} /> <span>恢复默认</span>
          </button>
        </div>
      )}
    </nav>
  );
}
