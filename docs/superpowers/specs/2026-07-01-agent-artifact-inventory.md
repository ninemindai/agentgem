# Coding-Agent Artifact Inventory

**Date:** 2026-07-01
**Status:** Research deliverable — grounds `2026-07-01-multi-agent-sources-design.md`
**Scope:** Where six coding/co-working agents store their artifacts on disk, so AgentGem can ingest them behind one abstraction.

Agents covered: **Claude Code** and **Codex** (already ingested — baseline reference), plus **Cursor**, **Cline / Roo Code**, **Gemini CLI**, and **Continue**.

> Grounding note: on the machine this inventory was built, only Claude Code and Codex artifacts exist. Cursor, Cline/Roo, Gemini CLI, and Continue are **not installed** here, so their paths/formats below come from current docs + upstream source (verified against `main` branches) and should be treated as the schema to scan for — an ingester must handle a missing home dir gracefully.

---

## 1. The headline finding: everything reduces to five neutral types + a session stream

However different on disk, every agent's artifacts map onto the five artifact classes AgentGem already models, plus a sessions/usage stream. That convergence is what makes one abstraction viable.

| Neutral type | Claude Code | Codex | Cursor | Cline / Roo | Gemini CLI | Continue |
|---|---|---|---|---|---|---|
| **instructions** | `CLAUDE.md` | `AGENTS.md` | `.cursor/rules/*.mdc`, `.cursorrules` | `.clinerules[/]`, `.roo/rules*` | `GEMINI.md` (hierarchical) | `rules:` block / `.continue/rules` |
| **mcp_server** | `.mcp.json` | `config.toml` | `.cursor/mcp.json` | `cline_mcp_settings.json` / `mcp_settings.json` | `settings.json → mcpServers` | `config.yaml → mcpServers` |
| **skill / command** | `skills/*/SKILL.md` | prompts | agent-requested `.mdc` | `.clinerules/skills`, `.roo/commands` | `commands/*.toml` | `prompts/*.prompt` |
| **hook** | `settings.json → hooks` | — | — | `.clinerules/hooks` | `hooks/hooks.json` | — |
| **sessions** (→ `SessionStat`) | `projects/*.jsonl` | `sessions/rollout-*.jsonl` | **SQLite** `state.vscdb` | `tasks/<id>/*.json` | `tmp/<id>/chats/*.jsonl` | `sessions/<id>.json` |
| **usage** (tokens/model) | in-transcript `usage` | token events | bubble `tokenCount` (SQLite) | `api_req_started` (2×-encoded) | per-msg `tokens` | `dev_data/*/tokensGenerated.jsonl` |

### Cross-cutting observations

1. **MCP is already universal.** Cursor, Cline, Roo, Gemini, and Continue all use the Claude-Desktop `mcpServers` schema (`command`/`args`/`env` for stdio, `url`/`headers` for HTTP/SSE). **One parser covers all six.** MCP `env`/`headers` may hold secrets — redact on import.
2. **The real variance is storage, not semantics.** Instructions / skills / MCP are flat text/JSON everywhere. Only *sessions* diverge — JSONL vs JSON-array vs SQLite. So the abstraction must hide the **transcript backend** and can share sub-parsers for everything else.
3. **Two token-usage shapes.** Either per-message token counts inside the transcript (Claude, Gemini, Cursor, Cline) or a dedicated append-only usage log (Continue `dev_data`). Both yield metadata-only usage without reading message text.
4. **Cross-editor duplication.** VS Code-fork agents (Cline/Roo) write under whichever app launched them (`Code`, `Cursor`, `Windsurf`, `VSCodium`); the same task can appear under several roots — dedup by task id.
5. **Missing installs are the norm, not an error.** Any given machine runs one or two of these. A source contributes nothing when its home dir is absent; it must never throw.

---

## 2. Baseline (already ingested) — for reference

Handled today by `packages/insight/src/observeScan.ts` (`parseClaudeTranscript`, `parseCodexTranscript`); paths resolved in `packages/model/src/resolveDir.ts`.

