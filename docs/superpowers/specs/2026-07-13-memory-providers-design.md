# Memory Providers — two-way sync bridge

**Date:** 2026-07-13
**Status:** Approved design, pre-implementation
**Branch:** `feat/memory-providers`

## Summary

Add a feature that connects AgentGem to one or more external **AI memory
providers** (mem0, Supermemory, Zep, Letta/MemGPT) as a **two-way sync bridge**:

- **Pull** — stored provider memories flow into the local recall BM25 index, so
  `#/recall` searches sessions *and* provider memories together.
- **Push** — durable facts/preferences and outcomes/scorecards that AgentGem
  already distills become memory *candidates*, land in a local outbox, and are
  written out to enabled providers **only after the user approves them**.

Nothing leaves the machine unapproved. This mirrors AgentGem's existing
consent-first pattern (Dream review queue, benchmark contribution opt-in).

## Scope

**v1 (this spec):**
- Provider adapter interface + registry.
- **mem0 adapter only**, implemented end-to-end.
- Pull → recall index (searchable) with incremental cursor + upsert-by-id.
- Push candidate generation + local outbox + curation UI + guarded send.
- Console "Memory providers" settings panel + curation surface.

**Deferred (registered as `NotImplemented` stubs / documented limitations):**
- Supermemory, Zep, Letta adapters (fast-follow, one PR each).
- Deletion reconciliation on pull (deleted provider memories linger until a full
  re-index).
- Cross-provider dedupe / conflict resolution / background sync daemon.

**Non-goals:** running memories through a hosted service; any sync in the desktop
client or hosted API process.

## Architecture

New package `packages/memory` (`@agentgem/memory`), depending on:
- `@agentgem/recall` — writes pulled memories into the recall index.
- `@agentgem/base` — `AGENTGEM_HOME` workspace paths, logging.
- `@agentgem/insight` — reuses `distill` / `sessionLessons` / attestation output
  and `scrub.ts` redaction for push candidates.

The provider surface is deliberately the **intersection** of what all four
providers can do — `pull` / `push` / `test`. Richer models (Zep temporal graph,
Letta memory blocks) map *down* to `MemoryRecord` inside their adapter; consumers
never branch on provider type.

```ts
export interface MemoryRecord {
  id: string;              // provider-native id (stable; drives dedupe + incremental)
  text: string;            // the memory content
  updatedAt: number;       // epoch ms — incremental pull cursor
  metadata?: Record<string, unknown>;
}

export interface ProviderConfig {
  enabled: boolean;
  apiKey: string;
  baseUrl?: string;
  userId?: string;
}

export interface PushCandidate {
  key: string;             // stable hash of scrubbed text — dedupe + re-push guard
  text: string;            // already scrubbed
  kind: "fact" | "preference" | "outcome";
  source: string;          // e.g. "distill:project-x" | "scorecard:gem-y"
}

export interface MemoryProvider {
  readonly id: string;     // "mem0" | "supermemory" | "zep" | "letta"
  test(cfg: ProviderConfig): Promise<{ ok: boolean; detail?: string }>;
  pull(cfg: ProviderConfig, since?: number): AsyncIterable<MemoryRecord>;
  push(cfg: ProviderConfig, m: PushCandidate): Promise<{ id: string }>;
}
```

A registry maps `id → MemoryProvider`. Only `mem0` is implemented in v1; the other
three are registered as stubs whose `test`/`pull`/`push` reject with a
`NotImplemented` marker so the UI can list them as "coming soon" without dead
abstractions.

## Pull data model (mapping into recall)

Each `MemoryRecord` becomes one recall `chunks` row under a reserved namespace,
reusing the existing FTS + `recallFunnel` unchanged:

| chunk column | value |
|---|---|
| `agent` | `memory:<provider>` (e.g. `memory:mem0`) — namespace = provenance |
| `session_id` | provider record `id` |
| `turn` | `0` |
| `project` | `metadata.project` if present, else `null` |
| `start_ms` | `updatedAt` |
| FTS `text` | `record.text` |

