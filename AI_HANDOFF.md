# AI_HANDOFF — Edict for Mac

给下一位接手的工程师 / AI：先读本文件，再读 `docs/STATUS.md`、`docs/ARCHITECTURE.md`。

## 目录
```
src/shared/        types.ts（全部领域类型）· court.ts（官员、状态标签、状态机表）
src/main/          main.ts（Electron 入口、菜单、协议、IPC）· api.ts（IPC 白名单）· secrets.ts（safeStorage）
src/main/runtime/  runtime.ts（唯一状态源）· orchestrator.ts（三省六部引擎）· agentLoop.ts · tools.ts
                   permissions.ts · stateMachine.ts · debate.ts · persist.ts · extras.ts · souls.ts · defaults.ts
src/main/llm/      adapters.ts（3 协议 SSE）· sse.ts · presets.ts
src/main/services/ workspace.ts（路径边界）· exec.ts · git.ts · terminal.ts
src/renderer/      App.tsx · store.ts · workbench/* · panels/* · court/*（CourtMode + Phaser game/*）
scripts/           build.mjs · gen-pixel-assets.mjs + pixel/* · art/import-art.mjs · make-icon.py
                   package-mac.mjs · make-iso.py · verify-dmg.py · verify-real.ts
tests/             unit.test.ts · runtime.test.ts · mockLlm.ts（MOCK）· helpers.ts · run-mock.ts
e2e/               flow.ts（完整 UI 流程 + 截图）· smoke.ts · court-smoke.ts
vendor/            monaco 0.40 min · phaser 3.90 · xterm 5.5（源码编译）· Fusion Pixel 字体（OFL）
assets/            pixel/（生成的占位美术，可被正式美术替换）· icon/
```

## 常用命令
```bash
node scripts/build.mjs [--prod]
npx electron dist                                   # Linux 容器内需 --no-sandbox
npx tsx --test --test-concurrency=1 tests/*.test.ts
xvfb-run -a npx tsx e2e/flow.ts                     # SHOTS=目录 可改截图输出
node scripts/package-mac.mjs                        # 需 ELECTRON_DARWIN_ZIP、RCODESIGN、DMG_TOOL（Linux）
python3 scripts/verify-dmg.py release/Edict-1.0.0-arm64.dmg release/stage
```

## 关键不变量（改动前务必理解）
1. **不可绕过门下省**：`Zhongshu → Menxia → Assigned`；门下结论无法解析时升级御裁，绝不默认准奏。
2. **仅皇上可执行**的流转见 `HUMAN_ONLY`（court.ts）；UI 发起的操作 actor 固定为 `emperor`，Agent/系统不得冒用。
3. **节点不重放**：`drive()` 只运行 pending 节点；新增步骤务必做成带稳定 id 的 `RunNode`，否则局部恢复会失效。
4. **Key 不出主进程**：`ProviderConfig.hasKey` 只是布尔；日志/审计/活动都经过 `redactSecrets`；测试断言 Key 不落盘。
5. 两种模式共享 store：朝堂功能一律调用与工作台相同的 IPC 方法，不要在场景里维护业务状态。

## 下一步建议
- 在 Mac 实机：安装 DMG、跑 `scripts/verify-real.ts`（DeepSeek / Qwen / Claude 各一次）、检查 Retina 下整数缩放与像素字体。
- 用 `docs/ART_PIPELINE.md` 的 prompt 包出正式美术并 `import-art` 替换。
- 可选：任务级 git worktree 隔离（参考 Yan-Agent `worktree-service`）、MCP 工具接入、渲染进程类型检查（装上 `@types/react` 后开启）。
