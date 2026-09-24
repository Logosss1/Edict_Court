import { useEffect, useRef, useState, lazy, Suspense } from 'react';
import { useStore, setUI, closeTab, markDirty, onMenu, getState, toast, type Tab } from '../store';
import { call } from '../api';
import { Icon } from '../common/Icon';
import { loadMonaco, languageFor, monacoTheme } from '../common/loaders';
import { takeReveal, onReveal, setProblems, registerSave, saveActiveEditor } from './editorBus';
import { PanelView } from '../panels/PanelView';
import { askText } from '../common/Prompt';
import { TaskDetail } from '../panels/TaskDetail';

const BINARY = /\.(png|jpe?g|gif|webp|ico|icns|pdf|zip|gz|tgz|dmg|woff2?|ttf|otf|mp3|mp4|mov|wasm|so|dylib|exe|bin|jar|class|o|a|sqlite|db)$/i;

interface ModelEntry {
  model: any;
  saved: number;
  viewState?: any;
  disk: string;
}
const models = new Map<string, ModelEntry>();

export function EditorArea() {
  const tabs = useStore((s) => s.ui.tabs);
  const active = useStore((s) => s.ui.activeTab);
  const tab = tabs.find((t) => t.id === active);

  useEffect(
    () =>
      onMenu(async (cmd) => {
        const ui = getState().ui;
        if (cmd === 'save') saveActiveEditor();
        if (cmd === 'close-tab' && ui.activeTab) {
          const t = ui.tabs.find((x) => x.id === ui.activeTab);
          if (t?.dirty && !(await call<boolean>('confirm', `${t.title} 有未保存的修改，确定关闭？`))) return;
          if (t?.path) disposeModel(t.path);
          closeTab(ui.activeTab);
        }
        if (cmd === 'new-file') {
          if (!getState().workspace) return toast('请先打开工作区', 'warn');
          const name = await askText('新建文件', { placeholder: '相对工作区的路径，如 src/util.ts' });
          if (name) {
            try {
              await call('createFile', name);
              setUI({});
              const { openFile } = await import('./Explorer');
              openFile(name, false);
            } catch (e) {
              toast((e as Error).message, 'error');
            }
          }
        }
      }),
    [],
  );

  return (
    <div className="editor-area">
      <div className="tabbar" role="tablist">
        {tabs.map((t) => (
          <div key={t.id} role="tab" aria-selected={t.id === active} className={`tab ${t.id === active ? 'on' : ''} ${t.preview ? 'preview' : ''}`} onClick={() => setUI({ activeTab: t.id })} onDoubleClick={() => setUI((ui) => ({ tabs: ui.tabs.map((x) => (x.id === t.id ? { ...x, preview: false } : x)) }))} onMouseDown={(e) => e.button === 1 && closeTab(t.id)} title={t.path ?? t.title}>
            <Icon name={t.kind === 'file' ? 'file' : t.kind === 'diff' ? 'diff' : t.kind === 'task' ? 'scroll' : 'layers'} size={13} />
            <span className="tab-title">{t.title}</span>
            {t.dirty ? (
              <span className="tab-dirty">●</span>
            ) : (
              <button className="tab-close" onClick={(e) => { e.stopPropagation(); if (t.path) disposeModel(t.path); closeTab(t.id); }}>
                <Icon name="x" size={12} />
              </button>
            )}
          </div>
        ))}
      </div>
      <div className="editor-content">
        <FileEditor tab={tab?.kind === 'file' ? tab : undefined} />
        {tab?.kind === 'diff' && <DiffView key={tab.id} tab={tab} />}
        {tab?.kind === 'panel' && <div className="panel-host"><PanelView panel={tab.panel!} /></div>}
        {tab?.kind === 'task' && <div className="panel-host"><TaskDetail taskId={tab.taskId!} /></div>}
        {!tab && <Welcome />}
      </div>
    </div>
  );
}

function disposeModel(path: string) {
  const e = models.get(path);
  if (e) {
    e.model.dispose();
    models.delete(path);
  }
}

