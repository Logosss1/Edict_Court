// web_fetch: download one public web page and turn it into plain text for an official.
// Only http(s) to public addresses: loopback, private and link-local networks are refused (local pages
// belong to preview_page), and every redirect hop is checked again. Size, time and redirects are capped.
import dns from 'node:dns';
import net from 'node:net';
import type { FetchLike } from '../llm/types';

export const WEB_LIMITS = { maxBytes: 2 * 1024 * 1024, maxChars: 20_000, maxRedirects: 5, timeoutMs: 20_000 };

export type Lookup = (host: string) => Promise<string[]>;
const defaultLookup: Lookup = async (host) => (await dns.promises.lookup(host, { all: true, verbatim: true })).map((a) => a.address);

export interface WebFetchResult {
  ok: boolean;
  /** final URL after redirects */
  url: string;
  status: number;
  contentType: string;
  title: string;
  text: string;
  bytes: number;
  /** body cut at maxBytes, or text cut at maxChars */
  truncated: boolean;
  ms: number;
  error?: string;
}

/** Loopback, private, link-local, CGNAT, multicast and reserved addresses (IPv4 and IPv6, mapped forms too). */
export function isPrivateAddress(ip: string): boolean {
  const v = net.isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT / tailnets
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 192 && b === 0 && ip.split('.')[2] === '0') return true;
    if (a >= 224) return true; // multicast, reserved, broadcast
    return false; // 198.18/15 stays allowed: proxy tools hand out fake IPs from it for every domain
  }
  if (v === 6) {
    const s = ip.toLowerCase().replace(/^\[|\]$/g, '');
    if (s === '::' || s === '::1') return true;
    const mapped = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]);
    const head = parseInt(s.split(':')[0] || '0', 16);
    if ((head & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
    if ((head & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
    if ((head & 0xff00) === 0xff00) return true; // multicast
    return false;
  }
  return true; // not an address at all: refuse
}

/** Is `raw` a public http(s) URL? Resolves the host and refuses private targets. */
export async function checkPublicUrl(raw: string, lookup: Lookup = defaultLookup): Promise<{ ok: true; url: URL } | { ok: false; reason: string }> {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return { ok: false, reason: `不是合法的网址：${raw.slice(0, 200)}` };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, reason: `只能抓取 http / https 网页：${u.protocol}` };
  if (u.username || u.password) return { ok: false, reason: '网址里不能带用户名或密码' };
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host) return { ok: false, reason: '网址缺少域名' };
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return { ok: false, reason: `不能抓取本机或内网地址：${host}（本机页面请用 preview_page）` };
  if (net.isIP(host)) {
    return isPrivateAddress(host) ? { ok: false, reason: `不能抓取本机或内网地址：${host}（本机页面请用 preview_page）` } : { ok: true, url: u };
  }
  let addrs: string[];
  try {
    addrs = await lookup(host);
  } catch (e) {
    return { ok: false, reason: `无法解析域名 ${host}：${(e as NodeJS.ErrnoException).code ?? (e as Error).message}` };
  }
  if (!addrs.length) return { ok: false, reason: `无法解析域名 ${host}` };
  const bad = addrs.find(isPrivateAddress);
  if (bad) return { ok: false, reason: `${host} 指向本机或内网地址 ${bad}，不能抓取` };
  return { ok: true, url: u };
}

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', copy: '©', reg: '®', trade: '™',
  laquo: '«', raquo: '»', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', middot: '·', bull: '•', times: '×', divide: '÷', deg: '°',
  larr: '←', rarr: '→', uarr: '↑', darr: '↓', para: '¶', sect: '§', euro: '€', pound: '£', yen: '¥', cent: '¢', zwj: '', zwnj: '', shy: '',
};
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

const stripTags = (s: string) => decodeEntities(s.replace(/<[^>]*>/g, ''));

