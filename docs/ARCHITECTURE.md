# 架构

```
┌──────────────────────── Renderer（sandbox, contextIsolation）────────────────────────┐
│  工作台（React）               朝堂（Phaser 3 + React 浮层）                           │
│  Monaco · xterm · 面板          太和殿 / 军机处 / 六部值房 / 承天门                    │
│  设置中心（settings/）· 待办 · 看板 · Agent 栏决策卡 / 方案卡 · 结案对话框            │
│            └──────────── 同一个 store（主进程事件的投影）────────────┘               │
└───────────────────────────── preload: window.edict.invoke / onEvent ──────────────────┘
                                        │ IPC（白名单 API：src/main/api.ts）
┌──────────────────────────────── Main process ────────────────────────────────────────┐
│ Runtime（src/main/runtime/runtime.ts） 唯一状态源：tasks / agents / debates / approvals │
│  ├─ stateMachine.ts   受保护状态流转（Edict STATE_TRANSITIONS + 档位边 + 仅皇上可执行边）│
│  ├─ orchestrator.ts   状态驱动 + 节点化的三省六部引擎（submit / drive / decideGate）    │
│  ├─ execPolicy.ts     子任务效果调度（只读并行 / 写入独占）、写任务审批、成果核验       │
│  ├─ agentLoop.ts      LLM ⇄ 工具循环：检查点、朱批注入、滚动压缩、重试、流式活动、记账  │
│  ├─ tools.ts          工具 + 权限（permissions.ts）+ 路径边界（services/workspace.ts）   │
│  ├─ worktrees.ts      每道旨意一个 git 工作树、结案 合并 / 保留分支 / 丢弃、手动工作树   │
│  ├─ canon.ts · askEmperor.ts  项目规约与典章注入 · 请旨（ask_emperor）                  │
│  ├─ debate.ts         朝堂议政（插话 → 待回应队列）                                     │
│  ├─ sqliteStore.ts    edict.db（node:sqlite、WAL、写后合并）与 1.x 迁移；storage.ts 备份│
│  ├─ persist.ts        SHA-256 哈希链审计、内容寻址快照、JSONL 活动流                    │
│  └─ extras.ts         技能（SKILL.md，内置技能包 builtinSkills.ts）、天下要闻           │
│ MCP（src/main/mcp）：client.ts（JSON-RPC：stdio / Streamable HTTP / 旧版 SSE）         │
│                      manager.ts（mcp.json、信任、策略、密钥、工具暴露 mcp__服务__工具）  │
│                      oauth.ts（远程服务登录）· resourceTools.ts · refs.ts（@mcp 引用）  │
│ LSP（src/main/lsp）：detect / registry（找本机语言服务器）· client · manager · tool     │
│ ACP（src/main/acp）：server（Unix 套接字）· agent（协议）· runtimeHost（旨意 ⇄ 会话）   │
│                      编辑器侧桥接：src/acp-bridge/bridge.ts（stdio ⇄ 套接字）            │
│ 预览：services/preview.ts（preview://ws、wt-<id> 只读文件服务）· previewHost.ts（分区、 │
│       webview、离屏截图）· previewActions.ts（交互步骤）→ Agent 工具 preview_page       │
│ LLM adapters（src/main/llm）：OpenAI Chat / Anthropic Messages / OpenAI Responses（SSE）│
│ Services：workspace（边界）、exec、git、worktree、shadowSnapshot（命令改动快照）、       │
│           terminal（BSD/util-linux `script` PTY）                                      │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

## 状态机

与 Edict `edict/backend/app/models/task.py` 的 `STATE_TRANSITIONS` 保持一致，并做两处收紧：

- **档位边**：只有 Solo 允许 `Pending → Doing`。
- **仅皇上可执行**：`PendingConfirm → Done`（结案）、`Doing → Cancelled`、`Menxia → Cancelled`。Agent 或系统尝试这些流转一律拒绝并写入审计（`transition_rejected`）。

中书省到尚书省唯一的路是 `Zhongshu → Menxia → Assigned`；`Menxia → Assigned` 只在门下省准奏、或皇上在关卡上亲自准奏时发生。门下省结论无法解析时**不会默认放行**，而是升级为御裁关卡。

## 节点化编排（局部恢复的基础）

每一步都是持久化的 `RunNode`（`triage / debate / plan / review / dispatch / exec / summary / result_review / solo`），带 run ID、模型、协议、尝试次数、退出状态、用量与结构化输出。`drive(task)` 根据**当前状态 + 已完成节点**决定下一步：

- 已完成节点永不重放；
- 节点失败（重试 3 次仍失败 / 自报失败）→ 旨意进入 `Blocked`，记录 `resumeState`；
- 应用重启时运行中的节点标为 `interrupted`，旨意进入 `Blocked`；
- 「局部重试」只把该节点置回 `pending`，从 `Blocked` 流转回 `resumeState`，引擎继续——其它节点的输出直接复用。

执行阶段按子任务依赖图调度（`execPolicy.scheduleExec`）：只读子任务并行（并行度可配，默认 3），写入与验证子任务等前面的跑完后单独执行，同一道旨意同一时间只有一个写入者（写锁）。同一官员一次只办一件事（每 Agent 互斥锁，保证可观测性真实）。有独立工作树的旨意互不排队；没有工作树的旨意仍是同一工作区同时只有一个在执行（其余进入 `Next` 排队）。节点有墙钟时限（默认 30 分钟）；重启后没有改动过任何东西的节点自动续跑，其它节点照旧阻塞等你处理。

## Court Lite vs Full Court

| 步骤 | Lite | Full |
|---|---|---|
| 太子分拣 | ✓（经济模型） | ✓ |
| 朝堂议政 | — | 可选（规划前） |
| 中书规划 | ✓ 1–3 子任务 | ✓ 2–6 子任务 |
| 门下审议 | ✓ 封驳上限 1 | ✓ 封驳上限 3 |
| 方案御览（可涂改） | 可选（默认关） | 默认开 |
| 尚书派发 | 省略（仍经过 `Assigned` 以保持状态机合法） | ✓ 执行令 |
| 六部执行 | ✓ | ✓ 并行 |
| 尚书汇总回奏 | ✓ | ✓ |
| 门下审议成果（可发回返工） | — | ✓ |
| 皇上御批结案 | ✓（可关） | ✓ |

## Agent 循环（agentLoop.ts）

每次模型调用前：`checkpoint`（叫停 / 预算门 / 取消）→ 注入未读朱批（要求回复开头回应，回应写入审计）→ 超过窗口 60% 时滚动压缩（保留原始目标锚点 + 最近 6 条）→ 调用（空闲超时 120s，429/5xx/网络错误指数重试）。工具结果截断到 12k 字符；`read_file` 默认 400 行；六部最终必须以结构化 JSON 结论收尾，系统再用磁盘上的真实文件哈希核验其声称的产物。

2.0 起：429 / 5xx 按 `Retry-After` 或指数退避重试；上下文超长时裁剪旧工具结果、压缩后重试一次；对话超过窗口 40% 时先把较早的大段工具结果缩短（保留最近 8 条，技能正文不裁剪），再按原规则压缩；同一工具以相同参数连续调用第 3 次时提醒、第 4 次起请示皇上；同一轮里相邻的只读工具调用并行执行；编辑或覆盖已有文件前必须在本轮读过它，且读后未被改动。

## Token 经济性

- 分级路由：中书 / 门下 / Solo 走强模型，分拣 / 派发 / 六部 / 议政走经济模型；每位官员可独立热切换。
- 上下文预算：仓库地图（≤120 行）+ 符号大纲（≤30 文件）代替源码；工具按需读取。
- 缓存友好：系统提示按官员固定（无时间戳 / 任务数据），Anthropic 请求附 `cache_control`。
- 预算：每旨 Token / 费用上限，超限进入「预算关卡」由皇上追加或取消；封驳上限超限升级御裁。
- 统计：每次调用记录 input / output / cached / cost（未上报用量时按内容估算并标注）；每任务、每官员、全局实时显示；下旨前按档位预估。

## 两种模式的同步

渲染进程只有一个 store，它是主进程 `RuntimeEvent` 流的投影；工作台与朝堂都从它读取、都通过同一组 IPC 方法下达命令。像素场景的 `sync(model)` 在每次状态变化时把官员动画映射为：思考→`think`、撰写→`talk`、调用工具→`think`+⚙、等待批准→`kneel`（向皇上请旨）、出错→`reject`、门下封驳→`reject`+「封驳！」。

## 像素渲染

Phaser 3.90：`pixelArt: true`、`roundPixels`、640×360 世界、**整数倍缩放**（窗口变化时取 `floor(min(W/640, H/360))`）；官员精灵开启 `pixelPerfect` 命中检测；气泡防重叠布局；文字使用 12px 像素中文字体（Fusion Pixel，OFL）。

## 思考程度（v1.1，v1.2.7 起按检测）

`src/shared/reasoning.ts` 把一个滑块翻译成各家参数。每个模型有自己的档位阶梯（`ModelInfo.reasoning`），UI 滑块的刻度就是这条阶梯，档位用 API 原名显示。阶梯来源：`Runtime.detectReasoning` 先发一个乱写的档位（被接受说明服务不校验，结果标为未能确认），再对 none / minimal / low / medium / high / xhigh / max / ultra 各发一个极小请求，只保留服务接受的档位，结果连同 `detected` 存进模型配置；没检测过时按模型 id 推测，名字也认不出且服务不校验时用通用五档。请求时按「官员单独设置 › 旨意滑块（强模型 / Solo）› 模型默认」取值，再按档位名的等级就近落到该模型的阶梯上（例如 max 落到 o3 的 high）。`agentLoop.effortRequest` 生成 `extraBody`（合并进请求体）、必要时提高 `max_tokens`（不超过模型上限）并去掉 temperature；OpenAI Chat 推理模型自动改用 `max_completion_tokens`。服务报参数不支持时，本会话内对该模型自动停止发送思考参数。

## 模型错误分类（v1.1）

`classifyLlmError`（`src/main/llm/types.ts`）：参数不支持 / 配置（模型或接入方式不支持、404、400/422、中转站「分组」「无可用渠道」）/ 鉴权 / 额度为**不可重试**；429 / 408 / 5xx / 网络 / 空闲超时为可重试（指数退避 3 次）。失败节点带 `errorInfo`，界面据此给出做法与「换模型重试」（`retryNodeWithModel`：在该旨意上为该官员指定模型并局部重试）。

## 协同设计（v1.2）

- **设计对象**（`src/shared/design.ts`）：`CollabDesign` = 角色（职责、提示词、强 / 经济档、可选的指定模型与思考程度、工具权限、朝堂形象）+ 步骤（单人执行 / 规划拆解 / 审议 / 分派执行 / 汇总 / 皇上关卡，所属阶段、输入、并行、封驳去向与上限、超时）+ 规则（预算、封驳上限、并行度、终审、自愈）+ 可选的朝堂站位。`validateDesign` 保证阶段顺序、引用和封驳去向合法，阶段只能映射到受保护状态机的合法流转，没有绕过门下省的路径。
- **设计库**（`src/main/runtime/designs.ts`）：`<dataDir>/designs/<id>/v<n>.json`，每次保存是新的不可变版本，另有索引记录当前版本、启停、收藏；删除移到 `designs/.trash` 可恢复。内置三省六部写在代码里、只读，仍走原生引擎；「复制」从它的声明式描述开始。朝堂站位单独存版本，不参与行为哈希。
- **解释器**（`src/main/runtime/flow.ts`）：旨意下达时固定设计的版本（`Task.designSpec`），每一步变成持久化的 RunNode（每轮循环 id 稳定），所以局部重试和重启恢复与原生引擎一致；每步的阶段显示为对应的 Edict 状态，看板、朝堂、奏折阁保持同步。角色的模型按「该旨意指定 › 角色指定 › 强 / 经济路由」取，思考程度按「角色指定 › 旨意滑块（强档）› 模型默认」取。

## 存储（v2.0）

- **edict.db**（`src/main/runtime/sqliteStore.ts`）：用 Electron 自带 Node 的内置 `node:sqlite`，不需要原生模块。任务、议政、会话、奏折、朱批、要闻各一张表（每行一份 JSON 加几个索引列），总量统计、每日编号、官员统计、设置与模型服务放在 `kv` 表。WAL、`synchronous=NORMAL`、外键、忙等超时；表结构按 `PRAGMA user_version` 加 `schema_migrations` 记录，只通过有序、只增的迁移列表演进。
- **写后合并**：运行时只标记改了什么（`markDirty` / `markStateDirty` / `markSettingsDirty`），250 ms 后在一个事务里只写 JSON 真变了的行；退出时全量比对后落盘。
- **1.x 迁移**（`openStateStore`）：`edict.db` 不存在或为空时，在一个事务里导入 `state.json` / `settings.json`，原件复制到 `backup-1.x-<时间>/`（附中文回滚说明），再改名为 `*.migrated`；可重复执行，两个进程同时打开也安全。JSON 损坏时按空导入并保留副本；数据库损坏时移到一边，从最新的 1.x 备份重建。
- **备份**（`storage.ts`）：「存储与备份」页的「立即备份」先落盘，再 `VACUUM INTO` 到临时名，改名为 `backups/edict-<时间>.db`。审计、活动流、`blobs/` 仍是旁边的文件（`persist.ts`），不进数据库。

## 执行层（v2.0）

- **子任务效果**：中书省给每个子任务标 `read` / `write` / `verify`（只读 / 写入 / 验证，缺省为只读），调度见上文「节点化编排」。
- **写任务审批**（`execPolicy.confirmWriteTask`）：写任务开工前发一张带选项的卡（准许开工 / 本子任务内免询问 / 改为只读执行 / 驳回），结果记为节点的 `grant`，并以一句提示交给官员；只读执行时只给只读工具。只读子任务第一次要写时，`tools.ts` 发升级卡。
- **操作审批与允许规则**：`permissions.decide` 给出 允许 / 询问 / 拒绝 与风险；`askAction` 对普通风险的操作提供「本旨意内不再询问」「本工作区永久允许」，规则键由 `ruleFor` 生成（命令前缀、`tool:write`、MCP 工具），旨意规则存在 `Task.allowRules`，工作区规则存在 `settings.workspacePerms[主工作区路径]`（`permRoot` 把工作树映射回主工作区）。发版 / 部署命令是高风险，但工作区可开 `releaseAlways`。
- **成果核验**（`execPolicy.checkEvidence`）：不采信自报——对声称的产物算哈希，列出系统记录的改动、命令与预览次数；产物不存在、写任务没有任何改动、验证任务什么都没跑时，`done` 降为 `partial`（成果存疑）。结论没有结构化 JSON 时给一次只改格式的机会；Court Lite 没有门下审议成果，存疑时停在御批关卡。
- **命令改动快照**（`services/shadowSnapshot.ts`）：`run_command` 在两次影子 git 快照之间执行，差异记为 `via: 'command'` 的改动，与文件工具的改动一样进入 `view_changes`、回奏、成果核验与撤回。`rt.revertNode` / `rt.revertTask` 从新到旧撤回，有冲突时整体不动；`revertNodeAndRedo` 撤回后局部重试或在关卡上发回返工。
- **请旨**（`askEmperor.ts`）：官员可带选项向皇上提问；全自动模式下超时按官员给的默认做法继续。
- **项目规约与典章**（`canon.ts`）：工作区的项目规约文件（`AGENTS.md`、`.edict/rules.md` 等，见 `RULE_FILES`）与皇上的典章（禁止 / 规矩 / 偏好 / 教训，可按工作区、按关键词生效）注入规划、审议与执行的用户消息（不进系统提示，缓存前缀不变）；封驳理由可一键收入典章。
- **技能**：内置技能包（`builtinSkills.ts`，37 个流程与日常技能）启动时写入 `skills/`（每个只写一次，删掉的不再写回；正文没改过的随新版本原地升级）；每位官员有固定的职责技能，其余技能默认不配备，在「设置 · 技能」按官员另配。`load_skill` 只能加载职责或已配备的技能，每次加载按正文 sha256 记入旨意的 `skillsUsed` 与奏折；从链接添加的技能保留来源哈希，可检查更新。

## 旨意工作树（v2.0）

- `services/worktree.ts` 只管 git 命令（`repoOf`、`addWorktree`、`linkDeps`、`commitAll`、`mergeBranch`、`removeWorktree`、`diffStat`…）；`runtime/worktrees.ts` 管生命周期。
- 协同旨意离开太子分拣时（`prepareWorkspace`），若工作区是有提交的 git 仓库且 `worktreePerEdict` 开启，就在 `<dataDir>/worktrees/<仓库哈希>/<旨意号>` 建分支 `edict/<旨意号>`，记入 `Task.worktree`。之后 `rt.workspaceFor(task)` 把工具、仓库上下文、成果核验、撤回、产物、预览（`preview://wt-<id>/`）、语言服务（每个工作树一组进程）、`run_command` 与人工终端都指向工作树。同一仓库上的 git 操作串行。
- 结案或取消后发 `worktree` 类决策卡（合并 / 保留分支 / 丢弃），界面是 `WorktreeDialog.tsx`（改动文件、行数、经手的部、可改的提交说明）；`worktreeFinish` 幂等，重启后未回答的卡会再发；工作树丢失的进行中旨意在重启时阻塞。
- 手动工作树：`worktreeList` / `worktreeCreate` / `worktreeOpen` / `worktreeRemove`，界面在「源代码管理」与「设置 · 工作树」（`WorktreeList.tsx`）。

