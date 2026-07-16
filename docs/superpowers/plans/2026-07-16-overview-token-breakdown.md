# Overview "Where tokens went" Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Where tokens went" section to the console Overview — a "Tokens by project" card (click-to-filter, facet-style persistent ranking) and a "Top sessions" card (deep-links to Sessions detail) — with range/filter persistence across navigation.

**Architecture:** Extend `aggregateObserve` (packages/insight) with two ranked fields computed over the *uncapped* filtered session set — `byProject` as a partial-filter aggregate (agent/model/minMsgs apply; project does NOT, so the card keeps its full ranking while a project filter is active) and `topSessions` (top 8 by tokens). Mirror the fields in three schema sites (insight interface, console Zod with `.default([])`, server Zod synced + exported). Render via a new `BreakdownCard.tsx` sibling of `UsageBars` (deliberately NOT a generalization of it). Persist Overview `range`+`filter` to sessionStorage with a validating reader.

**Tech Stack:** TypeScript, React 18, Zod 4, vitest + @testing-library/react (jsdom), hand-authored CSS in `theme.css` (Lapidary Ledger tokens).

**Spec (source of truth):** `docs/superpowers/specs/2026-07-16-overview-token-breakdown-design.md` — design-reviewed + eng-reviewed, 18 approved decisions. When this plan and the spec disagree, the spec wins.

## Global Constraints

- Worktree: `/Users/rfeng/Projects/ninemind/agentgem-worktrees/overview-token-breakdown`, branch `overview-token-breakdown`. All commands below run from the worktree root unless a `cd` is shown.
- Node >= 24, pnpm. **No new dependencies.**
- `tsc -b` is the typecheck (there is no `typecheck` script). Root tests run COMPILED files: `pnpm exec vitest run dist/__tests__/<name>.test.js` after `tsc -b`. A `src/*.ts` path silently matches nothing.
- Console tests are NOT in CI — run locally: `cd packages/console && pnpm exec vitest run <file>`.
- Full rebuild for the browser bundle is root `pnpm build` (`tsc -b && node scripts/build-console.mjs`); `tsc -b` alone leaves the console UI bundle stale.
- Every new `className` must have a matching rule in `packages/console/src/shell/theme.css` in the same commit (`grep -c "<class>" packages/console/src/shell/theme.css` must be > 0).
- Design tokens only — no new colors. Emerald (`var(--emerald)`) marks the SELECTED project row; terracotta (`var(--accent)`) stays the default bar/link color.
- Exact copy strings: section title `Where tokens went`; card titles `Tokens by project`, `Top sessions`; null bucket label `Unassigned`; empty line `No sessions in this range.`; chip aria-label `Clear project filter`; Unassigned tooltip `sessions with no project metadata — not filterable`.
- Token metric everywhere: `tokensOf() = tokensIn + tokensOut + tokensCache` (8A). Share denominator: `Σ byProject[].tokens`, NOT the pulse total (1A). Share omitted when the denominator is 0.
- Reuse `packages/console/src/util/timeAgo.ts` for relative dates — do NOT add a new helper (7A). Deep-link segments are `encodeURIComponent`-encoded (7A).
- Commit after every task with the message given in its final step; end commit bodies with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: insight — `byProject` + `topSessions` in `aggregateObserve`

**Files:**
- Modify: `packages/insight/src/observeAggregate.ts` (interface ~line 38-52; filter block lines 83-88; return block lines 129-143)
- Test (create): `packages/insight/src/__tests__/observeBreakdown.test.ts`

**Interfaces:**
- Consumes: existing `SessionStat`, `tokensOf`, `ObserveFilter` in the same file.
- Produces (later tasks rely on these exact shapes):
  - `ObservePayload.byProject: { project: string | null; sessions: number; tokens: number; tokensIn: number; tokensOut: number; tokensCache: number }[]` — desc by `tokens`, computed over `attrFiltered` (project filter NOT applied), `project === null` kept as `null`.
  - `ObservePayload.topSessions: { agent: AgentId; sessionId: string; project: string | null; model: string | null; tokens: number; tokensIn: number; tokensOut: number; tokensCache: number; endMs: number }[]` — top 8 by `tokensOf`, computed over `filtered` (all filters applied), uncapped input (ignores the 200-session `sessions` cap).

- [ ] **Step 1: Write the failing tests**

Create `packages/insight/src/__tests__/observeBreakdown.test.ts` (conventions copied from `observeUsage.test.ts` in the same directory):

