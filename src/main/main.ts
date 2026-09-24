// Edict for Mac — Electron main process.
import { app, BrowserWindow, Menu, Notification, dialog, ipcMain, nativeTheme, net, protocol, shell, type MenuItemConstructorOptions } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Runtime } from './runtime/runtime';
import { SafeStorageSecrets } from './secrets';
import { installOrchestrator, resumeAll } from './runtime/orchestrator';
import { loadSkills } from './runtime/extras';
import { buildApi } from './api';
import { TerminalManager } from './services/terminal';
import type { RuntimeEvent } from '../shared/types';

const APP_NAME = 'Edict';
app.setName(APP_NAME);
const isMac = process.platform === 'darwin';
const DIST = __dirname; // dist/ (main.js lives here)
const smokeTest = process.argv.includes('--smoke-test');

// Optional isolated data dir for tests (never used by the packaged app unless explicitly passed)
const dataArg = process.argv.find((a) => a.startsWith('--edict-data-dir='));
if (dataArg) app.setPath('userData', dataArg.split('=')[1]);

protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }]);

let win: BrowserWindow | null = null;
let rt: Runtime;
let terminals: TerminalManager;
let fsWatcher: fs.FSWatcher | null = null;

if (!smokeTest && !app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

function send(e: RuntimeEvent) {
  if (win && !win.isDestroyed()) win.webContents.send('rt:event', e);
}

function notify(title: string, body: string) {
  if (!Notification.isSupported()) return;
  if (win && win.isFocused()) return; // in-app toasts cover the focused case
  const n = new Notification({ title, body, silent: false });
  n.on('click', () => win?.show());
  n.show();
}

function watchWorkspace(dir: string | null) {
  fsWatcher?.close();
  fsWatcher = null;
  if (!dir) return;
  let pending = new Set<string>();
  let timer: NodeJS.Timeout | null = null;
  try {
    fsWatcher = fs.watch(dir, { recursive: true }, (_ev, file) => {
      if (!file) return;
      const f = String(file).split(path.sep).join('/');
      if (/(^|\/)(node_modules|\.git)(\/|$)/.test(f)) return;
      pending.add(f);
      if (!timer)
        timer = setTimeout(() => {
          send({ type: 'fs_changed', paths: [...pending] });
          pending = new Set();
          timer = null;
        }, 300);
    });
  } catch (e) {
    console.warn('[watch] failed', e);
  }
}

function buildMenu() {
  const cmd = (command: string, arg?: unknown) => () => send({ type: 'menu', command, arg });
  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [{ label: APP_NAME, submenu: [
          { role: 'about' as const, label: '关于 Edict' },
          { type: 'separator' as const },
          { label: '设置…', accelerator: 'Cmd+,', click: cmd('open-panel', 'models') },
          { type: 'separator' as const },
          { role: 'services' as const, label: '服务' },
          { type: 'separator' as const },
          { role: 'hide' as const, label: '隐藏 Edict' },
          { role: 'hideOthers' as const, label: '隐藏其他' },
          { role: 'unhide' as const, label: '全部显示' },
          { type: 'separator' as const },
          { role: 'quit' as const, label: '退出 Edict' },
        ] }]
      : []),
    { label: '文件', submenu: [
      { label: '打开文件夹…', accelerator: 'CmdOrCtrl+O', click: () => void openFolderDialog() },
      { label: '新建文件', accelerator: 'CmdOrCtrl+N', click: cmd('new-file') },
      { label: '保存', accelerator: 'CmdOrCtrl+S', click: cmd('save') },
      { label: '快速打开…', accelerator: 'CmdOrCtrl+P', click: cmd('quick-open') },
      { label: '关闭标签页', accelerator: 'CmdOrCtrl+W', click: cmd('close-tab') },
      ...(isMac ? [] : [{ type: 'separator' as const }, { role: 'quit' as const, label: '退出' }]),
    ] },
    { label: '编辑', submenu: [
      { role: 'undo', label: '撤销' }, { role: 'redo', label: '重做' }, { type: 'separator' },
      { role: 'cut', label: '剪切' }, { role: 'copy', label: '复制' }, { role: 'paste', label: '粘贴' }, { role: 'selectAll', label: '全选' },
      { type: 'separator' },
      { label: '全局搜索', accelerator: 'CmdOrCtrl+Shift+F', click: cmd('global-search') },
    ] },
    { label: '视图', submenu: [
      { label: '切换 工作台 / 朝堂', accelerator: 'CmdOrCtrl+J', click: cmd('toggle-mode') },
      { label: '显示/隐藏 下旨输入框', accelerator: 'CmdOrCtrl+L', click: cmd('toggle-composer') },
      { label: '聚焦 下旨输入框', accelerator: 'CmdOrCtrl+I', click: cmd('focus-composer') },
      { label: '命令面板', accelerator: 'CmdOrCtrl+Shift+P', click: cmd('command-palette') },
      { label: '显示/隐藏 终端', accelerator: 'Ctrl+`', click: cmd('toggle-terminal') },
      { label: '显示/隐藏 侧栏', accelerator: 'CmdOrCtrl+B', click: cmd('toggle-sidebar') },
      { type: 'separator' },
      { role: 'resetZoom', label: '实际大小' }, { role: 'zoomIn', label: '放大' }, { role: 'zoomOut', label: '缩小' },
      { type: 'separator' },
      { role: 'togglefullscreen', label: '全屏' },
      ...(app.isPackaged ? [] : [{ role: 'reload' as const }, { role: 'toggleDevTools' as const }]),
    ] },
    { label: '军机处', submenu: [
      { label: '旨意看板', accelerator: 'CmdOrCtrl+Shift+K', click: cmd('open-panel', 'kanban') },
      { label: '省部调度', click: cmd('open-panel', 'monitor') },
      { label: '奏折阁', click: cmd('open-panel', 'memorials') },
      { label: '旨库', click: cmd('open-panel', 'templates') },
      { label: '官员总览', click: cmd('open-panel', 'officials') },
      { label: '天下要闻', click: cmd('open-panel', 'news') },
      { label: '模型配置', click: cmd('open-panel', 'models') },
      { label: '技能配置', click: cmd('open-panel', 'skills') },
      { label: '小任务 Sessions', click: cmd('open-panel', 'sessions') },
      { label: '朝堂议政', click: cmd('open-panel', 'debate') },
      { label: '审计日志', click: cmd('open-panel', 'audit') },
    ] },
    { label: '朝堂', submenu: [
      { label: '上朝仪式', accelerator: 'CmdOrCtrl+Shift+U', click: cmd('ceremony') },
      { type: 'separator' },
      { label: '太和殿', accelerator: 'CmdOrCtrl+1', click: cmd('court-scene', 'taihe') },
      { label: '军机处值房', accelerator: 'CmdOrCtrl+2', click: cmd('court-scene', 'junjichu') },
      { label: '六部值房', accelerator: 'CmdOrCtrl+3', click: cmd('court-scene', 'liubu') },
      { label: '承天门告示区', accelerator: 'CmdOrCtrl+4', click: cmd('court-scene', 'chengtian') },
    ] },
    { role: 'windowMenu', label: '窗口' },
    { role: 'help', label: '帮助', submenu: [
      { label: '使用说明', click: cmd('open-panel', 'help') },
      { label: '打开数据目录', click: () => shell.openPath(rt.opts.dataDir) },
    ] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function openFolderDialog(): Promise<string | null> {
  if (!win) return null;
  const r = await dialog.showOpenDialog(win, { title: '打开工作区文件夹', properties: ['openDirectory', 'createDirectory'] });
  if (r.canceled || !r.filePaths[0]) return null;
  rt.setWorkspace(r.filePaths[0]);
  watchWorkspace(r.filePaths[0]);
  return r.filePaths[0];
}

function createWindow() {
  win = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 1100,
    minHeight: 680,
    title: 'Edict · 三省六部',
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#16120f' : '#f6f1e7',
    ...(isMac ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 14, y: 13 } } : {}),
    webPreferences: {
      preload: path.join(DIST, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
      backgroundThrottling: false,
    },
  });
  win.once('ready-to-show', () => win?.show());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('app://')) e.preventDefault();
  });
  win.loadURL('app://edict/renderer/index.html');
  win.on('closed', () => (win = null));
}

