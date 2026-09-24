# 测试与验证

三类验证严格分开标注，**mock 结果不冒充真实验收**。

## 1. 单元测试（纯逻辑）
`npm test`（`tests/unit.test.ts`）：SSE 解析与空闲超时、JSON 抽取、Key 脱敏、权限策略、工作区边界 / 搜索替换 / 符号大纲、RSS/Atom、方案校验（部门 / 依赖 / 环）、审计哈希链防篡改、各协议端点解析、美术导入网格还原。

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

## 3. 端到端 UI（mock LLM，Linux + Xvfb，真实 Electron）
`npm run e2e`（`e2e/flow.ts`，Playwright `_electron`）：在 UI 中添加模型服务并测试连接 → 打开工作区 → 输入框下旨 → 审批卡片 → 御批结案 → 看板 → Editor 打开 Agent 产物、磁盘改动实时刷新 → 问题面板 TS 诊断 → 终端交互 → 全局搜索 → Full Court 在**朝堂奏折批阅浮层**中涂改方案并放行 → 六部值房 / 军机处 → 朝堂内准奏 → 议政中通过**皇上口谕框**插话 → Solo → 承天门上朝仪式 → 全部面板 → 审计校验 → Key 未落盘。截图输出到 `docs/screenshots/`，结果写入 `docs/screenshots/e2e-results.json`。

## 4. 真实模型（需你本机执行）
```bash
EDICT_BASE_URL=https://api.deepseek.com EDICT_API_KEY=sk-... EDICT_MODEL=deepseek-chat \
EDICT_PROTOCOL=openai-chat EDICT_TIER=lite npx tsx scripts/verify-real.ts
```
脚本使用应用同一个运行时，完成后检查真实文件产物、节点 run ID 与审计链。**本构建环境未执行**（无 Key、无法访问模型服务）。

## 5. 安装包
`python3 scripts/verify-dmg.py release/Edict-1.0.0-arm64.dmg release/stage`：解码 UDIF → 解析 ISO9660/RockRidge → 校验可执行位、框架符号链接、Applications 链接、代码封印存在、主程序与已签名副本逐字节一致。**真实 Mac 上的挂载 / Gatekeeper / 启动未验证。**
