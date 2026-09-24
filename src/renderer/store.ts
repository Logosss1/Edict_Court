// Renderer store — a projection of the main-process runtime + UI state. Both modes
// (工作台 / 朝堂) read the same store, so they are always in sync.
import { useSyncExternalStore, useRef } from 'react';
import type { Activity, AgentId, RuntimeEvent, Snapshot, Task, Debate, Session, Memorial, ApprovalRequest, Annotation } from '../shared/types';
import { call } from './api';

export type PanelId = 'kanban' | 'monitor' | 'memorials' | 'templates' | 'officials' | 'news' | 'models' | 'skills' | 'sessions' | 'ceremony' | 'debate' | 'audit' | 'help';
export type CourtScene = 'taihe' | 'junjichu' | 'liubu' | 'chengtian';

export interface Tab {
  id: string;
  kind: 'file' | 'diff' | 'panel' | 'task' | 'preview';
  url?: string;
  title: string;
  path?: string;
  panel?: PanelId;
  taskId?: string;
  diff?: { original: string; modified: string; path: string; label: string };
  dirty?: boolean;
  preview?: boolean;
}

export interface Toast {
  id: number;
  level: 'info' | 'warn' | 'error' | 'success';
  message: string;
}

export interface UIState {
  mode: 'workbench' | 'court';
  selectedTaskId: string | null;
  tabs: Tab[];
  activeTab: string | null;
  sideView: 'explorer' | 'search' | 'git' | 'court' | null;
  bottomOpen: boolean;
  bottomTab: 'terminal' | 'problems' | 'output' | 'audit';
  composerHidden: boolean;
  courtScene: CourtScene;
  courtDept: AgentId;
  review: { taskId: string; tab?: 'plan' | 'report' | 'diff' | 'timeline' } | null;
  agentDialog: AgentId | null;
  debateId: string | null;
  toasts: Toast[];
  palette: boolean;
  ceremony: boolean;
  lastChat: { sessionId: string; reply: string } | null;
  fsVersion: number;
  changedPaths: string[];
  previewBlocked: { url: string; at: number } | null;
}

export interface AppState extends Snapshot {
  ready: boolean;
  activities: Record<string, Activity[]>; // key: taskId or '_global'
  ui: UIState;
}

const initialUI: UIState = {
  mode: 'workbench', selectedTaskId: null, tabs: [{ id: 'panel:kanban', kind: 'panel', title: '旨意看板', panel: 'kanban' }], activeTab: 'panel:kanban',
  sideView: 'explorer', bottomOpen: false, bottomTab: 'terminal', composerHidden: false, courtScene: 'taihe', courtDept: 'bingbu', review: null,
  agentDialog: null, debateId: null, toasts: [], palette: false, ceremony: false, lastChat: null, fsVersion: 0, changedPaths: [], previewBlocked: null,
};

let state: AppState = {
  ready: false, tasks: [], agents: [], debates: [], sessions: [], memorials: [], approvals: [], annotations: [], news: [], settings: {} as AppState['settings'],
  providers: [], skills: [], mcp: [], templates: [], workspace: null, dataDir: '', version: '', platform: '', totals: { inputTokens: 0, outputTokens: 0, cachedTokens: 0, costUsd: 0, calls: 0 },
  activities: {}, ui: initialUI,
};

const listeners = new Set<() => void>();
const actIndex = new Map<string, Activity>();

function set(next: Partial<AppState>) {
  state = { ...state, ...next };
  for (const l of listeners) l();
}

export function getState() {
  return state;
}

export function setUI(patch: Partial<UIState> | ((ui: UIState) => Partial<UIState>)) {
  const p = typeof patch === 'function' ? patch(state.ui) : patch;
  set({ ui: { ...state.ui, ...p } });
}

function upsert<T>(arr: T[], item: T, key: (x: T) => string): T[] {
  const k = key(item);
  const i = arr.findIndex((x) => key(x) === k);
  if (i < 0) return [...arr, item];
  const copy = arr.slice();
  copy[i] = item;
  return copy;
}

