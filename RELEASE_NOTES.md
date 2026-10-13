# Release Notes

Release descriptions are on the [GitHub Releases page](https://github.com/Logosss1/Edict_Court/releases). Each version keeps its own installers.

## 2.1.0

**What's new**
- **Web reading and search.** Officials can read web pages by default. Only public http(s) addresses are fetched: loopback, private and link-local addresses are refused, and every redirect is checked again. Search goes through a search service you set up in Settings › Web & search, or the model's own web search. If an edict needs search and none is set up, the official asks you; the setup opens on the card, can be tested there, and is saved to Settings. Keys are kept in the keychain.
- **Command sandbox.** Officials' shell commands run in a macOS sandbox. They can write only to the workspace (or the edict's worktree and its git folder), temporary folders and package caches, and cannot read the folders that hold keys, tokens and browser data, or Edict's own data folder. Network access is on by default and can be turned off. When the sandbox blocks a command, a card offers to run it once without the sandbox, allow that folder for the workspace, or stop. See Settings › Permissions & approvals.
- **Requirement spec and final check.** Plans start with a requirement spec (goal, numbered acceptance criteria, out of scope, constraints), and each subtask names the criteria it delivers. After the ministries finish, the Chancellery checks each criterion and gives a verdict with evidence; a "met" without real evidence counts as unknown. Unmet criteria go back to the ministry for another round (1 by default, 0 to 3), and if they are still unmet the edict waits for your decision. The spec can be edited on the plan, and the memorial lists the check. On by default in Court Lite and Full Court; set it in Settings › Run policy.
- **Scheduled edicts.** A new Schedules page: daily, on chosen weekdays, every few hours, at morning court (6:00) or once; stop after a number of runs or on a date. Each schedule runs in its own folder with its own mode, design and model, and goes straight to work without triage. Permissions are set when you schedule it: read only, ask before every change, or work inside its own git worktree with the merge left to you. A run missed while Edict was closed or the Mac was asleep runs once on return (or is skipped, your choice). Officials can propose a schedule; it waits for your approval.
- **Outside coding agents as officials.** Coding agents installed on your Mac that speak ACP can do a ministry's subtask. Settings › Outside agents finds them, shows how to install the missing ones, tests the connection, and lets you add any other ACP agent by its command. Choose an agent per ministry, or per subtask on the plan. Agents work only in the edict's worktree; their file and command requests go through Edict's permissions and sandbox, and files they change with their own tools are recorded and can be reverted. If an agent can't start or isn't logged in, the ministry's own official takes over. Edict never installs or logs in to an agent for you.
- **Several attempts at one subtask.** When you review a plan, a write subtask can get two or three lanes, each done by an official (with any model) or an outside agent, with a cost estimate. The lanes work side by side in their own worktrees, the Chancellery scores them, and on the new comparison page you see each lane's changes, score, time and cost and pick one. Its changes are merged into the edict's worktree; the others can be kept as branches. In full-auto mode and in schedules that work in a worktree, the Chancellery picks. Available in Full Court, and in Court Lite when turned on in Settings.
- **Worktree setup.** Per workspace, in Settings › Worktrees: copy untracked files such as `.env` into each new edict worktree, link dependency folders, and run a setup script before the officials start. Each worktree gets its own block of 10 ports, passed to commands as `EDICT_PORT` and `EDICT_PORT_RANGE`.

**Fixes**
- Cancelling an edict now stops the commands and model requests that are still running, instead of waiting for them to finish.

**Install**: download `Edict-2.1.0-arm64.dmg`. Not signed with a Developer ID and not notarized — allow it once in System Settings → Privacy & Security → "Open Anyway". Your data is kept when you install over 2.0.x.

## 2.0.3

