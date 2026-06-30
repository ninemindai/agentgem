# Insights → Playbook → Explore Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Contribute to explore" flow that turns an Insights project into a reviewed 📓 Playbook Gem published to the registry/explore catalog plus a social share card.

**Architecture:** Reuse existing distill (`distillWorkflow` + `distillSessionLessons`), gem-build (`buildGem`), cut-derivation (`GemTypeRegistry`, Playbook auto-derives from a `distilled-draft` skill), workspace-publish (`/api/registry/publish`), and share (`createShareCard`). New code is thin orchestration: a server endpoint that distills+persists a project's wins/lessons, a combined publish+share endpoint, and the Insights/Curate UI to drive review then publish.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), vitest (runs compiled `dist/**/__tests__/**/*.test.js` — build with `pnpm exec tsc -b` before running), zod, AgentBack `@post`/`@get` controllers, React 19 console panels, `@agentback/client` `defineRoute`.

## Global Constraints

- Privacy: only **distilled artifacts** (coordinates-only provenance) publish — never raw transcripts, goals, or friction prose. Inherit the distill model; add no new content exposure.
- Account-bound publishing is **deferred**: `scope` stays caller-supplied; `publishedBy` is already server-resolved from the session cookie (do not change it).
- Cut is **auto-derived** — do NOT hardcode `type: "playbook"`; let `resolvePublishType` derive it (a distilled-draft skill ⇒ playbook). Tests assert the derivation.
- Tests inject all agent/network deps (no real `claude-agent-acp`, no real GitHub registry). vitest runs from `dist/`.
- Commit messages end with: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`. Author identity is the repo default (Raymond Feng <raymond@ninemind.ai>).

---

### Task 1: `buildPlaybookGem` — assemble a Playbook Gem from distilled artifacts

Pure assembly: stage distilled skills + lessons into an inventory and build a Gem that auto-classifies as `playbook`. No agent, no network — the testable core.

**Files:**
- Create: `packages/insight/src/playbookDraft.ts`
- Modify: `packages/insight/src/index.ts` (add `export * from "./playbookDraft.js";`)
- Test: `src/gem/__tests__/playbookDraft.test.ts`

**Interfaces:**
- Consumes: `distilledToArtifact`/`lessonToArtifact` semantics via `stageDraftsByEvidence`/`stageLessonsByEvidence` from `@agentgem/capture`; `buildGem` from `@agentgem/build`; `deriveCut`/`BUILTIN_CUTS` from `@agentgem/model`; types `DistilledSkill`, `DistilledLesson` from `@agentgem/insight`; `ConfigInventory` from `@agentgem/model`.
- Produces: `export function buildPlaybookGem(args: { name: string; baseInventory: ConfigInventory; skills: DistilledSkill[]; lessons: DistilledLesson[]; createdFrom?: string }): { gem: Gem; selection: GemSelection }` — the staged inventory's Gem (a `playbook` cut) and the selection that reproduces it.

- [ ] **Step 1: Write the failing test**

```typescript
// src/gem/__tests__/playbookDraft.test.ts
import { describe, it, expect } from "vitest";
import { buildPlaybookGem } from "@agentgem/insight";
import { deriveCut, BUILTIN_CUTS } from "@agentgem/model";
import type { DistilledSkill, DistilledLesson } from "@agentgem/insight";

const emptyInv = { skills: [], mcpServers: [], instructions: [], hooks: [] };
const skill = (name: string): DistilledSkill => ({
  name, description: "d", triggers: ["t"], tools: ["Bash"], mutating: false, body: "## Contract\n",
  evidence: { sessions: 2, exampleSequence: [], root: "/r", provenance: { occurrences: [] } },
  status: "draft", confidence: "high", origin: "llm",
});
const lesson = (name: string): DistilledLesson => ({
  name, body: "Always verify before publishing.", importance: "high", status: "draft",
  evidence: { sessions: 1, root: "/r", provenance: { occurrences: [] } },
});