```ts
import { describe, it, expect } from "vitest";
import { aggregateObserve, type SessionStat } from "../observeAggregate.js";

const base: SessionStat = {
  agent: "claude", sessionId: "s", project: "p", model: "m", gitBranch: null,
  startMs: 1000, endMs: 2000, msgs: 5, tokensIn: 10, tokensOut: 5, tokensCache: 2,
};

describe("aggregateObserve — token attribution (byProject / topSessions)", () => {
  it("buckets by project with null kept as null, sorted desc by tokens", () => {
    const stats: SessionStat[] = [
      { ...base, sessionId: "s1", project: "a", tokensIn: 100, tokensOut: 0, tokensCache: 0 },
      { ...base, sessionId: "s2", project: "a", tokensIn: 30, tokensOut: 10, tokensCache: 10 },
      { ...base, sessionId: "s3", project: null, tokensIn: 60, tokensOut: 0, tokensCache: 0 },
    ];
    const p = aggregateObserve(stats, "all", 3000);
    expect(p.byProject).toEqual([
      { project: "a", sessions: 2, tokens: 150, tokensIn: 130, tokensOut: 10, tokensCache: 10 },
      { project: null, sessions: 1, tokens: 60, tokensIn: 60, tokensOut: 0, tokensCache: 0 },
    ]);
  });

  it("byProject ignores the project filter but respects agent/model/minMsgs (partial-filter aggregate)", () => {
    const stats: SessionStat[] = [
      { ...base, sessionId: "s1", project: "a", agent: "claude" },
      { ...base, sessionId: "s2", project: "b", agent: "claude" },
      { ...base, sessionId: "s3", project: "b", agent: "codex" },
    ];
    const p = aggregateObserve(stats, "all", 3000, { agent: "claude", project: "a" });
    // The project filter did NOT collapse the ranking…
    expect(p.byProject.map((r) => r.project).sort()).toEqual(["a", "b"]);
    // …but the agent filter still applied (codex session excluded from project b)…
    expect(p.byProject.find((r) => r.project === "b")!.sessions).toBe(1);
    // …and the rest of the payload IS project-scoped as before.
    expect(p.pulse.sessions).toBe(1);
    expect(p.topSessions).toHaveLength(1);
    expect(p.topSessions[0].sessionId).toBe("s1");
  });

  it("ranks over the UNCAPPED set — a token whale older than the 200-session payload cap still wins", () => {
    const stats: SessionStat[] = [];
    for (let i = 0; i < 220; i++) {
      stats.push({ ...base, sessionId: `recent-${i}`, endMs: 100_000 + i, tokensIn: 1, tokensOut: 0, tokensCache: 0 });
    }
    stats.push({ ...base, sessionId: "whale", endMs: 50_000, tokensIn: 9_999, tokensOut: 0, tokensCache: 0 });
    const p = aggregateObserve(stats, "all", 300_000);
    expect(p.sessions.find((s) => s.sessionId === "whale")).toBeUndefined(); // fell off the recency cap
    expect(p.topSessions[0].sessionId).toBe("whale");                        // still ranked #1 by tokens
    expect(p.topSessions).toHaveLength(8);                                   // capped at 8
    expect(p.byProject[0].tokens).toBe(220 + 9_999);                         // sums see past the cap too
  });

  it("topSessions rows carry the token split and endMs", () => {
    const p = aggregateObserve([{ ...base, sessionId: "s1" }], "all", 3000);
    expect(p.topSessions).toEqual([
      { agent: "claude", sessionId: "s1", project: "p", model: "m", tokens: 17, tokensIn: 10, tokensOut: 5, tokensCache: 2, endMs: 2000 },
    ]);
  });

  it("returns empty arrays for an empty range", () => {
    const p = aggregateObserve([], "all", 3000);
    expect(p.byProject).toEqual([]);
    expect(p.topSessions).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/insight && pnpm exec vitest run src/__tests__/observeBreakdown.test.ts`
Expected: FAIL — `byProject`/`topSessions` are `undefined` (property does not exist).

- [ ] **Step 3: Implement in `observeAggregate.ts`**

3a. Add to the `ObservePayload` interface, after the `usageDaily` member and before `facets`:

```ts
  // Token attribution over the UNCAPPED filtered set (the `sessions` array below is
  // recency-capped at 200 — deriving these client-side from it would silently
  // truncate). byProject is a PARTIAL-FILTER aggregate: agent/model/minMsgs apply,
  // the project filter does NOT — the Tokens-by-project card keeps its full ranking
  // while a project filter is active (Variant B). `project` stays null for the
  // unassigned bucket; labeling is the renderer's job.
  byProject: { project: string | null; sessions: number; tokens: number; tokensIn: number; tokensOut: number; tokensCache: number }[];
  topSessions: { agent: AgentId; sessionId: string; project: string | null; model: string | null; tokens: number; tokensIn: number; tokensOut: number; tokensCache: number; endMs: number }[];
```

3b. Replace the existing filter block (lines 83-88, the `// Apply attribute filters.` section):

```ts
  // Apply attribute filters. byProject deliberately skips the project filter — a
  // partial-filter aggregate (cousin of `facets` above, which skips ALL filters).
  let attrFiltered = rangeStats;
  if (filter?.agent !== undefined) attrFiltered = attrFiltered.filter((s) => s.agent === filter.agent);
  if (filter?.model !== undefined) attrFiltered = attrFiltered.filter((s) => s.model === filter.model);
  if (filter?.minMsgs !== undefined) attrFiltered = attrFiltered.filter((s) => s.msgs >= filter.minMsgs!);
  const filtered = filter?.project !== undefined
    ? attrFiltered.filter((s) => s.project === filter.project)
    : attrFiltered;
```

(The predicates are ANDed, so hoisting `project` to the end is semantically identical to the old order.)

3c. After the existing `for (const s of filtered) { … }` loop (ends ~line 115), add:

```ts
  const byProj = new Map<string | null, ObservePayload["byProject"][number]>();
  for (const s of attrFiltered) {
    const b = byProj.get(s.project) ??
      { project: s.project, sessions: 0, tokens: 0, tokensIn: 0, tokensOut: 0, tokensCache: 0 };
    b.sessions++; b.tokens += tokensOf(s);
    b.tokensIn += s.tokensIn; b.tokensOut += s.tokensOut; b.tokensCache += s.tokensCache;
    byProj.set(s.project, b);
  }
  const byProject = [...byProj.values()].sort((a, b) => b.tokens - a.tokens);

  const topSessions = [...filtered]
    .sort((a, b) => tokensOf(b) - tokensOf(a))
    .slice(0, 8)
    .map((s) => ({
      agent: s.agent, sessionId: s.sessionId, project: s.project, model: s.model,
      tokens: tokensOf(s), tokensIn: s.tokensIn, tokensOut: s.tokensOut, tokensCache: s.tokensCache,
      endMs: s.endMs,
    }));
```

