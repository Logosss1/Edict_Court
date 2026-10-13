// 设置中心: page registry (left nav groups, icons, search keywords).
import type { SettingsSection } from '../store';

export interface SectionInfo {
  id: SettingsSection;
  label: string;
  icon: string;
  /** extra words the settings search matches */
  keywords: string;
  /** shows a 新 tag in the nav (2.0 additions) */
  isNew?: boolean;
}

export const SETTINGS_GROUPS: { title: string; items: SectionInfo[] }[] = [
  {
    title: '通用',
    items: [
      { id: 'appearance', label: '外观与通知', icon: 'sparkles', keywords: '主题 深色 浅色 跟随系统 通知 提醒 桌面通知 输入框' },
      { id: 'storage', label: '存储与备份', icon: 'db', keywords: '数据目录 SQLite edict.db 备份 迁移 1.x 导出 磁盘 API Key 加密', isNew: true },
    ],
  },
  {
    title: '模型',
    items: [
      { id: 'providers', label: '模型服务', icon: 'cpu', keywords: '模型 服务商 API Key base_url 协议 OpenAI Anthropic Responses 测试连接 协议探测 思考' },
      { id: 'routing', label: '官员模型与路由', icon: 'users', keywords: '强模型 经济模型 路由 官员 独立模型 思考程度' },
    ],
  },
  {
    title: '运行',
    items: [
      { id: 'runtime', label: '运行策略', icon: 'zap', keywords: '预算 token 费用上限 封驳上限 审批门 方案御览 御批 议政 并行度 压缩 请旨 超时' },
      { id: 'permissions', label: '权限与审批', icon: 'shield', keywords: '权限模式 只读 询问 自动编辑 全自动 写任务 允许规则 本工作区永久 发版 部署 续跑 超时 请旨 太子追问', isNew: true },
      { id: 'canon', label: '典章', icon: 'rules', keywords: '项目规约 AGENTS.md CLAUDE.md rules.md 禁止 规矩 偏好 教训 封驳', isNew: true },
    ],
  },
  {
    title: '扩展',
    items: [
      { id: 'mcp', label: '连接服务', icon: 'plug', keywords: 'MCP 外部工具 服务 登录 OAuth 资源 提示词 mcp.json 信任 远程 本地' },
      { id: 'skills', label: '技能', icon: 'puzzle', keywords: '技能 SKILL.md 职责 另配 装备 官员 更新 导入' },
      { id: 'lsp', label: '语言服务', icon: 'code', keywords: 'LSP 语言服务器 诊断 跳转定义 typescript pyright gopls rust-analyzer 安装', isNew: true },
      { id: 'acp', label: '编辑器接入', icon: 'link', keywords: 'ACP 编辑器 socket 接入 外部编辑器', isNew: true },
      { id: 'worktrees', label: '工作树', icon: 'branch', keywords: 'git worktree 工作树 分支 结案 合并 丢弃 保留', isNew: true },
    ],
  },
  {
    title: '记录',
    items: [
      { id: 'audit', label: '审计日志', icon: 'shield', keywords: '审计 日志 防篡改 校验' },
      { id: 'help', label: '使用说明', icon: 'help', keywords: '帮助 说明 快捷键 功能介绍' },
    ],
  },
];

export const SECTIONS: SectionInfo[] = SETTINGS_GROUPS.flatMap((g) => g.items);
