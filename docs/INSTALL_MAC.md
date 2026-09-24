# Edict for Mac · 安装与首次打开（Apple Silicon / arm64）

> ⚠️ 本安装包 **未经 Apple Developer ID 签名、未经公证（notarization）**，仅做了 ad-hoc 签名。
> 只从你信任的来源获取本安装包。仅支持 Apple Silicon（M1 及以后），不支持 Intel Mac。

## 安装
1. 双击 `Edict-1.1.0-arm64.dmg`，把 **Edict.app** 拖到 **Applications（应用程序）**。
2. 首次打开时 macOS 会提示「无法验证开发者」或「Apple 无法检查其是否包含恶意软件」：
   - 点「完成 / 取消」；
   - 打开 **系统设置 → 隐私与安全性**，在页面下方找到 “已阻止使用 Edict” → 点 **仍要打开**，输入密码确认；
   - 再次打开 Edict，点 **打开**。
3. 若提示「已损坏，无法打开」（通常是下载时带了隔离属性），可在终端执行：
   `xattr -dr com.apple.quarantine /Applications/Edict.app`
   （这会移除隔离标记，请确认来源可信后再执行。）

## 风险说明
- 未公证意味着 Apple 没有扫描过本程序；安全性依赖你对来源与源码的信任。
- 本应用会在你授权的工作区内读写文件、执行命令（高风险命令需你逐条确认）。
- API Key 由 macOS 钥匙串（Electron safeStorage）加密保存在
  `~/Library/Application Support/Edict/EdictData/secrets.json`；任务、审计、会话在同一目录。本地存储不是安全沙箱。
- 外发网络请求只发往：你在「模型配置」中填写的模型服务、你手动添加的新闻源与远程技能链接、你配置的 MCP 服务；本地 MCP 程序仅在你确认后运行。

## 卸载
删除 `/Applications/Edict.app` 与 `~/Library/Application Support/Edict/`。