3d. Add both to the return object (anywhere before `facets`):

```ts
    byProject,
    topSessions,
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/insight && pnpm exec vitest run src/__tests__/observeBreakdown.test.ts`
Expected: 5 tests PASS.

Also run the existing suite for regressions: `cd packages/insight && pnpm exec vitest run src/__tests__/observeUsage.test.ts`
Expected: PASS (filter-order hoist is behavior-neutral).

- [ ] **Step 5: Commit**

```bash
git add packages/insight/src/observeAggregate.ts packages/insight/src/__tests__/observeBreakdown.test.ts
git commit -m "feat(insight): byProject + topSessions token attribution in aggregateObserve

byProject is a partial-filter aggregate (agent/model/minMsgs apply, project
does not) computed over the uncapped set; topSessions = top 8 by tokens.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: schemas — console mirror with `.default([])`, server sync + export, drift-guard

**Files:**
- Modify: `packages/console/src/api/routes.ts:439-455` (ObservePayloadSchema — also add `export`)
- Modify: `src/gem.controller.ts:26-47` (ObservePayloadSchema + SessionStatSchema — sync + `export`)
- Test (create): `src/__tests__/observePayloadDrift.test.ts`
- Test (modify): `packages/console/src/panels/Observe/Observe.test.tsx` (old-payload parse test; fixture update happens in Task 3)

**Interfaces:**
- Consumes: Task 1's `byProject`/`topSessions` shapes (exact fields above).
- Produces: exported `ObservePayloadSchema` from BOTH `packages/console/src/api/routes.ts` and `src/gem.controller.ts`; exported `SessionStatSchema` from `src/gem.controller.ts`. Console `ObservePayload` type (z.infer) now includes `byProject`/`topSessions` as required-after-parse (defaults fill them).

- [ ] **Step 1: Write the failing tests**

1a. Create `src/__tests__/observePayloadDrift.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { ObservePayloadSchema, SessionStatSchema } from "../gem.controller.js";
import { aggregateObserve, type SessionStat } from "@agentgem/insight";

// Drift-guard: the server's schema copies are the OpenAPI contract. This test makes
// the "aggregate grows a field the contract doesn't know" class unreproducible.
const stat: SessionStat = {
  agent: "claude", sessionId: "s1", project: "p", cwd: "/tmp/p", model: "m", gitBranch: null,
  startMs: 1000, endMs: 2000, msgs: 5, tokensIn: 10, tokensOut: 5, tokensCache: 2,
  tools: { Read: 3 }, skills: { verify: 1 }, subagents: { Explore: 1 },
};

