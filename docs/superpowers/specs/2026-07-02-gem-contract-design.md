# GemContract + verification-evidence ledger — design

- **Date:** 2026-07-02
- **Status:** Spec (awaiting user review)
- **Slice:** Part I phase 1 of [hermes-borrows](../../proposals/hermes-borrows.md)
- **Scope decision (made while user AFK, override welcome):** backend-only with a
  derived default contract. No console UI changes — the Publish-form contract
  editor waits for `feat/build-nav-gem-scope` to land (collision avoidance).

## Goal

Make "this Gem works" portable. Today `verifyGemRun` expectations arrive as UI
query params on the SSE run endpoint and die with the console session. After this
slice, a Gem carries its own completion contract through selection → build →
archive → install → run, every verified run appends to a local evidence ledger,
and the cross-agent matrix (phase 2) has its substrate.

Success criteria:

1. A Gem built from a selection with ≥1 skill has a derived contract; it survives
   the archive round-trip (`writeGemArchive` → `readGemArchive`).
2. A run prepared from a contract-bearing Gem verifies against that contract with
   **no** query params; explicit query params still win.
3. Every verified run (blocking and SSE paths) appends one JSONL record to the
   ledger under `agentgemHome()`.
4. Archives without contracts, and old archives read by new code, behave exactly
   as today. `ARCHIVE_FORMAT_VERSION` stays `1`.

## Decisions and alternatives considered

**Contract lives on the `Gem` model and in the manifest — not a sidecar file.**
The attestation pattern (`writeAttestedArchive` injecting a lock-covered
`attestation.json`) was considered and rejected: attestations are added *post hoc*
by a different party, while a contract is intrinsic build-time metadata — the same
species as `checks` and `grade`, which already live on `Gem` and in the manifest.
Putting it on `Gem` also covers the selection→prepare path, which never touches an
archive.

**No `formatVersion` bump.** `readGemArchive` does not enforce `formatVersion`,
and JSON parsing ignores unknown fields, so an optional `contract` field is
backward- and forward-compatible. (This corrects the hermes-borrows proposal,
which assumed a bump was needed.)

**Derivation lives in `buildGem`** (`@agentgem/build`), not in archive-write, so
both selection-built and archive-read Gems can carry contracts.

**Ledger writes are best-effort.** A ledger IO failure must never fail a run
response; it logs and moves on. The ledger is an observability substrate, not a
transaction log.

## Types

In `packages/model/src/types.ts` (next to `Gem`):

```ts
// A Gem's portable completion contract: what a runner should ask an agent to do,
// and what evidence proves the Gem worked. Serializable subset of GemExpectations
// (string-only: no RegExp in an archive).
export interface GemContract {
  task: string;                    // prompt handed to the agent
  expect: {
    tools?: string[];              // → GemExpectations.expectTools
    text?: string;                 // → GemExpectations.expectText (substring)
    forbidToolFailures?: boolean;  // default true
  };
}

export interface Gem {
  // ...existing fields...
  contract?: GemContract;          // absent = not contract-bearing
}
```

## Components

### 1. Derivation — `packages/build`

`buildGem` gains a final step: if the built Gem has ≥1 skill artifact and no
explicit contract was passed in build options, attach a conservative default:

```ts
{
  task: `Use the "${firstSkill.name}" skill to complete a small demonstration task in this workspace.`,
  expect: { tools: [firstSkill.name], forbidToolFailures: true },
}
```

Rationale: `verifyGemRun` matches `expect.tools` case-insensitively as a substring
of invoked tool titles, and the shipped end-to-end validation proved agents invoke
materialized skills by name. Gems with no skills get **no** derived contract
(honor-only) — deriving a meaningful task for arbitrary artifact mixes is
guesswork, and a wrong contract is worse than none. Build options gain
`contract?: GemContract` for callers that know better.

### 2. Serialization — `packages/archive`

`GemManifest` gains `contract?: GemContract`; `writeGemArchive` copies it from the
Gem; `readGemArchive` restores it. A malformed contract in a hand-edited archive
(wrong shape, non-string task) is treated as absent, with the tolerant-reader
posture the archive code already takes. The manifest is hashed by the lock, so the
contract is tamper-evident for free.

