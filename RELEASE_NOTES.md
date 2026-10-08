# Release Notes

Release descriptions (English and Chinese) are on the [GitHub Releases page](https://github.com/Logosss1/Edict_Court/releases). Each version keeps its own installers.

## 1.2.7

**What's new**
- **Thinking levels come from the model itself**:
  - **检测思考档位**: a new button in 模型配置, next to 测试连接, and in each model's 思考程度 card. It sends one tiny request per level name (none, minimal, low, medium, high, xhigh, max, ultra) and keeps the ones the service accepts. About ten very small requests per model.
  - Models you add are detected once automatically when you save (up to five at a time).
  - Some relays accept any value. Edict sends a made-up level first; if that is accepted too, the result is marked **未能确认**. Your own settings are kept, otherwise the name-based guess is used. If the name is unknown, a five-step ladder is used (None · Low · Medium · High · XHigh, or Low … Max for Claude-style services); its right end is thinking fully on.
  - The model table shows where the levels came from: 已检测, 未能确认 or 推测.
- **Levels use the API's own names**: None · Minimal · Low · Medium · High · XHigh · Max · Ultra, only the ones the current model has. GPT and Claude models show their own ladders.
- **Hover text**: 「模型想得越深结果越好，但更慢、更费 token。档位来自对当前模型的检测」, followed by the current level. The fixed level list and 「最右是该模型最高档」 are gone.
- **Per-official and per-role thinking levels** (1.2.6) list only the levels of the model that official or role uses. The separate 「该模型最高档」 option is removed; the last entry is the top level.

**Install**: download `Edict-1.2.7-arm64.dmg`. Not signed with a Developer ID and not notarized — allow it once in System Settings → Privacy & Security → "Open Anyway". Your data folder is kept when you install over 1.x.

**Verified**: 54/54 unit + integration tests (including a strict service that accepts only some levels and a relay that accepts anything), 21/21 + 67/67 end-to-end UI checks and the court smoke test on Linux + Xvfb (mock LLM). Not yet verified with a real model service.

## 1.2.6

**What's new**
- **Per-official models are easier to read**: 模型配置 → 官员独立模型与思考程度 now lists the officials one per row instead of a cramped three-column grid. Each row shows the official and their duty, 强 / 经济, a wide model dropdown and a thinking-level dropdown. The default option names the model it follows, e.g. 跟随经济路由（<your economy model>）.
- **Choose a model and thinking level for each role in your own collaboration designs**:
  - The built-in 三省六部 stays read-only. Copy it, or create a new design, and each role's form has two new fields:
    - **模型**: 跟随强/经济路由 (default) or any model from 模型配置.
    - **思考程度**: 跟随旨意 / 模型默认, a specific level, or 该模型最高档.
  - Saving creates a new version as usual. Running edicts keep the version they started with.
  - If a role's model is later removed from 模型配置 (or the service rejects it), that role falls back to its 强/经济 routing and the task log says so once.
  - The canvas role chips and the role table on the design's detail page show each role's model and thinking level.

**Install**: download `Edict-1.2.6-arm64.dmg`. Not signed with a Developer ID and not notarized — allow it once in System Settings → Privacy & Security → "Open Anyway". Your data folder is kept when you install over 1.x.

**Verified**: 53/53 unit + integration tests (including a design whose roles pick their own model and level, and one whose model was removed), 21/21 + 65/65 end-to-end UI checks and the court smoke test on Linux + Xvfb (mock LLM). Not yet verified with a real model service.

## 1.2.5

**Fixes**
- **Collaboration failed while Solo worked (HTTP 503 "不支持该模型或接入方式")**:
  - **Cause**: Solo uses the main model you pick in the composer. In collaboration, 太子, 尚书省 and 六部 use the **economy model** from 模型配置. That defaults to the second model in the service's list, which a relay group may not offer.
  - **Fix**: when the service says it does not offer an economy-class model, that official switches to your main model and carries on. The bad model is skipped for the rest of the session. A notice and a log line name the model and tell you to change the economy model in 模型配置.
  - The main model you picked yourself is never swapped silently. If it fails, the error card still shows.

**What's new**
- **Hover descriptions in the composer**: a short card with a one-line explanation appears above each control: 主模型, 协同设计, Solo / Court Lite / Full Court, 思考, 协同, 朝堂议政, 直接下旨, 续上一会话, the cost estimate, 下旨 and the header buttons. Cards near the bottom of the window open upwards and stay inside the window.

**Install**: download `Edict-1.2.5-arm64.dmg`. Not signed with a Developer ID and not notarized — allow it once in System Settings → Privacy & Security → "Open Anyway". Your data folder is kept when you install over 1.x.

**Verified**: 52/52 unit + integration tests (including a relay that rejects the economy model), 21/21 + 62/62 end-to-end UI checks and the court smoke test on Linux + Xvfb (mock LLM). Not yet verified with a real model service.

## 1.2.4

**What's new**
- **The court follows the palace layout**: leaving 太和殿 by the south door no longer drops you straight at 承天门.
  - **太和殿广场 (new scene)**: the paved court in front of the hall. 太和殿 stands on its three white marble terraces, with the 御路 stairs, bronze vats, cranes and the sundial, and guards along the imperial way.
  - **New route**: 太和殿 → south door → 太和殿广场 → south through 太和门 and 午门 → 承天门 → east along the 千步廊 → 六部值房. 军机处 is still through the west door of 太和殿. 太和殿 no longer has a door straight into 六部值房.
  - 太和殿广场 is also in the court toolbar. It is open-air, so weather, night and stars show there.
- Fixed: the 承天门 gateway can now be entered on foot. Before, it only worked by clicking.

**Install**: download `Edict-1.2.4-arm64.dmg`. Not signed with a Developer ID and not notarized — allow it once in System Settings → Privacy & Security → "Open Anyway". Your data folder is kept when you install over 1.x.

**Verified**: 51/51 unit + integration tests, 21/21 + 61/61 end-to-end UI checks and the court smoke test, which now walks the emperor 太和殿 → 广场 → 承天门 → 六部值房 and back, on Linux + Xvfb (mock LLM). Not yet verified with a real model service.

## 1.2.3

**What's new**
- **Manage your collaboration designs from the list**: every design except the built-in 三省六部 has edit, delete and ☆ favourite buttons on its row. Favourites sort right after 三省六部 and show a ★ in the edict pickers. The built-in can't be deleted; its ✎ opens an unsaved copy. **更多 ▾** in the detail view has favourite, duplicate, disable / enable and delete.
- **Deleting can be undone**: the confirmation says how many versions go with it, and the toast afterwards has **撤销**. A deleted design is kept in `designs/.trash`.
- **Court seating is in a corner**: **朝堂站位** sits at the top right of the editor (next to JSON) and at the end of the versions row in the detail view. It opens a side sheet; for 三省六部 it copies the full version first.
- **Safer editing**:
  - Undo / redo buttons, with ⌘Z / ⇧⌘Z.
  - ⌘S saves.
  - Esc closes the seating sheet or the inspector.
  - Delete removes the selected step, and a toast says it can be undone.
  - Unsaved changes are autosaved. If you leave the editor or the app closes, the list offers **继续编辑 / 丢弃**.
  - Leaving with unsaved changes asks first.
- **A tidier canvas**: empty phase rows fold to a thin strip and open while you drag.
- The 协同设计 hover description no longer mentions court seating.

**Install**: download `Edict-1.2.3-arm64.dmg`. Not signed with a Developer ID and not notarized — allow it once in System Settings → Privacy & Security → "Open Anyway". Your data folder is kept when you install over 1.x.

**Verified**: 51/51 unit + integration tests, 21/21 + 61/61 end-to-end UI checks (including favourite, delete and undo, undo / redo, Delete, Esc, ⌘S and restoring an autosaved draft) and the court smoke test on Linux + Xvfb (mock LLM). Not yet verified with a real model service.

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
