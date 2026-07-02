# Proposal: Borrowing from Hermes Agent v0.18.0 — mixture of local agents, /learn, /journey

- **Status:** Proposal (design)
- **Date:** 2026-07-02
- **Area:** Gem runner (`packages/run`), archive format (`packages/archive`), distillation (`@agentgem/insight`, `src/dream/`), console (`packages/console/src/panels/`)
- **Depends on:** the shipped ACP Gem runner (`runGemWithAgent` + `verifyGemRun` + prepare/stream flow), the dreaming review queue + diary (on `origin/main`), skill distillation (`distillWorkflow`)
- **Relates to:** [agentOS sandboxed execution](./agentos-sandboxed-execution.md), [dreaming](./dreaming.md), [skill distillation](./skill-distillation-from-transcripts.md), the Cut × Stone scorecard
- **Prior art:** [Hermes Agent v0.18.0 "The Judgment Release"](https://github.com/NousResearch/hermes-agent/releases/tag/v2026.7.1) — Mixture-of-Agents as a first-class model, `/goal` completion contracts + verification-evidence ledger, `/learn`, `/journey` + memory graph

## Summary

Hermes v0.18.0 shipped four ideas worth borrowing, reinterpreted for AgentGem's
artifact-first shape. Hermes is *agent-first* (it learns for itself, in-loop);
AgentGem is *artifact-first* (it distills portable, publishable Gems out-of-loop).
That's why Hermes's UX ideas transfer cleanly while its runtime ideas need
reshaping:

1. **Mixture of Local Agents** (Part I) — not an ensemble of *models* in one chat
   loop, but an ensemble of **locally installed ACP coding agents** (Claude Code,
   Codex, later others) delegated from the console, with **aggregation by judging
   evidence rather than synthesizing text**. Built in three phases: completion
   contracts + evidence ledger → cross-agent verification matrix → tournament
   delegation.
2. **`/learn`** (Part II) — an **intent-driven front door** on the existing
   distillation pipeline: "distill this now" from a session, directory, or URL,
   routed into the existing review queue. The machinery exists; the entry point
   doesn't.
3. **`/journey`** (Part III) — a **unified learning timeline**: one chronological
   view of everything sessions have taught AgentGem (distilled skills, lessons,
   dream harvests, builds, verifications), with in-place accept/prune. A read-side
   projection over state we already persist.

Cheapest first: Part III is UI over existing data, Part II(a) is an on-demand
invocation of an existing pipeline, Part I is the meat and attacks the evals gap
that gates the share/discovery thesis.

---

# Part I — Mixture of Local Agents

## Motivation

**AgentGem holds a hub position no single agent vendor has.** We already *observe*
many agents (the `SourceSpec`/`AGENT_SOURCES` inbound adapters normalize Cline,
Gemini, Continue, and Cursor transcripts) and *equip* many agents (materialize
targets fan a Gem out to each). Driving several of them is the missing third leg,
and most of the plumbing exists: `runGemWithAgent` drives one ACP agent today,
`AGENT_ADAPTERS` already enumerates a fetch-on-demand roster (`claude`, `codex`),
and the console has a hardened prepare/stream run flow.

**The trust rubric names evals as the committed next gap** — the one that gates the
whole share/discovery thesis. A marketplace whose pitch is trust needs evidence,
per agent, that a Gem does what it claims. "Runs on which agents?" is a question
only a multi-agent hub can answer, and it is exactly the kind of moat data the
aggregator was built to carry.

**Verification shipped, but the contract isn't portable.** `verifyGemRun`
(`packages/run/src/gemVerify.ts`) already does behavior-based verification —
`expectTools` / `expectText` / `forbidToolFailures` over the captured tool-call
trace — and `streamGemRun` already invokes it. But the expectations arrive as
**query params supplied by the UI caller**, so they live and die with one console
session. Nothing travels with the Gem itself: a downloaded Gem cannot tell any
runner what "working" means. Hermes's completion-contract move ("state what done
looks like; judge against evidence, not the model's say-so") is the missing piece,
and for us it has an obvious home: the archive manifest.

**Why judging, not synthesizing.** Hermes MoA aggregates *text*, so it needs an LLM
aggregator. Coding-agent ensembles produce *evidence* — tool traces, diffs, check
results — so our aggregator can be deterministic: cheaper, reproducible, and more
defensible for a trust product. We deliberately do not borrow the LLM-synthesis
step or the "MoA as a selectable model" framing (AgentGem owns no model picker).

## Design

### Phase 1 — completion contracts + evidence ledger

**Contract in the manifest.** Extend `GemManifest`
(`packages/archive/src/archive.ts`) with an optional, JSON-serializable contract:

```ts
interface GemContract {
  // The task prompt a runner should hand the agent to exercise this Gem.
  task: string;
  // Serializable subset of GemExpectations (string-only: no RegExp in the archive).
  expect: {
    tools?: string[];        // → GemExpectations.expectTools
    text?: string;           // → GemExpectations.expectText (substring)
    forbidToolFailures?: boolean; // default true
  };
}

interface GemManifest {
  // ...existing fields...
  contract?: GemContract;
}
```

This mirrors the existing `checks: ManifestCheckEntry[]` precedent (the manifest
already carries verification-adjacent data) and stays within the format's
JSON-friendly discipline. `formatVersion` bumps; readers treat a missing contract
as "not contract-bearing" — no migration needed.

**Authorship.** At build/publish time (Curate → Share flow), derive a default
contract from the Gem's own artifacts — e.g. `expect.tools` seeded with bundled
skill names, `task` templated from the Gem description — and let the publisher edit
it. A derived-but-editable default keeps the publish flow zero-friction while
making contracts near-universal.

**Runner integration.** `POST /api/gem/run/prepare` already materializes the
archive and registers a `runId`; it additionally parses the manifest contract into
the run registry entry. `streamGemRun` then resolves expectations as
**contract-from-archive, overridable by the existing query params** (the params
become a power-user/debug override rather than the only source). `verifyGemRun`
itself is unchanged.

**Evidence ledger.** Every verified run appends one JSONL record to a local,
profile-scoped ledger (same storage conventions as the existing analyze/warm
caches):

```jsonc
{ "ts": "...", "gemName": "...", "gemDigest": "...",
  "agent": "claude", "adapterVersion": "0.51.0",
  "contract": { /* as run */ },
  "run": { "ok": true, "toolCalls": 7 },
  "verification": { /* VerificationReport verbatim */ } }
```

This is Hermes's profile-scoped "verification evidence ledger" + `moa.save_traces`
idea in one file: an append-only substrate that phase 2 aggregates and future evals
replay. The ledger is **local-only by default** and excluded from any share/publish
payload; anything that ever uploads from it goes through the existing
redaction/leak-canary pass first.

### Phase 2 — cross-agent verification (the MoA eval harness)

**Orchestrator.** A new `verifyGemAcrossAgents` in `@agentgem/run`:

```ts
interface AgentVerdict {
  agent: AgentId;
  status: "passed" | "failed" | "unavailable";
  verification?: VerificationReport;   // absent when unavailable
  detail?: string;                     // adapter-resolve error, run error, …
}

async function verifyGemAcrossAgents(
  opts: { gem: Gem; contract: GemContract; roster?: AgentId[] }
): Promise<AgentVerdict[]>
```

For each roster entry it materializes a **fresh, per-agent run dir** (run dirs are
never shared — the prepare step runs once per agent), resolves the adapter via the
existing `resolveOrFetchAdapter`, runs `runGemWithAgent`, and verifies against the
contract. Failures stay data, matching the runner's never-throw discipline:
an unresolvable adapter is `"unavailable"`, a failed run or failed check is
`"failed"` with the report attached.

**Aggregation is deterministic.** The "aggregator" is the verdict list itself —
a compatibility matrix. No LLM in the loop.

**Concurrency.** Default **sequential** with an opt-in bound of 2. Local machines
pay for parallelism in RAM and provider rate limits, the roster is small today,
and sequential keeps per-run resource behavior identical to the shipped
single-agent path. Revisit when the roster grows.

**Console UX.** The run panel grows an "All agents" choice beside the current
single-agent picker. The SSE stream multiplexes by tagging every event with the
agent id (the `done` event already carries `agent`; `phase`/`tool`/`delta` gain
it), and the UI renders **one labelled block per agent** — Hermes's
reference-model-blocks UX, borrowed wholesale: you watch each agent work, then the
matrix lands as the final event.

**Marketplace surface.** The matrix is a new Stone-grade input and renders on the
Explore gem page as per-agent badges backed by ledger evidence. Longer term it
becomes a publish gate ("verified on ≥1 agent to earn ≥Quartz"), which is where
this proposal meets the agentOS one: server-side gating of third-party Gems should
run on the sandboxed backend, not on a maintainer's laptop.

### Phase 3 — tournament delegation (sequenced last, sketch only)

Same arbitrary task fanned to N agents, each in its **own git worktree** (the
repo's existing isolation discipline, applied programmatically), labelled outputs,
and a judge: the contract when one exists, the user picking between diffs when
not. This is the "council of coders" cockpit — genuinely valuable, but it competes
with each agent's native UI, needs diff-collection and cleanup UX that doesn't
exist yet, and without contracts it degrades to N plausible diffs and vibes. It
inherits everything phases 1–2 build; it should not be designed in detail until
they ship.

## Roster and degradation

`AGENT_ADAPTERS` today: `claude` (`claude-agent-acp`) and `codex` (`codex-acp`),
both validated, fetched on demand. The effective roster is *declared ∧ resolvable*;
`"unavailable"` is a first-class matrix value, never an error. The UI must degrade
gracefully to a roster of one — a single-agent machine still gets a one-row matrix
and a ledger entry. New adapters (Gemini CLI speaks ACP natively) join by adding a
validated `AGENT_ADAPTERS` entry; nothing in this design is roster-size-dependent.

## Security considerations

Fan-out multiplies the gem-run surface N-fold, so the hardened properties of the
single-agent path must hold **per run, not per session**:

- **Isolation:** one server-derived run dir per (gem, agent) pair; opaque `runId`s;
  the client never sees a path. Auto-allow stays scoped to the isolated run dir —
  one agent's allowance must not leak to a sibling's.
- **Concurrency cap** (above) doubles as DoS protection for the local machine.
- **Contract text is archive content** — third-party-authored. It is untrusted
  display data in the console (render as text, never HTML) and an untrusted prompt
  to the agent, which is precisely why cross-agent verification of registry Gems
  should prefer the sandboxed backend once adopted.
- **Ledger stays local** and share-excluded by default; redaction runs before any
  future upload path.
- Existing origin-guard/CSRF protections on prepare/stream apply unchanged.

---

# Part II — `/learn`: an intent-driven front door on distillation

## Motivation

Hermes's `/learn <anything>` distills a reusable skill from a directory, a URL, or
"the workflow you just walked me through." AgentGem's distillation is the same idea
with the opposite trigger: **recurrence-driven and retrospective**. `distillWorkflow`
(`@agentgem/insight`) finds n-gram recurrence across transcripts; the warm daemon
and the dreaming REM pass harvest in the background; candidates surface in the
Curate/Dreaming review queues with provenance. Nothing lets a user point at a thing
and say **"learn this, now."**

That entry point matters for the publishing thesis: intent-driven distillation is
how a user *deliberately mints* a Gem to publish to Explore, instead of waiting for
recurrence to notice a pattern. It is the difference between a goldmine you dig and
a goldmine that occasionally erupts.

## Design

**The borrow is the front door, not the pipeline.** One new endpoint feeding the
existing extractor seam and the existing review queue:

```
POST /api/distill/learn
{ "source": { "kind": "session" | "directory" | "url", "ref": "…" } }
```

- **`session`** (phase a, nearly free) — run the existing extractor on one named
  transcript (default: the most recent session) on demand instead of on the warm
  cadence. Same output shape, provenance `{ kind: "learn", source }`.
- **`directory`** (phase b) — scan a directory the user points at (a repo of
  scripts, a docs folder) through the existing capture/introspection machinery and
  distill candidate skills from its contents.
- **`url`** (phase c, last) — fetch a page (a blog post describing a workflow, a
  README) and distill from its text. **Must reuse the SSRF guard** built for
  registry-optional `.gem` install; URL fetching is the reason this phase is
  sequenced last.

**Invariant preserved: nothing lands without accept.** All three routes produce
review-queue items, exactly like dream harvests — `/learn` never writes directly
into a Gem or a target. This keeps the dreaming feature's core promise intact and
means Part II ships with zero new trust surface beyond the URL fetch.

**Input containment.** The `session` and `directory` refs are user-supplied paths
reaching a server endpoint: they must resolve against known roots (transcript dirs
from `resolveDirs`, an explicitly picked folder) and reject anything outside them
with the established `InvalidInputError` → 400 discipline (see
[input containment](../input-containment.md)) — never treat `ref` as a free path.

**Console surface.** A "Distill this…" action in Curate (session picker, folder
picker via the existing `pickFolder`, URL field). CLI parity (`agentgem learn <ref>`)
falls out of the same core function.

**Non-borrow:** Hermes writes learned skills to CONTRIBUTING.md standards
automatically. Our equivalent — the Gem archive format — already exists; no work
needed.

---

# Part III — `/journey`: the unified learning timeline

## Motivation

Hermes's `/journey` shows the memories and skills the agent has accumulated over
time, editable in place; their pitch line — *"your agent's memory stops being a
black box"* — is nearly word-for-word the **observability pillar** of the AgentGem
trust rubric.

AgentGem persists all the ingredients already, scattered across surfaces: the
dreaming diary (harvest and accept/reject history), the Curate queue, distilled
skills with provenance, build/publish history, and (after Part I) the verification
evidence ledger. What's missing is the **single chronological view**: "here is
everything this machine's sessions have taught AgentGem, in order, and what you did
about it." Because dreaming and distillation kept disciplined provenance and a
diary, this is a **read-side projection over existing state — no new pipeline**.

## Design

**One aggregation endpoint:**

```
GET /api/journey?since=…
→ [{ ts, kind: "distilled-skill" | "lesson" | "dream-harvest"
          | "gem-built" | "published" | "verified",
     title, ref, status: "pending" | "accepted" | "dismissed" | "folded" }]
```

sourced by merging, in time order: the dreaming diary, the review queue, distilled
skill provenance, build/publish records, and the Part I evidence ledger (so
cross-agent verification verdicts appear on the same timeline — the three parts of
this proposal meet here).

**Console panel.** A `Journey` panel (`packages/console/src/panels/Journey/`)
rendering the timeline with filters by kind and in-place actions. "Edit/delete"
does not need new mutations: accept/dismiss route to the *existing* queue endpoints
(`/dream/queue/accept`, `/dream/queue/dismiss`); the timeline is a lens, not a new
store. This is also the natural
home for the deferred **"Curate deep-link on skill/lesson accept"** follow-up —
accepting from the timeline deep-links into Curate with the item staged.

**Explicitly not borrowed (yet):** Hermes's desktop radial "memory graph." It's
visual sugar on the same data; the list timeline ships first and the graph can be a
later view over the identical endpoint if it earns its keep.

---

# Sequencing across the borrow set

| Order | Item | Why this order |
|---|---|---|
| 1 | Part III `/journey` panel | Pure read-side UI over existing diary/queue/provenance; high demo value ("watch your goldmine grow"); unblocks the Curate deep-link follow-up |
| 2 | Part II(a) `/learn` on a session | On-demand invocation of the existing extractor; completes the publish story |
| 3 | Part I phase 1 — contracts + ledger | Makes verification portable; small archive + runner change; everything downstream needs it |
| 4 | Part I phase 2 — cross-agent matrix | The flagship; attacks the evals gap; feeds Stone grade and the journey timeline |
| 5 | Part II(b, c) — directory/URL learn | Directory is easy; URL waits on SSRF-guard reuse review |
| 6 | Part I phase 3 — tournament delegation | Needs contracts to judge by; largest new UX surface |

# What we deliberately don't borrow from Hermes

- **LLM aggregation** — our ensemble outputs evidence; judging stays deterministic.
- **MoA as a virtual model/provider** — there is no model picker in AgentGem.
- **In-loop self-improvement forks** — AgentGem's learning loop is artifact-first
  (distill → review → Gem), and stays out-of-loop.
- **The radial memory graph** — timeline first; the graph is a later view if earned.

# Open questions

1. **Contract required at publish?** Derived-default-editable is the plan; whether
   Explore should eventually *require* a contract for grades above Quartz is a
   marketplace policy call.
2. **Verdict freshness.** Verdicts key on `(gemDigest, agent, adapterVersion)` —
   when an adapter major-versions, do old verdicts expire, downgrade, or persist
   with a staleness marker?
3. **Ledger retention.** Append-only JSONL grows forever; size cap vs. time-window
   pruning, and per-profile vs. per-project placement.
4. **`expectText` expressiveness.** The manifest contract is substring-only for
   serializability; is a `textRegex` (string source, compiled at run time) worth
   the injection-surface review it requires?
5. **`/learn` from a URL and licensing.** Distilling a skill from someone else's
   blog post creates a provenance/attribution question the queue item should at
   least record (source URL in provenance is the floor).
6. **Journey panel vs. Curate tab.** A new top-level panel adds IA weight to a
   console that just got a journey-based IA; folding the timeline into Curate is
   the conservative alternative.
7. **One contract per Gem?** A single `task` is a smoke test, not coverage — a Gem
   bundling several skills may want `contracts: GemContract[]` with per-artifact
   scope. Start singular (matrix semantics stay simple: all contracts must pass);
   revisit when a real multi-skill Gem needs it.
