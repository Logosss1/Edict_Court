// 细问: the planning official's round of questions (each with a recommended answer) and the facts it looked up,
// answered on one card; then 问答纪要 to confirm. GrillPanel (task pane) shows the outcome and takes late answers
// to questions that timed out in 全自动.
import { useMemo, useState } from 'react';
import { toast } from '../store';
import { call } from '../api';
import { Icon } from '../common/Icon';
import { Markdown } from '../common/Markdown';
import { TERMINAL, agentName } from '../../shared/court';
import type { ApprovalRequest, GrillAnswer, GrillFact, GrillQuestion, Task } from '../../shared/types';

type QPick = { i: number | 'free'; free: string };
type FactPick = { st?: 'confirmed' | 'corrected' | 'wrong'; fix: string };

/** The answer form: one block per question (recommendation preselected), 对 / 不对 per fact. */
function useGrillForm(questions: GrillQuestion[], facts: GrillFact[]) {
  const init = () => Object.fromEntries(questions.map((q) => [q.id, { i: q.options.length ? Math.max(0, q.options.indexOf(q.recommend)) : 'free', free: '' } as QPick]));
  const [picks, setPicks] = useState<Record<string, QPick>>(init);
  const [fp, setFp] = useState<Record<string, FactPick>>(() => Object.fromEntries(facts.map((f) => [f.id, { fix: '' }])));
  const pick = (id: string, p: Partial<QPick>) => setPicks((m) => ({ ...m, [id]: { ...m[id], ...p } }));
  const fact = (id: string, p: Partial<FactPick>) => setFp((m) => ({ ...m, [id]: { ...m[id], ...p } }));
  const answer = (q: GrillQuestion) => {
    const p = picks[q.id];
    return p.i === 'free' ? p.free.trim() : q.options[p.i];
  };
  const missing = [
    ...questions.filter((q) => !answer(q)).map((q) => q.id),
    ...facts.filter((f) => !fp[f.id]?.st || (fp[f.id].st === 'corrected' && !fp[f.id].fix.trim())).map((f) => f.id),
  ];
  const build = (onlyMarked = false): Pick<GrillAnswer, 'answers' | 'facts'> => ({
    answers: questions.filter((q) => answer(q)).map((q) => {
      const p = picks[q.id];
      const a = answer(q);
      return { id: q.id, answer: a, how: p.i === 'free' ? 'free' : a === q.recommend ? 'recommend' : 'option' };
    }),
    facts: facts.filter((f) => fp[f.id]?.st && (!onlyMarked || fp[f.id].st !== 'corrected' || fp[f.id].fix.trim())).map((f) => ({ id: f.id, status: fp[f.id].st!, ...(fp[f.id].st === 'corrected' ? { correction: fp[f.id].fix.trim() } : {}) })),
  });
  const allRight = () => setFp((m) => Object.fromEntries(facts.map((f) => [f.id, { ...m[f.id], st: 'confirmed' as const }])));
  const view = (
    <>
      {questions.map((q) => {
        const p = picks[q.id];
        return (
          <div key={q.id} className="gq" data-testid={`grill-q-${q.id}`}>
            <div className="gq-t"><span className="gq-id">{q.id}</span>{q.title}</div>
            {q.body && <div className="gq-b">{q.body}</div>}
            <div className="gq-opts">
              {q.options.map((o, i) => (
                <button key={i} className={`gq-o ${p.i === i ? 'on' : ''}`} onClick={() => pick(q.id, { i })} data-testid={`grill-opt-${q.id}-${i}`}>
                  {o}{o === q.recommend && <span className="gq-rec">推荐</span>}
                </button>
              ))}
              <button className={`gq-o ${p.i === 'free' ? 'on' : ''}`} onClick={() => pick(q.id, { i: 'free' })} data-testid={`grill-opt-${q.id}-free`}>{q.options.length ? '另答…' : '写答复'}</button>
            </div>
            {p.i === 'free' && <input className="input gq-free" autoFocus={!!q.options.length} value={p.free} onChange={(e) => pick(q.id, { free: e.target.value })} placeholder="写下你的答复" data-testid={`grill-free-${q.id}`} />}
          </div>
        );
      })}
      {facts.length > 0 && (
        <div className="gf-list">
          <div className="gf-h">
            <span>查到的事实 · 皇上确认后才用</span>
            {facts.length > 1 && <button className="link small" onClick={allRight} data-testid="grill-facts-all">都对</button>}
          </div>
          {facts.map((f) => {
            const s = fp[f.id] ?? { fix: '' };
            return (
              <div key={f.id} className="gf" data-testid={`grill-f-${f.id}`}>
                <div className="gq-t"><span className="gq-id">{f.id}</span>{f.text}</div>
                {f.source && <div className="gq-b">出处：{f.source}</div>}
                <div className="gq-opts">
                  <button className={`gq-o ${s.st === 'confirmed' ? 'on' : ''}`} onClick={() => fact(f.id, { st: 'confirmed' })} data-testid={`grill-f-${f.id}-ok`}>对</button>
                  <button className={`gq-o ${s.st === 'corrected' ? 'on' : ''}`} onClick={() => fact(f.id, { st: 'corrected' })} data-testid={`grill-f-${f.id}-fix`}>不对，更正…</button>
                  <button className={`gq-o deny ${s.st === 'wrong' ? 'on' : ''}`} onClick={() => fact(f.id, { st: 'wrong' })} data-testid={`grill-f-${f.id}-wrong`}>不对，别用</button>
                </div>
                {s.st === 'corrected' && <input className="input gq-free" value={s.fix} onChange={(e) => fact(f.id, { fix: e.target.value })} placeholder="正确的说法" data-testid={`grill-f-${f.id}-text`} />}
              </div>
            );
          })}
        </div>
      )}
    </>
  );
  return { view, build, missing };
}

