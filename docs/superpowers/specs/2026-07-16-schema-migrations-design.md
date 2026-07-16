# Schema migrations: convert `ensureSchema` from every-boot idempotent DDL to a run-once runner + explicit heal tier

Status: ENG-REVIEWED (plan-eng-review + Codex outside voice absorbed; quality gate 8/10)
Date: 2026-07-16
Code line references are as of `origin/main` commit `c974971e` (2026-07-16); re-verify against HEAD before implementing.
Decisions locked (D1-D4): hand-rolled runner (no drizzle-kit) · two-tier migrate + heal() · file split with baseline 0001, deferred backfill retirement · delivered as spec doc + issue, no agent spawn.

## Context

The aggregator schema is defined in `packages/aggregator/src/schema.ts` twice by design: drizzle `pgTable`s (query-side truth) and `ensureSchema()` (DDL authority, `schema.ts:632-911`). `ensureSchema` runs on **every boot** — 92 sequential `db.execute` round-trips plus 4 data-backfill scans — including the lazy-PGlite path where it lands on a session's first aggregator request. Its own adoption tripwire ("drizzle-kit migrations are a deferred follow-up when the schema starts evolving", `schema.ts:629`) has fired: ~30 tables, 12+ post-creation `alter table` patches, a PK re-key, a conditional index rebuild, and backfills whose ordering is enforced only by prose. Nothing can ever be deleted (a stale DB might exist), there is no transaction around the sequence, and boot cost grows monotonically.

## Current State (verified 2026-07-16)

