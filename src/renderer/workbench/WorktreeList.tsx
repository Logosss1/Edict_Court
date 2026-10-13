// 工作树 list for Source Control and 设置 · 工作树: the main checkout, each edict's worktree, manual ones.
import { useEffect, useState } from 'react';
import { useStore, selectTask, toast } from '../store';
import { call } from '../api';
import { Icon } from '../common/Icon';
import { askConfirm, askText } from '../common/Prompt';
import { openWorktreeDialog } from './WorktreeDialog';
import type { WorktreeInfo } from '../../shared/types';

const STATUS: Record<string, string> = { active: '', merged: '已合并', kept: '已保留分支', discarded: '已丢弃' };
const STATE: Record<string, string> = { Done: '待合并', Cancelled: '已取消 · 待处理', Blocked: '阻塞', PendingConfirm: '待御批', Review: '审议中', Doing: '执行中' };

export function useWorktrees() {
  const ws = useStore((s) => s.workspace);
  const tasks = useStore((s) => s.tasks);
  const fsVersion = useStore((s) => s.ui.fsVersion);
  const [list, setList] = useState<{ repoRoot: string | null; worktrees: WorktreeInfo[] } | null>(null);
  const sig = tasks.map((t) => `${t.id}:${t.state}:${t.worktree?.status ?? ''}`).join(',');
  const reload = () => void call<{ repoRoot: string | null; worktrees: WorktreeInfo[] }>('worktreeList').then(setList).catch(() => setList(null));
  useEffect(reload, [ws, sig, fsVersion]);
  return { list, reload };
}

export function WorktreeList({ compact }: { compact?: boolean }) {
  const { list, reload } = useWorktrees();
  if (!list) return null;
  if (!list.repoRoot) return <div className="muted small wt-empty">当前文件夹不是 Git 仓库：旨意直接在工作区里办，同一工作区的旨意依次执行。</div>;
  const create = async () => {
    const branch = await askText('新建工作树：分支名', { placeholder: '例如 try-vite7（不存在会从当前提交新建）' });
    if (!branch?.trim()) return;
    try {
      const w = await call<WorktreeInfo>('worktreeCreate', { branch: branch.trim() });
      toast(`已建立工作树 ${w.branch ?? ''}`, 'success');
      reload();
      if (await askConfirm('打开为工作区？', `${w.path}\n\n打开后编辑器、终端和新旨意都在这个工作树里。`, { ok: '打开' })) await call('worktreeOpen', w.path);
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  const remove = async (w: WorktreeInfo) => {
    if (!(await askConfirm(`移除工作树 ${w.branch ?? w.path}？`, `${w.path}\n\n目录会被删除；分支 ${w.branch ?? '（游离）'} 保留。有未提交改动时会拒绝。`, { ok: '移除', danger: true }))) return;
    try {
      const r = await call<{ message: string }>('worktreeRemove', w.path, {});
      toast(r.message, 'success');
      reload();
    } catch (e) {
      const msg = (e as Error).message;
      if (/未提交/.test(msg) && (await askConfirm('工作树里有未提交的改动', `${msg}\n\n强制移除会丢掉这些改动。`, { ok: '强制移除', danger: true }))) {
        await call('worktreeRemove', w.path, { force: true }).then(() => reload()).catch((x: Error) => toast(x.message, 'error'));
      } else toast(msg, 'error');
    }
  };
  return (
    <div className={`wt-list ${compact ? 'compact' : ''}`} data-testid="worktree-list">
      {list.worktrees.map((w) => {
        const name = w.main ? (w.branch ?? '（游离）') : w.kind === 'edict' && w.branch ? `edict/…${w.branch.slice(-4)}` : w.branch ?? w.path.split('/').pop();
        const note = w.kind === 'edict' ? w.taskTitle ?? '' : w.main ? '' : w.kind === 'manual' ? '手动 · 可打开为工作区' : '外部';
        const state = w.kind === 'edict' ? (w.status && w.status !== 'active' ? STATUS[w.status] : w.taskState ? STATE[w.taskState] ?? '使用中' : '') : '';
        return (
          <div key={w.path} className={`wt-row ${w.current ? 'cur' : ''} ${w.exists ? '' : 'gone'}`} title={`${w.path}${w.head ? `\n${w.head.slice(0, 10)}` : ''}`} data-testid={`wt-row-${w.kind}`}>
            <Icon name={w.main ? 'folder' : 'branch'} size={13} />
            <span className="wt-name ellipsis">{compact ? name : w.branch ?? w.path}</span>
            <span className="muted small ellipsis wt-note">{w.current ? '当前' : note}{!w.exists ? '（目录已不存在）' : ''}</span>
            {!w.current && state && <span className="muted small wt-state">· {state}</span>}
            <span className="wt-acts">
              {w.kind === 'edict' && w.taskId && <button className="icon-btn" title="查看旨意" onClick={() => selectTask(w.taskId!)}><Icon name="scroll" size={12} /></button>}
              {w.kind === 'edict' && w.taskId && (w.taskState === 'Done' || w.taskState === 'Cancelled') && <button className="icon-btn" title="结案处理：合并 / 保留分支 / 丢弃" onClick={() => openWorktreeDialog(w.taskId!)} data-testid="wt-finish"><Icon name="merge" size={12} /></button>}
              {!w.current && w.exists && <button className="icon-btn" title="打开为工作区" onClick={() => call('worktreeOpen', w.path).catch((e: Error) => toast(e.message, 'error'))} data-testid="wt-open"><Icon name="external" size={12} /></button>}
              {!w.main && !w.current && w.kind !== 'edict' && <button className="icon-btn" title="移除工作树" onClick={() => void remove(w)} data-testid="wt-remove"><Icon name="trash" size={12} /></button>}
            </span>
          </div>
        );
      })}
      <button className="link small wt-new" onClick={() => void create()} data-testid="wt-create"><Icon name="plus" size={12} /> 新建工作树…</button>
    </div>
  );
}
