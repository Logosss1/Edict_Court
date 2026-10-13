// 工作树: each court edict on a git repository works in its own worktree (branch edict/<id>), so edicts on one
// repo run side by side and the open workspace stays untouched until 结案 (合并 / 保留分支 / 丢弃).
import { useEffect, useState } from 'react';
import { toast, useStore } from '../../store';
import { call } from '../../api';
import type { Settings, WorktreeSetup } from '../../../shared/types';
import { Page, Row, Sec, Toggle } from '../ui';
import { WorktreeList } from '../../workbench/WorktreeList';
import { NumField, baseName } from './numField';
import { PathList } from './SandboxSection';

const NO_SETUP: WorktreeSetup = { script: '', copy: [], linkDeps: true, timeoutMin: 10 };

/** 工作树准备 for the open workspace: files to copy, links, a script; plus the port base (all workspaces). */
function SetupSection({ root }: { root: string }) {
  const setup = useStore((s) => s.settings.workspacePerms?.[root]?.worktreeSetup) ?? NO_SETUP;
  const portBase = useStore((s) => s.settings.worktreePortBase) ?? 42000;
  const [script, setScript] = useState(setup.script);
  useEffect(() => setScript(setup.script), [setup.script]);
  const save = (patch: Partial<WorktreeSetup>) => call('saveWorktreeSetup', root, patch).catch((e: Error) => toast(e.message, 'error'));
  return (
    <Sec title={`工作树准备 · ${baseName(root)}`} note="每道旨意的工作树建好后、官员动手前执行" testid="wt-setup">
      <Row label="复制这些文件" desc="不在 git 里、但项目要用的文件（如 .env），从主工作区复制到新工作树。一行一个，相对主工作区；最后一段可用 * 通配。已存在的不覆盖。">
        <PathList value={setup.copy} onSave={(v) => void save({ copy: v })} testid="wt-setup-copy" placeholder={'.env\n.env.local'} />
      </Row>
      <Row label="链接依赖目录" desc={setup.linkDeps ? '开启：node_modules、.venv、venv 从主工作区链接过去，新工作树不用重装。准备脚本要自己装依赖时请关掉，免得装进主工作区。' : '关闭：新工作树没有依赖目录，由准备脚本（或官员）自己安装。'}>
        <Toggle on={setup.linkDeps} onChange={(v) => void save({ linkDeps: v })} label="链接依赖目录" testid="wt-setup-link" />
      </Row>
      <Row label="准备脚本" desc="在新工作树里运行（以你的身份，不经过命令沙箱）。可用环境变量 $EDICT_ROOT_PATH（主工作区）、$EDICT_WORKTREE_PATH、$EDICT_PORT。失败不挡旨意，官员会被告知依赖可能没装好。">
        <textarea
          className="input sbx-list"
          rows={Math.min(8, Math.max(3, script.split('\n').length + 1))}
          value={script}
          placeholder={'例如：\nnpm ci\n或：cp "$EDICT_ROOT_PATH/.env" . && pnpm install --frozen-lockfile'}
          onChange={(e) => setScript(e.target.value)}
          onBlur={() => script.trim() !== setup.script && void save({ script })}
          spellCheck={false}
          data-testid="wt-setup-script"
        />
      </Row>
      <Row label="脚本时限" desc="超过就停止脚本，旨意照常进行">
        <NumField value={setup.timeoutMin} min={1} max={120} unit="分钟" label="准备脚本时限（分钟）" testid="wt-setup-timeout" onCommit={(v) => void save({ timeoutMin: v })} />
      </Row>
      <Row label="端口起点（所有工作区）" desc={`每个旨意工作树独占 10 个端口，从 ${portBase} 往上排，用完的会再分给新的。官员的命令里用 $EDICT_PORT 起开发服务器，几道旨意同时跑也不抢端口。`}>
        <NumField value={portBase} min={1024} max={65000} step={10} label="端口起点" testid="wt-port-base" onCommit={(v) => void call('updateSettings', { worktreePortBase: v }).catch((e: Error) => toast(e.message, 'error'))} />
      </Row>
    </Sec>
  );
}

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
      {ws && on && <SetupSection root={ws} />}
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
