// Tiny, safe Markdown renderer (escapes HTML; supports headings, lists, code, bold, links).
import { useMemo } from 'react';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function inline(s: string) {
  let out = esc(s);
  out = out.replace(/`([^`]+)`/g, '<code>$1</code>');
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
  return out;
}

export function mdToHtml(md: string): string {
  const lines = (md ?? '').replace(/\r/g, '').split('\n');
  const out: string[] = [];
  let i = 0;
  let list: 'ul' | 'ol' | null = null;
  const closeList = () => {
    if (list) out.push(`</${list}>`);
    list = null;
  };
  while (i < lines.length) {
    const l = lines[i];
    const fence = l.match(/^```(\w*)/);
    if (fence) {
      closeList();
      const buf: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) buf.push(lines[i++]);
      out.push(`<pre class="md-code"><code>${esc(buf.join('\n'))}</code></pre>`);
      i++;
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(l)) {
      closeList();
      const rows: string[][] = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
        const cells = lines[i].trim().slice(1, -1).split('|').map((c) => c.trim());
        if (!cells.every((c) => /^:?-{2,}:?$/.test(c))) rows.push(cells);
        i++;
      }
      const [head, ...body] = rows;
      out.push(`<table class="md-table"><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
      continue;
    }
    const h = l.match(/^(#{1,4})\s+(.*)/);
    if (h) {
      closeList();
      out.push(`<h${h[1].length + 1}>${inline(h[2])}</h${h[1].length + 1}>`);
    } else if (/^\s*[-*]\s+/.test(l)) {
      if (list !== 'ul') {
        closeList();
        out.push('<ul>');
        list = 'ul';
      }
      out.push(`<li>${inline(l.replace(/^\s*[-*]\s+/, ''))}</li>`);
    } else if (/^\s*\d+[.)]\s+/.test(l)) {
      if (list !== 'ol') {
        closeList();
        out.push('<ol>');
        list = 'ol';
      }
      out.push(`<li>${inline(l.replace(/^\s*\d+[.)]\s+/, ''))}</li>`);
    } else if (/^>\s?/.test(l)) {
      closeList();
      out.push(`<blockquote>${inline(l.replace(/^>\s?/, ''))}</blockquote>`);
    } else if (!l.trim()) {
      closeList();
    } else {
      closeList();
      out.push(`<p>${inline(l)}</p>`);
    }
    i++;
  }
  closeList();
  return out.join('\n');
}

export function Markdown({ text, className }: { text: string; className?: string }) {
  const html = useMemo(() => mdToHtml(text), [text]);
  return <div className={`md ${className ?? ''}`} dangerouslySetInnerHTML={{ __html: html }} />;
}
