// Edict ACP bridge — the process an editor launches as its ACP agent. It relays the
// editor's stdin/stdout to the running Edict app's Unix socket. Pure byte pipe: it never parses the
// protocol, holds no credentials and needs nothing but Node built-ins.
//
//   ELECTRON_RUN_AS_NODE=1 /Applications/Edict.app/Contents/MacOS/Edict /Applications/Edict.app/Contents/Resources/app/acp-bridge.js
//   node acp-bridge.js [--socket <path>] [--data-dir <EdictData dir>] [--wait <seconds>] [--no-launch]
//   env: EDICT_ACP_SOCKET, EDICT_DATA_DIR
//
// stdout carries protocol bytes only; every diagnostic goes to stderr.
import { spawn } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const BUNDLE_ID = 'app.edict.mac';
const LAUNCH_WAIT_SEC = 20;

interface Options {
  socket?: string;
  dataDir?: string;
  waitSec?: number;
  launch: boolean;
}

function parseArgs(argv: string[]): Options {
  const o: Options = { launch: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      const eq = a.indexOf('=');
      if (eq > 0) return a.slice(eq + 1);
      return argv[++i];
    };
    if (a === '--socket' || a.startsWith('--socket=')) o.socket = val();
    else if (a === '--data-dir' || a.startsWith('--data-dir=')) o.dataDir = val();
    else if (a === '--wait' || a.startsWith('--wait=')) o.waitSec = Math.max(0, Number(val()) || 0);
    else if (a === '--no-launch') o.launch = false;
    else if (a === '-h' || a === '--help') {
      err('用法 / usage: acp-bridge.js [--socket <path>] [--data-dir <dir>] [--wait <seconds>] [--no-launch]');
      process.exit(0);
    }
  }
  return o;
}

/** Mirrors the app: dataDir = <Electron userData for "Edict">/EdictData. */
function defaultDataDir(): string {
  const home = os.homedir();
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Edict', 'EdictData');
  if (process.platform === 'win32') return path.join(process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), 'Edict', 'EdictData');
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(home, '.config'), 'Edict', 'EdictData');
}

function err(msg: string) {
  process.stderr.write(`${msg}\n`);
}

function tryConnect(p: string): Promise<{ sock: net.Socket } | { code: string }> {
  return new Promise((resolve) => {
    const sock = net.createConnection(p);
    sock.once('connect', () => {
      sock.removeAllListeners('error');
      resolve({ sock });
    });
    sock.once('error', (e: NodeJS.ErrnoException) => resolve({ code: e.code ?? 'ERROR' }));
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function explain(sockPath: string, code: string) {
  if (code === 'EACCES' || code === 'EPERM') {
    err(`[Edict ACP] 无权访问 Edict 的 ACP 套接字（${code}）：${sockPath}\n  该套接字只允许运行 Edict 的同一系统用户连接。`);
    err(`[Edict ACP] Permission denied on Edict's ACP socket (${code}): ${sockPath}\n  Only the user running Edict may connect.`);
    return;
  }
  err(`[Edict ACP] 无法连接 Edict 的 ACP 套接字（${code}）：${sockPath}\n  请确认 Edict 正在运行，并已在设置中开启「编辑器接入（ACP）」。`);
  err(`[Edict ACP] Cannot reach Edict's ACP socket (${code}): ${sockPath}\n  Make sure Edict is running and "Editor access (ACP)" is enabled in its settings.`);
}

function relay(sock: net.Socket) {
  let editorDone = false;
  const exit = (code: number) => process.stdout.write('', () => process.exit(code));
  process.stdout.on('error', () => process.exit(0)); // editor closed our stdout
  process.stdin.on('end', () => {
    editorDone = true;
  });
  sock.on('error', (e) => err(`[Edict ACP] 套接字错误 / socket error: ${e.message}`));
  sock.on('close', () => {
    if (!editorDone) {
      err('[Edict ACP] 与 Edict 的连接已断开（Edict 已退出、关闭了 ACP，或拒绝了此编辑器的连接）。');
      err('[Edict ACP] Connection to Edict closed (Edict quit, ACP was turned off, or this editor was declined).');
    }
    exit(editorDone ? 0 : 1);
  });
  process.stdin.pipe(sock); // stdin EOF → half-close towards Edict
  sock.pipe(process.stdout);
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const sockPath = o.socket ?? process.env.EDICT_ACP_SOCKET ?? path.join(o.dataDir ?? process.env.EDICT_DATA_DIR ?? defaultDataDir(), 'acp.sock');
  let r = await tryConnect(sockPath);
  if ('code' in r) {
    explain(sockPath, r.code);
    const canLaunch = process.platform === 'darwin' && o.launch;
    const waitSec = o.waitSec ?? (canLaunch ? LAUNCH_WAIT_SEC : 0);
    if (canLaunch) {
      err(`[Edict ACP] 正在启动 Edict（${BUNDLE_ID}），最多等待 ${waitSec} 秒… / Launching Edict, waiting up to ${waitSec} s…`);
      try {
        // the app itself must not inherit "run as node" from the editor's launch config
        const env = { ...process.env };
        delete env.ELECTRON_RUN_AS_NODE;
        spawn('open', ['-b', BUNDLE_ID], { stdio: 'ignore', detached: true, env }).on('error', (e) => err(`[Edict ACP] open 失败 / failed: ${e.message}`)).unref();
      } catch (e) {
        err(`[Edict ACP] 无法启动 Edict / could not launch Edict: ${(e as Error).message}`);
      }
    }
    const deadline = Date.now() + waitSec * 1000;
    while ('code' in r && Date.now() < deadline) {
      await sleep(500);
      r = await tryConnect(sockPath);
    }
    if ('code' in r) {
      if (waitSec > 0) {
        err(`[Edict ACP] 等待 ${waitSec} 秒后仍无法连接 Edict。请打开 Edict，在设置中开启「编辑器接入（ACP）」后重试。`);
        err(`[Edict ACP] Still cannot reach Edict after ${waitSec} s. Open Edict, enable "Editor access (ACP)", then retry.`);
      }
      process.exit(1);
    }
    err('[Edict ACP] 已连接 Edict / Connected to Edict');
  }
  relay(r.sock);
}

main().catch((e) => {
  err(`[Edict ACP] 意外错误 / unexpected error: ${(e as Error)?.stack ?? String(e)}`);
  process.exit(1);
});
