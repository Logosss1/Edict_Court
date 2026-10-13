# 测试与验证

三类验证严格分开标注，**mock 结果不冒充真实验收**。

## 0. 运行方法
```bash
npm test                                  # 单元 + 集成：tests/*.test.ts（tsx --test，串行，单个测试超时 120 秒）
npx tsc -p tsconfig.json --noEmit         # 类型检查（= npm run typecheck），覆盖 src/ 全部代码
npm run build                             # E2E 启动的是 dist/，先构建
xvfb-run -a npx tsx e2e/flow.ts           # 主流程（= npm run e2e）
xvfb-run -a npx tsx e2e/features.ts       # 功能（= npm run e2e:features）；ONLY=worktree,mcp 只跑这些段
xvfb-run -a npx tsx e2e/court-smoke.ts    # 朝堂冒烟
xvfb-run -a npx tsx e2e/smoke.ts          # 启动冒烟：打开构建好的应用、截一张工作台
```
- `e2e/features.ts` 的段（`ONLY=` 的取值，逗号分隔；不设则全跑）：`effort`、`error`、`preview`、`mcp`、`designs`、`designer`、`manage`、`tips`、`sidebar`、`worktree`、`v21`、`sched`。
- 截图目录由 `SHOTS` 指定：`flow.ts` / `features.ts` 默认写进 `docs/screenshots/`（会改动仓库里的截图），`court-smoke.ts` 默认写到脚本里设定的临时目录；`smoke.ts` 的截图路径写死在脚本里。`EDICT_ELECTRON` 可换 Electron 可执行文件，`APP_DIR` 可让两个冒烟脚本启动别处的构建。每个脚本都用临时数据目录，不碰你的 EdictData。
- 2.1.0 第二批的结果（Linux + Xvfb，mock LLM）：单元 + 集成 234/234，另有 2 项只在 macOS 上运行的真实沙箱测试跳过；`e2e/flow.ts` 21/21；`e2e/features.ts` 100/100（含 `sched` 段 14 项）；`e2e/court-smoke.ts` 与 `e2e/smoke.ts`（正式构建）通过。还没在 Mac 上跑。
- 2.1.0 第一批的结果（Linux + Xvfb，mock LLM）：单元 + 集成 222/222，另有 2 项只在 macOS 上运行的真实沙箱测试跳过；`e2e/flow.ts` 21/21；`e2e/features.ts` 88/88（含 `v21` 段 11 项）；`e2e/court-smoke.ts` 与 `e2e/smoke.ts` 通过。同一份代码在一台 Apple Silicon Mac 上：单元 + 集成 222/222（含 2 项真实沙箱测试），跳过 2 项（没装 pyright、python3 没有 Pillow）。
- 2.0.3 的结果（Linux + Xvfb，mock LLM）：单元 + 集成 196/196；`e2e/flow.ts` 21/21；`e2e/features.ts` 79/79；`e2e/court-smoke.ts` 通过。
- 2.0.0 的结果（Linux + Xvfb，mock LLM）：单元 + 集成 179/179；`e2e/flow.ts` 21/21；`e2e/features.ts` 78/78；`e2e/court-smoke.ts` 与 `e2e/smoke.ts` 通过。

## 1. 单元测试（纯逻辑）
`npm test` 运行 `tests/` 下全部测试（本节的单元测试与第 2 节的集成测试）。`tests/unit.test.ts`：SSE 解析与空闲超时、JSON 抽取、Key 脱敏、权限策略、工作区边界 / 搜索替换 / 符号大纲、RSS/Atom、方案校验（部门 / 依赖 / 环）、审计哈希链防篡改、各协议端点解析、美术导入网格还原（要用 python3 的 Pillow，没有则跳过）。

