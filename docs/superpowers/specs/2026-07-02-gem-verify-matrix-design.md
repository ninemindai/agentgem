# Cross-agent verification matrix (`verifyGemAcrossAgents`) — design

- **Date:** 2026-07-02
- **Status:** Spec (awaiting user review)
- **Slice:** Part I phase 2 of [hermes-borrows](../../proposals/hermes-borrows.md)
- **Builds on:** phase 1 (GemContract + evidence ledger, shipped `12f3b6e`)
- **Scope decision (made while user AFK, override welcome):** core orchestrator +
  blocking `POST /api/gem/verify` + `agentgem verify` CLI subcommand. The console
  "All agents" UI and any SSE variant stay deferred with the other console work.

## Goal

Answer "which of this machine's agents does this Gem actually work on?" with
evidence. One call runs the same Gem, against its own contract, across the local
ACP adapter roster — each agent in a fresh isolated dir — and returns a
deterministic per-agent compatibility matrix. Every verified run lands in the
phase-1 evidence ledger, giving the future Stone-grade/marketplace surface and the
journey timeline their data.

Success criteria:

1. `verifyGemAcrossAgents` returns one `AgentVerdict` per roster agent:
   `"passed"` / `"failed"` / `"unavailable"`, with the `VerificationReport`
   attached for ran agents and a human-readable `detail` otherwise.
2. Agents whose adapter is not installed are reported `"unavailable"` — by
   default nothing is downloaded (no surprise 246 MB codex fetch); `fetch: true`
   opts into the on-demand chain.
3. Each agent runs in its own fresh run dir; one agent's workspace never leaks
   into another's.
4. Each completed run appends a phase-1 ledger record (pass or fail).
5. A Gem with no contract (and no explicit contract argument) is rejected with
   `InvalidInputError` → 400 at the endpoint; the matrix is only meaningful
   against the Gem's own claim.
6. `agentgem verify <archive-dir>` prints the matrix and exits 0 when every
   *available* agent passed (and ≥1 was available), 1 otherwise.

## Decisions and alternatives considered

**A dedicated orchestrator wrapping `materializeAndRunGem` (chosen).** Each roster
entry gets availability-check → materialize → run → verify → ledger, reusing the
phase-1 machinery verbatim. Alternatives rejected: extending `POST /gem/run` with
`agent: "all"` (overloads one endpoint's response contract and its single-run
semantics); client-driven N× calls to the existing endpoint (pushes orchestration,
isolation, and availability semantics onto every caller).

**Aggregation is deterministic.** The "matrix" is the verdict list itself. No LLM,
no scoring pass — per the proposal's judging-not-synthesizing stance.

**Contract-only verification.** The matrix verifies the Gem's *own claim*: the
contract from the Gem (or an explicit `contract` argument for callers that know
better). No loose `task`/`expectations` overrides here — that's what
`POST /gem/run` is for. No contract at all → `InvalidInputError`.

**`fetch` defaults to false.** `resolveOrFetchAdapter(..., { allowFetch: false })`
throws a clear message when the adapter isn't installed; the orchestrator catches
it into an `"unavailable"` verdict. The matrix answers "my installed agents";
`fetch: true` widens it deliberately.

