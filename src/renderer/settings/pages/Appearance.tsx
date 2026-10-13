import { setUI, useStore } from '../../store';
import { call } from '../../api';
import { Icon } from '../../common/Icon';
import type { NotifyPref, Settings } from '../../../shared/types';
import { Page, Row, Sec, Toggle } from '../ui';

const THEMES: { id: Settings['theme']; label: string; desc: string; icon: string }[] = [
  { id: 'system', label: '跟随系统', desc: '随 macOS 外观自动切换', icon: 'monitor' },
  { id: 'light', label: '浅色', desc: '宣纸底色，朱红与金', icon: 'sparkles' },
  { id: 'dark', label: '深色', desc: '墨色底，适合夜间', icon: 'eye' },
];

const NOTIFY: { id: NotifyPref; label: string; desc: string; icon: string }[] = [
  { id: 'all', label: '全部', desc: '要你处理的事，以及旨意完成', icon: 'bell' },
  { id: 'attention', label: '只提醒要我处理的', desc: '审批、请旨、奏折待批、阻塞与失联', icon: 'alert' },
  { id: 'off', label: '关闭', desc: '不弹系统通知，只在应用内提示', icon: 'x' },
];

export function AppearancePage() {
  const s = useStore((st) => st.settings);
  const up = (p: Partial<Settings>) => call('updateSettings', p);
  return (
    <Page icon="sparkles" title="外观与通知" lead="界面主题、下旨框，以及窗口不在前台时的桌面通知。" testid="settings-appearance">
      <Sec title="主题">
        <div className="mode-cards three">
          {THEMES.map((t) => (
            <button key={t.id} className={`mode-card ${s.theme === t.id ? 'on' : ''}`} onClick={() => up({ theme: t.id })} data-testid={`theme-${t.id}`}>
              <span className="t"><Icon name={t.icon} size={14} /> {t.label}</span>
              <span className="d">{t.desc}</span>
            </button>
          ))}
        </div>
      </Sec>
      <Sec title="桌面通知" note="· 只在 Edict 窗口不在前台时弹出；窗口在前台时用应用内提示">
        <div className="mode-cards three" role="radiogroup" aria-label="桌面通知">
          {NOTIFY.map((n) => {
            const on = (s.notify ?? 'all') === n.id;
            return (
              <button key={n.id} role="radio" aria-checked={on} className={`mode-card ${on ? 'on' : ''}`} onClick={() => up({ notify: n.id })} data-testid={`notify-${n.id}`}>
                <span className="t"><Icon name={n.icon} size={14} /> {n.label}</span>
                <span className="d">{n.desc}</span>
              </button>
            );
          })}
        </div>
      </Sec>
      <Sec title="下旨框">
        <Row label="显示右侧下旨框" desc="隐藏后可按 ⌘L 或点「下旨」重新打开">
          <Toggle on={!s.composerHidden} onChange={(v) => { setUI({ composerHidden: !v }); void up({ composerHidden: !v }); }} label="显示下旨框" />
        </Row>
      </Sec>
    </Page>
  );
}