/** Pending 细问 card: a round of questions, or 问答纪要 to confirm. */
export function GrillCard({ a }: { a: ApprovalRequest }) {
  const g = a.grill!;
  return g.phase === 'minutes' ? <MinutesCard a={a} /> : <RoundCard a={a} />;
}

function RoundCard({ a }: { a: ApprovalRequest }) {
  const g = a.grill!;
  const form = useGrillForm(g.questions, g.facts);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      toast((e as Error).message, 'error');
      setBusy(false);
    }
  };
  const answer = () => {
    if (form.missing.length) return toast(`还没答：${form.missing.join('、')}`, 'warn');
    void run(() => call('answerGrill', a.id, { ...form.build(), ...(note.trim() ? { note: note.trim() } : {}) }));
  };
  return (
    <div className="choice-card kind-grill" data-ap-id={a.id} data-testid="grill-card">
      <div className="cc-h">
        <Icon name="help" size={13} /> 规划前细问 · 第 {g.round} 轮
        <span className="muted">{agentName(a.agentId)}</span>
      </div>
      <div className="cc-t">{a.summary}</div>
      {a.reason && <div className="cc-why muted">{a.reason}</div>}
      {form.view}
      <input className="input cc-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="补充说明（可选）：问题以外想交代的" data-testid="grill-note" />
      <div className="cc-foot">
        <span className="muted">不改选项就是按推荐</span>
        <button className="btn sm" disabled={busy} onClick={() => void run(() => call('answerGrill', a.id, { ...form.build(true), ...(note.trim() ? { note: note.trim() } : {}), stop: true }))} title="已答的照答复，没答的按推荐，没确认的事实不用" data-testid="grill-stop">不必再问，开始规划</button>
        <button className="btn sm" disabled={busy} onClick={() => void run(() => call('decideApproval', a.id, true, 'recommend', note.trim() || undefined))} title="每个问题都按推荐答案，查到的事实都算对" data-testid="grill-recommend">都按推荐</button>
        <button className="btn sm primary" disabled={busy} onClick={answer} data-testid="grill-answer">{busy ? '…' : '答复'}</button>
      </div>
    </div>
  );
}