**What's new**
- **A living palace.** The court runs on your Mac's clock. Morning court opens by itself between 6 and 9; during the day officials work in their own offices, in the evening they leave one by one, and at night the halls are empty. Call court at any time from the court toolbar or with the drum at Chengtian Gate; an idle court ends after a few minutes (3, 5, 10 or 20, your choice).
- **Ten scenes.** The Hall of Supreme Harmony, the Palace Square, Chengtian Gate, the Privy Council, the Six Ministries Office, the Eastern Palace, the Imperial Garden, the Long Palace Street, the Corner Tower and a palace map you can click to travel. Doors follow the palace layout, and you and the officials walk through them.
- **The work, acted out.** Officials carry memorials between offices, runners take messages from hall to hall, rejected plans come back stamped, and an official who needs your decision walks to wherever you are and kneels to ask. Officials bow when you pass, and a ministry that is busy is excused from court and keeps working.
- **Details.** The real phase of the moon, the seasons, festival lanterns and fireworks, a palace cat, and koi you can feed in the garden.
- **The Crown Prince asks first.** When an edict is ambiguous, the Crown Prince asks one short question with likely answers before the court starts work, then carries on with your answer. Other officials ask in their own voice. You can turn this off in Settings › Permissions & approvals.

**Changes**
- Decision cards in court mode offer the same choices as in the workbench, including answering an official's question, and they stay in the corner of the window instead of scrolling away.

**Install**: download `Edict-2.0.3-arm64.dmg`. Not signed with a Developer ID and not notarized — allow it once in System Settings → Privacy & Security → "Open Anyway". Your data is kept when you install over 2.0.x.

## 2.0.2

**Fixes**
- The "New" tags in the Settings navigation now go away once you open that page, and stay hidden after a restart. Pages you haven't opened keep their tag. (This fix first shipped in 2.0.1.)

**Changes**
- Wording in the app and the documentation was tidied: labels, hints and descriptions now describe each feature on its own terms, and the English documents no longer quote Chinese interface labels.

**Install**: download `Edict-2.0.2-arm64.dmg`. Not signed with a Developer ID and not notarized — allow it once in System Settings → Privacy & Security → "Open Anyway". Your data is kept when you install over 2.0.x.

## 2.0.1

**Fixes**
- The "New" tags in the Settings navigation now go away once you open that page, and stay hidden after a restart. Pages you haven't opened keep their tag.

**Install**: download `Edict-2.0.1-arm64.dmg`. Not signed with a Developer ID and not notarized — allow it once in System Settings → Privacy & Security → "Open Anyway". Your data is kept when you install over 2.0.0.

## 2.0.0

The first 2.x release.

**What's new**
- **Execution you stay in charge of**:
  - Every subtask is tagged read, write or verify. Read subtasks run side by side; write and verify subtasks run one at a time, and only one writer works on an edict at once.
  - Subtasks start read-only. Before each write subtask starts, a card in the agent pane asks: allow, allow and skip further asks for writes and commands in this subtask, run it read-only instead, or reject, with an optional note. A read subtask that tries to change files asks first. Full-auto mode skips these cards.
  - Approval cards offer allow, allow without asking again for this edict, allow permanently for this workspace, and reject. Settings › Permissions & approvals lists the rules with where they came from, and you can revoke them. High-risk actions always ask.
  - Release and deploy commands (`git push`, publish, deploy tools …) ask every time, unless you turn on permanent allow for that workspace in Permissions & approvals.
  - **Result check**: files an official claims are hashed and checked against the changes Edict recorded. Missing evidence marks the result as doubtful, and Court Lite then stops for your final approval.
  - **Asking the emperor**: officials can stop and ask you a question with options. **Canon**: your standing rules (prohibitions / rules / preferences / lessons) and the project's rule files (`AGENTS.md`, `.edict/rules.md` and the like) go into planning, review and execution.
  - Files changed by `run_command` are recorded too (shadow snapshots), so "revert changes" and "revert and redo" work for a node or a whole edict.
  - `preview_page` can click, fill, press keys, wait and check text in the page, and capture extra viewport sizes.
- **One git worktree per edict** (on by default in git repositories):
  - Court edicts on the same repository run side by side, each on its own branch `edict/<id>` in a folder inside the data folder. The checkout you have open is not touched until you close the edict.
  - The dialog for closing an edict lists each changed file with line counts and the official (or command) that last changed it, and offers merge / keep branch / discard with an editable commit subject. A merge that would conflict is stopped and the branch kept.
  - You can also create a worktree yourself and open it as the workspace, from Source Control or Settings › Worktrees.
