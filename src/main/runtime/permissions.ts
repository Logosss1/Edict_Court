// Permission & risk policy for agent tools. High-risk operations ALWAYS need the emperor's
// confirmation regardless of permission mode; read-only mode forbids writes/commands entirely.
import type { AllowRule, NodeGrant, PermissionMode } from '../../shared/types';

export type ToolClass = 'read' | 'write' | 'command' | 'meta';

export interface RiskVerdict {
  decision: 'allow' | 'ask' | 'deny';
  risk: 'normal' | 'high';
  reason: string;
}

/** Release / deploy commands: high risk, but a workspace may opt into allowing them permanently. */
const RELEASE_CMD: [RegExp, string][] = [
  [/\bgit\s+push\b/, '推送到远程仓库'],
  [/\b(npm|pnpm|yarn|bun)\s+publish\b|\bcargo\s+publish\b|\btwine\s+upload\b|\bgem\s+push\b|\bpoetry\s+publish\b|\bswift\s+package-registry\s+publish\b/, '发布软件包'],
  [/\bgh\s+release\s+(create|upload|edit|delete)\b/, '发布 GitHub Release'],
  [/\bdocker\s+(push|buildx\s+build\b.*--push)/, '推送镜像'],
  [/\b(vercel|netlify\s+deploy|flyctl?\s+deploy|firebase\s+deploy|wrangler\s+(deploy|publish)|railway\s+up|heroku\s+(releases|container:release|deploy)|serverless\s+deploy|sls\s+deploy|eas\s+(submit|update)|fastlane|surge)\b/, '部署上线'],
  [/\bkubectl\s+(apply|rollout|set\s+image|delete)\b|\bhelm\s+(install|upgrade|uninstall)\b|\bterraform\s+(apply|destroy)\b|\bpulumi\s+(up|destroy)\b/, '变更线上基础设施'],
  [/\b(gcloud|aws|az)\b[^|;&]*\b(deploy|s3\s+sync|s3\s+cp|update-function-code)\b/, '云端部署'],
  [/\bxcrun\s+(altool|notarytool\s+submit)\b/, '提交 App 审核 / 公证'],
];

const HIGH_RISK_CMD: [RegExp, string][] = [
  [/\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r|-r|-R)\b/, '递归删除文件'],
  [/\bsudo\b|\bsu\s/, '提权执行'],
  [/\bgit\s+(reset\s+--hard|clean\s+-[a-z]*f|checkout\s+--\s|restore\s+\.|branch\s+-D)/, '可能丢弃未提交修改'],
  [/\b(curl|wget)\b[^|]*\|\s*(sh|bash|zsh|python)/, '下载并执行远程脚本'],
  [/\b(chmod|chown)\s+-R\b/, '批量修改权限'],
  [/\bmkfs|\bdd\s+if=|\bdiskutil\s+erase/, '磁盘级操作'],
  [/:\(\)\s*\{\s*:\|:&\s*\};:/, 'fork 炸弹'],
  [/\b(shutdown|reboot|halt)\b/, '关机/重启'],
  [/\bkillall\b|\bpkill\b/, '批量结束进程'],
  [/>\s*\/(etc|usr|bin|System|Library)\//, '写入系统目录'],
  [/\b(curl|wget|scp|rsync|nc|ssh)\b/, '网络外发 / 远程访问'],
  [/\b(npm|pnpm|yarn|pip3?|brew|cargo|gem)\s+(i|install|add|uninstall|remove)\b/, '安装/卸载依赖'],
  [/\bsecurity\s+(find|dump)-/, '读取钥匙串'],
  [/\bdocker\s+(rm|rmi|system\s+prune)/, '删除容器/镜像'],
];

const SAFE_CMD = /^\s*(ls|pwd|cat|head|tail|wc|grep|rg|find|echo|git\s+(status|diff|log|show|branch)|node\s+(-v|--version)|npm\s+(test|run\s+(test|lint|build|typecheck))|pnpm\s+(test|run)|yarn\s+(test|run)|python3?\s+-m\s+(pytest|unittest)|pytest|go\s+(test|build|vet)|cargo\s+(test|build|check)|tsc(\s|$)|make\s+test)\b/;

/** Commands that only look (no files written, nothing started) — they need no write lock and leave no side effects. */
const LOOK_CMD = /^\s*(ls|pwd|cat|head|tail|wc|grep|rg|find|echo|which|file|stat|du|tree|git\s+(status|diff|log|show|branch|rev-parse|ls-files|blame)|node\s+(-v|--version)|npm\s+(ls|view|-v)|python3?\s+--version)\b/;

export function isLookCommand(cmd: string): boolean {
  const parts = splitCommand(cmd);
  return parts.length > 0 && !/[`>]|\$\(/.test(cmd) && parts.every((p) => LOOK_CMD.test(p) && !/\s-(exec|delete)\b/.test(p));
}

export function classifyCommand(cmd: string): { high: boolean; reason: string; safe: boolean; release: boolean } {
  // any non-release high-risk part wins; `release` only when the risky parts are all release / deploy steps
  let release = '';
  for (const p of [cmd, ...splitCommand(cmd)]) {
    const hi = HIGH_RISK_CMD.find(([re]) => re.test(p));
    if (hi) return { high: true, reason: hi[1], safe: false, release: false };
    release ||= RELEASE_CMD.find(([re]) => re.test(p))?.[1] ?? '';
  }
  if (release) return { high: true, reason: `发版/部署：${release}`, safe: false, release: true };
  return { high: false, reason: '', safe: SAFE_CMD.test(cmd) && !/[;&|`$><]/.test(cmd.replace(/\s2>&1\s*$/, '')), release: false };
}