- **Incremental:** a per-provider `lastPulledAt` cursor is stored in the memory
  package's own state file (`~/.agentgem/memory-cursors.json`) and passed as
  `pull(cfg, since)`. Kept out of the recall `meta` table (which is private to
  `RecallIndex`) so the `@agentgem/recall` package needs no API change.
- **Upsert:** re-pull upserts by `session_id` (= provider id), so edited memories
  update in place instead of duplicating.
- **Provenance:** the `memory:*` agent prefix lets the UI filter/label by source.
- **Deletion (v1 limitation):** deleted provider memories are not reconciled; they
  linger until a full re-index.

Result: pulled memories are searchable via `#/recall` with **no query-layer
changes**.

## Push candidate generation + curation

1. **Generate.** `buildPushCandidates()` taps `insight/distill` + `sessionLessons`
   (facts/preferences) and outcome/attestation signal (outcomes/scorecards).
2. **Scrub first.** Every candidate is run through `insight/scrub.ts` **before it
   is shown** — the same redaction that gates transcript indexing and benchmark
   attestation. A candidate that cannot be safely scrubbed is dropped, not shown.
3. **Queue, don't send.** Candidates land in a local outbox
   (`~/.agentgem/memory-outbox.json`). Nothing is pushed automatically — this is
   the consent gate.
4. **Curate.** The console surfaces the outbox as an approve/skip list (mirrors the
   Dreaming review queue). On "Push approved," each approved candidate is sent to
   `provider.push()` for every *enabled* provider.
5. **Re-push guard.** The candidate `key` (content hash) + returned provider id are
   recorded; an already-pushed key is skipped on the next generation, so
   regenerating candidates does not spam duplicates outward (same hash-guard idea
   as the Reflection-Intake CLAUDE.md write).

## Config, secrets & process boundary

- Credentials live in `~/.agentgem/memory-providers.json` (chmod `0600`), keyed by
  provider: `{ "mem0": { "enabled": true, "apiKey": "...", "baseUrl": "...",
  "userId": "..." } }`. Loaded via the existing `AGENTGEM_HOME` workspace helper.
- **Sync runs only in the local core process** — never the hosted API, never the
  desktop client (desktop is a pure API client). API keys and the recall index are
  both local; the desktop console drives sync by calling its **local** core over
  the existing API (the inverse-locality constraint the benchmark-contribute routes
  already follow).
- Local-core-only routes:
  - `POST /api/memory/providers` — save + test config.
  - `POST /api/memory/pull` — run an incremental pull.
  - `GET  /api/memory/outbox` — list candidates.
  - `POST /api/memory/push` — send approved candidates.

## Console UI

- **Settings → "Memory providers"** panel: one connect row per provider — name,
  status badge (connected / error / coming-soon), API-key field, Test button,
  enable toggle, last-sync time, "Pull now". Styled to match the existing console
  identity/account rows; no net-new visual language.
- **Curation surface:** the outbox as an approve/skip review list, reusing the
  Dreaming panel's interaction pattern.

## Testing

- **Adapter contract** (mocked `fetch` against mem0): `pull` yields records, `push`
  returns an id, `test` reports ok/fail.
- **Pull mapping:** records → recall chunk rows → retrievable via `recallFunnel`;
  cursor advances across pulls; re-pull upserts by id (no dupes).
- **Push safety:** a candidate containing a secret is scrubbed/redacted before
  surfacing; the hash-guard blocks re-push of an already-sent key.
- **Isolation:** recall-touching tests run isolated — the real-FS recall/scorecard
  tests are known to flake under full-suite concurrency.

## Open questions / risks

- mem0 has both hosted and OSS/self-host modes; `baseUrl` in `ProviderConfig`
  covers self-host. Confirm the exact add/search request shape against the current
  mem0 API during implementation.
- `userId` scoping: mem0 memories are user-scoped; the adapter must pass a stable
  `userId` (default to the AgentGem identity uuid).
```