- **MCP**:
  - Log in to remote servers with OAuth. The browser opens only when you click "Log in"; a short-lived port on 127.0.0.1 receives the callback.
  - Resources and prompts. In the edict box, `/` lists MCP prompts and `@` inserts a resource reference; the resource text is attached when you send the edict.
  - New Settings › Connected services (MCP) page: status tiles and filters, add cards for remote and local servers that show which values go to the keychain, and server cards with login, trust, tool permissions, resources, prompts and logs.
- **Language servers (LSP)**: Edict finds language servers already installed on your Mac (24 well-known ones) and shows install commands for the missing ones; it installs nothing itself. Officials get an `lsp` tool (diagnostics, definition, references, hover, symbols), and the editor shows the servers' diagnostics. See Settings › Language servers.
- **Editors over ACP**: editors that speak ACP can send edicts to Edict over a local socket (no network port), follow progress and answer permission requests. Off by default; each editor must be approved the first time it connects. Settings › Editor connection has the switch and an editor configuration example to copy.
- **Built-in skill pack**: 37 skills for planning, review, investigation, QA, design, release, deploy, safety and everyday work. Each official holds a few duty skills; the rest are installed but not equipped. On Settings › Skills you switch extra skills on per official. The skills an official loaded are recorded, with their hash, on the edict and the memorial.
- **A new look**:
  - **Settings** is one tab with a left nav and search: Appearance & notifications, Storage & backup, Model services, Official models & routing, Run policy, Permissions & approvals, Canon, Connected services, Skills, Language servers, Editor connection, Worktrees, Audit log, Help.
  - **Activity bar**: To-do and Web preview side views, screens you can pin (right-click to customize), and Connected services / Skills / Permissions / Terminal / Settings at the bottom.
  - **Edict board**: stat tiles, a "Needs you" lane with inline actions, filters (including worktree) and a list view.
  - **Agent pane**: decision cards (number keys, ⏎, Esc), a plan card with each subtask's tag and live status, and a result-check line for each ministry.
  - Desktop notifications: all, only what needs me, or off (Settings › Appearance & notifications).
- **SQLite storage**: everything that was in `state.json` and `settings.json` now lives in one database, `edict.db`. Settings › Storage & backup shows where it is and makes a backup on demand.

**Install**: download `Edict-2.0.0-arm64.dmg`. Not signed with a Developer ID and not notarized — allow it once in System Settings → Privacy & Security → "Open Anyway". When you install over 1.x, your data is migrated into `edict.db` on first launch, and the original `state.json` / `settings.json` are kept in a `backup-1.x-…` folder inside the data folder, with rollback steps in its `README.txt`.

**Verified**: 179/179 unit + integration tests, 21/21 + 78/78 end-to-end UI checks, the court smoke test and the app smoke test on Linux + Xvfb (mock LLM). Not yet verified with a real model service.

**Not included**: an Intel (x86_64) build, auto-update, and Developer ID signing and notarization.

## 1.2.7

**What's new**
- **Thinking levels come from the model itself**:
  - **Detect thinking levels**: a new button in Model settings, next to Test connection, and in each model's thinking-level card. It sends one tiny request per level name (none, minimal, low, medium, high, xhigh, max, ultra) and keeps the ones the service accepts. About ten very small requests per model.
  - Models you add are detected once automatically when you save (up to five at a time).
  - Some relays accept any value. Edict sends a made-up level first; if that is accepted too, the result is marked **unconfirmed**. Your own settings are kept, otherwise the name-based guess is used. If the name is unknown, a five-step ladder is used (None · Low · Medium · High · XHigh, or Low … Max for services on the Anthropic Messages protocol); its right end is thinking fully on.
  - The model table shows where the levels came from: detected, unconfirmed or guessed.
- **Levels use the API's own names**: None · Minimal · Low · Medium · High · XHigh · Max · Ultra, only the ones the current model has. GPT and Claude models show their own ladders.
- **Hover text**: "The deeper the model thinks, the better the result, but it is slower and uses more tokens. Levels come from detecting the current model", followed by the current level. The fixed level list and the "far right is this model's top level" note are gone.
- **Per-official and per-role thinking levels** (1.2.6) list only the levels of the model that official or role uses. The separate "this model's top level" option is removed; the last entry is the top level.

**Install**: download `Edict-1.2.7-arm64.dmg`. Not signed with a Developer ID and not notarized — allow it once in System Settings → Privacy & Security → "Open Anyway". Your data folder is kept when you install over 1.x.

