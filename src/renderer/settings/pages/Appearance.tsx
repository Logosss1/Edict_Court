import { setUI, useStore } from '../../store';
import { call } from '../../api';
import { Icon } from '../../common/Icon';
import type { Settings } from '../../../shared/types';
import { Page, Row, Sec, Toggle } from '../ui';

const THEMES: { id: Settings['theme']; label: string; desc: string; icon: string }[] = [
  { id: 'system', label: '跟随系统', desc: '随 macOS 外观自动切换', icon: 'monitor' },
  { id: 'light', label: '浅色', desc: '宣纸底色，朱红与金', icon: 'sparkles' },
  { id: 'dark', label: '深色', desc: '墨色底，适合夜间', icon: 'eye' },
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
      <Sec title="下旨框">
        <Row label="显示右侧下旨框" desc="隐藏后可按 ⌘L 或点「下旨」重新打开">
          <Toggle on={!s.composerHidden} onChange={(v) => { setUI({ composerHidden: !v }); void up({ composerHidden: !v }); }} label="显示下旨框" />
        </Row>
      </Sec>
    </Page>
  );
}
