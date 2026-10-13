// 结案 dialog for an edict that worked in its own git worktree: what changed (+/− per file), then
// 合并 / 保留分支 / 丢弃 with an editable commit subject. Opens by itself once when the selected edict's
// 结案 card appears; also from the 待办 / Kanban card, the agent pane card and the edict detail.
import { useEffect, useState } from 'react';
import { useStore, setUI, toast } from '../store';
import { call } from '../api';
import { Icon } from '../common/Icon';
import { AGENT_MAP } from '../../shared/court';
import type { ApprovalChoice, Task, WorktreeFinishResult } from '../../shared/types';

type DiffFile = { path: string; added: number; removed: number; binary?: boolean; untracked?: boolean };

export function openWorktreeDialog(taskId: string, choice?: string) {
  setUI({ worktreeDialog: { taskId, choice } });
}

/** Branch to show for an edict whose worktree still matters (in use, or kept for later). */
export function worktreeLabel(t: Task): { branch: string; status: string; tone: string } | null {
  const w = t.worktree;
  if (!w) return null;
  const status = { active: TERMINAL_STATES.includes(t.state) ? '待结案处理' : '独立工作树', merged: '已合并', kept: '已保留分支', discarded: '已丢弃' }[w.status];
  return { branch: w.branch, status, tone: w.status === 'active' ? (TERMINAL_STATES.includes(t.state) ? 'gold' : 'jade') : w.status === 'kept' ? 'gold' : 'muted' };
}
const TERMINAL_STATES = ['Done', 'Cancelled'];

/** Choices when no 结案 card is open (the edict detail, a kept branch). Mirrors the backend card. */
function choicesFor(t: Task): ApprovalChoice[] {
  const w = t.worktree!;
  const into = w.baseBranch ?? '主工作区';
  if (w.status === 'kept')
    return [
      { id: 'merge', label: `合并到 ${into}`, hint: `把保留的分支 ${w.branch} 用 git merge --no-ff 并入${w.baseBranch ? ` ${w.baseBranch}` : '主工作区'}；有冲突会自动中止并列出文件`, approve: true, tone: 'primary' },
      { id: 'discard', label: '删除分支', hint: `删除分支 ${w.branch}，其中的改动不会保留`, approve: true, tone: 'danger' },
    ];
  const done = t.state === 'Done';
  return [
    ...(done ? [{ id: 'merge', label: `合并到 ${into}`, hint: `先提交到 ${w.branch}，再 git merge --no-ff 进${w.baseBranch ? ` ${w.baseBranch}` : '主工作区'}。有冲突会自动中止、保留分支，并列出冲突的文件`, approve: true, tone: 'primary' as const }] : []),
    { id: 'keep', label: '保留分支', hint: `提交到 ${w.branch}，删掉工作树目录；以后可在「源代码管理 → 工作树」里合并或打开`, approve: true, tone: done ? 'default' : 'primary' },
    { id: 'discard', label: '丢弃', hint: `删除工作树和分支 ${w.branch}，这些改动不会保留`, approve: true, tone: 'danger' },
  ];
}

const seen = new Set<string>();

/** Mounted once in App. */
export function WorktreeDialogHost() {
  const dlg = useStore((s) => s.ui.worktreeDialog);
  const sel = useStore((s) => s.ui.selectedTaskId);
  const mode = useStore((s) => s.ui.mode);
  const cardId = useStore((s) => s.approvals.find((a) => a.kind === 'worktree' && a.status === 'pending' && a.taskId === sel)?.id);
  useEffect(() => {
    if (!cardId || !sel || dlg || mode !== 'workbench' || seen.has(cardId)) return;
    seen.add(cardId);
    openWorktreeDialog(sel);
  }, [cardId, sel, dlg, mode]);
  if (!dlg) return null;
  return <WorktreeDialog key={`${dlg.taskId}:${dlg.choice ?? ''}`} taskId={dlg.taskId} initial={dlg.choice} />;
}