**Verified**: 54/54 unit + integration tests (including a strict service that accepts only some levels and a relay that accepts anything), 21/21 + 67/67 end-to-end UI checks and the court smoke test on Linux + Xvfb (mock LLM). Not yet verified with a real model service.

## 1.2.6

**What's new**
- **Per-official models are easier to read**: Model settings → per-official models and thinking levels now lists the officials one per row instead of a cramped three-column grid. Each row shows the official and their duty, strong / economy, a wide model dropdown and a thinking-level dropdown. The default option names the model it follows, e.g. "follow economy routing (<your economy model>)".
- **Choose a model and thinking level for each role in your own collaboration designs**:
  - The built-in Three Departments and Six Ministries design stays read-only. Copy it, or create a new design, and each role's form has two new fields:
    - **Model**: follow strong / economy routing (default) or any model from Model settings.
    - **Thinking level**: follow the edict / model default, a specific level, or this model's top level.
  - Saving creates a new version as usual. Running edicts keep the version they started with.
  - If a role's model is later removed from Model settings (or the service rejects it), that role falls back to its strong / economy routing and the task log says so once.
  - The canvas role chips and the role table on the design's detail page show each role's model and thinking level.

**Install**: download `Edict-1.2.6-arm64.dmg`. Not signed with a Developer ID and not notarized — allow it once in System Settings → Privacy & Security → "Open Anyway". Your data folder is kept when you install over 1.x.

**Verified**: 53/53 unit + integration tests (including a design whose roles pick their own model and level, and one whose model was removed), 21/21 + 65/65 end-to-end UI checks and the court smoke test on Linux + Xvfb (mock LLM). Not yet verified with a real model service.

## 1.2.5

**Fixes**
- **Collaboration failed while Solo worked (HTTP 503 "model or access method not supported")**:
  - **Cause**: Solo uses the main model you pick in the composer. In collaboration, the Crown Prince, the Department of State Affairs and the Six Ministries use the **economy model** from Model settings. That defaults to the second model in the service's list, which a relay group may not offer.
  - **Fix**: when the service says it does not offer an economy-class model, that official switches to your main model and carries on. The bad model is skipped for the rest of the session. A notice and a log line name the model and tell you to change the economy model in Model settings.
  - The main model you picked yourself is never swapped silently. If it fails, the error card still shows.

**What's new**
- **Hover descriptions in the composer**: a short card with a one-line explanation appears above each control: main model, collaboration design, Solo / Court Lite / Full Court, thinking, collaboration, court debate, direct edict, continue last session, the cost estimate, the send button and the header buttons. Cards near the bottom of the window open upwards and stay inside the window.

**Install**: download `Edict-1.2.5-arm64.dmg`. Not signed with a Developer ID and not notarized — allow it once in System Settings → Privacy & Security → "Open Anyway". Your data folder is kept when you install over 1.x.

**Verified**: 52/52 unit + integration tests (including a relay that rejects the economy model), 21/21 + 62/62 end-to-end UI checks and the court smoke test on Linux + Xvfb (mock LLM). Not yet verified with a real model service.

## 1.2.4

**What's new**
- **The court follows the palace layout**: leaving the Hall of Supreme Harmony by the south door no longer drops you straight at Chengtian Gate.
  - **Taihe Palace Square (new scene)**: the paved court in front of the hall. The hall stands on its three white marble terraces, with the imperial-way stairs, bronze vats, cranes and the sundial, and guards along the imperial way.
  - **New route**: Hall of Supreme Harmony → south door → Taihe Palace Square → south through the Gate of Supreme Harmony and the Meridian Gate → Chengtian Gate → east along the Thousand-Step Corridor → Six Ministries Office. The Privy Council is still through the west door of the hall, which no longer has a door straight into the Six Ministries Office.
  - Taihe Palace Square is also in the court toolbar. It is open-air, so weather, night and stars show there.
- Fixed: the Chengtian Gate gateway can now be entered on foot. Before, it only worked by clicking.

**Install**: download `Edict-1.2.4-arm64.dmg`. Not signed with a Developer ID and not notarized — allow it once in System Settings → Privacy & Security → "Open Anyway". Your data folder is kept when you install over 1.x.

