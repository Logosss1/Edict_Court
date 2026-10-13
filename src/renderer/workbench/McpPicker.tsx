// 下旨框: MCP prompts (`/` at the start of an empty line) and resources (`@`). A small list above the textarea —
// ↑/↓ move, Enter / Tab pick, Esc close. A prompt with arguments asks for them in a tiny inline form, then its text
// (mcpGetPrompt) replaces the `/…`; a resource inserts `@mcp:<server>/<uri>`, which submit() reads and attaches.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { call } from '../api';
import { toast, useStore } from '../store';
import type { McpPromptListItem, McpPromptResult, McpResourceListItem } from '../../shared/types';
import { applyPick, filterPrompts, filterResources, resourceInsert, triggerAt, type Trigger } from './mcpPick';
import './mcpPicker.css';

interface Form { prompt: McpPromptListItem; trigger: Trigger; values: Record<string, string>; busy?: boolean }
type Item = { kind: 'prompt'; p: McpPromptListItem } | { kind: 'resource'; r: McpResourceListItem };

export interface McpPicker {
  /** call from the textarea's onChange / onSelect / onFocus / onBlur */
  track: (el: HTMLTextAreaElement, focused?: boolean) => void;
  /** call first in the textarea's onKeyDown; true = handled */
  onKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => boolean;
  popup: ReactNode;
}

