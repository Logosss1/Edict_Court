# Release Notes

Release descriptions (English and Chinese) are on the [GitHub Releases page](https://github.com/Logosss1/Edict_Court/releases). Each version keeps its own installers.

## 1.2.2

**What's new**
- **Design your own collaboration**: user designs can now be edited, not just copied and rolled back.
  - **Flow canvas**: phases are rows and steps run left to right. Drag a step to reorder it or change its phase; drop it on another step to run them in parallel; drag new steps in from the toolbar; drop a role on a step to assign it; drag a review's ↺ knob onto an earlier step to choose where a rejection sends the work.
  - **Form editor**: every field of roles (name, duty, prompt, model tier, tool access, court figure), steps (type, phase, performer, executors, instruction, rejection target and limit, gates, inputs, parallel, optional, timeout) and rules (budget, rejection limit, parallelism, final 御批, self-healing). A JSON view is there for advanced edits.
  - Each save is checked first and becomes a new version you can roll back. Edicts already running keep their version. **新建** starts from a blank design; copying 三省六部 opens the copy in the editor. The built-in 三省六部 itself stays read-only.
- **Court layout per design**: place each role anywhere in 太和殿, 军机处, 六部值房 or 承天门, and choose facing, pose (standing, seated at a desk, kneeling) and what they do while idle (reading, writing, abacus, tea…). When an agent is working, its animation still follows the work. You can show only your design's roles or keep the built-in officials. The court uses the layout of the design chosen for new edicts. The layout is display-only and never changes how an edict runs.
- **Hover descriptions**: every icon in the left activity bar, every item in the 军机处 list and the court toolbar shows its name, a one-line description and its shortcut after a short pause.

**Install**: download `Edict-1.2.2-arm64.dmg`. Not signed with a Developer ID and not notarized — allow it once in System Settings → Privacy & Security → "Open Anyway". Your data folder is kept when you install over 1.x.

**Verified**: 50/50 unit + integration tests, 21/21 + 45/45 end-to-end UI checks (including dragging on the canvas and in the court layout, saving, and the court following the layout) and the court smoke test on Linux + Xvfb (mock LLM). Not yet verified with a real model service.

## 1.2.1

**What's new**
- **Collaboration designs**: the Three Departments and Six Ministries flow is now a versioned design you can copy, edit, pin per edict and roll back. Running edicts keep the version they started with.
- **A finer Tang court**: all four scenes redrawn at twice the detail in Tang style (hip roofs with 鸱尾, deep brackets, vermilion columns and white walls, lotus floor tiles, a 青绿山水 screen behind the throne, que towers at 承天门). Officials wear Tang rank robes and 幞头 and have 29 animations; what they do follows what the agent is doing (writing, reviewing, sealing, dispatching, abacus, scheming, weighing the law, measuring…). Still pixel art and 2D, so it stays light.
- **Things to do in the court** (none of them change how edicts run):
  - Hover an official for their current edict, model and token use.
  - Click an official for 召见, past edicts, 赏赐 / 训诫 (animation only) or 催办 (adds a 朱批 note).
  - Click scene objects to open panels: notice board → 天下要闻, throne table → 奏折阁, memorial wall → 旨意看板, ministry desk → that ministry's edicts.
  - Walk between halls through the doors. The emperor can walk with the arrow keys or by clicking the floor; Space next to an official summons them.
  - **奏折回放** re-enacts a finished edict's journey in 太和殿 from its records.
  - Day and night follow the clock. Weather can be clear, rain, snow or falling petals. Bell, drum and birdsong are off by default.
  - Small surprises: a cat on the wall, birds, lanterns you can light, incense you can add.
- **Left sidebar**: new entries for 网页预览 (workspace HTML files or a dev-server URL), 协同设计 and 进入朝堂. The 军机处 list is grouped into 政务 / 配置 / 记录, and new items carry a 新 badge.

**Install**: download `Edict-1.2.1-arm64.dmg`. Not signed with a Developer ID and not notarized — allow it once in System Settings → Privacy & Security → "Open Anyway". Your data folder is kept when you install over 1.x.

**Verified**: 48/48 unit + integration tests, 21/21 + 32/32 end-to-end UI checks and the court smoke test on Linux + Xvfb (mock LLM). Not yet verified with a real model service.

## 1.1.0

**What's new**
- **Thinking-level slider** in the edict box and the court: its steps are the selected model's own levels, and the far right is always that model's highest level. Set per model (OpenAI `reasoning_effort` / `reasoning.effort`, Claude `output_config.effort` or `thinking.budget_tokens`, Qwen, GLM, or custom JSON with levels like `ultra`) and per official. If a service rejects the parameter, it is dropped and the call retried once.
- **Readable model errors**: relay errors such as HTTP 503 "this group doesn't support the model or access method" are no longer retried blindly. An error card explains the cause and offers **retry with another model** (re-runs only the failed step). **Protocol probe** in Models tests Chat / Responses / Messages with and without thinking parameters.
- **HTML preview**: run generated pages in a sandboxed built-in browser with a console, device sizes, auto-reload and outbound-network blocking. Agents check their pages with the new `preview_page` tool (errors + screenshot).
- **Skills & MCP center**: create, edit, enable and assign Skills; configure MCP servers with Cursor's `mcp.json` format (stdio, Streamable HTTP, legacy SSE), per-tool risk and approval, per-official grants. Local commands need your confirmation; secrets move into the macOS keychain.

**Install**: download `Edict-1.1.0-arm64.dmg`. Not signed with a Developer ID and not notarized — allow it once in System Settings → Privacy & Security → "Open Anyway". Your data folder is kept when you install over 1.0.0.

**Verified**: 41/41 unit + integration tests (mock LLM; MCP against a real process and real local HTTP servers), 20/20 + 19/19 end-to-end UI checks on Linux + Xvfb, DMG structure check. Not yet verified on a real Mac or with a real model service.

SHA-256 `Edict-1.1.0-arm64.dmg`: `efca3d6610bdfc4c56b0da399549570671bd051433b5fc50239cbba562b36f23`

## 1.0.0

A new codebase that replaces the 0.x desktop packaging. 1.x ships for Apple Silicon Macs only; the 0.x releases (Intel macOS, Windows, Linux) remain available below.

**Highlights**
- Two modes on one runtime, switched with ⌘J: a Cursor-style **workbench** (edict box, activity stream, Monaco editor, terminal, search, Git) and a **pixel Tang-dynasty court** with four scenes.
- Three collaboration tiers: **Solo**, **Court Lite** (default) and **Full Court**, following EDICT's Three Departments and Six Ministries state machine — no path bypasses the Chancellery's review.
- Real-time intervention: pause / cancel / resume, notes the agent must answer, interjections in court debates, editing the plan before release, and a memorial review overlay.
- SHA-256 hash-chained audit log, persisted run nodes with local retry and restart recovery.
- OpenAI Chat Completions, Anthropic Messages and OpenAI Responses with your own base URL, key and model; no hard-coded keys.
- Token economy: strong/economy routing, repo map and symbol outlines, prompt caching, rolling compression, budgets and estimates.

**Install**: download `Edict-1.0.0-arm64.dmg`. Not signed with a Developer ID and not notarized — allow it once in System Settings → Privacy & Security → "Open Anyway".

**Verified**: 24/24 unit + integration tests (mock LLM), 20/20 end-to-end UI checks on Linux + Xvfb, DMG structure check. Not verified on a real Mac or with a real model service.

SHA-256 `Edict-1.0.0-arm64.dmg`: `743b0543253cf6311d23b378c685248f4cd3028b3d2d0d0c5560623929dc4234`

## 0.x

The 0.1.0 – 0.3.2 releases were a desktop packaging of the upstream EDICT runtime for macOS, Windows and Linux. Their source is available at the `v0.3.2` and earlier tags, and their installers remain on the Releases page.
