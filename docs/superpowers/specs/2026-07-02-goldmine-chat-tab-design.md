# Goldmine Chat Tab — Design

**Date:** 2026-07-02
**Status:** Approved design, pre-implementation
**Branch:** `feat/goldmine-chat-tab` (off `origin/main` @ a0c79dc)

## Summary

A new console tab that lets the user hold a read-mostly conversation with a **local coding agent driven over ACP**, grounded in their own goldmine (sessions, skills, tools, usage). The agent is oriented by a pre-injected goldmine summary and can dig for detail via a small set of read-only tools. Any conversation can be turned into a **Gem draft** that lands in the existing Curate flow for human review.

The point is differentiation from the raw coding agent the user already has open: this chat sees AgentGem's cross-session aggregated goldmine and terminates in publishing. It is **read-mostly** — the agent reads the goldmine and drafts a Gem; it does not execute Gems or write to the filesystem in this slice.

## Locked decisions

- **Data access: hybrid.** Pre-inject a compact goldmine summary into the opening prompt, *plus* give the agent inline read tools to fetch detail on demand.
- **Turn model: long-lived ACP session.** One ACP subprocess per open chat, kept alive across turns; the agent holds its own context and tools stay connected. Well-matched because the console is local single-user (~1 active chat, not a fleet).
- **Tool wiring: Approach A — inline ACP tools.** Register read-tool handlers directly on the ACP session, reusing the `acpRun.ts` tool-registration pattern. (Approach B — a standalone reusable goldmine MCP server — is the deferred next step, extracted once we see which tools the chat actually leans on.)
- **Gem handoff: in scope.** A "Draft a Gem" action maps the transcript + surfaced artifacts into a Curate draft. Read-mostly: produces a draft for human review, no execution.
- **Agent selection: fixed-per-chat picker.** A registry of `AgentDescriptor`s (Claude Code, Codex, future adapters) with an availability probe. The agent is chosen when a chat starts and fixed for that chat's lifetime; switching = new chat. (Replay-on-switch deferred.)

## Architecture & components

Each unit has one job and a well-defined interface; the chat panel never learns about ACP, and only the session manager holds a live subprocess.

| Unit | Location | Responsibility | Depends on |
|---|---|---|---|
| Agent registry | `packages/base/src/agents.ts` | Enumerate selectable ACP backends; `availableAgents()` probes each `command[0]` on PATH | `AgentDescriptor` (exists) |
| Goldmine context assembler | `packages/insight/src/goldmineContext.ts` | Build a compact opening-prompt summary (scorecard headline + top artifacts/usage) — the pre-inject half of hybrid | existing scorecard/usage/inventory fns |
| Inline read tools | `packages/run/src/chatTools.ts` | `search_sessions`, `get_artifact_detail` handlers registered on the ACP session — the dig-on-demand half | existing session/artifact query fns |
| Chat session manager | `packages/run/src/chatSession.ts` | `Map<chatId, LiveChat>`; open / `send(msg) → AsyncGenerator<event>` / teardown; owns subprocess lifecycle | `@agentgem/base`, assembler, tools |
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
2. User picks an agent, sends first message → `POST /api/chat {agentId}`. Manager spawns the ACP session (`connectAcpAdapter`, neutral workspace, `permission:"deny"` — the recommender's read-only posture), calls the assembler to inject the goldmine summary as opening context, registers the inline read tools, stores `LiveChat` under `chatId`.
3. Turn streams over `GET /api/chat/stream?chatId&message`: `phase(preparing→running)` → `delta` chunks → `tool` events when the agent calls `search_sessions` / `get_artifact_detail` → `done` with the final message + the artifacts surfaced this turn.
4. Follow-up turns reuse the **same** live session (the point of long-lived): no history replay, agent keeps its own context, tools stay connected.
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
- **Inline tools:** fake agent calls `search_sessions` → assert `tool` events surface and results feed back into the turn.
- **Assembler:** deterministic summary from fixture goldmine data (pure function — straightforward unit test).
- **Draft-gem mapper:** transcript + surfaced artifacts → expected Curate draft shape.
- **SSE integration:** one end-to-end turn emits the expected event sequence (mirrors the existing `sse.integration` style).

## Live-validation risks

- **Codex tool support:** whether `codex-acp` accepts the client-side tool registration our inline tools need. If not, it degrades gracefully to a **pre-inject-only** agent (hybrid falls back to just the summary — still useful).
- **Binary availability:** each backend needs its CLI installed to appear enabled in the picker; probe on PATH and grey out rather than fail on connect.
- **stdio bridging** against the real adapters (already flagged as needing live validation in `acpSession.ts`).

## Out of scope for slice 1 (deferred, YAGNI)

- **Approach B** — standalone reusable goldmine MCP server (extract once the inline tool set is proven; would let *any* agent, including the user's own Claude Code, mount the goldmine).
- **Replay-on-agent-switch** — switching agents starts a new chat rather than migrating context.
- **Tool-capable / execution mode** — running Gems or touching the filesystem from chat (reopens the full gem-run security surface; intentionally excluded).
- **Chat persistence across app restarts** — sessions are ephemeral; restart = fresh chat.
