// E2 · 项目规约与典章: the workspace's own rule files (AGENTS.md / CLAUDE.md / .edict/rules.md) and the
// emperor's standing canon (禁止 / 规矩 / 偏好 / 教训), added to the planning, review and execution prompts
// (user turn, so the cached system prompt stays the same).
import type { CanonEntry, CanonKind, Task } from '../../shared/types';
import type { Runtime } from './runtime';
import type { Workspace } from '../services/workspace';
import { now, truncate, uid } from './util';

export const RULE_FILES = ['AGENTS.md', 'CLAUDE.md', '.edict/rules.md'];
const RULES_BUDGET = 4000;
const CANON_BUDGET = 2000;
export const CANON_LABEL: Record<CanonKind, string> = { forbid: '禁止', rule: '规矩', preference: '偏好', lesson: '教训' };
const KIND_ORDER: CanonKind[] = ['forbid', 'rule', 'preference', 'lesson'];

/** The workspace's rule files that exist, each cut to its share of the budget. */
export function projectRules(ws: Workspace): { files: string[]; text: string } {
  const found: { file: string; text: string }[] = [];
  for (const f of RULE_FILES) {
    try {
      const buf = ws.readBuffer(f);
      const text = buf?.toString('utf8').trim();
      if (text) found.push({ file: f, text });
    } catch {
      /* unreadable or outside the boundary: skip */
    }
  }
  if (!found.length) return { files: [], text: '' };
  const share = Math.floor(RULES_BUDGET / found.length);
  return { files: found.map((x) => x.file), text: found.map((x) => `〔${x.file}〕\n${truncate(x.text, share)}`).join('\n\n') };
}

const mentions = (hay: string, kw: string) => !!kw.trim() && hay.includes(kw.trim().toLowerCase());

/**
 * Canon entries for an edict: 禁止 always; others when they have no keywords or the edict mentions one;
 * workspace-scoped entries only on that workspace. Ordered 禁止 → 规矩 → 偏好 → 教训, newest first, within budget.
 */
export function selectCanon(rt: Runtime, t: Task): CanonEntry[] {
  const root = rt.permRoot(t);
  const hay = `${t.title}\n${t.edict}`.toLowerCase();
  const picked = (rt.settings.canon ?? [])
    .filter((c) => c.enabled && c.text.trim() && (!c.root || c.root === root))
    .filter((c) => c.kind === 'forbid' || !c.keywords.length || c.keywords.some((k) => mentions(hay, k)))
    .sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || b.at - a.at);
  const out: CanonEntry[] = [];
  let used = 0;
  for (const c of picked) {
    const n = c.text.length + 8;
    if (used + n > CANON_BUDGET && c.kind !== 'forbid') continue;
    out.push(c);
    used += n;
  }
  return out;
}

/** Prompt block with the project's rule files (when the edict has a workspace) and the selected canon. */
export function canonBlock(rt: Runtime, t: Task, ws?: Workspace | null): string {
  const parts: string[] = [];
  if (ws) {
    const r = projectRules(ws);
    if (r.text) parts.push(`【项目规约】（工作区里的 ${r.files.join('、')}，请遵守）\n${r.text}`);
  }
  const canon = selectCanon(rt, t);
  if (canon.length) {
    parts.push(`【典章】（皇上定下的规矩，必须遵守；「禁止」一条都不能违反）\n${canon.map((c) => `- [${CANON_LABEL[c.kind]}] ${c.text.trim()}`).join('\n')}`);
    const ids = canon.map((c) => c.id);
    const before = new Set(t.canonUsed ?? []);
    if (ids.some((id) => !before.has(id))) {
      t.canonUsed = [...before, ...ids.filter((id) => !before.has(id))];
      rt.audit.record('system', 'canon_applied', { ids }, t.id);
      rt.touch(t);
    }
  }
  return parts.join('\n\n');
}

// ───────────────────────── editing the canon ─────────────────────────
function cleanKeywords(k: unknown): string[] {
  const list = Array.isArray(k) ? k : typeof k === 'string' ? k.split(/[,，、\s]+/) : [];
  return [...new Set(list.map((x) => String(x).trim()).filter(Boolean))].slice(0, 20);
}

function validKind(k: unknown): CanonKind {
  return KIND_ORDER.includes(k as CanonKind) ? (k as CanonKind) : 'rule';
}

function save(rt: Runtime, canon: CanonEntry[], action: string, detail: Record<string, unknown>) {
  rt.updateSettings({ canon });
  rt.audit.record('emperor', action, detail);
}

export function addCanon(rt: Runtime, o: { kind?: CanonKind; text: string; keywords?: string[] | string; root?: string | null; source?: CanonEntry['source'] }): CanonEntry {
  const text = String(o.text ?? '').trim();
  if (!text) throw new Error('典章内容不能为空');
  if (text.length > 600) throw new Error('一条典章最多 600 字，请拆成几条');
  const e: CanonEntry = { id: uid('cn'), kind: validKind(o.kind), text, keywords: cleanKeywords(o.keywords), enabled: true, at: now(), ...(o.root ? { root: o.root } : {}), ...(o.source ? { source: o.source } : {}) };
  save(rt, [...(rt.settings.canon ?? []), e], 'canon_added', { id: e.id, kind: e.kind, root: e.root ?? null });
  return e;
}

export function updateCanon(rt: Runtime, id: string, patch: Partial<Pick<CanonEntry, 'kind' | 'text' | 'keywords' | 'root' | 'enabled'>>): CanonEntry {
  const list = rt.settings.canon ?? [];
  const cur = list.find((c) => c.id === id);
  if (!cur) throw new Error('典章条目不存在');
  const next: CanonEntry = { ...cur };
  if (patch.text !== undefined) {
    const text = String(patch.text).trim();
    if (!text) throw new Error('典章内容不能为空');
    next.text = text.slice(0, 600);
  }
  if (patch.kind !== undefined) next.kind = validKind(patch.kind);
  if (patch.keywords !== undefined) next.keywords = cleanKeywords(patch.keywords);
  if (patch.enabled !== undefined) next.enabled = !!patch.enabled;
  if (patch.root !== undefined) {
    if (patch.root) next.root = patch.root;
    else delete next.root;
  }
  save(rt, list.map((c) => (c.id === id ? next : c)), 'canon_updated', { id, keys: Object.keys(patch) });
  return next;
}

export function removeCanon(rt: Runtime, id: string) {
  const list = rt.settings.canon ?? [];
  if (!list.some((c) => c.id === id)) return;
  save(rt, list.filter((c) => c.id !== id), 'canon_removed', { id });
}

/** 「收入典章」: turn a 门下 / 皇上 rejection into a lesson for later edicts on the same workspace. */
export function canonFromReview(rt: Runtime, taskId: string, index: number, o: { text?: string; keywords?: string[] | string; global?: boolean } = {}): CanonEntry {
  const t = rt.getTask(taskId);
  const r = t.reviews[index];
  if (!r) throw new Error('找不到这条审议记录');
  if (r.verdict !== 'reject') throw new Error('只有封驳意见可以收入典章');
  const text = o.text?.trim() || truncate([r.comment, ...r.issues].filter(Boolean).join('；'), 600);
  return addCanon(rt, {
    kind: 'lesson', text, keywords: o.keywords,
    root: o.global ? null : rt.permRoot(t),
    source: { taskId, label: `${t.title} · ${r.stage === 'plan' ? '方案' : '成果'}第 ${r.round} 轮${r.reviewer === 'emperor' ? '皇上' : '门下'}封驳` },
  });
}