describe("observe payload contract drift-guard", () => {
  it("aggregateObserve output parses against the server ObservePayloadSchema", () => {
    const parsed = ObservePayloadSchema.safeParse(aggregateObserve([stat], "all", 3000));
    expect(parsed.success, JSON.stringify(parsed.success ? "" : parsed.error.issues)).toBe(true);
  });

  it("insight SessionStat parses against the server SessionStatSchema (raw contract)", () => {
    const parsed = SessionStatSchema.safeParse(stat);
    expect(parsed.success, JSON.stringify(parsed.success ? "" : parsed.error.issues)).toBe(true);
  });
});
```

(If importing `../gem.controller.js` drags in heavy module side effects and the test can't run, fall back: move the two schemas to a new `src/observeSchemas.ts`, import them from `gem.controller.ts`, and point the test there. Try the direct import first — the project bans module-scoped side effects, so it should be clean.)

1b. Append to `packages/console/src/panels/Observe/Observe.test.tsx` (after the existing `describe` blocks; add `ObservePayloadSchema` to the existing import from `"../../api/routes.js"`):

```tsx
describe("ObservePayloadSchema version-skew defaults", () => {
  it("parses an old server payload lacking byProject/topSessions (protects /api/observe consumers like SessionPicker)", () => {
    const { byProject: _bp, topSessions: _ts, ...legacy } = payload;
    const parsed = ObservePayloadSchema.safeParse(legacy);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.byProject).toEqual([]);
      expect(parsed.data.topSessions).toEqual([]);
    }
  });
});
```

(This test compiles only after Task 3 adds `byProject`/`topSessions` to the `payload` fixture — if executing Task 2 standalone, write the test now and expect a compile error until the fixture lands; the schema change itself is verified by the root drift-guard.)

- [ ] **Step 2: Run the drift-guard to verify it fails**

Run: `tsc -b && pnpm exec vitest run dist/__tests__/observePayloadDrift.test.js`
Expected: FAIL — `gem.controller.js` does not export `ObservePayloadSchema` (and once exported, parse fails on missing `byTool`/`byProject`/… until Step 3 syncs the schema).

- [ ] **Step 3: Implement the schema changes**

3a. `src/gem.controller.ts` — replace lines 26-45 (both schema consts) with:

```ts
export const ObservePayloadSchema = z.object({
  pulse: z.object({ sessions: z.number(), msgs: z.number(), tokens: z.number(), activeMs: z.number() }),
  daily: z.array(z.object({ date: z.string(), sessions: z.number(), msgs: z.number(), tokensIn: z.number(), tokensOut: z.number(), tokensCache: z.number() })),
  sessions: z.array(z.object({ agent: z.string(), sessionId: z.string(), project: z.string().nullable(), model: z.string().nullable(), startMs: z.number(), endMs: z.number(), durationMs: z.number(), msgs: z.number(), tokens: z.number(), tokensIn: z.number(), tokensOut: z.number(), tokensCache: z.number(), gitBranch: z.string().nullable() })),
  models: z.array(z.object({ model: z.string(), agent: z.string(), sessions: z.number(), tokens: z.number() })),
  byTool: z.array(z.object({ name: z.string(), count: z.number() })),
  bySkill: z.array(z.object({ name: z.string(), count: z.number() })),
  bySubagent: z.array(z.object({ name: z.string(), count: z.number() })),
  usageDaily: z.array(z.object({
    date: z.string(),
    tools: z.record(z.string(), z.number()),
    skills: z.record(z.string(), z.number()),
    subagents: z.record(z.string(), z.number()),
  })),
  byProject: z.array(z.object({ project: z.string().nullable(), sessions: z.number(), tokens: z.number(), tokensIn: z.number(), tokensOut: z.number(), tokensCache: z.number() })),
  topSessions: z.array(z.object({ agent: z.string(), sessionId: z.string(), project: z.string().nullable(), model: z.string().nullable(), tokens: z.number(), tokensIn: z.number(), tokensOut: z.number(), tokensCache: z.number(), endMs: z.number() })),
  facets: z.object({ agents: z.array(z.string()), projects: z.array(z.string()), models: z.array(z.string()) }),
  range: z.enum(["today", "7d", "30d", "all"]),
});
// Raw scan output: the uncapped SessionStat[] the console fetches once, then
// aggregates per range/filter client-side (sharing @agentgem/insight's
// aggregateObserve). /observe still serves the server-aggregated payload.
export const SessionStatSchema = z.object({
  agent: z.string(),
  sessionId: z.string(),
  project: z.string().nullable(),
  cwd: z.string().nullable().optional(),
  model: z.string().nullable(),
  gitBranch: z.string().nullable(),
  startMs: z.number(), endMs: z.number(), msgs: z.number(),
  tokensIn: z.number(), tokensOut: z.number(), tokensCache: z.number(),
  tools: z.record(z.string(), z.number()).optional(),
  skills: z.record(z.string(), z.number()).optional(),
  subagents: z.record(z.string(), z.number()).optional(),
});
```

(Comment kept verbatim; only `export` + the drifted/new fields change. `byTool`…`usageDaily` and `cwd`/`tools`/`skills`/`subagents` fix the PRE-EXISTING drift; `byProject`/`topSessions` are this feature. Server-side fields are required — the server always produces them — no `.default`.)

3b. `packages/console/src/api/routes.ts` — line 439: change `const ObservePayloadSchema` to `export const ObservePayloadSchema`, and insert after the `usageDaily` member (line 452) and before `facets`:

```ts
  // Token attribution (spec 2026-07-16). .default([]) so an OLD server's payload
  // (SPA-cached-at-boot skew) degrades to hidden cards for /api/observe consumers
  // (SessionPicker et al.) instead of failing the whole-payload parse.
  byProject: z.array(z.object({ project: z.string().nullable(), sessions: z.number(), tokens: z.number(), tokensIn: z.number(), tokensOut: z.number(), tokensCache: z.number() })).default([]),
  topSessions: z.array(z.object({ agent: z.string(), sessionId: z.string(), project: z.string().nullable(), model: z.string().nullable(), tokens: z.number(), tokensIn: z.number(), tokensOut: z.number(), tokensCache: z.number(), endMs: z.number() })).default([]),
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `tsc -b && pnpm exec vitest run dist/__tests__/observePayloadDrift.test.js`
Expected: 2 tests PASS.

Typecheck everything: `tsc -b`
Expected: clean (the console `ObservePayload` z.infer gains the two fields; nothing consumes them yet).

- [ ] **Step 5: Commit**

```bash
git add src/gem.controller.ts packages/console/src/api/routes.ts src/__tests__/observePayloadDrift.test.ts packages/console/src/panels/Observe/Observe.test.tsx
git commit -m "feat(api): byProject/topSessions in all three observe schemas + drift-guard

Console schema takes .default([]) (version-skew protection for /api/observe
consumers); server ObservePayloadSchema + SessionStatSchema synced with the
four pre-existing drifted fields, exported for the drift-guard test.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: console UI — `BreakdownCard` + "Where tokens went" section + CSS

**Files:**
- Create: `packages/console/src/panels/Observe/BreakdownCard.tsx`
- Modify: `packages/console/src/panels/Observe/Dashboard.tsx` (imports ~line 8; JSX between the `obs-charts` close at line 128 and the `byTool` conditional at line 130)
- Modify: `packages/console/src/shell/theme.css` (after `.obs-usage-series-empty`, ~line 1048)
- Test (modify): `packages/console/src/panels/Observe/Observe.test.tsx` (fixture + new describe block)

**Interfaces:**
- Consumes: `data.byProject` / `data.topSessions` (Task 1 shapes via Task 2's console type), `fmtTokens` from `./data.js`, `timeAgo` from `../../util/timeAgo.js`, `filter`/`onFilter` props already on `Dashboard`.
- Produces: `TokensByProjectCard({ rows, activeProject, onPick, onClear })` and `TopSessionsCard({ rows, filterActive })`, both exported from `BreakdownCard.tsx`.

- [ ] **Step 1: Update the fixture and write the failing tests**

1a. In `Observe.test.tsx`, add to the `payload` fixture object (after `usageDaily`, before `facets`):

```tsx
  byProject: [
    { project: "agentgem", sessions: 2, tokens: 900_000, tokensIn: 700_000, tokensOut: 150_000, tokensCache: 50_000 },
    { project: null, sessions: 1, tokens: 100_000, tokensIn: 80_000, tokensOut: 10_000, tokensCache: 10_000 },
  ],
  topSessions: [
    { agent: "claude", sessionId: "a3f9c2d1e5b70000", project: "agentgem", model: "claude-opus-4-8",
      tokens: 900_000, tokensIn: 700_000, tokensOut: 150_000, tokensCache: 50_000, endMs: Date.now() - 2 * 3_600_000 },
  ],
