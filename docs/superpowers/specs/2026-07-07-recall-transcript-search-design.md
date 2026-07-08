# Recall — cross-session transcript search & conversation — design

**Date:** 2026-07-07
**Status:** approved for planning
**Home:** new Observe-phase panel, `#/recall` (sibling to Sessions/History)
**Mockup:** scratchpad `recall-mockup.html` (published artifact, validated against the console's Lapidary Ledger skin)

## Problem

Your past agent sessions are a searchable, answerable corpus — "where did I fix
the profile 500," "summarize what I learned about the aggregator schema," "pull
every command I ran against the prod DB" — but nothing surfaces them that way.
Two gaps:

1. **You can't find a session by what happened inside it.** The existing
   `searchSessions()` (`src/goldmine/tools.ts:7`) matches **metadata only** —
   `project + model + gitBranch`. The exact query people want ("the session where
   I did X") is a *content* query, and content isn't searchable today.
2. **The "converse with your history" primitives exist but aren't a surface.**
   `search_sessions`, `summarize_session`, and `ask_session` (the ACP one —
   `packages/insight/src/sessionAsk.ts`) are wired into the Chat tab's MCP server,
   so the chat agent *can* already interrogate sessions if you know to ask. Nobody
   knows to ask. And they're all **single-session**; nothing reasons *across* the
   corpus.

## The boundary this must respect

The goldmine architecture deliberately keeps **raw transcript content on the
user's machine**. `get_session_transcript` (verbatim content into the chat
agent's context) was **removed on purpose** (see
`docs/superpowers/specs/2026-07-05-goldmine-aggregates-only-design.md`);
`ask_session` replaced it — a *sub-agent* reads the scrubbed transcript and
returns only a text answer, so raw content never lands in the calling agent's
context. Every string leaves through `scrubText`. **Recall works with this
boundary, not around it:** search is lexical over scrubbed content; the
"understanding" layer is `ask_session` fan-out; synthesis sees only the
per-session answers, never raw transcripts.

## Goal

One Observe-phase surface, `#/recall`, with **instant local search** and **two
exits** that both run the same bounded engine:

- **Search (default, zero-cost).** Type a content query → ranked **cross-session
  moments** (best turns from *all* sessions, not "pick a session then dive"), each
  with an FTS snippet showing why it matched and a deep-link to the exact turn in
  the existing `TranscriptViewer`. Pure BM25, local, no ACP spend. Often the
  snippet alone answers "where did I…". Metadata filters (project / agent / branch
  / date) pre-narrow cheaply.
- **Exit A — Chat with selected.** Converse with the selected sessions as one
  corpus. Seeds from a bounded `ask_session` fan-out + synthesis, then continues
  as a normal `ChatManager` chat scoped to the selection.
- **Exit D — Extract across selected.** One-shot extraction prompt → a report
  (synthesis + per-session findings), exportable (copy / .md / .csv) and
  save-as-Gem.

Non-goals: semantic/vector search (the vendored module keeps a clean seam to
re-enable later); loading raw transcripts into any calling agent; a new top-level
phase; changing the existing Sessions or Chat panels beyond cross-links.

## Decisions (locked)

| Decision | Choice | Why |
|---|---|---|
| Search substrate | Vendored **BM25-only** (SQLite FTS5) | Local, boundary intact; reuse tested ranking + `snippet()` + elbow cutoff instead of hand-rolled grep. |
| Index grain | **Per-chunk** (`agent:sessionId#turn`), results span sessions | Cross-session is the product; one query ranks the best moments corpus-wide. |
| Engine / interaction | **A-engine + C-interaction** | Instant BM25 by default; the capped ACP funnel fires only on demand and powers both exits. |
| SQLite backend | **Node built-in `node:sqlite`** | Node ≥24 (already the repo floor) ships SQLite with FTS5 + `snippet()` + `bm25`, flagless. **No native dependency, no postinstall build** — Plans 2/3 must not reintroduce `better-sqlite3`. (`node:sqlite` is marked experimental; acceptable for a local, derived, rebuildable index cache.) |
| Package | **new `@agentgem/recall`** | Isolates the native dep + new surface; depends on `@agentgem/insight`. |
| Index at rest | **on-disk cache** `~/.agentgem/recall-index.db` | Instant startup. Accepted tradeoff — see privacy note. |

### Why SQLite here, not PGlite (which the repo also uses)

The repo already runs an on-disk **PGlite** transcript index (`packages/capture/src/transcriptIndex.ts`,
datadir `~/.agentgem/index`). Recall deliberately uses `node:sqlite` instead — the two serve
**different masters**, so this is justified specialization, not accidental duplication:

- **PGlite (aggregator/capture)** exists for **dialect parity with the hosted Postgres data-moat** —
  shared Drizzle schema, the same queries running local and remote. That parity is the whole point.
- **Recall's index** is **lightweight local session-content FTS**. It has no Postgres-parity requirement.
  PGlite is a multi-MB WASM Postgres (real weight); `node:sqlite` is built into the Node ≥24 runtime
  (zero marginal weight), FTS5 gives true `bm25()` (Postgres `ts_rank_cd` is weaker), and SQLite is the
  ecosystem-native store for coding-agent sessions. Paying PGlite's weight just to collapse to one engine
  is the wrong trade.

No collision: the two live at distinct paths under the same home (`~/.agentgem/index` dir vs.
`~/.agentgem/recall-index.db` file). **Do not "converge" Recall onto PGlite** — this was considered and
rejected for the reasons above.

## Provenance — reused vs. new

| Piece | Source | Status |
|---|---|---|
| BM25 index (FTS5, `bm25()`, `snippet()`, elbow cutoff) | vendor `@factionvc/hybrid-search`, **stripped to BM25** | ⚠️ vendor + fork (drop `sqlite-vec`/`ai`/`@ai-sdk/openai`; swap `@factionvc/common` logger for `createLogger`) |
| Scrubbed, size-bounded transcript content | `loadSessionTranscript()` (`packages/insight/src/inspectSession.ts:294`) | ✅ reuse |
| Session metadata for filters + enumeration | `scanSessions()` / `SessionStat` (`observeScan.ts`) | ✅ reuse |
| Single-session ACP interrogation | `askSession()` + `setAskConnectFnForTests` (`sessionAsk.ts:56`) | ✅ reuse (the fan-out unit) |
| Multi-turn chat continuation | `ChatManager` (`packages/run/src/chatSession.ts:53`) | ✅ reuse for Exit A |
| SSE streaming pattern | `registerChatRoutes` / `/api/chat/stream` (`src/goldmine/chatRoutes.ts`) | ✅ mirror for the funnel job |
| Report export + Save-as-Gem | `packages/console/src/report/` + `draftGemFromChat` (`src/goldmine/draftGem.ts`) | ✅ reuse for Exit D |
| Warm precompute | `Warmable` registry (warm-precompute daemon) | ✅ register the index build |
| Deep-link to a turn | `#/sessions/<agent>/<sessionId>` + `TranscriptViewer` | ✅ reuse |

## Architecture

### 1. The vendored BM25 module — `@agentgem/recall/src/search/`

FTS5 external-content index over scrubbed turns. Stripped from the source module:
the `vec0` table, `vec_item_map`, embedding calls (index-time and query-time), and
the three remote deps. What remains: `items` content table + `items_fts` FTS5 +
`bm25()` ranking + `snippet()` + the elbow-cutoff tail-trim. RRF fusion collapses
to BM25 rank (single signal).

**Row schema (extended for our filters):** per turn, store
`session_id, turn, project, agent, branch, start_ms, text` so filters are plain
SQL `WHERE` and rank is `bm25(items_fts)`. `text` is the scrubbed turn body
(message text or `tool name(input) -> output`, same rendering as
`sessionAsk.renderTranscript`), bounded per session.

**API:**
```ts
class RecallIndex {
  constructor(dbPath: string)                       // ~/.agentgem/recall-index.db
  async sync(sessions: SessionStat[]): Promise<{indexed: number; skipped: number}>
  search(q: string, f: RecallFilters, limit: number): MomentHit[]
  clear(): void
}
interface MomentHit { sessionId: string; agent: string; turn: number;
  project: string|null; branch: string|null; startMs: number;
  snippet: string; score: number; turnsMatched: number }
```

### 2. Index lifecycle — on-disk, versioned, incremental, warmed

- **On-disk** at `~/.agentgem/recall-index.db` (user-local home, alongside
  `session.json`/`binding.json`). A `meta` table carries a **schema version** +
  the scrub-pipeline version; a mismatch triggers a full rebuild (self-invalidates
  on drift so a stale scrubber can't leave un-scrubbed rows behind).
- **Incremental** by `mtime`: `sync()` re-indexes only sessions whose transcript
  file changed since last indexed; deletes rows for vanished sessions.
- **Warmed:** register the sync as a **`Warmable`** so the daemon keeps it fresh
  ahead of use. Searches before first build show an "indexing N/M" state and
  degrade to empty — never error.
- **Clearable:** a "Clear index" control (Settings + the Recall empty state) calls
  `clear()` and deletes the file.

### 3. The funnel engine — `@agentgem/recall/src/recallFunnel.ts` (the "A engine")

Shared by both exits. Composes `askSession` per selected session, then synthesizes.

```ts
recallFunnel({ sessionIds, prompt, mode: 'chat'|'extract', signal }): AsyncGenerator<FunnelEvent>
```
- **Cap + concurrency:** hard cap **K=12** sessions, **3** concurrent
  `ask_session` subprocesses. Over-cap → emit a `capped` event ("scanned 12 of N —
  widen?"). The cap is always surfaced in the UI, in both exits.
- **Fan-out → synthesize:** `ask_session(sessionId, agent, prompt)` each (reusing
  the tested `AcpConnectFn` seam) → a synthesis step that receives **only the
  per-session answers** (already scrubbed-derived; raw transcripts never reach it).
  In `extract` mode the synthesis is one additional neutral ACP prompt over the
  collected answers → the report. In `chat` mode there is no separate synthesis
  call: the per-session answers seed the first `ChatManager` turn and the chat
  agent synthesizes them as it responds.
- **Events:** `session_started`, `session_done{sessionId, degraded?}`,
  `synthesis_delta{text}`, `done`, `capped`, `cancelled` — mirrors `ChatEvent`.
- **Degradation:** `askSession` never throws (degrades to `answered:false`); the
  funnel reports "3 of 3 (1 degraded)" rather than failing the whole run.
- **Cancelable:** `signal` aborts in-flight subprocesses.

**Exit A** feeds the funnel result as the seed of a `ChatManager` chat scoped to
the selection (follow-up turns get the goldmine MCP tools, including the new
`search_session_content`, so the agent can re-interrogate within/beyond scope).
**Exit D** renders the funnel result as a report; no chat continuation.

### 4. MCP tool + REST routes

- **New MCP tool** `search_session_content(query, filters, limit)` → `MomentHit[]`,
  registered beside `search_sessions`/`summarize_session`/`ask_session` in
  `src/goldmine/mcpServer.ts`. Backed by `RecallIndex`. This is what lets Exit A's
  follow-up turns search content (the metadata-only `search_sessions` can't).
- **New routes** — `src/goldmine/recallRoutes.ts` (mirrors `chatRoutes.ts`):
  - `GET /api/recall/search?q=&project=&agent=&since=&limit=` → `MomentHit[]` (instant BM25).
  - `POST /api/recall/run` `{sessionIds, prompt, mode}` → `{jobId}` (starts a funnel).
  - `GET /api/recall/stream?jobId=` → SSE `FunnelEvent` stream.
  - `DELETE /api/recall/:jobId` → cancel.
  - `GET /api/recall/status` → index build state (for the "indexing N/M" UI).
  - Chat continuation reuses `/api/chat` with a session-scoped brief.

### 5. Console panel — `packages/console/src/panels/Recall/`

New panel at `#/recall`, registered in the Observe → Understand nav group next to
Sessions. Layout per the approved mockup: search bar + metadata filter pills →
cross-session moment cards (checkbox, project·branch·agent·when, highlighted
snippet, "N matching turns", Open-turn deep-link) → sticky action bar (selection
count + the two exit buttons) → an inline **workspace drawer** that renders either
the Chat (A) or Extract (D) exit. Reuses `chatStream.ts`'s SSE consumer pattern;
the moment "Open turn ↗" links to `#/sessions/<agent>/<sessionId>`. Sessions gets
a reciprocal "Search these ↗" entry into Recall.

## Privacy note (on-disk index)

Persisting the FTS index means scrubbed content lives **at rest** — a surface the
goldmine design otherwise avoided. Mitigations, all in scope:
- File lives at `~/.agentgem/recall-index.db` (user-local, not synced, not in any repo).
- Holds **only `scrubText`-processed** content — never raw. Same scrub path as
  `ask_session`; the `meta` version guards against a stale scrubber.
- A visible **Clear index** control; documented; `~/.agentgem/` is user-private.
- The index is a derived cache — deletable at any time, rebuilt from source `.jsonl`.

## Error handling

- **No index yet / mid-build:** search returns empty + "indexing N/M"; never throws.
- **Unparseable transcript:** skipped in `sync()` (counted in `skipped`), doesn't
  abort the build.
- **ACP unavailable (non-claude/codex source):** `askSession` already returns a
  graceful "raw interrogation isn't available for X" answer; funnel marks that
  session degraded.
- **Funnel cancel / timeout:** aborts subprocesses; partial synthesis is labeled partial.

## Testing

- **RecallIndex (unit, deterministic):** index N fake chunks → assert BM25 rank
  order, `snippet()` highlight, metadata filters, elbow cutoff, incremental `mtime`
  re-sync, version-mismatch rebuild, `clear()`.
- **recallFunnel (unit):** fake `AcpConnectFn` (`setAskConnectFnForTests`) →
  deterministic per-session answers → assert synthesis, `FunnelEvent` sequence,
  cap enforcement (K=12), concurrency limit, cancel, degraded-session handling.
- **Routes:** SSE stream shape for `/api/recall/stream`; search route filter
  plumbing; `/api/recall/status`.
- **Console (local — not in CI):** panel render, selection → count, exit-drawer
  toggles, Open-turn deep-link href.

## Build sequence (for the plan)

1. `@agentgem/recall` package skeleton + vendored BM25 module (stripped) + `RecallIndex` + tests.
2. Index lifecycle: on-disk + versioned + incremental `sync()` + `Warmable` registration.
3. `recallFunnel` + fan-out/synthesis + `FunnelEvent`s + cap/cancel + tests.
4. `search_session_content` MCP tool + `recallRoutes.ts` (search / run / stream / cancel / status).
5. Console `Recall` panel (search + moments + exits) + nav registration + Sessions cross-link.
6. Wire Exit A → `ChatManager` scoped chat; Exit D → report export + Save-as-Gem.
7. Settings "Clear index" control + docs + `.gitignore`/privacy note.
