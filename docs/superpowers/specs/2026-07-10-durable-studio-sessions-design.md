# Durable, backgroundable Studio sessions — design

Date: 2026-07-10
Status: approved (brainstorm complete; ready for implementation plan)
Scope: Studio (Play miniapp builder) only; the neutral Chat panel is an explicit fast-follow.

## Problem

An ACP session in Studio lives in three places, only one of which is durable:

- The **agent subprocess** — spawned by `connectAcpAdapter` (`packages/base/src/acpSession.ts`).
- **`ChatManager`** (`packages/run/src/chatSession.ts`) — an in-memory `Map<chatId, LiveChat>` in the local core.
- The **browser** — Studio holds only a `chatId` in React `useState` and one `EventSource` per turn.

Consequences today:

1. **Navigating away orphans the session.** Unmounting Studio fires `closeRef.current?.()` (`Studio.tsx:81`), closing the `EventSource`; `chatId` is component state, so a remount starts fresh and the next message opens a **new** session. The agent's turn actually keeps running (the server route has no `res.close` abort, so the orphaned handler drains the generator to completion — and for Studio the miniapp is checkpointed on turn end), but the UI can neither see the result nor resume the thread.
2. **No backgrounding is surfaced.** The session keeps running by accident, but `chatId` isn't persisted and there's no way to reconcile or re-render it.
3. **No recovery for a wedged-but-alive turn.** Adapter *crashes* are handled (the `dead` race in `acpSession.ts` surfaces a `failed` event); a stuck-but-alive turn has no cancel, and the existing `DELETE /api/chat/:chatId` kill isn't wired to any UI control.

## Enabling facts (verified against the code + the running machine)

- The ACP adapter writes a **full native transcript** to disk, exactly like a normal interactive session: `~/.claude/projects/<cwd-slug>/<sessionId>.jsonl` for Claude, `~/.codex/sessions/**/rollout-*.jsonl` for Codex. Confirmed present for the jailed Studio/chat cwds on disk.
- **The transcript filename is the ACP `sessionId`** — the exact value `session.sessionId` returns at `acpSession.ts:138`. One `chatId` reuses one ACP session across turns, so one `chatId` ↔ one `sessionId` ↔ one `.jsonl`.
- An existing route already reads a transcript by id: `GET /api/inspect/session?id=<sessionId>&agent=claude|codex` → `TranscriptViewSchema` (turns + spans). `loadSessionTranscript(id, agent)` resolves the file **by sessionId + agent alone** (no cwd needed) — it's what the Observe `TranscriptViewer` uses.
- Nothing persists the session id today: `chatId` is `useState` only; `ChatManager` is in-memory; the `sessionId` is a discarded local `const`; `~/.agentgem/session.json` is the unrelated better-auth identity session.
- The turn already survives client disconnect (no abort), so **we are not rebuilding the turn engine.**

## Requirements

- **R1 Background** — a turn keeps running across a panel switch or a full tab reload. (A core restart kills the live turn; only the transcript survives — see R2.)
- **R2 Restore** — on return, the thread re-renders from the on-disk `.jsonl`, surviving reload *and* core restart.
- **R3 Recover** — a visible Stop control kills a wedged session.
- **R4 Dead-session continue** — when the in-memory session is gone (swept / post-restart), render history read-only; the next message opens a **fresh** ACP session in the same cwd (no ACP `session/load` live-resume). For Studio this is low-loss because the agent re-reads the miniapp files it edits.

## Architecture

We add four things and reuse everything else: **surface the sessionId, persist it client-side, guard against double-prompting, and restore history from the transcript.**

```
Studio (React)                     core (ChatManager + routes)          disk
──────────────                     ───────────────────────────          ────
studioChat store  ──POST /api/chat──▶ openChat → {chatId, sessionId} ──▶ adapter writes
(localStorage,        ◀── {chatId, sessionId, agent} ──                   <sessionId>.jsonl
 keyed by miniapp)
      │
      ├─ on mount ─ GET /api/inspect/session?id=sessionId&agent ─────────▶ read .jsonl → turns
      ├─ GET /api/chat/:chatId/state ──▶ {alive, running, sessionId, agent}
      ├─ GET /api/chat/stream?chatId&message  (live turn; unchanged shape)
      └─ Stop ─ DELETE /api/chat/:chatId ──▶ closeChat (aborts running turn)
```

### Server changes

Files: `packages/base/src/acpSession.ts`, `packages/run/src/chatSession.ts`, `src/goldmine/chatRoutes.ts`, `src/index.ts`.

1. **Surface `sessionId`.** Add `sessionId: string` to `RawAcpSession` (already captured at `acpSession.ts:138`), to `ChatSessionHandle`, and to `LiveChat`. `ChatManager.openChat` returns `{ chatId, sessionId }` (or exposes a getter); `POST /api/chat` responds `{ chatId, sessionId, agent }`.
2. **`running` flag + concurrency guard.** `ChatManager` sets `chat.running = true` for the duration of a turn and clears it in a `finally`. A second turn while one is running is rejected with a `failed` event. This makes the "orphaned handler finishes the turn" behavior safe: a reloaded client cannot double-`prompt()` one ACP session (ACP is single-turn-at-a-time).
3. **`GET /api/chat/:chatId/state → { alive, running, sessionId, agent }`.** The in-memory `Map` is the only liveness authority; this is the reconciliation endpoint. Unknown `chatId` → `{ alive: false }`.
4. **Protect running turns from reaping.** `sweepIdle` and `evictLru` skip chats with `running === true`, so a background turn is never reaped mid-flight. (Edge: if all live chats are running and a new `openChat` hits `maxLive`, it waits/errors rather than killing an active turn — see Open questions.)
5. **Stop.** `DELETE /api/chat/:chatId` already exists and already aborts a running turn (`closeChat` disposes the handle + closes the connection → child dies → the `dead` race rejects `prompt()`). No server change beyond ensuring the running turn ends cleanly; just wire the client.

