# Steering Signals — capturing the human's judgment without persisting the human's prose

_Draft 2026-07-08. Base: `origin/main` @ 91488a9e._

## Goal

The distill pipeline mines **what the agent did**. It does not capture **how the human steered it** —
and the steering is the thing the product claims to own.

Anthropic's agentic-coding study (~400K sessions) found domain expertise is *transcript-legible*, and
named the three signals that carry it: **framing precision**, **verification asks**, and **correction
direction**. Those roughly double verified task success. They are also the exact signals that
`scrub.ts` deletes.

Today:

- `workflowScan.ts:432-497` keeps only the **first** genuine human turn, as `MissionHint {task, outcome}`.
- Mid-session reprompts, corrections, rejections, and verification demands are **dropped before storage**.
- `detectors.ts:123-197` (`no-verify-finish`, `unverified-tail`, `regression-cycle`) infer verification
  discipline from the **agent's** edit/verify sequence — not from what the human asked for.

So the pipeline distills a *procedure*, grounded in a mission sentence. That is real and defensible.
It is not judgment. **The claim "AgentGem turns your steering into a reusable capability" is currently
true in principle and unbuilt in fact.**

## The collision this proposal has to resolve

`scrub.ts` is not sloppy — it is a deliberate, well-argued design:

> *"Instead of scrubbing whatever a tool passes … field-aware, default-deny extraction … removing the
> file-content/PII class **by construction** rather than blocklist."*
> — `packages/insight/src/scrub.ts`, per `skill-distillation-from-transcripts.md` §3a

And §3a's core claim is correct: **"You cannot safely scrub arbitrary free text by blocklist."** Human
turns are arbitrary free text. A naive "also keep the user's messages" would destroy the strongest
privacy property in the codebase — the one that makes `agentgem scan ~/` acceptable to run at all.

Any design that persists user prose is wrong. **The resolution is that we do not need to.**

## The key observation

Two facts already true in the codebase make this tractable:

1. **`detectors.ts` already references transcript content without storing it.** A `DetectorSpec`
   carries *coordinates-only* evidence — `evidence.msgIndices`. The pattern for "point at a turn,
   don't copy it" exists and is used.
2. **The distiller runs locally, against the real transcript.** `distill.ts:172-212` drives a local
   Claude over ACP in plan mode. The raw session file is on the user's disk, readable in-process. The
   scrubber protects the **persisted signal store**; it was never protecting the distiller from the
   user's own machine.

So the prose does not need to be *stored* to be *used*. It needs to be *available at authoring time*,
on the machine that already owns it.

## Design — two tiers, one boundary

### Tier 1 — the persisted signal (coordinates + labels, never text)

A new pass over human turns emits, per turn, at most one label and no content:

```ts
// packages/insight/src/steering.ts
export type SteeringKind =
  | "frame"        // sets or re-scopes the task ("only touch the parser")
  | "verify-ask"   // demands evidence ("run the tests", "show me the diff")
  | "correction"   // rejects/redirects the agent's last move ("no, that breaks X")
  | "constraint"   // imposes a rule ("don't add a dependency")
  | "accept";      // ratifies a result ("ship it")

export interface SteeringSignal {
  kind: SteeringKind;
  msgIndex: number;      // coordinate into the transcript. NOT the text.
  turnsSinceEdit: number; // cheap positional feature: was this a reaction to an edit?
}
```

Classification is a **cheap, local, deterministic** first cut (imperative-mood + negation + tool-name
mentions), with the `cost: "llm"` detector kind — already stubbed at `detectors.ts:37` and reserved for
"future agent-judged detectors" — as the accurate second pass. This proposal is the concrete use case
that stub was waiting for.

What Tier 1 gives us immediately, with **zero new privacy surface**:

- A **steering profile** per session: counts and ratios of each kind. `verify-ask` density is precisely
  the "verification asks" axis the study measured. `correction` runs are the "correction direction" axis.
