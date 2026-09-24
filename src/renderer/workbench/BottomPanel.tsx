import { useEffect, useRef, useState } from 'react';
import { useStore, setUI } from '../store';
import { call } from '../api';
import { Icon } from '../common/Icon';
import { getProblems, onProblems, requestReveal, type Problem } from './editorBus';
import { openFile } from './Explorer';
import { Terminal, FitAddon } from '../../../vendor/xterm/xterm.mjs';
import { ActivityStream } from './ActivityStream';
import type { AuditEntry } from '../../shared/types';
import { agentName } from '../../shared/court';
import { fmtTime } from '../common/format';

export function BottomPanel() {
  const tab = useStore((s) => s.ui.bottomTab);
  const [problems, setP] = useState<Problem[]>(getProblems());
  useEffect(() => onProblems(() => setP(getProblems())), []);
  const errs = problems.filter((p) => p.severity === 'error').length;
  const tabBtn = (id: typeof tab, label: string, extra?: string) => (
    <button className={`bp-tab ${tab === id ? 'on' : ''}`} onClick={() => setUI({ bottomTab: id })}>
      {label}
      {extra && <span className="count">{extra}</span>}
    </button>
  );
  return (
    <div className="bottom-panel">
      <div className="bp-tabs">
        {tabBtn('terminal', '终端')}
        {tabBtn('problems', '问题', problems.length ? String(problems.length) : undefined)}
        {tabBtn('output', '输出 · Agent 日志')}
        {tabBtn('audit', '审计')}
        <span style={{ flex: 1 }} />
        {errs > 0 && <span className="muted small" style={{ color: '#d0453a' }}>{errs} 个错误</span>}
        <button className="icon-btn" onClick={() => setUI({ bottomOpen: false })} title="关闭面板">
          <Icon name="x" size={13} />
        </button>
      </div>
      <div className="bp-body">
        <div style={{ display: tab === 'terminal' ? 'flex' : 'none', height: '100%' }}>
          <TerminalHost />
        </div>
        {tab === 'problems' && (
          <div className="problems">
            {!problems.length && <div className="muted pad">没有问题（诊断来自已打开文件的语言服务）。</div>}
            {problems.map((p, i) => (
              <div key={i} className={`problem sev-${p.severity}`} onClick={() => { requestReveal(p.path, p.line, p.col); openFile(p.path, false); }}>
                <Icon name={p.severity === 'error' ? 'x' : 'alert'} size={13} />
                <span>{p.message}</span>
                <span className="muted small">{p.source} · {p.path}:{p.line}:{p.col}</span>
              </div>
            ))}
          </div>
        )}
        {tab === 'output' && <OutputView />}
        {tab === 'audit' && <AuditMini />}
      </div>
    </div>
  );
}

function OutputView() {
  const sel = useStore((s) => s.ui.selectedTaskId);
  return <ActivityStream taskId={sel ?? undefined} compact includeGlobal />;
}

function AuditMini() {
  const [list, setList] = useState<AuditEntry[]>([]);
  const tasksV = useStore((s) => s.tasks.length + s.approvals.length);
  useEffect(() => {
    call<AuditEntry[]>('auditList', undefined, 200).then((l) => setList(l.reverse()));
  }, [tasksV]);
  return (
    <div className="audit-mini">
      {list.map((e) => (
        <div key={e.seq} className="audit-row">
          <span className="muted small">#{e.seq} {fmtTime(e.at)}</span>
          <span className="audit-actor">{agentName(e.actor)}</span>
          <span className="audit-action">{e.action}</span>
          {e.taskId && <code>{e.taskId}</code>}
          <span className="muted small ellipsis">{JSON.stringify(e.detail).slice(0, 160)}</span>
        </div>
      ))}
    </div>
  );
}

let termSeq = 1;
function TerminalHost() {
  const [terms, setTerms] = useState<string[]>([`t${termSeq++}`]);
  const [active, setActive] = useState(terms[0]);
  return (
    <div className="term-host">
      <div className="term-list">
        {terms.map((t, i) => (
          <div key={t} className={`term-item ${t === active ? 'on' : ''}`} onClick={() => setActive(t)}>
            <Icon name="terminal" size={12} /> zsh {i + 1}
            <button className="icon-btn" onClick={(e) => { e.stopPropagation(); void call('termKill', t); const rest = terms.filter((x) => x !== t); setTerms(rest.length ? rest : [`t${termSeq++}`]); if (active === t) setActive(rest[0]); }}>
              <Icon name="trash" size={11} />
            </button>
          </div>
        ))}
        <button className="icon-btn" title="新建终端" onClick={() => { const id = `t${termSeq++}`; setTerms([...terms, id]); setActive(id); }}>
          <Icon name="plus" size={13} />
        </button>
      </div>
      <div className="term-views">
        {terms.map((t) => (
          <TermView key={t} id={t} visible={t === (terms.includes(active) ? active : terms[0])} />
        ))}
      </div>
    </div>
  );
}

function TermView({ id, visible }: { id: string; visible: boolean }) {
  const el = useRef<HTMLDivElement>(null);
  const term = useRef<any>(null);
  const fit = useRef<any>(null);
  const ws = useStore((s) => s.workspace);
  useEffect(() => {
    const dark = document.documentElement.dataset.theme !== 'light';
    const t = new Terminal({ fontFamily: 'SF Mono, Menlo, monospace', fontSize: 12.5, cursorBlink: true, allowProposedApi: true, theme: dark ? { background: '#120f0c', foreground: '#e9e0d0', cursor: '#e8b64c', selectionBackground: '#5a3a2a' } : { background: '#fbf7ef', foreground: '#2b2118', cursor: '#b3322a' } });
    const f = new FitAddon();
    t.loadAddon(f);
    t.open(el.current!);
    term.current = t;
    fit.current = f;
    setTimeout(() => {
      try {
        f.fit();
      } catch {
        /* hidden */
      }
      void call('termCreate', id, t.cols || 100, t.rows || 24);
    }, 50);
    const off = window.edict.onTerm((e) => {
      if (e.id !== id) return;
      if (e.kind === 'data') t.write(e.payload);
      else t.write(`\r\n\x1b[33m[进程已退出 ${e.payload}]\x1b[0m\r\n`);
    });
    t.onData((d: string) => void call('termWrite', id, d));
    const ro = new ResizeObserver(() => {
      try {
        f.fit();
        void call('termResize', id, t.cols, t.rows);
      } catch {
        /* ignore */
      }
    });
    ro.observe(el.current!);
    return () => {
      off();
      ro.disconnect();
      t.dispose();
      void call('termKill', id);
    };
  }, [id, ws]);
  const theme = useStore((s) => s.settings.theme);
  useEffect(() => {
    const t = term.current;
    if (!t) return;
    const dark = document.documentElement.dataset.theme !== 'light';
    t.options.theme = dark ? { background: '#120f0c', foreground: '#e9e0d0', cursor: '#e8b64c', selectionBackground: '#5a3a2a' } : { background: '#fbf7ef', foreground: '#2b2118', cursor: '#b3322a', selectionBackground: '#e6cfa8' };
  }, [theme]);
  useEffect(() => {
    if (visible)
      setTimeout(() => {
        try {
          fit.current?.fit();
          term.current?.focus();
        } catch {
          /* ignore */
        }
      }, 30);
  }, [visible]);
  return <div ref={el} className="term-view" style={{ display: visible ? 'block' : 'none' }} />;
}
