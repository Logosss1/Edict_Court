import { useEffect, useLayoutEffect, useRef, useState, memo, type ReactNode } from 'react';
import { useStore } from '../store';
import type { Activity, PreviewResult, PreviewStepResult, PreviewViewportResult, RunNode } from '../../shared/types';
import { call } from '../api';
import { openPreview } from './PreviewView';
import { AGENT_MAP } from '../../shared/court';
import { Icon } from '../common/Icon';
import { Markdown } from '../common/Markdown';
import { fmtTime } from '../common/format';

/**
 * Live activity of one edict (or the global log). `header` scrolls with the stream at the top (the plan card),
 * `footer` sits after the last item (decision cards), and finished ministry nodes get a 成果核验 line in time order.
 */
export function ActivityStream({ taskId, compact, includeGlobal, agentFilter, limit = 600, header, footer }: { taskId?: string; compact?: boolean; includeGlobal?: boolean; agentFilter?: string; limit?: number; header?: ReactNode; footer?: ReactNode }) {
  const list = useStore((s) => {
    const a = taskId ? s.activities[taskId] ?? [] : [];
    const g = includeGlobal || !taskId ? s.activities._global ?? [] : [];
    return { a, g };
  });
  let items = [...list.a, ...list.g];
  if (includeGlobal && taskId) items.sort((x, y) => x.at - y.at);
  if (agentFilter) items = items.filter((x) => x.agentId === agentFilter);
  items = items.slice(-limit);
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  });
  // custom 协同设计 roles: show the role's own name (the avatar official only lends its colour / emoji)
  const roleByNode = useStore((st) => {
    const t = taskId ? st.tasks.find((x) => x.id === taskId) : undefined;
    if (!t?.designSpec) return null;
    return Object.fromEntries(t.nodes.filter((n) => n.roleName).map((n) => [n.id, n.roleName!]));
  });
  // finished ministry nodes with a structured conclusion → 成果核验 rows (skipped when filtering by official)
  const verdictNodes = useStore((st) => {
    const t = taskId && !compact ? st.tasks.find((x) => x.id === taskId) : undefined;
    return t ? t.nodes.filter((n) => (n.kind === 'exec' || n.kind === 'solo') && n.status === 'done' && n.endedAt && n.output?.startsWith('{')) : EMPTY_NODES;
  });
  // pair tool results with calls
  const results = new Map<string, Activity>();
  for (const it of items) if (it.kind === 'tool_result' && it.data?.callId) results.set(String(it.data.callId), it);
  const rows: { at: number; el: ReactNode }[] = items
    .filter((a) => !(a.kind === 'tool_result' && a.data?.callId))
    .map((a) => ({ at: a.at, el: <ActivityItem key={a.id} a={a} result={results.get(a.id)} compact={compact} roleName={a.nodeId ? roleByNode?.[a.nodeId] : undefined} /> }));
  if (!agentFilter && verdictNodes.length) {
    const first = items[0]?.at ?? 0;
    for (const n of verdictNodes) if (n.endedAt! >= first) rows.push({ at: n.endedAt!, el: <Verdict key={`v-${n.id}`} n={n} /> });
    rows.sort((x, y) => x.at - y.at); // stable: same-time rows keep their order
  }
  return (
    <div
      ref={ref}
      className={`activity-stream ${compact ? 'compact' : ''}`}
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
      }}
      data-testid="activity-stream"
    >
      {header}
      {!items.length && <div className="muted pad small">暂无活动。下旨后，这里实时显示每位官员的思考、工具调用、结果与状态流转。</div>}
      {rows.map((r) => r.el)}
      {footer}
    </div>
  );
}

const EMPTY_NODES: RunNode[] = [];

