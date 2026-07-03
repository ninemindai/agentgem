# Trigger Quality — Plan 2A (Trigger-Contract Distillation) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Distill an LLM `TriggerContract` per skill, let the author review/edit it, and thread it into the built Gem via `SkillArtifact.trigger` — the "producing the contract" half of the design's Section 2.

**Architecture:** The contract rides the existing distillation seam. `DistilledSkill` gains an optional `triggerContract`; the ACP `DISTILL` prompt asks for it and `validateDistilled` carries it (LLM path only, never fabricated on the heuristic-skeleton path); `distilledToArtifact` maps it onto `SkillArtifact.trigger` (which the route-confusion runner from Plan 1 already reads). The console `DraftCard` becomes editable so the author sharpens the boundaries before folding.

**Tech Stack:** TypeScript, Zod, Vitest (jsdom for console), pnpm workspaces (`@agentgem/insight`, `@agentgem/capture`, `@agentgem/model`, `@agentgem/console`).

**Spec:** `docs/superpowers/specs/2026-07-02-trigger-quality-design.md` (Section 2). Builds on Plan 1 (`SkillArtifact.trigger?: TriggerContract` already exists).

## Global Constraints

- Node floor `>=24` (repo-wide).
- **Advisory / never-throw**: the LLM path may omit `triggerContract` (LLM unavailable, malformed, or missing the load-bearing fields `intent`+`triggers`); the skill still distills and builds. The heuristic-skeleton path (`extract.ts` `heuristicSkeleton`) **never** fabricates a contract.
- **Additive & backward-compatible**: `triggerContract` is optional everywhere. A `DistilledSkill` without it parses, distills, maps to an artifact (with `trigger` undefined), and persists exactly as today.
- The `TriggerContract` shape is fixed by Plan 1 (`packages/model/src/types.ts`): `{ intent: string; triggers: string[]; antiTriggers: string[]; inputs?: string[]; outputs?: string[] }`.
- **Two hand-synced Zod mirrors** must both gain the field in lockstep: `src/schemas.ts` `DistilledSkillSchema` (line 191) and `packages/console/src/api/routes.ts` `DistilledSkillSchema` (line ~430). A mismatch silently drops the field over the wire.
- Copyright header on any NEW file: `// Copyright (c) 2026 NineMind, Inc.` / `// SPDX-License-Identifier: MIT` (this plan modifies existing files only).
- Test command: `pnpm test` (`tsc -b && vitest run`) for the backend (root `src/**/__tests__/`). The **console** tests are NOT in root CI — run them with `pnpm --filter @agentgem/console test`. The full backend suite has a known pre-existing unrelated `consoleMount` "console not built" failure — ignore it.

## Non-goals (documented follow-ups, not this plan)

- **Reconstituting the contract from disk on the promote path.** `distilledSkillMarkdown` will *persist* the contract into SKILL.md frontmatter (parser-safe — `introspect.ts` `parseFrontmatter` is a regex that reads only `description:`/`internal:` and ignores other keys), but `readSkillsDir` (`packages/capture/src/introspect.ts:55`) will NOT be taught to parse it back into `SkillArtifact.trigger`. The in-memory distilled-drafts build path (`stageDraftsByEvidence` → `distilledToArtifact`) already carries the real contract; disk read-back is a separate format task.
- Route-confusion execution and scorecard rendering (Plan 2B / 2C).

---

### Task 1: Plumb `triggerContract` through the type, both Zod mirrors, and the cache token

**Files:**
- Modify: `packages/insight/src/distillTypes.ts` (add field + import)
- Modify: `src/schemas.ts:191-207` (`DistilledSkillSchema`)
- Modify: `packages/console/src/api/routes.ts` (`DistilledSkillSchema`, ~line 430; add a local `TriggerContractSchema`)
- Modify: `packages/insight/src/distillCache.ts:15-16` (bump token)
- Test: `src/__tests__/schemas.test.ts` (extend)

**Interfaces:**
- Produces: `DistilledSkill.triggerContract?: TriggerContract`; both `DistilledSkillSchema`s validate an optional `triggerContract`.

- [ ] **Step 1: Write the failing test**

Add to `src/__tests__/schemas.test.ts` (it already imports from `../schemas`; merge the import):