```

1b. Append the new describe block:

```tsx
describe("Where tokens went", () => {
  const dash = (over?: Partial<Parameters<typeof Dashboard>[0]>) =>
    render(<Dashboard data={payload} range="7d" onRange={() => {}} filter={{}} onFilter={() => {}} apiBase="" {...over} />);

  it("renders the section with both cards, shares, and session metadata", () => {
    dash();
    expect(screen.getByText("Where tokens went")).toBeDefined();
    expect(screen.getByText("Tokens by project")).toBeDefined();
    expect(screen.getByText("Top sessions")).toBeDefined();
    expect(screen.getByText("900k · 90%")).toBeDefined();          // fmtTokens + share of Σ byProject
    expect(screen.getByText(/a3f9c2d1 …|a3f9c2d1…/)).toBeDefined() // two-line meta: id prefix…
    expect(screen.getByText(/2h ago/)).toBeDefined();              // …and timeAgo(endMs)
  });

  it("renders Unassigned as a plain span (not a button), with the not-filterable tooltip", () => {
    dash();
    const el = screen.getByText("Unassigned");
    expect(el.tagName).toBe("SPAN");
    expect(el.getAttribute("title")).toBe("sessions with no project metadata — not filterable");
  });

  it("project row click applies the filter; clicking the ACTIVE row clears it", () => {
    const onFilter = vi.fn();
    dash({ onFilter });
    fireEvent.click(screen.getByRole("button", { name: "agentgem" }));
    expect(onFilter).toHaveBeenCalledWith({ project: "agentgem" });
    cleanup();
    dash({ filter: { project: "agentgem" }, onFilter });
    fireEvent.click(screen.getByRole("button", { name: "agentgem" }));
    expect(onFilter).toHaveBeenLastCalledWith({ project: undefined });
  });

  it("active row is marked aria-current and the ✕ chip clears the filter", () => {
    const onFilter = vi.fn();
    const { container } = dash({ filter: { project: "agentgem" }, onFilter });
    const active = container.querySelector('[aria-current="true"]');
    expect(active?.textContent).toContain("agentgem");
    fireEvent.click(screen.getByRole("button", { name: "Clear project filter" }));
    expect(onFilter).toHaveBeenCalledWith({ project: undefined });
  });

  it("session row deep-links to Sessions detail with encoded segments", () => {
    dash();
    fireEvent.click(screen.getByRole("button", { name: /agentgem · claude-opus-4-8|Open session/ }));
    expect(window.location.hash).toBe("#/sessions/claude/a3f9c2d1e5b70000");
  });

  it("keeps Top sessions mounted with an empty line while a filter is active", () => {
    dash({ data: { ...payload, topSessions: [] }, filter: { model: "claude-opus-4-8" } });
    expect(screen.getByText("Top sessions")).toBeDefined();
    expect(screen.getByText("No sessions in this range.")).toBeDefined();
  });

  it("hides the project card when the only bucket is Unassigned", () => {
    dash({ data: { ...payload, byProject: [{ project: null, sessions: 1, tokens: 5, tokensIn: 5, tokensOut: 0, tokensCache: 0 }] } });
    expect(screen.queryByText("Tokens by project")).toBeNull();
  });

  it("omits the share segment when total tokens are zero", () => {
    dash({ data: { ...payload, byProject: [
      { project: "z", sessions: 1, tokens: 0, tokensIn: 0, tokensOut: 0, tokensCache: 0 },
      { project: "y", sessions: 1, tokens: 0, tokensIn: 0, tokensOut: 0, tokensCache: 0 },
    ] } });
    expect(screen.queryByText(/NaN|%/)).toBeNull();
  });
});
```

Note for the deep-link test: give the session button an accessible name that includes the project (line 1 text). If the regex name lookup is brittle, use `screen.getAllByRole("button")` and click the one whose textContent starts with `agentgem` inside the Top sessions card — but try the simple form first.

- [ ] **Step 2: Run to verify failures**

Run: `cd packages/console && pnpm exec vitest run src/panels/Observe/Observe.test.tsx`
Expected: the new describe FAILS ("Where tokens went" not found); pre-existing tests still PASS (fixture gained fields, nothing renders them yet).

- [ ] **Step 3: Create `BreakdownCard.tsx`**

```tsx
// packages/console/src/panels/Observe/BreakdownCard.tsx
import type { ObservePayload } from "../../api/routes.js";
import { fmtTokens } from "./data.js";
import { timeAgo } from "../../util/timeAgo.js";

type ProjectRow = ObservePayload["byProject"][number];
type TopSessionRow = ObservePayload["topSessions"][number];

const splitTip = (r: { tokens: number; tokensIn: number; tokensOut: number; tokensCache: number }) =>
  `${fmtTokens(r.tokens)} — ${fmtTokens(r.tokensIn)} in · ${fmtTokens(r.tokensOut)} out · ${fmtTokens(r.tokensCache)} cache`;

