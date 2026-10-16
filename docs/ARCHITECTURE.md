# 架构

```
┌──────────────────────── Renderer（sandbox, contextIsolation）────────────────────────┐
│  工作台（React）               朝堂（Phaser 3 + React 浮层）                           │
│  Monaco · xterm · 面板          十个俯视像素场景与宫城舆图                              │
│  设置中心（settings/）· 待办 · 看板 · Agent 栏决策卡 / 方案卡 · 结案对话框            │
│            └──────────── 同一个 store（主进程事件的投影）────────────┘               │
└───────────────────────────── preload: window.edict.invoke / onEvent ──────────────────┘
                                        │ IPC（白名单 API：src/main/api.ts）
┌──────────────────────────────── Main process ────────────────────────────────────────┐
│ Runtime（src/main/runtime/runtime.ts） 唯一状态源：tasks / agents / debates / approvals │
│  ├─ stateMachine.ts   受保护状态流转（Edict STATE_TRANSITIONS + 档位边 + 仅皇上可执行边）│
│  ├─ orchestrator.ts   状态驱动 + 节点化的三省六部引擎（submit / drive / decideGate）    │
│  ├─ flow.ts           协同设计解释器                                                    │
│  ├─ execPolicy.ts     子任务调度（只读并行 / 写入独占）、写任务审批、成果核验           │
│  ├─ agentLoop.ts      LLM ⇄ 工具循环：检查点、朱批注入、压缩、重试、记账                │
│  ├─ tools.ts          工具 + 权限（permissions.ts）+ 路径边界（services/workspace.ts）   │
│  ├─ worktrees.ts      每道旨意一个 git 工作树                                           │
│  ├─ sqliteStore.ts    edict.db（node:sqlite、WAL）；storage.ts 备份                     │
│  └─ persist.ts        SHA-256 哈希链审计、内容寻址快照、JSONL 活动流                    │
│ MCP（src/main/mcp）· LSP（src/main/lsp）· ACP（src/main/acp）· 客卿（src/main/guests） │
│ LLM adapters（src/main/llm）：OpenAI Chat / Anthropic Messages / OpenAI Responses（SSE）│
│ Services：workspace、exec、git、worktree、shadowSnapshot、sandbox、web、search、terminal│
└──────────────────────────────────────────────────────────────────────────────────────┘
```

## 状态机

与 EDICT `task.py` 的 `STATE_TRANSITIONS` 一致，另加两处收紧：只有 Solo 允许 `Pending → Doing`；结案和取消只有皇上能做，Agent 或系统尝试一律拒绝并写入审计。中书省到尚书省唯一的路是 `Zhongshu → Menxia → Assigned`，门下省结论无法解析时升级为御裁，不默认放行。

## 节点化编排

每一步都是持久化的 `RunNode`（分拣、议政、规划、审议、派发、执行、汇总、成果审议等），记录模型、尝试次数、用量与结构化输出。`drive(task)` 按当前状态和已完成节点决定下一步：已完成节点不重放；节点失败或应用重启时旨意进入 `Blocked`；局部重试只重跑该节点。

执行阶段按子任务依赖调度：只读子任务并行（默认 3 路），写入与验证子任务单独执行，同一道旨意同时只有一个写入者。有独立工作树的旨意之间互不排队。

## Court Lite 与 Full Court

| 步骤 | Lite | Full |
|---|---|---|
| 太子分拣 | ✓ | ✓ |
| 规划前细问 | ✓ | ✓ |
| 朝堂议政 | — | 可选 |
| 中书规划 | 1–3 子任务 | 2–6 子任务 |
| 门下审议 | 封驳上限 1 | 封驳上限 3 |
| 方案御览 | 可选（默认关） | 可选（默认关） |
| 尚书派发 | 省略 | ✓ |
| 六部执行 | ✓ | ✓ 并行 |
| 对照检查 | ✓ | ✓ |
| 皇上御批 | ✓（可关） | ✓ |

## Agent 循环

每次模型调用前检查叫停、预算和取消，注入未读朱批与口谕，上下文过长时先缩短旧工具结果再滚动压缩。429 / 5xx / 网络错误按 `Retry-After` 或指数退避重试；配置、鉴权、额度类错误不重试，直接给出可读的错误卡和「换模型重试」。同一工具相同参数反复调用时提醒并请示；编辑已有文件前必须先读过。六部以结构化 JSON 结论收尾，系统用磁盘上的真实文件核验声称的产物。

## 规划与审议

