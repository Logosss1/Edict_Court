import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Runtime, type SecretStore } from '../src/main/runtime/runtime';
import { installOrchestrator } from '../src/main/runtime/orchestrator';
import { loadSkills } from '../src/main/runtime/extras';
import type { Protocol, Task } from '../src/shared/types';

export class MemorySecrets implements SecretStore {
  m = new Map<string, string>();
  encrypted = false;
  get(id: string) {
    return this.m.get(id) ?? null;
  }
  set(id: string, v: string) {
    this.m.set(id, v);
  }
  delete(id: string) {
    this.m.delete(id);
  }
}

export function tmpDir(prefix: string) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function makeRuntime(mockUrl: string, protocol: Protocol = 'openai-chat', dataDir = tmpDir('edict-data-')) {
  const rt = new Runtime({ dataDir, fetchImpl: (u, i) => fetch(u, i), secrets: new MemorySecrets(), version: 'test', platform: process.platform, resourcesDir: process.cwd() });
  installOrchestrator(rt);
  loadSkills(rt);
  rt.updateSettings({ permissionMode: 'auto' });
  const base = protocol === 'anthropic-messages' ? mockUrl.replace(/\/v1$/, '') : mockUrl;
  rt.upsertProvider({ id: 'mock', name: 'Mock', preset: 'custom', protocol, baseUrl: base, enabled: true, models: [ { id: 'mock-strong', inputPrice: 3, outputPrice: 15, contextWindow: 128000 }, { id: 'mock-economy', inputPrice: 0.2, outputPrice: 0.8, contextWindow: 128000 } ] }, 'sk-test-SECRET-123456789');
  return rt;
}

export async function waitFor<T>(fn: () => T | undefined | false, timeoutMs = 15000, label = 'condition'): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`waitFor timeout: ${label}`);
}

export const stateOf = (rt: Runtime, id: string) => (rt.tasks.get(id) as Task).state;
