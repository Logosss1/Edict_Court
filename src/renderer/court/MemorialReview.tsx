// 奏折批阅浮层 — light-weight review of plan / report / diffs inside the court; 准奏 / 封驳 /
// 涂改 all go through the same runtime calls as the workbench. Deep edits → back to the Editor.
import { useEffect, useRef, useState } from 'react';
import { useStore, useTask, setUI, openTab, openTaskTab } from '../store';
import { call } from '../api';
import { GateCard, PlanEditor, Pipeline, UsageLine } from '../panels/TaskWidgets';
import { Markdown } from '../common/Markdown';
import { loadMonaco, languageFor, monacoTheme } from '../common/loaders';
import { AGENT_MAP, STATE_LABEL } from '../../shared/court';
import { fmtTime } from '../common/format';
import type { Task } from '../../shared/types';
import { PreviewView } from '../workbench/PreviewView';

function htmlFiles(task: Task): string[] {
  const alive = new Map<string, boolean>();
  for (const c of task.changes) if (!c.reverted) alive.set(c.path, c.op !== 'delete');
  return [...alive.entries()].filter(([p, ok]) => ok && /\.html?$/i.test(p)).map(([p]) => p).sort((a, b) => (/index\.html?$/i.test(a) ? -1 : /index\.html?$/i.test(b) ? 1 : a.localeCompare(b)));
}

/** 御览成品：run the page the officials produced, right inside the review overlay. */
function PreviewPane({ task }: { task: Task }) {
  const files = htmlFiles(task);
  const [sel, setSel] = useState(files[0]);
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (sel) void call<string>('previewUrl', sel).then(setUrl).catch(() => setUrl(null));
  }, [sel]);
  return (
    <div className="mr-preview" data-testid="memorial-preview">
      {files.length > 1 && (
        <div className="mr-preview-files">
          {files.map((f) => <button key={f} className={`px-btn sm ${f === sel ? 'on' : ''}`} onClick={() => setSel(f)}>{f}</button>)}
        </div>
      )}
      {url ? <PreviewView key={url} tab={{ id: `mr:${url}`, kind: 'preview', title: sel, url }} /> : <div className="px-muted">工作区未打开或文件不可用</div>}
    </div>
  );
}

type Tab = 'plan' | 'report' | 'diff' | 'preview' | 'timeline';

export function MemorialReview({ taskId, tab: initial }: { taskId: string; tab?: Tab }) {
  const task = useTask(taskId);
  const [tab, setTab] = useState<Tab>(initial ?? (task?.gate?.kind === 'final' ? 'report' : 'plan'));
  const others = useStore((s) => s.tasks.filter((t) => t.gate && t.id !== taskId));
  if (!task) return null;
  const close = () => setUI({ review: null });
  const tabs: [Tab, string][] = [['plan', '中书方案'], ['report', '回奏'], ['diff', `改动 · ${new Set(task.changes.map((c) => c.path)).size}`], ...(htmlFiles(task).length ? [['preview', `预览 · ${htmlFiles(task).length}`] as [Tab, string]] : []), ['timeline', '流转']];
  return (
    <div className="px-modal-backdrop" onMouseDown={close}>
      <div className="memorial-review pixel" onMouseDown={(e) => e.stopPropagation()} data-testid="memorial-review">
        <div className="mr-rod top" />
        <div className="mr-paper">
          <div className="mr-head">
            <div>
              <div className="mr-title">奏折 · {task.title}</div>
              <div className="px-muted">{task.id} · {STATE_LABEL[task.state]}{task.gate ? ' · 待御批' : ''}</div>
            </div>
            <span style={{ flex: 1 }} />
            {others.length > 0 && <button className="px-btn sm" onClick={() => setUI({ review: { taskId: others[0].id } })}>下一本（{others.length}）</button>}
            <button className="px-btn sm" onClick={() => { close(); openTaskTab(task.id); }} title="切回工作台 Editor 深度编辑">回工作台编辑</button>
            <button className="px-x" onClick={close}>×</button>
          </div>
          <Pipeline task={task} />
          <UsageLine task={task} />
          <div className="mr-tabs">
            {tabs.map(([k, l]) => <button key={k} className={`px-btn sm ${tab === k ? 'on' : ''}`} onClick={() => setTab(k)}>{l}</button>)}
          </div>
          <div className="mr-body">
            {tab === 'plan' && (task.gate && task.state === 'Menxia' ? <GateCard task={task} variant="court" onDecided={() => (others.length ? setUI({ review: { taskId: others[0].id } }) : close())} /> : task.plan ? <PlanEditor plan={task.plan} readOnly /> : <div className="px-muted">中书省尚未呈上方案</div>)}
            {tab === 'report' && (
              <>
                {task.gate && task.state !== 'Menxia' ? <GateCard task={task} variant="court" onDecided={() => (others.length ? setUI({ review: { taskId: others[0].id } }) : close())} /> : <Markdown text={task.result?.summary || '（尚未回奏）'} />}
              </>
            )}
            {tab === 'diff' && <DiffPane task={task} />}
            {tab === 'preview' && <PreviewPane task={task} />}
            {tab === 'timeline' && <Timeline task={task} />}
          </div>
        </div>
        <div className="mr-rod bottom" />
      </div>
    </div>
  );
}

