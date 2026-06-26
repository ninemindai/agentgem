# Proposal: Skill distillation from session transcripts

- **Status:** Proposal (draft for review — both H review blockers F1/F2 designed out; see §12)
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

When `retainSequences` is on, accumulate per session a capped, ordered list. Each
step is scrubbed by the **field-aware scrubber** (§3a), which returns both a
coarse `verb` (the safe, low-cardinality procedure token, e.g. `Bash:git commit`)
and a minimal scrubbed `arg`:

```ts
// in the assistant tool_use loop, the `else` branch (currently line 190-192):
} else {
  bumpUnresolved(unresolved, name, "builtin");   // keep — count still useful
  if (opts.retainSequences && seq.length < SEQ_CAP_PER_SESSION) {
    const { verb, arg } = (opts.scrub ?? scrubStep)(name, block.input);
    seq.push({ tool: name, verb, arg });
  }
}
```

Add to `WorkflowSignal` (both gated — empty when the option is off):

```ts
sequences?: {
  root: string;
  sessions: {
    steps: { tool: string; verb: string; arg: string }[];
    missionHint?: { task: string; outcome: string };   // §3b — scrubbed first-user / last-assistant
  }[];
};
// Builtin-aware recurrence — the distillation analogue of `shapes`, computed from
// procedure verbs (NOT resolved inventory), so builtin-only sessions count (§3c).
procedures?: { key: string; verbs: string[]; sessions: number; sampleSessionIdx: number }[];
```

`SEQ_CAP_PER_SESSION` (~40) and a global cap bound prompt size on noisy sessions.
Stays pure/total — a scrubber that throws is caught and the step dropped + noted.

### 3a. The scrubber (resolves review finding F2)

Builtin inputs contain bash commands, absolute paths, file contents, and pasted
secrets. The naive approach — feed `block.input` to `redactMcpConfig` — fails:
it over-redacts (whole-string) yet under-detects (only `>=32`-char/keyword
tokens), so it both destroys the procedure and leaks short secrets, URLs with
`user:pass@host`, and file contents. **You cannot safely scrub arbitrary free
text by blocklist.** So we invert it.

**Field-aware, default-deny extraction.** Instead of scrubbing whatever a tool
sent, `scrubStep(tool, input)` keeps only an allowlisted, structural slice per
known builtin and **drops everything else**. Output is `{ verb, arg }` — a coarse
low-cardinality `verb` for recurrence (§3c) and a minimal scrubbed `arg` for the
agent. Content fields are never retained.

| tool | `verb` | `arg` kept | dropped (default-deny) |
|------|--------|-----------|------------------------|
| `Bash` | `Bash:<argv0> <subcmd>` (e.g. `Bash:git commit`) | command line, **token-scrubbed** + `$HOME`→`~` | — (command is the value; scrub in place) |
| `Read`/`Grep`/`Glob` | `Read` / `Grep` / `Glob` | path/pattern, **path-redacted** | file contents, output |
| `Edit`/`Write`/`NotebookEdit` | `Edit` / `Write` | `file_path`, **path-redacted** | `old_string` / `new_string` / `content` → `<N chars>` |
| `Task`/agent spawns | `Task:<subagent_type>` | `description` (short), token-scrubbed | `prompt` (may carry pasted secrets) |
| anything else | `<ToolName>` | — | entire input |

The three primitives the scrubber composes, in order of safety:
1. **Field allowlist** (above) — the load-bearing defense: unknown fields and all
   content fields are dropped, not scrubbed. Removes the file-contents/PII class
   entirely rather than hoping a regex catches it.
2. **Path redaction** — rewrite `/Users/<u>/…` and other `$HOME` prefixes to `~/…`
   and collapse to a repo-relative or basename form, so paths never carry a
   username.
3. **Token scrub** — a *token-level* (not whole-string) pass over the kept `arg`:
   split on whitespace, replace any token that is high-entropy or matches the
   secret keyword set with `<redacted>`, keeping the surrounding command intact.
   This is `redact.ts`'s detector reused at token granularity — the one piece of
   the existing helper that ports cleanly.

Lives in a new `src/gem/scrub.ts` (not `redact.ts`, which stays the config-value
redactor). Injected as `opts.scrub` for testing; pure/total; on any throw the step
is dropped + noted. Residual risk: a secret pasted *inside* a Bash command that is
neither high-entropy nor keyword-matched (e.g. a 12-char password) can survive in
`arg` — mitigated by truncation, by `arg` being optional to the agent (the `verb`
carries the procedure), and ultimately by the draft-only/human-review gate (§7).