```ts
import { DistilledSkillSchema } from "../schemas";

describe("DistilledSkillSchema triggerContract", () => {
  const base = {
    name: "do-x", description: "d", triggers: ["t"], tools: [], mutating: false, body: "b",
    evidence: { sessions: 1, exampleSequence: [], root: "/r", provenance: { occurrences: [] } },
    status: "draft" as const, confidence: "medium" as const, origin: "llm" as const,
  };
  it("parses a distilled skill WITHOUT a trigger contract (backward-compat)", () => {
    const s = DistilledSkillSchema.parse(base);
    expect(s.triggerContract).toBeUndefined();
  });
  it("parses and preserves a trigger contract", () => {
    const s = DistilledSkillSchema.parse({ ...base, triggerContract: { intent: "i", triggers: ["a"], antiTriggers: ["b"] } });
    expect(s.triggerContract?.intent).toBe("i");
    expect(s.triggerContract?.antiTriggers).toEqual(["b"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test`
Expected: FAIL — `triggerContract` stripped by the schema (parsed value is `undefined` in the second case).

- [ ] **Step 3: Add the type field**

In `packages/insight/src/distillTypes.ts`, add the import at the top (with the other imports) and the field to `interface DistilledSkill` (after `origin: "llm" | "heuristic";`):

```ts
import type { TriggerContract } from "@agentgem/model";
```
```ts
  triggerContract?: TriggerContract;
```

- [ ] **Step 4: Extend the server Zod mirror**

In `src/schemas.ts`, add `triggerContract` to `DistilledSkillSchema` (after `origin: z.enum(["llm", "heuristic"]),`, line 206). `TriggerContractSchema` already exists in this file (line 11):

```ts
  triggerContract: TriggerContractSchema.optional(),
```

- [ ] **Step 5: Extend the console Zod mirror**

In `packages/console/src/api/routes.ts`, just above `DistilledSkillSchema`, add a local schema (the console file has no `TriggerContractSchema`), then add the field:

```ts
const TriggerContractSchema = z.object({
  intent: z.string(),
  triggers: z.array(z.string()),
  antiTriggers: z.array(z.string()),
  inputs: z.array(z.string()).optional(),
  outputs: z.array(z.string()).optional(),
});
```
Add inside `DistilledSkillSchema` (after `origin: z.enum(["llm", "heuristic"]),`):
```ts
  triggerContract: TriggerContractSchema.optional(),
```

- [ ] **Step 6: Bump the distill cache token**

In `packages/insight/src/distillCache.ts`, update the comment (line 15) and token (line 16) so caches written before the field aren't misread as "already has a contract":

```ts
// d2 = d1 + optional DistilledSkill.triggerContract.
const TOKEN_VERSION = "d2";
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `pnpm test`
Expected: PASS (both new cases). Then `pnpm --filter @agentgem/console typecheck` — expected: clean (console schema change type-checks).

- [ ] **Step 8: Commit**

```bash
git add packages/insight/src/distillTypes.ts src/schemas.ts packages/console/src/api/routes.ts packages/insight/src/distillCache.ts src/__tests__/schemas.test.ts
git commit -m "feat(insight): plumb optional triggerContract through DistilledSkill + zod mirrors"
```

---

### Task 2: Emit the contract on the ACP LLM distill path

**Files:**
- Modify: `packages/insight/src/distill.ts` (add `parseTriggerContract` helper; call it in `validateDistilled`; extend the `DISTILL` prompt; import `TriggerContract`)
- Test: `src/gem/__tests__/distill.test.ts` (extend the existing `validateDistilled` cases)

**Interfaces:**
- Consumes: raw ACP JSON (`it.triggerContract`).
- Produces: each `validateDistilled` output skill carries `triggerContract` when the raw item has a well-formed one (`intent` non-empty AND ≥1 trigger), else `undefined`. `origin: "heuristic"` skeletons are untouched (no contract).

- [ ] **Step 1: Write the failing test**

In `src/gem/__tests__/distill.test.ts`, find the existing `validateDistilled(...)` test and its `inv`/`candidates` fixtures. Add these cases reusing those fixtures (replace `INV` / `CANDS` with the fixture names already in the file):

```ts
it("carries a well-formed triggerContract from the LLM output", () => {
  const raw = { distilled: [{
    name: "do-x", description: "d", triggers: ["save this"], tools: [], body: "## Contract\nx",
    confidence: "high",
    triggerContract: { intent: "do x", triggers: ["save this"], antiTriggers: ["one-off"] },
  }] };
  const out = validateDistilled(raw, INV, CANDS);
  expect(out[0].triggerContract).toEqual({ intent: "do x", triggers: ["save this"], antiTriggers: ["one-off"] });
});

