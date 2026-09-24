import { createHash, randomBytes } from 'node:crypto';
import type { Usage } from '../../shared/types';

export const sha256 = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');

export const uid = (prefix = ''): string => `${prefix}${Date.now().toString(36)}${randomBytes(4).toString('hex')}`;

export const now = (): number => Date.now();

export function ymd(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

export function addUsage(a: Usage, b: Partial<Usage>): Usage {
  return {
    inputTokens: a.inputTokens + (b.inputTokens ?? 0),
    outputTokens: a.outputTokens + (b.outputTokens ?? 0),
    cachedTokens: a.cachedTokens + (b.cachedTokens ?? 0),
    costUsd: +(a.costUsd + (b.costUsd ?? 0)).toFixed(6),
    calls: a.calls + (b.calls ?? 0),
    estimated: a.estimated || b.estimated,
  };
}

/** Rough token estimate: CJK chars ≈ 1 token each, other text ≈ 4 chars/token. */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    if (c >= 0x2e80 && c <= 0x9fff) cjk++;
  }
  const rest = text.length - cjk;
  return Math.ceil(cjk * 1.0 + rest / 4);
}

export function truncate(s: string, max: number, note = '…[已截断]'): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n${note}（原长 ${s.length} 字符）`;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Extract the first JSON object/array from a model reply (handles ```json fences and chatter). */
export function extractJson<T = unknown>(text: string): T | null {
  if (!text) return null;
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates: string[] = [];
  if (fence) candidates.push(fence[1]);
  candidates.push(text);
  for (const c of candidates) {
    const start = c.search(/[[{]/);
    if (start < 0) continue;
    const open = c[start];
    const close = open === '{' ? '}' : ']';
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < c.length; i++) {
      const ch = c[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === open) depth++;
      else if (ch === close) {
        depth--;
        if (depth === 0) {
          const slice = c.slice(start, i + 1);
          try {
            return JSON.parse(slice) as T;
          } catch {
            try {
              // tolerate trailing commas
              return JSON.parse(slice.replace(/,\s*([}\]])/g, '$1')) as T;
            } catch {
              break;
            }
          }
        }
      }
    }
  }
  return null;
}

export function redactSecrets(s: string): string {
  return s
    .replace(/(sk-[A-Za-z0-9_\-]{8})[A-Za-z0-9_\-]+/g, '$1***')
    .replace(/(Bearer\s+)[A-Za-z0-9._\-]+/gi, '$1***')
    .replace(/(x-api-key["']?\s*[:=]\s*["']?)[^"'\s,}]+/gi, '$1***')
    .replace(/(api[_-]?key["']?\s*[:=]\s*["']?)[^"'\s,}]+/gi, '$1***');
}
