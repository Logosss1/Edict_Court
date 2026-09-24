# 现状盘点与交付清单（v1.1.0）

## v1.1.0（本次）
根据使用反馈新增，全部已实现并测试：

| 需求 | 实现 | 验证 |
|---|---|---|
| 中转站 HTTP 503「当前分组暂不支持您请求的模型或接入方式」反复重试后阻塞、看不懂 | 错误分类（配置 / 参数 / 鉴权 / 额度 / 限流 / 5xx / 网络 / 超时）：**配置类错误不再盲目重试**；阻塞处显示**可读错误卡片**（原因 + 做法 + 原始信息折叠）与一键**换模型重试**（只重跑该节点，选择记在该旨意）；「模型配置」新增**协议探测**：同一 base_url / Key / 模型分别以 Chat / Responses / Messages、带与不带思考参数各试一次，结果矩阵可一键套用 | 单元 + 集成（mock）+ E2E |
| 模型思考程度（low / medium / high / xhigh / max / ultra…） | 输入框（工作台与朝堂口谕框）新增**思考程度滑块**：档位 = 当前模型自己的档位，**最右 = 该模型最高档**（没有 ultra 就是它的最高档）；默认刻度 = 模型默认档。「模型配置」按模型设置思考方式（OpenAI `reasoning_effort` / `reasoning.effort`、Claude `output_config.effort`、Claude 旧版 `thinking.budget_tokens`、Qwen `enable_thinking`、GLM `thinking.type`、自定义 JSON——可自定义 ultra 等档位）、可用档位、默认档、思考预算、最大输出；按模型 id 自动识别，未知模型默认**不发送**思考参数。每位官员可单独设置思考程度。服务拒绝思考参数时自动去掉参数重试一次并提示 | 单元 + 集成（mock，校验真实请求体）+ E2E |
| 生成的 HTML 无法在应用内运行 / 测试 | **HTML 预览**页签：内置浏览器（`<webview>`，独立会话分区、沙箱）打开工作区页面或本机 localhost 开发服务器；地址栏、刷新、磁盘改动**自动刷新**、手机 / 平板 / 桌面视口、**控制台**（错误计数、一键让 Agent 修复）、开发者工具、在默认浏览器打开；入口：编辑器「预览」按钮、文件树右键、改动列表、朝堂奏折批阅「预览」页。Agent 新工具 **`preview_page`**：在隐藏的无头浏览器中打开页面，返回标题、可见文本、控制台错误、失败资源并**截图**（活动流中可见）；官员产出网页后被要求用它自验 | 单元（文件服务 / 边界 / URL 策略）+ E2E（真实 Electron webview 与离屏截图） |
| 专门的地方增加、修改 Skill 与 MCP | **技能与 MCP 中心**（活动栏插头图标 / 军机处 / 六部值房·吏部）：技能新建、编辑、改名、复制、启用 / 停用、授予官员、导入文件夹、远程链接；「官员视角」显示某位官员实际拿到的系统提示与工具。**MCP**：与 Cursor 相同格式的 `mcp.json`（`command/args/env/envFile/cwd` 或 `url/headers`，变量 `${env:…}` `${workspaceFolder}` `${userHome}`…），可从工作区 `.cursor/mcp.json` / `.vscode/mcp.json` 导入；自研 MCP 客户端支持 stdio、Streamable HTTP（JSON / SSE 回包、会话头）与旧版 HTTP+SSE（自动回退）；服务状态、日志、工具列表、每工具启用 / 风险（只读 / 有副作用 / 高风险）/ 自动批准、按官员授权；本地命令首次运行须原生对话框确认；形似密钥的值自动移入钥匙串 | 集成（真实子进程 + 真实本地 HTTP 服务，LLM 为 mock）+ E2E |

说明：Cursor 客户端本身不开源，MCP 部分参照的是 Cursor 公开文档中的 `mcp.json` 格式与 MCP 公开规范，客户端代码为本项目自写。

## P0 盘点
- 起点：构建环境中**没有既有 Edict for Mac 代码**（无 AI_HANDOFF / README / docs 可读），因此本版本全部为**新建**；无需保留的未提交修改，未执行任何 reset / checkout / 批量删除。
- 调研：通读 Edict（README、`task.py` 状态机、`kanban_update.py`、`朝堂议政_开发规格.md`、各省部 SOUL、9 个旨库模板）、Yan-Agent（技术参考：权限链、上下文预算与压缩、长任务恢复、Git worktree、数据存放）、Cursor 3 Agents Window（中央输入 / 智能体列表 / 检查面板 / 与 Editor 并存）、VS Code 功能面。
- 环境限制：npm / PyPI / Hugging Face 不可达，GitHub（git + release 资产）可达 → 依赖全部从 GitHub 获取并校验（见 THIRD_PARTY_NOTICES.md），Electron 二进制 SHA256 与官方 SHASUMS256.txt 一致。

