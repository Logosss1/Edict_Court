// 存储与备份: what the settings page shows about edict.db, and on-demand consistent copies of it in
// <dataDir>/backups/edict-<yyyymmdd-HHMMSS>.db (audit.jsonl, activity/ and blobs/ live next to it, untouched).
import fs from 'node:fs';
import path from 'node:path';
import type { StorageBackup, StorageInfo } from '../../shared/types';
import type { Runtime } from './runtime';

export const BACKUP_DIR = 'backups';
const BACKUP_NAME = /^edict-\d{8}-\d{6}(-\d{1,3})?\.db$/;
const IMPORT_BACKUP = /^backup-1\.x-\d{8}-\d{6}(-\d{1,4})?$/;

const pad = (n: number) => String(n).padStart(2, '0');
const stamp = (d: Date) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;

function sizeOf(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

/** Backups in <dataDir>/backups, newest first (only files named like ours). */
export function listBackups(dataDir: string): StorageBackup[] {
  const dir = path.join(dataDir, BACKUP_DIR);
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: StorageBackup[] = [];
  for (const name of names) {
    if (!BACKUP_NAME.test(name)) continue;
    try {
      const st = fs.statSync(path.join(dir, name));
      if (st.isFile()) out.push({ name, at: Math.round(st.mtimeMs), bytes: st.size });
    } catch {
      /* vanished */
    }
  }
  return out.sort((a, b) => b.at - a.at || b.name.localeCompare(a.name));
}

export function storageInfo(rt: Runtime): StorageInfo {
  const dbFile = rt.store.file;
  const importBackup = rt.store.getMeta('import_backup');
  return {
    dataDir: rt.opts.dataDir,
    dbFile,
    dbBytes: sizeOf(dbFile),
    walBytes: sizeOf(`${dbFile}-wal`),
    origin: rt.store.getMeta('origin') ?? '',
    ...(importBackup ? { importBackup } : {}),
    counts: rt.store.counts(),
    backups: listBackups(rt.opts.dataDir),
    encrypted: rt.opts.secrets.encrypted,
  };
}

/** Flush pending writes, then copy edict.db into backups/ (through a temp name, so a half-written copy is never listed). */
export function backupNow(rt: Runtime, when = new Date()): StorageBackup {
  rt.flushAll();
  const dir = path.join(rt.opts.dataDir, BACKUP_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const base = `edict-${stamp(when)}`;
  let name = `${base}.db`;
  for (let i = 2; fs.existsSync(path.join(dir, name)); i++) name = `${base}-${i}.db`;
  const file = path.join(dir, name);
  const tmp = path.join(dir, `.${name}.tmp`);
  fs.rmSync(tmp, { force: true });
  try {
    rt.store.backupTo(tmp);
    fs.renameSync(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    rt.audit.record('emperor', 'storage_backup_failed', { error: (e as Error).message });
    throw new Error(`备份失败：${(e as Error).message}`);
  }
  const bytes = sizeOf(file);
  rt.audit.record('emperor', 'storage_backup', { name, bytes });
  return { name, at: when.getTime(), bytes };
}

/**
 * Absolute path of a backup by name: one of ours in backups/, or the backup-1.x-<stamp> folder made by the 1.x import.
 * Anything else (`../x`, other files) is refused.
 */
export function backupPath(rt: Runtime, name: string): string {
  if (typeof name !== 'string' || !(BACKUP_NAME.test(name) || IMPORT_BACKUP.test(name))) throw new Error('无效的备份名');
  const file = BACKUP_NAME.test(name) ? path.join(rt.opts.dataDir, BACKUP_DIR, name) : path.join(rt.opts.dataDir, name);
  if (!fs.existsSync(file)) throw new Error('备份不存在（可能已被移走）');
  return file;
}
