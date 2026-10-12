import { Page } from '../ui';
import { AgentView, SkillsTab } from '../../panels/Skills';

export function SkillsPage() {
  return (
    <Page icon="puzzle" title="技能" lead="每位官员有固定的职责技能；另配的技能像浏览器扩展一样按官员开关。" testid="settings-skills">
      <div className="skills-center" data-testid="skills-center"><SkillsTab /><AgentView /></div>
    </Page>
  );
}
