# 架构

```
┌──────────────────────── Renderer（sandbox, contextIsolation）────────────────────────┐
│  工作台（React）               朝堂（Phaser 3 + React 浮层）                           │
│  Monaco · xterm · 面板          太和殿 / 军机处 / 六部值房 / 承天门                    │
│            └──────────── 同一个 store（主进程事件的投影）────────────┘               │
└───────────────────────────── preload: window.edict.invoke / onEvent ──────────────────┘
                                        │ IPC（白名单 API：src/main/api.ts）
┌──────────────────────────────── Main process ────────────────────────────────────────┐
│ Runtime（src/main/runtime/runtime.ts） 唯一状态源：tasks / agents / debates / approvals │
│  ├─ stateMachine.ts   受保护状态流转（Edict STATE_TRANSITIONS + 档位边 + 仅皇上可执行边）│
│  ├─ orchestrator.ts   状态驱动 + 节点化的三省六部引擎（submit / drive / decideGate）    │
│  ├─ agentLoop.ts      LLM ⇄ 工具循环：检查点、朱批注入、滚动压缩、重试、流式活动、记账  │
│  ├─ tools.ts          工具 + 权限（permissions.ts）+ 路径边界（services/workspace.ts）   │
│  ├─ debate.ts         朝堂议政（插话 → 待回应队列）                                     │
│  ├─ persist.ts        JSON/JSONL 持久化、SHA-256 哈希链审计、内容寻址快照               │
│  └─ extras.ts         技能（SKILL.md）、天下要闻（RSS/Atom）                           │
│ LLM adapters（src/main/llm）：OpenAI Chat / Anthropic Messages / OpenAI Responses（SSE）│
│ Services：workspace（边界）、exec、git、terminal（BSD/util-linux `script` PTY）        │
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

执行阶段按子任务依赖图调度，并行度可配（默认 3）；同一官员一次只办一件事（每 Agent 互斥锁，保证可观测性真实）。同一工作区同时只有一个旨意在执行（其余进入 `Next` 排队）。

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
