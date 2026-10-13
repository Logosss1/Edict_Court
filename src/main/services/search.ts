// web_search back ends: Brave Search, Tavily, a self-hosted SearXNG, or the search built into the model
// service (Anthropic Messages / OpenAI Responses official APIs). Keys travel only in request headers / bodies
// sent to that service and never appear in results, logs or the audit.
import type { SearchProviderKind } from '../../shared/types';
import { endpointFor, headersFor } from '../llm/adapters';
import type { FetchLike, ProviderRuntime } from '../llm/types';

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchResult {
  ok: boolean;
  hits: SearchHit[];
  /** the model's own summary (built-in model search only) */
  answer?: string;
  error?: string;
  ms: number;
}

export interface SearchCall {
  provider: SearchProviderKind;
  key?: string | null;
  /** SearXNG base URL */
  url?: string;
  /** built-in model search: the provider runtime (with key) and model id */
  model?: { runtime: ProviderRuntime; id: string };
  query: string;
  count?: number;
  fetchImpl: FetchLike;
  signal?: AbortSignal;
}

export const SEARCH_LABEL: Record<SearchProviderKind, string> = { brave: 'Brave Search', tavily: 'Tavily', searxng: 'SearXNG（自建）', model: '模型自带搜索' };
export const SEARCH_NEEDS_KEY: Record<SearchProviderKind, boolean> = { brave: true, tavily: true, searxng: false, model: false };

const clip = (s: unknown, n: number) => {
  const t = typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() : '';
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

async function json(res: Response, what: string): Promise<unknown> {
  const text = await res.text();
  if (!res.ok) {
    const hint = res.status === 401 || res.status === 403 ? '（Key 无效或没有权限）' : res.status === 429 ? '（额度用完或请求太频繁）' : '';
    throw new Error(`${what} 返回 HTTP ${res.status}${hint}：${clip(text, 200)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${what} 返回的不是 JSON：${clip(text, 120)}`);
  }
}

/** Search services mark the matched words with <strong> / <b>; officials get plain text. */
const plain = (s: unknown) => (typeof s === 'string' ? s.replace(/<\/?(strong|b|em|mark)>/gi, '') : s);
const hit = (title: unknown, url: unknown, snippet: unknown): SearchHit | null => (typeof url === 'string' && /^https?:\/\//i.test(url) ? { title: clip(plain(title), 200) || url, url, snippet: clip(plain(snippet), 400) } : null);

async function brave(c: SearchCall, n: number): Promise<Pick<SearchResult, 'hits'>> {
  const u = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(c.query)}&count=${n}`;
  const j = (await json(await c.fetchImpl(u, { method: 'GET', headers: { accept: 'application/json', 'x-subscription-token': c.key ?? '' }, signal: c.signal }), 'Brave Search')) as { web?: { results?: { title?: string; url?: string; description?: string }[] } };
  return { hits: (j.web?.results ?? []).map((r) => hit(r.title, r.url, r.description)).filter((h): h is SearchHit => !!h) };
}

async function tavily(c: SearchCall, n: number): Promise<Pick<SearchResult, 'hits' | 'answer'>> {
  const res = await c.fetchImpl('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${c.key ?? ''}` },
    body: JSON.stringify({ query: c.query, max_results: n, search_depth: 'basic' }),
    signal: c.signal,
  });
  const j = (await json(res, 'Tavily')) as { results?: { title?: string; url?: string; content?: string }[]; answer?: string };
  return { hits: (j.results ?? []).map((r) => hit(r.title, r.url, r.content)).filter((h): h is SearchHit => !!h), ...(j.answer ? { answer: clip(j.answer, 2000) } : {}) };
}

