// Workspace file access with strict path boundaries. Every agent/file tool goes through here.
import fs from 'node:fs';
import path from 'node:path';

export const IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt', '.venv', 'venv', '__pycache__', 'target', '.idea', '.edict', '.cache', 'coverage', '.turbo', 'Pods', 'DerivedData']);
const BINARY_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.icns', '.pdf', '.zip', '.gz', '.tgz', '.dmg', '.woff', '.woff2', '.ttf', '.otf', '.mp3', '.mp4', '.mov', '.wasm', '.so', '.dylib', '.exe', '.bin', '.jar', '.class', '.o', '.a', '.sqlite', '.db']);

export class PathBoundaryError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'PathBoundaryError';
  }
}

export interface TreeNode {
  name: string;
  path: string; // relative
  dir: boolean;
  children?: TreeNode[];
  size?: number;
}

export class Workspace {
  readonly root: string;
  private realRoot: string;

  constructor(root: string) {
    this.root = path.resolve(root);
    this.realRoot = fs.realpathSync(this.root);
  }

  /** Resolve a user/agent supplied path into an absolute path inside the workspace or throw. */
  resolve(p: string): string {
    if (typeof p !== 'string' || !p.trim()) throw new PathBoundaryError('路径为空');
    if (p.includes('\0')) throw new PathBoundaryError('路径包含非法字符');
    const abs = path.resolve(this.root, p.replace(/^~(?=$|\/)/, '__home__'));
    const rel = path.relative(this.root, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) throw new PathBoundaryError(`路径越界：${p} 不在工作区内`);
    // symlink escape check on the closest existing ancestor
    let probe = abs;
    while (!fs.existsSync(probe) && probe !== this.root) probe = path.dirname(probe);
    const real = fs.realpathSync(probe);
    const rrel = path.relative(this.realRoot, real);
    if (rrel.startsWith('..') || path.isAbsolute(rrel)) throw new PathBoundaryError(`路径经符号链接越界：${p}`);
    return abs;
  }

  rel(abs: string): string {
    return path.relative(this.root, abs).split(path.sep).join('/');
  }

  isProtectedWrite(p: string): string | null {
    const rel = this.rel(this.resolve(p));
    if (rel === '.git' || rel.startsWith('.git/')) return '禁止直接改写 .git 内部文件';
    return null;
  }

  isSensitive(p: string): boolean {
    const base = path.basename(p).toLowerCase();
    return base.startsWith('.env') || /\.(pem|key|p12|keystore)$/.test(base) || base === 'id_rsa' || base === 'credentials';
  }

  exists(p: string): boolean {
    return fs.existsSync(this.resolve(p));
  }

  read(p: string): string {
    const abs = this.resolve(p);
    const st = fs.statSync(abs);
    if (st.isDirectory()) throw new Error(`${p} 是目录`);
    if (st.size > 4 * 1024 * 1024) throw new Error(`${p} 过大（${st.size} 字节），请按行读取`);
    return fs.readFileSync(abs, 'utf8');
  }

  readBuffer(p: string): Buffer | null {
    const abs = this.resolve(p);
    return fs.existsSync(abs) ? fs.readFileSync(abs) : null;
  }

  write(p: string, content: string): void {
    const abs = this.resolve(p);
    const prot = this.isProtectedWrite(p);
    if (prot) throw new PathBoundaryError(prot);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }

  remove(p: string): void {
    const abs = this.resolve(p);
    if (abs === this.root) throw new PathBoundaryError('不可删除工作区根目录');
    fs.rmSync(abs, { recursive: false, force: true });
  }

  mkdir(p: string): void {
    fs.mkdirSync(this.resolve(p), { recursive: true });
  }

  rename(from: string, to: string): void {
    fs.renameSync(this.resolve(from), this.resolve(to));
  }

  listDir(p = '.'): { name: string; dir: boolean; size: number }[] {
    const abs = this.resolve(p);
    return fs
      .readdirSync(abs, { withFileTypes: true })
      .filter((d) => d.name !== '.DS_Store')
      .map((d) => {
        let size = 0;
        if (!d.isDirectory()) {
          try {
            size = fs.statSync(path.join(abs, d.name)).size;
          } catch {
            /* ignore */
          }
        }
        return { name: d.name, dir: d.isDirectory(), size };
      })
      .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
  }

  /** Lazy tree for the explorer: one level at a time. */
  tree(p = '.'): TreeNode[] {
    const base = this.resolve(p);
    return this.listDir(p).map((e) => ({ name: e.name, dir: e.dir, size: e.size, path: this.rel(path.join(base, e.name)) }));
  }