## 2. 集成测试（mock LLM，真实线协议）
`tests/runtime.test.ts` 启动 `tests/mockLlm.ts`：一个按角色脚本化回复的 HTTP 服务，**逐字节**输出 OpenAI Chat Completions / Anthropic Messages / OpenAI Responses 的 SSE 流（含 reasoning、分片 tool call、usage）。覆盖：

- 三种协议下 Court Lite 全流程 + 门下封驳强制重拟；API Key 只出现在请求头、不出现在审计
- Full Court：方案御览 → 皇上涂改（删去子任务、改标题）→ 按修改后方案执行 → 尚书派发 → 门下审议成果 → 御批封驳 → 返工 → 再次御批
- 执行节点连续 500 → 旨意阻塞 → 局部重试仅重放该节点（中书省不被再次调用）
- 叫停期间无进展、朱批被消费并回应、取消
- 路径越界（`../`、符号链接逃逸、`.git/`）拒绝；`rm -rf` 必须审批，驳回后工具失败
- 议政插话后官员以「回禀皇上」回应；中书令总结
- 应用崩溃模拟：运行中节点标记中断 → 新进程加载 → 局部恢复
- 预算关卡

### v1.1 新增
- `tests/reasoning.test.ts`：各模型族的档位预设；**滑块最右 = 模型最高档**（o3 → high、Opus → max、自定义 ultra）；各协议的请求体；中转站 503「分组不支持」判为配置错误且**不重试**；真实请求体中 `reasoning_effort=xhigh` / `max_completion_tokens` / 去掉 temperature；服务拒绝思考参数时自动回退一次；503 后「换模型重试」只重跑该节点并结案；协议探测矩阵。
- `tests/preview.test.ts`：预览文件服务（类型、index 回退、目录列表、中文路径）、拒绝 `.env` / 越界 / 符号链接逃逸；URL 策略；`preview_page` 在无桌面环境时如实报告不可用、在（替身）宿主下把控制台错误判为失败。
- `tests/mcp.test.ts`：**真实子进程**（`tests/fixtures/mcp-echo-server.mjs`，按 MCP 规范写的测试服务）经 stdio 完成 initialize → 分页 tools/list → tools/call、服务端反向请求 roots/list；未信任不启动、命令改变需重新信任；风险分级、只读模式、官员授权、工具停用、高风险驳回；密钥移入钥匙串且仍能送达服务、不进审计；**真实本地 HTTP 服务**上的 Streamable HTTP（JSON 与 SSE 回包、`Mcp-Session-Id`、`MCP-Protocol-Version`）与旧版 HTTP+SSE 自动回退；Solo 官员（mock LLM）调用 MCP 工具。

### v1.2 新增
- `tests/designs.test.ts`：设计校验（阶段顺序、规划步骤、封驳去向、角色模型格式与思考程度）；设计库（内置只读、复制 → 版本 → 回滚、审计、无改动不出新版本）；进行中的旨意固定版本；复制的三省六部在解释器上跑出与原生引擎相同的流程、关卡与封驳循环；自定义角色的批评家循环；重启中断后只重跑该节点；朝堂站位单独存版本且不进行为哈希；收藏、删除进回收站与恢复；画布编辑辅助函数；**角色指定模型与思考程度**真实写进请求体，被删除的模型回退到路由且每道旨意只提示一次。
- `tests/reasoning.test.ts`：经济模型被服务拒绝时自动换用主模型；**检测思考档位**：严格的服务只保留接受的档位（共 10 个极小请求），什么都接受的服务标为未能确认并用通用五档。
- `e2e/features.ts`：协同设计列表 / 画布拖拽 / 表单 / 朝堂站位 / 保存 / 朝堂按设计布局；收藏、删除与撤销、⌘Z、Delete、Esc、⌘S、恢复暂存；悬停说明；官员模型竖排；角色指定模型与思考程度并显示在详情页；滑块英文档位与新说明文字；检测思考档位。
- `e2e/court-smoke.ts`：五个场景截图；皇帝从太和殿走到广场、承天门、六部值房再走回来；悬停、菜单、赏赐动画。
- `tests/preview-actions.test.ts`：`preview_page` 交互步骤。真实注入脚本在 `node:vm` 里对一个极简假 DOM 执行（**不是浏览器**）：按序执行、首个失败即停（后续标为未执行）、`optional` 步骤失败继续、页面卡死中止；选择器 / 值含引号、反引号、`${}`、`</script>`、U+2028 时原样到达页面且不被当成代码；断言文本 / 可见 / `waitFor` 轮询；回车提交表单、Tab 移焦、下拉、勾选；步数 / 等待 / 总时长 / 截图上限；参数校验的中文报错；工具结果逐步列出、断言失败判为未通过、截图存为 blob；`checkEvidence` 仍计入预览次数并注明未通过次数。
- `e2e/features.ts`：真实隐藏浏览器里执行 填写 → 选择 → 勾选 → 回车 → 点击，断言按钮改变的文字；`alert` 不阻塞、交互期间外部请求仍被拦截；交互后另截 375 宽并发现横向溢出；断言失败时后续步骤不执行；Agent（mock LLM）调用带 `actions` 的 `preview_page`，工具结果逐步列出失败的断言。