it("drops a malformed triggerContract (missing intent) to undefined, keeping the skill", () => {
  const raw = { distilled: [{
    name: "do-x", description: "d", triggers: ["save this"], tools: [], body: "## Contract\nx",
    confidence: "high",
    triggerContract: { triggers: ["save this"], antiTriggers: [] },
  }] };
  const out = validateDistilled(raw, INV, CANDS);
  expect(out).toHaveLength(1);
  expect(out[0].triggerContract).toBeUndefined();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test`
Expected: FAIL — `out[0].triggerContract` is `undefined` in the first case (not yet parsed).

- [ ] **Step 3: Add the parser helper**

In `packages/insight/src/distill.ts`, add the model import (merge with the existing `@agentgem/model` import if present) and a helper above `validateDistilled`:

```ts
import type { TriggerContract } from "@agentgem/model";
```
```ts
// Parse a trigger contract out of raw LLM JSON. Never throws, never fabricates:
// requires the load-bearing fields (intent + >=1 trigger) or returns undefined so
// the skill still distills without a contract.
function parseTriggerContract(raw: unknown): TriggerContract | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const o = raw as Record<string, unknown>;
  const intent = typeof o.intent === "string" ? o.intent.trim() : "";
  const strs = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((s): s is string => typeof s === "string" && s.trim().length > 0) : [];
  const triggers = strs(o.triggers);
  if (!intent || !triggers.length) return undefined;
  const contract: TriggerContract = { intent, triggers, antiTriggers: strs(o.antiTriggers) };
  const inputs = strs(o.inputs);
  const outputs = strs(o.outputs);
  if (inputs.length) contract.inputs = inputs;
  if (outputs.length) contract.outputs = outputs;
  return contract;
}
```

- [ ] **Step 4: Carry it in `validateDistilled`**

In the `out.push({ ... })` object inside `validateDistilled` (distill.ts:66-77), add one line (after `origin: "llm",`):

```ts
      triggerContract: parseTriggerContract(it.triggerContract),
```

- [ ] **Step 5: Ask for it in the prompt**

In the `DISTILL` template (distill.ts:97-112), (a) add a bullet after the `body:` line describing the contract, and (b) extend the JSON shape. Replace the `body:` list line and the final `Return ONLY JSON` line:

```ts
  `  body: ## Contract (guarantees) / ## Phases (reproduce the ordered ` +
  `instructions/steps the agent followed) / ## Output Format (the deliverable)\n` +
  `  triggerContract (optional): {intent (one line), triggers (when it SHOULD fire), ` +
  `antiTriggers (adjacent tasks where it must NOT fire)} — omit if you cannot state a clear boundary\n` +
  `DEDUP — do NOT propose a skill that overlaps any installed skill:\n${installedSkillsJson}\n` +
  `Drop a candidate that is one-off, trivial, or has no clear trigger phrase.\n` +
  `MISSIONS + WORKFLOWS (redacted; counts are facts):\n${candidatesJson}\n\n` +
  `Return ONLY JSON: {"distilled":[{"name","description","triggers":[],"tools":[],` +
  `"mutating":bool,"body","confidence":"high"|"medium"|"low",` +
  `"triggerContract":{"intent":"","triggers":[],"antiTriggers":[]}}]}.`;
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm test`
Expected: PASS (both new cases; existing `distill.test.ts` cases still green).

- [ ] **Step 7: Commit**

```bash
git add packages/insight/src/distill.ts src/gem/__tests__/distill.test.ts
git commit -m "feat(insight): distill an optional trigger contract on the LLM path"
```

---

### Task 3: Map the contract onto the artifact and persist it faithfully

**Files:**
- Modify: `packages/capture/src/draftStage.ts` (`distilledToArtifact` line 34; `distilledSkillMarkdown` line 18)
- Test: `src/gem/__tests__/draftStage.test.ts` (extend)

**Interfaces:**
- Consumes: `DistilledSkill.triggerContract` (Task 1).
- Produces: `distilledToArtifact(s).trigger === s.triggerContract`; `distilledSkillMarkdown(s)` includes a `triggerContract:` frontmatter block when present (so `writeDistilledDraft` persists an author's edit rather than silently dropping it). Both are no-ops when the contract is absent.

- [ ] **Step 1: Write the failing test**

Add to `src/gem/__tests__/draftStage.test.ts` (it imports `distilledToArtifact`/`distilledSkillMarkdown`; extend). Reuse the file's existing `DistilledSkill` fixture builder if present, else inline:

```ts
const withContract = {
  name: "do-x", description: "d", triggers: ["t"], tools: [], mutating: false, body: "body",
  evidence: { sessions: 1, exampleSequence: [], root: "/r", provenance: { occurrences: [] } },
  status: "draft" as const, confidence: "medium" as const, origin: "llm" as const,
  triggerContract: { intent: "do x", triggers: ["save"], antiTriggers: ["one-off"] },
};

it("maps triggerContract onto SkillArtifact.trigger", () => {
  expect(distilledToArtifact(withContract).trigger).toEqual(withContract.triggerContract);
});
it("leaves trigger undefined when there is no contract", () => {
  const { triggerContract, ...noContract } = withContract;
  expect(distilledToArtifact(noContract).trigger).toBeUndefined();
});
it("persists the contract into SKILL.md frontmatter", () => {
  const md = distilledSkillMarkdown(withContract);
  expect(md).toContain("triggerContract:");
  expect(md).toContain("intent: do x");
  expect(md).toContain("    - one-off");
});
it("omits the triggerContract block when absent (markdown unchanged)", () => {
  const { triggerContract, ...noContract } = withContract;
  expect(distilledSkillMarkdown(noContract)).not.toContain("triggerContract:");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test`
Expected: FAIL — `.trigger` undefined; markdown lacks `triggerContract:`.

- [ ] **Step 3: Map onto the artifact**

In `packages/capture/src/draftStage.ts`, update `distilledToArtifact` (line 34-36):

```ts
export function distilledToArtifact(s: DistilledSkill): SkillArtifact {
  return { type: "skill", name: s.name, description: s.description, source: "distilled-draft", content: distilledSkillMarkdown(s), trigger: s.triggerContract };
}
```

- [ ] **Step 4: Persist into frontmatter (parser-safe)**

In `distilledSkillMarkdown` (line 18-32), insert the contract block after the `mutating:` line and before the closing `"---"`:

```ts
export function distilledSkillMarkdown(s: DistilledSkill): string {
  return [
    "---",
    `name: ${s.name}`,
    `description: ${s.description}`,
    "triggers:",
    ...s.triggers.map((t) => `  - ${t}`),
    `tools: [${s.tools.join(", ")}]`,
    `mutating: ${s.mutating}`,
    ...(s.triggerContract ? [
      "triggerContract:",
      `  intent: ${s.triggerContract.intent}`,
      "  triggers:",
      ...s.triggerContract.triggers.map((t) => `    - ${t}`),
      "  antiTriggers:",
      ...s.triggerContract.antiTriggers.map((t) => `    - ${t}`),
    ] : []),
    "---",
    "",
    s.body.trim(),
    "",
  ].join("\n");
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm test`
Expected: PASS (all four new cases; existing draftStage cases still green).

- [ ] **Step 6: Commit**

```bash
git add packages/capture/src/draftStage.ts src/gem/__tests__/draftStage.test.ts
git commit -m "feat(capture): map trigger contract to SkillArtifact.trigger + persist in frontmatter"
```

---

### Task 4: Author review — editable Triggers section in `DraftCard`

**Files:**
- Modify: `packages/console/src/panels/Observe/TranscriptViewer.tsx` (`DraftCard`, ~line 197-229)
- Test: `packages/console/src/panels/Observe/TranscriptViewer.test.tsx` (extend)

**Interfaces:**
- Consumes: `DistilledSkill.triggerContract` (now on the console mirror from Task 1).
- Produces: when a draft has a `triggerContract`, `DraftCard` renders editable `intent` / `triggers` / `anti-triggers` fields and POSTs the edited contract via `workflowDraftRoute`. When absent, `DraftCard` is unchanged.

- [ ] **Step 1: Write the failing test**

In `packages/console/src/panels/Observe/TranscriptViewer.test.tsx`, follow the existing "distills … saves a draft" test's `vi.spyOn(routes.workflowDraftRoute, "call")` pattern. Add:

```ts
it("edits the trigger contract and posts the edited draft", async () => {
  const draft = {
    name: "do-x", description: "d", triggers: ["t"], tools: [], mutating: false, body: "b",
    evidence: { sessions: 1, exampleSequence: [], root: "/r", provenance: { occurrences: [] } },
    status: "draft" as const, confidence: "high" as const, origin: "llm" as const,
    triggerContract: { intent: "do x", triggers: ["save"], antiTriggers: [] },
  };
  const spy = vi.spyOn(routes.workflowDraftRoute, "call").mockResolvedValue({ path: "/p" } as any);
  render(<DraftCard apiBase="" draft={draft} />);
  fireEvent.change(screen.getByLabelText("triggers"), { target: { value: "save, share" } });
  fireEvent.click(screen.getByRole("button", { name: /save draft/i }));
  await waitFor(() => expect(spy).toHaveBeenCalled());
  const body = spy.mock.calls[0][1].body;
  expect(body.triggerContract.triggers).toEqual(["save", "share"]);
});
```

(If `DraftCard` is not exported, export it from `TranscriptViewer.tsx` — a named `export function DraftCard` — so the test can mount it directly.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @agentgem/console test`
Expected: FAIL — no `triggers` input; posted body has unedited contract.

- [ ] **Step 3: Make `DraftCard` hold an editable contract**

In `packages/console/src/panels/Observe/TranscriptViewer.tsx`, update `DraftCard`. Add local state for the three fields (comma-separated strings, split on save — mirrors `Publish/index.tsx`), a `splitList` helper, post the rebuilt draft, and render the section. Full replacement of the component:

```tsx
const splitList = (s: string): string[] => s.split(",").map((t) => t.trim()).filter(Boolean);

export function DraftCard({ apiBase, draft }: { apiBase: string; draft: DistilledSkill }) {
  const [open, setOpen] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [intent, setIntent] = useState(draft.triggerContract?.intent ?? "");
  const [triggersRaw, setTriggersRaw] = useState(draft.triggerContract?.triggers.join(", ") ?? "");
  const [antiRaw, setAntiRaw] = useState(draft.triggerContract?.antiTriggers.join(", ") ?? "");

  const save = () => {
    setSaving(true); setErr(null);
    const body: DistilledSkill = draft.triggerContract
      ? { ...draft, triggerContract: { intent: intent.trim(), triggers: splitList(triggersRaw), antiTriggers: splitList(antiRaw) } }
      : draft;
    workflowDraftRoute.call(makeClient(apiBase), { body })
      .then((r) => setSaved(r.path))
      .catch((e) => setErr(String(e?.message ?? e)))
      .finally(() => setSaving(false));
  };

  return (
    <div className="tv-draft">
      <div className="tv-draft-head">
        <span className="tv-draft-name">{draft.name}</span>
        <span className="obs-chip">{draft.confidence}</span>
        {saved
          ? <span className="obs-muted tv-draft-saved">saved → {saved}</span>
          : <button type="button" className="obs-open-transcript" onClick={save} disabled={saving}>{saving ? "Saving…" : "Save draft"}</button>}
      </div>
      <p className="tv-draft-desc">{draft.description}</p>
      {draft.tools.length > 0 && <div className="obs-muted tv-draft-tools">tools: {draft.tools.join(", ")}</div>}
      {draft.triggerContract && (
        <div className="tv-draft-triggers">
          <label>intent <input aria-label="intent" value={intent} onChange={(e) => setIntent(e.target.value)} /></label>
          <label>triggers <input aria-label="triggers" value={triggersRaw} onChange={(e) => setTriggersRaw(e.target.value)} placeholder="comma,separated" /></label>
          <label>anti-triggers <input aria-label="anti-triggers" value={antiRaw} onChange={(e) => setAntiRaw(e.target.value)} placeholder="comma,separated" /></label>
        </div>
      )}
      <button type="button" className="tv-tool-head" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className={"obs-caret" + (open ? " open" : "")}>▸</span> body
      </button>
      {open && <pre className="tv-io">{draft.body}</pre>}
      {err && <span className="obs-error tv-distill-note">{err}</span>}
    </div>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @agentgem/console test`
Expected: PASS. Then `pnpm --filter @agentgem/console typecheck` — expected: clean.

- [ ] **Step 5: Commit**

```bash
git add packages/console/src/panels/Observe/TranscriptViewer.tsx packages/console/src/panels/Observe/TranscriptViewer.test.tsx
git commit -m "feat(console): editable trigger contract review in DraftCard"
```

---

## Self-Review

- **Spec coverage (Section 2 — producing the contract):** LLM emit → Task 2; author review UI → Task 4; folded into `SkillArtifact` on accept → Task 3; "field simply absent when LLM unavailable" → `parseTriggerContract` returns `undefined` (Task 2) + optional everywhere (Task 1). Disk read-back reconstitution is an explicit Non-goal.
- **Placeholder scan:** every step has concrete code/commands. Task 2's test reuses the existing `INV`/`CANDS` fixtures in `distill.test.ts` (named there); Task 4's test reuses the existing `workflowDraftRoute` spy pattern — the deltas (raw JSON, assertions) are given in full.
- **Type consistency:** `triggerContract` (Task 1) is the field name used identically in Tasks 2 (parse), 3 (`distilledToArtifact` maps it to `.trigger`), and 4 (edit). The `TriggerContract` shape matches Plan 1's model type. `distilledToArtifact` sets `trigger:` (the `SkillArtifact` field), not `triggerContract:` — the rename across the seam is intentional and matches `SkillArtifact.trigger?: TriggerContract`.
- **Never-throw:** `parseTriggerContract` requires `intent`+`triggers` or returns undefined; heuristic skeletons never set the field; all schema/artifact fields optional.
