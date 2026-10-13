// 工作树: each court edict on a git repository works in its own worktree (branch edict/<id>), so edicts on one
// repo run side by side and the open workspace stays untouched until 结案 (合并 / 保留分支 / 丢弃).
import { toast, useStore } from '../../store';
import { call } from '../../api';
import type { Settings } from '../../../shared/types';
import { Page, Row, Sec, Toggle } from '../ui';
import { WorktreeList } from '../../workbench/WorktreeList';

export function WorktreesPage() {
  const settings = useStore((s) => s.settings);
  const ws = useStore((s) => s.workspace);
  const on = settings.worktreePerEdict !== false;
  const up = (p: Partial<Settings>) => call('updateSettings', p).catch((e: Error) => toast(e.message, 'error'));
  return (
    <Page icon="branch" title="工作树" lead="Git 仓库里的旨意可以各在自己的工作树（独立的分支和目录）里办：几道旨意同时进行互不干扰，你的工作区在结案前一个文件都不会动。" testid="settings-worktrees">
      <Sec>
        <Row label="每道旨意一个工作树" desc={on ? '开启：三省六部流程的旨意在 edict/<旨意号> 分支上办，依赖目录（node_modules 等）从主工作区链接过去；结案时选择合并、保留分支或丢弃。Solo 和不动文件的协同设计不建工作树。' : '关闭：旨意直接在打开的工作区里改文件，同一工作区的旨意依次执行。'} testid="wt-toggle-row">
          <Toggle on={on} onChange={(v) => up({ worktreePerEdict: v })} label="每道旨意一个工作树" testid="wt-per-edict" />
        </Row>
      </Sec>
      <Sec title="当前仓库的工作树" note={ws ? undefined : '请先打开工作区'}>
        {ws && <WorktreeList />}
      </Sec>
      <Sec title="说明">
        <ul className="sp-ul">
          <li><b>合并</b>：先把工作树里的改动提交到旨意分支，再在主工作区 <code>git merge --no-ff</code>。有冲突或主工作区有挡路的改动时会自动中止，主工作区保持原样，分支保留，并列出相关文件。</li>
          <li><b>保留分支</b>：提交后删掉工作树目录，分支留着，以后可以在这里或「源代码管理」里再合并或打开。</li>
          <li><b>丢弃</b>：删除工作树和分支，改动不保留。</li>
          <li>手动新建的工作树可以「打开为工作区」，编辑器、终端和新旨意都在那里进行。</li>
          <li>权限里的「本工作区永久允许」规则按主工作区记，工作树里的旨意同样适用。</li>
        </ul>
      </Sec>
    </Page>
  );
}