### v2.0 新增
- `tests/exec2.test.ts`：执行层。`Retry-After` 与退避、上下文超长单独分类并压缩重试一次；裁剪旧工具结果（保留最新的与技能正文）；相邻只读调用并行、相同调用计数（第 3 次提醒、第 4 次请示）；编辑或覆盖已有文件前必须在本轮读过；按效果调度（只读并行、写入 / 验证独占、按方案顺序）；写任务开工卡（驳回则带理由阻塞）与只读子任务的升级卡；发版 / 部署分类、命令前缀规则、复合命令；本工作区永久允许、高风险从不放行、发版需工作区开启；结论缺 status 或无结构化输出判为存疑、证据缺失降级、格式修复一次、Court Lite 存疑停在关卡；节点超时失败并可局部重试；审批选项校验与必填批示。
- `tests/snapshot.test.ts`：`run_command` 的影子快照：新建 / 修改 / 删除记为命令改动并可撤回（含二进制）；只看不改的命令与关闭设置时不做快照；`.gitignore`、依赖目录与密钥文件不进快照，普通文件夹不会多出 `.git`；工作区自己的 git 索引与引用不受影响；超大文件只记文件名、文件过多时停用、并发快照不冲突、超过 80% 上限时 gc。撤回节点 / 整道旨意从新到旧、有冲突时什么都不动；在御批关卡撤回某部并发回返工。
- `tests/canon-ask.test.ts`：项目规约文件按预算读取；典章的选取（禁止总生效、关键词、工作区范围）；规划、审议、执行提示都带上规约与典章，封驳可收为教训；请旨的选项 / 自由回答 / 让官员自定，记入旨意与奏折；全自动模式超时按默认继续。
- `tests/sqlite.test.ts`：WAL 等设置与迁移记录；字段与顺序往返不丢；250 ms 写后合并、只写改动的行；事务回滚与嵌套保存点；真实形态的 1.x 数据目录一次导入、备份附 README、原件改名；重复打开不重复导入；1.x JSON 损坏、数据库损坏（文件头 / 数据页）的恢复；两个连接、两个进程同时迁移只导入一次；2,000 个任务时改一个只写一行。
- `tests/settings2.test.ts`：「立即备份」先落盘再写一致的副本并记审计；桌面通知按 `notify` 过滤；允许规则记录来源、可撤销本旨意的规则。
- `tests/worktree.test.ts`（真实 git 临时仓库 + mock LLM）：旨意在自己的工作树里办、合并前主工作区不动；同一仓库两道旨意并行、非 git 工作区仍排队；保留分支 / 丢弃、保留的分支以后可合并、取消的旨意只能保留或丢弃；合并冲突时主工作区原样、分支保留并再次询问；不选处理方式什么都不动；真实冲突被中止、本地改动挡路时拒绝合并；手动工作树的新建 / 列表 / 打开 / 移除与各项保护；重启后未回答的结案卡重发、工作树丢失的旨意阻塞；关闭 `worktreePerEdict` 时照旧排队；结案对话框的逐文件行数。
- `tests/mcp-oauth.test.ts`（进程内假授权服务器 + 受保护的 Streamable HTTP MCP 服务，真实回环套接字）：401 → 资源元数据 → 授权服务器元数据 → 动态注册 → 浏览器（以请求授权地址模拟）→ 回环回调 → 令牌、每个请求带 Bearer、临近过期续期；预注册客户端与发现回退；回调服务只绑 127.0.0.1、只认 `/callback`、超时关闭；`state` 不符时不换取令牌；令牌不外泄；退出登录。
- `tests/mcp.test.ts`（新增部分）：资源与提示词（新测试服务 `tests/fixtures/mcp-resources-server.mjs`）。`tests/mcp-refs.test.ts`：`@mcp:` 引用的解析，以及对真实 stdio 服务展开成【附带资源】、读不到的注明、预算与审计。`tests/mcp-settings.test.ts`：「连接服务」页添加卡片生成的条目、明文 / 钥匙串提示与后端一致、配置合并与删除、`/` 与 `@` 的触发。
- `tests/lsp.test.ts`（真实子进程：假语言服务器 `tests/fixtures/fake-lsp.mjs`）：Content-Length 分帧；24 种服务器的登记数据；不经 shell 的检测、版本探测、缓存、自定义路径、缺失时的安装提示；懒启动、握手、诊断、跳转、符号、磁盘同步；工作区边界（含符号链接逃逸）；`lsp` 工具输出；崩溃退避重启与放弃；闲置关闭；拉取式诊断；切换工作区时停掉旧服务器。本机装有 `pyright-langserver` 时另跑真实服务器，否则跳过。
- `tests/acp.test.ts`：协议层（initialize、错误处理、会话与模式、提示与内容块、取消、权限往返：普通风险可「始终允许」、高风险从不）；`0600` 套接字、按编辑器名称批准、拒绝即断开、停止时删除套接字、不发 initialize 的连接被断开；stdio 桥接；对真实运行时（mock LLM）的端到端：Solo 流式输出与真实 diff、会话恢复回放、审批发往编辑器、取消、Court Lite 发送方案并停在御批关卡、编辑器目录与工作区不一致时须同意切换；编辑器配置片段。
- `tests/skillpack.test.ts`：内置技能包的名称、职责、说明长度、正文结构、发版 / 部署的风险提示措辞、引用的工具名与相互引用。`tests/skills2.test.ts`：只给职责官员配备、另配 / 调整职责 / 恢复；1.x 未改过的技能原地升级、改过的保留；`load_skill` 只能加载职责或已配备的技能并记入旨意与奏折；链接技能的来源哈希与检查更新。
- `e2e/flow.ts`：写任务开工与命令执行以 Agent 栏的选项卡呈现。`e2e/features.ts` 的 `sidebar`：活动栏「待办」、网页预览侧栏、协同设计直达、右键增减常用页面、标题栏切换朝堂；`tips`：活动栏（含底部连接服务、权限等）与下旨框的悬停说明；`mcp`：在新的「连接服务（MCP）」页保存本地服务（原生确认框由测试替身代点）并让官员调用其工具；`worktree`：Git 仓库里的旨意在自己的工作树分支上办、期间主工作区一个文件都不动、结案对话框列出文件 / 行数 / 经手的部、合并是默认选项、合并后主工作区有旨意提交与合并提交且工作树目录已清理。