- **细问**（`grill.ts`）：第一次规划前，规划官员一轮轮提问，每题带推荐答案；问答纪要确认后注入后续每一步。
- **口谕**（`oral.ts`）：执行中追加的指示，正在干活的官员下一步读到。
- **忠于旨意**（`faithful.ts`）：不许改动旨意重点，字数按约数，对照检查只比成品与旨意。
- **审议**：门下意见分必改 / 建议，只有必改能封驳。
- **需求对照**（`requirements.ts`）：规划先写需求说明与验收标准，执行后逐条对照，未满足的发回补办。

## Token 与模型参数

- 分级路由：规划、审议、Solo 走强模型，其余走经济模型；每位官员可单独指定模型。
- 上下文预算：仓库地图与符号大纲代替整份源码；系统提示按官员固定，便于缓存。
- 预算：每道旨意的 Token / 费用上限，0 为不限，超限时进入预算关卡。
- 思考程度（`shared/reasoning.ts`）：固定六档，按模型检测到的档位阶梯就近对应；服务拒绝参数时去掉重试。
- 回答参数（`shared/sampling.ts`）：Temperature、Top P、两个惩罚参数，官员设置优先于模型设置。

## 执行与权限

- 写任务开工前发审批卡；操作按风险允许 / 询问 / 拒绝，允许规则可按旨意或工作区保存。发版、部署命令每次都问。
- 成果核验不采信自报：产物不存在或写任务没有改动时标为成果存疑。
- 命令改动快照（`shadowSnapshot.ts`）：`run_command` 前后各做一次影子 git 快照，改动可撤回、可撤回并重做。
- 命令沙箱（`sandbox.ts`）：macOS `sandbox-exec`，被拦下时发决策卡。
- 联网（`web.ts`、`search.ts`）：只抓公网地址，逐跳检查重定向。
- 请旨与典章：官员可带选项向皇上提问；项目规约文件和典章注入规划、审议与执行。
- 技能：37 个内置技能，每位官员有固定的职责技能，其余按官员另配。

## 旨意工作树

协同旨意在有提交的 git 仓库里会建 `edict/<旨意号>` 分支和独立工作树，工具、预览、语言服务与终端都指向它。结案时选合并 / 保留分支 / 丢弃。「设置 › 工作树」可配置复制文件、链接依赖、准备脚本和端口块（`worktreeSetup.ts`）。同一子任务可排两三路并行尝试（`attempts.ts`、`attemptRun.ts`），门下省评比后合并选中的一路。

## 协同设计

`CollabDesign`（`shared/design.ts`）= 角色 + 步骤 + 规则 + 可选的朝堂站位。`validateDesign` 保证没有绕过门下省的路径。设计按版本存放在 `<dataDir>/designs/`，旨意下达时固定版本；内置三省六部只读。

## 存储

`edict.db` 用 Electron 自带的 `node:sqlite`，任务、议政、会话、奏折等各一张表，设置放在 `kv` 表，表结构通过只增的迁移列表演进。运行时只标记改动，250 ms 后在一个事务里写入。「立即备份」用 `VACUUM INTO` 生成 `backups/edict-<时间>.db`。审计、活动流和快照是数据库旁边的文件。

## MCP、LSP、ACP 与客卿

- **MCP**：stdio、Streamable HTTP 与旧版 SSE；tools、resources、prompts 与远程服务 OAuth 登录；按官员授权。
- **LSP**：在本机查找 24 种常见语言服务器（不自动安装），给编辑器诊断和官员的 `lsp` 工具。
- **ACP**：编辑器经本机 Unix 套接字下旨，每个编辑器首次连接须批准。
- **客卿**：支持 ACP 的外部编程智能体可承办子任务，只在旨意工作树里工作，请求经 Edict 的权限与沙箱；起不来时由本部官员接手。

## 定时旨意

`scheduler.ts` 每 30 秒检查到点的定时旨意，按排定时的文件夹、模式与权限直接下旨，错过的补跑一次。官员可用 `propose_schedule` 提议，由皇上准奏。

## 两种模式的同步与像素朝堂

渲染进程只有一个 store，是主进程事件流的投影，工作台与朝堂都从它读取、经同一组 IPC 下达命令。朝堂按官员状态播放动作（思考、撰写、请旨下跪、封驳等），按本地时间切换早朝、办公与夜间。

Phaser 3：`pixelArt`、640×360 世界、整数倍缩放，美术按 2 倍精度绘制。十个场景全部由代码绘制，每个场景一个模块 `scripts/pixel/td/<key>.mjs`（接口见 `scripts/pixel/td/SPEC.md`），`npm run assets` 生成 `assets/pixel/` 下的位图与热点数据，并检查每个场景不超过 Tang48 调色板的 48 色。
