# 现状盘点与交付清单（v1.0.0）

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
2. Monaco 为 0.40（GitHub 可获取的最新构建版）；语言服务覆盖 TS/JS/JSON/CSS/HTML，其它语言仅高亮。未实现 VS Code 扩展 API——扩展能力通过「技能（SKILL.md）」与工具提供。
3. 渲染进程 TSX 未做 tsc 严格类型检查（离线环境无 `@types/react`）；主进程 / 运行时 / 测试已通过 `tsc --strict`。
4. Linux 上生成的 DMG 内部是 ISO9660 + Rock Ridge（与 Bitcoin Core 的 macOS 发布流程相同），不是 HFS+/APFS；如遇挂载问题，使用同时交付的 zip，或在 Mac 上运行 `npm run package:mac`（改用 `hdiutil`）。
5. 签名为 ad-hoc，无公证；首次打开需在「隐私与安全性」中允许。
6. 仅 Apple Silicon；无自动更新。
7. 正式美术尚未生成（见 P6）。
