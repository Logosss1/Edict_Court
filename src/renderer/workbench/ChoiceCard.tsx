// Decision card, inline in the agent pane: numbered options (1–9), ⏎ to confirm, Esc to deny,
// an optional 批示. Used for write-task starts, risky actions, 请旨 questions, escalations and loops.
import { useEffect, useRef, useState } from 'react';
import { useStore, selectTask, toast } from '../store';
import { call } from '../api';
import { Icon } from '../common/Icon';
import { agentName } from '../../shared/court';
import { openWorktreeDialog } from './WorktreeDialog';
import { openAttempts } from '../panels/Lanes';
import { SearchSetupDialog } from '../settings/pages/Web';
import type { ApprovalChoice, ApprovalRequest } from '../../shared/types';

const KIND_HEAD: Record<string, { icon: string; label: string }> = {
  write_task: { icon: 'edit', label: '写任务开工 · 请皇上定夺' },
  question: { icon: 'help', label: '官员请旨' },
  escalate: { icon: 'key', label: '请求加权限' },
  loop: { icon: 'refresh', label: '疑似重复操作' },
  worktree: { icon: 'merge', label: '结案 · 工作树如何处理' },
  search_setup: { icon: 'globe', label: '官员上疏 · 需要联网搜索' },
  web_domain: { icon: 'globe', label: '抓取网页 · 新网站' },
  sandbox: { icon: 'lock', label: '命令被沙箱拦下' },
  guest: { icon: 'users', label: '客卿改了文件 · 请皇上定夺' },
  attempt: { icon: 'layers', label: '排班办完 · 请选一路' },
};
/** 太子追问: the prince's one question at triage (he is not an official) */
const PRINCE_HEAD = { icon: 'help', label: '太子请旨' };

/** Choices to show: the request's own, or 准许 / 驳回 for plain approvals. */
export function choicesOf(a: ApprovalRequest): ApprovalChoice[] {
  if (a.choices?.length) return a.choices;
  return [
    { id: '', label: a.risk === 'high' ? '准许（高风险）' : '准许', hint: a.risk === 'high' ? '仅这一次；之后同类操作仍会问你' : undefined, approve: true, tone: a.risk === 'high' ? 'danger' : 'primary' },
    { id: '', label: '驳回', hint: '官员会换个做法，或在结论里说明', approve: false, tone: 'danger', comment: 'optional' },
  ];
}

/** Tool-call args (JSON) → readable lines: `$ cmd` for commands, `key：value` otherwise. */
function readable(text: string): { lines: string[]; cmd?: string } {
  const t = text.trim();
  if (t.startsWith('{')) {
    try {
      const j = JSON.parse(t) as Record<string, unknown>;
      if (j && typeof j === 'object' && !Array.isArray(j)) {
        if (typeof j.command === 'string') return { lines: Object.entries(j).filter(([k]) => k !== 'command').map(([k, v]) => `${k}：${short(v)}`), cmd: j.command };
        return { lines: Object.entries(j).map(([k, v]) => `${k}：${short(v)}`) };
      }
    } catch {
      /* plain text */
    }
  }
  return { lines: text.split('\n') };
}
const short = (v: unknown) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  const one = s.replace(/\s*\n\s*/g, ' ⏎ ');
  return one.length > 240 ? `${one.slice(0, 239)}…（共 ${s.length} 字）` : one;
};

/** 做法：… / 验收标准：… lines get a bold label. */
function Detail({ text }: { text: string }) {
  const [more, setMore] = useState(false);
  const { lines, cmd } = readable(text);
  const long = lines.length > 7 || lines.join('').length > 600;
  const shown = long && !more ? lines.slice(0, 6) : lines;
  return (
    <div className="cc-d">
      {cmd && <pre className="cc-cmd">$ {cmd}</pre>}
      {shown.map((l, i) => {
        const m = l.match(/^([\p{Script=Han}A-Za-z ]{1,8})[：:](.*)$/u);
        return <div key={i}>{m ? <><b>{m[1]}：</b>{m[2]}</> : l || ' '}</div>;
      })}
      {long && <button className="link" onClick={() => setMore(!more)}>{more ? '收起' : `展开全部（${lines.length} 行）`}</button>}
    </div>
  );
}