## 分阶段交付
| 阶段 | 内容 | 状态 |
|---|---|---|
| P1 桌面骨架 | 原生窗口（hiddenInset 标题栏、交通灯）、中文菜单栏、⌘ 快捷键、深浅色跟随系统、系统通知、首次启动须知、单实例 | ✅（Linux 实测；Mac 未实测） |
| P2 工作台 + Solo | 可隐藏输入框、模型 / 档位 / 协同开关、预估费用；Monaco 编辑器、文件树、多标签、搜索替换、终端、问题、Git；Solo 真实工具循环 | ✅ |
| P3 三省六部闭环 | Lite / Full 两档真实编排（非前端 mock）：封驳循环、审批门、预算门、依赖并行、成果审议与返工、局部重试、重启恢复 | ✅（mock LLM 集成测试） |
| P4 像素朝堂骨架 | Phaser 3 像素完美渲染、四场景、⌘J 切换与双向同步 | ✅ |
| P5 L2 交互 | 插话、涂改规划、朱批必回应、奏折批阅浮层（方案 / 回奏 / diff / 流转）与准奏封驳 | ✅ |
| P6 正式美术 | 规格锁 + 程序化占位美术 + Aseprite 调色板 + 导入 / 规整工具 + prompt 包 | ⚠️ 占位美术完成；**AI 生图未执行**（本环境无生图服务） |
| P7 全功能面板 | 11 个军机处面板 + 审计日志 + 使用说明 | ✅ |
| 交付 | arm64 `.app`（ad-hoc 签名）、DMG、zip、文档 | ✅（结构校验通过；Mac 实机未验证） |

## 什么是真实的 / 什么是 mock
- **真实**：运行时、状态机、编排、工具执行（真实读写文件、真实执行命令）、审计、持久化、三种协议的 HTTP+SSE 客户端、Electron 应用本身、Editor / 终端 / Git、像素朝堂。
- **mock**：自动化测试中的 LLM 回复（`tests/mockLlm.ts`，脚本化，但使用真实线协议）。应用内**没有任何 mock 数据或假进度**——没配置模型时会明确提示去配置。
- **未验证**：真实模型下的效果（需 Key，脚本已备）；Mac 实机（安装、Gatekeeper、Retina、BSD `script` 终端 resize、`net.fetch` 代理）。

## 已知限制
1. 终端不依赖原生模块：通过系统 `script` 获得 PTY，resize 通过 `stty -f <tty>` 下发；全屏 TUI 程序在极端 resize 下可能错位。
2. Monaco 为 0.40（GitHub 可获取的最新构建版）；语言服务覆盖 TS/JS/JSON/CSS/HTML，其它语言仅高亮。未实现 VS Code 扩展 API——扩展能力通过「技能（SKILL.md）」、MCP 与工具提供。
3. 渲染进程 TSX 未做 tsc 严格类型检查（离线环境无 `@types/react`）；主进程 / 运行时 / 测试已通过 `tsc --strict`。
4. Linux 上生成的 DMG 内部是 ISO9660 + Rock Ridge（与 Bitcoin Core 的 macOS 发布流程相同），不是 HFS+/APFS；如遇挂载问题，使用同时交付的 zip，或在 Mac 上运行 `npm run package:mac`（改用 `hdiutil`）。
5. 签名为 ad-hoc，无公证；首次打开需在「隐私与安全性」中允许。
6. 仅 Apple Silicon；无自动更新。
7. 正式美术尚未生成（见 P6）。
8. 思考档位的自动识别基于模型 id 的经验规则；中转站 / 私有模型请在「模型配置 → 思考程度」确认，或用「协议探测」实测。
9. MCP 只实现了 tools（含 roots / ping 回应、日志通知）；resources / prompts / sampling / elicitation 与 OAuth 登录流程未实现（远程服务可用 headers 携带令牌）。
10. HTML 预览默认只允许本地资源（工作区与 localhost）；页面引用 CDN 时会提示并可由你临时放开。