/** The biggest <main> / <article> (by length) if the page has one, else <body>, else the whole document. */
function contentRegion(html: string): string {
  const blocks: string[] = [];
  for (const tag of ['main', 'article']) {
    const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'gi');
    for (const m of html.matchAll(re)) blocks.push(m[1]);
  }
  const best = blocks.sort((a, b) => stripTags(b).trim().length - stripTags(a).trim().length)[0];
  if (best && stripTags(best).trim().length > 200) return best;
  const body = html.match(/<body\b[^>]*>([\s\S]*)<\/body>/i);
  return body ? body[1] : html;
}

/** HTML → title + readable Markdown-ish text: headings, lists, code blocks, tables and absolute links kept. */
export function htmlToText(html: string, baseUrl?: string): { title: string; text: string } {
  const title = stripTags(html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '').replace(/\s+/g, ' ').trim();
  let s = html.replace(/<!--[\s\S]*?-->/g, '');
  s = s.replace(/<(script|style|noscript|svg|template|iframe|object|canvas|head)\b[\s\S]*?<\/\1>/gi, '');
  s = contentRegion(s);
  s = s.replace(/<(nav|footer|aside|form|button|select)\b[\s\S]*?<\/\1>/gi, '');
  // code blocks keep their whitespace: park them, convert the rest, put them back
  const pres: string[] = [];
  s = s.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_m, inner: string) => {
    pres.push(stripTags(inner.replace(/<br\s*\/?>/gi, '\n')).replace(/^\n+|\s+$/g, ''));
    return `\n\n\u0000PRE${pres.length - 1}\u0000\n\n`;
  });
  s = s.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, n: string, inner: string) => `\n\n${'#'.repeat(Number(n))} ${stripTags(inner).replace(/\s+/g, ' ').trim()}\n\n`);
  s = s.replace(/<a\b[^>]*?href\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi, (_m, _q, d1?: string, d2?: string, d3?: string, inner = '') => {
    const text = stripTags(inner).replace(/\s+/g, ' ').trim();
    const href = decodeEntities(d1 ?? d2 ?? d3 ?? '').trim();
    if (!text) return '';
    let abs = '';
    try {
      abs = new URL(href, baseUrl).href;
    } catch {
      /* not a link we can follow */
    }
    const bare = (x: string) => x.replace(/\/+$/, '');
    return /^https?:/i.test(abs) && bare(abs) !== bare(text) ? `[${text}](${abs})` : text;
  });
  s = s.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_m, inner: string) => {
    const t = stripTags(inner);
    return t.includes('\n') ? t : `\`${t}\``;
  });
  s = s.replace(/<li\b[^>]*>/gi, '\n- ');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/?(t[dh])\b[^>]*>/gi, ' | ');
  s = s.replace(/<\/?(p|div|section|tr|table|thead|tbody|ul|ol|dl|dt|dd|blockquote|figure|figcaption|header|hr)\b[^>]*>/gi, '\n\n');
  s = stripTags(s);
  s = s
    .replace(/[ \t\f\v ]+/g, ' ')
    .split('\n')
    .map((l) => l.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  s = s.replace(/\u0000PRE(\d+)\u0000/g, (_m, i: string) => `\`\`\`\n${pres[Number(i)]}\n\`\`\``);
  return { title, text: s };
}