function firstLaunchNotice() {
  const marker = path.join(rt.opts.dataDir, '.first-launch-ack');
  if (fs.existsSync(marker) || smokeTest || process.env.EDICT_E2E) return;
  void dialog
    .showMessageBox({
      type: 'info',
      title: '欢迎使用 Edict · 三省六部',
      message: '首次启动须知',
      detail: [
        '1. 本安装包未经 Apple 签名与公证。若 macOS 提示"无法验证开发者"，请在「系统设置 → 隐私与安全性」中点击「仍要打开」。仅从可信来源获取安装包。',
        `2. 数据存放位置：${rt.opts.dataDir}（任务、审计、会话、技能）。本地存储不是安全沙箱。`,
        `3. API Key 使用系统钥匙串加密（safeStorage${(rt.opts.secrets.encrypted ? '：可用' : '：不可用，已退化为本地编码存储')}），不会写入日志与审计。`,
        '4. 外发请求范围：仅发往你在「模型配置」中填写的模型服务地址，以及你主动添加的新闻源 / 远程技能链接。',
        '5. Agent 只能在所打开的工作区内读写；高风险命令（删除、提权、推送、网络外发等）必须经你确认。',
      ].join('\n\n'),
      buttons: ['朕已知晓'],
    })
    .then(() => fs.writeFileSync(marker, new Date().toISOString()));
}

