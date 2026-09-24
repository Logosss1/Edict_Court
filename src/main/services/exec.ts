import { spawn } from 'node:child_process';
import os from 'node:os';

export interface ExecResult {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

export function userShell(): string {
  if (process.platform === 'darwin') return process.env.SHELL || '/bin/zsh';
  return process.env.SHELL && !process.env.SHELL.endsWith('nologin') ? process.env.SHELL : '/bin/bash';
}

/** Environment for child processes: inherit PATH etc., but strip anything that looks like a secret. */
export function safeEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(k)) continue;
    if (k.startsWith('ELECTRON_') || k === 'NODE_OPTIONS') continue;
    env[k] = v;
  }
  // GUI apps on macOS get a minimal PATH; add common locations.
  if (process.platform === 'darwin') {
    const extraPath = ['/opt/homebrew/bin', '/usr/local/bin', `${os.homedir()}/.local/bin`];
    env.PATH = [...new Set([...(env.PATH ?? '/usr/bin:/bin').split(':'), ...extraPath])].join(':');
  }
  env.TERM = env.TERM || 'xterm-256color';
  return { ...env, ...extra };
}

export function runCommand(cmd: string, cwd: string, opts: { timeoutMs?: number; maxOutput?: number; signal?: AbortSignal } = {}): Promise<ExecResult> {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const maxOut = opts.maxOutput ?? 64 * 1024;
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(userShell(), ['-lc', cmd], { cwd, env: safeEnv(), detached: process.platform !== 'win32' });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const cap = (s: string, add: string) => (s.length >= maxOut ? s : (s + add).slice(0, maxOut));
    child.stdout.on('data', (d) => (stdout = cap(stdout, d.toString())));
    child.stderr.on('data', (d) => (stderr = cap(stderr, d.toString())));
    const kill = () => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGTERM');
      } catch {
        child.kill('SIGTERM');
      }
      setTimeout(() => {
        try {
          if (child.pid) process.kill(-child.pid, 'SIGKILL');
        } catch {
          /* gone */
        }
      }, 2000);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    const onAbort = () => kill();
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', (e) => {
      stderr += String(e);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      resolve({ exitCode: code, signal: signal ?? null, stdout, stderr, timedOut, durationMs: Date.now() - started });
    });
  });
}