export function useMcpPicker(text: string, setText: (t: string) => void, ta: RefObject<HTMLTextAreaElement | null>): McpPicker {
  const servers = useStore((s) => s.mcp);
  const [caret, setCaret] = useState(0);
  const [focused, setFocused] = useState(false);
  const [sel, setSel] = useState(0);
  const [dismissed, setDismissed] = useState<number | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [live, setLive] = useState<{ key: string; prompts?: McpPromptListItem[]; resources?: McpResourceListItem[] }>({ key: '' });
  const listRef = useRef<HTMLDivElement>(null);

  // what the connected servers offer (state first; refreshed live once per change when a picker opens)
  const ok = servers.filter((s) => s.status === 'ok');
  const key = ok.map((s) => `${s.name}:${s.resourceCount ?? 0}:${s.prompts?.length ?? 0}`).join('|');
  const fromState = useMemo(() => ({
    prompts: ok.flatMap((s) => (s.prompts ?? []).map((p) => ({ ...p, server: s.name }))),
    resources: ok.flatMap((s) => (s.resources ?? []).map((r) => ({ ...r, server: s.name }))),
  }), [key, servers]); // eslint-disable-line react-hooks/exhaustive-deps
  const prompts = (live.key === key && live.prompts) || fromState.prompts;
  const resources = (live.key === key && live.resources) || fromState.resources;

  const trig = focused && !form ? triggerAt(text, caret) : null;
  const open = !!trig && trig.start !== dismissed && (trig.kind === 'prompt' ? prompts.length > 0 : resources.length > 0);
  const items: Item[] = !open || !trig ? [] : trig.kind === 'prompt' ? filterPrompts(prompts, trig.query).map((p) => ({ kind: 'prompt', p })) : filterResources(resources, trig.query).map((r) => ({ kind: 'resource', r }));
  const shown = open && items.length > 0;
  const cur = Math.min(sel, Math.max(0, items.length - 1));

  useEffect(() => {
    if (!trig) setDismissed(null);
  }, [trig?.start, !trig]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => setSel(0), [trig?.kind, trig?.query]);
  useEffect(() => {
    listRef.current?.querySelector('.on')?.scrollIntoView({ block: 'nearest' });
  }, [cur, shown]);
  // refresh from the servers when a picker opens and what we hold is stale
  const want = open ? trig!.kind : null;
  useEffect(() => {
    if (!want || !key) return;
    if (live.key === key && (want === 'prompt' ? live.prompts : live.resources)) return;
    let gone = false;
    const done = (patch: Partial<typeof live>) => !gone && setLive((l) => ({ ...(l.key === key ? l : { key }), ...patch }));
    if (want === 'prompt') void call<McpPromptListItem[]>('mcpListPrompts').then((p) => done({ prompts: p }), () => undefined);
    else void call<McpResourceListItem[]>('mcpListResources').then((r) => done({ resources: r }), () => undefined);
    return () => {
      gone = true;
    };
  }, [want, key]); // eslint-disable-line react-hooks/exhaustive-deps

  const put = (t: Trigger, insert: string) => {
    const el = ta.current;
    const r = applyPick(el?.value ?? text, t, insert);
    setText(r.text);
    setCaret(r.caret);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(r.caret, r.caret);
    });
  };
  const runPrompt = async (p: McpPromptListItem, t: Trigger, values: Record<string, string>) => {
    try {
      const r = await call<McpPromptResult>('mcpGetPrompt', p.server, p.name, values);
      setForm(null);
      put(t, r.text);
    } catch (e) {
      toast((e as Error).message, 'error');
      setForm((f) => (f ? { ...f, busy: false } : f));
    }
  };
  const choose = (it: Item) => {
    if (!trig) return;
    if (it.kind === 'resource') return put(trig, resourceInsert(it.r));
    const p = it.p;
    if (p.arguments.length) return setForm({ prompt: p, trigger: trig, values: {} });
    setForm({ prompt: p, trigger: trig, values: {}, busy: true });
    void runPrompt(p, trig, {});
  };
  const closeForm = () => {
    if (form) setDismissed(form.trigger.start); // the typed `/…` stays; don't reopen the list over it
    setForm(null);
    requestAnimationFrame(() => ta.current?.focus());
  };
  const submitForm = () => {
    if (!form || form.busy) return;
    const missing = form.prompt.arguments.filter((a) => a.required && !form.values[a.name]?.trim()).map((a) => a.title || a.name);
    if (missing.length) return toast(`请填写：${missing.join('、')}`, 'warn');
    setForm({ ...form, busy: true });
    void runPrompt(form.prompt, form.trigger, form.values);
  };

  const track = (el: HTMLTextAreaElement, f?: boolean) => {
    setCaret(el.selectionStart ?? el.value.length);
    if (f !== undefined) setFocused(f);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!shown || e.nativeEvent.isComposing) return false;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setSel((cur + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length);
      return true;
    }
    if ((e.key === 'Enter' && !e.metaKey && !e.ctrlKey && !e.shiftKey) || e.key === 'Tab') {
      e.preventDefault();
      choose(items[cur]);
      return true;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      setDismissed(trig!.start);
      return true;
    }
    return false;
  };

  let popup: ReactNode = null;
  if (form) {
    const p = form.prompt;
    popup = (
      <div className="mcp-pick form" data-testid="mcp-prompt-form" onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); closeForm(); } }}>
        <div className="mcp-pick-h">
          <span className="slash">/</span><b>{p.title || p.name}</b><span className="srv">{p.server}</span>
          <span className="keys">{form.busy ? '读取中…' : '↵ 插入 · Esc 取消'}</span>
        </div>
        {p.description && <div className="mcp-pick-d">{p.description}</div>}
        {p.arguments.map((a, i) => (
          <label key={a.name} className="mcp-pick-arg">
            <span>{a.title || a.name}{a.required && <i> *</i>}</span>
            <input className="input" autoFocus={i === 0} value={form.values[a.name] ?? ''} placeholder={a.description ?? (a.required ? '必填' : '可选')} disabled={form.busy}
              onChange={(e) => setForm({ ...form, values: { ...form.values, [a.name]: e.target.value } })}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); submitForm(); } }} />
          </label>
        ))}
        {p.arguments.length > 0 && (
          <div className="mcp-pick-foot">
            <button className="btn sm" onClick={closeForm}>取消</button>
            <button className="btn sm primary" onClick={submitForm} disabled={form.busy} data-testid="mcp-prompt-insert">{form.busy ? '读取中…' : '插入'}</button>
          </div>
        )}
      </div>
    );
  } else if (shown && trig) {
    popup = (
      <div className="mcp-pick" role="listbox" aria-label={trig.kind === 'prompt' ? 'MCP 提示词' : 'MCP 资源'} data-testid={`mcp-pick-${trig.kind}`}>
        <div className="mcp-pick-h">
          <b>{trig.kind === 'prompt' ? 'MCP 提示词' : 'MCP 资源'}</b>
          <span className="sub">{trig.kind === 'prompt' ? '插入提示词内容' : '内容会附在旨意后交给官员'}</span>
          <span className="keys">↑↓ 选择 · ↵ 插入 · Esc 关闭</span>
        </div>
        <div className="mcp-pick-list" ref={listRef}>
          {items.map((it, i) => {
            const k = it.kind === 'prompt' ? `p:${it.p.server}/${it.p.name}` : `r:${it.r.server}/${it.r.uri}`;
            return (
              <div key={k} role="option" aria-selected={i === cur} className={`mcp-pick-i ${i === cur ? 'on' : ''}`} onMouseDown={(e) => { e.preventDefault(); choose(it); }} onMouseEnter={() => setSel(i)}>
                {it.kind === 'prompt' ? (
                  <>
                    <span className="slash">/</span>
                    <b>{it.p.title || it.p.name}</b>
                    <span className="srv">{it.p.server}</span>
                    {it.p.arguments.length > 0 && <span className="args">{it.p.arguments.map((a) => a.name + (a.required ? '*' : '')).join(' ')}</span>}
                    <span className="d">{it.p.description}</span>
                  </>
                ) : (
                  <>
                    <span className="at">@</span>
                    <b>{it.r.title || it.r.name}</b>
                    <span className="srv">{it.r.server}</span>
                    <span className="d mono">{it.r.uri}</span>
                  </>
                )}
              </div>
            );
          })}
        </div>
      </div>
    );
  }
  return { track, onKeyDown, popup };
}
