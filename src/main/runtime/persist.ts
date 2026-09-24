// Durable local storage for the runtime. Plain JSON + JSONL files under the
// app data dir. NOTE: local storage is NOT a security sandbox — see docs/SECURITY.md.
import fs from 'node:fs';
import path from 'node:path';
import type { AuditEntry } from '../../shared/types';
import { sha256 } from './util';

export class JsonFile<T> {
  private timer: NodeJS.Timeout | null = null;
  constructor(
    public file: string,
    private fallback: () => T,
  ) {}

  load(): T {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      return JSON.parse(raw) as T;
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code !== 'ENOENT') {
        // keep corrupt file for diagnosis instead of silently overwriting it
        try {
          fs.copyFileSync(this.file, `${this.file}.corrupt-${Date.now()}`);
        } catch {
          /* ignore */
        }
      }
      return this.fallback();
    }
  }

  saveNow(data: T): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 1));
    fs.renameSync(tmp, this.file);
  }

  saveDebounced(getData: () => T, ms = 250): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      try {
        this.saveNow(getData());
      } catch (e) {
        console.error('[persist] save failed', this.file, e);
      }
    }, ms);
  }

  flush(getData: () => T): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.saveNow(getData());
  }
}

export class JsonlLog<T> {
  constructor(public file: string) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  append(entry: T): void {
    fs.appendFileSync(this.file, JSON.stringify(entry) + '\n');
  }
  readAll(limit?: number): T[] {
    try {
      const lines = fs.readFileSync(this.file, 'utf8').split('\n').filter(Boolean);
      const sel = limit ? lines.slice(-limit) : lines;
      const out: T[] = [];
      for (const l of sel) {
        try {
          out.push(JSON.parse(l));
        } catch {
          /* skip torn line */
        }
      }
      return out;
    } catch {
      return [];
    }
  }
}

/** Append-only audit log with a SHA-256 hash chain (tamper evident). */
export class AuditLog {
  private log: JsonlLog<AuditEntry>;
  private lastHash = 'GENESIS';
  private seq = 0;
  private listeners: ((e: AuditEntry) => void)[] = [];

  constructor(file: string) {
    this.log = new JsonlLog<AuditEntry>(file);
    const all = this.log.readAll();
    const last = all[all.length - 1];
    if (last) {
      this.lastHash = last.hash;
      this.seq = last.seq;
    }
  }

  onEntry(fn: (e: AuditEntry) => void) {
    this.listeners.push(fn);
  }

  record(actor: string, action: string, detail: Record<string, unknown>, taskId?: string): AuditEntry {
    const base = { seq: this.seq + 1, at: Date.now(), actor, action, taskId, detail, prevHash: this.lastHash };
    const hash = sha256(JSON.stringify(base));
    const entry: AuditEntry = { ...base, hash };
    this.log.append(entry);
    this.seq = entry.seq;
    this.lastHash = hash;
    for (const l of this.listeners) l(entry);
    return entry;
  }

  list(filter?: { taskId?: string; limit?: number }): AuditEntry[] {
    let all = this.log.readAll();
    if (filter?.taskId) all = all.filter((e) => e.taskId === filter.taskId);
    if (filter?.limit) all = all.slice(-filter.limit);
    return all;
  }

  verify(): { ok: boolean; count: number; brokenAt?: number } {
    const all = this.log.readAll();
    let prev = 'GENESIS';
    for (const e of all) {
      const { hash, ...rest } = e;
      if (rest.prevHash !== prev || sha256(JSON.stringify(rest)) !== hash) return { ok: false, count: all.length, brokenAt: e.seq };
      prev = hash;
    }
    return { ok: true, count: all.length };
  }
}

/** Content-addressed blob store for file snapshots (before/after of agent edits). */
export class BlobStore {
  constructor(private dir: string) {
    fs.mkdirSync(dir, { recursive: true });
  }
  put(content: Buffer | string): string {
    const buf = typeof content === 'string' ? Buffer.from(content) : content;
    const h = sha256(buf);
    const p = path.join(this.dir, h.slice(0, 2), h);
    if (!fs.existsSync(p)) {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, buf);
    }
    return h;
  }
  get(hash: string): Buffer | null {
    if (!/^[a-f0-9]{64}$/.test(hash)) return null;
    try {
      return fs.readFileSync(path.join(this.dir, hash.slice(0, 2), hash));
    } catch {
      return null;
    }
  }
}
