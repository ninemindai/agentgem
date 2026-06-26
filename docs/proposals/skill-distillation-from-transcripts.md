# Proposal: Skill distillation from session transcripts

- **Status:** Proposal (draft for review)
- **Date:** 2026-06-26
- **Area:** workflow-aware Gem recommendation (`src/gem/workflowScan.ts`, `src/gem/acpRecommender.ts`, `src/workflowStream.ts`)
- **Depends on:** the shipped Analyze pipeline (deterministic scan + ACP recommender); see [analyze.md](../analyze.md)
- **Related:** gbrain [`skillify`](https://github.com/garrytan/gbrain/blob/master/skills/skillify/SKILL.md) (rubric borrowed, runtime not adopted); [redaction.md](../redaction.md)

## 1. Motivation

**The unit of value is the Gem: a capture of everything needed to reproduce
achieving a task/mission with a coding agent.** Distillation is not a separate
"author a skill" product — it is the mechanism that makes a *Gem candidate* a
faithful capture of how the mission was actually accomplished.

The gap it fills: today's `GemCandidate` bundles only **installed artifacts that
fired** (skills, MCP servers, hooks, instructions). But the actual work — the
`Bash → Edit → test → commit` procedure that achieved the task — lives in the
builtin tool calls, which the scan discards into `unresolved` as a bare count
(`workflowScan.ts:191`). So a current Gem captures the *tools you had*, not *how
you used them to finish the mission*. For "reproduce achieving this task," that is
the wrong half.

Distillation recovers the discarded procedure, turns it into a draft skill, and
**feeds it back into the Gem candidate** as connective tissue. A meaningful
candidate becomes:

> (artifacts that fired) + (the distilled procedure-skill encoding the steps) + (instructions)

— a bundle that is actually re-runnable, not just a list of tools that were
present. Once a draft skill is accepted it becomes inventory, so the next
analysis recognizes its usage and the loop closes.

### Non-goals
- Not auto-installing skills. Distilled content is unverified by construction; it
  lands as a reviewable draft and is only referenced by a Gem candidate, never
  silently written into `.claude/skills/`.
- Not adopting the gbrain runtime (resolver integration, `check-resolvable`,
  5-dimension cross-modal eval). We borrow gbrain/skillify's **Phase-0 viability
  gate** and **frontmatter/body template** only.
- Not breaking the inventory trust boundary. A distilled skill enters a candidate
  only via the draft mechanism in §2, which makes it a first-class (draft)
  inventory artifact before it can be `include`d.

## 2. Output shape: distilled skills are draft artifacts a Gem references

A distilled skill is the **workflow capture** — its body holds the instructions,
ordered steps, and decision points that achieved the mission, in skillify's
Contract → Phases → Output Format shape. It is the connective tissue that makes a
Gem re-runnable, so it must be *referenceable by a `GemCandidate`*, not stranded
in a parallel track.

The trust-boundary tension (a `GemCandidate.include` name must resolve to real
inventory via `recommendationToSelection`, `acpRecommender.ts:94`) is resolved by
making a distilled skill a **first-class draft artifact** with a real name and
root before any candidate references it. The draft is written/staged (§7), then
the candidate includes it exactly like any other skill — `include[]` stays a list
of resolvable names; the resolver just gains the draft namespace.

```ts
// acpRecommender.ts
export interface DistilledSkill {
  name: string;                 // kebab slug, unique vs installed + other drafts
  description: string;          // one paragraph (skillify frontmatter `description`)
  triggers: string[];          // phrases "a user would actually say" (skillify)
  tools: string[];             // builtin tools the workflow uses (from evidence)
  mutating: boolean;           // does the workflow write/exec? (from evidence)
  // body = the captured workflow: ## Contract (what it guarantees) /
  // ## Phases (the ordered instructions/steps the agent followed) /
  // ## Output Format (the deliverable). This is the mission, codified.
  body: string;
  evidence: {
    sessions: number;          // recurrence count (= shape frequency)
    exampleSequence: string[]; // redacted ordered tool calls, one representative run
    root: string;              // project this was distilled from
  };
  status: "draft";              // never "installed" from this pipeline
  confidence: "high" | "medium" | "low";
}
```

`GemCandidate` is unchanged structurally — a distilled skill referenced by a
candidate appears as a normal `RecommendedItem { type: "skill", name, root }`
once staged. `WorkflowAnalysis` carries the drafts so the UI can show "this Gem
includes 1 newly-distilled skill" and let the user review the body before accept:

```ts
export interface WorkflowAnalysis {
  candidates: GemCandidate[];   // may now reference distilled-draft skills by name
  gaps: string[];               // unchanged
  distilled: DistilledSkill[];  // NEW — the draft bodies the candidates reference
}
```

`deterministicAnalysis` and `validateAnalysis` fallbacks return `distilled: []`
and reference no drafts (distillation has no deterministic fallback — absence is
the safe default; the selective candidate still stands on its own).

## 3. Scan change: opt-in sequence retention

`scanWorkflow` currently reduces builtins to `bumpUnresolved(unresolved, name,
"builtin")` (`workflowScan.ts:191`) — name only, input and order dropped. Add an
**opt-in** mode that retains ordered, redacted builtin calls per session. Opt-in
because it costs memory and touches sensitive content; the selective track never
needs it.

```ts
export interface ScanOptions {
  retainSequences?: boolean;   // default false — selective track stays cheap
  redact?: (input: unknown) => string;  // injected; default = ./redact.ts
}
export function scanWorkflow(paths, inv, opts: ScanOptions = {}): WorkflowSignal
```

When `retainSequences` is on, accumulate per session a capped, ordered list:

```ts
// in the assistant tool_use loop, the `else` branch (currently line 190-192):
} else {
  bumpUnresolved(unresolved, name, "builtin");   // keep — count still useful
  if (opts.retainSequences && seq.length < SEQ_CAP_PER_SESSION) {
    seq.push({ tool: name, arg: (opts.redact ?? redactDefault)(block.input) });
  }
}
```

Add to `WorkflowSignal` (gated — empty when the option is off):

```ts
sequences?: {
  root: string;
  sessions: {
    steps: { tool: string; arg: string }[];
    missionHint?: { task: string; outcome: string };   // §3b — redacted first-user / last-assistant
  }[];
};
```

`SEQ_CAP_PER_SESSION` (~40) and a global cap bound prompt size on noisy sessions.
Stays pure/total — a redactor that throws is caught and the step dropped + noted.

### 3a. Redaction (hard requirement)

Builtin inputs contain bash commands, absolute paths, and pasted secrets. Route
every retained `block.input` through a redactor BEFORE it lands in the signal —
so it is redacted before it ever reaches the ACP agent or a written draft. The
redactor is injected (testable) and defaults to the project redactor.

> **Open risk (verified in review):** `src/gem/redact.ts` exports
> `redactMcpConfig(config)`, which walks a structured object and redacts string
> *values* that are high-entropy (`>=32` chars, `[A-Za-z0-9_-]` only) or sit under
> secret-ish keys. `block.input` is object-shaped, so it *can* be fed through it —
> BUT the fit is poor for transcript content:
> - **Over-redacts**: a multi-word string containing one secret token is replaced
>   *whole* (`<redacted>`), destroying the surrounding command — i.e. the very
>   procedure we are trying to capture (`redact.ts:24-30`).
> - **Under-detects**: misses secrets `<32` chars, secrets with `/ . :` (URLs,
>   `user:pass@host`), file *contents* read into context, and PII in paths.
> This is genuinely new redaction surface — a free-text scrubber, not a reuse of
> the config helper. Resolve before track 1.

### 3b. Mission orientation: cluster by intent, not just frequency

A "mission" is a session-level notion — *what the user set out to achieve* — but
the current scan is purely statistical: it groups by `shapes` / `coOccurrence`
frequency (`workflowScan.ts:249,262`), which is blind to intent. Two sessions
with the same artifact-set may be different missions; one mission may span several
shapes. To capture *meaningful* Gem candidates we add a light intent signal:

- When `retainSequences` is on, also capture per session a redacted **mission
  hint**: the first *genuine* user message (the task statement) and the last
  assistant message (the outcome). Redact via the same redactor path.

> **Open risk (verified against 232 real transcripts for this project):** "first
> user message = the task" is wrong for most sessions. Empirically, 3 of 4 recent
> main sessions begin with a `<local-command-caveat>` wrapper (a slash-command
> invocation), not a human task; others begin with injected `<system-reminder>`
> context. Extraction must skip: `isSidechain` records (sub-agent dispatch prompts,
> e.g. "Security + correctness review of…"), `isCompactSummary` openers (a
> continuation's summary, not the original goal), `tool_result`-only user
> messages, and local-command / system-reminder wrappers — then take the first
> real human turn, which **may not exist** in fully command-driven sessions. A
> session with no recoverable mission hint should still distill (sequence only),
> just without intent framing. Note `claudeTranscriptsForCwd` already excludes the
> nested `subagents/` dir (non-recursive `readdirSync`), so most sidechains never
> reach the scan — but defensively filtering `isSidechain` is still required.
- The generative step receives `{ missionHint, redactedSequence, recurrence }`
  per candidate, so it distills the workflow *around the stated goal* rather than
  around a co-occurrence cluster. The frequency `shapes` still drive the Phase-0
  pre-filter (§4) — intent refines what a candidate *means*, frequency decides
  whether it *recurs*.

This keeps the cheap deterministic gate intact while letting the agent name and
scope each Gem by the mission it accomplished ("ship a sandboxed Gem-run
backend") instead of by its tool fingerprint ("uses Bash + Edit + vitest").

## 4. Phase-0 viability gate (deterministic pre-filter)

Before spending an ACP call, filter candidate procedures with gbrain/skillify's
Phase-0 gate. Two of its three criteria are deterministic from the signal:

| skillify criterion | deterministic check |
|---|---|
| "Will this be invoked 2+ times?" | `shape.sessions >= MIN_RECURRENCE` (default 2) — this is already a fact in `signal.shapes` |
| ">20 lines of logic?" | retained sequence length ≥ `MIN_STEPS` (default ~4 distinct steps) |
| "clear trigger phrase?" | deferred to the generative step (the agent proposes triggers; a candidate with none is dropped in validation) |

```ts
export function distillCandidates(signal: WorkflowSignal): ShapeCandidate[] {
  if (!signal.sequences) return [];
  return signal.shapes
    .filter(s => s.sessions >= MIN_RECURRENCE)
    .map(s => attachSequences(s, signal.sequences))   // representative redacted run
    .filter(c => c.steps.length >= MIN_STEPS);
}
```

A shape with `sessions: 1` never reaches the agent. Cheap, principled, and reuses
data the scan already produces.

> **Open risk (see review):** `signal.shapes` keys on *resolved inventory
> artifacts* only — a session that did its work entirely in builtins
> (`Bash`/`Edit`/`Read`) produces an **empty** shape and is dropped at
> `workflowScan.ts:253`. Those are precisely the sessions richest in distillable
> procedure. The Phase-0 recurrence signal therefore needs a builtin-aware shape
> key, or distillation will mostly fire on sessions that *also* used skills/MCP.

## 5. Generative ACP step

A SECOND ACP run, distinct from the existing `GROUNDING` recommender
(`acpRecommender.ts:178`). Same plan-mode / permission-deny / timeout plumbing
(`recommendWorkflow`, `acpRecommender.ts:220`), different prompt and validation.

The prompt:
- receives the Phase-0-passing `ShapeCandidate[]`, each carrying its redacted
  sequence, recurrence count, and **mission hint** (§3b: the task statement +
  outcome) so the workflow is distilled *around the stated goal*,
- receives the **installed-skill names as a negative constraint** — the dedup
  rule. This is skillify's "no MECE overlap" expressed against our inventory: do
  not propose a skill that duplicates an installed one.
- is told to name/scope each skill by the mission it accomplished, and to emit
  **skillify-shaped frontmatter** + a Contract → Phases → Output Format body where
  the Phases section reproduces the ordered instructions/steps the agent followed.

```ts
const DISTILL = (candidatesJson, installedSkillsJson) =>
  `You distill the WORKFLOW a coding agent used to accomplish a mission into a ` +
  `reusable skill. Each candidate carries: a mission hint (the task the user set ` +
  `out to do + the outcome), an ordered redacted sequence of tool calls, and how ` +
  `many sessions it recurred across.\n` +
  `Name and scope each skill by the MISSION it accomplished — not by its tool ` +
  `fingerprint. For each genuinely reusable workflow, emit a skill with:\n` +
  `  frontmatter: name (kebab), description (one paragraph), triggers (phrases a ` +
  `user would actually type), tools (from the sequence), mutating (bool)\n` +
  `  body: ## Contract (guarantees) / ## Phases (reproduce the ordered ` +
  `instructions/steps the agent followed) / ## Output Format (the deliverable)\n` +
  `DEDUP — do NOT propose a skill that overlaps any installed skill:\n${installedSkillsJson}\n` +
  `Drop a candidate that is one-off, trivial, or has no clear trigger phrase.\n` +
  `MISSIONS + WORKFLOWS (redacted; counts are facts):\n${candidatesJson}\n\n` +
  `Return ONLY JSON: {"distilled":[{"name","description","triggers":[],"tools":[],` +
  `"mutating":bool,"body","confidence":"high"|"medium"|"low"}]}.`;
```

Run it alongside the existing recommender. Either run failing degrades only its
own track (selective failure → deterministic candidates; distill failure →
`distilled: []`). Never throws.

## 6. Validation of distilled output

A distilled skill CANNOT be validated against the inventory (that is the point) —
so validation shifts to **shape + evidence-grounding** instead of name-matching:

1. Structural: required frontmatter fields present, `name` is a valid kebab slug,
   `triggers` non-empty (enforces skillify's third Phase-0 criterion), `body`
   non-empty.
2. Slug uniqueness: `name` must NOT collide with an installed skill — a hard drop
   (the dedup boundary; a collision means the agent ignored the negative
   constraint).
3. Evidence-grounding: every tool in `tools[]` must actually appear in that
   candidate's redacted sequence. Drops fabricated tools, mirroring how
   `validateAnalysis` drops hallucinated inventory names (`acpRecommender.ts:159`).
4. `mutating` cross-check: if the sequence contains `Bash`/`Edit`/`Write`, force
   `mutating: true` regardless of what the agent claimed (conservative default).

Any candidate failing 1–3 is dropped (logged). Zero survivors → `distilled: []`.

> **Open risk (see review):** evidence-grounding checks the *tool list*, not the
> *body*. The body is free-form agent prose and can hallucinate steps that never
> happened or leak redacted-but-reconstructed detail. Body content is unverifiable
> by construction — which is the strongest argument for §7's draft-only,
> human-review-before-promote stance, and against ever auto-promoting.

## 7. Draft-write / review flow

Distilled skills surface as **drafts**, never installed:

- The `workflowStream.ts` payload (built at `workflowStream.ts:67`) gains
  `distilled` next to `candidates` / `gaps`.
- Accepting a draft writes `SKILL.md` to a review location (e.g.
  `.agentgem/distilled/<name>/SKILL.md`), NOT directly into `.claude/skills/`.
  The user edits, then promotes it themselves.
- Once promoted into the project inventory, the next `introspect` + `scanWorkflow`
  sees it as a real skill — the selective track then tracks its usage. Loop closed.

This is the agentgem-native equivalent of the gstack `skillify` / `learn` flow
(codify a live success into a skill), but retrospective and transcript-driven.

### 7b. The one new seam: stage drafts INTO the inventory (not into buildGem)

For a `GemCandidate` to `include` a distilled skill before it is installed (§2),
the name must resolve. **Correction after code review:** `buildGem` does not read
files — it resolves every selected name against the in-memory `ConfigInventory`
(`inventory.skills.find(s => s.name === n)`) and **throws if absent**
(`buildGem.ts:39,58`). So the seam is *not* inside `buildGem` and `buildGem`
needs **no change**.

The correct, more contained seam is **upstream, at inventory assembly**: a staged
draft under `.agentgem/distilled/<name>/SKILL.md` must be materialized into a
`GemArtifact` of `type: "skill"` and merged into the `ConfigInventory` (the
project's `skills[]`) that the controller passes to `buildGem`. A distilled draft
is otherwise an ordinary skill artifact (name + body), so once merged it flows
through the existing path untouched — including the `secretRefs` re-redaction
guard at `buildGem.ts:79` (skills carry no config, so they pass through). Drafts
the user never promotes simply expire; the candidate that referenced one is
regenerated on the next analysis. This keeps `buildGem`'s "unknown name → throw"
invariant intact for every non-draft name.

## 8. Caching

`analysisCache.ts` keys on the transcript token `${count}:${maxMtime}`
(`analysisCache.ts:16-20`) and stores an opaque `result` — there is **no schema
version field** to bump. Since the token is content-blind, a project analyzed
before distillation existed will hit its old cache entry (no `distilled`) until
its transcripts change. Fix by versioning the token itself — prefix it, e.g.
`v2:${count}:${maxMtime}` — so the rollout invalidates stale entries. Cache write
also stamps `Date.now()` (`workflowStream.ts:73`), unchanged.

## 9. What we borrow from gbrain/skillify vs. leave behind

Borrow (portable, no runtime dependency):
- Phase-0 viability gate → §4 deterministic pre-filter.
- Frontmatter template (`name/description/triggers/tools/mutating`) + body
  shape (Contract/Phases/Output Format) → §2 type + §5 prompt.
- "No MECE overlap" dedup → §5 negative constraint + §6 slug-uniqueness drop.

Leave behind (gbrain-specific overhead):
- Resolver integration / `check-resolvable`.
- `scripts/*.ts` deterministic extraction.
- 5-dimension cross-modal eval + test-locking. (A future "verify distilled skill"
  step could revisit this, but it is out of scope here.)

## 10. Build sequence

1. Redaction: a free-text transcript scrubber (NOT a reuse of `redact.ts`'s
   config-value redactor — see §3a). (tests)
2. `scanWorkflow` `retainSequences` mode → `sequences` + per-session `missionHint`
   (§3b) on `WorkflowSignal`, with a builtin-aware shape key (§4 risk). (tests:
   extend `workflowScan.test.ts` — cap, redaction, mission-hint extraction,
   builtin-only sessions, total/pure on bad redactor)
3. `distillCandidates` Phase-0 filter (carries mission hint through). (tests:
   recurrence + step thresholds)
4. `DistilledSkill` type (`status: "draft"`) + `distilled: []` in both fallbacks.
5. `DISTILL` prompt + second ACP run wired into `recommendWorkflow` (or a sibling
   `distillWorkflow`). (tests: extend `acpRecommender.test.ts` with fake agent)
6. Distilled validation (`validateDistilled`). (tests: drop fabricated tools,
   slug collision, missing triggers)
7. Resolver draft namespace (§7b) so a candidate can `include` a staged draft.
   (tests: `buildGem` resolves a draft `SKILL.md`; unknown name still errors)
8. `workflowStream` payload (`distilled` + candidate→draft references) + cache
   version bump.
9. Draft-write/stage handler to `.agentgem/distilled/<name>/SKILL.md`.

Tracks 1–6 are pure/total and unit-testable with no live agent. The ACP wiring
reuses the existing `setConnectFnForTests` seam (`acpRecommender.ts:63`).

## 11. Open questions for review
- One ACP run emitting both tracks, or two independent runs? (Two = cleaner
  failure isolation + smaller prompts; one = half the agent latency.) Leaning two.
- `MIN_RECURRENCE` default — 2 (skillify's literal threshold) or higher to cut
  noise on chatty projects?
- Draft location — `.agentgem/distilled/` vs. surfacing in the Lapidary Ledger UI
  for in-place review before any file is written.

## 12. Review findings (deep review, verified against code + real transcripts)

Severity: **H** blocks track 1 · **M** changes the design · **L** polish.

| # | Sev | Finding | Resolution |
|---|-----|---------|------------|
| F1 | **H** | **Builtin-only sessions produce no signal.** `shapes` (and `coOccurrence`) only key on *resolved inventory* names; `workflowScan.ts:253` drops sessions with `names.size === 0`. The sessions richest in distillable procedure (pure `Bash`/`Edit`/`Read` work) are exactly the ones with no skill/MCP, so they never form a shape and never reach Phase-0. As written, distillation mostly fires only on sessions that *also* used a skill — defeating the motivation. | Add a **builtin-aware shape key** (include retained-sequence signature), or drive Phase-0 off the sequences directly, not off `shapes`. |
| F2 | **H** | **Redaction is new surface, not a reuse.** `redactMcpConfig` over-redacts (whole-string) and under-detects (`>=32`-char/keyword only) on free text — see §3a. Capturing raw `block.input` + mission text without a real scrubber risks leaking secrets into a draft skill that may later be published. | Build a free-text scrubber first (track 1); treat `redact.ts` as defense-in-depth, not the primary. |
| F3 | **M** | **Mission-hint extraction ≈ wrong on most sessions.** 3/4 sampled main sessions open with `<local-command-caveat>`/slash-command or `<system-reminder>` wrappers, not a human task — see §3b. Naive "first user message" captures boilerplate. | Skip wrappers + `isSidechain` + `isCompactSummary` + `tool_result`-only; tolerate "no mission hint" (sequence-only distill). |
| F4 | **M** | **The new seam is at inventory assembly, not `buildGem`.** `buildGem` resolves names in-memory and throws on miss (`buildGem.ts:39,58`); it reads no files. §7b originally mislocated the change. | Materialize staged drafts into the `ConfigInventory.skills[]` upstream; `buildGem` unchanged (corrected in §7b). |
| F5 | **M** | **Body is unverifiable.** Evidence-grounding checks `tools[]`, not the prose `body`, which can hallucinate steps or reconstruct redacted detail (§6). | Reinforces draft-only + human-review-before-promote; never auto-promote. A future "verify distilled skill" pass (run the body, compare outcome) is the real check. |
| F6 | **L** | **Cache has no schema version.** Token is content-blind `count:mtime`; old entries shadow the new `distilled` field until transcripts change (§8). | Version the token (`v2:…`). |
| F7 | **L** | **Second ACP run doubles latency/cost.** Analyze is already ~15-20s (`analysisCache.ts` header); a second 60s-timeout agent run compounds it. | Run the two ACP calls concurrently; or gate distillation behind an explicit "distill" action rather than every Analyze. |

**Net assessment:** the architecture is sound and the trust-boundary discipline
(draft-only, evidence-grounded validation, degrade-to-empty) is right. F1 and F2
are real blockers that must be designed out before track 1 — F1 because the
feature would silently under-fire on its best inputs, F2 because it is a
secret-leak path into a publishable artifact. F3-F7 are tractable within the
existing design.
