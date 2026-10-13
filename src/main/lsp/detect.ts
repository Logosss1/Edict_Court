// Language server discovery: look executables up directly on disk (PATH from safeEnv() + common
// install dirs) — no shell per lookup. Results are cached; `--version` probing is optional.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { safeEnv } from '../services/exec';
import { LSP_SERVERS, type LspServerDef } from './registry';

export interface DetectedServer {
  id: string;
  name: string;
  found: boolean;
  /** Absolute executable path. */
  path?: string;
  args?: string[];
  /** Candidate command that matched. */
  command?: string;
  version?: string;
  /** Chinese hint for the current platform, e.g. "Pyright：npm i -g pyright". */
  installHint: string;
  /** Why an executable that exists was rejected (rustup proxy without the component, stale shim). */
  note?: string;
  homepage: string;
  checkedAt: number;
}

export interface DetectOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  home?: string;
  probeVersion?: boolean;
  versionTimeoutMs?: number;
  /** Ignore cached results. */
  refresh?: boolean;
  /** User overrides per server id (absolute path or command name, custom args). */
  overrides?: Record<string, { path?: string; args?: string[] } | undefined>;
}

const FOUND_TTL = 10 * 60_000;
const MISSING_TTL = 20_000; // short, so a fresh install is picked up without restarting Edict
const cache = new Map<string, { at: number; value: DetectedServer; probed: boolean }>();
let dirsCache: { key: string; at: number; dirs: string[] } | null = null;

export function clearDetectCache() {
  cache.clear();
  dirsCache = null;
}

export function installHint(def: LspServerDef, platform: NodeJS.Platform = process.platform): string {
  const h = def.install[platform as 'darwin' | 'linux' | 'win32'] ?? def.install.all ?? def.install.darwin ?? def.install.linux ?? '';
  return `${def.name}：${h}`;
}

