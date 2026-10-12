import { Page } from '../ui';
import { McpTab } from '../../panels/Skills';

export function McpPage() {
  return (
    <Page icon="plug" title="连接服务（MCP）" lead="让官员使用外部工具：本地命令或远程服务。" testid="settings-mcp">
      <div className="skills-center" data-testid="skills-center"><McpTab /></div>
    </Page>
  );
}