  *walk(maxFiles = 8000): Generator<string> {
    let count = 0;
    const stack = [this.root];
    while (stack.length) {
      const dir = stack.pop()!;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const e of entries) {
        if (e.isSymbolicLink()) continue;
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (!IGNORE_DIRS.has(e.name)) stack.push(abs);
        } else {
          if (++count > maxFiles) return;
          yield this.rel(abs);
        }
      }
    }
  }

  isBinaryPath(rel: string): boolean {
    return BINARY_EXT.has(path.extname(rel).toLowerCase());
  }

  search(query: string, opts: { regex?: boolean; caseSensitive?: boolean; wholeWord?: boolean; include?: string; maxResults?: number } = {}) {
    const max = opts.maxResults ?? 2000;
    let src = opts.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (opts.wholeWord) src = `\\b${src}\\b`;
    const re = new RegExp(src, opts.caseSensitive ? 'g' : 'gi');
    const inc = opts.include ? globToRegex(opts.include) : null;
    const results: { path: string; line: number; col: number; preview: string }[] = [];
    for (const rel of this.walk()) {
      if (results.length >= max) break;
      if (this.isBinaryPath(rel)) continue;
      if (inc && !inc.test(rel)) continue;
      let text: string;
      try {
        const abs = path.join(this.root, rel);
        if (fs.statSync(abs).size > 1024 * 1024) continue;
        text = fs.readFileSync(abs, 'utf8');
      } catch {
        continue;
      }
      if (text.includes('\u0000')) continue;
      const lines = text.split('\n');
      for (let i = 0; i < lines.length && results.length < max; i++) {
        re.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = re.exec(lines[i])) && results.length < max) {
          results.push({ path: rel, line: i + 1, col: m.index + 1, preview: lines[i].slice(0, 240) });
          if (m[0].length === 0) re.lastIndex++;
        }
      }
    }
    return results;
  }

  replaceAll(query: string, replacement: string, opts: { regex?: boolean; caseSensitive?: boolean; wholeWord?: boolean; include?: string; paths?: string[] } = {}) {
    let src = opts.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (opts.wholeWord) src = `\\b${src}\\b`;
    const re = new RegExp(src, opts.caseSensitive ? 'g' : 'gi');
    const hits = new Set((opts.paths ?? this.search(query, { ...opts, maxResults: 100000 }).map((r) => r.path)).filter(Boolean));
    const changed: { path: string; count: number; before: string; after: string }[] = [];
    for (const rel of hits) {
      const before = this.read(rel);
      let count = 0;
      const after = before.replace(re, (...args) => {
        count++;
        if (!opts.regex) return replacement;
        // support $1 style groups
        const groups = args.slice(1, -2);
        return replacement.replace(/\$(\d)/g, (_, n) => groups[Number(n) - 1] ?? '');
      });
      if (count) {
        this.write(rel, after);
        changed.push({ path: rel, count, before, after });
      }
    }
    return changed;
  }

  /** Compact repository map for planning prompts (context budget friendly). */
  repoMap(maxLines = 160): string {
    const dirs = new Map<string, number>();
    const files: string[] = [];
    for (const rel of this.walk(6000)) {
      files.push(rel);
      const d = path.posix.dirname(rel);
      dirs.set(d, (dirs.get(d) ?? 0) + 1);
    }
    const lines: string[] = [`工作区：${path.basename(this.root)}（${files.length} 个文件）`];
    if (files.length <= maxLines) {
      lines.push(...files);
    } else {
      const top = files.filter((f) => !f.includes('/'));
      lines.push('根目录文件：' + top.slice(0, 40).join(', '));
      const sorted = [...dirs.entries()].filter(([d]) => d !== '.').sort((a, b) => a[0].localeCompare(b[0]));
      for (const [d, n] of sorted.slice(0, maxLines - 2)) lines.push(`${d}/ (${n})`);
    }
    return lines.join('\n');
  }

  outline(rel: string): string[] {
    const text = this.read(rel);
    return extractOutline(rel, text);
  }

  /** Symbol outline for the most relevant source files (bounded). */
  outlineMap(maxFiles = 40, maxSymbolsPerFile = 12): string {
    const out: string[] = [];
    let n = 0;
    for (const rel of this.walk(4000)) {
      if (n >= maxFiles) break;
      if (!/\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|swift|c|cc|cpp|h|hpp|rb|php|cs|vue|svelte)$/.test(rel)) continue;
      try {
        const syms = this.outline(rel).slice(0, maxSymbolsPerFile);
        if (syms.length) {
          out.push(`${rel}: ${syms.join(', ')}`);
          n++;
        }
      } catch {
        /* skip */
      }
    }
    return out.join('\n');
  }
}

export function extractOutline(rel: string, text: string): string[] {
  const ext = path.extname(rel).toLowerCase();
  const pats: RegExp[] = [];
  if (/\.(ts|tsx|js|jsx|mjs|cjs|vue|svelte)$/.test(ext)) {
    pats.push(/^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/, /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, /^\s*(?:export\s+)?(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/, /^\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/);
  } else if (ext === '.py') {
    pats.push(/^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/, /^\s*class\s+([A-Za-z_]\w*)/);
  } else if (ext === '.go') {
    pats.push(/^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/, /^type\s+([A-Za-z_]\w*)/);
  } else if (ext === '.rs') {
    pats.push(/^\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/, /^\s*(?:pub\s+)?(?:struct|enum|trait)\s+([A-Za-z_]\w*)/);
  } else {
    pats.push(/^\s*(?:public|private|protected|static|final|\s)*(?:class|interface|struct|enum|func|fun|def)\s+([A-Za-z_]\w*)/);
  }
  const syms: string[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    for (const p of pats) {
      const m = lines[i].match(p);
      if (m) {
        syms.push(`${m[1]}@${i + 1}`);
        break;
      }
    }
  }
  return syms;
}

export function globToRegex(glob: string): RegExp {
  const parts = glob
    .split(',')
    .map((g) => g.trim())
    .filter(Boolean)
    .map((g) =>
      g
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*\*\/?/g, '§')
        .replace(/\*/g, '[^/]*')
        .replace(/\?/g, '[^/]')
        .replace(/§/g, '.*'),
    );
  return new RegExp(`(^|/)(${parts.join('|')})$`);
}
