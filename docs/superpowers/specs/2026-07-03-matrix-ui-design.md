# Console "All agents" verification UI — design

- **Date:** 2026-07-03
- **Status:** Spec (awaiting user review)
- **Slice:** the UI half of hermes-borrows Part I phase 2 (deferred from PR #71 with the
  console churn); completes the "mixture of local agents **delegated from our UI**" vision.
- **Borrowed wholesale from Hermes:** the reference-model labelled-blocks UX — watch each
  agent work in its own block, then the verdict lands. Aggregation stays deterministic
  (the matrix), never LLM synthesis.
- **Design decisions (made while user AFK, override welcome):**
  - The UI lives in the **Materialize panel's existing Run bar** — "all agents" becomes a
    roster option in the agent select; no new panel or tab.
  - **All-agents mode is contract-only** (matching `verifyGemAcrossAgents` semantics): the
    task input is hidden and the button reads "Verify" — the Gem's own contract supplies
    the task. A contract-less selection fails at prepare with a clear 400 message.
  - SSE uses the **prepare → stream** split (opaque `verifyId`), mirroring the hardened
    run flow — the client never holds paths or the gem body.

## Goal

Fan a Gem out across the local agent roster from the console and watch it happen: one
labelled output block per agent (streaming text + tool chips + live status), finishing
with the compatibility matrix (`✓ claude · ✗ codex · – gemini`). The blocking
`POST /gem/verify` and CLI stay for programmatic callers; this adds the streaming twin
the browser needs (client header timeouts kill long blocking requests).

Success criteria:

1. `verifyGemAcrossAgents` streams per-agent progress: new optional callbacks
   `onAgentStart(agent)`, `onDelta(agent, chunk)`, `onToolCall(agent, tool)` — additive,
   existing callers unchanged.
2. `POST /api/gem/verify/prepare` `{ selection|archivePath, name?, dir?, projects?, agents?, fetch? }`
   → `{ verifyId, gemName, gemDigest, agents }`; contract-less Gem or unknown agent id →
   400 at prepare (fail before any run).
3. `GET /api/gem/verify/stream?verifyId=` emits named SSE events, every per-agent event
   tagged with `agent`: `agent-start`, `tool`, `delta`, `verdict` (one per agent as it
   finishes), `done` (full verdict list), `failed`. Unknown/expired verifyId → single
   `failed` event.
4. In the Materialize Run bar, choosing "all agents" hides the task input, relabels the
   button "Verify", and streaming renders one block per agent plus a final matrix row;
   `unavailable` agents render as `–` with the detail. Single-agent mode is unchanged.
5. Ledger rows still land per run (the orchestrator's existing behavior — the stream
   layer adds no writes), and journey's `verified` events pick them up with no changes.

## Decisions and alternatives considered

**Prepare → stream, not a POST-SSE hybrid.** Native `EventSource` is GET-only and the
console's four existing streams all use it; the selection travels in the POST, the GET
carries only the opaque id — same security shape as `gem/run/prepare`.

**Callbacks on the orchestrator, not a second orchestrator.** The streaming endpoint
must not fork the matrix logic; `verifyGemAcrossAgents` gains pass-through callbacks to
`materializeAndRunGem`'s existing `onDelta`/`onToolCall`, each wrapped to prepend the
current agent. Sequential execution is unchanged — blocks fill one after another, which
is honest UI for what actually happens.

**Contract-only in the UI too.** Offering a task override in all-agents mode would
reintroduce the loose-expectations path the matrix deliberately rejects; users who want
a custom task run agents one at a time.

**Rejected:** a new "Verify" panel (the Run bar already owns agent execution UX);
parallel agent execution for snappier UI (roster of 2, RAM/rate-limit cost, and the
sequential matrix is the shipped, reviewed semantics); WebSockets (nothing else uses
them here).

## Components

### 1. Orchestrator callbacks — `packages/run/src/verifyMatrix.ts`

`VerifyMatrixOptions` gains:

```ts
  onAgentStart?: (agent: AgentId) => void;                 // fired before an agent's availability check
  onDelta?: (agent: AgentId, chunk: string) => void;
  onToolCall?: (agent: AgentId, tool: ToolInvocation) => void;
```

Threaded into the loop: `onAgentStart(agent)` first; `materializeAndRunGem` receives
`onDelta: (c) => opts.onDelta?.(agent, c)` and likewise for tools. `onVerdict` is
already per-agent. No behavior change when the callbacks are absent.

### 2. Verify registry + prepare — `packages/run/src/verifyMatrix.ts` + `src/gem.controller.ts`

A `registerVerify(spec) → verifyId` / `resolveVerify(id)` pair beside the run registry
(same `randomUUID` opaque-id discipline), holding
`{ gem, baseDir, roster?, fetch?, gemDigest, gemName }` server-side.

