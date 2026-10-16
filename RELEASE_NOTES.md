# Release Notes

Installers for every version are on the [Releases page](https://github.com/Logosss1/Edict_Court/releases). Builds are Apple Silicon only, not signed with a Developer ID and not notarized.

## 2.1.1

- The planning official asks about the edict in rounds before planning, each question with a recommended answer, and you confirm a summary before work starts. Replaces the Crown Prince's single question.
- Review notes are *must fix* or *suggestion*; only must-fix items send work back. Full Court reviews results once when the requirement check is on.
- Plans stay on the edict's main point; word counts are targets within about 15%.
- Oral orders: send a correction to a running edict.
- Six fixed thinking steps for every model, mapped to each model's own levels.
- Temperature, top-p and penalties per model and per official.
- *See why* window for blocked edicts; one card per model on the Models page.
- Collapsible edict pane (⌘⌥B) and token budgets that can be unlimited.

## 2.1.0

- Web reading and search, with private and loopback addresses refused.
- Officials' shell commands run in a macOS sandbox.
- Plans start with a requirement spec that the Chancellery checks at the end.
- Scheduled edicts with their own folder, mode, model and permissions.
- ACP-compatible coding agents can take a ministry's subtask.
- Several attempts at one subtask, compared and picked on a comparison page.
- Worktree setup: copied files, linked folders, a setup script and per-worktree ports.

## 2.0.3

- A living palace that follows your Mac's clock: morning court, officials in their offices by day, empty halls at night.
- Ten scenes and a palace map; officials carry memorials and come to you when they need a decision.
- The Crown Prince asks a short question when an edict is ambiguous.

## 2.0.1 – 2.0.2

- "New" tags in Settings go away once the page is opened.
- Wording in the app and the documentation tidied.

## 2.0.0

- Execution you stay in charge of: read / write / verify subtasks, approval cards before writes, permission rules you can revoke, and a check of each official's claimed changes.
- One git worktree per edict, with a merge / keep / discard dialog when it closes.
- MCP login with OAuth, resources and prompts; language servers (LSP); editors over ACP.
- A built-in pack of 37 skills.
- New settings center, activity bar, edict board and agent pane.
- SQLite storage with on-demand backups.

## 1.x

- **1.2.x**: collaboration designs you can edit on a flow canvas, with per-role models and thinking levels and a court layout per design; the court redrawn in Tang style with more scenes and things to do; thinking levels detected from the model.
- **1.1.0**: thinking-level slider, readable model errors, HTML preview, and the skills and MCP center.
- **1.0.0**: a new codebase for Apple Silicon. A workbench and a pixel court on one runtime, three collaboration tiers (Solo, Court Lite, Full Court), real-time intervention, a hash-chained audit log, and support for the OpenAI Chat, OpenAI Responses and Anthropic Messages protocols.

## 0.x

0.1.0 – 0.3.2 packaged the upstream EDICT runtime for macOS, Windows and Linux. Their source is at the `v0.3.2` and earlier tags.