/** One-line evidence check of a finished ministry node: claimed artifacts, recorded changes, commands run. */
export function verdictOf(n: RunNode): { status: string; parts: string[]; issues: string[] } | null {
  try {
    const j = JSON.parse(n.output ?? '') as { status?: string; artifacts?: string[]; issues?: string[]; systemCheck?: string[] };
    if (!j || typeof j !== 'object' || !j.status) return null;
    const sc = j.systemCheck ?? [];
    const parts: string[] = [];
    const arts = sc.filter((l) => / [✓✗] /.test(` ${l} `) && !l.startsWith('系统记录') && !l.startsWith('本节点'));
    if (arts.length) parts.push(`产物 ${arts.map((l) => l.replace(/ sha256:\w+$/, '')).slice(0, 2).join('、')}${arts.length > 2 ? ` 等 ${arts.length} 个` : ''}`);
    const ch = sc.find((l) => l.startsWith('系统记录的改动：'));
    if (ch) {
      const list = ch.slice('系统记录的改动：'.length);
      parts.push(list === '无' ? '系统未记录改动' : `系统记录 ${list.split(', ').length} 处改动`);
    }
    const cmd = sc.find((l) => l.startsWith('本节点执行命令'));
    if (cmd) parts.push(cmd.replace('本节点', ''));
    return { status: j.status, parts, issues: j.issues ?? [] };
  } catch {
    return null;
  }
}

function Verdict({ n }: { n: RunNode }) {
  const v = verdictOf(n);
  if (!v) return null;
  const ok = v.status === 'done';
  return (
    <div className={`act verdict ${ok ? 'ok' : 'warn'}`} data-testid="verdict" title={v.issues.join('\n') || undefined}>
      <Icon name={ok ? 'check' : 'alert'} size={12} />
      <span>
        <b>{n.subtaskId ?? n.label} 成果核验</b>
        {v.parts.length ? `：${v.parts.join(' · ')}` : ''}
        {!ok && v.issues.length ? <span className="v-issue"> · 存疑：{v.issues.slice(0, 2).join('；')}</span> : null}
      </span>
    </div>
  );
}

const ActivityItem = memo(function ActivityItem({ a, result, compact, roleName }: { a: Activity; result?: Activity; compact?: boolean; roleName?: string }) {
  const meta = a.agentId ? AGENT_MAP[a.agentId] : undefined;
  const who = meta ? (
    <span className="act-who" style={{ color: meta.color }} title={roleName ? `协同设计角色（朝堂形象：${meta.name}）` : undefined}>
      {meta.emoji} {roleName ?? meta.name}
    </span>
  ) : null;
  const time = <span className="act-time">{fmtTime(a.at)}</span>;
  switch (a.kind) {
    case 'thinking':
      return <Thinking a={a} who={who} time={time} />;
    case 'text': {
      const j = !a.streaming ? jsonOutput(a.content) : null;
      return (
        <div className="act act-text">
          <div className="act-head">{who}{time}{a.streaming && <span className="typing" />}</div>
          {j ? <JsonOutput j={j} raw={a.content} /> : <Markdown text={a.content || '…'} />}
        </div>
      );
    }
    case 'tool_call':
      return <ToolCall a={a} result={result} who={who} time={time} />;
    case 'tool_result':
      return (
        <div className="act act-log">
          {who} <pre className="tool-out">{a.content}</pre>
        </div>
      );
    case 'state':
      return (
        <div className="act act-state">
          <Icon name="chevronRight" size={11} /> {a.content} {time}
        </div>
      );
    case 'gate':
      return (
        <div className="act act-gate">
          <Icon name="scroll" size={13} /> {a.content} {time}
        </div>
      );
    case 'human':
    case 'annotation':
      return (
        <div className="act act-human">
          <span className="act-who" style={{ color: '#e8b64c' }}>👑</span> {a.content} {time}
        </div>
      );
    case 'preview':
      return <PreviewAct a={a} who={who} time={time} />;
    case 'error':
      return (
        <div className="act act-error">
          <Icon name="alert" size={13} /> {who} {a.content} {time}
        </div>
      );
    default:
      return (
        <div className={`act act-log ${compact ? '' : ''}`}>
          {who} <span className="act-logtext">{a.content}</span> {time}
        </div>
      );
  }
});

/** Structured (JSON) outputs of officials: plans, verdicts, orders. */
function jsonOutput(text: string): Record<string, unknown> | null {
  const t = text.trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  if (!t.startsWith('{') || !t.endsWith('}')) return null;
  try {
    const j = JSON.parse(t);
    return j && typeof j === 'object' && !Array.isArray(j) ? j : null;
  } catch {
    return null;
  }
}

