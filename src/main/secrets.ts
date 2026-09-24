// API keys are encrypted with Electron safeStorage (macOS Keychain-backed) and stored in
// secrets.json. They never enter logs, audit records, git, or renderer memory.
import fs from 'node:fs';
import path from 'node:path';
import { safeStorage } from 'electron';
import type { SecretStore } from './runtime/runtime';

export class SafeStorageSecrets implements SecretStore {
  private file: string;
  private data: Record<string, { enc: boolean; v: string }> = {};
  readonly encrypted: boolean;

  constructor(dataDir: string) {
    this.file = path.join(dataDir, 'secrets.json');
    this.encrypted = safeStorage.isEncryptionAvailable();
    try {
      this.data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      this.data = {};
    }
  }

  private save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.data), { mode: 0o600 });
  }

  get(id: string): string | null {
    const e = this.data[id];
    if (!e) return null;
    try {
      return e.enc ? safeStorage.decryptString(Buffer.from(e.v, 'base64')) : Buffer.from(e.v, 'base64').toString('utf8');
    } catch {
      return null;
    }
  }

  set(id: string, value: string): void {
    this.data[id] = this.encrypted ? { enc: true, v: safeStorage.encryptString(value).toString('base64') } : { enc: false, v: Buffer.from(value).toString('base64') };
    this.save();
  }

  delete(id: string): void {
    delete this.data[id];
    this.save();
  }
}
