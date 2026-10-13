# Edict for Mac · 三省六部多智能体协作编程工作站

[English](README.md) | 中文

> 下载：[最新版本（Releases）](https://github.com/Logosss1/Edict_Court/releases/latest) · 旧的 0.x 桌面封装版本见 [历史 Releases](https://github.com/Logosss1/Edict_Court/releases) 与 `v0.3.2` 及更早的标签。

Edict for Mac 是一款 **Apple Silicon Mac** 上的桌面 AI 编程工作站。你下一道旨意，一个由 AI 官员组成的朝廷按朝堂的规矩办事：太子分拣，中书省规划，门下省审议，尚书省派发，六部并行执行，最后回奏请你御批。协作流程来自 [Edict](https://github.com/cft0808/edict) 的三省六部。

```
皇上下旨 → 太子分拣 → 中书省规划 → 门下省审议（准奏 / 封驳）
        → 尚书省派发 → 六部并行执行 → 汇总回奏 → 皇上御批结案
```

| 工作台 | 朝堂 |
|---|---|
| ![工作台](docs/screenshots/03-workbench-final-gate.png) | ![官员跪奏请旨](docs/screenshots/71-court-petition.png) |

工作台和朝堂是同一份实时状态的两种看法：在朝堂里准奏，工作台立即结案；在工作台叫停，朝堂里的官员立即停笔。⌘J 切换。

## 主要功能

### 三省六部协作，三种档位

| 档位 | 流程 | 适用 |
|---|---|---|
| **Solo** | 一位官员直接和你对话、读写文件、执行命令 | 简单任务 |
| **Court Lite**（默认） | 分拣 → 规划 → 审议 → 六部执行 → 回奏 | 日常任务 |
| **Full Court** | 全流程，可选朝堂议政，方案下发前可以亲手修改，六部按依赖图并行，门下省再审成果 | 复杂长任务 |

门下省审议不能绕过：从规划到执行没有跳过它的路径，被封驳的方案必须返工。

### 由你掌控执行

- 子任务分读、写、验证三类。读任务并行；每个写任务开工前先问你：准许、准许且不再问、改为只读、驳回。
- 准许可以只管这道旨意，也可以对整个工作区永久生效。高风险操作总会询问；发版、部署命令每次都问，除非该工作区明确开启。
- 遇到不清楚的地方，官员会停下来请旨，并给出可选项。
- 成果会和 Edict 实际记录的改动对账；任一步或整道旨意都能撤回，命令行改的文件也算在内。

### 完整的编程工作台

文件树、带诊断的 Monaco 编辑器、全局搜索替换、集成终端、问题面板和 Git。Edict 使用你 Mac 上已装好的语言服务器。沙箱预览可以运行生成的网页，官员会在里面自测。看板有一列专门放等你处理的事。

| 看板 | 编辑器 | 网页预览 |
|---|---|---|
| ![看板](docs/screenshots/04-kanban.png) | ![编辑器](docs/screenshots/05-editor-problems.png) | ![网页预览](docs/screenshots/33-html-preview.png) |

### 每道旨意一个 git worktree

在 git 仓库里，每道旨意在自己的分支和目录里干活，同一仓库的多道旨意可以同时进行，你自己的工作区不受影响。结案时列出每个改动的文件和改它的官员，你选择合并、保留分支或丢弃。

### 模型、技能与工具

- 支持 OpenAI Chat Completions、OpenAI Responses、Anthropic Messages 以及兼容的服务。不内置任何 Key；你的 Key 用 macOS 钥匙串里的密钥加密保存。
- 强 / 经济模型分级，思考档位从模型本身探测，每位官员可以用不同模型。
- 内置 37 个技能（规划、评审、排查、测试、发版、部署等），也可以自己写。
- MCP 服务器（stdio、Streamable HTTP、SSE），支持 OAuth 登录、资源和提示词、按工具分级风险。支持 ACP 的编辑器也可以驱动 Edict。

| 协同设计 | MCP 服务器 | 结案合并 |
|---|---|---|
| ![协同设计画布](docs/screenshots/37-designs-canvas.png) | ![MCP 设置](docs/screenshots/36-mcp-center.png) | ![结案对话框](docs/screenshots/60-worktree-merge.png) |

### 自定义协作流程

朝堂流程是一份有版本的设计。可以复制后在流程画布上调整步骤、指定封驳退回到哪一步、给每个角色单独配模型，并把某个设计固定给某道旨意。

### 可审计、可恢复

所有操作写入哈希链审计日志。每一步完成即保存，出错或重启后只重跑失败的那一步。数据存放在一个 SQLite 数据库里。

## 特色功能

### 活起来的宫城

朝堂模式是一座跟着你电脑时钟运转的像素宫城，把正在进行的工作演出来。

- **宫里的一天**：每天 6–9 点自动早朝；白天官员在各自衙门办公，傍晚陆续下值，夜里大殿空着、只剩灯火。随时可以去承天门击鼓上朝，一段时间没有操作会自动退朝。
- **把工作演出来**：官员在衙门之间递折子，跑腿的把消息从一处送到另一处，被封驳的方案盖着「驳」字退回；需要你拍板时，官员会走到你所在的地方跪奏请旨。正忙的部院因公告假，留在案前继续办差。
- **在宫里走动**：十个场景，太和殿、太和殿广场、承天门、军机处（折子墙）、六部院、东宫、御花园、宫道长街、角楼和宫城舆图。用方向键或点击地面行走，官员见驾行礼。
- **小细节**：真实月相、晴雨雪、春天落花、夏夜萤火、节日烟花、宫里的猫，还有御花园池子里会游过来抢食的锦鲤。

| 朝会中 | 回奏呈折 | 宫城舆图 |
|---|---|---|
| ![朝会中](docs/screenshots/70-court-session.png) | ![回奏呈折](docs/screenshots/72-court-memorial.png) | ![宫城舆图](docs/screenshots/73-court-map.png) |
| **六部院** | **军机处** | **承天门** |
| ![六部院](docs/screenshots/74-court-liubu.png) | ![军机处](docs/screenshots/75-court-junjichu.png) | ![承天门](docs/screenshots/76-court-chengtian.png) |
| **东宫** | **御花园** | **角楼夜景** |
| ![东宫](docs/screenshots/77-court-donggong.png) | ![御花园](docs/screenshots/78-court-garden.png) | ![角楼夜景](docs/screenshots/79-court-night.png) |

### 太子先问一句再办

旨意含糊时，太子会在开工前问你一个简短的问题（「父皇，这个应该是…」），附上几个可能的答案，你答完再往下办。其他官员需要你定夺时，也会用自己的口吻请旨（「皇上，臣对…不太明白」）。太子追问可以在「设置 › 权限与审批」里关掉。

## 近期更新

- **2.0.3**：活起来的宫城、十个新场景、太子追问。
- **2.0**：由你掌控执行、每道旨意一个 git worktree、MCP 登录与资源 / 提示词、语言服务器、ACP、内置技能、SQLite 存储、新的设置中心。

完整的更新记录见 [RELEASE_NOTES.md](RELEASE_NOTES.md)。

## 安装（Apple Silicon）

从 [Releases](https://github.com/Logosss1/Edict_Court/releases/latest) 下载 `Edict-<版本>-arm64.dmg`，把 Edict 拖进「应用程序」（[详细说明](docs/INSTALL_MAC.md)）。**安装包未用开发者 ID 签名、未公证**：首次打开需在「系统设置 → 隐私与安全性」中点「仍要打开」。暂无 Intel 版本。

## 从源码构建

```bash
npm install
npm run build            # esbuild 打包 main / preload / renderer 到 dist/
npx electron dist        # 运行
npm test                 # 单元 + 集成测试（mock 模型）
npm run typecheck        # 类型检查
npm run package:mac      # 组装 Edict.app（arm64）、ad-hoc 签名、生成 zip + DMG
```

`package:mac` 需要官方的 `electron-v44.4.5-darwin-arm64.zip`（放在 `deps/`，或设置 `ELECTRON_DARWIN_ZIP`）。在 macOS 上使用 `codesign` 与 `hdiutil`；在 Linux 上需要 rcodesign 与 libdmg-hfsplus 的 `dmg`。端到端测试：先 `npm run build`，再 `npm run e2e` 与 `npm run e2e:features`（Playwright；Linux 下用 `xvfb-run`；见 [docs/TESTING.md](docs/TESTING.md)）。

## 文档

- [docs/STATUS.md](docs/STATUS.md) — 现状盘点、交付清单、已知限制
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — 运行时、状态机、编排、Token 经济性
- [docs/SECURITY.md](docs/SECURITY.md) — 权限、路径边界、数据位置、外发范围
- [docs/ART_PIPELINE.md](docs/ART_PIPELINE.md) — 像素美术规格与场景生成
- [docs/TESTING.md](docs/TESTING.md) — 测试与验证方法

## 许可证

MIT。第三方组件见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