export function ChoiceCard({ a, active }: { a: ApprovalRequest; active: boolean }) {
  const choices = choicesOf(a);
  const [sel, setSel] = useState(0);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [setup, setSetup] = useState(false);
  const noteRef = useRef<HTMLInputElement>(null);
  const node = useStore((s) => (a.taskId && a.nodeId ? s.tasks.find((t) => t.id === a.taskId)?.nodes.find((n) => n.id === a.nodeId) : undefined));
  const c = choices[sel];
  const needNote = c?.comment === 'required';
  const kindHead = a.kind === 'question' && a.agentId === 'taizi' ? PRINCE_HEAD : KIND_HEAD[a.kind ?? ''];
  const head = a.risk === 'high' && a.kind !== 'question' ? { icon: 'alert', label: '高风险操作 · 须皇上确认' } : kindHead ?? { icon: 'shield', label: '操作待批准' };

  const decide = async (i = sel, configured = false) => {
    const ch = choices[i];
    if (!ch || busy) return;
    // 上疏 for search: 「配置搜索服务」 first opens the setup; the card is answered once it is saved
    if (a.kind === 'search_setup' && ch.id === 'configure' && !configured) {
      setSel(i);
      setSetup(true);
      return;
    }
    if (ch.comment === 'required' && !note.trim()) {
      setSel(i);
      noteRef.current?.focus();
      return toast('这一项需要写下你的答复', 'warn');
    }
    setBusy(true);
    try {
      await call('decideApproval', a.id, ch.approve, ch.id || undefined, note.trim() || undefined);
    } catch (e) {
      toast((e as Error).message, 'error');
      setBusy(false);
    }
  };
  const decideRef = useRef(decide);
  decideRef.current = decide;

  // keyboard: 1–9 pick, ⏎ confirm, Esc deny — only for the first card, not while typing elsewhere, and not while
  // the search setup is open over it (Esc there closes the setup, it does not deny)
  useEffect(() => {
    if (!active || setup) return;
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement as HTMLElement | null;
      const inNote = el === noteRef.current;
      const typing = el && (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && !inNote) || el.isContentEditable || el.closest('.monaco-editor'));
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      if (!inNote && /^[1-9]$/.test(e.key)) {
        const i = Number(e.key) - 1;
        if (i < choices.length) {
          e.preventDefault();
          setSel(i);
        }
      } else if (e.key === 'Enter') {
        e.preventDefault();
        void decideRef.current();
      } else if (e.key === 'Escape' && !inNote) {
        const deny = choices.findIndex((x) => !x.approve);
        if (deny >= 0) {
          e.preventDefault();
          void decideRef.current(deny);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, choices, setup]);

  return (
    <div className={`choice-card ${a.risk === 'high' ? 'high' : ''} kind-${a.kind ?? 'action'}`} data-ap-id={a.id} data-testid="choice-card">
      <div className="cc-h">
        <Icon name={head.icon} size={13} /> {head.label}
        <span className="muted">{[agentName(a.agentId), node?.subtaskId].filter(Boolean).join(' · ')}</span>
      </div>
      <div className="cc-t">{a.summary}</div>
      {a.detail && <Detail text={a.detail} />}
      {setup && <SearchSetupDialog onClose={() => setSetup(false)} onSaved={() => { setSetup(false); void decide(choices.findIndex((x) => x.id === 'configure'), true); }} />}
      {a.kind === 'worktree' && a.taskId && <button className="link small cc-more" onClick={() => openWorktreeDialog(a.taskId!)} data-testid="cc-worktree-open">查看改动明细与提交说明…</button>}
      {a.kind === 'attempt' && a.taskId && <button className="link small cc-more" onClick={() => openAttempts(a.taskId!)} data-testid="cc-attempts-open">打开「比试」，并排看各路的改动…</button>}
      {a.reason && a.kind !== 'question' && !a.summary.includes(a.reason) && <div className="cc-why muted">{a.reason}</div>}
      <div className="cc-opts" role="radiogroup" aria-label="选择">
        {choices.map((ch, i) => (
          <button
            key={`${ch.id}-${i}`}
            role="radio"
            aria-checked={sel === i}
            className={`copt ${sel === i ? 'on' : ''} ${!ch.approve || ch.tone === 'danger' ? 'deny' : ''}`}
            onClick={() => setSel(i)}
            onDoubleClick={() => void decide(i)}
            data-testid={`ap-opt-${ch.id || (ch.approve ? 'approve' : 'deny')}`}
          >
            <span className="num">{i + 1}</span>
            <span className="tx">
              <span className="l">{ch.label}</span>
              {ch.hint && <span className="h2">{ch.hint}</span>}
            </span>
          </button>
        ))}
      </div>
      {c?.comment && (
        <input
          ref={noteRef}
          className="input cc-note"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder={needNote ? '写下你的答复（必填）' : a.kind === 'question' ? '补充说明（可选）' : '批示（可选）：例如 先别动样式文件'}
          data-testid="ap-note"
        />
      )}
      <div className="cc-foot">
        <span className="muted">{active ? `数字键选择 · ⏎ 确定${choices.some((x) => !x.approve) ? ' · Esc 驳回' : ''}` : '双击选项直接确定'}</span>
        <button className={`btn sm ${c && !c.approve ? 'danger' : 'primary'}`} disabled={busy || (needNote && !note.trim())} onClick={() => void decide()} data-testid="ap-confirm">
          {busy ? '…' : '确定'}
        </button>
      </div>
    </div>
  );
}

/** Approvals of the selected edict as cards; other edicts' pending approvals as one line. */
export function PendingChoices({ taskId }: { taskId: string }) {
  const mine = useStore((s) => s.approvals.filter((a) => a.taskId === taskId && a.status === 'pending'));
  if (!mine.length) return null;
  return (
    <div className="cc-list">
      {mine.map((a, i) => <ChoiceCard key={a.id} a={a} active={i === 0} />)}
    </div>
  );
}

export function OtherPendingNotice({ taskId }: { taskId: string | null }) {
  const others = useStore((s) => s.approvals.filter((a) => a.status === 'pending' && a.taskId !== taskId));
  const tasks = useStore((s) => s.tasks);
  if (!others.length) return null;
  const first = others[0];
  const t = tasks.find((x) => x.id === first.taskId);
  return (
    <button className="other-pending" onClick={() => (first.taskId ? selectTask(first.taskId) : undefined)} data-testid="other-pending">
      <Icon name="bell" size={12} />
      <span className="ellipsis">{others.length === 1 ? `「${t?.title ?? first.summary}」等你批准` : `另有 ${others.length} 件等你批准：${t?.title ?? first.summary} 等`}</span>
      <span className="go">查看 →</span>
    </button>
  );
}
