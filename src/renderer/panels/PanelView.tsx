import type { PanelId } from '../store';
import { Kanban } from './Kanban';
import { Monitor, Officials } from './Monitor';
import { Memorials } from './Memorials';
import { Templates } from './Templates';
import { News } from './News';
import { Models } from './Models';
import { Skills } from './Skills';
import { Designs } from './Designs';
import { Schedules } from './Schedules';
import { Sessions } from './Sessions';
import { CeremonyPanel } from './Ceremony';
import { DebatePanel } from './Debate';
import { AuditPanel } from './Audit';
import { Help } from './Help';
import { SettingsView } from '../settings/SettingsView';

export function PanelView({ panel }: { panel: PanelId }) {
  switch (panel) {
    case 'kanban':
      return <Kanban />;
    case 'monitor':
      return <Monitor />;
    case 'memorials':
      return <Memorials />;
    case 'templates':
      return <Templates />;
    case 'officials':
      return <Officials />;
    case 'news':
      return <News />;
    case 'models':
      return <Models />;
    case 'designs':
      return <Designs />;
    case 'schedules':
      return <Schedules />;
    case 'skills':
      return <Skills />;
    case 'sessions':
      return <Sessions />;
    case 'ceremony':
      return <CeremonyPanel />;
    case 'debate':
      return <DebatePanel />;
    case 'audit':
      return <AuditPanel />;
    case 'help':
      return <Help />;
    case 'settings':
      return <SettingsView />;
    default:
      return null;
  }
}
