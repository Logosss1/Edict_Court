# Edict for Mac

English | [Chinese (Simplified)](README.zh-CN.md)

<p align="center">
  <a href="https://github.com/Logosss1/Edict_Court/releases/latest"><img src="https://img.shields.io/github/v/release/Logosss1/Edict_Court?display_name=tag&label=latest%20release" alt="Latest release"></a>
  <img src="https://img.shields.io/badge/platform-macOS%20Apple%20Silicon-111827" alt="macOS Apple Silicon">
  <img src="https://img.shields.io/badge/Electron-44-47848F?logo=electron&logoColor=white" alt="Electron">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-22C55E" alt="MIT License"></a>
</p>

Edict for Mac is a desktop AI coding workstation for **Apple Silicon Macs**. You issue an order, an *edict*, and a court of AI officials handles it the way an imperial court would: the Crown Prince triages it, the Secretariat plans it, the Chancellery reviews the plan, and the Six Ministries carry it out in parallel and report back for your approval. The workflow comes from [EDICT](https://github.com/cft0808/edict)'s Three Departments and Six Ministries.

```
You issue an edict → Crown Prince triages → Secretariat plans → Chancellery reviews (approve or send back)
  → Department of State Affairs dispatches → Six Ministries work in parallel → report → you approve
```

| Workbench | Court |
|---|---|
| ![Workbench](docs/screenshots/03-workbench-final-gate.png) | ![An official kneels to ask for a decision](docs/screenshots/71-court-petition.png) |

The workbench and the court are two views of the same live state. Approve in the court and the workbench closes the case; stop an official in the workbench and the same official stops writing in the court. Switch with ⌘J.

## Main features

### A court of agents, three ways to work

| Tier | Flow | Use for |
|---|---|---|
| **Solo** | One agent talks to you, reads and writes files, runs commands | Quick tasks |
| **Court Lite** (default) | Triage → plan → review → ministries → report | Everyday work |
| **Full Court** | The whole court, with an optional debate, a plan you can edit before it is released, parallel ministries with a dependency graph, and a review of the results | Large, long tasks |

The Chancellery cannot be bypassed: there is no path from planning to execution that skips its review, and a plan it sends back must be reworked.

### You stay in charge

- Subtasks are read, write or verify. Read subtasks run side by side; each write subtask asks before it starts, and you can allow it, allow it without further questions, keep it read-only, or reject it.
- Approvals can be remembered for one edict or permanently for a workspace. High-risk actions always ask, and release or deploy commands ask every time unless the workspace opts in.
- When something is unclear, officials stop and ask you, with options to pick from.
- Results are checked against the changes Edict actually recorded, and any step or a whole edict can be reverted, including changes made by shell commands.

### A full coding workbench

A file tree, Monaco editor with diagnostics, project-wide search and replace, an integrated terminal, a problems panel and Git. Edict uses the language servers already installed on your Mac. A sandboxed preview runs generated web pages, and officials test their own pages in it. The Kanban board has a lane for everything waiting on you.

| Kanban | Editor | Web preview |
|---|---|---|
| ![Kanban](docs/screenshots/04-kanban.png) | ![Editor](docs/screenshots/05-editor-problems.png) | ![Web preview](docs/screenshots/33-html-preview.png) |

### One git worktree per edict

In a git repository each edict works on its own branch in its own folder, so several edicts on one repository run side by side and your own checkout is not touched. When an edict is done you see every changed file and who changed it, then merge, keep the branch, or discard it.

### Models, skills and tools

- OpenAI Chat Completions, OpenAI Responses and Anthropic Messages, with any compatible service. No keys are built in; yours are encrypted with a key kept in the macOS keychain.
- Strong and economy models, a thinking-level slider whose steps are detected from the model itself, and a model of your choice for each official.
- 37 built-in skills for planning, review, investigation, QA, release and deploy, plus your own.
- MCP servers (stdio, Streamable HTTP, SSE) with OAuth login, resources and prompts, and per-tool risk levels. Editors that speak ACP can drive Edict too.

| Collaboration designs | MCP servers | Merging a worktree |
|---|---|---|
| ![Flow canvas](docs/screenshots/37-designs-canvas.png) | ![MCP settings](docs/screenshots/36-mcp-center.png) | ![Closing an edict](docs/screenshots/60-worktree-merge.png) |

### Your own collaboration designs

The court's flow is a versioned design. Copy it, rearrange the steps on a flow canvas, decide where a rejection sends the work, give each role its own model, and pin a design to an edict.

### Auditable and recoverable

Every action goes into a hash-chained audit log. Each step is saved as it finishes, so after a failure or a restart only the failed step runs again. Your data lives in one SQLite database.

## Standout features

### A living palace

The court mode is a pixel-art palace that runs on your Mac's clock and acts out the work as it happens.

- **A palace day.** Morning court opens by itself between 6 and 9. During the day officials work in their own offices, in the evening they leave one by one, and at night the halls stand empty under the lamps. You can call court at any time by striking the drum at the gate; an idle court ends after a few minutes.
- **The work, acted out.** Officials carry memorials between offices, runners take messages from hall to hall, rejected plans come back stamped, and an official who needs your decision walks to wherever you are and kneels to ask. Busy ministries are excused from court and keep working at their desks.
- **Walk the palace.** Ten scenes: the Hall of Supreme Harmony, the Palace Square, Chengtian Gate, the Privy Council with its memorial wall, the Six Ministries Office, the Eastern Palace, the Imperial Garden, the Long Palace Street, the Corner Tower and a palace map. Walk with the arrow keys or click, and officials bow as you pass.
- **Small things.** The real phase of the moon, weather, falling petals in spring, fireflies on summer nights, fireworks on festival nights, a palace cat, and koi in the garden pond that come when you feed them.

| Court in session | A report presented | Palace map |
|---|---|---|
| ![Court in session](docs/screenshots/70-court-session.png) | ![A report presented to the throne](docs/screenshots/72-court-memorial.png) | ![Palace map](docs/screenshots/73-court-map.png) |
| **Six Ministries Office** | **Privy Council** | **Chengtian Gate** |
| ![Six Ministries Office](docs/screenshots/74-court-liubu.png) | ![Privy Council](docs/screenshots/75-court-junjichu.png) | ![Chengtian Gate](docs/screenshots/76-court-chengtian.png) |
| **Eastern Palace** | **Imperial Garden** | **Corner Tower at night** |
| ![Eastern Palace](docs/screenshots/77-court-donggong.png) | ![Imperial Garden](docs/screenshots/78-court-garden.png) | ![Corner Tower at night](docs/screenshots/79-court-night.png) |

### The Crown Prince asks before he guesses

When an edict is ambiguous, the Crown Prince asks you one short question with a few likely answers before the court starts work, then carries on with your answer. Other officials ask in their own voice when they need a decision. You can turn the prince's question off in Settings › Permissions & approvals.

## Recent updates

- **2.0.3**: the living palace, ten new scenes, and the Crown Prince's clarifying question.
- **2.0**: execution you stay in charge of, one git worktree per edict, MCP login with resources and prompts, language servers, editors over ACP, built-in skills, SQLite storage and a new settings center.

The full history is in [RELEASE_NOTES.md](RELEASE_NOTES.md).

## Install

Download `Edict-<version>-arm64.dmg` from [Releases](https://github.com/Logosss1/Edict_Court/releases/latest) and drag Edict into Applications ([details](docs/INSTALL_MAC.md)). The app is not signed with a Developer ID or notarized, so on first launch allow it in System Settings → Privacy & Security → "Open Anyway". Apple Silicon only; there is no Intel build yet.

## Build from source

```bash
npm install
npm run build            # bundle main / preload / renderer into dist/
npx electron dist        # run
npm test                 # unit and integration tests (mock model)
npm run typecheck
npm run package:mac      # build Edict.app (arm64), sign ad hoc, make the zip and DMG
```

`package:mac` needs the official `electron-v44.4.5-darwin-arm64.zip` in `deps/` (or `ELECTRON_DARWIN_ZIP`). On macOS it signs with `codesign` and builds the DMG with `hdiutil`; on Linux it needs `rcodesign` and libdmg-hfsplus `dmg`. End-to-end tests: `npm run e2e` and `npm run e2e:features` after `npm run build` (Playwright; on Linux run them under `xvfb-run`, see [docs/TESTING.md](docs/TESTING.md)).

## Documentation (in Chinese)

[Status](docs/STATUS.md) · [Architecture](docs/ARCHITECTURE.md) · [Security](docs/SECURITY.md) · [Testing](docs/TESTING.md) · [Art pipeline](docs/ART_PIPELINE.md) · [Install](docs/INSTALL_MAC.md)

## License

MIT. Third-party components are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). EDICT and Yan-Agent are MIT-licensed.