### 3b. Mission orientation: cluster by intent, not just frequency

A "mission" is a session-level notion — *what the user set out to achieve* — but
the current scan is purely statistical: it groups by `shapes` / `coOccurrence`
frequency (`workflowScan.ts:249,262`), which is blind to intent. Two sessions
with the same artifact-set may be different missions; one mission may span several
shapes. To capture *meaningful* Gem candidates we add a light intent signal:

- When `retainSequences` is on, also capture per session a scrubbed **mission
  hint**: the first *genuine* user message (the task statement) and the last
  assistant message (the outcome). Mission text is prose, so it gets the token
  scrub + path redaction + hard truncation (§3a primitives 2–3) — the one place
  free text is retained, kept short and low-detail on purpose.

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
- The generative step receives `{ missionHint, scrubbedSequence, recurrence }`
  per candidate, so it distills the workflow *around the stated goal* rather than
  around a co-occurrence cluster. The **procedure recurrence** (§3c) drives the
  Phase-0 pre-filter (§4) — intent refines what a candidate *means*, recurrence
  decides whether it *recurs*.

This keeps the cheap deterministic gate intact while letting the agent name and
scope each Gem by the mission it accomplished ("ship a sandboxed Gem-run
backend") instead of by its tool fingerprint ("uses Bash + Edit + vitest").

### 3c. Procedure recurrence (resolves review finding F1)

The existing `shapes` / `coOccurrence` signals key on **resolved inventory names**
only — `sessionNames` never includes builtins, so a session that did all its work
in `Bash`/`Edit`/`Read` has `names.size === 0` and is dropped at
`workflowScan.ts:253`. Those are precisely the sessions richest in distillable
procedure. Driving Phase-0 off `shapes` would make distillation fire *only* on
sessions that also happened to use a skill/MCP — defeating the motivation.

Fix: a **separate recurrence signal computed from procedure verbs**, independent
of inventory. For each session with a retained sequence, derive a canonical
`procedureKey` from its ordered `verb` list:

```ts
// collapse consecutive duplicate verbs, drop pure-navigation noise (Read/Grep/Glob
// runs), keep the action spine (Bash verbs, Edit/Write), then join.
function procedureKey(steps: Step[]): string {
  const spine = dedupeConsecutive(steps.map(s => s.verb))
    .filter(v => !/^(Read|Grep|Glob)$/.test(v));
  return spine.join(" > ");           // e.g. "Bash:git checkout > Edit > Bash:vitest > Bash:git commit"
}
```

Group sessions by `procedureKey`, count frequency → `signal.procedures`. This is
the builtin-aware analogue of `shapes`: `{ key, verbs, sessions, sampleSessionIdx }`,
frequency-sorted, capped. Phase-0 (§4) filters on `procedure.sessions`, not
`shape.sessions`.

Cardinality is controlled by the coarse `verb` (`Bash:git commit`, not the full
command), so genuinely-repeated procedures collapse to the same key while one-offs
stay singletons. Exact-key grouping is deliberately simple and may under-cluster
near-identical procedures (`vitest` vs `vitest run`); that is acceptable for a
first cut — the ACP step merges near-duplicates, and a similarity-based clusterer
(shingle + Jaccard) is a noted future refinement, not a blocker.

## 4. Phase-0 viability gate (deterministic pre-filter)

Before spending an ACP call, filter candidate procedures with gbrain/skillify's
Phase-0 gate. Two of its three criteria are deterministic from the signal:

| skillify criterion | deterministic check |
|---|---|
| "Will this be invoked 2+ times?" | `procedure.sessions >= MIN_RECURRENCE` (default 2) — from the builtin-aware `signal.procedures` (§3c), so builtin-only sessions count |
| ">20 lines of logic?" | procedure spine length ≥ `MIN_STEPS` (default ~4 distinct verbs) |
| "clear trigger phrase?" | deferred to the generative step (the agent proposes triggers; a candidate with none is dropped in validation) |

```ts
export function distillCandidates(signal: WorkflowSignal): ProcedureCandidate[] {
  if (!signal.procedures || !signal.sequences) return [];
  return signal.procedures
    .filter(p => p.sessions >= MIN_RECURRENCE)
    .filter(p => p.verbs.length >= MIN_STEPS)
    .map(p => ({                                       // attach one representative scrubbed run + its mission hint
      ...p,
      sample: signal.sequences.sessions[p.sampleSessionIdx],
    }));
}
```

A procedure seen in only one session never reaches the agent. Cheap, principled,
and — unlike the original `shapes`-based gate — fires on the builtin-only sessions
that carry the most procedure (F1).

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

1. `src/gem/scrub.ts` — the field-aware, default-deny `scrubStep(tool, input)`
   returning `{ verb, arg }` (§3a). (tests: per-tool allowlist, content fields
   dropped, path redaction, token scrub leaves command intact, throw → drop)
2. `scanWorkflow` `retainSequences` mode → `sequences` (with `verb`) + per-session
   `missionHint` (§3b) + the builtin-aware `procedures` recurrence signal (§3c)
   on `WorkflowSignal`. (tests: extend `workflowScan.test.ts` — cap, scrub wiring,
   mission-hint extraction skipping wrappers/sidechains, **builtin-only session
   forms a procedure**, total/pure on bad scrubber)
3. `distillCandidates` Phase-0 filter over `signal.procedures` (carries the sample
   run + mission hint through). (tests: recurrence + spine-length thresholds,
   builtin-only procedure passes the gate)
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

| # | Sev | Finding | Status |
|---|-----|---------|--------|
| F1 | **H** | **Builtin-only sessions produce no signal.** `shapes`/`coOccurrence` key on *resolved inventory* names; `workflowScan.ts:253` drops `names.size === 0` sessions — exactly the pure-builtin sessions richest in procedure. Distillation would fire only on sessions that *also* used a skill, defeating the motivation. | **Resolved (§3c).** New `procedures` recurrence signal computed from coarse procedure *verbs*, independent of inventory; Phase-0 (§4) filters on it. Builtin-only sessions now form procedures and pass the gate. |
| F2 | **H** | **Redaction is new surface, not a reuse.** `redactMcpConfig` over-redacts (whole-string) yet under-detects (`>=32`-char/keyword only) on free text; capturing raw `block.input` risks leaking secrets/file-contents into a publishable draft. | **Resolved (§3a).** New field-aware, **default-deny** `scrub.ts`: allowlist a structural slice per builtin, drop all content fields, then path-redact + token-scrub. Removes the file-contents/PII class by construction rather than by blocklist. |
| F3 | **M** | **Mission-hint extraction ≈ wrong on most sessions.** 3/4 sampled main sessions open with `<local-command-caveat>`/`<system-reminder>` wrappers, not a human task. | **Resolved (§3b).** Skip wrappers + `isSidechain` + `isCompactSummary` + `tool_result`-only; tolerate "no mission hint" (procedure-only distill). |
| F4 | **M** | **The new seam is at inventory assembly, not `buildGem`.** `buildGem` resolves names in-memory and throws on miss (`buildGem.ts:39,58`); reads no files. | **Resolved (§7b).** Materialize staged drafts into `ConfigInventory.skills[]` upstream; `buildGem` unchanged. |
| F5 | **M** | **Body is unverifiable.** Evidence-grounding checks `tools[]`, not the prose `body`, which can hallucinate steps. | **Accepted/mitigated (§6, §7).** Draft-only + human-review-before-promote; never auto-promote. A future "verify distilled skill" pass (run body, compare outcome) is the real check — out of scope. |
| F6 | **L** | **Cache has no schema version.** Content-blind `count:mtime` token shadows the new `distilled` field. | **Resolved (§8).** Version the token (`v2:…`). |
| F7 | **L** | **Second ACP run doubles latency/cost.** Analyze is already ~15-20s; a second 60s-timeout run compounds it. | **Open (§11).** Run the two ACP calls concurrently, or gate distillation behind an explicit action. Decision deferred. |

**Net assessment:** the architecture and trust discipline (draft-only,
evidence-grounded validation, degrade-to-empty) are sound. The two H blockers are
now designed out: **F1** via the inventory-independent procedure-recurrence signal
(§3c), and **F2** via the default-deny field-aware scrubber (§3a) that removes the
secret/file-content class structurally instead of by blocklist. F3/F4/F6 are
resolved in-design; F5 is accepted under the draft-only gate; F7 is the only open
performance decision and does not block track 1.