// "Tokens by project" — facet-style persistent ranking (Variant B): rows come from the
// pre-project-filter aggregate, so the list survives its own click. The active row is
// highlighted; clicking it (or the header chip) clears the filter. `project === null`
// renders as a quiet, honest non-affordance — the null bucket is not filterable (9A).
export function TokensByProjectCard({ rows, activeProject, onPick, onClear }: {
  rows: ProjectRow[]; activeProject: string | undefined;
  onPick: (project: string) => void; onClear: () => void;
}) {
  const visible = rows.slice(0, 8);
  // Degenerate guard (3A): a lone unclickable Unassigned bar answers nothing.
  if (visible.length === 0 || (visible.length === 1 && visible[0].project === null)) return null;
  const total = rows.reduce((n, r) => n + r.tokens, 0); // share denominator (1A): Σ byProject, NOT pulse
  const max = visible[0].tokens || 1;
  return (
    <div className="obs-card">
      <div className="obs-breakdown-head">
        <div className="obs-card-title">Tokens by project</div>
        {activeProject !== undefined && (
          <button type="button" className="obs-breakdown-chip" aria-label="Clear project filter" onClick={onClear}>
            {activeProject} ✕
          </button>
        )}
      </div>
      <ul className="obs-usage-list">
        {visible.map((r) => {
          const active = r.project !== null && r.project === activeProject;
          const share = total > 0 ? ` · ${Math.round((r.tokens / total) * 100)}%` : "";
          return (
            <li key={r.project ?? " unassigned"} className={"obs-usage-row" + (active ? " is-active" : "")}
              aria-current={active || undefined}>
              <div className="obs-usage-head">
                {r.project === null
                  ? <span className="obs-usage-name obs-muted" title="sessions with no project metadata — not filterable">Unassigned</span>
                  : <button type="button" className="obs-usage-link obs-usage-name"
                      title={active ? `Clear filter: ${r.project}` : `Filter dashboard to ${r.project}`}
                      onClick={() => (active ? onClear() : onPick(r.project!))}>
                      {r.project}
                    </button>}
                <span className="obs-usage-count" title={splitTip(r)}>{fmtTokens(r.tokens)}{share}</span>
              </div>
              <span className="obs-usage-track"><span className="obs-usage-fill" style={{ width: `${(r.tokens / max) * 100}%` }} /></span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// "Top sessions" — top 8 by tokens; rows deep-link to the Sessions detail page.
// Stays mounted with an in-card empty line while a filter is active (3A) so the
// two-card row doesn't jump on every filter click.
export function TopSessionsCard({ rows, filterActive }: { rows: TopSessionRow[]; filterActive: boolean }) {
  if (rows.length === 0 && !filterActive) return null;
  const max = rows[0]?.tokens || 1;
  return (
    <div className="obs-card">
      <div className="obs-breakdown-head"><div className="obs-card-title">Top sessions</div></div>
      {rows.length === 0 ? (
        <p className="obs-muted obs-usage-series-empty">No sessions in this range.</p>
      ) : (
        <ul className="obs-usage-list">
          {rows.map((s) => (
            <li key={s.agent + ":" + s.sessionId} className="obs-usage-row">
              <div className="obs-usage-head">
                <button type="button" className="obs-usage-link obs-usage-name"
                  title={`Open session ${s.sessionId}`}
                  onClick={() => {
                    window.location.hash =
                      `#/sessions/${encodeURIComponent(s.agent)}/${encodeURIComponent(s.sessionId)}`;
                  }}>
                  {s.project ?? "Unassigned"}
                </button>
                <span className="obs-usage-count" title={splitTip(s)}>{fmtTokens(s.tokens)}</span>
              </div>
              <div className="obs-breakdown-meta">{s.model ?? "—"} · {s.sessionId.slice(0, 8)}… · {timeAgo(s.endMs)}</div>
              <span className="obs-usage-track"><span className="obs-usage-fill" style={{ width: `${(s.tokens / max) * 100}%` }} /></span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Wire the section into `Dashboard.tsx`**

4a. Add imports (after the existing `./data.js` import):

```tsx
import { TokensByProjectCard, TopSessionsCard } from "./BreakdownCard.js";
```

4b. Insert between the closing `</div>` of the main `obs-charts` row (line 128) and the `{(data.byTool.length > 0 || …)` conditional (line 130) — OUTSIDE that conditional, per the approved 1B placement:

```tsx
            {(() => {
              const attrFilterActive =
                filter.agent !== undefined || filter.project !== undefined || filter.model !== undefined;
              if (data.byProject.length === 0 && data.topSessions.length === 0 && !attrFilterActive) return null;
              return (
                <div className="obs-breakdown-section">
                  <div className="obs-card-title obs-breakdown-title">Where tokens went</div>
                  <div className="obs-breakdown-charts">
                    <TokensByProjectCard
                      rows={data.byProject} activeProject={filter.project}
                      onPick={(p) => onFilter({ ...filter, project: p })}
                      onClear={() => onFilter({ ...filter, project: undefined })}
                    />
                    <TopSessionsCard rows={data.topSessions} filterActive={attrFilterActive} />
                  </div>
                </div>
              );
            })()}
```

- [ ] **Step 5: Author the CSS (same commit — every class must have a rule)**

Append to `packages/console/src/shell/theme.css` after the `.obs-usage-series-empty` rule (~line 1048):

```css
/* "Where tokens went" — token attribution (Tokens by project / Top sessions).
   Own auto-fit grid: .obs-charts' auto-fill would leave a ghost third column
   in a two-card row. Emerald marks SELECTION (distinct from terracotta data). */
.obs-breakdown-section { margin-bottom: 24px; }
.obs-breakdown-title { margin-bottom: 10px; }
.obs-breakdown-charts { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 14px; }
.obs-breakdown-head { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; margin-bottom: 10px; }
.obs-breakdown-head .obs-card-title { margin-bottom: 0; }
.obs-breakdown-chip { font: 500 11px/1 var(--font-ui); color: var(--ink-soft); background: var(--paper-2);
  border: 1px solid var(--line); border-radius: 999px; padding: 3px 9px; cursor: pointer; }
.obs-breakdown-chip:hover { border-color: var(--accent); }
.obs-breakdown-meta { font: 11px/1.3 var(--font-ui); color: var(--muted); }
.obs-usage-row.is-active .obs-usage-name { font-weight: 700; }
.obs-usage-row.is-active .obs-usage-fill { background: var(--emerald); }
```

Verify each class exists: 

```bash
for c in obs-breakdown-section obs-breakdown-title obs-breakdown-charts obs-breakdown-head obs-breakdown-chip obs-breakdown-meta is-active; do
  printf "%s: " "$c"; grep -c "$c" packages/console/src/shell/theme.css; done
```

Expected: every count > 0.

- [ ] **Step 6: Run the console tests to verify they pass**

Run: `cd packages/console && pnpm exec vitest run src/panels/Observe/Observe.test.tsx`
Expected: all tests PASS, including the Task 2 schema-defaults test (fixture now complete) and all pre-existing Dashboard tests.

- [ ] **Step 7: Commit**

```bash
git add packages/console/src/panels/Observe/BreakdownCard.tsx packages/console/src/panels/Observe/Dashboard.tsx packages/console/src/shell/theme.css packages/console/src/panels/Observe/Observe.test.tsx
git commit -m "feat(console): 'Where tokens went' — Tokens by project + Top sessions cards

Facet-style project card (Variant B: persistent ranking, is-active highlight,
✕ clear chip), top-8 sessions with two-line rows (timeAgo + token split
tooltips), share = Σ byProject with zero-guard, Unassigned as honest non-link.
Section sits between the main charts and the artifact usage bars (1B).

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Observe view persistence (sessionStorage, validated)

**Files:**
- Modify: `packages/console/src/panels/Observe/index.tsx` (lines 1-20: imports + state init; add persist effect)
- Test (modify): `packages/console/src/panels/Observe/Observe.test.tsx`

**Interfaces:**
- Consumes: `ObserveRange`, `ObserveFilter` from `../../api/routes.js` (already imported there).
- Produces: sessionStorage key `agentgem.observe.view` holding `{ range, filter }` JSON; exported `loadObserveView()` (exported for tests).

- [ ] **Step 1: Write the failing tests**

Append to `Observe.test.tsx`. The `Observe` component fetches `/api/observe/raw`, so stub fetch with one raw session (dashboard renders instead of the first-run screen):

```tsx
const rawStat = {
  agent: "claude", sessionId: "s1", project: "agentgem", model: "claude-opus-4-8", gitBranch: null,
  startMs: Date.now() - 10_000, endMs: Date.now() - 5_000, msgs: 200,
  tokensIn: 700_000, tokensOut: 150_000, tokensCache: 50_000,
};

describe("Observe view persistence", () => {
  afterEach(() => { sessionStorage.clear(); });

  const renderObserve = () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(res({ sessions: [rawStat] })));
    return render(<Observe apiBase="" />);
  };

  it("CRITICAL regression: fresh mount with empty storage keeps today's defaults (7d, min 100 msgs)", async () => {
    sessionStorage.clear();
    renderObserve();
    const tab = await screen.findByRole("tab", { name: "7d" });
    expect(tab.getAttribute("aria-selected")).toBe("true");
    expect((screen.getByLabelText("minimum messages per session") as HTMLInputElement).value).toBe("100");
  });

  it("rehydrates persisted range and filter", async () => {
    sessionStorage.setItem("agentgem.observe.view",
      JSON.stringify({ range: "30d", filter: { project: "agentgem", minMsgs: 100 } }));
    renderObserve();
    const tab = await screen.findByRole("tab", { name: "30d" });
    expect(tab.getAttribute("aria-selected")).toBe("true");
    expect((screen.getByLabelText("project") as HTMLSelectElement).value).toBe("agentgem");
  });

  it("garbage in storage falls back to defaults without crashing", async () => {
    sessionStorage.setItem("agentgem.observe.view", "not-json{{{");
    renderObserve();
    const tab = await screen.findByRole("tab", { name: "7d" });
    expect(tab.getAttribute("aria-selected")).toBe("true");
  });

  it("old-build values are whitelisted: unknown range falls back, cleared minMsgs survives", async () => {
    sessionStorage.setItem("agentgem.observe.view",
      JSON.stringify({ range: "14d", filter: {} }));
    renderObserve();
    const tab = await screen.findByRole("tab", { name: "7d" });     // "14d" not in the enum
    expect(tab.getAttribute("aria-selected")).toBe("true");
    expect((screen.getByLabelText("minimum messages per session") as HTMLInputElement).value).toBe(""); // cleared stays cleared
  });

  it("persists range changes for the next mount", async () => {
    renderObserve();
    fireEvent.click(await screen.findByRole("tab", { name: "30d" }));
    const stored = JSON.parse(sessionStorage.getItem("agentgem.observe.view")!);
    expect(stored.range).toBe("30d");
  });
});
```

- [ ] **Step 2: Run to verify failures**

Run: `cd packages/console && pnpm exec vitest run src/panels/Observe/Observe.test.tsx`
Expected: "rehydrates", "old-build values", and "persists" FAIL (state is hardcoded); the CRITICAL regression and garbage tests may pass vacuously today — they exist to pin behavior.

- [ ] **Step 3: Implement in `index.tsx`**

3a. Add above the `Observe` component (after imports; add `useEffect` to the react import):

```tsx
const VIEW_KEY = "agentgem.observe.view";
const VIEW_RANGES: ObserveRange[] = ["today", "7d", "30d", "all"];

/** 4A + 3A: validated sessionStorage rehydration. Garbage, old-build values, or
 *  wrong types fall back to the defaults; a stale `project` passes through (the
 *  card's ✕ chip is the recovery affordance). Exported for tests. */
export function loadObserveView(): { range: ObserveRange; filter: ObserveFilter } {
  const fallback: { range: ObserveRange; filter: ObserveFilter } = { range: "7d", filter: { minMsgs: 100 } };
  try {
    const raw = sessionStorage.getItem(VIEW_KEY);
    if (!raw) return fallback;
    const v = JSON.parse(raw) as { range?: unknown; filter?: Record<string, unknown> };
    const range = VIEW_RANGES.includes(v.range as ObserveRange) ? (v.range as ObserveRange) : fallback.range;
    const f = v.filter ?? {};
    const str = (x: unknown) => (typeof x === "string" && x !== "" ? x : undefined);
    // A stored blob with no minMsgs means the user CLEARED it — keep it cleared.
    const minMsgs = !("minMsgs" in f) ? undefined
      : typeof f.minMsgs === "number" && Number.isFinite(f.minMsgs) ? f.minMsgs
      : fallback.filter.minMsgs;
    return { range, filter: { agent: str(f.agent), project: str(f.project), model: str(f.model), minMsgs } };
  } catch {
    return fallback;
  }
}
```

3b. Replace the two state lines inside `Observe`:

```tsx
  const [range, setRange] = useState<ObserveRange>(() => loadObserveView().range);
  const [filter, setFilter] = useState<ObserveFilter>(() => loadObserveView().filter);
  // Persist the view so the triage loop (Overview → session detail → back) keeps
  // its investigation context (4A). Best-effort: a blocked/full store is harmless.
  useEffect(() => {
    try { sessionStorage.setItem(VIEW_KEY, JSON.stringify({ range, filter })); } catch { /* best-effort */ }
  }, [range, filter]);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/console && pnpm exec vitest run src/panels/Observe/Observe.test.tsx`
Expected: all PASS, including the CRITICAL fresh-mount regression.

- [ ] **Step 5: Commit**

```bash
git add packages/console/src/panels/Observe/index.tsx packages/console/src/panels/Observe/Observe.test.tsx
git commit -m "feat(console): persist Overview range/filter to sessionStorage (validated rehydrate)

Range whitelisted against the enum, minMsgs finite-or-default with
cleared-state preserved, garbage falls back to defaults. Keeps the token
triage loop's context across Overview → Sessions → back.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: full-suite verification + real-browser pass

**Files:** none created — verification only.

**Interfaces:** consumes everything above.

- [ ] **Step 1: Full typecheck + root suite (drift-guard included)**

Run: `pnpm build && pnpm exec vitest run dist/__tests__/observePayloadDrift.test.js`
Expected: build clean (this also refreshes the console bundle — the server caches the SPA at boot, so a stale bundle is the classic trap), drift-guard PASS.

- [ ] **Step 2: Package suites**

Run: `cd packages/insight && pnpm test`
Expected: PASS. (Real-FS scan tests can flake under full-suite concurrency — if `observeScan*` times out, re-run that file in isolation before treating it as a failure.)

Run: `cd packages/console && pnpm test`
Expected: PASS (workers are capped at 4 by config; expect a few minutes).

- [ ] **Step 3: Real-browser verify (project verify skill)**

Invoke the repo's `verify` skill (Skill tool) to launch the console against a temp `AGENTGEM_HOME` and drive `#/overview`. Checklist (from the spec + test plan at `~/.gstack/projects/ninemindai-agentgem/rfeng-overview-token-breakdown-eng-review-test-plan-20260716.md`):

1. Section renders at the 1B position: pulse → charts → **Where tokens went** → tools/skills bars → heatmap; styled (cards, bars, chip — no unstyled UI).
2. Click a project row → dashboard rescopes; card keeps full ranking, active row bold + emerald, ✕ chip appears; rescope perceivable without scrolling (is-updating dim).
3. Click active row / chip → filter clears.
4. Click a top-session row → Sessions detail; navigate back → range + filter still applied.
5. Values read `38.2M · 71%`-style; tooltips show the in/out/cache split; session rows show `model · id… · 2h ago`.

- [ ] **Step 4: Commit any verify fixes, then hand off**

If the browser pass surfaced fixes, commit them (`fix(console): …`). Then follow `superpowers:finishing-a-development-branch` — push and open a PR per the repo's PR lifecycle rules (CI gate `test (24)`, verify each commit landed on `origin/main` after merge).

---

## Self-Review (done at write time)

- **Spec coverage:** T1→Task 1, T2→Task 2, T3+T4→Task 3, T5→Task 4, T6 folded into each task's tests, T7→Task 5. All 18 spec decisions have a home; the 8 eng-review test additions are all present (share-under-filter in Task 1; drift-guard + old-payload in Task 2; active-row-clear, span, degenerate, zero-share in Task 3; CRITICAL regression + garbage in Task 4).
- **Placeholders:** none — every step carries code or an exact command.
- **Type consistency:** `byProject`/`topSessions` shapes identical across Task 1 interface, Task 2 Zod (console + server), Task 3 fixture; `loadObserveView` name consistent between impl and tests.