describe("buildPlaybookGem", () => {
  it("assembles a gem from distilled skills + lessons that derives to the playbook cut", () => {
    const { gem, selection } = buildPlaybookGem({
      name: "my-playbook", baseInventory: emptyInv, skills: [skill("ship-loop")], lessons: [lesson("verify-first")],
    });
    expect(gem.name).toBe("my-playbook");
    expect(gem.artifacts.some((a) => a.type === "skill")).toBe(true);
    expect(gem.artifacts.some((a) => a.type === "instructions")).toBe(true);
    expect(deriveCut(BUILTIN_CUTS, gem)).toBe("playbook"); // a distilled-draft skill ⇒ playbook
    expect(selection.skills).toContain("ship-loop");
  });

  it("returns a skill-only gem (no lessons) that still derives to playbook", () => {
    const { gem } = buildPlaybookGem({ name: "p", baseInventory: emptyInv, skills: [skill("a")], lessons: [] });
    expect(deriveCut(BUILTIN_CUTS, gem)).toBe("playbook");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec tsc -b && pnpm exec vitest run dist/gem/__tests__/playbookDraft.test.js`
Expected: FAIL — `buildPlaybookGem` is not exported.

- [ ] **Step 3: Write minimal implementation**

```typescript
// packages/insight/src/playbookDraft.ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Assemble a Playbook Gem from distilled wins (skills) + lessons (instructions).
// Staging makes distilled drafts visible to buildGem; the resulting gem carries a
// skill with source "distilled-draft" so GemTypeRegistry derives the playbook cut.
import type { ConfigInventory, Gem, GemSelection } from "@agentgem/model";
import { stageDraftsByEvidence, stageLessonsByEvidence } from "@agentgem/capture";
import { buildGem } from "@agentgem/build";
import type { DistilledSkill, DistilledLesson } from "./distillTypes.js";

export function buildPlaybookGem(args: {
  name: string; baseInventory: ConfigInventory; skills: DistilledSkill[]; lessons: DistilledLesson[]; createdFrom?: string;
}): { gem: Gem; selection: GemSelection } {
  const staged = stageLessonsByEvidence(stageDraftsByEvidence(args.baseInventory, args.skills), args.lessons);
  const selection: GemSelection = {
    skills: args.skills.map((s) => s.name),
    includeInstructions: args.lessons.length > 0,
  };
  const gem = buildGem(staged, selection, { name: args.name, createdFrom: args.createdFrom ?? "claude" });
  return { gem, selection };
}
```

Add to `packages/insight/src/index.ts`:
```typescript
export * from "./playbookDraft.js";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec tsc -b && pnpm exec vitest run dist/gem/__tests__/playbookDraft.test.js`
Expected: PASS (2 tests). If `selection`/`includeInstructions` shape mismatches `buildGem`, inspect `packages/build/src/buildGem.ts` and align — instructions are a `includeInstructions` boolean, lessons stage as instructions on the inventory.

- [ ] **Step 5: Commit**

```bash
git add packages/insight/src/playbookDraft.ts packages/insight/src/index.ts src/gem/__tests__/playbookDraft.test.ts
git commit -m "feat(insight): buildPlaybookGem — assemble a playbook gem from distilled wins+lessons

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: `POST /api/playbook/prepare` — distill + persist a project's playbook draft

Scans a project, distills wins + lessons, persists them so they appear as inventory artifacts the user can review, and returns their names. Reuses the `/inspect/distill` pattern.

**Files:**
- Modify: `src/gem.controller.ts` (add the endpoint near `inspectDistill` ~line 316; reuse its inventory/scan setup)
- Modify: `src/schemas.ts` (add `PlaybookPrepareBodySchema`, `PlaybookPrepareResponseSchema`)
- Test: `src/gem/__tests__/playbookPrepare.test.ts` (controller-level with injected distill deps)

**Interfaces:**
- Consumes: `distillWorkflow`, `distillSessionLessons` (`@agentgem/insight`); `writeDistilledDraft`, `writeDistilledLesson` (`@agentgem/capture`); the controller's existing scan/inventory setup.
- Produces: response `{ skills: string[]; lessons: string[]; root: string; degraded: boolean }` (names of persisted distilled artifacts).

- [ ] **Step 1: Write the failing test** — drive the controller method with a fake scan/distill seam (mirror existing controller tests; inject a deps object or stub `distillWorkflow`/`distillSessionLessons` via the controller's seam). Assert: persisted skill+lesson names returned; `degraded` reflects the distill result; persistence functions called.

```typescript
// src/gem/__tests__/playbookPrepare.test.ts — sketch the contract; mirror the
// nearest existing gem.controller test for the harness (injected deps + a temp HOME).
import { describe, it, expect } from "vitest";
import { preparePlaybook } from "../playbookPrepareCore.js"; // pure core extracted below
import type { DistilledSkill, DistilledLesson } from "@agentgem/insight";

describe("preparePlaybook (core)", () => {
  it("persists distilled skills + lessons and returns their names", async () => {
    const skills: DistilledSkill[] = [{ name: "ship-loop", description: "d", triggers: ["t"], tools: ["Bash"], mutating: false, body: "x", evidence: { sessions: 2, exampleSequence: [], root: "/r", provenance: { occurrences: [] } }, status: "draft", confidence: "high", origin: "llm" }];
    const lessons: DistilledLesson[] = [{ name: "verify-first", body: "verify", importance: "high", status: "draft", evidence: { sessions: 1, root: "/r", provenance: { occurrences: [] } } }];
    const written: string[] = [];
    const r = await preparePlaybook({
      root: "/r",
      distill: async () => ({ skills, lessons, degraded: false }),
      persistSkill: (s) => { written.push(`skill:${s.name}`); },
      persistLesson: (l) => { written.push(`lesson:${l.name}`); },
    });
    expect(r).toEqual({ skills: ["ship-loop"], lessons: ["verify-first"], root: "/r", degraded: false });
    expect(written).toEqual(["skill:ship-loop", "lesson:verify-first"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec tsc -b && pnpm exec vitest run dist/gem/__tests__/playbookPrepare.test.js`
Expected: FAIL — `playbookPrepareCore.js` not found.

- [ ] **Step 3: Write minimal implementation**

Extract a pure core (testable without the controller), then wire the endpoint to it.

```typescript
// src/playbookPrepareCore.ts
import type { DistilledSkill, DistilledLesson } from "@agentgem/insight";
export interface PreparePlaybookDeps {
  root: string;
  distill: () => Promise<{ skills: DistilledSkill[]; lessons: DistilledLesson[]; degraded: boolean }>;
  persistSkill: (s: DistilledSkill) => void;
  persistLesson: (l: DistilledLesson) => void;
}
export async function preparePlaybook(deps: PreparePlaybookDeps): Promise<{ skills: string[]; lessons: string[]; root: string; degraded: boolean }> {
  const { skills, lessons, degraded } = await deps.distill();
  for (const s of skills) deps.persistSkill(s);
  for (const l of lessons) deps.persistLesson(l);
  return { skills: skills.map((s) => s.name), lessons: lessons.map((l) => l.name), root: deps.root, degraded };
}
```

Schemas in `src/schemas.ts`:
```typescript
export const PlaybookPrepareBodySchema = z.object({ root: z.string() });
export const PlaybookPrepareResponseSchema = z.object({ skills: z.array(z.string()), lessons: z.array(z.string()), root: z.string(), degraded: z.boolean() });
```

Endpoint in `src/gem.controller.ts` (reuse `inspectDistill`'s scan/inventory setup verbatim; build a `signal` via `scanWorkflow([root...], scanInv, { retainSequences: true })`):
```typescript
@post("/playbook/prepare", { body: PlaybookPrepareBodySchema, response: PlaybookPrepareResponseSchema })
async playbookPrepare(input: { body: z.infer<typeof PlaybookPrepareBodySchema> }): Promise<z.infer<typeof PlaybookPrepareResponseSchema>> {
  const root = input.body.root;
  // ... build scanInv + signal exactly as inspectDistill does (lines ~316-330) ...
  return preparePlaybook({
    root,
    distill: async () => {
      const [w, l] = await Promise.all([distillWorkflow(signal, scanInv), distillSessionLessons(signal, scanInv)]);
      return { skills: w.distilled, lessons: l.lessons, degraded: w.degraded || l.degraded };
    },
    persistSkill: (s) => { writeDistilledDraft(s); },
    persistLesson: (l) => { writeDistilledLesson(l); },
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec tsc -b && pnpm exec vitest run dist/gem/__tests__/playbookPrepare.test.js`
Expected: PASS. Then `pnpm exec tsc -b` to confirm the controller compiles.

- [ ] **Step 5: Commit**

```bash
git add src/playbookPrepareCore.ts src/schemas.ts src/gem.controller.ts src/gem/__tests__/playbookPrepare.test.ts
git commit -m "feat(api): POST /api/playbook/prepare — distill+persist a project's playbook draft

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: `POST /api/playbook/publish` — publish workspace to registry + mint share card

One combined action over a workspace already saved from the reviewed selection: registry-publish (cut auto-derives to playbook) AND create a gem share card.

**Files:**
- Create: `src/playbookPublishCore.ts` (pure orchestration over injected publish + share fns)
- Modify: `src/gem.controller.ts` (endpoint), `src/schemas.ts` (schemas)
- Test: `src/gem/__tests__/playbookPublish.test.ts`

**Interfaces:**
- Consumes: the existing `registryPublish` handler body (`{ workspace, scope, name?, version, description?, tags? }` — omit `type`, let it derive) and `createShareCard(db, { kind: "gem", name, provenance, generatedAtMs })`.
- Produces: `export async function publishPlaybookCore(deps: { publish: () => Promise<{ ref: string; version: string }>; share: () => Promise<{ id: string; url: string }> }): Promise<{ exploreRef: string; version: string; shareUrl: string }>`.

- [ ] **Step 1: Write the failing test**

```typescript
// src/gem/__tests__/playbookPublish.test.ts
import { describe, it, expect } from "vitest";
import { publishPlaybookCore } from "../playbookPublishCore.js";

describe("publishPlaybookCore", () => {
  it("publishes to the registry AND mints a share card, returning both refs", async () => {
    const calls: string[] = [];
    const r = await publishPlaybookCore({
      publish: async () => { calls.push("publish"); return { ref: "@me/my-playbook", version: "1.0.0" }; },
      share: async () => { calls.push("share"); return { id: "abc", url: "https://agentgem.ai/share/abc" }; },
    });
    expect(r).toEqual({ exploreRef: "@me/my-playbook", version: "1.0.0", shareUrl: "https://agentgem.ai/share/abc" });
    expect(calls).toEqual(["publish", "share"]);
  });

  it("still returns the explore ref if the share card fails (publish is the data-critical leg)", async () => {
    const r = await publishPlaybookCore({
      publish: async () => ({ ref: "@me/p", version: "1.0.0" }),
      share: async () => { throw new Error("share down"); },
    });
    expect(r).toMatchObject({ exploreRef: "@me/p", shareUrl: "" }); // share is best-effort
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec tsc -b && pnpm exec vitest run dist/gem/__tests__/playbookPublish.test.js`
Expected: FAIL — `playbookPublishCore.js` not found.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/playbookPublishCore.ts
export async function publishPlaybookCore(deps: {
  publish: () => Promise<{ ref: string; version: string }>;
  share: () => Promise<{ id: string; url: string }>;
}): Promise<{ exploreRef: string; version: string; shareUrl: string }> {
  const pub = await deps.publish();                  // data-critical: must succeed
  let shareUrl = "";
  try { shareUrl = (await deps.share()).url; } catch { /* best-effort teaser */ }
  return { exploreRef: pub.ref, version: pub.version, shareUrl };
}
```

Schemas in `src/schemas.ts`:
```typescript
export const PlaybookPublishBodySchema = z.object({
  workspace: z.string(), scope: z.string(), name: z.string().optional(), version: z.string(),
  description: z.string().optional(), tags: z.array(z.string()).optional(), provenance: z.string(),
});
export const PlaybookPublishResponseSchema = z.object({ exploreRef: z.string(), version: z.string(), shareUrl: z.string() });
```

Endpoint in `src/gem.controller.ts` (reuse `this.registryPublish` internals + `createShareCard(this.db, ...)`):
```typescript
@post("/playbook/publish", { body: PlaybookPublishBodySchema, response: PlaybookPublishResponseSchema })
async playbookPublish(input: { body: z.infer<typeof PlaybookPublishBodySchema> }): Promise<z.infer<typeof PlaybookPublishResponseSchema>> {
  const b = input.body;
  return publishPlaybookCore({
    publish: async () => {
      const r = await this.registryPublish({ body: { workspace: b.workspace, scope: b.scope, name: b.name, version: b.version, description: b.description, tags: b.tags } });
      return { ref: r.ref, version: r.version };
    },
    share: async () => createShareCard(this.db, { kind: "gem", name: b.name ?? b.workspace, provenance: b.provenance, generatedAtMs: Date.now() }),
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec tsc -b && pnpm exec vitest run dist/gem/__tests__/playbookPublish.test.js`
Expected: PASS (2 tests). `pnpm exec tsc -b` confirms the controller compiles (imports: `createShareCard`).

- [ ] **Step 5: Commit**

```bash
git add src/playbookPublishCore.ts src/schemas.ts src/gem.controller.ts src/gem/__tests__/playbookPublish.test.ts
git commit -m "feat(api): POST /api/playbook/publish — registry publish + share card in one action

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Console routes + Insights "Contribute to explore" button

Wire the console: routes for prepare/publish, and the Insights report button that starts the flow (prepare → hand off to Curate with the distilled draft pre-selected).

**Files:**
- Modify: `packages/console/src/api/routes.ts` (add `playbookPrepareRoute`, `playbookPublishRoute`)
- Modify: `packages/console/src/pendingAnalyze.ts` (carry an optional playbook draft, not just a root)
- Modify: `packages/console/src/panels/Insights/index.tsx` (the button)
- Test: `packages/console/src/pendingAnalyze.test.ts` (extend), `packages/console/src/panels/Insights/InsightsReportCard.test.tsx` (button present)

**Interfaces:**
- Consumes: `defineRoute`/`makeClient`; the new endpoints' schemas (mirror server zod).
- Produces: `playbookPrepareRoute`, `playbookPublishRoute`; `setPendingPlaybook(draft)` / `consumePendingPlaybook()` in `pendingAnalyze.ts` where `draft = { root: string; skills: string[]; lessons: string[] }`.

- [ ] **Step 1: Write the failing test** — extend `pendingAnalyze.test.ts`:

```typescript
import { setPendingPlaybook, consumePendingPlaybook } from "./pendingAnalyze.js";
it("hands a playbook draft from Insights to Curate exactly once", () => {
  setPendingPlaybook({ root: "/r", skills: ["a"], lessons: ["b"] });
  expect(consumePendingPlaybook()).toEqual({ root: "/r", skills: ["a"], lessons: ["b"] });
  expect(consumePendingPlaybook()).toBeNull();
});
```

- [ ] **Step 2: Run to verify it fails**

Run (console pkg): `pnpm exec vitest run src/pendingAnalyze.test.ts`
Expected: FAIL — `setPendingPlaybook` not exported.

- [ ] **Step 3: Implement** — add to `pendingAnalyze.ts`:

```typescript
export interface PendingPlaybook { root: string; skills: string[]; lessons: string[] }
let pendingPlaybook: PendingPlaybook | null = null;
export function setPendingPlaybook(d: PendingPlaybook): void { pendingPlaybook = d; }
export function consumePendingPlaybook(): PendingPlaybook | null { const d = pendingPlaybook; pendingPlaybook = null; return d; }
```

Add routes to `packages/console/src/api/routes.ts` (mirror the server schemas):
```typescript
export const playbookPrepareRoute = defineRoute("POST", "/api/playbook/prepare", {
  body: z.object({ root: z.string() }),
  response: z.object({ skills: z.array(z.string()), lessons: z.array(z.string()), root: z.string(), degraded: z.boolean() }),
});
export const playbookPublishRoute = defineRoute("POST", "/api/playbook/publish", {
  body: z.object({ workspace: z.string(), scope: z.string(), name: z.string().optional(), version: z.string(), description: z.string().optional(), tags: z.array(z.string()).optional(), provenance: z.string() }),
  response: z.object({ exploreRef: z.string(), version: z.string(), shareUrl: z.string() }),
});
```

In `InsightsReportCard` (Insights `index.tsx`), add a button in the "Worth publishing" head (only when `onBuild` is set — i.e. a single project, not "All projects"). It calls prepare, then stores the draft + navigates to Curate:
```tsx
{onContribute && <button type="button" className="ledger-build" onClick={onContribute}>Contribute to explore →</button>}
```
Define `onContribute` in `Insights` next to `generate`, passed like `onBuild`, only for `r.path !== "*"`:
```tsx
onContribute={r.path === "*" ? undefined : async () => {
  const { skills, lessons } = await playbookPrepareRoute.call(makeClient(apiBase), { body: { root: r.path } });
  setPendingPlaybook({ root: r.path, skills, lessons });
  window.location.hash = "#/curate";
}}
```

- [ ] **Step 4: Run tests to verify they pass**

Run (console): `pnpm exec vitest run src/pendingAnalyze.test.ts src/panels/Insights/ && pnpm run typecheck`
Expected: PASS; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add packages/console/src/api/routes.ts packages/console/src/pendingAnalyze.ts packages/console/src/pendingAnalyze.test.ts packages/console/src/panels/Insights/index.tsx packages/console/src/panels/Insights/InsightsReportCard.test.tsx
git commit -m "feat(console): Insights 'Contribute to explore' button + playbook routes/hand-off

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Curate review + "Publish to explore" action

Curate consumes the playbook draft, pre-selects the distilled artifacts for review, and offers a "Publish to explore" action that saves a workspace from the reviewed selection then calls `playbookPublishRoute`.

**Files:**
- Modify: `packages/console/src/panels/Curate/index.tsx` (consume the playbook draft; pre-select; add the publish action)
- Create: `packages/console/src/panels/Curate/PublishToExplore.tsx` (the scope/version/name form + result; reuses `createWorkspaceRoute` then `playbookPublishRoute`)
- Test: `packages/console/src/panels/Curate/PublishToExplore.test.tsx`

**Interfaces:**
- Consumes: `consumePendingPlaybook()`; `createWorkspaceRoute` (existing); `playbookPublishRoute`; `buildSelection`/`activeGem` (existing Curate selection state).
- Produces: a reviewed-then-published Playbook; UI surfaces `{ exploreRef, shareUrl }`.

- [ ] **Step 1: Write the failing test** — render `PublishToExplore` with injected route clients; fill scope+version; click Publish; assert it (a) creates a workspace from the selection, (b) calls publish with that workspace, (c) renders the explore ref + share link. (Mirror `Workspaces.test.tsx` render-with-fetch-stub harness.)

- [ ] **Step 2: Run to verify it fails**

Run (console): `pnpm exec vitest run src/panels/Curate/PublishToExplore.test.tsx`
Expected: FAIL — component not found.

- [ ] **Step 3: Implement**
  - In Curate `index.tsx` `useEffect`, also `consumePendingPlaybook()`: if present, `setKeys(new Set([...skills.map(k => selKey("skills", k))]))`, set `includeInstructions` view, switch to compose, and reveal `<PublishToExplore>`.
  - `PublishToExplore.tsx`: inputs for `scope` (placeholder, interim — note "account-binding coming"), `version` (default `1.0.0`), `name`, `provenance` (auto: "distilled from N sessions"). On submit: `createWorkspaceRoute.call(..., { body: { name, selection: buildSelection(selected) } })` then `playbookPublishRoute.call(..., { body: { workspace: name, scope, name, version, provenance } })`; render `exploreRef` + `shareUrl` (copyable).

- [ ] **Step 4: Run tests to verify they pass**

Run (console): `pnpm exec vitest run src/panels/Curate/ && pnpm run typecheck`
Expected: PASS; typecheck clean. Then root `pnpm exec tsc -b && pnpm exec vitest run` for backend regression (incl. Tasks 1-3).

- [ ] **Step 5: Commit**

```bash
git add packages/console/src/panels/Curate/index.tsx packages/console/src/panels/Curate/PublishToExplore.tsx packages/console/src/panels/Curate/PublishToExplore.test.tsx
git commit -m "feat(console): Curate review + Publish to explore (playbook → registry + share)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: End-to-end verification + register the page wiring

- [ ] **Step 1:** `pnpm build` at repo root (server + console).
- [ ] **Step 2:** Launch (`PORT=43xx SERVE_CONSOLE=true node dist/index.js`), open Insights, pick a single project, click "Contribute to explore"; confirm it routes to Curate with the distilled wins/lessons pre-selected.
- [ ] **Step 3:** In Curate, review, set a scope + version, click "Publish to explore"; confirm an explore ref + share URL return (registry must be configured — if `DEPLOY_REGISTRY` is unset, expect a clear "registry not configured" error, which is acceptable for local).
- [ ] **Step 4:** Confirm the published gem's `type` is `playbook` (derived) in the registry index entry.
- [ ] **Step 5:** Run the full suites once more: console `pnpm exec vitest run` + root `pnpm exec tsc -b && pnpm exec vitest run`. Commit any wiring fixes.

---

## Notes / risks for the implementer

- **Curate inventory visibility (highest risk):** Task 5 assumes the persisted distilled drafts (Task 2) are visible in Curate's inventory so they can be pre-selected. If `inventoryRoute` does NOT surface `~/.agentgem/distilled/*`, Task 5 must either (a) make `introspectConfig` include staged distilled drafts, or (b) carry the draft artifacts in the hand-off and render them directly. Resolve this in Task 5 step 3; prefer (a) if `stage*ByEvidence` already feeds the live inventory, else (b).
- **`scope` interim:** account-binding is deferred — the user supplies a scope; surface a note. `publishedBy` already records the real signed-in login server-side.
- **Cut is derived, never set:** do not pass `type` on publish; the distilled-draft skill makes `resolvePublishType` derive `playbook`. Task 6 step 4 verifies this.
