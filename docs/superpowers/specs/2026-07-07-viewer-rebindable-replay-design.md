# Viewer-Rebindable Replay — Design

**Date:** 2026-07-07
**Status:** Approved (brainstorming), pending implementation plan

## Overview

A shared **session-replay** miniapp currently renders a fixed snapshot of the *author's* session (baked, redacted — see the shipped "portable miniapps" work). This adds a **local-console** affordance so a viewer can re-bind that same replay scaffold to one of **their own** local sessions: pick a session, and the duel replays *your* run instead of the author's.

This is a pure enhancement over the portable baked default. It changes nothing on app.agentgem.ai (no local sessions, no Runner there) — the baked redacted default keeps showing everywhere.

## Goal

On an interactive local replay, offer a host-owned **"Replay yours"** picker of the viewer's local sessions; selecting one feeds that session's compacted `{meta, timeline}` into the sealed iframe, which re-renders the replay against it. The sealed game never chooses or names a session — the host does.

## Scope

**In scope:**
- `replay` genre only (the only session-sourced genre; it already declares `needs: ["session-data"]`).
- The interactive console player (`packages/console/src/panels/Play/Runner.tsx`).
- A read-only server route extension to feed a *viewer-chosen* session.

**Non-goals (YAGNI / deferred):**
- Rebinding `skill-run` / `project-fun` (different, non-session sources).
- Any behavior on the marketplace player (`packages/marketplace/src/GamePlayer.tsx`) — it has no broker and no local sessions; the baked default is correct there.
- Persisting the viewer's pick across opens (each open starts on the author default).
- A new `GameCapability`, a new scaffold, or any change to the replay scaffold — the scaffold already renders baked-first and re-renders on an `agentgem:feed` (`packages/play/src/scaffolds.ts:97-101`).
- Arcade grid thumbnails (`interactive={false}`) — they never prompt or feed sensitive caps (`Runner.tsx:94`) and keep showing the baked default.

## Interaction

1. The interactive Runner renders a **"Replay yours ▾"** control in its own chrome (outside the sealed iframe), shown only when `genre === "replay"` and `interactive`.
2. Opening it lists the viewer's local sessions via the existing `fetchSessions(apiBase)` → `GET /api/watch/sessions` (`listActiveSessions()`), most-recent first, each row `project · agent · N msgs` (reusing `WatchSession`: `{ id, agent, project, model, msgs, … }`).
3. Selecting a row feeds that session into the sealed iframe on the **existing** `session-data` channel; the scaffold's message listener re-`boot()`s and replays it.
4. Until a pick is made (or if the list is empty), the author's baked redacted default shows.

## Security model (the crux)

The sealed game **cannot name a session.** It only ever receives host-pushed data on the `session-data` channel; the selection is made by the viewer in host-owned UI. Two guards:

- **Client:** the picker is populated only from `fetchSessions` (the host's own list), and the Runner posts the feed only into its own iframe (`e.source` check already in place, `Runner.tsx:88-89`).
- **Server (defense in depth):** the `session-data` route accepts an optional `sessionId` + `agent` override, honored **only if that `(sessionId, agent)` pair appears in `listActiveSessions()`** (the same enumerated local list the picker draws from). An override not in the list → 404. This prevents a crafted client from coercing the route into loading an arbitrary transcript path; loading still flows through `defaultReaders.loadSession` → `loadSessionTranscript`.

## Components & data flow

```
Runner "Replay yours ▾"  ──select(session)──▶  serve("session-data", { sessionId, agent })
        │                                              │
        │ fetchSessions()                              │ playSessionDataRoute({ name, sessionId, agent })
        ▼                                              ▼
  GET /api/watch/sessions                     GET /api/play/session-data   (server validates against
  (listActiveSessions)                         PlayController.sessionData    listActiveSessions, then
                                                                             loadSession + compactTurns)
        └──────────────────────────── postMessage {type:"agentgem:feed", channel:"session-data", data} ──▶ sealed iframe
                                                                             (scaffold re-boot()s — no change)
```

### Route contract

`GET /api/play/session-data` (extend `PlaySessionDataSchema` query + `playSessionDataRoute`):

- Query: `{ name: string; sessionId?: string; agent?: string }`
- Response: unchanged — `{ meta: Record<string, unknown>; timeline: { role, tsMs, text }[] }`
- Server (`PlayController.sessionData`, `src/play.controller.ts:50-59`):
  - No override → current behavior (the miniapp's own `createdFrom.sessionId`).
  - Override present → require the `(sessionId, agent)` to be in `listActiveSessions()`; else `404`. Then `defaultReaders.loadSession(sessionId, agent)` + `compactTurns`, same shape as today.

### Runner change

`packages/console/src/panels/Play/Runner.tsx`:
- Add a `serve` override path: `serve("session-data", { sessionId, agent })` posts the picked session's data on the `session-data` channel (extend `serve`'s signature to carry an optional session ref, or a small dedicated `feedPickedSession` helper).
- Add a picker overlay (host chrome), gated on `interactive && needs?.includes("session-data")`, populated by `fetchSessions`. Selecting a row calls the override serve and closes the overlay.
- **Detect a replay via the existing `needs` prop, not a new `genre` prop.** Only replays declare `session-data`, so `needs?.includes("session-data")` identifies exactly the rebindable case with no new prop threading through `Studio`/`Arcade`/`Composer`.

## Error / edge handling

- **No local sessions:** the picker shows an empty state ("No local sessions yet"); the baked default keeps playing.
- **Chosen session fails to load / ages out:** the feed silently no-ops (the `catch` in `serve` already swallows), and the current render stays — no crash.
- **Game changed while picking:** the existing `gameGen` staleness guard in `serve` (`Runner.tsx:38-42`) already drops a stale feed.
- **Marketplace / offline:** no Runner or picker; baked default renders.

## Testing

- **Runner (jsdom, `packages/console/src/panels/Play/__tests__/Runner.test.tsx`):** for a `replay` interactive miniapp, the "Replay yours" control appears; selecting a mocked session posts an `agentgem:feed` on the `session-data` channel with the picked session's data; the control is absent for a non-replay genre and for `interactive={false}`.
- **Route (`src/play/__tests__` or the play controller test):** `sessionData` with a valid override `(sessionId, agent)` present in the (stubbed) `listActiveSessions` returns that session's `{meta, timeline}`; an override *not* in the list returns 404; no override preserves the author-session behavior.

## Chosen defaults (approved)

- All local sessions, recent-first (not filtered to the shared replay's project).
- Reuse the `session-data` channel/capability — no new `GameCapability`.
- No persistence of the pick.
- No scaffold change.

## Deferred follow-ons

- "Remember my last pick for this game" (per-gem, via the existing consent store).
- Live rebind ("follow my current session") — the `live-session-events` cap already exists; a replay variant could stream instead of snapshot.
