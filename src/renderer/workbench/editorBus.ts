// Small coordination bus between explorer/search/problems and the Monaco editor area.
type Reveal = { line: number; col: number };
const pending = new Map<string, Reveal>();
const listeners = new Set<(path: string) => void>();

export function requestReveal(path: string, line: number, col = 1) {
  pending.set(path, { line, col });
  listeners.forEach((l) => l(path));
}

export function takeReveal(path: string): Reveal | undefined {
  const r = pending.get(path);
  pending.delete(path);
  return r;
}

export function onReveal(fn: (path: string) => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

// Problems (Monaco markers) aggregated for the problems panel
export interface Problem {
  path: string;
  line: number;
  col: number;
  severity: 'error' | 'warning' | 'info';
  message: string;
  source: string;
}
let problems: Problem[] = [];
const pListeners = new Set<() => void>();
export function setProblems(p: Problem[]) {
  problems = p;
  pListeners.forEach((l) => l());
}
export function getProblems() {
  return problems;
}
export function onProblems(fn: () => void) {
  pListeners.add(fn);
  return () => {
    pListeners.delete(fn);
  };
}

// save hook registry (Cmd+S)
let saveActive: (() => void) | null = null;
export function registerSave(fn: (() => void) | null) {
  saveActive = fn;
}
export function saveActiveEditor() {
  saveActive?.();
}

// Language-server diagnostics → Monaco markers (owner `lsp:<server>`), for open models only.
export interface LspDiag { line: number; column: number; endLine: number; endColumn: number; severity: 'error' | 'warning' | 'info' | 'hint'; message: string; source?: string; code?: string; unnecessary?: boolean; deprecated?: boolean }
const lspLatest = new Map<string, Map<string, LspDiag[]>>();
export function applyLspDiagnostics(path: string, server: string, diagnostics: LspDiag[]) {
  const per = lspLatest.get(path) ?? new Map<string, LspDiag[]>();
  per.set(server, diagnostics);
  lspLatest.set(path, per);
  paintLspMarkers(path);
}
export function paintLspMarkers(path: string) {
  const monaco = window.monaco;
  if (!monaco) return;
  const model = monaco.editor.getModel(monaco.Uri.from({ scheme: 'file', path: '/' + path }));
  if (!model) return;
  const S = monaco.MarkerSeverity;
  for (const [server, list] of lspLatest.get(path) ?? []) {
    monaco.editor.setModelMarkers(model, 'lsp:' + server, list.map((d) => ({
      startLineNumber: d.line, startColumn: d.column, endLineNumber: d.endLine, endColumn: Math.max(d.endColumn, d.line === d.endLine ? d.column + 1 : d.endColumn),
      severity: d.severity === 'error' ? S.Error : d.severity === 'warning' ? S.Warning : d.severity === 'info' ? S.Info : S.Hint,
      message: d.message, source: d.source ?? server, code: d.code,
      tags: [...(d.unnecessary ? [1] : []), ...(d.deprecated ? [2] : [])],
    })));
  }
}
export function forgetLspDiagnostics(path: string) {
  lspLatest.delete(path);
}