**Verified**: 51/51 unit + integration tests, 21/21 + 61/61 end-to-end UI checks and the court smoke test, which now walks the emperor from the hall to the square, Chengtian Gate and the Six Ministries Office and back, on Linux + Xvfb (mock LLM). Not yet verified with a real model service.

## 1.2.3

**What's new**
- **Manage your collaboration designs from the list**: every design except the built-in Three Departments and Six Ministries has edit, delete and ☆ favourite buttons on its row. Favourites sort right after the built-in design and show a ★ in the edict pickers. The built-in can't be deleted; its ✎ opens an unsaved copy. **More ▾** in the detail view has favourite, duplicate, disable / enable and delete.
- **Deleting can be undone**: the confirmation says how many versions go with it, and the toast afterwards has **Undo**. A deleted design is kept in `designs/.trash`.
- **Court seating is in a corner**: **Court seating** sits at the top right of the editor (next to JSON) and at the end of the versions row in the detail view. It opens a side sheet; for the built-in design it copies the full version first.
- **Safer editing**:
  - Undo / redo buttons, with ⌘Z / ⇧⌘Z.
  - ⌘S saves.
  - Esc closes the seating sheet or the inspector.
  - Delete removes the selected step, and a toast says it can be undone.
  - Unsaved changes are autosaved. If you leave the editor or the app closes, the list offers **continue editing / discard**.
  - Leaving with unsaved changes asks first.
- **A tidier canvas**: empty phase rows fold to a thin strip and open while you drag.
- The collaboration-design hover description no longer mentions court seating.

**Install**: download `Edict-1.2.3-arm64.dmg`. Not signed with a Developer ID and not notarized — allow it once in System Settings → Privacy & Security → "Open Anyway". Your data folder is kept when you install over 1.x.

**Verified**: 51/51 unit + integration tests, 21/21 + 61/61 end-to-end UI checks (including favourite, delete and undo, undo / redo, Delete, Esc, ⌘S and restoring an autosaved draft) and the court smoke test on Linux + Xvfb (mock LLM). Not yet verified with a real model service.

## 1.2.2

**What's new**
- **Design your own collaboration**: user designs can now be edited, not just copied and rolled back.
  - **Flow canvas**: phases are rows and steps run left to right. Drag a step to reorder it or change its phase; drop it on another step to run them in parallel; drag new steps in from the toolbar; drop a role on a step to assign it; drag a review's ↺ knob onto an earlier step to choose where a rejection sends the work.
  - **Form editor**: every field of roles (name, duty, prompt, model tier, tool access, court figure), steps (type, phase, performer, executors, instruction, rejection target and limit, gates, inputs, parallel, optional, timeout) and rules (budget, rejection limit, parallelism, final imperial approval, self-healing). A JSON view is there for advanced edits.
  - Each save is checked first and becomes a new version you can roll back. Edicts already running keep their version. **New** starts from a blank design; copying the built-in design opens the copy in the editor. The built-in Three Departments and Six Ministries design itself stays read-only.
- **Court layout per design**: place each role anywhere in the Hall of Supreme Harmony, the Privy Council, the Six Ministries Office or Chengtian Gate, and choose facing, pose (standing, seated at a desk, kneeling) and what they do while idle (reading, writing, abacus, tea…). When an agent is working, its animation still follows the work. You can show only your design's roles or keep the built-in officials. The court uses the layout of the design chosen for new edicts. The layout is display-only and never changes how an edict runs.
- **Hover descriptions**: every icon in the left activity bar, every item in the Privy Council list and the court toolbar shows its name, a one-line description and its shortcut after a short pause.

**Install**: download `Edict-1.2.2-arm64.dmg`. Not signed with a Developer ID and not notarized — allow it once in System Settings → Privacy & Security → "Open Anyway". Your data folder is kept when you install over 1.x.

**Verified**: 50/50 unit + integration tests, 21/21 + 45/45 end-to-end UI checks (including dragging on the canvas and in the court layout, saving, and the court following the layout) and the court smoke test on Linux + Xvfb (mock LLM). Not yet verified with a real model service.

## 1.2.1