## MCP、LSP 与 ACP（v2.0）

- **MCP**：`oauth.ts` 实现远程服务登录（发现、动态注册、PKCE、一次性回环回调、续期、吊销）；`client.ts` 支持 `resources/*`、`prompts/*` 与列表变更通知（仅当服务声明该能力）；`resourceTools.ts` 给官员 `mcp_list_resources` / `mcp_read_resource`（按官员授权）；`refs.ts` 在下旨时把 `@mcp:<服务>/<uri>` 展开成【附带资源】块（最多 10 项、合计 8000 字符）。下旨框的 `/`（提示词）与 `@`（资源）选择器在 `workbench/McpPicker.tsx`。
- **LSP**（`src/main/lsp`）：`registry.ts` 是 24 种常见语言服务器的数据（命令、项目标记、各平台安装提示）；`detect.ts` 不经 shell 在 `PATH` 与常见安装目录里找可执行文件并缓存；`client.ts` 是 LSP 3.17 的 stdio JSON-RPC 客户端（推送与拉取两种诊断）；`manager.ts` 按（项目根 × 服务器）懒启动、从磁盘同步文档、闲置回收、崩溃退避重启，并把诊断推给编辑器（Monaco 标记）；`tool.ts` 是官员的 `lsp` 工具（诊断、定义、引用、悬停、符号、全局符号），没装服务器时返回安装提示。
- **ACP**（`src/main/acp`）：`server.ts` 在 `<dataDir>/acp.sock` 上监听并逐个批准编辑器；`connection.ts` 是按行分隔的 JSON-RPC 2.0；`agent.ts` 实现 ACP v1 的 initialize、`session/new|load|prompt|cancel|set_mode`；`runtimeHost.ts` 把一次提示变成一道旨意（`orchestrator.submit`，模式 = Solo / Court Lite / Full Court，默认 Solo），活动流映射为 `session/update`，方案映射为 `plan`，待批操作映射为 `session/request_permission` 再交给 `rt.decideApproval`；遇到关卡本轮结束。会话索引存于 `acp-sessions.json`，恢复会话时回放。编辑器侧由 `dist/acp-bridge.js` 把 stdio 接到套接字，「编辑器接入」页可复制 Zed 配置。

