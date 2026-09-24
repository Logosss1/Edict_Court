// Whitelisted API surface exposed to the renderer through a single IPC channel.
import { dialog, shell, type BrowserWindow } from 'electron';
import type { AgentId, Plan, ProviderConfig, Settings, Tier, ModelRef } from '../shared/types';
import type { Runtime } from './runtime/runtime';
import { previewUrlFor, isAllowedPreviewUrl } from './services/preview';
import { submit, decideGate, retryNode, retryNodeWithModel, unblock, type SubmitInput } from './runtime/orchestrator';
import { createDebate, runDebate, interject, pauseDebate, concludeDebate } from './runtime/debate';
import { readSkill, saveSkill, addRemoteSkill, removeSkill, refreshNews, setSkillEnabled, duplicateSkill, importSkillFolder } from './runtime/extras';
import { systemPromptFor } from './runtime/agentLoop';
import { parseMcpConfig } from './mcp/manager';
import type { McpServerPolicy, McpToolPolicy } from '../shared/types';
import fs from 'node:fs';
import path from 'node:path';
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
    retryNodeWithModel: (id: string, nodeId: string, ref: ModelRef) => retryNodeWithModel(rt, id, nodeId, ref),
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
    probeProvider: (id: string, model: string, level?: string) => rt.probeProvider(id, model, level),
    fetchModels: (id: string) => rt.fetchModels(id),
    presets: () => rt.presets(),

    // ── skills / news / audit
    skillRead: (name: string) => readSkill(rt, name),
    skillSave: (o: { name: string; description: string; agents: AgentId[] | 'all'; content: string; enabled?: boolean; originalName?: string }) => saveSkill(rt, o),
    skillSetEnabled: (name: string, enabled: boolean) => setSkillEnabled(rt, name, enabled),
    skillDuplicate: (name: string) => duplicateSkill(rt, name),
    skillImportFolder: async () => {
      const win = host.getWindow();
      const r = await dialog.showOpenDialog(win!, { title: '选择技能文件夹（包含 SKILL.md）', properties: ['openDirectory'] });
      if (r.canceled || !r.filePaths[0]) return null;
      return importSkillFolder(rt, r.filePaths[0]);
    },
    /** What an official actually sees: soul + skill index (full text is loaded on demand via load_skill). */
    skillAgentView: (agentId: AgentId) => ({ system: systemPromptFor(rt, agentId), mcpTools: rt.mcp.toolSpecsFor(agentId, false).map((t) => t.name) }),

    // ── MCP
    mcpList: () => rt.mcp.list(),
    mcpConfig: () => ({ text: rt.mcp.rawConfig(), path: rt.mcp.configPath }),
    mcpSave: async (text: string) => {
      const cfg = parseMcpConfig(text);
      const pending = rt.mcp.untrustedIn(cfg);
      let trust: string[] = [];
      if (pending.length) {
        const win = host.getWindow();
        const r = await dialog.showMessageBox(win!, {
          type: 'warning',
          message: `允许 Edict 在本机运行以下 ${pending.length} 个 MCP 服务命令？`,
          detail: `${pending.map((p) => `• ${p.name}：${p.commandLine}`).join('\n')}\n\n这些命令会以你的用户身份在本机运行，可访问你的文件与网络。仅运行你信任的来源。之后命令行改变时会再次询问。`,
          buttons: ['暂不运行', '信任并运行'],
          defaultId: 0,
          cancelId: 0,
        });
        if (r.response === 1) trust = pending.map((p) => p.name);
      }
      return rt.mcp.saveConfig(text, trust);
    },
    mcpTrust: async (name: string) => {
      const e = rt.mcp.config.mcpServers[name];
      if (!e?.command) return;
      const win = host.getWindow();
      const r = await dialog.showMessageBox(win!, { type: 'warning', message: `信任并运行 MCP 服务「${name}」？`, detail: `命令：${rt.mcp.states.get(name)?.target ?? e.command}\n\n该命令会以你的用户身份在本机运行。`, buttons: ['取消', '信任并运行'], defaultId: 0, cancelId: 0 });
      if (r.response === 1) rt.mcp.trust(name);
    },
    mcpStart: (name: string) => rt.mcp.start(name),
    mcpStop: (name: string) => rt.mcp.stop(name),
    mcpRestart: (name: string) => rt.mcp.restart(name),
    mcpSetServerPolicy: (name: string, patch: Partial<McpServerPolicy>) => rt.mcp.setServerPolicy(name, patch),
    mcpSetToolPolicy: (name: string, tool: string, patch: Partial<McpToolPolicy>) => rt.mcp.setToolPolicy(name, tool, patch),
    /** Read `.cursor/mcp.json` / `.vscode/mcp.json` / `mcp.json` from the open workspace, merged into the editor text (not saved yet). */
    mcpImportWorkspace: () => {
      const root = ws().root;
      const found = ['.cursor/mcp.json', '.vscode/mcp.json', 'mcp.json', '.mcp.json'].map((f) => path.join(root, f)).find((f) => fs.existsSync(f));
      if (!found) throw new Error('工作区中未找到 .cursor/mcp.json、.vscode/mcp.json 或 mcp.json');
      const incoming = parseMcpConfig(fs.readFileSync(found, 'utf8'));
      const merged = { mcpServers: { ...rt.mcp.config.mcpServers, ...incoming.mcpServers } };
      return { text: JSON.stringify(merged, null, 2), from: path.relative(root, found), added: Object.keys(incoming.mcpServers) };
    },
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
    // ── HTML 预览
    previewUrl: (p?: string) => {
      const w = ws();
      return previewUrlFor(p ? w.rel(w.resolve(p)) : '');
    },
    previewOpenExternal: (p: string) => {
      if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(p)) return void shell.openExternal(p);
      const abs = ws().resolve(p);
      rt.audit.record('emperor', 'preview_open_external', { path: p });
      return shell.openPath(abs);
    },
    previewCapture: async (url: string, width?: number, height?: number) => {
      if (!isAllowedPreviewUrl(url) || !rt.opts.previewPage) throw new Error('无法预览该地址');
      const r = await rt.opts.previewPage(url, { waitMs: 600, width: width ?? 1280, height: height ?? 800 });
      const hash = r.png ? rt.blobs.put(r.png) : undefined;
      return { ...r, png: undefined, screenshot: hash };
    },
    blobImage: (hash: string) => {
      if (!/^[a-f0-9]{64}$/.test(hash)) return null;
      const b = rt.blobs.get(hash);
      return b ? `data:image/png;base64,${b.toString('base64')}` : null;
    },
    openDataDir: () => shell.openPath(rt.opts.dataDir),
  };
}

export type Api = ReturnType<typeof buildApi>;
