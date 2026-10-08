// Editor state helpers: undo/redo history for the draft, and an autosaved copy of the unsaved draft in
// localStorage so a crash, a reload or a stray click never loses an afternoon of flow design.
import { useCallback, useRef, useState } from 'react';
import type { Draft } from './edit';

const COALESCE_MS = 600;
const LIMIT = 100;

/** draft state with undo / redo; edits that land within 600ms of each other (typing) form one step */
export function useDraftHistory(start: Draft) {
  const [state, setState] = useState<{ past: Draft[]; now: Draft; future: Draft[] }>({ past: [], now: start, future: [] });
  const last = useRef(0);
  const set = useCallback((next: Draft) => {
    const t = Date.now();
    const merge = t - last.current < COALESCE_MS;
    last.current = t;
    setState((s) => (next === s.now ? s : { past: merge && s.past.length ? s.past : [...s.past, s.now].slice(-LIMIT), now: next, future: [] }));
  }, []);
  const undo = useCallback(() => {
    last.current = 0;
    setState((s) => (s.past.length ? { past: s.past.slice(0, -1), now: s.past[s.past.length - 1], future: [s.now, ...s.future] } : s));
  }, []);
  const redo = useCallback(() => {
    last.current = 0;
    setState((s) => (s.future.length ? { past: [...s.past, s.now], now: s.future[0], future: s.future.slice(1) } : s));
  }, []);
  return { draft: state.now, setDraft: set, undo, redo, canUndo: state.past.length > 0, canRedo: state.future.length > 0 };
}

const KEY = 'edict.designDraft';

export interface StashedDraft {
  /** the design as it was when editing started (what "changed" is measured against) */
  base: Draft;
  draft: Draft;
  note: string;
  at: number;
}

export function readStash(): StashedDraft | null {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || 'null');
    return v && v.draft && v.base ? v : null;
  } catch {
    return null;
  }
}

export function writeStash(s: StashedDraft) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* storage full or unavailable: autosave is best-effort */
  }
}

export function clearStash() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