### Client changes (Studio)

Files: a new `packages/console/src/panels/Play/studioChatStore.ts`, `Studio.tsx`, and transcript→`Msg[]` mapping.

1. **`studioChat` store** — module-level store + `useSyncExternalStore`, backed by `localStorage`, keyed by miniapp `name`, holding `{ chatId, sessionId, agent }`. Mirrors `activeGem.ts` (store shape) and `consent.ts` (localStorage `try/catch` idiom).
2. **On mount** — read the store; if a `sessionId` exists:
   - **Render history**: `GET /api/inspect/session?id=<sessionId>&agent=<agent>` → map `turns`/`spans` → `Msg[]`. User turn → `{role:"user"}`; assistant turn → `{role:"agent", text}` plus tool spans → `{role:"tool", title, failed}`. **Strip the injected brief** from the first user turn (the first prompt is `${brief}\n\n---\nUser: ${message}`; render only the part after `\n---\nUser: `).
   - **Fetch `state`.** If `running` → show the working spinner and poll `state` (~1.5s); when it clears, refresh history + the miniapp preview. If `alive` → the next message reuses `chatId` (context intact). If not `alive` → drop `chatId` from the store (keep `sessionId` for history); the next message opens a fresh session and updates the store.
3. **Stop button** — `DELETE /api/chat/:chatId` → clear `chatId`/`running` in the store → `setChatId(null)`. Shown whenever a session is live or a turn is running.
4. **On send** — if there is no live `chatId`, `POST /api/chat` (receive `chatId` + `sessionId`), persist them, then open the stream (existing `openStudioStream`).

### Transcript → `Msg[]` mapping

`TranscriptViewSchema` turns carry `{ id, role: "user"|"assistant", tsMs, spans, tokens }`. The mapper lives client-side (or a small helper) and is pure/unit-testable:

- `role:"user"` → `{ role:"user", text }` (brief-stripped on the first turn only).
- `role:"assistant"` → `{ role:"agent", text }` for text spans; each tool span → `{ role:"tool", title, failed }`.
- Ordering preserved by `tsMs` / turn order.

## Error & edge handling

- **Session opened, no message sent** → no `.jsonl` yet → `inspect/session` 404 → render an empty thread (not an error).
- **Stale `chatId`** (session swept) → `state.alive:false` → R4 fresh-continue; history still renders from the transcript.
- **localStorage disabled / private mode** → `try/catch` no-ops (as `consent.ts`); the feature degrades to today's behavior (ephemeral `chatId`).
- **Core restart mid-turn** → the live turn dies with the child; on return `state.alive:false`, history renders up to whatever the transcript captured, next message continues fresh.
- **Concurrent double-send** (reload races an in-flight turn) → server `running` guard rejects the second turn with `failed`.

## Testing

- **Server** (`chatSession` / `chatRoutes` unit tests — the CI-gated `test (24)` home): `running` guard rejects a concurrent turn; `sweepIdle`/`evictLru` skip running chats; `openChat` + `POST /api/chat` surface `sessionId`; `GET /state` returns liveness for known/unknown `chatId`.
- **Client** (`packages/console` vitest — run locally; console tests are not in CI): store round-trips through localStorage keyed by miniapp; mount reconciliation renders transcript history and polls while `running`; the brief-stripping mapper; Stop calls DELETE and resets state.

## Out of scope (v1)

- **Live token-streaming re-attach** to an in-flight turn (the detached-buffer + `/api/chat/:chatId/attach` SSE subsystem). v1 shows history + a spinner until the running turn lands in the transcript. Clean upgrade path later if the spinner feels bad.
- **ACP `session/load` live-resume** — R4 is fresh-continue by decision.
- **The neutral Chat panel** — shares the same server plumbing (`/api/chat/*`, `ChatManager`); a fast-follow once Studio proves the pattern. Chat is keyed by scope (neutral/project/miniapp) rather than a single miniapp name, which is the only real delta.
- **Codex parity** is in scope for restore (the `agent` field selects the parser and `inspect/session` already supports `agent=codex`), but Codex is exercised less; Claude is the primary validation path.

## Open questions (resolve during planning, not blockers)

- **`maxLive` under all-running:** when every live chat is running and a new `openChat` would exceed `maxLive` (default 3), do we (a) queue, (b) error to the user ("too many active sessions — stop one"), or (c) raise the cap? Leaning (b) for a clear signal.
- **`sessionId` availability timing:** confirm `claude-agent-acp` returns `session.sessionId` from `session/new` *before* the first prompt (it should — the id names the session, not the turn). If the `.jsonl` is only created on first output, an opened-but-unused session has an id but no file (handled by the 404 → empty-thread path).