function FileEditor({ tab }: { tab?: Tab }) {
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const fsVersion = useStore((s) => s.ui.fsVersion);
  const changed = useStore((s) => s.ui.changedPaths);
  const theme = useStore((s) => s.settings.theme);
  const path = tab?.path;

  // create editor once
  useEffect(() => {
    let disposed = false;
    loadMonaco().then((monaco) => {
      if (disposed || !host.current) return;
      editor.current = monaco.editor.create(host.current, {
        model: null, automaticLayout: true, theme: monacoTheme(), fontSize: 13, fontFamily: 'SF Mono, Menlo, Monaco, "Cascadia Code", monospace', minimap: { enabled: true, scale: 1 },
        smoothScrolling: true, scrollBeyondLastLine: false, renderWhitespace: 'selection', bracketPairColorization: { enabled: true }, tabSize: 2,
      });
      editor.current.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => saveActiveEditor());
      monaco.editor.onDidChangeMarkers(() => {
        const all = monaco.editor.getModelMarkers({});
        setProblems(all.map((m: any) => ({ path: m.resource.path.replace(/^\//, ''), line: m.startLineNumber, col: m.startColumn, severity: m.severity >= 8 ? 'error' : m.severity >= 4 ? 'warning' : 'info', message: m.message, source: m.source || m.owner })));
      });
    });
    return () => {
      disposed = true;
      editor.current?.dispose();
    };
  }, []);

  useEffect(() => {
    editor.current && window.monaco?.editor.setTheme(monacoTheme());
  }, [theme]);

  // switch model on tab change
  useEffect(() => {
    if (!path) return;
    let cancelled = false;
    setErr(null);
    (async () => {
      const monaco = await loadMonaco();
      if (BINARY.test(path)) return setErr('二进制文件，暂不支持在编辑器中打开');
      let entry = models.get(path);
      if (!entry) {
        let text: string;
        try {
          text = await call<string>('readFile', path);
        } catch (e) {
          return setErr((e as Error).message);
        }
        if (cancelled) return;
        const uri = monaco.Uri.from({ scheme: 'file', path: '/' + path });
        const model = monaco.editor.getModel(uri) ?? monaco.editor.createModel(text, languageFor(path), uri);
        entry = { model, saved: model.getAlternativeVersionId(), disk: text };
        models.set(path, entry);
        model.onDidChangeContent(() => markDirty(`file:${path}`, model.getAlternativeVersionId() !== entry!.saved));
      }
      const ed = editor.current;
      if (!ed || cancelled) return;
      const prev = ed.getModel();
      if (prev && prev !== entry.model) {
        const prevEntry = [...models.values()].find((m) => m.model === prev);
        if (prevEntry) prevEntry.viewState = ed.saveViewState();
      }
      ed.setModel(entry.model);
      if (entry.viewState) ed.restoreViewState(entry.viewState);
      const r = takeReveal(path);
      if (r) {
        ed.revealLineInCenter(r.line);
        ed.setPosition({ lineNumber: r.line, column: r.col });
      }
      ed.focus();
      registerSave(async () => {
        const e = models.get(path);
        if (!e) return;
        const text = e.model.getValue();
        try {
          await call('writeFile', path, text);
          e.saved = e.model.getAlternativeVersionId();
          e.disk = text;
          markDirty(`file:${path}`, false);
          toast(`已保存 ${path}`, 'success');
        } catch (er) {
          toast((er as Error).message, 'error');
        }
      });
    })();
    const off = onReveal((p) => {
      if (p === path && editor.current) {
        const r = takeReveal(p);
        if (r) {
          editor.current.revealLineInCenter(r.line);
          editor.current.setPosition({ lineNumber: r.line, column: r.col });
        }
      }
    });
    return () => {
      cancelled = true;
      off();
    };
  }, [path]);

  // live refresh when agents (or anything) change files on disk
  useEffect(() => {
    const targets = changed.length ? changed : [...models.keys()];
    for (const p of targets) {
      const e = models.get(p);
      if (!e) continue;
      call<string>('readFile', p)
        .then((text) => {
          if (text === e.disk) return;
          const dirty = e.model.getAlternativeVersionId() !== e.saved;
          e.disk = text;
          if (dirty) {
            toast(`${p} 已在磁盘上被修改（可能来自 Agent），与你未保存的修改冲突`, 'warn');
            return;
          }
          e.model.pushEditOperations([], [{ range: e.model.getFullModelRange(), text }], () => null);
          e.saved = e.model.getAlternativeVersionId();
          markDirty(`file:${p}`, false);
        })
        .catch(() => {});
    }
  }, [fsVersion]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="file-editor" style={{ display: tab ? 'flex' : 'none' }}>
      {tab && (
        <div className="breadcrumbs">
          {tab.path?.split('/').map((seg, i, arr) => (
            <span key={i}>
              {seg}
              {i < arr.length - 1 && <Icon name="chevronRight" size={10} />}
            </span>
          ))}
        </div>
      )}
      {err && <div className="editor-err">{err}</div>}
      <div ref={host} className="monaco-host" style={{ display: err ? 'none' : 'block' }} />
    </div>
  );
}

export function DiffView({ tab }: { tab: Tab }) {
  const host = useRef<HTMLDivElement>(null);
  const [inline, setInline] = useState(false);
  useEffect(() => {
    let ed: any;
    let m1: any;
    let m2: any;
    loadMonaco().then((monaco) => {
      if (!host.current || !tab.diff) return;
      ed = monaco.editor.createDiffEditor(host.current, { automaticLayout: true, readOnly: true, theme: monacoTheme(), renderSideBySide: !inline, fontSize: 12.5, minimap: { enabled: false }, originalEditable: false });
      const lang = languageFor(tab.diff.path);
      m1 = monaco.editor.createModel(tab.diff.original, lang);
      m2 = monaco.editor.createModel(tab.diff.modified, lang);
      ed.setModel({ original: m1, modified: m2 });
    });
    return () => {
      ed?.dispose();
      m1?.dispose();
      m2?.dispose();
    };
  }, [tab.id, inline, tab.diff]);
  return (
    <div className="diff-view">
      <div className="breadcrumbs">
        <Icon name="diff" size={12} /> {tab.diff?.label} · {tab.diff?.path}
        <span style={{ flex: 1 }} />
        <button className="link" onClick={() => setInline(!inline)}>{inline ? '并排' : '行内'}视图</button>
      </div>
      <div ref={host} className="monaco-host" />
    </div>
  );
}

function Welcome() {
  const ws = useStore((s) => s.workspace);
  return (
    <div className="welcome">
      <div className="welcome-seal">敕</div>
      <h1>Edict · 三省六部</h1>
      <p className="muted">下旨 → 太子分拣 → 中书规划 → 门下审议（准奏 / 封驳）→ 尚书派发 → 六部执行 → 回奏</p>
      <div className="welcome-actions">
        {!ws && <button className="btn primary" onClick={() => call('openFolder')}><Icon name="folder" /> 打开工作区</button>}
        <button className="btn" onClick={() => setUI({ composerHidden: false })}><Icon name="send" /> 下旨（⌘I）</button>
        <button className="btn" onClick={() => setUI({ mode: 'court' })}><Icon name="crown" /> 上朝（⌘J）</button>
      </div>
    </div>
  );
}

export { Suspense, lazy };