**What's new**
- **Collaboration designs**: the Three Departments and Six Ministries flow is now a versioned design you can copy, edit, pin per edict and roll back. Running edicts keep the version they started with.
- **A finer Tang court**: all four scenes redrawn at twice the detail in Tang style (hip roofs with owl-tail ridge ornaments, deep brackets, vermilion columns and white walls, lotus floor tiles, a blue-green landscape screen behind the throne, que towers at Chengtian Gate). Officials wear Tang rank robes and soft headwraps and have 29 animations; what they do follows what the agent is doing (writing, reviewing, sealing, dispatching, abacus, scheming, weighing the law, measuring…). Still pixel art and 2D, so it stays light.
- **Things to do in the court** (none of them change how edicts run):
  - Hover an official for their current edict, model and token use.
  - Click an official to summon them, see past edicts, reward / reprimand them (animation only) or hurry them up (adds a vermilion note).
  - Click scene objects to open panels: notice board → news, throne table → memorial archive, memorial wall → edict board, ministry desk → that ministry's edicts.
  - Walk between halls through the doors. The emperor can walk with the arrow keys or by clicking the floor; Space next to an official summons them.
  - **Memorial replay** re-enacts a finished edict's journey in the Hall of Supreme Harmony from its records.
  - Day and night follow the clock. Weather can be clear, rain, snow or falling petals. Bell, drum and birdsong are off by default.
  - Small surprises: a cat on the wall, birds, lanterns you can light, incense you can add.
- **Left sidebar**: new entries for Web preview (workspace HTML files or a dev-server URL), Collaboration designs and Enter the court. The Privy Council list is grouped into affairs / configuration / records, and new items carry a "New" badge.

**Install**: download `Edict-1.2.1-arm64.dmg`. Not signed with a Developer ID and not notarized — allow it once in System Settings → Privacy & Security → "Open Anyway". Your data folder is kept when you install over 1.x.

**Verified**: 48/48 unit + integration tests, 21/21 + 32/32 end-to-end UI checks and the court smoke test on Linux + Xvfb (mock LLM). Not yet verified with a real model service.

## 1.1.0

**What's new**
- **Thinking-level slider** in the edict box and the court: its steps are the selected model's own levels, and the far right is always that model's highest level. Set per model (OpenAI `reasoning_effort` / `reasoning.effort`, Claude `output_config.effort` or `thinking.budget_tokens`, Qwen, GLM, or custom JSON with levels like `ultra`) and per official. If a service rejects the parameter, it is dropped and the call retried once.
- **Readable model errors**: relay errors such as HTTP 503 "this group doesn't support the model or access method" are no longer retried blindly. An error card explains the cause and offers **retry with another model** (re-runs only the failed step). **Protocol probe** in Models tests Chat / Responses / Messages with and without thinking parameters.
- **HTML preview**: run generated pages in a sandboxed built-in browser with a console, device sizes, auto-reload and outbound-network blocking. Agents check their pages with the new `preview_page` tool (errors + screenshot).
- **Skills & MCP center**: create, edit, enable and assign Skills; configure MCP servers with the standard `mcp.json` format (stdio, Streamable HTTP, legacy SSE), per-tool risk and approval, per-official grants. Local commands need your confirmation; secrets move into the macOS keychain.

**Install**: download `Edict-1.1.0-arm64.dmg`. Not signed with a Developer ID and not notarized — allow it once in System Settings → Privacy & Security → "Open Anyway". Your data folder is kept when you install over 1.0.0.

**Verified**: 41/41 unit + integration tests (mock LLM; MCP against a real process and real local HTTP servers), 20/20 + 19/19 end-to-end UI checks on Linux + Xvfb, DMG structure check. Not yet verified on a real Mac or with a real model service.

SHA-256 `Edict-1.1.0-arm64.dmg`: `efca3d6610bdfc4c56b0da399549570671bd051433b5fc50239cbba562b36f23`

## 1.0.0

A new codebase that replaces the 0.x desktop packaging. 1.x ships for Apple Silicon Macs only; the 0.x releases (Intel macOS, Windows, Linux) remain available below.

**Highlights**
- Two modes on one runtime, switched with ⌘J: a **workbench** (edict box, activity stream, Monaco editor, terminal, search, Git) and a **pixel Tang-dynasty court** with four scenes.
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
