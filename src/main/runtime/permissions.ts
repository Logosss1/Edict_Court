// Permission & risk policy for agent tools. High-risk operations ALWAYS need the emperor's
// confirmation regardless of permission mode; read-only mode forbids writes/commands entirely.
import type { PermissionMode } from '../../shared/types';

export type ToolClass = 'read' | 'write' | 'command' | 'meta';

export interface RiskVerdict {
  decision: 'allow' | 'ask' | 'deny';
  risk: 'normal' | 'high';
  reason: string;
}

const HIGH_RISK_CMD: [RegExp, string][] = [
  [/\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r|-r|-R)\b/, '递归删除文件'],
  [/\bsudo\b|\bsu\s/, '提权执行'],
  [/\bgit\s+push\b/, '推送到远程仓库'],
  [/\bgit\s+(reset\s+--hard|clean\s+-[a-z]*f|checkout\s+--\s|restore\s+\.|branch\s+-D)/, '可能丢弃未提交修改'],
  [/\b(curl|wget)\b[^|]*\|\s*(sh|bash|zsh|python)/, '下载并执行远程脚本'],
  [/\b(npm|pnpm|yarn)\s+publish\b/, '发布软件包'],
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

export function classifyCommand(cmd: string): { high: boolean; reason: string; safe: boolean } {
  for (const [re, why] of HIGH_RISK_CMD) if (re.test(cmd)) return { high: true, reason: why, safe: false };
  return { high: false, reason: '', safe: SAFE_CMD.test(cmd) && !/[;&|`$><]/.test(cmd.replace(/\s2>&1\s*$/, '')) };
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
  if (c.high) return { decision: 'ask', risk: 'high', reason: `高风险命令：${c.reason}` };
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
