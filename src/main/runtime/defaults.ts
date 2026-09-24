import type { Settings, Template } from '../../shared/types';

export function defaultSettings(): Settings {
  return {
    permissionMode: 'auto-edit',
    defaultTier: 'lite',
    multiAgent: true,
    routing: { strong: null, economy: null },
    agentModels: {},
    budgets: { solo: 300_000, lite: 600_000, full: 1_500_000 },
    maxCostUsd: 0,
    maxRejections: { lite: 1, full: 3 },
    planGate: { lite: false, full: true },
    finalGate: true,
    debateBeforePlan: false,
    debateRounds: 2,
    parallelism: 3,
    contextWindowTokens: 64_000,
    newsFeeds: [],
    theme: 'system',
    lastWorkspace: null,
    composerHidden: false,
    language: 'zh',
  };
}

// 旨库 — adapted from Edict's 9 preset edict templates, tuned for a coding workstation.
export const TEMPLATES: Template[] = [
  { id: 'tpl-code-review', cat: '工程开发', icon: '🔍', name: '代码审查', desc: '对指定文件/目录进行质量审查，输出问题清单和改进建议', depts: ['兵部', '刑部'], tier: 'lite',
    params: [ { key: 'target', label: '文件/目录路径', type: 'text', required: true, default: '.' }, { key: 'focus', label: '重点关注', type: 'text', default: '安全漏洞,错误处理,性能' } ],
    command: '对 {target} 进行代码审查，重点关注：{focus}。输出问题清单（含文件与行号）和改进建议，写入 REVIEW.md' },
  { id: 'tpl-feature', cat: '工程开发', icon: '⚡', name: '功能开发', desc: '从需求到实现、测试、文档一条龙', depts: ['中书省', '兵部', '刑部', '礼部'], tier: 'full',
    params: [ { key: 'requirement', label: '需求描述', type: 'textarea', required: true }, { key: 'tests', label: '测试要求', type: 'select', options: ['补充单元测试', '仅手动验证', '无需测试'], default: '补充单元测试' } ],
    command: '实现以下功能：{requirement}。测试要求：{tests}。完成后更新相关文档。' },
  { id: 'tpl-bugfix', cat: '工程开发', icon: '🐛', name: 'Bug 修复', desc: '定位并修复缺陷，附复现与回归验证', depts: ['兵部', '刑部'], tier: 'lite',
    params: [ { key: 'symptom', label: '现象描述', type: 'textarea', required: true }, { key: 'where', label: '可能位置（可选）', type: 'text' } ],
    command: '修复缺陷：{symptom}。可能位置：{where}。先复现，再修复，最后运行测试验证。' },
  { id: 'tpl-api-design', cat: '工程开发', icon: '🧩', name: 'API 设计与实现', desc: 'RESTful API 设计、实现、测试', depts: ['中书省', '兵部'], tier: 'full',
    params: [ { key: 'requirement', label: '需求描述', type: 'textarea', required: true }, { key: 'tech', label: '技术栈', type: 'select', options: ['Node/Express', 'Python/FastAPI', 'Go/Gin'], default: 'Node/Express' }, { key: 'auth', label: '鉴权方式', type: 'select', options: ['JWT', 'API Key', '无'], default: 'JWT' } ],
    command: '设计并实现一个 {tech} 的 RESTful API：{requirement}。鉴权方式：{auth}。包含测试。' },
  { id: 'tpl-tests', cat: '工程开发', icon: '🧪', name: '补齐测试', desc: '为指定模块补充单元测试并运行', depts: ['刑部'], tier: 'lite',
    params: [ { key: 'target', label: '模块路径', type: 'text', required: true } ],
    command: '为 {target} 补充单元测试，覆盖主要分支与边界条件，并运行测试确认通过。' },
  { id: 'tpl-deploy', cat: '基建运维', icon: '🚀', name: '部署方案', desc: '生成部署检查单、Docker 配置、CI/CD 流程', depts: ['兵部', '工部'], tier: 'lite',
    params: [ { key: 'project', label: '项目名称/描述', type: 'text', required: true }, { key: 'env', label: '部署环境', type: 'select', options: ['Docker', 'K8s', 'VPS', 'Serverless'], default: 'Docker' }, { key: 'ci', label: 'CI/CD 工具', type: 'select', options: ['GitHub Actions', 'GitLab CI', '无'], default: 'GitHub Actions' } ],
    command: '为项目「{project}」生成{env}部署方案，CI/CD 使用{ci}，产出配置文件与部署说明。' },
  { id: 'tpl-docs', cat: '文档报告', icon: '📝', name: '项目文档', desc: '梳理项目结构并生成 README/架构说明', depts: ['礼部'], tier: 'lite',
    params: [ { key: 'audience', label: '目标读者', type: 'text', default: '新加入的开发者' } ],
    command: '梳理本项目的入口、主要模块与测试方式，面向{audience}写一份带源码依据的 ARCHITECTURE.md。' },
  { id: 'tpl-weekly-report', cat: '文档报告', icon: '📊', name: '周报生成', desc: '基于 Git 记录与看板产出，生成结构化周报', depts: ['户部', '礼部'], tier: 'lite',
    params: [ { key: 'range', label: '报告周期', type: 'text', default: '最近 7 天' }, { key: 'focus', label: '重点关注', type: 'text', default: '项目进展,下周计划' } ],
    command: '根据 git log 与现有文档生成{range}的周报，重点覆盖{focus}，写入 reports/weekly.md' },
  { id: 'tpl-standup', cat: '日常办公', icon: '🗓️', name: '每日站会摘要', desc: '汇总今日进展和待办', depts: ['尚书省'], tier: 'solo',
    params: [ { key: 'range', label: '汇总范围', type: 'select', options: ['今天', '最近24小时', '昨天+今天'], default: '今天' } ],
    command: '汇总{range}的 git 提交与未完成事项，生成站会摘要。' },
];

export const BUILTIN_SKILLS: { name: string; description: string; agents: string[] | 'all'; content: string }[] = [
  {
    name: 'code-review-checklist',
    description: '代码审查清单：正确性、边界、错误处理、安全、性能、可读性',
    agents: ['menxia', 'xingbu', 'bingbu'],
    content: `# 代码审查清单\n1. 正确性：逻辑与需求一致；边界条件（空值、越界、并发）。\n2. 错误处理：异常路径可观测、不吞错。\n3. 安全：输入校验、注入、路径穿越、密钥泄露。\n4. 性能：复杂度、N+1、无界内存。\n5. 可读性：命名、函数粒度、注释只解释为什么。\n6. 测试：新增逻辑有测试，失败用例可复现。`,
  },
  {
    name: 'test-writing',
    description: '编写测试：先写失败用例、覆盖边界、运行并报告结果',
    agents: ['xingbu', 'bingbu', 'solo'],
    content: `# 测试编写规范\n- 先识别项目现有测试框架（package.json / pytest.ini / go test）。\n- 先写能暴露问题的失败用例，再修复。\n- 覆盖：正常路径、边界、错误路径。\n- 必须实际运行测试命令，并在结论中给出命令与结果摘要。`,
  },
  {
    name: 'commit-message',
    description: '约定式提交信息（Conventional Commits）规范',
    agents: ['libu', 'gongbu', 'solo'],
    content: `# 提交信息规范\n格式：type(scope): subject\ntype ∈ feat fix docs refactor test chore build ci perf\nsubject ≤ 50 字符，祈使句；正文说明为什么改。`,
  },
];