function charsetOf(contentType: string, head: Buffer): string {
  const fromHeader = contentType.match(/charset\s*=\s*"?([\w-]+)/i)?.[1];
  if (fromHeader) return fromHeader.toLowerCase();
  const sniff = head.subarray(0, 4096).toString('latin1');
  return (sniff.match(/<meta[^>]+charset\s*=\s*["']?([\w-]+)/i)?.[1] ?? 'utf-8').toLowerCase();
}

function decode(buf: Buffer, charset: string): string {
  try {
    return new TextDecoder(charset).decode(buf);
  } catch {
    return new TextDecoder('utf-8').decode(buf);
  }
}

const HEADERS = {
  accept: 'text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.5',
  'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
  'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Edict',
};

const isHtml = (ct: string) => /text\/html|application\/xhtml\+xml/i.test(ct);
const isText = (ct: string) => !ct || /^text\/|application\/(json|xml|javascript|x-javascript|ld\+json|rss\+xml|atom\+xml|x-yaml|yaml|toml)|[+/](json|xml)\b/i.test(ct);

async function readCapped(res: Response, maxBytes: number): Promise<{ buf: Buffer; truncated: boolean }> {
  if (!res.body) return { buf: Buffer.from(await res.arrayBuffer()).subarray(0, maxBytes), truncated: false };
  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(Buffer.from(value));
    size += value.byteLength;
    if (size > maxBytes) {
      truncated = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
  }
  return { buf: Buffer.concat(chunks).subarray(0, maxBytes), truncated };
}

/** Fetch one public page (redirects followed by hand, each hop checked) and return its text. */
export async function webFetch(raw: string, deps: { fetchImpl: FetchLike; lookup?: Lookup }, o: { maxChars?: number; signal?: AbortSignal } = {}): Promise<WebFetchResult> {
  const started = Date.now();
  const maxChars = Math.min(60_000, Math.max(1000, o.maxChars ?? WEB_LIMITS.maxChars));
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), WEB_LIMITS.timeoutMs);
  const onAbort = () => ctl.abort();
  o.signal?.addEventListener('abort', onAbort, { once: true });
  const fail = (url: string, error: string, status = 0): WebFetchResult => ({ ok: false, url, status, contentType: '', title: '', text: '', bytes: 0, truncated: false, ms: Date.now() - started, error });
  let current = raw;
  try {
    for (let hop = 0; ; hop++) {
      let chk = await checkPublicUrl(current, deps.lookup);
      if (!chk.ok) return fail(current, chk.reason);
      const get = (redirect: RequestRedirect) => deps.fetchImpl(chk.ok ? chk.url.href : current, { method: 'GET', redirect, signal: ctl.signal, headers: HEADERS });
      let res = await get('manual');
      if (res.type === 'opaqueredirect' || res.status === 0) {
        // this fetch cannot hand back redirects: let it follow them, then check where it ended up
        res = await get('follow');
        if (res.url && res.url !== chk.url.href) {
          chk = await checkPublicUrl(res.url, deps.lookup);
          if (!chk.ok) {
            await res.body?.cancel().catch(() => undefined);
            return fail(res.url, chk.reason);
          }
        }
      } else if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        if (hop >= WEB_LIMITS.maxRedirects) return fail(chk.url.href, `跳转超过 ${WEB_LIMITS.maxRedirects} 次`, res.status);
        current = new URL(res.headers.get('location')!, chk.url).href;
        await res.body?.cancel().catch(() => undefined);
        continue;
      }
      const ct = (res.headers.get('content-type') ?? '').toLowerCase();
      if (!isHtml(ct) && !isText(ct)) {
        await res.body?.cancel().catch(() => undefined);
        return fail(chk.url.href, `不是文本网页（${ct.split(';')[0]}），无法转成文字`, res.status);
      }
      const { buf, truncated: cut } = await readCapped(res, WEB_LIMITS.maxBytes);
      const body = decode(buf, charsetOf(ct, buf));
      const { title, text } = isHtml(ct) || /^\s*<(!doctype html|html)\b/i.test(body) ? htmlToText(body, chk.url.href) : { title: '', text: body.trim() };
      const truncated = cut || text.length > maxChars;
      return {
        ok: res.ok,
        url: chk.url.href,
        status: res.status,
        contentType: ct.split(';')[0],
        title,
        text: text.length > maxChars ? text.slice(0, maxChars) : text,
        bytes: buf.length,
        truncated,
        ms: Date.now() - started,
        ...(res.ok ? {} : { error: `HTTP ${res.status}` }),
      };
    }
  } catch (e) {
    const timedOut = ctl.signal.aborted && !o.signal?.aborted;
    return fail(current, timedOut ? `${WEB_LIMITS.timeoutMs / 1000} 秒内没有取回网页` : o.signal?.aborted ? '已停止' : `抓取失败：${(e as Error).message}`);
  } finally {
    clearTimeout(timer);
    o.signal?.removeEventListener('abort', onAbort);
  }
}
