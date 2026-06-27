# Distillation Extractor Seam Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Insert a deterministic `extractCandidates` seam between procedure mining and the LLM distiller, delivering provenance, heuristic-first resilience, precision pre-filtering, and a reflections stream from one well-bounded module.

**Architecture:** A new pure module `src/gem/extract.ts` enriches the existing Phase-0 gated candidates with source provenance, a deterministic skeleton draft, and a prior-confidence label, and emits a second `Reflection[]` stream. `distillWorkflow` consumes the seam and the LLM becomes an *enricher* — when it degrades, the skeletons ship instead of an empty result. Shared types move to `src/gem/distillTypes.ts` to keep `extract.ts` and `distill.ts` acyclic.

**Tech Stack:** TypeScript (NodeNext ESM, `.js` import specifiers), Vitest (compiled — tests authored in `src/**/__tests__/*.test.ts`, run from `dist/`), Zod schemas, existing ACP recommender plumbing.

## Global Constraints

- **Imports use `.js` specifiers** even for `.ts` files (NodeNext ESM). Example: `import { x } from "./distillTypes.js"`.
- **Tests run compiled:** `pnpm test` = `tsc -b && vitest run` over `dist/**/__tests__/**/*.test.js`. Always run `pnpm test` (never `vitest` directly) so the build runs first. After renaming/moving files, the prior `dist/` can hold stale `.js` — if a run looks wrong post-rename, `rm -rf dist && pnpm test`.
- **Privacy boundary:** provenance carries **coordinates only** — `sessionId`, `transcript` (basename), `messageIndices`, `atMs`. **Never** put raw message content into a `Provenance`. The LLM prompt is unchanged and never receives provenance.
- **Totality:** `scanWorkflow`, `extractCandidates`, `distillWorkflow`, and reflection persistence must never throw on bad input — degrade, log, continue.
- **No new vanilla-HTML UI** (React rewrite is pending). Backend data + API payload only.
- **Commits:** end the message with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`. Git identity is `Raymond Feng <raymond@ninemind.ai>` (configure per-commit with `-c user.name=... -c user.email=...` if the worktree identity differs).
- **Branch/worktree:** all work happens in the worktree `../agentgem-distill-seam` on branch `feat/distill-extractor-seam`.

---

## File Structure

- **Create** `src/gem/distillTypes.ts` — shared types: `Occurrence`, `Provenance`, `Reflection`, `GatedCandidate`, `ProcedureCandidate`, `DistilledSkill`. Pure types, no runtime code. Breaks the `extract ↔ distill` cycle.
- **Create** `src/gem/extract.ts` — the seam: `extractCandidates`, `buildProvenance`, `heuristicSkeleton`, `scoreCandidate`, `extractReflections`. Pure, no I/O.
- **Create** `src/gem/reflectionStore.ts` — `writeReflections` sidecar persistence.
- **Modify** `src/gem/workflowScan.ts` — capture `msgIndex` per step; `sessionId`/`transcript`/`atMs` per session; `sessionIdxs` per procedure; export `spineWithIndices`.
- **Modify** `src/gem/distill.ts` — re-export moved types; `distillWorkflow` consumes `extractCandidates` + skeleton fallback; `validateDistilled` stitches pooled provenance + `origin:"llm"`.
- **Modify** `src/gem/acpRecommender.ts` — add `reflections: Reflection[]` to `WorkflowAnalysis` (+ `[]` in both deterministic/validate returns).
- **Modify** `src/gem.controller.ts` + `src/workflowStream.ts` — fold reflections into `gaps`, add `reflections` to the payload, persist the sidecar.
- **Modify** `src/schemas.ts` — extend `DistilledSkillSchema` (`origin`, `evidence.provenance`) and `WorkflowAnalyzeResponseSchema` (`reflections`).
- **Test** `src/gem/__tests__/extract.test.ts` (new); extend `distill.test.ts` and `workflowScan.test.ts`.

---

### Task 1: Shared types module (`distillTypes.ts`)

Move the two types that would otherwise cause an `extract ↔ distill` import cycle into a pure type module, add the new fields, and re-export from `distill.ts` so existing importers (`draftStage.ts`, `acpRecommender.ts`) are untouched.

**Files:**
- Create: `src/gem/distillTypes.ts`
- Modify: `src/gem/distill.ts:6-34` (remove the two interface defs; import + re-export from the new module)

**Interfaces:**
- Consumes: `ProcedureGroup`, `SessionSequence`, `ProcedureStep` from `./workflowScan.js`.
- Produces: `Occurrence`, `Provenance`, `Reflection`, `GatedCandidate`, `ProcedureCandidate`, `DistilledSkill`.

- [ ] **Step 1: Create the types module**

```ts
// src/gem/distillTypes.ts
//
// Shared distillation types. Extracted from distill.ts so that extract.ts (the
// deterministic seam) and distill.ts (the LLM orchestration) can both depend on
// the types WITHOUT depending on each other — the seam carries a
// `skeleton: DistilledSkill` and distill.ts imports `extractCandidates`, which
// would otherwise be a cycle. Pure types; no runtime code.
import type { ProcedureGroup, SessionSequence } from "./workflowScan.js";

// One source location a procedure/reflection was observed at. COORDINATES ONLY —
// never raw message content (privacy boundary). `messageIndices` are JSONL line
// indices within the transcript named by `transcript` (basename).
export interface Occurrence {
  sessionId: string;
  transcript: string;       // basename, not an absolute path
  messageIndices: number[];
  atMs: number;
}
export interface Provenance { occurrences: Occurrence[] }

// A second, non-skill signal: a recurring pattern that is not itself distilled
// into a skill. `recurring-decision` is reserved (see plan Task 6 note) and not
// emitted yet.
export interface Reflection {
  kind: "unresolved-task" | "recurring-pattern" | "recurring-decision";
  detail: string;           // scrubbed, human-readable
  importance: "high" | "medium";
  provenance: Provenance;
}

// A procedure that passed the deterministic Phase-0 gate, with one representative
// scrubbed run (+ its mission hint) attached. This is what `distillCandidates`
// returns — before the seam enriches it.
export interface GatedCandidate extends ProcedureGroup {
  sample: SessionSequence;
}

// A gated candidate enriched by the extractor seam (extract.ts): source
// provenance, a deterministic skeleton draft, and a precision prior.
export interface ProcedureCandidate extends GatedCandidate {
  provenance: Provenance;
  skeleton: DistilledSkill;
  priorConfidence: "high" | "medium" | "low";
}

// A distilled skill: the workflow capture, as a DRAFT. `origin` distinguishes an
// LLM-enriched draft from a deterministic skeleton (heuristic fallback).
export interface DistilledSkill {
  name: string;
  description: string;
  triggers: string[];
  tools: string[];
  mutating: boolean;
  body: string;
  evidence: { sessions: number; exampleSequence: string[]; root: string; provenance: Provenance };
  status: "draft";
  confidence: "high" | "medium" | "low";
  origin: "llm" | "heuristic";
}
```

- [ ] **Step 2: Re-point `distill.ts` at the moved types**

In `src/gem/distill.ts`, delete the `ProcedureCandidate` interface (lines 15-19) and the `DistilledSkill` interface (lines 21-34), and replace the top imports so the names are imported and re-exported:

```ts
// src/gem/distill.ts (top, replacing the two deleted interfaces)
import type { WorkflowSignal, ScanInventory } from "./workflowScan.js";
import { CLAUDE_AGENT, analysisWorkspace, defaultConnectFn, currentTestConnectFn, type AcpConnectFn } from "./acpRecommender.js";
import type { GatedCandidate, ProcedureCandidate, DistilledSkill } from "./distillTypes.js";

