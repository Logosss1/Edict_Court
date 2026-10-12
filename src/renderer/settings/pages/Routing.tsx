import { Page } from '../ui';
import { AgentModels, Routing } from '../../panels/Models';

export function RoutingPage() {
  return (
    <Page icon="users" title="官员模型与路由" lead="动脑的角色用强模型，粗活用经济模型；也可以给每位官员单独指定模型和思考程度。" testid="settings-routing">
      <Routing />
      <AgentModels />
    </Page>
  );
}