**Sequential by default.** Local machines pay for parallel agent runs in RAM and
provider rate limits, and the roster is 2 today. No concurrency option in this
slice (YAGNI — the proposal's "opt-in bound of 2" waits for a real need).

**Per-agent dirs derive from a base dir + agent id.** `AgentId` values are safe
literals (`"claude" | "codex"`), so `join(baseDir, agent)` inside the orchestrator
is path-safe; the endpoint derives `baseDir` with the existing hardened
`deriveRunDir(gem.name + "-matrix")` and the CLI uses the same helper's semantics.

## Components

### 1. Orchestrator — `packages/run/src/verifyMatrix.ts` (new)

```ts
export interface AgentVerdict {
  agent: AgentId;
  status: "passed" | "failed" | "unavailable";
  verification?: VerificationReport;   // present for passed/failed
  detail?: string;                     // adapter-resolve error or run error
}

export interface VerifyMatrixOptions {
  gem: Gem;
  baseDir: string;                     // server/CLI-derived; agent id appended per run
  contract?: GemContract;              // default: gem.contract; neither → throws InvalidInputError
  roster?: AgentId[];                  // default: Object.keys(AGENT_ADAPTERS)
  fetch?: boolean;                     // default false: missing adapter → "unavailable"
  onVerdict?: (v: AgentVerdict) => void; // fires as each agent finishes (CLI progress)
  connectFn?: RunConnectFn;            // test seam, passed through to materializeAndRunGem
  home?: string;                       // test seam for the ledger (default agentgemHome())
}

export async function verifyGemAcrossAgents(opts: VerifyMatrixOptions): Promise<AgentVerdict[]>
```

Per roster agent, sequentially:

1. **Availability:** `resolveOrFetchAdapter(AGENT_ADAPTERS[agent], { allowFetch: opts.fetch ?? false })`
   — throw → `{ agent, status: "unavailable", detail: err.message }`. Skipped when
   a `connectFn` test seam is injected (mirrors `materializeAndRunGem`'s
   `hasTestConnectFn()` guard).
2. **Run:** `materializeAndRunGem({ gem, dir: join(baseDir, agent), task: contract.task, agent, expectations: contractToExpectations(contract), connectFn })`.
3. **Verdict:** `verification.passed` → `"passed"`, else `"failed"` (a run that
   never completed — `run.ok === false` — is `"failed"` with `detail: run.error`;
   its verification report already fails fast per phase 1).
4. **Ledger:** `appendVerification({ gemName, gemDigest, agent, adapterVersion,
   contractApplied: true, run, verification }, home)` — computed once per call:
   `gemDigest` via `readGemMeta(writeGemArchive(gem).files)`.

The orchestrator never throws per-agent (failures are data); it throws only for
the no-contract case, before any agent runs.

### 2. Endpoint — `POST /api/gem/verify` (`src/gem.controller.ts`)

Request mirrors the run endpoints' Gem resolution: `{ selection | archivePath,
name?, dir?, projects?, agents?, fetch? }`. Response:

```ts
{ gemName: string, gemDigest: string, baseDir: string, verdicts: AgentVerdict[] }
```

Resolution: archive or selection → `Gem` (existing pattern); `baseDir =
deriveRunDir(gem.name + "-matrix")`; roster from `agents` filtered to known
`AgentId`s (unknown ids → `InvalidInputError`). Long-running by nature (N
sequential agent runs) — same blocking character as the existing `POST /gem/run`,
acceptable until the SSE/console slice. Schemas in `src/schemas.ts`
(`GemVerifyRequestSchema` / `GemVerifyResponseSchema` with an `AgentVerdictSchema`).

### 3. CLI — `agentgem verify <archive-dir>` (`src/cli.ts` + `src/verifyCli.ts` new)

Follows the `warm` pattern: an `argv[0] === "verify"` branch lazy-imports
`runVerifyCommand` from `src/verifyCli.ts`. Flags: `--agents claude,codex`,
`--fetch`. Reads the archive dir (`readArchiveDir` + `readGemArchive`), derives
the base dir with the same sanitizer semantics as the endpoint, calls the core
with an `onVerdict` printer, prints one line per agent
(`✓ claude passed · 3 checks`, `✗ codex failed — <first failed check>`,
`– codex unavailable — <detail>`), and exits per success criterion 6. No server
needed. Help text gains the subcommand.

## Data flow

```
archive|selection ──▶ Gem ──▶ contract (gem.contract ?? explicit; none → 400/exit 2)
                                 │
              roster (default AGENT_ADAPTERS keys, or agents param)
                                 ▼   sequentially per agent
        resolveOrFetchAdapter(allowFetch: fetch?) ──throw──▶ verdict: unavailable
                                 │ok
        materializeAndRunGem(dir = baseDir/agent, task, expectations)
                                 ▼
        verification.passed ? passed : failed ──▶ appendVerification (ledger)
                                 ▼
                    AgentVerdict[] (the matrix)
```

## Error handling

- No contract anywhere → `InvalidInputError` before any run (400 at endpoint;
  CLI prints the message and exits 2).
- Unknown agent id in `agents`/`--agents` → `InvalidInputError` (400 / exit 2).
- Adapter missing (fetch off) → `"unavailable"` verdict, never an error.
- Agent run failure/timeout → `"failed"` verdict with `detail`; matrix continues
  to the next agent.
- Ledger IO failures stay best-effort (phase 1 guarantee, unchanged).

## Testing

All hermetic via the existing `connectFn`/`setRunConnectFnForTests` seams and temp
`AGENTGEM_HOME`s:

1. **Matrix core:** two-agent roster with an injected connectFn that passes for
   one agent's expectations and fails the other → `["passed", "failed"]` in
   roster order; ledger has exactly 2 records; per-agent dirs are distinct and
   both materialized.
2. **Unavailable:** no connectFn seam + a roster entry whose adapter can't
   resolve with `allowFetch: false` → `"unavailable"`, no run dir created, no
   ledger record. (Injected installer seam from `resolveOrFetchAdapter` keeps
   this hermetic.)
3. **No contract:** contract-less Gem, no explicit contract → throws
   `InvalidInputError`; endpoint test asserts 400.
4. **Endpoint:** supertest — archive with contract → 200 with per-agent verdicts
   and `gemDigest`; unknown agent id → 400.
5. **CLI:** `runVerifyCommand` unit test with injected core dep — prints one line
   per verdict, exit code 0/1/2 matrix.
6. Full root suite + console tests (not in CI) before merge.

## Out of scope (later slices)

Console "All agents" UI + SSE multiplexed streaming, concurrency > 1, ledger
read/aggregation API (matrix history), publish-gate integration, remote/sandboxed
verification (agentOS), gemini adapter enablement, fixing #68 (registry contract
drop) and #69 (task visibility) — tracked separately.
