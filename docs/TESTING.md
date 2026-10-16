# 测试与验证

自动化测试中的模型回复全部来自 mock，结果不等于真实模型下的验收。

## 运行方法
```bash
npm test                                  # 单元 + 集成：tests/*.test.ts
npm run typecheck                         # 类型检查，覆盖 src/
npm run build                             # E2E 启动的是 dist/，先构建
xvfb-run -a npx tsx e2e/flow.ts           # 主流程（= npm run e2e）
xvfb-run -a npx tsx e2e/features.ts       # 功能（= npm run e2e:features）
xvfb-run -a npx tsx e2e/court-smoke.ts    # 朝堂冒烟
xvfb-run -a npx tsx e2e/smoke.ts          # 启动冒烟
```
- `e2e/features.ts` 可用 `ONLY=` 只跑部分段（逗号分隔）：`effort`、`error`、`preview`、`mcp`、`designs`、`designer`、`manage`、`tips`、`sidebar`、`worktree`、`v21`、`sched`、`oral`、`lanes`、`grill`、`budget`、`pane`。
- 截图目录由 `SHOTS` 指定，`flow.ts` 与 `features.ts` 默认写进 `docs/screenshots/`（会覆盖仓库里的截图，结果 json 不提交）。每个脚本都用临时数据目录，不碰你的数据。
- 2.1.1 的结果（Linux + Xvfb）：单元 + 集成 284 项通过，2 项只在 macOS 上运行的真实沙箱测试跳过；`flow.ts` 22/22；`features.ts` 142/142。

## 单元与集成测试
- `tests/mockLlm.ts` 是按角色脚本化回复的 HTTP 服务，逐字节输出 OpenAI Chat、Anthropic Messages、OpenAI Responses 三种 SSE 流，测试走真实线协议。
- 覆盖：状态机与编排（封驳、局部重试、重启恢复、预算关卡）、权限与路径边界、执行层与命令快照、SQLite 存储、协同设计、思考程度与回答参数、HTML 预览、MCP（真实子进程与本地 HTTP 服务、OAuth 假授权服务器）、LSP（假语言服务器）、ACP、技能、旨意工作树（真实 git）、联网与搜索、命令沙箱、需求对照、定时旨意、客卿（按 ACP 写的测试程序）与排班。
- 真实 `sandbox-exec` 测试只在 macOS 上运行；本机装有 `pyright-langserver` 时另跑真实语言服务器。

## 端到端 UI
用 Playwright 驱动真实 Electron（Linux 下在 Xvfb 里）：`flow.ts` 走一遍下旨、审批、结案、编辑器、终端、搜索、朝堂批阅与议政；`features.ts` 按段覆盖各项功能，最后检查 API Key 没有落盘、前端没有运行时错误；`court-smoke.ts` 检查朝堂场景与行走路线。

## 真实模型
```bash
EDICT_BASE_URL=https://api.deepseek.com EDICT_API_KEY=sk-... EDICT_MODEL=deepseek-chat \
EDICT_PROTOCOL=openai-chat EDICT_TIER=lite npx tsx scripts/verify-real.ts
```
在本机用你自己的 Key 执行，完成后检查真实产物、节点记录与审计链。

## 安装包
`python3 scripts/verify-dmg.py <dmg> <stage>` 检查在 Linux 上打出的 DMG：可执行位、框架符号链接、Applications 链接，以及主程序与已签名副本逐字节一致。
