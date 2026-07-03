# Goldmine Chat Tab — Design

**Date:** 2026-07-02
**Status:** Approved design, pre-implementation
**Branch:** `feat/goldmine-chat-tab` (off `origin/main` @ a0c79dc)

## Summary

A new console tab that lets the user hold a read-mostly conversation with a **local coding agent driven over ACP**, grounded in their own goldmine (sessions, skills, tools, usage). The agent is oriented by a pre-injected goldmine summary and can dig for detail via a small set of read-only tools. Any conversation can be turned into a **Gem draft** that lands in the existing Curate flow for human review.

The point is differentiation from the raw coding agent the user already has open: this chat sees AgentGem's cross-session aggregated goldmine and terminates in publishing. It is **read-mostly** — the agent reads the goldmine and drafts a Gem; it does not execute Gems or write to the filesystem in this slice.

## Locked decisions

- **Data access: hybrid (true, in slice 1).** Pre-inject a compact goldmine summary into the opening prompt, *plus* provision a **goldmine MCP server** so the agent can call read tools to dig for detail on demand.
- **Turn model: long-lived ACP session.** One ACP subprocess per open chat, kept alive across turns; the agent holds its own context and the MCP server stays connected. Well-matched because the console is local single-user (~1 active chat, not a fleet).
- **Tool wiring: client-provisioned stdio MCP server.** ACP has no lightweight "inline tool handler"; a client exposes tools to an agent only by configuring an MCP server on the session. Confirmed against `@agentclientprotocol/sdk` v0.28.1: `buildSession(cwd).withMcpServer({name, command, args, env}).start()` provisions a **stdio** MCP server. We ship a `agentgem-goldmine` stdio binary built with `@agentback/mcp` — mirroring the existing `agentgem-distill` server (`src/distill/mcpServer.ts`) — and `connectAcpAdapter` is extended to pass it through. **Correction to an earlier draft:** `acpRun.ts` only *observes* the agent's own tool calls; it does not register tools, so there was never a cheap "inline" path — the MCP server is the mechanism.
- **Gem handoff: in scope.** A "Draft a Gem" action maps the transcript + surfaced artifacts into a Curate draft. Read-mostly: produces a draft for human review, no execution.
- **Agent selection: fixed-per-chat picker.** A registry of `AgentDescriptor`s (Claude Code, Codex, future adapters) with an availability probe. The agent is chosen when a chat starts and fixed for that chat's lifetime; switching = new chat. (Replay-on-switch deferred.)

## Architecture & components

Each unit has one job and a well-defined interface; the chat panel never learns about ACP, and only the session manager holds a live subprocess.

| Unit | Location | Responsibility | Depends on |
|---|---|---|---|
| ACP MCP provisioning | `packages/base/src/acpSession.ts` (extend) | Let `open(cwd, {mcpServers})` pass `McpServer[]` into `buildSession(...).withMcpServer(...)` | `@agentclientprotocol/sdk` |
| Agent registry | `packages/base/src/agents.ts` | Enumerate selectable ACP backends; `availableAgents()` probes each `command[0]` on PATH | `AgentDescriptor` (exists) |
| Goldmine context assembler | `packages/insight/src/goldmineContext.ts` | Build a compact opening-prompt summary (scorecard headline + top artifacts/usage) — the pre-inject half of hybrid | existing scorecard/usage/inventory fns |
| Goldmine MCP server | `src/goldmine/mcpServer.ts`, shipped as `agentgem-goldmine` bin | Stdio `@mcpServer` exposing `search_sessions`, `get_artifact_detail` read tools — the dig-on-demand half | `@agentback/mcp`, existing scan/query fns; pattern from `src/distill/mcpServer.ts` |
| Chat session manager | `packages/run/src/chatSession.ts` | `Map<chatId, LiveChat>`; open (provisions the goldmine MCP server descriptor) / `send(msg) → AsyncGenerator<event>` / teardown; owns subprocess lifecycle | `@agentgem/base`, assembler |
| Gem-draft mapper | reuse Curate + a mapper | Turn transcript + surfaced artifacts into a Curate draft | existing Curate flow |
| Chat panel (UI) | `packages/console/src/panels/Chat/` (`index` + `chatStream.ts`) | Agent picker, message list, streaming render, "Draft a Gem" button | `defineConsolePage`, existing `openXxxStream` pattern |

### Backend endpoints

Raw Express SSE handlers, registered alongside the other streams in `src/index.ts` (the `@agentback/rest` decorator framework returns single JSON bodies; streaming routes are raw handlers, matching `/api/gem/run/stream`, `/api/insights/stream`, etc.).

- `GET  /api/agents` → registry + per-agent availability
- `POST /api/chat` `{agentId}` → creates session, returns `{chatId}`
- `GET  /api/chat/stream?chatId&message` → SSE turn: `phase` / `delta` / `tool` / `done` / `failed` (the existing event vocabulary)
- `POST /api/chat/:chatId/draft-gem` → drafts into Curate, returns a deep-link target
- `DELETE /api/chat/:chatId` → teardown

## Data flow (one chat)