### v2.1 新增
- `tests/web.test.ts`（假网络、假 DNS、假搜索服务）：内网 / 回环 / 链路本地地址判定（含 IPv4 映射的 IPv6）与 DNS 解析后再判定；网页转文本（标题、链接、实体、脚本与样式去除）；`webFetch` 每一跳重定向都重查、内网目标从不请求、跳数上限、非文本拒绝、404 的正文保留、字数与 2 MB 上限、GBK 编码；四种搜索后端（Brave、Tavily、SearXNG 及其 403 提示、模型自带搜索：Anthropic 与 Responses，后者不支持时回退旧工具名）；`web_fetch` 工具的允许 / 每次询问（准一次、本旨意、永久、驳回）/ 关闭；`web_search` 上疏：每道旨意只问一次、配置后保存并接着搜索、Key 不进设置与审计、Key 错误、删除 Key、打开配置却没保存按驳回处理、全自动模式超时只用抓取；设置保存的规整。
- `tests/sandbox.test.ts`：沙箱规则文件（只有拒绝项、路径转义、网络规则）；`~` 展开与真实路径；`git` 公共目录（假文件与真实 git 工作树）；从命令输出识别被拦下的写 / 读 / 联网；策略默认值、数据目录不可读、工作区可写目录增删、设置保存；`run_command` 被拦下时的选项卡（假沙箱后端）：作罢、重跑一次、允许本工作区写该目录，关网时的联网失败，发版命令不进沙箱，关闭沙箱；系统没有沙箱时只提示一次。**真实 `sandbox-exec` 测试只在 macOS 上运行**，Linux 上跳过：工作区外写入被拒、密钥目录的文件读不到也列不出、普通命令照常、关网后本机回环可连而外网不通；旨意工作树里改文件、跑 node、`git commit` 都正常，提交进了仓库，主工作区和家目录不受影响。
- `tests/requirements.test.ts`：需求说明的解析（编号规整、负责关系）与由验收标准推出；对照检查结果的解析（判定同义词、无证据的「满足」降级）；补办子任务的生成；Court Lite 全流程（对照检查用经济模型、顺序、提示词、奏折「需求对照」）；一轮补办后满足；补办后仍未满足 → 停在御批（关掉结案御批时按封驳上限处理、补办轮数为 0）；关闭对照检查；Full Court 方案御览中皇上改方案后推出的需求说明随之重推；复制的设计带「对照检查」步骤、校验规则与解释器里的补办。
- `tests/runtime.test.ts`：奏折多出「需求对照」一节。
- `tests/edict-schedule.test.ts`（定时旨意，第二批）：时间规则（每天、每周、早朝、每隔 N 小时按整步顺延、指定一次、跨年）与人话描述、错误提示；保存时的校验、编辑、停用、重启后还在；到点直接下旨（不经太子）、在排定的文件夹里办（即使打开的是别的文件夹）、标题与流转记录；上一次没办完则跳过并记一笔、立即执行一次不改平常的时间；错过的时间补跑一次（不按次数补）或跳过、刚到点不算错过；执行次数 / 截止日 / 指定一次到期自动结束，再启用时说明原因；文件夹没了记为没下成、下次再试；三档权限：只读（无工作树、写子任务改只读、不弹卡片、写入和命令被拒）、在旨意工作树里改（关掉「每道旨意一个工作树」也建、办事不弹卡片、主目录不动、高风险仍问）、非 git 文件夹退回每次都问、每次都问（全自动设置下仍弹写任务卡片）；官员提议：卡片三个选项、提议期间不能启用或立即执行、同一来源只提一次、准奏 / 先停用 / 不必、修改后保存即准奏且卡片关闭、提议不随来源旨意取消而作废、重启后再出卡片、删除时卡片关闭；定时旨意里不能再提议；电脑只在定时旨意真正办事时保持唤醒。
- `e2e/features.ts` 的 `sched`：活动栏打开「定时旨意」页 → 新建表单（每周、加周六、08:30、在旨意工作树里改）的三次预览 → 保存后的规则、详情页的人话时间 → 立即执行一次：在 git 工作树里办完、主目录没动、执行记录与看板「定时」标记 → Solo 官员上疏提议 → 待办里的定时提议卡片 → 打开到「定时旨意」页 → 准奏后生效、待办里消失。
- `e2e/features.ts` 的 `v21`：Solo 官员要搜索时的上疏卡片（配置 / 只用抓取 / 驳回）→ 配置窗口选 SearXNG（本机假服务）、测试、保存 → 设置里出现该服务、这次搜索接着执行并记入审计；「联网与搜索」「权限与审批 › 命令沙箱」「运行策略 › 需求对照」三个设置页；Court Lite 旨意的方案卡列出需求与对照结果、奏折有「需求对照」。