- **Claude Code** — `~/.claude/projects/<folder>/<uuid>.jsonl` (JSONL: `type`, `message`, `timestamp`, `cwd`, `sessionId`, `message.model`, `message.usage`). Setup: `~/.claude/skills/*/SKILL.md`, `settings.json`, `hooks/hooks.json`, `CLAUDE.md`.
- **Codex** — `~/.codex/sessions/rollout-*.jsonl` (JSONL: `payload` with `session_meta` / `response_item` / `event_msg` token counts). Config `~/.codex/config.toml`.
- The `Agent` type is currently the **closed union `"claude" | "codex"`** — the constraint the design opens up.

---

## 3. Cursor — the SQLite outlier

**Home:** app storage under `~/Library/Application Support/Cursor/` (macOS) + `~/.cursor/`. `storage: sqlite`.

| Category | Path | Format | Notes / gotchas |
|---|---|---|---|
| Instructions | `<repo>/.cursor/rules/*.mdc`, legacy `<repo>/.cursorrules`, `AGENTS.md` | Markdown (+ YAML frontmatter `description`/`globs`/`alwaysApply`) | `.cursorrules` deprecated but still read. User/global rules are **not files** — they live in `globalStorage/state.vscdb → ItemTable`. |
| MCP | `~/.cursor/mcp.json` (global), `<repo>/.cursor/mcp.json` (project) | JSON, standard `mcpServers` | Trivial; project overrides global. |
| Sessions | `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb`; per-workspace `workspaceStorage/<hash>/state.vscdb`; newer builds also `~/.cursor/**/agent-transcripts/*.jsonl` | **SQLite** (+ occasional JSONL) | Tables `ItemTable` (VS Code KV) and `cursorDiskKV` (Cursor's own store). Keys: `composerData:<id>` (ordered bubble headers) → hydrate each `bubbleId:<id>:<bubbleId>` row. **Two-hop join.** |
| Usage | Inside `bubbleId:*` blobs (`tokenCount`, `inputTokens`, `outputTokens`); `store.db meta.lastUsedModel`; `~/.cursor/ai-tracking/ai-code-tracking.db` | Integer fields in JSON blobs | Local token sums are a **lower bound**, not the authoritative bill. Model may be session-level only. |
| Memories / notepads | `globalStorage/state.vscdb → ItemTable` | SQLite KV | Opaque keys; enumerate empirically on a live install. |

**Ingestion hazards:** binary SQLite (no line streaming); values are JSON **strings** inside cells (double-parse — tool `params`/`result` are stringified-JSON-within-JSON); data split across many DBs (global + per-workspace + per-agent `store.db`) — must union/dedupe; format churned across versions (`chatdata` → `composerData` → `cursorDiskKV`/`agentKv`); DB is WAL-mode and locks while Cursor runs — **copy before reading, open read-only, never write**. Bubble `type` enum: `1`=user, `2`=assistant. The `agent-transcripts/*.jsonl` path, when present, is the one easy source.

---

## 4. Cline / Roo Code — the clean-JSON first adapter

VS Code extensions. **Cline** id `saoudrizwan.claude-dev`; **Roo** id `rooveterinaryinc.roo-cline`. Root: `~/Library/Application Support/<AppDir>/User/globalStorage/<extId>/` where `<AppDir>` ∈ `Code`, `Code - Insiders`, `Cursor`, `VSCodium`, `Windsurf`. `storage: json` (one SQLite touch for model config).

| Category | Path | Format | Notes |
|---|---|---|---|
| Sessions | `…/globalStorage/<extId>/tasks/<taskId>/` | JSON | `<taskId>` = creation timestamp (ms). Files: `api_conversation_history.json` (Anthropic-style message array), `ui_messages.json` (UI timeline of `ClineMessage`), `context_history.json`, `task_metadata.json`. Roo adds `history_item.json` + global `_index.json`; older Roo used `claude_messages.json` (fallback). |
| Usage | Inside `ui_messages.json` — messages with `say: "api_req_started"` | JSON string in `.text` (**parse twice**) | `ClineApiReqInfo`: `tokensIn`, `tokensOut`, `cacheWrites`, `cacheReads`, `cost`. Written as placeholder then updated in place (partial entries may lack token fields). Roo also rolls totals into `history_item.json`/`_index.json` (`tokensIn/tokensOut/cacheReads/cacheWrites/totalCost`) — cheap per-task totals. |
| Instructions | `.clinerules` (file or `.clinerules/` dir, concatenated); Roo `.roorules` or `.roo/rules/`, mode-scoped `.roo/rules-<mode>/` | Markdown | Cline also reads foreign `.cursorrules`, `.windsurfrules`, `AGENTS.md`. Subdirs `.clinerules/{workflows,hooks,skills}`. |
| MCP | Cline `…/<extId>/settings/cline_mcp_settings.json`; Roo `…/settings/mcp_settings.json` (**different filename**) + project `.roo/mcp.json` | JSON `mcpServers` (+ `disabled`, `autoApprove`, `type`, `url`, `timeout`) | Standard schema with extensions. |
| Model/provider | globalStorage-root `state.vscdb → ItemTable` (`apiConfiguration` / `ProviderSettings`); secrets in OS keychain (SecretStorage) | SQLite | The one non-trivial parse; API keys are **not** on disk in readable form. |

**Hazards:** double-encoded JSON in `api_req_started` and tool messages; cross-editor task duplication (dedup by `taskId`); Roo filename divergences (`mcp_settings.json`, legacy `claude_messages.json`). Enumerate tasks by globbing `tasks/*/` and reading the metadata file, not by parsing every timeline.

---

## 5. Gemini CLI — JSONL with mutation records

**Home:** `~/.gemini/` (override `GEMINI_CLI_HOME`). `storage: jsonl`. Path truth: `packages/core/src/config/storage.ts`.

| Category | Path | Format | Notes |
|---|---|---|---|
| Instructions | `~/.gemini/GEMINI.md` (global) + `<project>/**/GEMINI.md` (ancestors) | Markdown | All discovered files concatenated low→high specificity. Context filename configurable via `settings.json → context.fileName` (may be `["AGENTS.md", …]`). |
| Settings | `~/.gemini/settings.json` (user), `<project>/.gemini/settings.json` | JSON (nested) | Keys incl. `model.name`, `context.*`, `general.checkpointing.enabled`, `mcpServers`, `telemetry`. `$VAR` / `${VAR:-DEFAULT}` expansion. |
| MCP | `settings.json → mcpServers` | JSON | `command`/`args`/`env`/`cwd` (stdio), `url` (SSE), `httpUrl`/`headers` (HTTP), `trust`, `includeTools`/`excludeTools`. |
| Commands / extensions | `~/.gemini/commands/*.toml` (+ project); `~/.gemini/extensions/<name>/gemini-extension.json` | TOML / JSON | Command `prompt` (required) + `description`; subdir → namespace (`/git:commit`). Extensions bundle `commands/`, `hooks/hooks.json`, `skills/<n>/SKILL.md`. |
| Sessions | `~/.gemini/tmp/<id>/chats/session-<ts>-<sessionId>.jsonl` | **JSONL with mutation lines** | `<id>` is a **slug** from `~/.gemini/projects.json` (not a raw hash; hash survives only in the in-file `projectHash`). `ConversationRecord` → `messages[]`; `MessageRecord = {id, timestamp, content, type}`; gemini messages add `{toolCalls, thoughts, tokens, model}`. |
| Usage | Per-message `tokens = {input, output, cached, thoughts, tool, total}` in session JSONL; optional OpenTelemetry via `telemetry.outfile` | JSONL / OTel | Per-session usage recoverable without telemetry enabled. |
| Auth/misc | `oauth_creds.json`, `google_accounts.json`, `installation_id` (plain text), `projects.json`, `trustedFolders.json` | JSON / text | Secrets — skip values. |

**Hazards:** session files are line-delimited JSON with **mutation records** — `{"$rewindTo":…}` and `{"$set":…}` lines that must be folded to reconstruct final state; dir identifier is a slug via `projects.json`; `context.fileName` is nested in settings but flat (`contextFileName`) in extension manifests.

---

## 6. Continue — the cleanest usage-telemetry precedent

**Home:** `~/.continue/` (override `CONTINUE_GLOBAL_DIR`). `storage: json` + JSONL usage. Path truth: `core/util/paths.ts`.

| Category | Path | Format | Notes |
|---|---|---|---|
| Config | `~/.continue/config.yaml` (preferred), legacy `config.json`, `config.ts`, `sharedConfig.json`; project `.continue/` | YAML / JSON | `models[]`, `mcpServers[]`, `rules`, `prompts`, `docs`, `context`, `data[]`. Ingest YAML first, JSON fallback. |
| MCP | `config.yaml → mcpServers[]` | YAML | `name`, `command` (required), `args`, `env`, `cwd`, `requestOptions` (SSE/HTTP). |
| Rules / prompts | `~/.continue/rules/**` or `rules:` blocks; `<repo>/.continue/prompts/*.prompt`; `~/.continue/assistants/*.yaml` | Markdown / `.prompt` / YAML | `.prompt` = Markdown + optional YAML frontmatter (slash-command prompts). |
| Sessions | `~/.continue/sessions/<sessionId>.json` + index `sessions.json` | JSON | `Session = {sessionId, title, workspaceDirectory, history[], usage?}`. `history[]` items carry a `ChatMessage` (discriminated on `role`); **`content` is string OR `MessagePart[]`** — handle both. |
| **Usage (dev_data)** | `~/.continue/dev_data/<schemaVersion>/<eventName>.jsonl` + `devdata.sqlite` | **JSONL, append-only** | Best clean cross-agent usage source. Every event has base `{eventName, schema, timestamp, userId, userAgent, selectedProfileId}`. `tokensGenerated` adds `{model, provider, promptTokens, generatedTokens}` and carries **no code/prompt text**. |
| Misc | `~/.continue/index/` (SQLite + LanceDB), `logs/`, `<repo>/.continueignore` | mixed | Skip index/embeddings. |

**Hazards:** glob the version dir by wildcard (`dev_data/*/`), key parsing off per-line `eventName`/`schema` not the filename; each schema ships an `all` (with code/prompt fields) vs `noCode` variant depending on the `data` destination `level` — don't assume `prompt`/`completion` present. `tokensGenerated` is the safest universal metric.

---

## 7. Difficulty ranking (drives build order)

| Rank | Agent | Why | Adapter order |
|---|---|---|---|
| Easiest | **Cline / Roo** | flat JSON tasks, standard `mcpServers`, `.clinerules` | Phase 2 (proof) |
| Easy | **Gemini CLI** | JSONL sessions (mutation-fold), TOML commands | Phase 3 |
| Easy | **Continue** | JSON sessions + clean `dev_data` usage JSONL | Phase 3 |
| Hardest | **Cursor** | SQLite, double-encoded JSON, multi-DB union, WAL locks, version churn | Phase 3 (last) |

Cursor is the interface stress-test — building it last proves the `SourceSpec` contract isn't secretly JSONL-shaped.

---

## Sources

Claude Code / Codex from the AgentGem codebase (`packages/insight`, `packages/model/src/resolveDir.ts`). Cursor: cursor.com/docs (Rules, MCP) + community reverse-engineering of `state.vscdb`. Cline/Roo: `cline/cline` (`apps/vscode/src/core/storage/disk.ts`, `shared/ExtensionMessage.ts`) and `RooCodeInc/Roo-Code` (`globalFileNames.ts`, `task-persistence`). Gemini CLI: `google-gemini/gemini-cli` (`packages/core/src/config/storage.ts`) + official docs. Continue: `continuedev/continue` (`core/util/paths.ts`, `core/index.d.ts`, `packages/config-yaml/src/schemas/data`) + docs.continue.dev.
