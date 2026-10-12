import { Page } from '../ui';
import { Policy } from '../../panels/Models';

export function RunPolicyPage() {
  return (
    <Page icon="zap" title="运行策略" lead="预算、封驳上限、审批门、议政与并行度。" testid="settings-runtime">
      <Policy />
    </Page>
  );
}