function WorktreeDialog({ taskId, initial }: { taskId: string; initial?: string }) {
  const task = useStore((s) => s.tasks.find((t) => t.id === taskId));
  const card = useStore((s) => s.approvals.find((a) => a.kind === 'worktree' && a.status === 'pending' && a.taskId === taskId));
  const w = task?.worktree;
  const choices = card?.choices?.length ? card.choices : task && w ? choicesFor(task) : [];
  const [sel, setSel] = useState(initial && choices.some((c) => c.id === initial) ? initial : choices[0]?.id);
  const [msg, setMsg] = useState(task ? `${task.title}（${task.id}）` : '');
  const [files, setFiles] = useState<DiffFile[] | null>(null);
  const [busy, setBusy] = useState(false);
  const close = () => setUI({ worktreeDialog: null });
  const live = !!w && (w.status === 'active' || w.status === 'kept');
  useEffect(() => {
    if (live) call<DiffFile[]>('worktreeDiffStat', taskId).then(setFiles).catch(() => setFiles([]));
  }, [taskId, live, w?.conflicts?.length]);
  useEffect(() => {
    if (!task || !live) close();
  }, [task, live]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, []);
  if (!task || !w || !live) return null;
  const c = choices.find((x) => x.id === sel) ?? choices[0];
  const lastBy = new Map<string, (typeof task.changes)[number]>();
  for (const ch of task.changes) if (!ch.reverted) lastBy.set(ch.path, ch);
  const plus = (files ?? []).reduce((n, f) => n + f.added, 0);
  const minus = (files ?? []).reduce((n, f) => n + f.removed, 0);
  const into = w.baseBranch ?? '主工作区';
  const go = async () => {
    if (!c || busy) return;
    setBusy(true);
    try {
      const r = await call<WorktreeFinishResult>('worktreeFinish', taskId, c.id, c.id !== 'discard' && w.status === 'active' ? msg.trim() || undefined : undefined);
      toast(r.message, r.ok ? 'success' : 'warn');
      if (r.ok) close();
      else setBusy(false);
    } catch (e) {
      toast((e as Error).message, 'error');
      setBusy(false);
    }
  };
  const verb = c?.id === 'merge' ? '合并' : c?.id === 'keep' ? '保留分支' : c?.label ?? '确定';
  return (
    <div className="modal-backdrop" onMouseDown={close}>
      <div className="modal wt-dlg" onMouseDown={(e) => e.stopPropagation()} data-testid="worktree-dialog" role="dialog" aria-label={`结案：${task.title}`}>
        <div className="wt-h">
          <span className="wt-seal">敕</span>
          <span className="ellipsis">{w.status === 'kept' ? '保留的分支' : task.state === 'Done' ? '结案' : '已取消'}：{task.title}</span>
        </div>
        <div className="wt-intro">
          {w.status === 'kept' ? (
            <>分支 <code>{w.branch}</code> 已保留（工作树目录已移除）。可以把它合并到 {into}，或删除分支。</>
          ) : task.state === 'Done' ? (
            <>这道旨意在独立工作树里完成：分支 <code>{w.branch}</code>，基于 {w.baseBranch ?? 'HEAD'} 的 <code>{w.base.slice(0, 7)}</code>。你的工作区没有被动过，现在决定怎么处理这些改动。</>
          ) : (
            <>旨意已取消，改动留在独立工作树里：分支 <code>{w.branch}</code>，基于 {w.baseBranch ?? 'HEAD'} 的 <code>{w.base.slice(0, 7)}</code>。可以保留分支日后再看，或丢弃。</>
          )}
        </div>
        {(w.conflicts?.length || w.error) && (
          <div className="warnbox wt-warn">
            <Icon name="alert" size={13} />
            <span>上次处理未完成：{w.conflicts?.length ? `${w.conflicts.slice(0, 6).join('、')}${w.conflicts.length > 6 ? ` 等 ${w.conflicts.length} 个文件` : ''} 有冲突或被主工作区的改动挡住。` : w.error}可以先保留分支，在主工作区处理好后再合并。</span>
          </div>
        )}
        {w.dirtyBase ? <div className="muted small">建立工作树时主工作区有 {w.dirtyBase} 处未提交的改动，没有包含在这道旨意里。</div> : null}
        <div className="wt-files" data-testid="wt-files">
          <div className="wt-fh">
            <span>{files ? `${files.length} 个文件` : '统计改动…'}</span>
            {files && files.length > 0 && <span className="wt-num"><span className="add">+{plus}</span> <span className="del">−{minus}</span></span>}
          </div>
          {files && !files.length && <div className="wt-f muted">没有改动</div>}
          <div className="wt-fl">
            {(files ?? []).map((f) => {
              const ch = lastBy.get(f.path);
              return (
                <div key={f.path} className="wt-f">
                  <code className="ellipsis" title={f.path}>{f.path}</code>
                  {ch?.via === 'command' ? <span className="chg-tag cmd" title={ch.command}>命令 {ch.command && ch.command.length > 18 ? `${ch.command.slice(0, 17)}…` : ch.command}</span> : ch?.via === 'guest' ? <span className="chg-tag guest" title="客卿用它自带的工具改的">客卿 {ch.command}</span> : ch ? <span className="chg-tag">{AGENT_MAP[ch.agentId]?.name}</span> : null}
                  <span className="wt-num">{f.binary ? <span className="muted">二进制</span> : <><span className="add">+{f.added}</span>{f.removed ? <span className="del"> −{f.removed}</span> : null}</>}</span>
                </div>
              );
            })}
          </div>
        </div>
        <div className="wt-opts" role="radiogroup" aria-label="处理方式">
          {choices.map((x) => (
            <button key={x.id} role="radio" aria-checked={x.id === c?.id} className={`wt-opt ${x.id === c?.id ? 'on' : ''} ${x.tone === 'danger' ? 'danger' : ''}`} onClick={() => setSel(x.id)} data-testid={`wt-opt-${x.id}`}>
              <span className="rd" />
              <span className="tx">
                <span className="l">{x.label}{x.id === 'merge' && <span className="rec">推荐</span>}</span>
                {x.hint && <span className="h2">{x.hint}</span>}
              </span>
            </button>
          ))}
        </div>
        {c && c.id !== 'discard' && w.status === 'active' && (
          <input className="input wt-msg" value={msg} onChange={(e) => setMsg(e.target.value)} placeholder="提交说明" title="提交到旨意分支时的说明（第一行）" data-testid="wt-msg" />
        )}
        <div className="wt-foot">
          <span className="muted small">{card ? '稍后决定：留在看板「需要你处理」里' : '也可以在「源代码管理 → 工作树」里处理'}</span>
          <button className="btn" onClick={close} data-testid="wt-later">稍后</button>
          <button className={`btn ${c?.tone === 'danger' ? 'danger-fill' : 'primary'}`} disabled={busy || !c} onClick={() => void go()} data-testid="wt-confirm">{busy ? '处理中…' : verb}</button>
        </div>
      </div>
    </div>
  );
}
