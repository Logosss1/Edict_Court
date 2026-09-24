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
  return () => listeners.delete(fn);
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
  return () => pListeners.delete(fn);
}

// save hook registry (Cmd+S)
let saveActive: (() => void) | null = null;
export function registerSave(fn: (() => void) | null) {
  saveActive = fn;
}
export function saveActiveEditor() {
  saveActive?.();
}
