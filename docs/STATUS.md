# 现状与已知限制（v2.1.1）

各版本的改动见 [RELEASE_NOTES.md](../RELEASE_NOTES.md)，测试方法见 [TESTING.md](TESTING.md)。

## 真实与模拟
- **真实**：运行时、状态机、编排、工具执行（真实读写文件、执行命令）、审计、SQLite 存储、三种协议的 HTTP+SSE 客户端、编辑器 / 终端 / Git、旨意工作树与命令快照、语言服务器与 ACP、像素朝堂。
- **模拟**：自动化测试里的模型回复（`tests/mockLlm.ts`，走真实线协议）。应用内没有假数据或假进度，没配置模型时会提示去配置。
- **未充分验证**：真实模型下的效果；真实的 ACP 编辑器、外部智能体与 OAuth 授权服务器（测试里用协议级的模拟程序）。

## 尚未提供
- Intel（x86_64）版本，只支持 Apple Silicon。
- 自动更新。
- Developer ID 签名与公证（目前是 ad-hoc 签名，首次打开需在「隐私与安全性」中允许）。

## 已知限制
1. 终端经系统 `script` 获得 PTY，全屏 TUI 程序在极端 resize 下可能错位。
2. 编辑器是 Monaco 0.40，内置语言服务覆盖 TS/JS/JSON/CSS/HTML；其它语言要本机装有语言服务器才有诊断。不支持第三方编辑器扩展，扩展能力通过技能、MCP、LSP 与工具提供。
3. 类型检查只覆盖 `src/`；`tests/` 与 `e2e/` 由 tsx 直接运行。
4. 在 Linux 上打出的 DMG 内部是 ISO9660 + Rock Ridge；挂载有问题时用同时生成的 zip，或在 Mac 上打包。
5. MCP 支持 tools、resources、prompts 与 OAuth 登录；不支持 sampling 与 elicitation。
6. HTML 预览默认只允许工作区与 localhost 资源，引用 CDN 时需临时放开。
7. 旨意工作树只在有提交的 git 仓库里、且是协同旨意时建立；其它情况在打开的工作区里依次执行。主工作区未提交的改动不会带进工作树。
8. 命令改动快照会把命令执行期间工作区的所有改动都记到该命令名下；工作区超过 2 万个文件或快照超过 512 MB 时不再做快照。
9. 编辑器接入（ACP）一次只对应一个工作区；方案御览、御批等关卡要回到 Edict 处理；图片和音频附件被忽略。
10. 命令沙箱只在 macOS 上生效（`sandbox-exec`）；终端里你自己敲的命令不进沙箱。
11. 网页抓取只取页面文本、不执行脚本；「模型自带搜索」只在官方 Anthropic Messages / OpenAI Responses 接口上可用。
12. 定时旨意只在 Edict 运行时触发，错过的时间回来后最多补跑一次。