function MinutesCard({ a }: { a: ApprovalRequest }) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const decide = async (choice: 'ok' | 'more') => {
    if (busy) return;
    if (choice === 'more' && !note.trim()) return toast('写下要补充或更正的地方', 'warn');
    setBusy(true);
    try {
      await call('decideApproval', a.id, true, choice, note.trim() || undefined);
    } catch (e) {
      toast((e as Error).message, 'error');
      setBusy(false);
    }
  };
  return (
    <div className="choice-card kind-grill" data-ap-id={a.id} data-testid="grill-minutes">
      <div className="cc-h">
        <Icon name="file" size={13} /> 问答纪要 · 请皇上过目
        <span className="muted">{agentName(a.agentId)}</span>
      </div>
      <div className="cc-why muted">纪要定了，各部就照纪要办。</div>
      <Markdown className="grill-minutes" text={a.grill?.minutes ?? ''} />
      <input className="input cc-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="要补充或更正的地方（选「还有要补充」时必填）" data-testid="grill-minutes-note" />
      <div className="cc-foot">
        <span className="muted" />
        <button className="btn sm" disabled={busy} onClick={() => void decide('more')} data-testid="grill-more">还有要补充</button>
        <button className="btn sm primary" disabled={busy} onClick={() => void decide('ok')} data-testid="grill-ok">{busy ? '…' : '就这样办'}</button>
      </div>
    </div>
  );
}

const ENDED: Record<string, string> = { confirmed: '皇上准了纪要', stopped: '皇上说不必再问', timeout: '全自动无人答复，先按推荐答案办', skipped: '未细问' };

/** Task pane: what 细问 settled, and a form for questions that timed out (a late answer sends work back). */
export function GrillPanel({ task }: { task: Task }) {
  const g = task.grill;
  const [open, setOpen] = useState(false);
  const [late, setLate] = useState(false);
  const openQs = useMemo(() => (g?.questions ?? []).filter((q) => q.how === 'timeout'), [g]);
  const openFs = useMemo(() => (g?.facts ?? []).filter((f) => f.status === 'unconfirmed'), [g]);
  if (!g || g.status !== 'done' || g.ended === 'skipped') return null;
  const pending = openQs.length + openFs.length;
  const done = TERMINAL.includes(task.state);
  return (
    <div className="grill-panel" data-testid="grill-panel">
      <div className="gp-h">
        <button className="link" onClick={() => setOpen(!open)} data-testid="grill-panel-toggle">
          <Icon name={open ? 'chevronDown' : 'chevronRight'} size={11} /> 细问纪要
        </button>
        <span className="muted small">{g.name}问了 {g.rounds} 轮 · {g.questions.length} 个问题{g.facts.length ? ` · ${g.facts.length} 条事实` : ''} · {ENDED[g.ended ?? 'confirmed']}</span>
        {pending > 0 && <button className="btn sm" onClick={() => { setLate(!late); setOpen(true); }} data-testid="grill-late-open">补答 {pending} 项</button>}
      </div>
      {g.lateRework && <div className="muted small">补答已传给官员；已办的部分在回奏前返工调整</div>}
      {open && <Markdown className="grill-minutes" text={g.minutes ?? ''} />}
      {late && pending > 0 && <LateForm task={task} questions={openQs} facts={openFs} done={done} onDone={() => setLate(false)} />}
    </div>
  );
}

function LateForm({ task, questions, facts, done, onDone }: { task: Task; questions: GrillQuestion[]; facts: GrillFact[]; done: boolean; onDone: () => void }) {
  const form = useGrillForm(questions, facts);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    const b = form.build(true);
    setBusy(true);
    try {
      const r = await call<{ rework: boolean; changed: number }>('answerGrillLate', task.id, b);
      toast(done ? '已记录在案（旨意已结束，不再返工）' : !r.changed ? '已确认，照现在的做法办，不必返工' : r.rework ? '补答已传给官员，已办的部分会返工调整' : '补答已记下，规划时照此办', 'success');
      onDone();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="gp-late" data-testid="grill-late">
      <div className="muted small">{done ? '旨意已结束：补答只记录在案。' : '这些问题当时没人答，先按推荐办了。保持推荐就是确认；改了答复，已办的部分会返工调整。'}</div>
      {form.view}
      <div className="cc-foot">
        <span className="muted" />
        <button className="btn sm" onClick={onDone}>取消</button>
        <button className="btn sm primary" disabled={busy} onClick={() => void submit()} data-testid="grill-late-submit">{busy ? '…' : '提交补答'}</button>
      </div>
    </div>
  );
}