- A real signal for the goldmine scorecard: today `battleTested` means *the procedure recurred*.
  It could mean *the procedure recurred **and** the human stopped correcting it* — convergence, which
  is a far stronger claim and is the honest definition of "battle-tested."
- Detectors upgrade from inference to observation: `no-verify-finish` currently guesses from agent
  behaviour; it could assert *"you never asked it to verify."*

### Tier 2 — the ephemeral read (prose, local, never persisted)

At distill time — and **only** at distill time, in-process, on the user's machine — the distiller reads
the raw user turns at the Tier-1 coordinates and includes them in the ACP prompt:

```
MISSION: <task>
PROCEDURE: <scrubbed {verb,arg} steps>       # unchanged
STEERING: <the human's actual words at the labelled turns>   # read now, never stored
```

The LLM authors `SKILL.md` from procedure **plus** judgment: the constraints the human imposed, what
they rejected and why, what they demanded before accepting. That is the difference between a Gem that
says *"run the tests"* and one that says *"run the tests, and don't trust a green run that skipped the
integration suite — that's how the regression got in last time."*

**The boundary, stated once, enforced twice:**

| | persisted to `~/.agentgem` | leaves the machine |
|---|---|---|
| **procedure** (`{verb, arg}`) | yes, scrubbed | yes, in the Gem |
| **steering labels + coordinates** | yes | **no** — profile aggregates only |
| **human prose** | **never** | only as *distilled, LLM-authored skill text*, which is then gated by `assertGemSafe` |

The second enforcement point is new and load-bearing: distilled skill text is authored *from* the user's
prose, so it can quote a secret the user typed. The leak canary now gates every egress path (`exportGem`,
`publishGem`, `deployGem`), which is what makes Tier 2 safe to ship at all. **This proposal depends on
that gate being wired** — it was not, until recently.

## Success criteria

- `SteeringSignal[]` is derived per session and persisted **without any transcript text**. Assert this:
  a test that JSON-stringifies the stored signal and greps for a canary phrase planted in a user turn.
- Tier 2 prose is read, used, and **never written** — assert via a fake fs/ACP that records writes.
- A distilled `SKILL.md` from a session with corrections differs from one without, in a way a human
  reviewer can name. (If it doesn't, this proposal is not worth its risk.)
- `evidence.msgIndices` stays coordinates-only. No existing privacy test regresses.

## Risks and honest edges

- **Classification precision.** Mislabelling a turn is cheap in Tier 1 (a wrong count) and expensive in
  Tier 2 (the LLM is handed an irrelevant quote). Start with high-precision, low-recall rules; missing a
  correction is far better than surfacing a random user message.
- **This makes the prompt bigger and the distill slower.** `MAX_DISTILL_CANDIDATES = 5` exists because
  "the top-5 or it never finishes" (`distill.ts:22-27`). Steering text competes for that budget.
- **The "never persisted" property is a claim, not a type.** Nothing in TypeScript prevents a future
  caller from writing the Tier-2 string to disk. Mitigate by making the read return an opaque
  `EphemeralProse` branded type that only the ACP prompt builder consumes, and by the grep test above.
- **It cuts both ways for the pitch.** Once we capture steering, "we own your judgment" becomes literally
  true — which raises the stakes of the privacy posture rather than lowering them. The asset framing
  (*"your judgment, yours to own"*) only survives if the boundary above is real and demonstrable.

## Open questions

1. **Should the steering profile be shareable?** A team lead seeing *"this engineer's verify-ask density
   is 0.2"* is surveillance, not distillation. **Leaning: strictly local, aggregate-only, never in the
   org dashboard.** The profile improves *your* gems; it does not rate *you*. This should probably be a
   stated product invariant, not an implementation detail.
2. **Does a Gem record that it was distilled from corrected sessions?** It is a genuine trust signal
   ("converged after 6 corrections") and a genuine embarrassment ("the author needed 6 tries").
3. **Retroactive?** Existing transcripts still contain the prose on disk. Tier 1 can be backfilled
   without re-storing anything — worth doing, since it makes the scorecard's `battleTested` claim
   honest for sessions already captured.
