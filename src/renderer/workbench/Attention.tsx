// 「需要你处理」 cards with inline actions — used by the 待办 side view and the Kanban lane.
import { useState } from 'react';
import { openPanel, selectTask, setUI, toast } from '../store';
import { call } from '../api';
import { Icon } from '../common/Icon';
import { fmtAgo } from '../common/format';
import { useAttention, type AttentionItem } from '../common/attention';
import { openWorktreeDialog } from './WorktreeDialog';
import { openAttempts } from '../panels/Lanes';
import { SearchSetupDialog } from '../settings/pages/Web';
import { BlockedReasonDialog } from './BlockedReason';

const KIND_ICON: Record<AttentionItem['kind'], string> = {
  write_task: 'edit', question: 'help', approval: 'shield', risk: 'alert', plan: 'scroll', final: 'scroll', decide: 'gate', blocked: 'alert', merge: 'merge', schedule: 'clock', attempt: 'layers',
};

/** Open the edict in the agent pane (where the full card lives). */
export function focusItem(it: AttentionItem) {
  // an official's 定时 proposal is looked at on the 定时旨意 page
  if (it.kind === 'schedule') {
    setUI({ mode: 'workbench', scheduleFocus: it.approval?.tool.replace(/^schedule:/, '') ?? null });
    openPanel('schedules');
    return;
  }
  if (it.taskId) selectTask(it.taskId);
  setUI({ mode: 'workbench' });
  setTimeout(() => document.querySelector<HTMLElement>(`[data-ap-id="${it.approval?.id ?? ''}"], [data-testid=gate-card]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }), 80);
}

async function run(p: Promise<unknown>, ok?: string) {
  try {
    await p;
    if (ok) toast(ok, 'success');
  } catch (e) {
    toast((e as Error).message, 'error');
  }
}

/** Inline buttons for one item: the common answers, plus 更多… to open the full card. */
export function AttnActions({ it }: { it: AttentionItem }) {
  const [busy, setBusy] = useState(false);
  const [setup, setSetup] = useState(false);
  const [why, setWhy] = useState(false);
  const go = (p: () => Promise<unknown>, ok?: string) => async () => {
    setBusy(true);
    await run(p(), ok);
    setBusy(false);
  };
  const a = it.approval;
  const more = (label = '更多…') => <button className="btn sm" onClick={() => focusItem(it)} data-testid="attn-more">{label}</button>;
  if (a) {
    const choices = a.choices ?? [];
    if (a.kind === 'grill') {
      // a 细问 round: answer on the card; the one-click 都按推荐 / 就这样办 here
      const quick = a.grill?.phase === 'minutes' ? { id: 'ok', label: '就这样办', ok: '照纪要规划' } : { id: 'recommend', label: '都按推荐', ok: '都按推荐答案' };
      return (
        <div className="a-act">
          <button className="btn sm primary" onClick={() => focusItem(it)} data-testid="attn-answer">{a.grill?.phase === 'minutes' ? '看纪要' : '回答'}</button>
          <button className="btn sm" disabled={busy} onClick={go(() => call('decideApproval', a.id, true, quick.id), quick.ok)} data-testid={`attn-grill-${quick.id}`}>{quick.label}</button>
        </div>
      );
    }
    if (it.kind === 'question') return <div className="a-act"><button className="btn sm primary" onClick={() => focusItem(it)} data-testid="attn-answer">回答</button></div>;
    if (!choices.length) {
      return (
        <div className="a-act">
          <button className={`btn sm ${a.risk === 'high' ? 'danger' : 'primary'}`} disabled={busy} onClick={go(() => call('decideApproval', a.id, true), '已准许')} data-testid="attn-approve">准许</button>
          <button className="btn sm" disabled={busy} onClick={go(() => call('decideApproval', a.id, false), '已驳回')} data-testid="attn-deny">驳回</button>
          {more('详情')}
        </div>
      );
    }
    // 结案 worktree: 合并 / 丢弃 open the dialog (diff + commit subject) preselected; 保留分支 is safe to do at once
    if (it.kind === 'merge' && a.taskId) {
      const has = (id: string) => choices.some((c) => c.id === id);
      return (
        <div className="a-act">
          {has('merge') && <button className="btn sm primary" onClick={() => openWorktreeDialog(a.taskId!, 'merge')} data-testid="attn-wt-merge">合并</button>}
          {has('keep') && <button className={`btn sm ${has('merge') ? '' : 'primary'}`} disabled={busy} onClick={go(() => call('decideApproval', a.id, true, 'keep'))} data-testid="attn-wt-keep">保留分支</button>}
          {has('discard') && <button className="btn sm" onClick={() => openWorktreeDialog(a.taskId!, 'discard')} data-testid="attn-wt-discard">丢弃</button>}
        </div>
      );
    }
    // 定时提议: approve, approve but keep it off to edit first, or drop it
    if (it.kind === 'schedule') {
      return (
        <div className="a-act">
          <button className="btn sm primary" disabled={busy} onClick={go(() => call('decideApproval', a.id, true, 'approve'), '已准奏，按时下旨')} data-testid="attn-sch-approve">准奏</button>
          <button className="btn sm" disabled={busy} onClick={go(() => call('decideApproval', a.id, true, 'paused'), '已排上，先停用')} data-testid="attn-sch-paused">先停用</button>
          <button className="btn sm" disabled={busy} onClick={go(() => call('decideApproval', a.id, false, 'deny'), '提议作废')} data-testid="attn-sch-deny">不必</button>
          {more('查看')}
        </div>
      );
    }
    // 排班办完: look at the lanes side by side, or take 门下省's pick at once
    if (it.kind === 'attempt' && a.taskId) {
      const rec = choices.find((c) => c.approve && c.tone === 'primary');
      return (
        <div className="a-act">
          <button className="btn sm primary" onClick={() => openAttempts(a.taskId!)} data-testid="attn-attempts-open">打开比试</button>
          {rec && <button className="btn sm" disabled={busy} onClick={go(() => call('decideApproval', a.id, true, rec.id), rec.label.replace(/（.*）$/, ''))} data-testid="attn-attempt-rec">{rec.label.replace(/（.*）$/, '')}</button>}
        </div>
      );
    }
        // 上疏 for search: 配置 opens the setup; the petition is answered once the service is saved
    if (a.kind === 'search_setup') {
      return (
        <div className="a-act">
          <button className="btn sm primary" onClick={() => setSetup(true)} data-testid="attn-choice-configure">配置搜索服务</button>
          {choices.some((c) => c.id === 'fetch_only') && <button className="btn sm" disabled={busy} onClick={go(() => call('decideApproval', a.id, true, 'fetch_only'), '这道旨意只用抓取')} data-testid="attn-choice-fetch_only">只用抓取</button>}
          {more()}
          {setup && <SearchSetupDialog onClose={() => setSetup(false)} onSaved={() => { setSetup(false); void run(call('decideApproval', a.id, true, 'configure'), '搜索服务已设好，接着搜索'); }} />}
        </div>
      );
    }
    // quick answers: the first two choices that need no written note
    const quick = choices.filter((c) => c.comment !== 'required' && c.tone !== 'danger').slice(0, 2);
    return (
      <div className="a-act">
        {quick.map((c, i) => (
          <button key={c.id} className={`btn sm ${i === 0 ? 'primary' : ''}`} disabled={busy} onClick={go(() => call('decideApproval', a.id, c.approve, c.id), c.label)} data-testid={`attn-choice-${c.id}`}>{shortLabel(c.label)}</button>
        ))}
        {more()}
      </div>
    );
  }
  const t = it.task!;
  if (it.kind === 'final')
    return (
      <div className="a-act">
        <button className="btn sm primary" onClick={() => focusItem(it)} data-testid="attn-review">御览回奏</button>
        <button className="btn sm" disabled={busy} onClick={go(() => call('decideGate', t.id, { approve: true }), '准奏结案')} data-testid="attn-close">准奏结案</button>
      </div>
    );
  if (it.kind === 'plan') return <div className="a-act"><button className="btn sm primary" onClick={() => focusItem(it)} data-testid="attn-plan">御览方案</button></div>;
  if (it.kind === 'blocked') {
    const failed = [...t.nodes].reverse().find((n) => n.status === 'failed');
    return (
      <div className="a-act">
        {failed && <button className="btn sm primary" disabled={busy} onClick={go(() => call('retryNode', t.id, failed.id), `局部重试：${failed.label}`)} data-testid="attn-retry">局部重试</button>}
        {!failed && <button className="btn sm primary" disabled={busy} onClick={go(() => call('unblock', t.id), '已解除阻塞')} data-testid="attn-unblock">继续</button>}
        <button className="btn sm" onClick={() => setWhy(true)} data-testid="attn-why">查看原因</button>
        {why && <BlockedReasonDialog task={t} onClose={() => setWhy(false)} onOpenTask={() => focusItem(it)} />}
      </div>
    );
  }
  return <div className="a-act">{more('查看')}</div>;
}

/** 准许，本子任务内写入与命令免询问 → 免询问 (cards are narrow) */
function shortLabel(l: string) {
  if (l.startsWith('准许，本子任务内')) return '免询问';
  if (l.startsWith('准许，本旨意内')) return '本旨免询问';
  if (l.startsWith('准许，本工作区')) return '本工作区永久';
  if (l === '改为只读执行') return '只读执行';
  return l.length > 8 ? `${l.slice(0, 7)}…` : l;
}

export function AttnCard({ it }: { it: AttentionItem }) {
  return (
    <div className={`acard ${it.tone}`} data-testid={`attn-${it.kind}`}>
      <div className="a-kind">
        <Icon name={KIND_ICON[it.kind]} size={12} /> {it.label}
        <span className="muted">{[it.who, fmtAgo(it.at)].filter(Boolean).join(' · ')}</span>
      </div>
      <div className="a-title clickable" title={it.title} onClick={() => focusItem(it)}>{it.title}</div>
      <div className="a-sub" title={it.sub}>{it.sub}</div>
      <AttnActions it={it} />
    </div>
  );
}

/** 待办 side view: everything waiting on the emperor, grouped by kind. */
export function InboxView() {
  const items = useAttention();
  const groups: { title: string; kinds: AttentionItem['kind'][] }[] = [
    { title: '请你批准', kinds: ['write_task', 'approval', 'risk'] },
    { title: '官员请旨', kinds: ['question'] },
    { title: '御览与御批', kinds: ['plan', 'final', 'decide', 'attempt'] },
    { title: '阻塞', kinds: ['blocked'] },
    { title: '结案合并', kinds: ['merge'] },
    { title: '定时提议', kinds: ['schedule'] },
  ];
  return (
    <div className="side-view inbox-view" data-testid="inbox">
      <div className="side-title">待办 {items.length > 0 && <span className="count">{items.length}</span>}</div>
      {!items.length && (
        <div className="empty-side">
          <Icon name="check" size={22} />
          <p>没有等你处理的事。</p>
          <p className="muted small">官员要开工写文件、请旨、回奏待批或阻塞时，会出现在这里。</p>
        </div>
      )}
      <div className="inbox-list">
        {groups.map((g) => {
          const list = items.filter((x) => g.kinds.includes(x.kind));
          if (!list.length) return null;
          return (
            <div key={g.title} className="inbox-group">
              <div className="inbox-h">{g.title} <span className="muted">{list.length}</span></div>
              {list.map((it) => <AttnCard key={it.key} it={it} />)}
            </div>
          );
        })}
      </div>
    </div>
  );
}