## 设置中心与界面（v2.0）

- **设置中心**（`src/renderer/settings/`）：一个编辑器标签页，左侧分组导航加搜索，页面登记在 `sections.ts`：通用（外观与通知、存储与备份）· 模型（模型服务、官员模型与路由）· 运行（运行策略、权限与审批、典章）· 扩展（连接服务、技能、语言服务、编辑器接入、工作树）· 记录（审计日志、使用说明）。菜单「设置」与 ⌘, 打开它。
- **活动栏**（`ActivityBar.tsx`）：侧栏视图（资源管理器、全局搜索、源代码管理、待办、网页预览），可固定的页面（右键增减、拖动排序，放不下的进「更多」），底部是连接服务 / 技能 / 权限 / 终端 / 设置。
- **待办与看板**：`common/attention.ts` 汇总所有等皇上处理的事（写任务开工、请旨、审批、高风险、方案、御批、裁决、阻塞、合并），供「待办」侧栏、看板的「需要你处理」栏和角标共用。看板有统计卡、五个阶段列、筛选（全部 / 我需处理 / 进行中 / 阻塞 / 工作树）与列表视图。
- **Agent 栏**：当前旨意的审批是栏底的决策卡（`ChoiceCard.tsx`：数字键选项、⏎ 确认、Esc 驳回、可选或必填的批示），方案卡（`PlanCard.tsx`）列出每个子任务的 只读 / 写入 / 验证 与实时状态，每个六部节点结束后有一行成果核验；撤回本旨改动、节点的撤回改动 / 撤回并重做在这里调用上面的撤回接口。
- **桌面通知**：`rt.notifyDesktop` 按设置 `notify`（全部 / 只提醒要我处理的 / 关闭）过滤，窗口在前台时不弹。