// Back-compat re-export: existing importers (draftStage.ts, acpRecommender.ts)
// import these from "./distill.js".
export type { ProcedureCandidate, DistilledSkill } from "./distillTypes.js";
```

> Note: `distillCandidates`'s return type changes from `ProcedureCandidate[]` to `GatedCandidate[]` (it produces the pre-enrichment shape). Update its signature in Step 3.

- [ ] **Step 3: Update `distillCandidates` + `validateDistilled` signatures for the new shapes**

In `src/gem/distill.ts`, change `distillCandidates` to return `GatedCandidate[]`:

```ts
export function distillCandidates(
  signal: WorkflowSignal,
  opts: { minRecurrence?: number; minSteps?: number } = {},
): GatedCandidate[] {
  const minRecurrence = opts.minRecurrence ?? MIN_RECURRENCE;
  const minSteps = opts.minSteps ?? MIN_STEPS;
  const sessions = signal.sequences?.sessions;
  if (!signal.procedures || !sessions) return [];
  return signal.procedures
    .filter((p) => p.sessions >= minRecurrence && p.verbs.length >= minSteps)
    .map((p) => ({ ...p, sample: sessions[p.sampleSessionIdx] }))
    .filter((c): c is GatedCandidate => c.sample !== undefined);
}
```

Change `validateDistilled` to take `ProcedureCandidate[]` (it now reads `.provenance`) and write the new `evidence.provenance` + `origin:"llm"` fields. Replace the body's evidence assembly + push:

```ts
export function validateDistilled(raw: unknown, inv: ScanInventory, candidates: ProcedureCandidate[]): DistilledSkill[] {
  let obj: any = raw;
  if (typeof raw === "string") { try { obj = JSON.parse(extractJson(raw)); } catch { return []; } }
  if (!obj || typeof obj !== "object" || !Array.isArray(obj.distilled)) return [];

  const installed = new Set<string>([
    ...inv.project.skills.map((s) => s.name),
    ...(inv.global?.skills ?? []).map((s) => s.name),
  ]);
  const evidenceTools = new Set<string>();
  for (const c of candidates) for (const st of c.sample.steps) evidenceTools.add(st.tool);
  const evidenceIsMutating = [...evidenceTools].some((t) => MUTATING_TOOL_RE.test(t));
  const sessions = candidates.reduce((m, c) => Math.max(m, c.sessions), 0);
  const exampleSequence = candidates[0]?.verbs ?? [];
  const root = inv.project.root;
  // Pooled provenance: the union of every candidate's occurrences (deduped by
  // sessionId). The LLM output cannot be mapped 1:1 back to a single candidate,
  // so we attach the evidence pool the distillation drew from. (Skeletons, by
  // contrast, carry their own candidate's exact provenance — see extract.ts.)
  const provenance = poolProvenance(candidates);

  const out: DistilledSkill[] = [];
  for (const it of obj.distilled) {
    if (!it || typeof it !== "object") continue;
    if (typeof it.name !== "string" || !KEBAB_RE.test(it.name)) { console.error(`distill: dropping non-kebab name '${it.name}'`); continue; }
    if (installed.has(it.name)) { console.error(`distill: dropping slug colliding with installed skill '${it.name}'`); continue; }
    const triggers = Array.isArray(it.triggers) ? it.triggers.filter((t: unknown): t is string => typeof t === "string" && t.trim().length > 0) : [];
    if (!triggers.length) continue;
    if (typeof it.body !== "string" || !it.body.trim()) continue;
    const tools = Array.isArray(it.tools) ? it.tools.filter((t: unknown): t is string => typeof t === "string") : [];
    if (tools.some((t: string) => !evidenceTools.has(t))) { console.error(`distill: dropping '${it.name}' — fabricated tool not in evidence`); continue; }
    out.push({
      name: it.name,
      description: typeof it.description === "string" ? it.description : "",
      triggers,
      tools,
      mutating: evidenceIsMutating || tools.some((t: string) => MUTATING_TOOL_RE.test(t)),
      body: it.body,
      evidence: { sessions, exampleSequence, root, provenance },
      status: "draft",
      confidence: ["high", "medium", "low"].includes(it.confidence) ? it.confidence : "medium",
      origin: "llm",
    });
  }
  return out;
}

// Union the occurrences of every candidate, deduped by sessionId (first wins).
export function poolProvenance(candidates: { provenance: Provenance }[]): Provenance {
  const seen = new Set<string>();
  const occurrences: Occurrence[] = [];
  for (const c of candidates) for (const o of c.provenance.occurrences) {
    if (seen.has(o.sessionId)) continue;
    seen.add(o.sessionId);
    occurrences.push(o);
  }
  return { occurrences };
}
```

Add to the `distillTypes` import in `distill.ts`: `Provenance`, `Occurrence`.

- [ ] **Step 4: Build to verify the type move compiles**

Run: `cd ../agentgem-distill-seam && pnpm exec tsc -b`
Expected: PASS (no errors). If `dist/` holds stale output from the rename, `rm -rf dist && pnpm exec tsc -b`.

> The existing `distill.test.ts` `validateDistilled` tests (if any pass hand-built candidates) will now fail to typecheck because candidates lack `provenance`. That is fixed in Task 5, Step 1 where those tests gain a `provenance` field. For now, `tsc -b` over `src` (non-test) must pass.

- [ ] **Step 5: Commit**

```bash
cd ../agentgem-distill-seam
git add src/gem/distillTypes.ts src/gem/distill.ts
git -c user.name='Raymond Feng' -c user.email='raymond@ninemind.ai' commit -m "refactor(distill): extract shared types to distillTypes.ts

Move DistilledSkill + ProcedureCandidate out of distill.ts to break the
upcoming extract<->distill import cycle. Add Provenance/Occurrence/Reflection,
GatedCandidate (pre-enrichment) vs ProcedureCandidate (post-seam), and the
new evidence.provenance + origin fields. validateDistilled now stitches pooled
provenance and tags origin:\"llm\".

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Scanner provenance capture (`workflowScan.ts`)

Capture the source coordinates already in hand during the parse: the JSONL line index per step, session id/basename/timestamp per session, and every session index per mined procedure. Export `spineWithIndices` so the seam can map a verb-run back to step line indices.

**Files:**
- Modify: `src/gem/workflowScan.ts` (interfaces at 25-29; spine at 180-189; `mineProcedures` at 204-231; parse loop at 274-357)
- Test: `src/gem/__tests__/workflowScan.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `ProcedureStep.msgIndex: number`; `SessionSequence.sessionId/transcript/atMs`; `ProcedureGroup.sessionIdxs: number[]`; `export function spineWithIndices(steps: ProcedureStep[]): { verb: string; msgIndex: number }[]`.

- [ ] **Step 1: Write the failing test**

Append to `src/gem/__tests__/workflowScan.test.ts`:

```ts
import { spineWithIndices } from "../workflowScan.js";