function JsonOutput({ j, raw }: { j: Record<string, unknown>; raw: string }) {
  const [open, setOpen] = useState(false);
  const subs = Array.isArray(j.subtasks) ? j.subtasks.length : 0;
  const orders = Array.isArray(j.orders) ? j.orders.length : 0;
  const head = subs ? `拟定方案：${subs} 个子任务` : j.verdict ? `审议结论：${j.verdict === 'approve' ? '准奏' : j.verdict === 'reject' ? '封驳' : String(j.verdict)}` : orders ? `执行令：${orders} 条` : j.status ? `结论：${({ done: '完成', partial: '部分完成', failed: '失败' } as Record<string, string>)[String(j.status)] ?? String(j.status)}` : '结构化输出';
  const text = String(j.summary ?? j.comment ?? j.reason ?? j.note ?? '');
  return (
    <div className="json-out" data-testid="json-out">
      <div><b>{head}</b>{text ? `　${text}` : ''}</div>
      <button className="link small" onClick={() => setOpen(!open)}>{open ? '收起原文' : '查看原文'}</button>
      {open && <pre className="tool-out">{(() => { try { return JSON.stringify(JSON.parse(raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, '')), null, 2); } catch { return raw; } })()}</pre>}
    </div>
  );
}

function Thinking({ a, who, time }: { a: Activity; who: React.ReactNode; time: React.ReactNode }) {
  const [open, setOpen] = useState(!!a.streaming);
  useEffect(() => {
    if (!a.streaming) setOpen(false);
  }, [a.streaming]);
  return (
    <div className="act act-thinking">
      <div className="act-head clickable" onClick={() => setOpen(!open)}>
        <Icon name={open ? 'chevronDown' : 'chevronRight'} size={11} /> {who} <span className="muted">思考{a.streaming ? '中' : ''} · {a.content.length} 字</span> {time}
        {a.streaming && <span className="typing" />}
      </div>
      {open && <div className="thinking-body">{a.content}</div>}
    </div>
  );
}

