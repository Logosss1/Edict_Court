import { Page } from '../ui';
import { ProvidersSection } from '../../panels/Models';

export function ProvidersPage() {
  return (
    <Page icon="cpu" title="模型服务" lead="兼容 OpenAI Chat Completions · Anthropic Messages · OpenAI Responses；base_url / API Key / 模型 id 均由你填写。" testid="settings-providers">
      <ProvidersSection />
    </Page>
  );
}