let toastSeq = 1;
export function toast(message: string, level: Toast['level'] = 'info') {
  const t = { id: toastSeq++, level, message };
  setUI((ui) => ({ toasts: [...ui.toasts.slice(-4), t] }));
  setTimeout(() => setUI((ui) => ({ toasts: ui.toasts.filter((x) => x.id !== t.id) })), level === 'error' ? 7000 : 3800);
}

// streaming deltas are batched per animation frame
let deltaQueue: { id: string; append: string }[] = [];
let rafScheduled = false;
function flushDeltas() {
  rafScheduled = false;
  if (!deltaQueue.length) return;
  const touched = new Set<string>();
  for (const d of deltaQueue) {
    const a = actIndex.get(d.id);
    if (!a) continue;
    const na = { ...a, content: a.content + d.append };
    actIndex.set(d.id, na);
    touched.add(na.taskId ?? '_global');
  }
  deltaQueue = [];
  const acts = { ...state.activities };
  for (const k of touched) acts[k] = (acts[k] ?? []).map((x) => actIndex.get(x.id) ?? x);
  set({ activities: acts });
}

function addActivity(a: Activity) {
  const key = a.taskId ?? '_global';
  actIndex.set(a.id, a);
  const list = state.activities[key] ?? [];
  const i = list.findIndex((x) => x.id === a.id);
  const next = i >= 0 ? list.map((x) => (x.id === a.id ? a : x)) : [...list, a].slice(-2500);
  set({ activities: { ...state.activities, [key]: next } });
}

export function applyEvent(e: RuntimeEvent) {
  switch (e.type) {
    case 'snapshot':
      set({ ...e.snapshot, ready: true });
      break;
    case 'task':
      set({ tasks: upsert(state.tasks, e.task, (t) => t.id) });
      break;
    case 'task_removed':
      set({ tasks: state.tasks.filter((t) => t.id !== e.id) });
      break;
    case 'agent':
      set({ agents: upsert(state.agents, { ...e.agent }, (a) => a.id) });
      break;
    case 'activity':
      addActivity(e.activity);
      break;
    case 'activity_delta':
      deltaQueue.push({ id: e.id, append: e.append });
      if (!rafScheduled) {
        rafScheduled = true;
        requestAnimationFrame(flushDeltas);
      }
      break;
    case 'debate':
      set({ debates: upsert(state.debates, JSON.parse(JSON.stringify(e.debate)) as Debate, (d) => d.id) });
      break;
    case 'session':
      set({ sessions: upsert(state.sessions, { ...e.session } as Session, (s) => s.id) });
      break;
    case 'memorial':
      set({ memorials: upsert(state.memorials, e.memorial as Memorial, (m) => m.taskId) });
      break;
    case 'approval':
      set({ approvals: upsert(state.approvals, { ...e.approval } as ApprovalRequest, (a) => a.id) });
      break;
    case 'annotation':
      set({ annotations: upsert(state.annotations, { ...e.annotation } as Annotation, (a) => a.id) });
      break;
    case 'news':
      set({ news: e.news });
      break;
    case 'settings':
      set({ settings: e.settings });
      break;
    case 'providers':
      set({ providers: e.providers });
      break;
    case 'skills':
      set({ skills: e.skills });
      break;
    case 'mcp':
      set({ mcp: e.servers });
      break;
    case 'totals':
      set({ totals: e.totals });
      break;
    case 'workspace':
      set({ workspace: e.workspace });
      setUI((ui) => ({ fsVersion: ui.fsVersion + 1, tabs: ui.tabs.filter((t) => t.kind !== 'file' && t.kind !== 'diff' && t.kind !== 'preview'), activeTab: ui.tabs.find((t) => t.kind === 'panel')?.id ?? null }));
      break;
    case 'fs_changed':
      setUI((ui) => ({ fsVersion: ui.fsVersion + 1, changedPaths: e.paths }));
      break;
    case 'toast':
      toast(e.message, e.level);
      break;
    case 'preview_blocked':
      setUI({ previewBlocked: { url: e.url, at: Date.now() } });
      break;
    case 'menu':
      menuHandlers.forEach((h) => h(e.command, e.arg));
      break;
  }
}

const menuHandlers = new Set<(cmd: string, arg?: unknown) => void>();
export function onMenu(h: (cmd: string, arg?: unknown) => void) {
  menuHandlers.add(h);
  return () => menuHandlers.delete(h);
}