1. Panel loads → `GET /api/agents` → picker shows installed backends; unavailable ones greyed with "not installed."
2. User picks an agent, sends first message → `POST /api/chat {agentId}`. Manager opens the ACP session (`connectAcpAdapter`, neutral workspace, `permission:"deny"` — the recommender's read-only posture) **with the `agentgem-goldmine` stdio MCP server provisioned** into the session, calls the assembler to inject the goldmine summary as opening context, stores `LiveChat` under `chatId`. Note: read tools call for `permission:"allow"` on the *tool* requests; the "deny" posture blocks *filesystem/write* permission prompts while the goldmine MCP tools are pure reads — the exact permission policy for read-only MCP tools is settled in the plan against adapter behavior.
3. Turn streams over `GET /api/chat/stream?chatId&message`: `phase(preparing→running)` → `delta` chunks → `tool` events when the agent calls the goldmine MCP tools `search_sessions` / `get_artifact_detail` → `done` with the final message + the artifacts surfaced this turn.
4. Follow-up turns reuse the **same** live session (the point of long-lived): no history replay, agent keeps its own context, the MCP server stays connected.
5. "Draft a Gem" → `POST /api/chat/:chatId/draft-gem` → mapper builds a Curate draft from transcript + surfaced artifacts → panel deep-links into Curate.

## Lifecycle & error handling

The real risk surface is the long-lived subprocess, so it is contained entirely in the session manager.

- **Teardown triggers:** explicit `DELETE` on "close chat"; an **idle-timeout sweep** (default ~15 min inactivity); a best-effort `beforeunload` beacon on tab close. The idle sweep is the backstop so a crashed tab cannot orphan a subprocess indefinitely.
- **Concurrency cap:** small (default 3) live sessions; opening beyond it evicts the least-recently-used with a user-visible notice. Single-user, so this is a safety rail, not a scaling feature.
- **Agent crash / spawn failure:** surfaced as a `failed` SSE event (never throw-and-hang — matches runner behavior); panel offers "restart chat." Binary-not-found is caught at picker time, not at connect time.
- **Tool errors:** a read tool that throws returns an error result to the agent (it can recover/rephrase), never aborts the stream.
- **Credential isolation:** inherited from `connectAcpAdapter` / `localAgentEnv()` — agentgem's stored keys are stripped; the spawned agent uses the user's own login.

## Testing

Reuse the `setConnectFnForTests` seam (in-process fake agent, no subprocess).

- **Session manager:** multi-turn keeps one session (assert connect called once across turns); idle sweep tears down; LRU eviction; `failed` event on fake-agent error.
- **Goldmine MCP server:** each tool (`search_sessions`, `get_artifact_detail`) unit-tested directly against fixture `~/.claude` data (the server is a thin `@mcpServer` over existing scan/query fns — test those handlers without spawning stdio).
- **MCP provisioning (base):** unit-test that `open(cwd, {mcpServers})` threads the descriptors into `buildSession(...).withMcpServer(...)` via a fake `agentCtx` (assert the builder received them); no real subprocess.
- **Assembler:** deterministic summary from fixture goldmine data (pure function — straightforward unit test).
- **Draft-gem mapper:** transcript + surfaced artifacts → expected Curate draft shape.
- **SSE integration:** one end-to-end turn (fake agent that emits `agent_message_chunk` + a `tool_call`) emits the expected event sequence (mirrors the existing `sse.integration` style).

## Live-validation risks

- **Adapter honors client MCP servers (PRIMARY RISK) — ✅ CONFIRMED 2026-07-02.** SDK v0.28.1 provisioning was verified end-to-end against the real `claude-agent-acp` (installed locally): the live smoke (`scripts/smoke/mcp-provision-smoke.mjs` + `echo-mcp.mjs`) provisioned a stdio echo MCP server via `buildSession(...).withMcpServer(...)`, and the agent called it (`mcp__echo__echo` → `echo: PONG42`). The true-hybrid path stands; no pivot to pre-inject-only needed. **Note:** Claude Code namespaces client MCP tools as `mcp__<serverName>__<toolName>` — so goldmine tools surface as `mcp__agentgem-goldmine__search_sessions` / `mcp__agentgem-goldmine__get_artifact_detail`; prompt the agent with these names and expect them in `tool_call` titles. `codex-acp` remains unverified (not installed) and degrades to pre-inject-only.
- **Read-tool permission policy:** confirm read-only MCP tool calls proceed under the session's permission posture without a write-style prompt loop.
- **Binary availability:** each backend needs its CLI installed to appear enabled in the picker; probe on PATH and grey out rather than fail on connect.
- **stdio bridging** against the real adapters (already flagged as needing live validation in `acpSession.ts`).

## Out of scope for slice 1 (deferred, YAGNI)

- **Reusing the goldmine MCP server elsewhere** — the `agentgem-goldmine` binary is built for this chat first; wiring it into *other* agents (e.g. the user's own Claude Code config) is a later, additive step.
- **Replay-on-agent-switch** — switching agents starts a new chat rather than migrating context.
- **Tool-capable / execution mode** — running Gems or touching the filesystem from chat (reopens the full gem-run security surface; intentionally excluded).
- **Chat persistence across app restarts** — sessions are ephemeral; restart = fresh chat.
