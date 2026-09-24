# Release Notes

Release descriptions (English and Chinese) are on the [GitHub Releases page](https://github.com/Logosss1/Edict_Court/releases). Each version keeps its own installers.

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