async function searxng(c: SearchCall, n: number): Promise<Pick<SearchResult, 'hits'>> {
  const base = (c.url ?? '').trim().replace(/\/+$/, '').replace(/\/search$/, '');
  if (!/^https?:\/\//i.test(base)) throw new Error('请先填写 SearXNG 的地址（如 https://search.example.com）');
  const res = await c.fetchImpl(`${base}/search?q=${encodeURIComponent(c.query)}&format=json`, { method: 'GET', headers: { accept: 'application/json' }, signal: c.signal });
  if (res.status === 403) throw new Error('SearXNG 拒绝了 JSON 格式：请在它的 settings.yml 的 search.formats 里加上 json');
  const j = (await json(res, 'SearXNG')) as { results?: { title?: string; url?: string; content?: string }[] };
  return { hits: (j.results ?? []).slice(0, n).map((r) => hit(r.title, r.url, r.content)).filter((h): h is SearchHit => !!h) };
}

/** The model service's own web search (server-side tool), one non-streaming call. */
async function modelSearch(c: SearchCall, n: number): Promise<Pick<SearchResult, 'hits' | 'answer'>> {
  if (!c.model) throw new Error('没有指定用哪个模型搜索');
  const p = c.model.runtime;
  const headers = { ...headersFor(p), accept: 'application/json' };
  const prompt = `Search the web for: ${c.query}\nReply with a short factual summary (in the language of the query) and cite your sources.`;
  if (p.config.protocol === 'anthropic-messages') {
    const body = { model: c.model.id, max_tokens: 1500, messages: [{ role: 'user', content: prompt }], tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 2 }] };
    const j = (await json(await c.fetchImpl(endpointFor(p), { method: 'POST', headers, body: JSON.stringify(body), signal: c.signal }), '模型服务')) as { content?: { type: string; text?: string; content?: unknown; citations?: { url?: string; title?: string; cited_text?: string }[] }[] };
    const hits: SearchHit[] = [];
    const seen = new Set<string>();
    const add = (h: SearchHit | null) => h && !seen.has(h.url) && (seen.add(h.url), hits.push(h));
    let answer = '';
    for (const b of j.content ?? []) {
      if (b.type === 'web_search_tool_result' && Array.isArray(b.content)) for (const r of b.content as { url?: string; title?: string; page_age?: string }[]) add(hit(r.title, r.url, r.page_age ? `（${r.page_age}）` : ''));
      if (b.type === 'text' && b.text) {
        answer += b.text;
        for (const ci of b.citations ?? []) add(hit(ci.title, ci.url, ci.cited_text));
      }
    }
    if (!hits.length && !answer.trim()) throw new Error('模型服务没有返回搜索结果（这个服务或模型可能不支持自带搜索）');
    return { hits: hits.slice(0, n), answer: clip(answer, 3000) };
  }
  if (p.config.protocol === 'openai-responses') {
    const call = (type: string) => c.fetchImpl(endpointFor(p), { method: 'POST', headers, body: JSON.stringify({ model: c.model!.id, input: prompt, tools: [{ type }] }), signal: c.signal });
    let res = await call('web_search');
    if (res.status === 400) {
      const text = await res.clone().text();
      if (/web_search/i.test(text)) res = await call('web_search_preview');
    }
    const j = (await json(res, '模型服务')) as { output?: { type: string; content?: { type: string; text?: string; annotations?: { type: string; url?: string; title?: string }[] }[] }[] };
    const hits: SearchHit[] = [];
    const seen = new Set<string>();
    let answer = '';
    for (const o of j.output ?? []) {
      if (o.type !== 'message') continue;
      for (const part of o.content ?? []) {
        if (part.text) answer += part.text;
        for (const a of part.annotations ?? []) {
          const h = a.type === 'url_citation' ? hit(a.title, a.url, '') : null;
          if (h && !seen.has(h.url)) {
            seen.add(h.url);
            hits.push(h);
          }
        }
      }
    }
    if (!hits.length && !answer.trim()) throw new Error('模型服务没有返回搜索结果（这个服务或模型可能不支持自带搜索）');
    return { hits: hits.slice(0, n), answer: clip(answer, 3000) };
  }
  throw new Error('模型自带搜索只支持 Anthropic Messages 与 OpenAI Responses 协议的服务');
}

export async function webSearch(c: SearchCall): Promise<SearchResult> {
  const started = Date.now();
  const n = Math.min(10, Math.max(1, c.count ?? 6));
  if (!c.query.trim()) return { ok: false, hits: [], error: '搜索词为空', ms: 0 };
  if (SEARCH_NEEDS_KEY[c.provider] && !c.key) return { ok: false, hits: [], error: `${SEARCH_LABEL[c.provider]} 还没有填 Key`, ms: 0 };
  try {
    const r = c.provider === 'brave' ? await brave(c, n) : c.provider === 'tavily' ? await tavily(c, n) : c.provider === 'searxng' ? await searxng(c, n) : await modelSearch(c, n);
    return { ok: true, ...r, ms: Date.now() - started };
  } catch (e) {
    return { ok: false, hits: [], error: c.signal?.aborted ? '已停止' : (e as Error).message, ms: Date.now() - started };
  }
}

/** Search results as tool output: numbered title, URL and snippet, then the summary if any. */
export function formatHits(query: string, r: SearchResult): string {
  const lines = [`搜索「${query}」：${r.hits.length} 条结果`];
  r.hits.forEach((h, i) => lines.push(`${i + 1}. ${h.title}\n   ${h.url}${h.snippet ? `\n   ${h.snippet}` : ''}`));
  if (r.answer) lines.push(`\n搜索服务给出的摘要：\n${r.answer}`);
  lines.push('\n要看某条的全文，用 web_fetch 打开它的网址。');
  return lines.join('\n');
}
