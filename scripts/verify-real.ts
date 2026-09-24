// REAL-MODEL verification (run on your machine with your own key — never commit keys).
//
//   EDICT_BASE_URL=https://api.deepseek.com EDICT_API_KEY=sk-... EDICT_MODEL=deepseek-chat \
//   EDICT_PROTOCOL=openai-chat EDICT_TIER=lite npx tsx scripts/verify-real.ts
//
// Runs the same runtime the app uses (headless), issues a small coding edict into a temp
// workspace, auto-approves gates (and denies high-risk commands), then checks REAL artifacts.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Runtime, type SecretStore } from '../src/main/runtime/runtime';
import { installOrchestrator, submit, decideGate } from '../src/main/runtime/orchestrator';
import { loadSkills } from '../src/main/runtime/extras';
import type { Protocol, Tier } from '../src/shared/types';

const env = (k: string, d?: string) => {
  const v = process.env[k] ?? d;
  if (v === undefined) throw new Error(`missing env ${k}`);
  return v;
};
class Mem implements SecretStore {
  m = new Map<string, string>();
  encrypted = false;
  get(k: string) { return this.m.get(k) ?? null; }
  set(k: string, v: string) { this.m.set(k, v); }
  delete(k: string) { this.m.delete(k); }
}

(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'edict-real-data-'));
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'edict-real-ws-'));
  const rt = new Runtime({ dataDir, fetchImpl: (u, i) => fetch(u, i), secrets: new Mem(), version: 'verify-real', platform: process.platform, resourcesDir: process.cwd() });
  installOrchestrator(rt);
  loadSkills(rt);
  rt.updateSettings({ permissionMode: 'auto', finalGate: true });
  const model = env('EDICT_MODEL');
  rt.upsertProvider({ id: 'real', name: 'real', preset: 'custom', protocol: env('EDICT_PROTOCOL', 'openai-chat') as Protocol, baseUrl: env('EDICT_BASE_URL'), enabled: true, models: [{ id: model, inputPrice: 0, outputPrice: 0, contextWindow: 64000 }] }, env('EDICT_API_KEY'));
  rt.setWorkspace(ws);
  rt.on((e) => {
    if (e.type === 'activity' && !e.activity.streaming && ['state', 'gate', 'error', 'tool_call'].includes(e.activity.kind)) console.log(`[${e.activity.kind}] ${e.activity.agentId ?? ''} ${e.activity.content.slice(0, 160)}`);
    if (e.type === 'approval' && e.approval.status === 'pending') {
      console.log(`[approval] ${e.approval.risk} ${e.approval.summary} → ${e.approval.risk === 'high' ? 'DENY' : 'APPROVE'}`);
      rt.decideApproval(e.approval.id, e.approval.risk !== 'high');
    }
  });
  const tier = env('EDICT_TIER', 'lite') as Tier;
  const r = await submit(rt, { text: '在工作区创建 greet.js，导出 greet(name) 返回 "Hello, <name>"；再创建 greet.test.js 用 node 自带 assert 测试它，并运行 node greet.test.js 验证。', tier, multiAgent: tier !== 'solo', forceEdict: true });
  if (r.kind !== 'task') throw new Error('expected a task');
  const id = r.taskId;
  const deadline = Date.now() + 15 * 60_000;
  while (Date.now() < deadline) {
    const t = rt.tasks.get(id)!;
    if (t.gate) {
      console.log(`[gate] ${t.gate.kind} → approve`);
      decideGate(rt, id, { approve: true, comment: 'verify-real auto approve' });
    }
    if (['Done', 'Cancelled', 'Blocked'].includes(t.state)) break;
    await new Promise((res) => setTimeout(res, 1000));
  }
  const t = rt.tasks.get(id)!;
  const greet = path.join(ws, 'greet.js');
  const report = {
    state: t.state, blockedReason: t.blockedReason, usage: t.usage, rejections: t.reviews.filter((x) => x.verdict === 'reject').length,
    artifacts: fs.existsSync(greet), nodes: t.nodes.map((n) => `${n.id}:${n.status}:${n.model}:${n.runId}`), audit: rt.audit.verify(),
  };
  console.log(JSON.stringify(report, null, 2));
  rt.dispose();
  process.exit(t.state === 'Done' && report.artifacts ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