function ToolCall({ a, result, who, time }: { a: Activity; result?: Activity; who: React.ReactNode; time: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const ok = result?.data?.ok;
  return (
    <div className={`act act-tool ${result ? (ok ? 'ok' : 'fail') : 'pending'}`}>
      <div className="act-head clickable" onClick={() => setOpen(!open)}>
        <Icon name={open ? 'chevronDown' : 'chevronRight'} size={11} />
        {who}
        <span className="tool-name">{String(a.data?.name ?? '')}</span>
        <span className="tool-desc">{a.content}</span>
        <span className={`tool-status ${result ? (ok ? 'ok' : 'fail') : ''}`}>{result ? (ok ? '✓' : '✗') : '…'}</span>
        {time}
      </div>
      {open && (
        <div className="tool-detail">
          <pre className="tool-args">{JSON.stringify(a.data?.args ?? {}, null, 2)}</pre>
          {result && <pre className="tool-out">{result.content}</pre>}
        </div>
      )}
    </div>
  );
}

/** Result of the agent's preview_page run: screenshot, console errors, open-in-preview. */
function PreviewAct({ a, who, time }: { a: Activity; who: React.ReactNode; time: React.ReactNode }) {
  const d = (a.data ?? {}) as unknown as PreviewResult;
  const [img, setImg] = useState<string | null>(null);
  const [big, setBig] = useState(false);
  useEffect(() => {
    if (d.screenshot) void call<string | null>('blobImage', d.screenshot).then(setImg);
  }, [d.screenshot]);
  const errors = (d.console ?? []).filter((c) => c.level === 'error');
  const wsUrl = d.url?.startsWith('preview://ws/');
  const rel = d.url?.startsWith('preview://') ? decodeURIComponent(d.url.replace(/^preview:\/\/[^/]+\//, '')) : d.url;
  return (
    <div className="act act-preview" data-testid="act-preview">
      <div className="act-head">{who}{time}</div>
      <div className="pv-act">
        {img ? <img src={img} alt="预览截图" className={big ? 'big' : ''} onClick={() => setBig(!big)} title="点击放大/缩小" /> : <div className="pv-noimg muted small">（无截图）</div>}
        <div className="pv-act-info">
          <div><b>{errors.length ? '⚠' : '✅'} {d.title || '（无标题）'}</b></div>
          <div className="muted small">{rel} · {d.width}×{d.height} · {d.loadMs}ms</div>
          <div className="small">控制台错误 {errors.length}{d.failed?.length ? ` · 资源失败 ${d.failed.length}` : ''}{d.blocked?.length ? ` · 已拦截外部请求 ${d.blocked.length}` : ''}</div>
          {errors.slice(0, 4).map((c, i) => <div key={i} className="small pv-err">✖ {c.step ? <span className="muted">[第 {c.step} 步] </span> : null}{c.message}</div>)}
          {rel && wsUrl && <button className="btn sm" onClick={() => openPreview(rel)}><Icon name="globe" size={12} /> 打开预览</button>}
          {rel && !wsUrl && d.url?.startsWith('preview://wt-') && <div className="muted small">在旨意自己的工作树里预览；合并后可在工作区打开</div>}
        </div>
      </div>
      {!!d.steps?.length && <PreviewSteps steps={d.steps} />}
      {!!d.viewports?.length && <PreviewViewports list={d.viewports} />}
    </div>
  );
}

function BlobThumb({ hash, alt }: { hash: string; alt: string }) {
  const [img, setImg] = useState<string | null>(null);
  const [big, setBig] = useState(false);
  useEffect(() => {
    void call<string | null>('blobImage', hash).then(setImg);
  }, [hash]);
  return img ? <img src={img} alt={alt} className={`pv-thumb ${big ? 'big' : ''}`} onClick={() => setBig(!big)} title="点击放大/缩小" /> : null;
}

/** Interactive steps (click / fill / assert …): ✓ / ✗ / skipped, the note, and a screenshot when one was taken. */
function PreviewSteps({ steps }: { steps: PreviewStepResult[] }) {
  const bad = steps.filter((s) => !s.ok && !s.skipped && !s.optional).length;
  const [open, setOpen] = useState(bad > 0 || steps.length <= 6);
  return (
    <div className="pv-steps" data-testid="pv-steps">
      <div className="pv-sub clickable" onClick={() => setOpen(!open)}>
        <Icon name={open ? 'chevronDown' : 'chevronRight'} size={11} /> 交互步骤 {steps.length} 步 · {bad ? <span className="bad">{bad} 步未通过</span> : <span className="good">全部通过</span>}
      </div>
      {open && steps.map((s) => (
        <div key={s.index} className={`pv-step ${s.skipped ? 'skip' : s.ok ? 'ok' : s.optional ? 'opt' : 'bad'}`}>
          <span className="pv-ix">{s.index}</span>
          <span className="pv-mark">{s.skipped ? '—' : s.ok ? '✓' : '✗'}</span>
          <span className="pv-act-l">{s.action}{s.optional && <span className="muted">（可选）</span>}</span>
          {s.note && <span className="muted pv-note" title={s.note}>{s.note}</span>}
          <span className="muted pv-ms">{s.skipped ? '未执行' : `${s.ms}ms`}</span>
          {s.screenshot && <BlobThumb hash={s.screenshot} alt={`第 ${s.index} 步截图`} />}
        </div>
      ))}
    </div>
  );
}

/** Extra viewport screenshots (e.g. 375 / 768 / 1280): size, horizontal overflow warning, thumbnail. */
function PreviewViewports({ list }: { list: PreviewViewportResult[] }) {
  return (
    <div className="pv-vps" data-testid="pv-viewports">
      {list.map((v, i) => (
        <div key={i} className={`pv-vp ${v.overflowX ? 'warn' : ''}`}>
          <div className="small"><b>{v.width}×{v.height}</b>{v.overflowX ? <span className="bad"> · 横向溢出{v.contentWidth ? `（内容宽 ${v.contentWidth}px）` : ''}</span> : <span className="good"> · 无横向溢出</span>}</div>
          {v.note && <div className="muted small">{v.note}</div>}
          {v.screenshot && <BlobThumb hash={v.screenshot} alt={`${v.width} 宽截图`} />}
        </div>
      ))}
    </div>
  );
}