Boot order today: `resolveAggregatorDb()` → `ensureSchema(db)` (`localDb.ts:16,27`) → `mountAggregator` → `migrateAccountsOrFail` + re-run `backfillUserHandles` (`src/serverAggregator.ts:134-147`). Tests build the same way via `makeTestDb` (`testDb.ts:9`). The drift guard (merged PR #455) asserts every pgTable column exists after `ensureSchema`.

### Statement classification audit

| # | `ensureSchema` content (lines) | Class | Rationale |
|---|---|---|---|
| 1 | ~30 × `create table if not exists` + all `create index` (633-873) | **Baseline 0001** | Pure DDL, idempotent |
| 2 | 12 × `alter table … add column if not exists` patches (645-691) | **Baseline 0001** | One-time schema evolution, idempotent |
| 3 | `attestations` constraint drop + composite index (638-639); `usage_days` PK re-key `do $$` (667-672) | **Baseline 0001** | One-time re-keys, already conditional |
| 4 | `drop table if exists web_sessions` (801); `accounts.login drop not null` (798); `user_handle_shape` check (782-785) | **Baseline 0001** | One-time, idempotent |
| 5 | `delete from account_scopes where role='self'` (905) | **heal() tail** | Drained one-time (`ScopeGrant` no longer admits `"self"`, `binding.ts:75-76`) — but its position is order-constrained: it must run AFTER `backfillUserHandles` (`schema.ts:898-900` warns deleting first briefly breaks publishing on a pre-backfill DB, e.g. restored backup). Kept in heal() at today's exact position; a drained DELETE per boot is free. |
| 6 | Handle-dupe detection + `user_handle_uniq` conditional rebuild (767-781) | **heal()** | Conditional repair guarding the `claimHandle` race arbiter; if run-once and skipped due to dupes at migration time, the index would never be created after an operator resolves them |
| 7 | `backfillBindingAnchors` (879) | **heal()** | `recordBinding`'s `upsertAccount` is best-effort *today* (`binding.ts:63-65`) — anchor-less bindings can still be created; run-once would end their repair |
| 8 | `backfillUserHandles` (887) | **heal()** | Complements #7 in the same boot (newly-anchored rows need handles); also re-run post-migration at `serverAggregator.ts:144` |
| 9 | `backfillUserEmails` (893) | **heal()** | Email-less users can still be minted by the anchor path; better-auth Connect 500s on null email |
| 10 | `backfillGemOwners` + unresolved-owner warn (907-910) | **heal()** | Owner resolution can succeed later as accounts appear; warn is operationally load-bearing |
| — | `migrateAccountsOrFail`, handle re-run (`serverAggregator.ts:134-147`) | **heal-tier, stays put** | Already every-boot outside `ensureSchema`; documented as heal tier, not moved (out of scope) |

## Proposed Change

Three modules replacing the DDL half of `schema.ts` (pgTables + `AppDb` stay in `schema.ts`, ~520 lines):

### `packages/aggregator/src/migrations.ts` — the runner + steps

```ts
// Steps take the narrow execute-only surface — provably satisfied by both the db handle and a
// drizzle transaction, so no assignability bet on PgTransaction extends PgDatabase.
type MigrationDb = Pick<AppDb, "execute">;
interface Migration { id: string; idempotent?: true; run(db: MigrationDb): Promise<void> }
const MIGRATIONS: Migration[] = [
  // baseline = today's ensureSchema DDL rows 1-4, verbatim. `idempotent: true` selects the
  // unwrapped execution path below.
  { id: "0001-baseline", idempotent: true, run: baseline },
];
// Arbitrary constant; the only requirement is that every instance uses the same bigint.
const MIGRATION_LOCK_KEY = 7264120520250716n;

export async function runMigrations(db: AppDb): Promise<{ applied: string[] }> {
  await db.execute(sql`create table if not exists schema_migrations (
    id text primary key, applied_at timestamptz not null default now())`);
  const done = new Set((await db.execute(sql`select id from schema_migrations`)).rows.map((r) => r.id));
  const pending = MIGRATIONS.filter((m) => !done.has(m.id));
  if (pending.length === 0) return { applied: [] };   // fast path: no lock, no tx
  const applied: string[] = [];
  for (const m of pending) {
    try {
      if (m.idempotent) {
        // Idempotent steps (the 0001 baseline) run UNWRAPPED — statement-by-statement
        // autocommit, byte-for-byte today's ensureSchema lock profile. Concurrent boots
        // racing through this path is today's status quo (safe by idempotency); the
        // on-conflict record absorbs the race. This is what makes the transition boot on
        // live prod a non-event instead of one giant lock-holding transaction.
        await m.run(db);
        await db.execute(sql`insert into schema_migrations (id) values (${m.id}) on conflict (id) do nothing`);
      } else {
        // Future (non-idempotent) steps: ONE transaction per step. The transaction pins a
        // single pooled connection, which is what makes the advisory lock sound:
        // pg_advisory_lock (session-scoped) through a Pool would lock on one connection and
        // "unlock" on another, leaking the lock and guarding nothing. pg_advisory_xact_lock
        // is tied to THIS transaction and auto-releases on commit/rollback.
        await db.transaction(async (tx) => {
          await tx.execute(sql`select pg_advisory_xact_lock(${MIGRATION_LOCK_KEY})`);
          // Re-check under the lock: a concurrent boot may have applied this step between
          // our unlocked read and lock acquisition.
          const now = await tx.execute(sql`select 1 from schema_migrations where id = ${m.id}`);
          if (now.rows.length > 0) return;
          await m.run(tx);
          await tx.execute(sql`insert into schema_migrations (id) values (${m.id})`);
        });
      }
      applied.push(m.id);
    } catch (e) {
      throw new Error(`schema migration ${m.id} failed`, { cause: e });   // step id reaches the boot log
    }
  }
  return { applied };
}
```

- **Existing prod DB needs no special-casing and no new lock exposure:** 0001 runs exactly as today's boot does (idempotent autocommit sweep), then records itself. A mid-sweep crash leaves it unrecorded → next boot re-runs from the top — precisely today's behavior. No "mark-applied-without-running" shortcut: that would silently skip the sweep on a stale-but-existing DB (one whose last boot ran older code), which today's every-boot sweep protects against.
- **Failure mode:** a step that throws aborts boot with the step id in the error (`migration <id> failed`, original error as `cause`); non-idempotent steps roll back atomically and retry next boot.
- **Locking:** `pg_advisory_xact_lock`, never `pg_advisory_lock` — session locks through a `pg.Pool` land on arbitrary connections. PGlite is single-connection, where the xact lock is a trivially-satisfied no-op.
- **Driver constraint:** the runner uses only `execute` and `transaction` — exactly the surface the lazy PGlite client implements (`localDb.ts:47-51`), so the deferred-boot path keeps working unchanged.
- **Transaction-safe DDL only** in non-idempotent steps (no `create index concurrently`); and **never edit an applied migration — add a new one**. Both house rules go in the module header. (Checksums/dirty-flags were considered and rejected: steps are TS functions, not SQL files — checksumming function bodies false-alarms on reformatting, and the merged drift guard (#455) catches real schema divergence.)
- **Export surface unchanged:** the backfills move to `heal.ts`, but the package root must keep re-exporting them (`export * from "./heal.js"` in `packages/aggregator/src/index.ts`) — `src/serverAggregator.ts:18` imports `backfillUserHandles` from `@agentgem/aggregator` and must compile unchanged.
- **Test seam:** `runMigrations(db, steps: Migration[] = MIGRATIONS)` — tests inject fake idempotent/non-idempotent/throwing steps through the optional parameter; production callers pass nothing.
- **Future steps** get `NNNN-slug` ids, appended to `MIGRATIONS`; idempotency preferred (and marked) but no longer required.
- **Suite command:** "full existing root test suite" = `pnpm test` at repo root (`tsc -b && vitest run`, per `package.json:48`); single-file runs use `pnpm exec vitest run dist/aggregator/__tests__/<name>.test.js`.

### `packages/aggregator/src/heal.ts`

`heal(db)`: the every-boot tail, preserving today's statement order **verbatim** (the order is load-bearing — see audit rows 5 and 8):

```
index-guard (dupe check + user_handle_uniq)   schema.ts:767-781
  → backfillBindingAnchors                    schema.ts:879
  → backfillUserHandles                       schema.ts:887
  → backfillUserEmails                        schema.ts:893
  → delete account_scopes where role='self'   schema.ts:905  (order-constrained: after handles)
  → backfillGemOwners + unresolved warn       schema.ts:907-910
```

Every boot, after migrations.

### `ensureSchema(db)` survives as a thin wrapper

`await runMigrations(db); await heal(db);` — so `localDb.ts`, `testDb.ts`, and every test keep their call sites unchanged. Zero churn outside `packages/aggregator`.

## Acceptance Criteria

1. Steady-state boot (all migrations applied) executes exactly **2** runner statements — `create table if not exists schema_migrations` + the applied-ids select — and takes **no transaction and no advisory lock**; asserted by counting instrumented `db.execute`/`db.transaction` calls.
2. **Parity:** schema dump — `information_schema.columns` + `pg_indexes.indexdef` (expression indexes like `lower(handle)` don't appear in information_schema) + `pg_constraint` — of a fresh DB after the new `ensureSchema` wrapper (`runMigrations` + `heal`) is identical to the dump after the pre-change `ensureSchema`. The comparison target is the full wrapper, NOT `runMigrations` alone (the handle index guard lives in `heal`). **Baseline fixture:** the parity test keeps a frozen verbatim copy of the pre-refactor `ensureSchema` body as a test-only `legacyEnsureSchema` fixture in the test file, so parity stays assertable after the source refactor lands.
3. The schema-drift guard (PR #455) passes unchanged.
4. Second `runMigrations` call applies **0 migration steps** and executes only the 2 bookkeeping statements from AC1.
5. A migration step that throws: boot fails with `schema migration <id> failed` (original error as `cause`), and `schema_migrations` does not contain that id.
6. `heal()` run twice on a DB seeded with one anchor-less `account_bindings` row creates exactly one `accounts` anchor (idempotency + preserved semantics).
7. Handle-dupe scenario ("Bob"/"bob" both present): boot still succeeds, error logged, index skipped — exact current behavior (`schema.ts:771-772`).
8. For a non-idempotent step: `pg_advisory_xact_lock` is acquired **inside** the transaction and **before** the applied re-check (asserted on an instrumented statement sequence); the 0001 baseline path runs **unwrapped** with an `on conflict do nothing` record.
9. `heal()` executes its six steps in exactly today's relative order (asserted on an instrumented call/statement sequence).
10. The `@agentgem/aggregator` root export surface is unchanged — `src/serverAggregator.ts` compiles with no import edits (`backfillUserHandles` et al. re-exported via `heal.js`).
11. Full existing root test suite passes with no call-site changes outside `packages/aggregator`.

## Testing Plan

| Layer | What | Count |
|---|---|---|
| Unit | runner: records, skips applied, ordering, step-failure wrapping (AC5), fast-path no-lock/no-tx (AC1/AC4), lock-inside-tx sequence for non-idempotent steps + unwrapped baseline path (AC8) | +6 |
| Integration | parity dump incl. indexdef (AC2), heal idempotency (AC6), handle-dupe (AC7), heal step order (AC9) | +4 |
| Real Postgres (opt-in) | two concurrent `runMigrations` against one database apply each non-idempotent step exactly once — gated on `TEST_DATABASE_URL`, skipped when unset (CI has no Postgres service; PGlite is single-connection) | +1 |
| Existing | drift guard + full aggregator suite unchanged | 0 changed |

The lock design is additionally correct by construction (xact-scoped inside a pinned-connection transaction) — the opt-in concurrency test verifies it against real Postgres locally and on demand, not as a CI gate.

## Rollback Plan

Revert the PR. The leftover `schema_migrations` table is inert under old code (old `ensureSchema` never reads it), and 0001's statements are idempotent, so old code re-running them against the migrated DB is today's status quo.

## Effort Estimate

~1h extract baseline + runner · ~1h heal split · ~2h tests (parity, counting, heal) · ~1h review margin. (human: ~5h / CC: ~40min)

## Out of Scope

- Retiring drained backfills / deleting 0001-subsumed patches (follow-up **after** prod records 0001)
- drizzle-kit adoption
- **The three-stage boot choreography** (`ensureSchema` heal → `migrateAccountsOrFail` → second `backfillUserHandles`, `serverAggregator.ts:134-147`) — the outside voice correctly names this the deeper conceptual mess, but it is auth-critical (loud-fail account-link conflicts) and was explicitly scoped out in D2/D3; consolidating it into heal() is a follow-up with its own failure-mode analysis
- Root-causing `recordBinding`'s best-effort `upsertAccount` (would let audit row 7 leave the heal tier)
- Migration checksums / dirty flags (considered, rejected — see Proposed Change; drift guard #455 is the divergence net)
- The three local `node:sqlite` stores (separate debt item, partly fixed in PR #456)

## Related

- PR #455 (drift guard — the referee for AC2/AC3), PR #456, PR #457 (same debt review)

## What already exists (reused, not rebuilt)

- The entire 0001 baseline body = today's `ensureSchema` DDL (rows 1-4), moved verbatim — zero new DDL authored.
- `heal()` = today's every-boot tail (`schema.ts:767-781`, `875-910`), moved verbatim with order preserved.
- `makeTestDb`/`resolveAggregatorDb` call sites and the drift guard (#455) consume the `ensureSchema` wrapper unchanged.
- The backfill functions themselves are untouched — only their home module changes (re-exported from the package root).

## Failure modes (new codepaths)

| Codepath | Realistic failure | Test | Error handling | User-visible? |
|---|---|---|---|---|
| Fast path (all applied) | applied-ids select fails (DB down) | existing boot-failure behavior | error propagates, boot aborts loudly | yes — boot log |
| Baseline unwrapped run | crash mid-sweep | AC5-adjacent (unrecorded → rerun) | next boot re-runs from top (today's semantics) | no — self-heals |
| Concurrent first boots | both run baseline | opt-in pg test + `on conflict do nothing` | idempotent by construction | no |
| Non-idempotent step | throws mid-step | AC5 | tx rollback, step id in error, retry next boot | yes — boot log |
| heal() regression | step order broken by future edit | AC9 sequence test | n/a (test-guarded) | — |

No silent-failure critical gaps: every unhandled path aborts boot loudly, and the two self-healing paths are today's existing semantics.

## Implementation Tasks

- [ ] **T1 (P1, human: ~2h / CC: ~15min)** — migrations.ts — extract baseline (rows 1-4) + runner with idempotent/unwrapped vs tx/xact-lock paths, step-id error wrapping, `MigrationDb` narrow type
  - Surfaced by: Architecture review — pooled-connection advisory-lock finding + Codex hybrid-baseline finding
  - Verify: AC1, AC4, AC5, AC8 unit tests
- [ ] **T2 (P1, human: ~1h / CC: ~10min)** — heal.ts — move the six-step tail verbatim (order per audit), re-export via package index (root surface unchanged)
  - Surfaced by: Architecture review row-5 reclassification + Codex export-surface finding
  - Verify: AC9, AC10; `tsc -b` with zero `serverAggregator.ts` edits
- [ ] **T3 (P1, human: ~2h / CC: ~15min)** — tests — parity dump incl. `pg_indexes.indexdef` (AC2), heal idempotency (AC6), handle-dupe (AC7), statement-count fast path (AC1)
  - Surfaced by: Test review + Codex AC2/expression-index finding
  - Verify: `tsc -b && pnpm exec vitest run dist/aggregator/__tests__/migrations.test.js`
- [ ] **T4 (P2, human: ~1h / CC: ~10min)** — opt-in real-Postgres concurrency test gated on `TEST_DATABASE_URL`
  - Surfaced by: Codex instrumentation-over-trust finding
  - Verify: run locally against a scratch Postgres; skipped in CI

Sequential implementation, no parallelization opportunity — all four tasks touch `packages/aggregator/src/` and T3/T4 depend on T1/T2.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Codex Review | `/codex review` | Independent 2nd opinion | 1 | CLEAR (absorbed) | 11 findings: 8 accepted, 2 rejected w/ rationale, 1 folded into scope note |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR | 7 issues, 0 critical gaps — all folded into spec |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | n/a (no UI surface) |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

- **CODEX:** outside voice (high effort, repo-grounded) found the AC2 parity hole, the fast-path DDL contradiction, the one-big-transaction prod risk (resolved via the idempotent/unwrapped baseline hybrid), the export-surface break, the unwrapped step-id error, the `run(tx)` type risk, and the instrumentation-only lock testing gap — all absorbed. Checksum and boot-choreography recommendations rejected with documented rationale.
- **CROSS-MODEL:** strong agreement on the load-bearing issue (advisory-lock soundness through a connection pool); the one genuine tension (transaction-wrapped vs unwrapped baseline) resolved by a hybrid that dominates both originals (today's lock profile + recorded run-once).
- **VERDICT:** ENG CLEARED — ready to implement.

NO UNRESOLVED DECISIONS
