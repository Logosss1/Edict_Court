import { execFile } from 'node:child_process';
import { safeEnv } from './exec';

function git(cwd: string, args: string[], maxBuffer = 16 * 1024 * 1024): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, env: safeEnv({ GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' }), maxBuffer }, (e, stdout, stderr) => {
      resolve({ code: e ? ((e as { code?: number }).code ?? 1) : 0, out: String(stdout), err: String(stderr) });
    });
  });
}

export interface GitFile {
  path: string;
  index: string; // X
  worktree: string; // Y
  status: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'conflict' | 'other';
  staged: boolean;
}

export interface GitStatus {
  isRepo: boolean;
  branch: string;
  ahead: number;
  behind: number;
  files: GitFile[];
}

export async function gitStatus(cwd: string): Promise<GitStatus> {
  const r = await git(cwd, ['status', '--porcelain=v1', '-b', '-uall', '-z']);
  if (r.code !== 0) return { isRepo: false, branch: '', ahead: 0, behind: 0, files: [] };
  const parts = r.out.split('\0').filter(Boolean);
  let branch = '';
  let ahead = 0;
  let behind = 0;
  const files: GitFile[] = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p.startsWith('## ')) {
      const m = p.slice(3);
      branch = m.split('...')[0].replace('No commits yet on ', '');
      const a = m.match(/ahead (\d+)/);
      const b = m.match(/behind (\d+)/);
      ahead = a ? +a[1] : 0;
      behind = b ? +b[1] : 0;
      continue;
    }
    const X = p[0];
    const Y = p[1];
    const file = p.slice(3);
    if (X === 'R' || X === 'C') i++; // skip orig path
    let status: GitFile['status'] = 'other';
    if (X === '?' && Y === '?') status = 'untracked';
    else if (X === 'U' || Y === 'U' || (X === 'A' && Y === 'A') || (X === 'D' && Y === 'D')) status = 'conflict';
    else if (X === 'A' || Y === 'A') status = 'added';
    else if (X === 'D' || Y === 'D') status = 'deleted';
    else if (X === 'R') status = 'renamed';
    else if (X === 'M' || Y === 'M') status = 'modified';
    files.push({ path: file, index: X, worktree: Y, status, staged: X !== ' ' && X !== '?' });
  }
  return { isRepo: true, branch, ahead, behind, files };
}

export async function gitShowHead(cwd: string, rel: string): Promise<string | null> {
  const r = await git(cwd, ['show', `HEAD:${rel}`]);
  return r.code === 0 ? r.out : null;
}

export async function gitStage(cwd: string, paths: string[]) {
  return git(cwd, ['add', '--', ...paths]);
}
export async function gitUnstage(cwd: string, paths: string[]) {
  return git(cwd, ['restore', '--staged', '--', ...paths]);
}
export async function gitCommit(cwd: string, message: string) {
  return git(cwd, ['commit', '-m', message]);
}
export async function gitLog(cwd: string, n = 30) {
  const r = await git(cwd, ['log', `-${n}`, '--pretty=format:%h\x1f%an\x1f%ar\x1f%s']);
  if (r.code !== 0) return [];
  return r.out
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [hash, author, when, subject] = l.split('\x1f');
      return { hash, author, when, subject };
    });
}
export async function gitInit(cwd: string) {
  return git(cwd, ['init']);
}
