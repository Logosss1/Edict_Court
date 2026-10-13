// 命令沙箱 (2.1): officials' shell commands run under macOS sandbox-exec. Writes are limited to the
// workspace (or the edict's worktree and its git directory), temp folders and package-manager caches;
// folders with keys, tokens and browser data cannot be read; the network is on unless switched off.
// The profile only adds denials on top of (allow default), so the order of rules never matters.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface SandboxPolicy {
  /** absolute folders (and their contents) commands may write */
  writable: string[];
  /** absolute folders / files commands may not read */
  denyRead: string[];
  /** inside denyRead, still readable (an edict worktree inside the data folder) */
  allowRead: string[];
  network: boolean;
}

export interface SandboxBackend {
  available(): boolean;
  /** argv that runs `cmd` in `shell` under `profile` */
  wrap(profile: string, shell: string, cmd: string): { file: string; args: string[] };
}

const SANDBOX_EXEC = '/usr/bin/sandbox-exec';
let probed: boolean | undefined;

const macBackend: SandboxBackend = {
  available() {
    if (probed !== undefined) return probed;
    probed = false;
    if (process.platform !== 'darwin' || !fs.existsSync(SANDBOX_EXEC)) return probed;
    try {
      probed = spawnSync(SANDBOX_EXEC, ['-p', '(version 1)\n(allow default)', '/usr/bin/true'], { timeout: 5000 }).status === 0;
    } catch {
      probed = false;
    }
    return probed;
  },
  wrap: (profile, shell, cmd) => ({ file: SANDBOX_EXEC, args: ['-p', profile, shell, '-lc', cmd] }),
};

let backend: SandboxBackend = macBackend;
/** tests: a stand-in for sandbox-exec (Linux has none) */
export const setSandboxBackendForTests = (b: SandboxBackend | null) => (backend = b ?? macBackend);
export const sandboxBackend = () => backend;

export function expandHome(p: string, home = os.homedir()): string {
  const t = p.trim();
  if (t === '~') return home;
  if (t.startsWith('~/')) return path.join(home, t.slice(2));
  return t;
}

/** Real path of `p` (symlinks resolved, /tmp → /private/tmp); for a path that does not exist yet, its nearest existing parent's. */
export function realish(p: string): string {
  const abs = path.resolve(p);
  let cur = abs;
  const rest: string[] = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(cur), ...rest);
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return abs;
      rest.unshift(path.basename(cur));
      cur = parent;
    }
  }
}

const q = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
const sub = (p: string) => `(subpath ${q(p)})`;

/** Device files every shell command needs to write. */
const DEVICES = ['(literal "/dev/null")', '(literal "/dev/zero")', '(literal "/dev/dtracehelper")', '(literal "/dev/random")', '(literal "/dev/urandom")', '(regex #"^/dev/tty")', '(regex #"^/dev/fd/")', '(literal "/dev/ptmx")', '(regex #"^/dev/ttys")'];

export function buildProfile(p: SandboxPolicy): string {
  const writable = [...new Set(p.writable.map(realish))];
  const deny = [...new Set(p.denyRead.map(realish))];
  const allowRead = [...new Set(p.allowRead.map(realish))];
  const lines = ['(version 1)', '(allow default)'];
  lines.push(`(deny file-write* (require-not (require-any ${[...writable.map(sub), ...DEVICES].join(' ')})))`);
  if (deny.length) {
    const target = `(require-any ${deny.map(sub).join(' ')})`;
    lines.push(allowRead.length ? `(deny file-read-data (require-all ${target} (require-not (require-any ${allowRead.map(sub).join(' ')}))))` : `(deny file-read-data ${target})`);
  }
  if (!p.network) lines.push('(deny network-outbound (require-not (remote ip "localhost:*")))');
  return lines.join('\n');
}

/** The common .git folder of a worktree (its `.git` is a file pointing into <repo>/.git/worktrees/<name>). */
export function gitCommonDir(root: string): string | null {
  try {
    const dotgit = path.join(root, '.git');
    const st = fs.statSync(dotgit);
    if (st.isDirectory()) return null; // inside the workspace already
    const m = fs.readFileSync(dotgit, 'utf8').match(/^gitdir:\s*(.+)$/m);
    if (!m) return null;
    const gitdir = path.resolve(root, m[1].trim());
    const common = path.join(gitdir, 'commondir');
    if (fs.existsSync(common)) return path.resolve(gitdir, fs.readFileSync(common, 'utf8').trim());
    return path.dirname(path.dirname(gitdir));
  } catch {
    return null;
  }
}

/** Temp folders: the per-user one (os.tmpdir) and the shared ones. */
export function tempDirs(): string[] {
  const out = [os.tmpdir()];
  if (process.platform === 'darwin') out.push('/private/tmp', '/private/var/tmp', '/private/var/folders');
  else out.push('/tmp', '/var/tmp');
  return out;
}

export interface SandboxDenial {
  kind: 'write' | 'read' | 'network' | 'unknown';
  /** the path the command was refused, when the output names one */
  path?: string;
}

const PERM_RE = /operation not permitted|permission denied|EPERM|EACCES|read-only file system|EROFS|sandbox/i;
const NET_RE = /could not resolve host|getaddrinfo|ENOTFOUND|EAI_AGAIN|network is unreachable|nodename nor servname|temporary failure in name resolution|failed to connect|connection refused|unable to access '[^']*https?:/i;

const inside = (p: string, roots: string[]) => roots.some((r) => p === r || p.startsWith(r.endsWith(path.sep) ? r : r + path.sep));

/**
 * Did the sandbox stop this (failed) command? Looks for permission errors and the paths they name: a path
 * outside the writable folders (or inside a no-read folder) means yes; a permission error on a path the
 * command may use means no (a real permission problem). No path named: maybe — the emperor decides.
 */
export function detectDenial(output: string, p: SandboxPolicy, home = os.homedir()): SandboxDenial | null {
  if (!p.network && NET_RE.test(output)) return { kind: 'network' };
  if (!PERM_RE.test(output)) return null;
  const writable = p.writable.map(realish);
  const deny = p.denyRead.map(realish);
  const allowRead = p.allowRead.map(realish);
  const lines = output.split('\n').filter((l) => PERM_RE.test(l));
  let sawAllowedPath = false;
  for (const l of lines) {
    for (const m of l.matchAll(/(?:^|[\s'"`(:=])((?:~|\/)[^\s'"`():;,]*[^\s'"`():;,.])/g)) {
      const raw = m[1];
      if (raw.startsWith('//') || /^\/(usr|bin|sbin|System)\//.test(raw)) continue;
      const abs = realish(expandHome(raw, home));
      if (inside(abs, deny) && !inside(abs, allowRead)) return { kind: 'read', path: abs };
      if (!inside(abs, writable) && !abs.startsWith('/dev/')) return { kind: 'write', path: abs };
      sawAllowedPath = true;
    }
  }
  return sawAllowedPath ? null : { kind: 'unknown' };
}