app.whenReady().then(async () => {
  const dataDir = path.join(app.getPath('userData'), 'EdictData');
  protocol.handle('app', (req) => {
    const u = new URL(req.url);
    const rel = decodeURIComponent(u.pathname).replace(/^\/+/, '');
    const file = path.normalize(path.join(DIST, rel));
    if (!file.startsWith(DIST + path.sep)) return new Response('forbidden', { status: 403 });
    return net.fetch(pathToFileURL(file).toString());
  });
  rt = new Runtime({
    dataDir,
    fetchImpl: (url, init) => net.fetch(url, init as RequestInit) as unknown as Promise<Response>,
    secrets: new SafeStorageSecrets(dataDir),
    version: app.getVersion(),
    platform: process.platform,
    resourcesDir: DIST,
    notify,
  });
  installOrchestrator(rt);
  loadSkills(rt);
  nativeTheme.themeSource = rt.settings.theme;
  terminals = new TerminalManager((id, kind, payload) => win?.webContents.send('term:event', { id, kind, payload }));
  rt.on((e) => {
    send(e);
    if (e.type === 'workspace') watchWorkspace(e.workspace);
    if (e.type === 'settings') nativeTheme.themeSource = e.settings.theme;
  });
  const api = buildApi(rt, terminals, { openFolderDialog, getWindow: () => win });
  ipcMain.handle('rt:invoke', async (_e, method: string, args: unknown[]) => {
    const fn = (api as Record<string, (...a: unknown[]) => unknown>)[method];
    if (typeof fn !== 'function') throw new Error(`未知 API：${method}`);
    return fn(...(Array.isArray(args) ? args : []));
  });
  buildMenu();
  createWindow();
  watchWorkspace(rt.workspace?.root ?? null);
  firstLaunchNotice();
  resumeAll(rt);
  if (smokeTest) {
    setTimeout(() => {
      console.log('[smoke] ok', JSON.stringify({ tasks: rt.tasks.size, dataDir }));
      app.quit();
    }, 3000);
  }
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('web-contents-created', (_e, contents) => {
  contents.session.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === 'clipboard-sanitized-write' || permission === 'notifications'));
});

app.on('before-quit', () => {
  try {
    terminals?.killAll();
    rt?.dispose();
  } catch (e) {
    console.error(e);
  }
});

app.on('window-all-closed', () => {
  if (!isMac || smokeTest) app.quit();
});