function isDir(p: string) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isExecutable(file: string, platform: NodeJS.Platform) {
  try {
    if (!fs.statSync(file).isFile()) return false;
    if (platform !== 'win32') fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** `<base>/<glob-free dir>/*\/<tail>` expansion for version-managed install dirs (newest name first). */
function expand(base: string, tail: string): string[] {
  try {
    return fs
      .readdirSync(base)
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
      .map((d) => path.join(base, d, tail));
  } catch {
    return [];
  }
}

function npmPrefixBin(env: NodeJS.ProcessEnv, home: string, platform: NodeJS.Platform): string[] {
  const prefixes = [env.npm_config_prefix, env.NPM_CONFIG_PREFIX].filter((x): x is string => !!x);
  try {
    const m = fs.readFileSync(path.join(home, '.npmrc'), 'utf8').match(/^\s*prefix\s*=\s*(.+?)\s*$/m);
    if (m) prefixes.push(m[1].replace(/^~(?=$|\/)/, home).replace(/^["']|["']$/g, ''));
  } catch {
    /* no ~/.npmrc */
  }
  return prefixes.map((p) => (platform === 'win32' ? p : path.join(p, 'bin')));
}

/** Directories searched for executables: PATH first, then common per-user / Homebrew / toolchain locations. */
export function searchDirs(opts: Pick<DetectOptions, 'env' | 'home' | 'platform'> = {}): string[] {
  const env = opts.env ?? safeEnv();
  const home = opts.home ?? os.homedir();
  const platform = opts.platform ?? process.platform;
  const key = `${env.PATH ?? ''}\0${home}\0${platform}`;
  if (dirsCache && dirsCache.key === key && Date.now() - dirsCache.at < MISSING_TTL) return dirsCache.dirs;
  const h = (...p: string[]) => path.join(home, ...p);
  const list = [
    ...(env.PATH ?? '').split(path.delimiter),
    h('.local/bin'), h('go/bin'), h('.cargo/bin'), h('.npm-global/bin'), h('.bun/bin'), h('.volta/bin'), h('.yarn/bin'),
    h('.dotnet/tools'), h('.pub-cache/bin'), h('.rbenv/shims'), h('.pyenv/shims'), h('.asdf/shims'), h('.local/share/mise/shims'), h('.swiftly/bin'),
    ...npmPrefixBin(env, home, platform),
    ...(platform === 'darwin' ? [h('Library/pnpm'), ...expand(h('Library/Python'), 'bin')] : [h('.local/share/pnpm')]),
    ...expand(h('.nvm/versions/node'), 'bin'),
    ...expand(h('.gem/ruby'), 'bin'),
    '/opt/homebrew/bin', '/usr/local/bin', '/opt/homebrew/opt/llvm/bin', '/usr/local/opt/llvm/bin', ...expand('/opt/homebrew/lib/ruby/gems', 'bin'),
    '/usr/local/go/bin', '/opt/local/bin', '/usr/bin', '/bin',
  ];
  const seen = new Set<string>();
  const dirs: string[] = [];
  for (const d of list) {
    if (!d || !path.isAbsolute(d)) continue;
    const n = path.normalize(d);
    if (seen.has(n)) continue;
    seen.add(n);
    if (isDir(n)) dirs.push(n);
  }
  dirsCache = { key, at: Date.now(), dirs };
  return dirs;
}

/** Locate an executable by name (or verify an absolute path) without spawning a shell. */
export function findExecutable(cmd: string, dirs: string[] = searchDirs(), platform: NodeJS.Platform = process.platform): string | null {
  if (!cmd) return null;
  if (path.isAbsolute(cmd) || cmd.includes('/')) return isExecutable(path.resolve(cmd), platform) ? path.resolve(cmd) : null;
  const exts = platform === 'win32' ? ['', ...(process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').map((e) => e.toLowerCase())] : [''];
  for (const d of dirs) for (const e of exts) {
    const f = path.join(d, cmd + e);
    if (isExecutable(f, platform)) return f;
  }
  return null;
}

function run(file: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    try {
      const child = execFile(file, args, { env, timeout: timeoutMs, maxBuffer: 256 * 1024, windowsHide: true }, (err, stdout, stderr) => resolve({ ok: !err, out: `${stdout ?? ''}\n${stderr ?? ''}`.trim() }));
      child.stdin?.end(); // servers waiting on stdio exit at EOF instead of hanging until the timeout
    } catch {
      resolve({ ok: false, out: '' });
    }
  });
}

function xcrunFind(cmd: string, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<string | null> {
  return run('/usr/bin/xcrun', ['--find', cmd], env, timeoutMs).then(({ ok, out }) => {
    const p = ok ? out.split('\n').map((l) => l.trim()).find((l) => l.startsWith('/')) : undefined;
    return p && isExecutable(p, 'darwin') ? p : null;
  });
}

export function parseVersion(out: string | null | undefined): string | undefined {
  if (!out) return undefined;
  const m = out.match(/\bv?(\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?)/);
  return m ? m[1] : out.split('\n')[0].trim().slice(0, 60) || undefined;
}

function sameFile(a: string, b: string) {
  try {
    const x = fs.statSync(a);
    const y = fs.statSync(b);
    return x.ino === y.ino && x.dev === y.dev;
  } catch {
    return false;
  }
}

function versionCommand(def: LspServerDef, cmd: string | undefined, exe: string): { bin: string; args: string[] } | null {
  const c = def.commands.find((x) => x.cmd === cmd) ?? def.commands[0];
  if (!c?.version) return null;
  const bin = c.version.sibling ? path.join(path.dirname(exe), c.version.sibling) : exe;
  return fs.existsSync(bin) ? { bin, args: c.version.args } : null;
}

/** Executables that exist but cannot run: rustup proxies without the component (rustup ships a rust-analyzer
 *  proxy by default), version-manager shims (pyenv / asdf / mise / rbenv) whose active version lacks the tool. */
async function unusable(def: LspServerDef, cmd: string, exe: string, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<string | null> {
  const base = path.basename(exe);
  const rustup = path.join(path.dirname(exe), 'rustup');
  if (base !== 'rustup' && sameFile(exe, rustup)) {
    const r = await run(rustup, ['which', base], env, timeoutMs);
    return r.ok ? null : `rustup 代理存在，但当前工具链未安装 ${base} 组件`;
  }
  if (/[\\/]shims[\\/]/.test(exe)) {
    const v = versionCommand(def, cmd, exe);
    if (v && !(await run(v.bin, v.args, env, timeoutMs)).ok) return `版本管理器 shim 存在，但当前激活的版本未安装 ${base}`;
  }
  return null;
}

/** Status of one server: found path (+ version when probed), or missing + install hint. */
export async function detectServer(def: LspServerDef, opts: DetectOptions = {}): Promise<DetectedServer> {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? safeEnv();
  const timeoutMs = opts.versionTimeoutMs ?? 3000;
  const ov = opts.overrides?.[def.id];
  const key = JSON.stringify([def.id, def.commands, ov?.path, ov?.args, platform, env.PATH, opts.home]);
  const hit = cache.get(key);
  if (hit && !opts.refresh) {
    const ttl = hit.value.found ? FOUND_TTL : MISSING_TTL;
    const stillThere = !hit.value.found || isExecutable(hit.value.path!, platform);
    if (Date.now() - hit.at < ttl && stillThere) {
      if (!opts.probeVersion || hit.probed || !hit.value.found) return hit.value;
      hit.value.version = await probe(def, hit.value, env, timeoutMs);
      hit.probed = true;
      return hit.value;
    }
  }
  const dirs = searchDirs({ env, home: opts.home, platform });
  const value: DetectedServer = { id: def.id, name: def.name, found: false, installHint: installHint(def, platform), homepage: def.homepage, checkedAt: Date.now() };
  const candidates = ov?.path ? [{ cmd: ov.path, args: ov.args ?? def.commands[0]?.args ?? [], xcrun: false }] : def.commands;
  for (const c of candidates) {
    let p = findExecutable(c.cmd, dirs, platform);
    if (!p && c.xcrun && platform === 'darwin') p = await xcrunFind(c.cmd, env, timeoutMs);
    if (!p) continue;
    const bad = await unusable(def, c.cmd, p, env, timeoutMs);
    if (bad) {
      value.note = bad;
      continue;
    }
    Object.assign(value, { found: true, path: p, args: ov?.args ?? c.args, command: c.cmd, note: undefined });
    break;
  }
  if (value.found && opts.probeVersion) value.version = await probe(def, value, env, timeoutMs);
  cache.set(key, { at: Date.now(), value, probed: !!opts.probeVersion });
  return value;
}

async function probe(def: LspServerDef, d: DetectedServer, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<string | undefined> {
  const v = d.path ? versionCommand(def, d.command, d.path) : null;
  if (!v) return undefined;
  const r = await run(v.bin, v.args, env, timeoutMs);
  return r.ok ? parseVersion(r.out) : undefined;
}

export function detectServers(defs: LspServerDef[] = LSP_SERVERS, opts: DetectOptions = {}): Promise<DetectedServer[]> {
  return Promise.all(defs.map((d) => detectServer(d, opts)));
}
