// Integrated terminal without native modules: a real PTY is obtained through the system
// `script` utility (BSD script on macOS, util-linux script on Linux). Resize is applied by
// running `stty` against the child's tty device, which delivers SIGWINCH to the shell.
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { safeEnv, userShell } from './exec';

interface Term {
  proc: ChildProcess;
  tty?: string;
}

export class TerminalManager {
  private terms = new Map<string, Term>();
  constructor(private emit: (id: string, kind: 'data' | 'exit', payload: string) => void) {}

  create(id: string, cwd: string, cols: number, rows: number): void {
    this.kill(id);
    const shell = userShell();
    const env = safeEnv({ COLUMNS: String(cols), LINES: String(rows), TERM: 'xterm-256color', EDICT_TERMINAL: '1' });
    const args = process.platform === 'darwin' ? ['-q', '/dev/null', shell, '-il'] : ['-qfec', `${shell} -il`, '/dev/null'];
    const proc = spawn('script', args, { cwd, env });
    const t: Term = { proc };
    this.terms.set(id, t);
    proc.stdout?.on('data', (d: Buffer) => this.emit(id, 'data', d.toString('utf8')));
    proc.stderr?.on('data', (d: Buffer) => this.emit(id, 'data', d.toString('utf8')));
    proc.on('exit', (code) => {
      this.emit(id, 'exit', String(code ?? ''));
      this.terms.delete(id);
    });
    proc.on('error', (e) => this.emit(id, 'data', `\r\n[终端启动失败] ${e.message}\r\n`));
    setTimeout(() => this.resize(id, cols, rows), 400);
  }

  write(id: string, data: string): void {
    this.terms.get(id)?.proc.stdin?.write(data);
  }

  private findTty(t: Term): Promise<string | undefined> {
    if (t.tty) return Promise.resolve(t.tty);
    const pid = t.proc.pid;
    if (!pid) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      execFile('pgrep', ['-P', String(pid)], (e, out) => {
        const child = String(out).trim().split('\n')[0];
        if (!child) return resolve(undefined);
        execFile('ps', ['-o', 'tty=', '-p', child], (e2, out2) => {
          const tty = String(out2).trim();
          if (!tty || tty === '?' || tty === '??') return resolve(undefined);
          t.tty = tty.startsWith('/dev/') ? tty : `/dev/${tty}`;
          resolve(t.tty);
        });
      });
    });
  }

  async resize(id: string, cols: number, rows: number): Promise<void> {
    const t = this.terms.get(id);
    if (!t) return;
    const tty = await this.findTty(t);
    if (!tty) return;
    const flag = process.platform === 'darwin' ? '-f' : '-F';
    execFile('stty', [flag, tty, 'cols', String(Math.max(10, cols | 0)), 'rows', String(Math.max(3, rows | 0))], () => {});
  }

  kill(id: string): void {
    const t = this.terms.get(id);
    if (t) {
      try {
        t.proc.kill('SIGHUP');
      } catch {
        /* ignore */
      }
      this.terms.delete(id);
    }
  }

  killAll(): void {
    for (const id of [...this.terms.keys()]) this.kill(id);
  }
}