export async function initStore() {
  window.edict.onEvent(applyEvent);
  const snap = await call<Snapshot>('snapshot');
  applyEvent({ type: 'snapshot', snapshot: snap });
  const g = await call<Activity[]>('activities', undefined, 400);
  for (const a of g) actIndex.set(a.id, a);
  set({ activities: { ...state.activities, _global: g } });
  setUI({ composerHidden: !!snap.settings.composerHidden });
  const active = snap.tasks.filter((t) => !['Done', 'Cancelled'].includes(t.state)).sort((a, b) => b.updatedAt - a.updatedAt)[0];
  if (active) selectTask(active.id);
}

export async function loadActivities(taskId: string) {
  if (state.activities[taskId]?.length) return;
  const list = await call<Activity[]>('activities', taskId, 1500);
  for (const a of list) actIndex.set(a.id, a);
  const existing = state.activities[taskId] ?? [];
  const ids = new Set(list.map((a) => a.id));
  set({ activities: { ...state.activities, [taskId]: [...list, ...existing.filter((a) => !ids.has(a.id))] } });
}

export function selectTask(id: string | null) {
  setUI({ selectedTaskId: id });
  if (id) void loadActivities(id);
}

export function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function shallowEqual(a: unknown, b: unknown) {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  for (const k of ka) if (!Object.is((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false;
  return true;
}

/** useStore(selector) — re-renders only when the selected slice changes (shallow). */
export function useStore<T>(selector: (s: AppState) => T): T {
  const cache = useRef<{ s?: AppState; v?: T }>({});
  const get = () => {
    if (cache.current.s === state) return cache.current.v as T;
    const v = selector(state);
    if (cache.current.s !== undefined && shallowEqual(v, cache.current.v)) {
      cache.current.s = state;
      return cache.current.v as T;
    }
    cache.current = { s: state, v };
    return v;
  };
  return useSyncExternalStore(subscribe, get, get);
}

export const useTask = (id: string | null | undefined): Task | undefined => useStore((s) => (id ? s.tasks.find((t) => t.id === id) : undefined));

// ───────── tabs ─────────
export function openTab(tab: Tab) {
  setUI((ui) => {
    const exists = ui.tabs.find((t) => t.id === tab.id);
    let tabs = exists ? ui.tabs.map((t) => (t.id === tab.id ? { ...t, ...tab, dirty: t.dirty } : t)) : [...ui.tabs.filter((t) => !(t.preview && tab.preview && t.kind === tab.kind)), tab];
    if (!exists && tabs.length > 14) tabs = tabs.filter((t) => t.dirty || t.id === tab.id || t !== tabs.find((x) => !x.dirty));
    return { tabs, activeTab: tab.id, mode: 'workbench' as const };
  });
}

export function openPanel(panel: PanelId) {
  const titles: Record<PanelId, string> = { kanban: '旨意看板', monitor: '省部调度', memorials: '奏折阁', templates: '旨库', officials: '官员总览', news: '天下要闻', models: '模型配置', skills: '技能与 MCP', sessions: '小任务', ceremony: '上朝仪式', debate: '朝堂议政', audit: '审计日志', help: '使用说明' };
  openTab({ id: `panel:${panel}`, kind: 'panel', title: titles[panel], panel });
}

export function openTaskTab(taskId: string) {
  const t = state.tasks.find((x) => x.id === taskId);
  selectTask(taskId);
  openTab({ id: `task:${taskId}`, kind: 'task', title: t ? t.title : taskId, taskId });
}

export function closeTab(id: string) {
  setUI((ui) => {
    const i = ui.tabs.findIndex((t) => t.id === id);
    const tabs = ui.tabs.filter((t) => t.id !== id);
    let active = ui.activeTab;
    if (active === id) active = tabs[Math.min(i, tabs.length - 1)]?.id ?? null;
    return { tabs, activeTab: active };
  });
}

export function markDirty(id: string, dirty: boolean) {
  setUI((ui) => ({ tabs: ui.tabs.map((t) => (t.id === id && t.dirty !== dirty ? { ...t, dirty, preview: false } : t)) }));
}