describe("provenance capture", () => {
  it("spineWithIndices keeps the first step's msgIndex per deduped/nav-filtered verb", () => {
    const steps = [
      { tool: "Read", verb: "Read", arg: "", msgIndex: 3 },        // nav — dropped
      { tool: "Edit", verb: "Edit", arg: "", msgIndex: 5 },
      { tool: "Edit", verb: "Edit", arg: "", msgIndex: 6 },        // consecutive dup — dropped
      { tool: "Bash", verb: "Bash:git commit", arg: "", msgIndex: 9 },
    ];
    expect(spineWithIndices(steps)).toEqual([
      { verb: "Edit", msgIndex: 5 },
      { verb: "Bash:git commit", msgIndex: 9 },
    ]);
  });

  it("mineProcedures records every session index that exercised a procedure", () => {
    const verbs = ["Edit", "Bash:npx vitest", "Bash:git commit"];
    const steps = verbs.map((verb, i) => ({ tool: verb.split(":")[0], verb, arg: "", msgIndex: i }));
    const sessions = [{ steps }, { steps }];
    // mineProcedures is module-private; assert via scanWorkflow in the next test.
    expect(sessions.length).toBe(2);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd ../agentgem-distill-seam && pnpm test -- workflowScan`
Expected: FAIL — `spineWithIndices` is not exported / `msgIndex` not on the step type.

- [ ] **Step 3: Add the fields to the interfaces**

In `src/gem/workflowScan.ts` replace lines 25-29:

```ts
// One captured builtin tool call: the tool name, its scrubbed { verb, arg }, and
// the JSONL line index it was parsed from (provenance coordinate).
export interface ProcedureStep extends ScrubbedStep { tool: string; msgIndex: number }
export interface MissionHint { task: string; outcome: string }
// `sessionId`/`transcript`/`atMs` are provenance coordinates: which transcript a
// run came from and when. `transcript` is a basename, never an absolute path.
export interface SessionSequence { steps: ProcedureStep[]; missionHint?: MissionHint; sessionId: string; transcript: string; atMs: number }
// A recurring procedure (verb spine), the sessions exercising it, a representative
// sample index, and ALL exercising session indices (for provenance fan-out).
export interface ProcedureGroup { key: string; verbs: string[]; sessions: number; sampleSessionIdx: number; sessionIdxs: number[] }
```

- [ ] **Step 4: Refactor the spine helper to carry indices**

In `src/gem/workflowScan.ts` replace `actionSpine` (lines 180-189) with an index-carrying core plus a thin verb-only wrapper (keeps `mineProcedures` behaviour identical, DRY):

```ts
// Action spine WITH source indices: drop consecutive-duplicate verbs and pure
// navigation/inspection steps, keeping each surviving verb's first msgIndex.
export function spineWithIndices(steps: ProcedureStep[]): { verb: string; msgIndex: number }[] {
  const spine: { verb: string; msgIndex: number }[] = [];
  for (const { verb, msgIndex } of steps) {
    const base = verb.split(" ")[0];
    if (NAV_TOOL_RE.test(verb) || BASH_NAV_RE.test(base)) continue;
    if (spine[spine.length - 1]?.verb === verb) continue;
    spine.push({ verb, msgIndex });
  }
  return spine;
}
function actionSpine(steps: ProcedureStep[]): string[] {
  return spineWithIndices(steps).map((e) => e.verb);
}
```

- [ ] **Step 5: Record `sessionIdxs` in `mineProcedures`**

In `src/gem/workflowScan.ts`, in `mineProcedures` (line 222), add `sessionIdxs`:

```ts
  const frequent = [...grams.entries()]
    .map(([key, v]) => ({ key, verbs: v.verbs, sessions: v.sess.size, sampleSessionIdx: [...v.sess][0], sessionIdxs: [...v.sess] }))
    .filter((g) => g.sessions >= MIN_SUPPORT)
    .sort((a, b) => b.verbs.length - a.verbs.length || b.sessions - a.sessions);
```

- [ ] **Step 6: Capture the coordinates in the parse loop**

In `src/gem/workflowScan.ts`:

(a) Index the line loop. Replace line 284 `for (const line of text.split("\n")) {` with:

```ts
    const basename = path.split("/").pop() ?? path;
    let sessionId = "";   // first record's sessionId, else synthesized below
    const lines = text.split("\n");
    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      const line = lines[lineIdx];
```

(b) After the `try { rec = JSON.parse(line); }` block (line 287), capture the session id once:

```ts
      if (!sessionId && typeof rec?.sessionId === "string") sessionId = rec.sessionId;
```

(c) When pushing a step (line 326), add `msgIndex`:

```ts
              try { steps.push({ tool: name, msgIndex: lineIdx, ...scrub(name, block.input) }); }
```

(d) Where the session sequence is assembled (lines 352-356), attach coordinates (synthesize `sessionId` if the transcript had none):

```ts
    if (opts.retainSequences && steps.length > 0) {
      const missionHint: MissionHint | undefined =
        firstUserText !== null ? { task: scrubProse(firstUserText), outcome: scrubProse(lastAssistantText) } : undefined;
      const coords = { sessionId: sessionId || basename.replace(/\.jsonl$/, ""), transcript: basename, atMs: ms };
      seqSessions.push(missionHint ? { steps, missionHint, ...coords } : { steps, ...coords });
    }
```

- [ ] **Step 7: Add a scanWorkflow test that asserts captured coordinates**

Append to `src/gem/__tests__/workflowScan.test.ts` (reuse the file's existing `scanWorkflow` fixtures pattern — write a tiny transcript to a temp file). If the test file already has a transcript-writing helper, use it; otherwise:

```ts
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanWorkflow } from "../workflowScan.js";

it("scanWorkflow stamps sessionId/transcript/atMs and per-step msgIndex", () => {
  const dir = mkdtempSync(join(tmpdir(), "scan-"));
  const file = join(dir, "abc123.jsonl");
  const rows = [
    { sessionId: "sess-1", message: { role: "user", content: "Please ship the auth migration." } },
    { message: { role: "assistant", content: [{ type: "tool_use", name: "Edit", input: { file_path: "/x" } }] } },
    { message: { role: "assistant", content: [{ type: "tool_use", name: "Bash", input: { command: "git commit -m x" } }] } },
  ];
  writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n"));
  const inv = { project: { root: dir, name: "p", skills: [], mcpServers: [], hooks: [], instructions: [] } } as any;
  const sig = scanWorkflow([file], inv, { retainSequences: true });
  const seq = sig.sequences!.sessions[0];
  expect(seq.sessionId).toBe("sess-1");
  expect(seq.transcript).toBe("abc123.jsonl");
  expect(seq.steps.map((s) => s.tool)).toEqual(["Edit", "Bash"]);
  expect(seq.steps.every((s) => typeof s.msgIndex === "number")).toBe(true);
});
```

- [ ] **Step 8: Run to verify all pass**

Run: `cd ../agentgem-distill-seam && pnpm test -- workflowScan`
Expected: PASS. (Existing `workflowScan` tests that build `SessionSequence`/`ProcedureStep` literals will need the new required fields — fix each by adding `sessionId`/`transcript`/`atMs` to session literals and `msgIndex` to step literals. Search the test file for `steps:` and `{ steps }` and update.)

- [ ] **Step 9: Commit**

```bash
cd ../agentgem-distill-seam
git add src/gem/workflowScan.ts src/gem/__tests__/workflowScan.test.ts
git -c user.name='Raymond Feng' -c user.email='raymond@ninemind.ai' commit -m "feat(scan): capture provenance coordinates (msgIndex, sessionId, sessionIdxs)

Stamp each builtin step with its JSONL line index, each session with
sessionId/transcript/atMs, and each mined procedure with every exercising
session index. Export spineWithIndices so the extractor seam can map a verb-run
back to source line indices. Coordinates only — no raw content.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Provenance mapping in the seam (`extract.ts`)

Create `extract.ts` with `buildProvenance` (map a candidate's verb-run back to source line indices across every exercising session) and a first `extractCandidates` that returns gated candidates enriched with provenance only (skeleton + prior added in Task 4).

**Files:**
- Create: `src/gem/extract.ts`
- Test: `src/gem/__tests__/extract.test.ts` (new)

**Interfaces:**
- Consumes: `distillCandidates` (`./distill.js`) → `GatedCandidate[]`; `spineWithIndices` (`./workflowScan.js`); `WorkflowSignal`, `ScanInventory` (`./workflowScan.js`); types from `./distillTypes.js`.
- Produces: `export function buildProvenance(verbs: string[], sessions: SessionSequence[], sessionIdxs: number[]): Provenance`; `export interface ExtractionResult { candidates: ProcedureCandidate[]; reflections: Reflection[] }`; `export function extractCandidates(signal, inv, opts?): ExtractionResult`.

- [ ] **Step 1: Write the failing test**

```ts
// src/gem/__tests__/extract.test.ts
import { describe, it, expect } from "vitest";
import { buildProvenance } from "../extract.js";
import type { SessionSequence } from "../workflowScan.js";

function session(verbs: string[], base: { sessionId: string; transcript: string; atMs: number }): SessionSequence {
  return { ...base, steps: verbs.map((verb, i) => ({ tool: verb.split(":")[0], verb, arg: "", msgIndex: i * 2 })) };
}

describe("buildProvenance", () => {
  it("maps a verb-run to the matching step msgIndices in each exercising session", () => {
    const verbs = ["Edit", "Bash:git commit"];
    const s0 = session(["Read", "Edit", "Bash:git commit"], { sessionId: "a", transcript: "a.jsonl", atMs: 10 });
    const s1 = session(["Edit", "Bash:git commit", "Bash:git push"], { sessionId: "b", transcript: "b.jsonl", atMs: 20 });
    const prov = buildProvenance(verbs, [s0, s1], [0, 1]);
    expect(prov.occurrences).toHaveLength(2);
    expect(prov.occurrences[0]).toMatchObject({ sessionId: "a", transcript: "a.jsonl", atMs: 10 });
    // s0 spine = [Edit(2), Bash:git commit(4)] (Read at msgIndex 0 is nav-dropped)
    expect(prov.occurrences[0].messageIndices).toEqual([2, 4]);
    expect(prov.occurrences[1].messageIndices).toEqual([0, 2]);
  });

  it("skips a session where the run does not occur (no crash)", () => {
    const s0 = session(["Write"], { sessionId: "a", transcript: "a.jsonl", atMs: 1 });
    const prov = buildProvenance(["Edit", "Bash:git commit"], [s0], [0]);
    expect(prov.occurrences).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd ../agentgem-distill-seam && pnpm test -- extract`
Expected: FAIL — `../extract.js` does not exist.

- [ ] **Step 3: Implement `buildProvenance` + provenance-only `extractCandidates`**

```ts
// src/gem/extract.ts
//
// The deterministic extractor seam between procedure mining and the LLM. Takes
// the Phase-0 gated candidates and enriches each with: source provenance, a
// heuristic skeleton draft (Task 4), and a precision prior (Task 4). Also emits
// a second `Reflection[]` stream (Task 6). Pure; no I/O. The LLM (distill.ts)
// becomes an enricher over this output, with the skeleton as the degrade path.
import { distillCandidates } from "./distill.js";
import { spineWithIndices, type WorkflowSignal, type ScanInventory, type SessionSequence } from "./workflowScan.js";
import type { Provenance, Occurrence, ProcedureCandidate, Reflection } from "./distillTypes.js";

export interface ExtractionResult { candidates: ProcedureCandidate[]; reflections: Reflection[] }

// Locate the contiguous verb-run `verbs` inside `spine` and return the source
// msgIndices of the matched positions, or [] if the run is absent.
function locateRun(spine: { verb: string; msgIndex: number }[], verbs: string[]): number[] {
  for (let i = 0; i + verbs.length <= spine.length; i++) {
    let ok = true;
    for (let j = 0; j < verbs.length; j++) if (spine[i + j].verb !== verbs[j]) { ok = false; break; }
    if (ok) return spine.slice(i, i + verbs.length).map((e) => e.msgIndex);
  }
  return [];
}

// Map a procedure's verb-run back to one Occurrence per exercising session.
// Sessions where the run cannot be located contribute nothing (defensive).
export function buildProvenance(verbs: string[], sessions: SessionSequence[], sessionIdxs: number[]): Provenance {
  const occurrences: Occurrence[] = [];
  for (const idx of sessionIdxs) {
    const sess = sessions[idx];
    if (!sess) continue;
    const messageIndices = locateRun(spineWithIndices(sess.steps), verbs);
    if (!messageIndices.length) continue;
    occurrences.push({ sessionId: sess.sessionId, transcript: sess.transcript, messageIndices, atMs: sess.atMs });
  }
  return { occurrences };
}

export function extractCandidates(
  signal: WorkflowSignal,
  inv: ScanInventory,
  opts: { minRecurrence?: number; minSteps?: number } = {},
): ExtractionResult {
  const gated = distillCandidates(signal, opts);
  const sessions = signal.sequences?.sessions ?? [];
  const candidates: ProcedureCandidate[] = gated.map((g) => {
    const provenance = buildProvenance(g.verbs, sessions, g.sessionIdxs ?? [g.sampleSessionIdx]);
    // skeleton + priorConfidence are filled in Task 4; placeholders keep the type
    // total until then. Replaced in the next task — do not ship between tasks.
    return { ...g, provenance, priorConfidence: "medium", skeleton: undefined as unknown as ProcedureCandidate["skeleton"] };
  });
  return { candidates, reflections: [] };
}
```

> The `skeleton` placeholder is replaced in Task 4 Step 3; `extractCandidates` is not consumed by `distillWorkflow` until Task 5, so the placeholder never reaches runtime.

- [ ] **Step 4: Run to verify the `buildProvenance` tests pass**

Run: `cd ../agentgem-distill-seam && pnpm test -- extract`
Expected: PASS (both `buildProvenance` tests).

- [ ] **Step 5: Commit**

```bash
cd ../agentgem-distill-seam
git add src/gem/extract.ts src/gem/__tests__/extract.test.ts
git -c user.name='Raymond Feng' -c user.email='raymond@ninemind.ai' commit -m "feat(extract): provenance mapping in the deterministic seam

buildProvenance maps a procedure verb-run back to per-session source line
indices via spineWithIndices; extractCandidates enriches Phase-0 gated
candidates with that provenance (skeleton + prior follow in the next task).

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Heuristic skeleton + precision prior (`extract.ts`)

Add the deterministic skeleton draft and the precision layer (mission-cue prior + junk filter). After this task `extractCandidates` returns fully-formed `ProcedureCandidate`s.

**Files:**
- Modify: `src/gem/extract.ts`
- Test: `src/gem/__tests__/extract.test.ts`

**Interfaces:**
- Consumes: `ScanInventory` (for installed-slug dedupe), `MUTATING_TOOL_RE` semantics (inline here).
- Produces: `export function heuristicSkeleton(c: GatedCandidate, provenance: Provenance, inv: ScanInventory): DistilledSkill`; `export function scoreCandidate(c: GatedCandidate, minRecurrence: number): "high" | "medium" | "low"`. `extractCandidates` now drops junk candidates and attaches `skeleton` + `priorConfidence`.

- [ ] **Step 1: Write the failing tests**

Append to `src/gem/__tests__/extract.test.ts`:

```ts
import { heuristicSkeleton, scoreCandidate, extractCandidates } from "../extract.js";
import { validateDistilled } from "../distill.js";
import type { GatedCandidate } from "../distillTypes.js";

const inv = { project: { root: "/r", name: "r", skills: [], mcpServers: [], hooks: [], instructions: [] } } as any;

function gated(verbs: string[], opts: Partial<GatedCandidate> = {}): GatedCandidate {
  const steps = verbs.map((verb, i) => ({ tool: verb.split(":")[0], verb, arg: "", msgIndex: i }));
  return {
    key: verbs.join(" > "), verbs, sessions: 2, sampleSessionIdx: 0, sessionIdxs: [0],
    sample: { steps, sessionId: "s", transcript: "s.jsonl", atMs: 0, missionHint: { task: "Ship the auth migration", outcome: "done" } },
    ...opts,
  };
}

describe("heuristicSkeleton", () => {
  it("produces a draft that survives validateDistilled and is grounded", () => {
    const c = gated(["Edit", "Bash:git commit"]);
    const prov = { occurrences: [] };
    const sk = heuristicSkeleton(c, prov, inv);
    expect(sk.origin).toBe("heuristic");
    expect(sk.confidence).toBe("low");
    expect(sk.triggers.length).toBeGreaterThan(0);
    expect(sk.tools).toEqual(["Edit", "Bash"]);
    expect(sk.mutating).toBe(true);                 // Edit/Bash present
    // Round-trip: a skeleton re-validated as if it were agent output must survive.
    const fake = { distilled: [{ name: sk.name, description: sk.description, triggers: sk.triggers, tools: sk.tools, mutating: sk.mutating, body: sk.body, confidence: "low" }] };
    const c2 = { ...c, provenance: prov, skeleton: sk, priorConfidence: "low" as const };
    expect(validateDistilled(fake, inv, [c2])).toHaveLength(1);
  });

  it("dedupes its slug against an installed skill", () => {
    const c = gated(["Edit", "Bash:git commit"]);
    const sk = heuristicSkeleton(c, { occurrences: [] }, inv);
    const invWith = { project: { ...inv.project, skills: [{ name: sk.name }] } } as any;
    const sk2 = heuristicSkeleton(c, { occurrences: [] }, invWith);
    expect(sk2.name).not.toBe(sk.name);
  });
});

describe("scoreCandidate + extractCandidates junk filter", () => {
  it("scores a strong-mission, high-recurrence candidate high", () => {
    expect(scoreCandidate(gated(["Edit", "Bash:git commit"], { sessions: 5 }), 2)).toBe("high");
  });
  it("drops an empty-mission candidate at minimum recurrence", () => {
    const sig = {
      root: "/r", flavor: "claude", sessions: { scanned: 1, firstMs: 0, lastMs: 0, spanDays: 0 },
      artifacts: [], unresolved: [], coOccurrence: [], shapes: [], notes: [],
      sequences: { root: "/r", sessions: [{ steps: [{ tool: "Edit", verb: "Edit", arg: "", msgIndex: 0 }, { tool: "Bash", verb: "Bash:x", arg: "", msgIndex: 1 }, { tool: "Bash", verb: "Bash:y", arg: "", msgIndex: 2 }], sessionId: "s", transcript: "s.jsonl", atMs: 0 }] },
      procedures: [{ key: "k", verbs: ["Edit", "Bash:x", "Bash:y"], sessions: 2, sampleSessionIdx: 0, sessionIdxs: [0] }],
    } as any;
    // No missionHint on the only session → empty-mission + min recurrence → dropped.
    expect(extractCandidates(sig, inv).candidates).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd ../agentgem-distill-seam && pnpm test -- extract`
Expected: FAIL — `heuristicSkeleton`/`scoreCandidate` not exported.

- [ ] **Step 3: Implement skeleton + precision, and finish `extractCandidates`**

Replace the `extractCandidates` body in `src/gem/extract.ts` and add the helpers. Update the imports to add `GatedCandidate`, `DistilledSkill`:

```ts
import type { Provenance, Occurrence, ProcedureCandidate, Reflection, GatedCandidate, DistilledSkill } from "./distillTypes.js";

const MUTATING_TOOL_RE = /^(Bash|Edit|Write|NotebookEdit)$/;
const OUTCOME_CUES = ["shipped", "fixed", "migrated", "merged", "released", "deployed", "done", "resolved"];
const STOPWORDS = new Set(["the", "a", "an", "to", "of", "and", "for", "with", "please", "my", "our", "this", "that", "it"]);

function slugify(text: string): string {
  const slug = text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").split("-").filter((w) => w && !STOPWORDS.has(w)).slice(0, 5).join("-");
  return slug || "workflow";
}

// Unique kebab slug not colliding with any installed skill (append -2, -3, …).
function uniqueSlug(base: string, inv: ScanInventory): string {
  const installed = new Set<string>([...inv.project.skills.map((s) => s.name), ...(inv.global?.skills ?? []).map((s) => s.name)]);
  if (!installed.has(base)) return base;
  for (let n = 2; ; n++) { const cand = `${base}-${n}`; if (!installed.has(cand)) return cand; }
}

// Deterministic draft from the procedure spine + mission hint. Always emits ≥1
// trigger and a non-empty body so it survives validateDistilled.
export function heuristicSkeleton(c: GatedCandidate, provenance: Provenance, inv: ScanInventory): DistilledSkill {
  const task = c.sample.missionHint?.task?.trim() || c.verbs[0] || "workflow";
  const name = uniqueSlug(slugify(task), inv);
  const tools = [...new Set(c.sample.steps.map((s) => s.tool))];
  const mutating = tools.some((t) => MUTATING_TOOL_RE.test(t));
  const phases = c.verbs.map((v, i) => `${i + 1}. ${v}`).join("\n");
  const body = [
    "## Contract", "_Skeleton distilled deterministically — review and flesh out._", "",
    "## Phases", phases, "",
    "## Output Format", "_Describe the deliverable._",
  ].join("\n");
  return {
    name,
    description: c.sample.missionHint ? `${c.sample.missionHint.task} → ${c.sample.missionHint.outcome}`.slice(0, 280) : `Recurring workflow across ${c.sessions} sessions.`,
    triggers: [task.slice(0, 80)],
    tools,
    mutating,
    body,
    evidence: { sessions: c.sessions, exampleSequence: c.verbs, root: inv.project.root, provenance },
    status: "draft",
    confidence: "low",
    origin: "heuristic",
  };
}

// Precision prior: reward a clear mission (task + an outcome cue) and recurrence;
// penalize an empty mission at exactly the minimum recurrence.
export function scoreCandidate(c: GatedCandidate, minRecurrence: number): "high" | "medium" | "low" {
  const mission = c.sample.missionHint;
  const hasTask = !!mission?.task?.trim();
  const hasOutcomeCue = !!mission && OUTCOME_CUES.some((cue) => `${mission.task} ${mission.outcome}`.toLowerCase().includes(cue));
  if (hasTask && hasOutcomeCue && c.sessions > minRecurrence) return "high";
  if (hasTask) return "medium";
  return "low";
}

export function extractCandidates(
  signal: WorkflowSignal,
  inv: ScanInventory,
  opts: { minRecurrence?: number; minSteps?: number } = {},
): ExtractionResult {
  const minRecurrence = opts.minRecurrence ?? 2;
  const gated = distillCandidates(signal, opts);
  const sessions = signal.sequences?.sessions ?? [];
  const candidates: ProcedureCandidate[] = [];
  for (const g of gated) {
    const priorConfidence = scoreCandidate(g, minRecurrence);
    // Junk filter: empty-mission candidates at exactly the floor waste LLM spend.
    if (priorConfidence === "low" && !g.sample.missionHint && g.sessions <= minRecurrence) continue;
    const provenance = buildProvenance(g.verbs, sessions, g.sessionIdxs ?? [g.sampleSessionIdx]);
    const skeleton = heuristicSkeleton(g, provenance, inv);
    candidates.push({ ...g, provenance, priorConfidence, skeleton });
  }
  // Strongest priors first, so a downstream prompt cap keeps the best candidates.
  const rank = { high: 0, medium: 1, low: 2 } as const;
  candidates.sort((a, b) => rank[a.priorConfidence] - rank[b.priorConfidence] || b.sessions - a.sessions);
  return { candidates, reflections: [] };
}
```

- [ ] **Step 4: Run to verify all pass**

Run: `cd ../agentgem-distill-seam && pnpm test -- extract`
Expected: PASS (all `extract` tests).

- [ ] **Step 5: Commit**

```bash
cd ../agentgem-distill-seam
git add src/gem/extract.ts src/gem/__tests__/extract.test.ts
git -c user.name='Raymond Feng' -c user.email='raymond@ninemind.ai' commit -m "feat(extract): heuristic skeleton drafts + precision prior

heuristicSkeleton builds a deterministic, validateDistilled-surviving draft
(name from missionHint, body from the spine, grounded tools, origin:heuristic).
scoreCandidate ranks by mission cues + recurrence; extractCandidates drops
empty-mission floor candidates and sorts by prior so the LLM sees the best N.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Wire the seam into `distillWorkflow` (heuristic-first resilience)

`distillWorkflow` consumes `extractCandidates`; the LLM enriches; on degrade it returns the skeletons (non-empty) instead of `[]`.

**Files:**
- Modify: `src/gem/distill.ts:152-183` (`distillWorkflow`)
- Test: `src/gem/__tests__/distill.test.ts`

**Interfaces:**
- Consumes: `extractCandidates` (`./extract.js`).
- Produces: unchanged signature `distillWorkflow(signal, inv, opts) → { distilled: DistilledSkill[]; degraded: boolean }`, but `degraded:true` may now carry `origin:"heuristic"` skeletons.

- [ ] **Step 1: Fix existing `validateDistilled` test candidates to carry provenance**

In `src/gem/__tests__/distill.test.ts`, any `validateDistilled(...)` call passing hand-built candidates needs each candidate to include `provenance`, `skeleton`, `priorConfidence` (or be typed `as ProcedureCandidate`). Add a helper at the top of that file and use it to wrap the existing sample candidates:

```ts
import type { ProcedureCandidate, GatedCandidate } from "../distillTypes.js";
function enrich(g: GatedCandidate): ProcedureCandidate {
  return { ...g, provenance: { occurrences: [] }, priorConfidence: "medium", skeleton: undefined as any };
}
```

(Where a test calls `validateDistilled(raw, inv, [cand])`, change to `validateDistilled(raw, inv, [enrich(cand)])`.)

- [ ] **Step 2: Write the failing resilience test**

Append to `src/gem/__tests__/distill.test.ts`:

```ts
import { distillWorkflow } from "../distill.js";

const inv = { project: { root: "/r", name: "r", skills: [], mcpServers: [], hooks: [], instructions: [] } } as any;

function signalTwoSessions(): WorkflowSignal {
  const verbs = ["Edit", "Bash:npx vitest", "Bash:git commit"];
  const steps = verbs.map((verb, i) => ({ tool: verb.split(":")[0], verb, arg: "", msgIndex: i }));
  const mk = (id: string) => ({ steps, sessionId: id, transcript: `${id}.jsonl`, atMs: 0, missionHint: { task: "Fix and ship the failing test", outcome: "shipped" } });
  return {
    root: "/r", flavor: "claude", sessions: { scanned: 2, firstMs: 0, lastMs: 0, spanDays: 0 },
    artifacts: [], unresolved: [], coOccurrence: [], shapes: [], notes: [],
    sequences: { root: "/r", sessions: [mk("a"), mk("b")] },
    procedures: [{ key: verbs.join(" > "), verbs, sessions: 2, sampleSessionIdx: 0, sessionIdxs: [0, 1] }],
  } as WorkflowSignal;
}

describe("distillWorkflow resilience", () => {
  it("returns heuristic skeletons (non-empty) when the agent connect fails", async () => {
    const failing = async () => { throw new Error("no creds"); };
    const out = await distillWorkflow(signalTwoSessions(), inv, { connectFn: failing as any });
    expect(out.degraded).toBe(true);
    expect(out.distilled.length).toBeGreaterThan(0);
    expect(out.distilled.every((d) => d.origin === "heuristic")).toBe(true);
    expect(out.distilled[0].evidence.provenance.occurrences.length).toBe(2);
  });

  it("still short-circuits to empty (non-degraded) when nothing clears Phase-0", async () => {
    const empty = { ...signalTwoSessions(), procedures: [], sequences: { root: "/r", sessions: [] } } as WorkflowSignal;
    const out = await distillWorkflow(empty, inv, { connectFn: (async () => { throw new Error("x"); }) as any });
    expect(out).toEqual({ distilled: [], degraded: false });
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `cd ../agentgem-distill-seam && pnpm test -- distill`
Expected: FAIL — current `distillWorkflow` returns `{ distilled: [], degraded: true }` on connect failure.

- [ ] **Step 4: Rewrite `distillWorkflow` to use the seam**

Replace `distillWorkflow` (lines 152-183) in `src/gem/distill.ts`:

```ts
import { extractCandidates } from "./extract.js";

export async function distillWorkflow(
  signal: WorkflowSignal,
  inv: ScanInventory,
  opts: { connectFn?: AcpConnectFn; timeoutMs?: number; minRecurrence?: number; minSteps?: number } = {},
): Promise<{ distilled: DistilledSkill[]; degraded: boolean }> {
  const { candidates } = extractCandidates(signal, inv, opts);
  if (!candidates.length) return { distilled: [], degraded: false };
  const skeletons = candidates.map((c) => c.skeleton);

  const connectFn = opts.connectFn ?? currentTestConnectFn() ?? defaultConnectFn;
  const timeoutMs = opts.timeoutMs ?? 60_000;
  let conn: { ctx: { open(cwd: string): Promise<{ setMode(m: string): Promise<void>; promptText(t: string): Promise<string>; dispose(): void }> }; close: () => void } | null = null;
  let handle: { setMode(m: string): Promise<void>; promptText(t: string): Promise<string>; dispose(): void } | null = null;
  try {
    const prompt = DISTILL(JSON.stringify(candidates.map(trimCandidate)), JSON.stringify(installedSkillNames(inv)));
    const deadline = Date.now() + timeoutMs;
    const left = () => Math.max(0, deadline - Date.now());
    conn = await withTimeout(connectFn(CLAUDE_AGENT, null), left());
    handle = await withTimeout(conn.ctx.open(analysisWorkspace()), left());
    await withTimeout(handle.setMode("plan"), left());
    const text = await withTimeout(handle.promptText(prompt), left());
    const distilled = validateDistilled(text, inv, candidates);
    // The LLM ran but produced nothing usable → fall back to skeletons (degraded).
    if (!distilled.length) return { distilled: skeletons, degraded: true };
    return { distilled, degraded: false };
  } catch (err) {
    console.error("distill: agent unavailable, returning heuristic skeletons:", (err as Error).message);
    return { distilled: skeletons, degraded: true };
  } finally {
    try { handle?.dispose(); } catch { /* ignore */ }
    try { conn?.close(); } catch { /* ignore */ }
  }
}
```

> `trimCandidate` (lines 130-137) reads `c.verbs/c.sessions/c.sample` — all present on `ProcedureCandidate`. No change needed.

- [ ] **Step 5: Run to verify all pass**

Run: `cd ../agentgem-distill-seam && pnpm test -- distill`
Expected: PASS. Then run the full suite: `pnpm test`. Expected: PASS (or only the controller/stream wiring tests from Task 7 outstanding).

- [ ] **Step 6: Commit**

```bash
cd ../agentgem-distill-seam
git add src/gem/distill.ts src/gem/__tests__/distill.test.ts
git -c user.name='Raymond Feng' -c user.email='raymond@ninemind.ai' commit -m "feat(distill): heuristic-first resilience via the extractor seam

distillWorkflow now consumes extractCandidates and treats the LLM as an
enricher. On connect/timeout/junk/empty-validation it returns the deterministic
skeletons (origin:heuristic) instead of an empty result — degraded no longer
means nothing. Phase-0 empty still short-circuits non-degraded.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: Reflections stream + sidecar (`extract.ts`, `reflectionStore.ts`)

Emit `unresolved-task` and `recurring-pattern` reflections from already-captured scan data, and persist them to a sidecar file.

> **Scope note:** `recurring-decision` (sub-`MIN_STEPS` recurring procedures) is in the `Reflection` union for forward-compat but **not emitted** — mining floors at 3-grams (`MIN_GRAM=3`) and the spec puts a new sub-threshold mining pass out of scope. Documented, not a placeholder.

**Files:**
- Modify: `src/gem/extract.ts` (`extractReflections`, called from `extractCandidates`)
- Create: `src/gem/reflectionStore.ts`
- Test: `src/gem/__tests__/extract.test.ts`

**Interfaces:**
- Produces: `export function extractReflections(signal: WorkflowSignal): Reflection[]`; `export function writeReflections(reflections: Reflection[], root: string, base?: string): string | null` (returns the written path, or `null` when there is nothing to write or the write fails — best-effort).

- [ ] **Step 1: Write the failing tests**

Append to `src/gem/__tests__/extract.test.ts`:

```ts
import { extractReflections } from "../extract.js";
import { writeReflections } from "../reflectionStore.js";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function reflSignal(verbs: string[], sessions = 2): any {
  const steps = verbs.map((verb, i) => ({ tool: verb.split(":")[0], verb, arg: "", msgIndex: i }));
  return {
    root: "/r", flavor: "claude", sessions: { scanned: sessions, firstMs: 0, lastMs: 0, spanDays: 0 },
    artifacts: [], unresolved: [], coOccurrence: [], shapes: [], notes: [],
    sequences: { root: "/r", sessions: Array.from({ length: sessions }, (_, i) => ({ steps, sessionId: `s${i}`, transcript: `s${i}.jsonl`, atMs: 0 })) },
    procedures: [{ key: verbs.join(" > "), verbs, sessions, sampleSessionIdx: 0, sessionIdxs: Array.from({ length: sessions }, (_, i) => i) }],
  };
}

describe("extractReflections", () => {
  it("flags repeated edits with no terminal commit/push as unresolved-task", () => {
    const refl = extractReflections(reflSignal(["Edit", "Write", "Bash:npm run build"]));
    expect(refl.some((r) => r.kind === "unresolved-task")).toBe(true);
    expect(refl[0].provenance.occurrences.length).toBeGreaterThan(0);
  });
  it("flags a highly recurrent procedure as recurring-pattern", () => {
    const refl = extractReflections(reflSignal(["Edit", "Bash:npx vitest", "Bash:git commit"], 4));
    expect(refl.some((r) => r.kind === "recurring-pattern")).toBe(true);
  });
});

describe("writeReflections", () => {
  it("writes a sidecar JSON and returns its path", () => {
    const base = mkdtempSync(join(tmpdir(), "refl-"));
    const refl = extractReflections(reflSignal(["Edit", "Write", "Bash:npm run build"]));
    const path = writeReflections(refl, "/some/root", base);
    expect(path).toBeTruthy();
    const parsed = JSON.parse(readFileSync(path!, "utf8"));
    expect(parsed.root).toBe("/some/root");
    expect(Array.isArray(parsed.reflections)).toBe(true);
  });
  it("returns null when there is nothing to persist", () => {
    expect(writeReflections([], "/r", mkdtempSync(join(tmpdir(), "refl-")))).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd ../agentgem-distill-seam && pnpm test -- extract`
Expected: FAIL — `extractReflections` / `reflectionStore` missing.

- [ ] **Step 3: Implement `extractReflections` and call it from `extractCandidates`**

Add to `src/gem/extract.ts`:

```ts
const TERMINAL_RE = /^Bash:git (commit|push)$|^Bash:gh pr/;
const WORK_RE = /^(Edit|Write|NotebookEdit)$/;
const RECURRING_PATTERN_MIN = 3;   // "you do this a lot" threshold (above Phase-0 floor)

// Second stream, derived ONLY from already-mined procedures (no new pass):
//  - unresolved-task: a recurring procedure that does real work (Edit/Write) but
//    never reaches a terminal commit/push/PR verb.
//  - recurring-pattern: a procedure exercised in >= RECURRING_PATTERN_MIN sessions.
export function extractReflections(signal: WorkflowSignal): Reflection[] {
  const procedures = signal.procedures ?? [];
  const sessions = signal.sequences?.sessions ?? [];
  const out: Reflection[] = [];
  for (const p of procedures) {
    const provenance = buildProvenance(p.verbs, sessions, p.sessionIdxs ?? [p.sampleSessionIdx]);
    const doesWork = p.verbs.some((v) => WORK_RE.test(v));
    const reachesTerminal = p.verbs.some((v) => TERMINAL_RE.test(v));
    if (doesWork && !reachesTerminal) {
      out.push({ kind: "unresolved-task", importance: "high",
        detail: `Repeated workflow edits files but never commits/pushes: ${p.verbs.join(" → ")} (${p.sessions} sessions).`, provenance });
    }
    if (p.sessions >= RECURRING_PATTERN_MIN) {
      out.push({ kind: "recurring-pattern", importance: "medium",
        detail: `Frequently repeated flow (${p.sessions} sessions): ${p.verbs.join(" → ")}.`, provenance });
    }
  }
  return out;
}
```

Then change `extractCandidates`'s final return to include reflections:

```ts
  return { candidates, reflections: extractReflections(signal) };
```

- [ ] **Step 4: Implement the sidecar store**

```ts
// src/gem/reflectionStore.ts
//
// Best-effort persistence of the reflections stream. Reflections are a secondary
// signal (not skills), so a write failure must never block analysis — callers
// ignore the return. Written to <base>/.agentgem/reflections/<root-hash>.json.
import { mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { agentgemHome } from "../resolveDir.js";
import type { Reflection } from "./distillTypes.js";

export function writeReflections(reflections: Reflection[], root: string, base: string = agentgemHome()): string | null {
  if (!reflections.length) return null;
  try {
    const dir = join(base, ".agentgem", "reflections");
    mkdirSync(dir, { recursive: true });
    const hash = createHash("sha1").update(root).digest("hex").slice(0, 12);
    const path = join(dir, `${hash}.json`);
    writeFileSync(path, JSON.stringify({ root, reflections }, null, 2), "utf8");
    return path;
  } catch (err) {
    console.error("reflections: sidecar write failed (ignored):", (err as Error).message);
    return null;
  }
}
```

- [ ] **Step 5: Run to verify all pass**

Run: `cd ../agentgem-distill-seam && pnpm test -- extract`
Expected: PASS (reflection + sidecar tests).

- [ ] **Step 6: Commit**

```bash
cd ../agentgem-distill-seam
git add src/gem/extract.ts src/gem/reflectionStore.ts src/gem/__tests__/extract.test.ts
git -c user.name='Raymond Feng' -c user.email='raymond@ninemind.ai' commit -m "feat(extract): reflections stream + best-effort sidecar

extractReflections emits unresolved-task (edits, never committed) and
recurring-pattern (high-recurrence flow) from already-mined procedures, each
with provenance. writeReflections persists them to a sidecar JSON; failures are
swallowed so analysis is never blocked. recurring-decision deferred (needs
sub-3-gram mining, out of scope).

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 7: Wire reflections into the API (gaps + payload + persist + schema)

Surface reflections in the analyze response and SSE `done`, fold high-importance ones into `gaps`, and persist the sidecar. Extend the Zod schemas for the new `DistilledSkill` fields and `reflections`.

**Files:**
- Modify: `src/gem/acpRecommender.ts:33-39,92,180` (`WorkflowAnalysis.reflections`)
- Modify: `src/gem.controller.ts:514-525` (analyze handler)
- Modify: `src/workflowStream.ts:65-80` (SSE done)
- Modify: `src/schemas.ts:155-169,362-372` (schemas)
- Test: extend `src/gem/__tests__/distill.test.ts` (or a small controller-level test if the file exists)

**Interfaces:**
- Consumes: `extractReflections` (`./extract.js`), `writeReflections` (`./reflectionStore.js`), `Reflection` (`./distillTypes.js`).
- Produces: `WorkflowAnalysis.reflections: Reflection[]`; analyze/stream payload field `reflections`.

- [ ] **Step 1: Add `reflections` to `WorkflowAnalysis` + both return sites**

In `src/gem/acpRecommender.ts`:

(a) Add the import: `import type { DistilledSkill, Reflection } from "./distill.js";` → change to also import `Reflection`. Since `Reflection` lives in `distillTypes`, add:
```ts
import type { Reflection } from "./distillTypes.js";
```
(b) Extend the interface (after `distilled`):
```ts
export interface WorkflowAnalysis {
  candidates: GemCandidate[];
  gaps: string[];
  distilled: DistilledSkill[];
  reflections: Reflection[];   // NEW — secondary signal (non-skill)
}
```
(c) `deterministicAnalysis` return (line 92): `return { candidates, gaps, distilled: [], reflections: [] };`
(d) `validateAnalysis` return (line 180): `return { candidates, gaps, distilled: [], reflections: [] };`

> Reflections are produced in the controller/stream (not the recommender), so the recommender returns `[]`; the analyze handler fills the field. This keeps the recommender's single responsibility intact.

- [ ] **Step 2: Extend the Zod schemas**

In `src/schemas.ts`, extend `DistilledSkillSchema` (lines 155-169):

```ts
const ProvenanceSchema = z.object({
  occurrences: z.array(z.object({
    sessionId: z.string(),
    transcript: z.string(),
    messageIndices: z.array(z.number()),
    atMs: z.number(),
  })),
});
export const DistilledSkillSchema = z.object({
  name: z.string(),
  description: z.string(),
  triggers: z.array(z.string()),
  tools: z.array(z.string()),
  mutating: z.boolean(),
  body: z.string(),
  evidence: z.object({
    sessions: z.number(),
    exampleSequence: z.array(z.string()),
    root: z.string(),
    provenance: ProvenanceSchema,
  }),
  status: z.literal("draft"),
  confidence: z.enum(["high", "medium", "low"]),
  origin: z.enum(["llm", "heuristic"]),
});
export const ReflectionSchema = z.object({
  kind: z.enum(["unresolved-task", "recurring-pattern", "recurring-decision"]),
  detail: z.string(),
  importance: z.enum(["high", "medium"]),
  provenance: ProvenanceSchema,
});
```

Add `reflections` to `WorkflowAnalyzeResponseSchema` (after `distilled`, line 365):
```ts
  reflections: z.array(ReflectionSchema),
```

> The `/workflow/draft` write handler accepts a `DistilledSkillSchema` body. Since the UI now round-trips drafts that include `origin` + `evidence.provenance`, the extended schema covers them automatically. No handler change there.

- [ ] **Step 3: Fill reflections in the analyze handler + persist**

In `src/gem.controller.ts`, add imports near line 61:
```ts
import { extractReflections } from "./gem/extract.js";
import { writeReflections } from "./gem/reflectionStore.js";
```
Replace the handler tail (lines 514-525):
```ts
    const [{ analysis, degraded }, distill] = await Promise.all([
      recommendWorkflow(signal, scanInv),
      distillWorkflow(signal, scanInv),
    ]);
    const reflections = extractReflections(signal);
    writeReflections(reflections, root);   // best-effort; ignore the path
    // Fold high-importance reflections into gaps (recommender consumer; no new UI).
    const gaps = [...analysis.gaps, ...reflections.filter((r) => r.importance === "high").map((r) => r.detail)];
    const candidates = analysis.candidates.map((c) => ({ ...c, selection: recommendationToSelection(c) as Record<string, unknown> }));
    return {
      candidates,
      gaps,
      distilled: distill.distilled,
      reflections,
      signalSummary: { sessionsScanned: signal.sessions.scanned, spanDays: signal.sessions.spanDays, notes: signal.notes },
      degraded,
    };
```

- [ ] **Step 4: Mirror it in the SSE stream**

In `src/workflowStream.ts`, add the same imports, then replace lines 70-78:
```ts
    send("phase", { phase: "validating" });
    const reflections = extractReflections(signal);
    writeReflections(reflections, root);
    const gaps = [...analysis.gaps, ...reflections.filter((r) => r.importance === "high").map((r) => r.detail)];
    const candidates = analysis.candidates.map((c) => ({ ...c, selection: recommendationToSelection(c) }));
    const payload = {
      candidates,
      gaps,
      distilled: distill.distilled,
      reflections,
      signalSummary: { sessionsScanned: signal.sessions.scanned, spanDays: signal.sessions.spanDays, notes: signal.notes },
      degraded,
    };
```

- [ ] **Step 5: Write a wiring test**

Append to `src/gem/__tests__/distill.test.ts` (asserts the response shape the controller builds — call the pieces directly, since the controller class needs DI):

```ts
import { extractReflections } from "../extract.js";

describe("analyze wiring", () => {
  it("high-importance reflections fold into gaps", () => {
    const verbs = ["Edit", "Write", "Bash:npm run build"];   // edits, no commit → unresolved-task (high)
    const steps = verbs.map((verb, i) => ({ tool: verb.split(":")[0], verb, arg: "", msgIndex: i }));
    const signal = {
      root: "/r", flavor: "claude", sessions: { scanned: 2, firstMs: 0, lastMs: 0, spanDays: 0 },
      artifacts: [], unresolved: [], coOccurrence: [], shapes: [], notes: [],
      sequences: { root: "/r", sessions: [0, 1].map((i) => ({ steps, sessionId: `s${i}`, transcript: `s${i}.jsonl`, atMs: 0 })) },
      procedures: [{ key: verbs.join(" > "), verbs, sessions: 2, sampleSessionIdx: 0, sessionIdxs: [0, 1] }],
    } as WorkflowSignal;
    const reflections = extractReflections(signal);
    const baseGaps: string[] = [];
    const gaps = [...baseGaps, ...reflections.filter((r) => r.importance === "high").map((r) => r.detail)];
    expect(gaps.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 6: Run the full suite**

Run: `cd ../agentgem-distill-seam && rm -rf dist && pnpm test`
Expected: PASS (clean build after the multi-file changes; all tests green).

- [ ] **Step 7: Commit**

```bash
cd ../agentgem-distill-seam
git add src/gem/acpRecommender.ts src/gem.controller.ts src/workflowStream.ts src/schemas.ts src/gem/__tests__/distill.test.ts
git -c user.name='Raymond Feng' -c user.email='raymond@ninemind.ai' commit -m "feat(api): surface reflections (gaps + payload + sidecar) and provenance schema

Add reflections to WorkflowAnalysis + the analyze/SSE payloads, fold
high-importance reflections into gaps, and persist the sidecar best-effort.
Extend DistilledSkillSchema with origin + evidence.provenance and add
ReflectionSchema so the round-tripped drafts validate.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- §1 Provenance — Task 2 (scanner coords), Task 3 (`buildProvenance`), Task 5 (pooled stitch in `validateDistilled`), Task 7 (schema). ✓ "Jump to source" UI explicitly deferred. ✓
- §2 Heuristic-first resilience — Task 4 (`heuristicSkeleton`), Task 5 (`distillWorkflow` fallback, `origin`). ✓
- §3 Precision — Task 4 (`scoreCandidate`, junk filter, prior sort). ✓
- §4 Reflections — Task 6 (extract + sidecar), Task 7 (gaps + payload). All four sinks: gaps (Task 7), sidecar (Task 6/7), API payload (Task 7), UI deferred. ✓ `recurring-decision` documented as deferred (consistent with spec's "no new mining pass" out-of-scope). ✓
- §7 Boundaries — `distillTypes.ts` (Task 1) resolves the cycle. ✓
- §8 Testing incl. privacy regression — provenance asserted to carry only coordinates across Task 2/3 tests (no `content` field is ever written into `Occurrence`). A dedicated assertion lives in Task 3 (`buildProvenance` returns only `sessionId/transcript/messageIndices/atMs`).

**Placeholder scan:** The only `undefined as any` skeleton placeholder (Task 3 Step 3) is explicitly replaced in Task 4 Step 3 and never consumed at runtime before then (distillWorkflow wires in at Task 5). No `TBD`/`TODO`/"handle errors appropriately".

**Type consistency:** `GatedCandidate` (pre-seam, from `distillCandidates`) vs `ProcedureCandidate` (post-seam, +`provenance`/`skeleton`/`priorConfidence`) used consistently; `validateDistilled` takes `ProcedureCandidate[]`; `poolProvenance`/`buildProvenance` both return `Provenance`; `origin` is `"llm"|"heuristic"` everywhere; `Reflection.kind` union identical in `distillTypes.ts` and `ReflectionSchema`.