`POST /api/gem/verify/prepare` resolves the Gem exactly like `verifyGem` (archive or
selection), validates the roster (unknown ids → `InvalidInputError`), **requires a
contract** (`gem.contract` absent → `InvalidInputError`, so the failure lands at
prepare, not mid-stream), computes `gemDigest` once, derives `baseDir` via
`deriveMatrixBaseDir`, registers, and returns `{ verifyId, gemName, gemDigest, agents }`
(the effective roster).

### 3. Stream endpoint — `src/gemVerifyStream.ts` (new) + registration in `src/index.ts`

Thin SSE glue in the exact shape of `src/gemRunStream.ts` (duck-typed req/res, `send`
helper, never throws to the wire): resolve `verifyId` (unknown → `failed`), then run
`verifyGemAcrossAgents` with the registry spec, wiring callbacks to events:

| SSE event | payload |
|---|---|
| `agent-start` | `{ agent }` |
| `tool` | `{ agent, toolCallId, title, kind?, status? }` |
| `delta` | `{ agent, text }` |
| `verdict` | `{ agent, status, verification?, detail? }` |
| `done` | `{ verdicts, gemName, gemDigest }` |
| `failed` | `{ message }` |

The orchestrator's own ledger appends are untouched (criterion 5).

### 4. Console — `packages/console/src/panels/Materialize/`

- `verifyStream.ts` (new, sibling of `runStream.ts`): typed `VerifyEvent` union +
  `openVerifyStream(apiBase, verifyId, onEvent)` via native `EventSource`.
- `routes.ts`: add the `prepareVerifyRoute` typed client route next to `prepareRunRoute`.
- `Run.tsx`: the agent select gains an `"all"` option.
  - `agent === "all"`: task input hidden, button "Verify"; `start` calls
    `verify/prepare` then `openVerifyStream`; state becomes per-agent
    `Record<AgentId, { output: string; tools: string[]; status: "pending" | "running" | AgentVerdict["status"]; detail?: string }>`
    initialized from the prepare response's `agents`, rendered as one labelled block
    each (agent name header, status badge, tool chips, `<pre>` transcript), followed —
    after `done` — by a matrix row: `✓ agent` / `✗ agent` / `– agent (detail)`.
  - Single-agent mode: byte-for-byte today's behavior.
- If `Run.tsx` grows past ~200 lines, the all-agents rendering extracts to
  `MatrixBlocks.tsx`; the mode switch and shared bar stay in `Run.tsx`.

## Data flow

```
Run bar: agent = "all" → POST /gem/verify/prepare {selection|archive, agents?, fetch?}
   (contract required; roster validated; baseDir derived; digest computed) → verifyId
→ GET /gem/verify/stream?verifyId
→ per agent, sequentially: agent-start → (tool | delta)* → verdict
→ done {verdicts, gemName, gemDigest}      → matrix row renders
   ↘ orchestrator appends ledger rows per run (unchanged) → journey "verified" events
```

## Error handling

- Contract-less Gem / unknown agent id / missing selection+archive → 400 at prepare,
  surfaced in the Run bar as the existing error line (with the contract message
  suggesting a skill-bearing selection, whose contract is derived at build).
- Unknown/expired `verifyId` → single `failed` SSE event (mirrors run stream).
- An agent's failure/unavailability is a `verdict`, never a stream failure — the stream
  ends with `done` whenever the orchestrator returns.
- Browser disconnect: the server run continues (same as the run stream today);
  the registry entry is consumed by the stream (one-shot), so an EventSource
  auto-reconnect gets the clean unknown-id failure instead of replaying a full
  matrix run; re-preparing is cheap.

## Testing

1. **Core callbacks:** extend `verifyMatrix.test.ts` — a two-agent roster with the
   split connectFn asserts `onAgentStart`/`onDelta`/`onToolCall` fire with the right
   agent tags in order, and that omitting them changes nothing.
2. **Registry:** `registerVerify`/`resolveVerify` round-trip; unknown id → undefined.
3. **Prepare endpoint:** supertest — 200 with verifyId + effective roster; 400 on
   contract-less gem; 400 on unknown agent id.
4. **Stream:** unit test in the `gemRunStream.test.ts` style (fake req/res +
   `setRunConnectFnForTests`): full event sequence for a passing+failing pair —
   `agent-start`×2, per-agent `delta`/`tool`, `verdict`×2, `done` with both verdicts;
   unknown verifyId → `failed` only.
5. **Console:** `Run.tsx` tests — "all" mode hides task/relabels button; streamed
   events land in the right agent's block; matrix row renders ✓/✗/–; single-agent mode
   regression (existing tests unchanged).
6. Full root suite + console tests (console changed — run locally, not in CI).

## Out of scope (later)

Parallel agent execution; a `fetch missing agents` toggle in the UI (`fetch` stays
false; unavailable is informative); per-agent cancel; persisting matrix history in the
UI (the ledger + journey already record it); tournament delegation (Part I phase 3);
Explore/marketplace badge surfacing.