function DiffPane({ task }: { task: Task }) {
  const files = [...new Set(task.changes.map((c) => c.path))];
  const [sel, setSel] = useState(files[0]);
  const host = useRef<HTMLDivElement>(null);
  const [texts, setTexts] = useState<{ a: string; b: string } | null>(null);
  useEffect(() => {
    if (!sel) return;
    const list = task.changes.filter((c) => c.path === sel && !c.reverted);
    const first = list[0] ?? task.changes.find((c) => c.path === sel)!;
    const last = list[list.length - 1] ?? first;
    Promise.all([first.beforeHash ? call<string>('blob', first.beforeHash) : '', last.afterHash ? call<string>('blob', last.afterHash) : '']).then(([a, b]) => setTexts({ a: a ?? '', b: b ?? '' }));
  }, [sel, task.changes]);
  useEffect(() => {
    if (!texts || !host.current) return;
    let ed: any;
    let m1: any;
    let m2: any;
    loadMonaco().then((monaco) => {
      if (!host.current) return;
      ed = monaco.editor.createDiffEditor(host.current, { automaticLayout: true, readOnly: true, theme: monacoTheme(), renderSideBySide: false, fontSize: 12, minimap: { enabled: false } });
      m1 = monaco.editor.createModel(texts.a, languageFor(sel));
      m2 = monaco.editor.createModel(texts.b, languageFor(sel));
      ed.setModel({ original: m1, modified: m2 });
    });
    return () => {
      ed?.dispose();
      m1?.dispose();
      m2?.dispose();
    };
  }, [texts, sel]);
  if (!files.length) return <div className="px-muted">本旨意尚无文件改动</div>;
  return (
    <div className="mr-diff">
      <div className="mr-files">
        {files.map((f) => {
          const last = [...task.changes].reverse().find((c) => c.path === f)!;
          return (
            <div key={f} className={`mr-file ${f === sel ? 'on' : ''}`} onClick={() => setSel(f)} title={f}>
              <span className={`git-badge git-${last.op === 'create' ? 'added' : last.op === 'delete' ? 'deleted' : 'modified'}`}>{last.op === 'create' ? 'A' : last.op === 'delete' ? 'D' : 'M'}</span>
              <span className="ellipsis">{f}</span>
              <span className="px-muted">{AGENT_MAP[last.agentId]?.name}</span>
            </div>
          );
        })}
        <button className="px-btn sm" onClick={() => texts && openTab({ id: `diff:task:${task.id}:${sel}`, kind: 'diff', title: `${sel.split('/').pop()} · ${task.id}`, diff: { original: texts.a, modified: texts.b, path: sel, label: `旨意 ${task.id} 的改动` } })}>在 Editor 中打开</button>
      </div>
      <div ref={host} className="mr-monaco" />
    </div>
  );
}

function Timeline({ task }: { task: Task }) {
  return (
    <div className="mr-timeline">
      {task.flow.map((f, i) => (
        <div key={i} className="mr-flow"><span className="px-muted">{fmtTime(f.at)}</span> {f.from} → <b>{f.to}</b> <span className="px-muted">{f.remark}</span></div>
      ))}
      {task.reviews.map((r, i) => (
        <div key={`r${i}`} className={`review-note ${r.verdict}`}>{r.stage === 'plan' ? '方案' : '成果'}第{r.round}轮 · {r.reviewer === 'emperor' ? '皇上' : '门下省'} · {r.verdict === 'approve' ? '准奏' : '封驳'}：{r.comment}</div>
      ))}
    </div>
  );
}