### 3. Run registry threading — `packages/run`

`registerRun(dir, agent)` grows an optional meta argument:

```ts
registerRun(dir, agent, meta?: { gemName?: string; gemDigest?: string; contract?: GemContract })
```

Both prepare paths (`src/gem.controller.ts`: selection and archivePath) pass the
Gem's name, its lock `gemDigest` (computed at prepare; for the selection path,
compute via `computeLock(writeGemArchive(gem).files)`), and its contract. The
opaque-runId security property is unchanged — meta stays server-side.

### 4. Expectation resolution — `src/gemRunStream.ts` + blocking endpoint

Precedence: if **any** expectation query param (`expectTools`, `expectText`) is
present, the query expectations replace the contract's `expect` entirely — no
per-field mixing of the two sources. Otherwise the registry contract's `expect`
applies; otherwise no verification. `task` resolves independently: the query
`task` wins, else `contract.task`; "missing task" is only an error when neither
exists. The `done`
event gains `contractApplied: boolean` so the UI can say why verification ran.

### 5. Evidence ledger — `packages/run/src/evidenceLedger.ts` (new)

```ts
export interface VerificationRecord {
  ts: string;                       // ISO, stamped at append
  gemName?: string;
  gemDigest?: string;
  agent: string;
  adapterVersion?: string;
  contractApplied: boolean;
  run: { ok: boolean; toolCalls: number };
  verification: VerificationReport; // verbatim
}

export function appendVerification(rec: VerificationRecord, home?: string): void
```

Append-one-JSON-line to `join(home ?? agentgemHome(), "verifications.jsonl")`.
Synchronous append (`appendFileSync`) keeps ordering trivial; records are small.
Errors are caught and logged, never thrown. Both run endpoints call it whenever
verification ran (pass or fail — failures are evidence too). The ledger is
local-only; nothing in this slice reads it back (phase 2 / journey do), and it is
excluded from any share/publish payload by construction (nothing uploads it).

## Data flow

```
selection ──buildGem──▶ Gem{contract?} ──writeGemArchive──▶ gem.json{contract?}
                                 │                              │
                                 │                        readGemArchive
                                 ▼                              ▼
                    prepare: materialize + registerRun(dir, agent, {name, digest, contract})
                                 ▼
                    stream/blocking run: expectations = query ?? contract
                                 ▼
                    verifyGemRun ──▶ done{verification, contractApplied}
                                 └──▶ appendVerification (best-effort)
```

## Error handling

- Malformed manifest contract → treated as absent (tolerant reader).
- Ledger IO error → log to stderr, response unaffected.
- Contract present but agent run fails → verification runs, fails, and is
  recorded; `ok:false` outcomes are already first-class in the runner.
- No contract, no query params → exactly today's behavior (no verification).

## Testing

TDD throughout; all tests hermetic (temp dirs, fake connectFn via the existing
`setRunConnectFnForTests` seam):

1. **Derivation:** skill-bearing selection → contract present with skill name;
   artifact-only selection → no contract; explicit build-option contract wins.
2. **Round-trip:** `writeGemArchive`/`readGemArchive` preserves the contract;
   archive without contract reads as today; malformed contract reads as absent.
3. **Precedence:** query params beat contract; contract applies when params
   absent; neither → no verification, task required.
4. **Ledger:** verified run appends a parseable record under a temp
   `AGENTGEM_HOME`; append failure (unwritable dir) doesn't fail the run; both
   blocking and SSE paths append.
5. **Compat guard:** existing archive fixtures still pass untouched
   (`ARCHIVE_FORMAT_VERSION` unchanged assertion).

Run the full root suite plus `packages/console` tests locally (console is not in
CI), though no console code changes are expected.

## Out of scope (later slices)

Publish-form contract editor (post nav-branch), `verifyGemAcrossAgents` + the
compatibility matrix (phase 2), ledger read API / journey timeline, multi-contract
`contracts[]` (open question #7 in the proposal), registry/marketplace surfacing.
