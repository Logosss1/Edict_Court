// Minimal Server-Sent-Events reader over a WHATWG ReadableStream with idle timeout.

export interface SseEvent {
  event: string;
  data: string;
}

export async function* readSse(body: ReadableStream<Uint8Array>, opts: { idleTimeoutMs?: number; signal?: AbortSignal } = {}): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const idle = opts.idleTimeoutMs ?? 90_000;
  try {
    while (true) {
      if (opts.signal?.aborted) throw new DOMException('aborted', 'AbortError');
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_, rej) => {
        timer = setTimeout(() => rej(new Error(`流式响应空闲超时（${Math.round(idle / 1000)}s 无数据）`)), idle);
      });
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await Promise.race([reader.read(), timeout]);
      } finally {
        clearTimeout(timer);
      }
      if (chunk.done) break;
      buf += decoder.decode(chunk.value, { stream: true });
      buf = buf.replace(/\r\n/g, '\n');
      let idx: number;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const ev = parseBlock(raw);
        if (ev) yield ev;
      }
    }
    if (buf.trim()) {
      const ev = parseBlock(buf);
      if (ev) yield ev;
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* ignore */
    }
  }
}

function parseBlock(raw: string): SseEvent | null {
  let event = 'message';
  const data: string[] = [];
  for (const line of raw.split('\n')) {
    if (!line || line.startsWith(':')) continue;
    const i = line.indexOf(':');
    const field = i < 0 ? line : line.slice(0, i);
    let value = i < 0 ? '' : line.slice(i + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  }
  if (!data.length) return null;
  return { event, data: data.join('\n') };
}