## 3. 端到端 UI（mock LLM，Linux + Xvfb，真实 Electron）
先 `npm run build`。`npm run e2e`（`e2e/flow.ts`，Playwright `_electron`）：在 UI 中添加模型服务并测试连接 → 打开工作区 → 输入框下旨 → Agent 栏的写任务 / 命令选项卡 → 御批结案 → 看板 → Editor 打开 Agent 产物、磁盘改动实时刷新 → 问题面板 TS 诊断 → 终端交互 → 全局搜索 → Full Court 在**朝堂奏折批阅浮层**中涂改方案并放行 → 六部值房 / 军机处 → 朝堂内准奏 → 议政中通过**皇上口谕框**插话 → Solo → 承天门上朝仪式 → 全部面板 → 审计校验 → Key 未落盘。截图输出到 `docs/screenshots/`，结果写入 `docs/screenshots/e2e-results.json`。

`e2e/features.ts`（按段运行，见第 0 节）：`effort` 思考滑块档位与最右档 → 真实 Electron 发出的请求体、无档位模型显示「不适用」；`error` 中转站 503 错误卡片与换模型重试、协议探测矩阵、检测思考档位、官员模型竖排；`preview` HTML 预览（webview 加载、控制台错误、外部请求拦截、磁盘改动自动刷新）、离屏截图与交互步骤、Agent 调用 `preview_page`；`mcp` 技能新建、MCP 保存前原生确认框（由测试替身代点）→ 连接真实 stdio 服务 → 官员调用 MCP 工具；`designs` / `designer` / `manage` 协同设计（见 v1.2）；`tips` 悬停说明；`sidebar` 活动栏；`worktree` 旨意工作树与结案合并。最后总要检查 API Key 未出现在审计 / 状态 / 设置 / `mcp.json`、无前端运行时错误。结果写入 `docs/screenshots/e2e-features-results.json`（或 `SHOTS` 目录）。

`e2e/court-smoke.ts`：朝堂各场景截图、皇帝行走路线、悬停卡片、官员菜单与赏赐动画，出错即以非零退出。`e2e/smoke.ts`：只启动构建好的应用并截一张工作台。

## 4. 真实模型（需你本机执行）
```bash
EDICT_BASE_URL=https://api.deepseek.com EDICT_API_KEY=sk-... EDICT_MODEL=deepseek-chat \
EDICT_PROTOCOL=openai-chat EDICT_TIER=lite npx tsx scripts/verify-real.ts
```
脚本使用应用同一个运行时，完成后检查真实文件产物、节点 run ID 与审计链。**本构建环境未执行**（无 Key、无法访问模型服务）。

## 5. 安装包
`python3 scripts/verify-dmg.py release/Edict-2.0.0-arm64.dmg release/stage`：解码 UDIF → 解析 ISO9660/RockRidge → 校验可执行位、框架符号链接、Applications 链接、代码封印存在、主程序与已签名副本逐字节一致。1.2.x 的每个版本都在一台 Apple Silicon Mac 上打包，并从文件夹直接启动过；**DMG 挂载、拖入「应用程序」和 Gatekeeper 首次打开未验证。**
