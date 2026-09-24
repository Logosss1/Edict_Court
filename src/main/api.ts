// Whitelisted API surface exposed to the renderer through a single IPC channel.
import { dialog, shell, type BrowserWindow } from 'electron';
import type { AgentId, Plan, ProviderConfig, Settings, Tier, ModelRef } from '../shared/types';
import type { Runtime } from './runtime/runtime';
import { submit, decideGate, retryNode, unblock, type SubmitInput } from './runtime/orchestrator';
import { createDebate, runDebate, interject, pauseDebate, concludeDebate } from './runtime/debate';
import { readSkill, saveSkill, addRemoteSkill, removeSkill, refreshNews } from './runtime/extras';
import { gitStatus, gitShowHead, gitStage, gitUnstage, gitCommit, gitLog, gitInit } from './services/git';
import type { TerminalManager } from './services/terminal';
import { PERMISSION_LABEL } from './runtime/permissions';

export function buildApi(rt: Runtime, terminals: TerminalManager, host: { openFolderDialog: () => Promise<string | null>; getWindow: () => BrowserWindow | null }) {
  const ws = () => rt.requireWorkspace();
  return {
    // ── state
    snapshot: () => rt.snapshot(),
    activities: (taskId?: string, limit?: number) => rt.activities(taskId, limit),
    info: () => ({ dataDir: rt.opts.dataDir, encrypted: rt.opts.secrets.encrypted, version: rt.opts.version, platform: rt.opts.platform, permissionLabels: PERMISSION_LABEL }),

    // ── edicts & control
    submit: (input: SubmitInput) => submit(rt, input),
    estimate: (text: string, tier: Tier, model?: ModelRef | null) => rt.estimate(text, tier, model),
    pause: (id: string) => rt.pause(id),
    resume: (id: string) => rt.resume(id),
    cancel: (id: string, reason?: string) => rt.cancel(id, reason),
    retryNode: (id: string, nodeId: string) => retryNode(rt, id, nodeId),
    unblock: (id: string) => unblock(rt, id),
    decideGate: (id: string, d: { approve: boolean; comment?: string; plan?: Plan; reworkTargets?: string[] }) => decideGate(rt, id, d),
    decideApproval: (id: string, approve: boolean) => rt.decideApproval(id, approve),
    annotate: (agentId: AgentId, text: string, taskId?: string) => rt.annotate(agentId, text, taskId),
    revertChange: (taskId: string, changeId: string, force?: boolean) => rt.revertChange(taskId, changeId, force),
    blob: (hash: string) => rt.blobs.get(hash)?.toString('utf8') ?? null,
    memorialMarkdown: (taskId: string) => rt.memorialMarkdown(taskId),
    deleteTask: (id: string) => {
      const t = rt.getTask(id);
      if (!['Done', 'Cancelled'].includes(t.state)) throw new Error('只能删除已结案的旨意（奏折阁中的记录会保留）');
      rt.tasks.delete(id);
      rt.audit.record('emperor', 'task_removed_from_board', {}, id);
      rt.emit({ type: 'task_removed', id });
      rt.persist();
    },

    // ── debate (朝堂议政)
    debateCreate: (topic: string, participants?: AgentId[], maxRounds?: number) => createDebate(rt, { topic, participants, maxRounds }),
    debateRun: (id: string, extra?: number) => {
      void runDebate(rt, id, extra).catch((e) => rt.toast('error', `议政失败：${(e as Error).message}`));
    },
    debateInterject: (id: string, text: string) => interject(rt, id, text),
    debatePause: (id: string) => pauseDebate(rt, id),
    debateConclude: (id: string) => concludeDebate(rt, id),
    debateDelete: (id: string) => {
      rt.debates.delete(id);
      rt.persist();
    },

    // ── settings / models
    updateSettings: (patch: Partial<Settings>) => rt.updateSettings(patch),
    setAgentModel: (agentId: AgentId, ref: ModelRef | null) => rt.setAgentModel(agentId, ref),
    upsertProvider: (cfg: ProviderConfig, apiKey?: string | null) => rt.upsertProvider(cfg, apiKey),
    deleteProvider: (id: string) => rt.deleteProvider(id),
    testProvider: (id: string, model: string) => rt.testProvider(id, model),
    fetchModels: (id: string) => rt.fetchModels(id),
    presets: () => rt.presets(),

    // ── skills / news / audit
    skillRead: (name: string) => readSkill(rt, name),
    skillSave: (o: { name: string; description: string; agents: AgentId[] | 'all'; content: string }) => saveSkill(rt, o),
    skillAddRemote: (o: { name: string; url: string; description: string; agents: AgentId[] | 'all' }) => addRemoteSkill(rt, o),
    skillRemove: (name: string) => removeSkill(rt, name),
    newsRefresh: () => refreshNews(rt),
    auditList: (taskId?: string, limit?: number) => rt.audit.list({ taskId, limit: limit ?? 500 }),
    auditVerify: () => rt.audit.verify(),

    // ── workspace & editor
    openFolder: () => host.openFolderDialog(),
    setWorkspace: (p: string) => rt.setWorkspace(p),
    tree: (p?: string) => ws().tree(p ?? '.'),
    readFile: (p: string) => ws().read(p),
    writeFile: (p: string, content: string) => {
      const w = ws();
      const existed = w.exists(p);
      w.write(p, content);
      rt.audit.record('emperor', 'human_file_save', { path: p, bytes: Buffer.byteLength(content), created: !existed });
      rt.emit({ type: 'fs_changed', paths: [p] });
    },
    createFile: (p: string) => {
      const w = ws();
      if (w.exists(p)) throw new Error('文件已存在');
      w.write(p, '');
      rt.emit({ type: 'fs_changed', paths: [p] });
    },
    mkdir: (p: string) => {
      ws().mkdir(p);
      rt.emit({ type: 'fs_changed', paths: [p] });
    },
    rename: (a: string, b: string) => {
      ws().rename(a, b);
      rt.audit.record('emperor', 'human_file_rename', { from: a, to: b });
      rt.emit({ type: 'fs_changed', paths: [a, b] });
    },
    deleteFile: async (p: string) => {
      const win = host.getWindow();
      const r = await dialog.showMessageBox(win!, { type: 'warning', message: `确定删除 ${p}？`, detail: '此操作不可撤销（不经过废纸篓）。', buttons: ['取消', '删除'], defaultId: 0, cancelId: 0 });
      if (r.response !== 1) return false;
      ws().remove(p);
      rt.audit.record('emperor', 'human_file_delete', { path: p });
      rt.emit({ type: 'fs_changed', paths: [p] });
      return true;
    },
    search: (q: string, o: { regex?: boolean; caseSensitive?: boolean; wholeWord?: boolean; include?: string }) => ws().search(q, { ...o, maxResults: 3000 }),
    replaceAll: (q: string, r: string, o: { regex?: boolean; caseSensitive?: boolean; wholeWord?: boolean; include?: string }) => {
      const changed = ws().replaceAll(q, r, o);
      rt.audit.record('emperor', 'human_replace_all', { query: q, files: changed.map((c) => c.path), count: changed.reduce((n, c) => n + c.count, 0) });
      rt.emit({ type: 'fs_changed', paths: changed.map((c) => c.path) });
      return changed.map((c) => ({ path: c.path, count: c.count }));
    },
    listFiles: () => [...ws().walk(20000)],

    // ── git
    gitStatus: () => gitStatus(ws().root),
    gitHead: (p: string) => gitShowHead(ws().root, p),
    gitStage: (paths: string[]) => gitStage(ws().root, paths),
    gitUnstage: (paths: string[]) => gitUnstage(ws().root, paths),
    gitCommit: (msg: string) => gitCommit(ws().root, msg).then((r) => {
      rt.audit.record('emperor', 'git_commit', { message: msg, ok: r.code === 0 });
      return r;
    }),
    gitLog: () => gitLog(ws().root),
    gitInit: () => gitInit(ws().root),

    // ── terminal
    termCreate: (id: string, cols: number, rows: number) => terminals.create(id, rt.workspace?.root ?? process.env.HOME ?? '/', cols, rows),
    termWrite: (id: string, data: string) => terminals.write(id, data),
    termResize: (id: string, cols: number, rows: number) => terminals.resize(id, cols, rows),
    termKill: (id: string) => terminals.kill(id),

    // ── host
    confirm: async (message: string, detail?: string) => {
      const win = host.getWindow();
      const r = await dialog.showMessageBox(win!, { type: 'question', message, detail, buttons: ['取消', '确定'], defaultId: 1, cancelId: 0 });
      return r.response === 1;
    },
    openExternal: (url: string) => {
      if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    },
    revealInFinder: (p: string) => shell.showItemInFolder(ws().resolve(p)),
    openDataDir: () => shell.openPath(rt.opts.dataDir),
  };
}

export type Api = ReturnType<typeof buildApi>;
