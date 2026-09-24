# 安全、权限与数据

## 进程与渲染隔离
- Renderer：`sandbox: true`、`contextIsolation: true`、`nodeIntegration: false`；只通过 preload 暴露的 `invoke / onEvent` 访问白名单 API（`src/main/api.ts`）。
- 页面由自定义 `app://` 协议提供，协议处理器拒绝越出 `dist/` 的路径；CSP 仅允许同源脚本；禁止页面导航与新窗口（外链只允许 http/https 并交给系统浏览器）。
- 权限请求（摄像头、定位等）一律拒绝，仅允许剪贴板写入与通知。

## HTML 预览
- 工作区通过私有协议 `preview://ws/` 只读提供，**不开放任何网络端口**；复用工作区路径边界（拒绝越界与符号链接逃逸），拒绝 `.git/`、`.env*`、密钥文件。
- 预览页运行在独立会话分区 `edict-preview`：`<webview>` 在 `will-attach-webview` 中被强制去掉 preload、开启 sandbox / contextIsolation、关闭 Node；不允许弹窗、下载、任何权限请求；导航只允许 `preview://ws` 与 localhost。
- 预览页的**外发网络默认拦截**（只放行工作区、localhost、data/blob），防止 Agent 生成的页面把数据发往外部；需要 CDN 时由你在预览栏确认放开（设置项 `previewAllowNetwork`），可随时恢复。
- Agent 工具 `preview_page` 使用同一分区的离屏隐藏窗口，串行执行、20 秒超时，结果与截图写入审计 / 快照库。

## MCP 服务
- 配置文件 `mcp.json`（Cursor 格式）存于数据目录；保存时**形似密钥的值**（名称含 key/token/secret/password/auth…，或值形如 `sk-…`、`ghp_…`、`Bearer …`；以及 `--api-key=…` 类参数）移入钥匙串加密存储，文件中只留 `${secret:…}` 占位。
- **本地命令**（stdio）以你的用户身份运行：首次运行、或命令行 / 参数 / cwd 改变时必须在原生对话框中确认（信任记录为命令行哈希）；子进程环境剔除含 KEY/TOKEN/SECRET 的变量，只注入你为该服务配置的变量。
- 工具调用受权限模式约束：只读工具直接执行；有副作用工具需批准（可逐个勾选自动批准，或全自动模式）；**高风险工具任何模式下都须确认**；只读模式下只能用只读工具；规划 / 审议类官员只拿到只读工具；可按官员授权。审计记录服务、工具、耗时与**参数名**（不记参数值）。

## Agent 权限模式
| 模式 | 读 | 写文件 | 命令 |
|---|---|---|---|
| 只读 | ✓ | ✗ | ✗ |
| 询问 | ✓ | 需批准 | 需批准 |
| 自动编辑（默认） | ✓ | 自动 | 安全命令自动（测试 / 构建 / git status 等），其它需批准 |
| 全自动 | ✓ | 自动 | 自动 |

**任何模式下都必须皇上确认的高风险操作**：递归删除、`sudo`、`git push`、`git reset --hard` 等丢弃修改、下载并执行远程脚本、发布包、批量改权限、磁盘操作、网络外发（curl/wget/ssh/scp/rsync/nc）、安装/卸载依赖、读取钥匙串、删除文件、读取/改写敏感文件（`.env*`、`*.pem`、`*.key`、`id_rsa`、`credentials`）。

## 路径边界
所有文件工具经 `Workspace.resolve`：拒绝工作区外路径、拒绝经符号链接逃逸（检查最近存在祖先的 realpath）、禁止改写 `.git/` 内部；越界尝试写入审计 `path_boundary_violation`。命令在工作区根目录执行，超时（默认 120s，最长 600s）后连同进程组终止，输出上限 64KB；子进程环境剔除名称含 KEY/TOKEN/SECRET/PASSWORD/CREDENTIAL 的变量。

## 数据存放（本地存储不是安全沙箱）
`~/Library/Application Support/Edict/EdictData/`：
- `state.json` 任务、议政、会话、奏折、朱批、要闻、统计
- `settings.json` 设置与模型服务（**不含 Key**）
- `secrets.json` API Key：Electron `safeStorage`（macOS 钥匙串派生密钥）加密后 base64；若系统不支持加密会在「模型配置」中明示
- `mcp.json`（MCP 服务，不含密钥）· `mcp-policy.json`（工具策略、授权、已信任命令哈希）
- `audit.jsonl` 哈希链审计；`activity/*.jsonl` 活动流；`blobs/` 文件改动前后快照（内容寻址）；`skills/*/SKILL.md`

任何能读取你用户目录的进程都能读取这些文件（Key 除外，需钥匙串解密）。

## 外发请求范围
仅以下几类，且都由你配置或主动触发：
1. 「模型配置」中填写的模型服务 base_url；
2. 「天下要闻」中你添加的 RSS/Atom 地址（点「采集」时）；
3. 「技能与 MCP」中你粘贴的远程 SKILL.md（仅 https）；
4. 你在 `mcp.json` 中配置的远程 MCP 服务地址，以及你批准运行的本地 MCP 程序自身发起的请求（由该程序决定）；
5. 仅当你在预览栏允许外部网络时，被预览页面引用的外部资源。

应用本身不包含遥测、更新检查或任何预置外部地址。API Key 只作为请求头发往对应 base_url，不写入日志、审计、活动流、导出或测试夹具（测试中有断言检查）。

## 安装包
未经 Apple Developer ID 签名、未公证（仅 ad-hoc 签名）。见 [INSTALL_MAC.md](INSTALL_MAC.md)。
