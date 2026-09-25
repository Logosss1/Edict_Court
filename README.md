# Edict for Mac · A Multi-Agent Collaborative Programming Workstation

English | [中文](README.zh-CN.md)

<p align="center">
  <a href="https://github.com/Logosss1/Edict_Court/releases/latest"><img src="https://img.shields.io/github/v/release/Logosss1/Edict_Court?display_name=tag&label=latest%20release" alt="Latest release"></a>
  <img src="https://img.shields.io/badge/platform-macOS%20Apple%20Silicon-111827" alt="macOS Apple Silicon">
  <img src="https://img.shields.io/badge/Electron-44-47848F?logo=electron&logoColor=white" alt="Electron">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-22C55E" alt="MIT License"></a>
</p>

Edict for Mac is a desktop AI coding tool for **Apple Silicon Macs (arm64 only)**. Its core is the multi-agent workflow of [EDICT](https://github.com/cft0808/edict) — the Three Departments and Six Ministries

```
Emperor issues an edict → Crown Prince triages (small talk is answered directly) → Secretariat plans
  → Chancellery reviews (approve / reject; a rejection forces a re-plan) → Department of State Affairs dispatches
  → the Six Ministries execute in parallel → summary report → the Emperor approves and closes the case
```

> **Versions.** 1.x is a new codebase. The 0.x releases (a macOS / Windows / Linux packaging of the upstream EDICT runtime) remain available under [Releases](https://github.com/Logosss1/Edict_Court/releases) and the `v0.3.2` and earlier tags.

## Two modes, one runtime (⌘J)

| Workbench (default) | Court (pixel art) |
|---|---|
| ![Workbench](docs/screenshots/03-workbench-final-gate.png) | ![Hall of Supreme Harmony](docs/screenshots/08-court-taihe-presenter.png) |
| Edict box (⌘L to hide/show) · model / tier / multi-agent switch · live activity stream · approve / reject · editor | You sit on the throne; each official's animation is the agent's real state; click an official to see their work and leave a vermilion note; memorial review overlay |

Both modes are projections of the same main-process state: tasks, approvals, results and audit are identical and sync in both directions.

## Three collaboration tiers

| Tier | Flow | Use for |
|---|---|---|
| **Solo** | One agent talks to you directly, reads/writes files, runs commands | Simple tasks |
| **Court Lite** (default) | Triage → plan → review (1 rejection max, then escalates to you) → ministries → report | Everyday work |
| **Full Court** | The full court; optional **court debate**; **plan review where you can edit the plan**; parallel ministries with a dependency graph; result review; rejection loop (max 3) | Complex, long tasks |

## Highlights

- **Institutional review.** The state machine matches EDICT's `STATE_TRANSITIONS`; there is no path from planning to dispatch that bypasses the Chancellery. Illegal transitions are refused and audited; high-risk transitions need you.
- **Observable and interruptible.** Streaming thinking, tool calls, logs and health for every official. Pause / cancel / resume, notes the agent must answer, interjections during debates, and editing the plan before release.
- **Auditable and recoverable.** SHA-256 hash-chained audit log; five-stage memorial timeline; every step is a persisted node, so a failure or restart re-runs only the failed node.
- **Editor.** File tree, tabs, Monaco with diagnostics, global search/replace, integrated terminal, problems panel, Git.
- **Multiple protocols and providers.** OpenAI Chat Completions, Anthropic Messages, OpenAI Responses; presets only fill in the base URL — **no keys are hard-coded**.
- **Token economy.** Strong/economy model routing, repo map and symbol outlines instead of whole files, prompt caching, rolling compression, budgets and pre-flight estimates.

### New in 1.1.0

- **Thinking-level slider.** Its steps are the selected model's own levels; **the far right is always that model's highest level**. Translated per protocol (`reasoning_effort`, `reasoning.effort`, `output_config.effort`, `thinking.budget_tokens`, `enable_thinking`, …), configurable per model and per official, with custom levels such as `ultra`.
- **Readable model errors.** Configuration errors such as a relay's "this group doesn't support the model or access method" are no longer retried blindly; an error card explains the cause and offers **retry with another model**. **Protocol probe** tests Chat / Responses / Messages with and without thinking parameters.
- **HTML preview and self-testing.** A sandboxed built-in browser runs generated pages with a console, device sizes, auto-reload and outbound-network blocking; agents verify their pages with the `preview_page` tool, which returns errors and a screenshot.
- **Skills & MCP center.** Create, edit, enable and assign Skills; configure MCP servers with the  `mcp.json` format (stdio, Streamable HTTP, legacy SSE), with per-tool risk levels, approval and per-official grants. Local commands need your confirmation; secrets move into the macOS keychain.

## Install (Apple Silicon)

Download `Edict-<version>-arm64.dmg` from [Releases](https://github.com/Logosss1/Edict_Court/releases/latest) and see [docs/INSTALL_MAC.md](docs/INSTALL_MAC.md). **The app is not signed with a Developer ID or notarized (ad-hoc signature only).** On first launch, allow it in System Settings → Privacy & Security → "Open Anyway".

## Build from source

```bash
npm install
npm run build            # bundle main / preload / renderer into dist/
npx electron dist        # run
npm test                 # unit + integration tests (mock LLM)
npm run package:mac      # assemble Edict.app (arm64), ad-hoc sign, create zip + DMG
```

`package:mac` needs the official `electron-v44.4.5-darwin-arm64.zip` in `deps/` (or `ELECTRON_DARWIN_ZIP`). On macOS it signs with `codesign` and builds the DMG with `hdiutil`; on Linux it needs `rcodesign` and libdmg-hfsplus `dmg` on `PATH` (or `RCODESIGN` / `DMG_TOOL`). End-to-end tests: `npm run e2e` and `npm run e2e:features` (Playwright; on Linux run under `xvfb-run`).

## Verification status

| Kind | Result |
|---|---|
| Unit tests | 18/18 ✅ |
| Integration tests (**mock LLM** over real SSE wire formats; MCP against a real child process and real local HTTP servers) | 23/23 ✅ |
| End-to-end UI (**mock LLM**, real Electron app on Linux + Xvfb) | 20/20 + 19/19 ✅ |
| DMG structure check | ✅ |
| **Real model service** | ⏳ not run in the build environment (`scripts/verify-real.ts` needs your key) |
| **Real Mac host** | ⏳ not yet verified (built on Linux) |

Screenshots come from Linux + Xvfb, **not from a Mac**. Details: [docs/STATUS.md](docs/STATUS.md) (Chinese).

## Documentation (Chinese)

[STATUS](docs/STATUS.md) · [ARCHITECTURE](docs/ARCHITECTURE.md) · [SECURITY](docs/SECURITY.md) · [TESTING](docs/TESTING.md) · [ART_PIPELINE](docs/ART_PIPELINE.md) · [INSTALL_MAC](docs/INSTALL_MAC.md) · [AI_HANDOFF](AI_HANDOFF.md) · [RELEASE_NOTES](RELEASE_NOTES.md)

## License

MIT. Third-party components are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). EDICT and Yan-Agent are MIT-licensed. This project does not use the Visual Studio Code name, icons or Marketplace.