/** Split a shell line into simple commands on && || ; | and newlines (quotes are not parsed — conservative). */
export function splitCommand(cmd: string): string[] {
  return cmd
    .split(/&&|\|\||;|\||\n/)
    .map((p) => p.trim())
    .filter(Boolean);
}

/** How many leading words name a command for an always-allow rule (`npm run build`, `git commit`, `pytest`). */
const ARITY: Record<string, number> = {
  git: 2, npm: 2, pnpm: 2, yarn: 2, bun: 2, npx: 2, pnpx: 2, bunx: 2, deno: 2, cargo: 2, go: 2, make: 2, cmake: 2, docker: 2, kubectl: 2, brew: 2,
  pip: 2, pip3: 2, poetry: 2, uv: 2, swift: 2, dotnet: 2, mvn: 2, gradle: 2, './gradlew': 2, gh: 3, node: 2, python: 2, python3: 2, ruby: 2, php: 2,
  java: 2, vitest: 2, xcodebuild: 1, tsc: 1, eslint: 1, prettier: 1, jest: 1, pytest: 1, ls: 1, cat: 1, echo: 1,
  'npm run': 3, 'pnpm run': 3, 'yarn run': 3, 'bun run': 3, 'npm exec': 3, 'docker compose': 3, 'python -m': 3, 'python3 -m': 3, 'uv run': 3, 'poetry run': 3, 'go run': 3, 'cargo run': 2,
};

/** The rule prefix of one simple command, or null when it can't be allowed by rule (subshells, empty). */
export function commandPrefix(part: string): string | null {
  if (/`|\$\(/.test(part)) return null;
  const words = part.trim().split(/\s+/).filter((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w));
  if (!words.length) return null;
  const two = words.length > 1 ? `${words[0]} ${words[1]}` : '';
  const n = (two && ARITY[two]) || ARITY[words[0]] || 1;
  return words.slice(0, n).join(' ');
}

/** Rule keys an approval of `tool` would grant (every key must be allowed for a later call to skip asking). */
export function ruleFor(tool: string, args: Record<string, unknown>): { keys: string[]; label: string } | null {
  if (tool === 'run_command') {
    const parts = splitCommand(String(args.command ?? ''));
    const prefixes = parts.map(commandPrefix);
    if (!parts.length || prefixes.some((p) => p === null)) return null;
    const uniq = [...new Set(prefixes as string[])];
    return { keys: uniq.map((p) => `cmd:${p}`), label: uniq.map((p) => `「${p}」`).join('、') + ' 开头的命令' };
  }
  if (tool === 'write_file' || tool === 'edit_file') return { keys: ['tool:write'], label: '写入 / 编辑文件' };
  if (tool.startsWith('mcp__')) {
    const [, server, name] = tool.split('__');
    return { keys: [`mcp:${server}/${name}`], label: `MCP 工具 ${server} / ${name}` };
  }
  return null;
}

export const allowedByRules = (keys: string[], rules: AllowRule[]) => keys.length > 0 && keys.every((k) => rules.some((r) => r.key === k));

/** Permission mode inside one exec node after the emperor's grant. */
export function effectiveMode(mode: PermissionMode, grant?: NodeGrant): PermissionMode {
  if (grant === 'readonly') return 'readonly';
  if (grant === 'write_free') return 'auto';
  if (grant === 'write' && mode === 'readonly') return 'ask';
  return mode;
}

export function decide(mode: PermissionMode, cls: ToolClass, opts: { command?: string; sensitive?: boolean; deleting?: boolean } = {}): RiskVerdict {
  if (cls === 'meta') return { decision: 'allow', risk: 'normal', reason: '' };
  if (cls === 'read') {
    if (opts.sensitive) return { decision: 'ask', risk: 'high', reason: '读取可能含密钥的敏感文件，内容会发送给模型服务' };
    return { decision: 'allow', risk: 'normal', reason: '' };
  }
  if (mode === 'readonly') return { decision: 'deny', risk: 'normal', reason: '只读模式禁止写入与执行命令' };
  if (cls === 'write') {
    if (opts.deleting) return { decision: 'ask', risk: 'high', reason: '删除文件' };
    if (opts.sensitive) return { decision: 'ask', risk: 'high', reason: '改写敏感文件' };
    if (mode === 'ask') return { decision: 'ask', risk: 'normal', reason: '写入文件（询问模式）' };
    return { decision: 'allow', risk: 'normal', reason: '' };
  }
  // command
  const c = classifyCommand(opts.command ?? '');
  if (c.high) return { decision: 'ask', risk: 'high', reason: c.release ? c.reason : `高风险命令：${c.reason}` };
  if (mode === 'auto') return { decision: 'allow', risk: 'normal', reason: '' };
  if (mode === 'auto-edit' && c.safe) return { decision: 'allow', risk: 'normal', reason: '' };
  return { decision: 'ask', risk: 'normal', reason: '执行命令' };
}

export const PERMISSION_LABEL: Record<PermissionMode, string> = {
  readonly: '只读（仅查看）',
  ask: '询问（写入与命令均需批准）',
  'auto-edit': '自动编辑（写文件自动，命令需批准，安全命令放行）',
  auto: '全自动（高风险仍须批准）',
};
