// 下旨框 MCP pickers, pure part: which trigger the caret is in (`/` at the start of an otherwise empty line → prompts,
// `@` → resources), filtering, and the text after a pick. No React / DOM here so it can be unit tested.
import { mcpRefToken } from '../../shared/mcpRefs';
import type { McpPromptListItem, McpResourceListItem } from '../../shared/types';

/** `raw` is the trigger text itself (`/rev`, `@read`), `query` what filters the list. */
export interface Trigger { kind: 'prompt' | 'resource'; start: number; end: number; raw: string; query: string }

/** Characters after which `@` opens the resource picker: start, whitespace, CJK text / punctuation (no emails). */
const CJK = '\\u3000-\\u303f\\u3400-\\u9fff\\uf900-\\ufaff\\uff00-\\uffef';
const AT_BEFORE = new RegExp(`(^|[\\s${CJK}])@([^\\s@<>]{0,200})$`);
/** The caret must sit at the end of the `@…` word (text right after it may only be space or CJK). */
const AT_AFTER = new RegExp(`^[^\\s${CJK}]`);

export function triggerAt(text: string, caret: number): Trigger | null {
  if (caret < 0 || caret > text.length) return null;
  const before = text.slice(0, caret);
  const line = before.slice(before.lastIndexOf('\n') + 1);
  const rest = text.slice(caret).split('\n')[0];
  const slash = line.match(/^\/([^\s/]{0,100})$/);
  if (slash && !rest.trim()) return { kind: 'prompt', start: caret - line.length, end: caret, raw: line, query: slash[1] };
  const at = before.match(AT_BEFORE);
  if (at && !AT_AFTER.test(rest)) return { kind: 'resource', start: caret - at[2].length - 1, end: caret, raw: `@${at[2]}`, query: at[2].replace(/^mcp:/i, '') };
  return null;
}

const norm = (s: string | undefined) => (s ?? '').toLowerCase();

/** Prompts matching the typed query (name, title, server, description), best first. */
export function filterPrompts(list: McpPromptListItem[], query: string, max = 50): McpPromptListItem[] {
  const q = norm(query);
  const score = (p: McpPromptListItem) => (!q ? 0 : norm(p.name).startsWith(q) || norm(p.title).startsWith(q) ? 0 : norm(p.name).includes(q) || norm(p.title).includes(q) ? 1 : 2);
  return list.filter((p) => !q || [p.name, p.title, p.server, p.description].some((x) => norm(x).includes(q))).sort((a, b) => score(a) - score(b)).slice(0, max);
}

/** Resources matching the query (name, title, uri, server; `server/uri` also works), best first. */
export function filterResources(list: McpResourceListItem[], query: string, max = 50): McpResourceListItem[] {
  const q = norm(query);
  const score = (r: McpResourceListItem) => (!q ? 0 : norm(r.name).startsWith(q) || norm(r.title).startsWith(q) ? 0 : norm(`${r.server}/${r.uri}`).startsWith(q) ? 1 : 2);
  return list.filter((r) => !q || [r.name, r.title, r.uri, r.server, `${r.server}/${r.uri}`].some((x) => norm(x).includes(q))).sort((a, b) => score(a) - score(b)).slice(0, max);
}

/** Replace the trigger with `insert`; returns the new text and where the caret goes. */
export function applyPick(text: string, t: Trigger, insert: string): { text: string; caret: number } {
  // the trigger may have moved if the text changed meanwhile (prompt arguments form): fall back to its end
  const same = text.slice(t.start, t.end) === t.raw;
  const start = same ? t.start : Math.min(t.end, text.length);
  const end = same ? t.end : start;
  const after = text.slice(end);
  const pad = t.kind === 'resource' && !/^\s/.test(after) ? ' ' : '';
  const out = text.slice(0, start) + insert + pad + after;
  return { text: out, caret: start + insert.length + pad.length };
}

export const resourceInsert = (r: McpResourceListItem) => mcpRefToken(r.server, r.uri);
