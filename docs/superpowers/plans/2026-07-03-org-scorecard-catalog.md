# Org-Scoped Scorecard Catalog — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a hosted, public `/orgs/:scope` page in the marketplace that lists an org's gems (gems keyed `@scope/*`) with the existing Cut × Stone badge plus a per-gem maturity rubric.

**Architecture:** Mirror the shipped SP2 profile feature end-to-end. Backend: a pure `computeGemRubric` + a `buildOrgCatalog(db, scope)` resolver that filters `catalog_gems` by scope-from-key (exactly like `buildProfile` filters by `published_by`), exposed via a new `@get("/org-catalog")` method on the existing `AggregatorController`. Frontend: an `OrgCatalog` page + `RubricRing` component, wired into the marketplace `Router` at `/orgs/:scope`, reusing `CutBadge`/`StoneRating`.

**Tech Stack:** TypeScript, drizzle-orm (Postgres/PGlite), AgentBack decorator controllers (`@agentback/openapi`), Zod, React 18 + Vite, Vitest + @testing-library/react.

## Global Constraints

- **Git identity:** every commit MUST be `Raymond Feng <raymond@ninemind.ai>`. Use `git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit …`.
- **Commit staging:** Edit/Write do NOT `git add`. Stage every changed file explicitly, then `git commit` (no `-a`). Verify with `git show --stat HEAD`.
- **Backend test-collection trap:** backend package code lives in `packages/aggregator/src/`, but its tests MUST live at the repo root under `src/aggregator/__tests__/` (the root vitest only collects root `src/**/__tests__`). Import code as `@agentgem/aggregator`.
- **Backend test command already builds:** root `pnpm test` runs `tsc -b && vitest run`; pass a filter to scope it (e.g. `pnpm test orgRubric`). No separate build step needed.
- **Marketplace runs its own toolchain** (NOT in CI — run locally): from `packages/marketplace/`: `pnpm test` (vitest), `pnpm typecheck` (`tsc -p tsconfig.json --noEmit`), `pnpm build` (vite). `pnpm test` does NOT typecheck — run `pnpm typecheck` separately.
- **Scope charset:** an org scope is a GitHub login/org name — `^[A-Za-z0-9-]+$` (no `.`/`_`/`%`, so it is safe to interpolate into a SQL `LIKE` prefix).
- **Node floor:** >= 24.
- **Deploy-gate:** the new `/api/aggregator/org-catalog` route only goes live after `api.agentgem.ai` redeploys; note this at handoff (same gate SP2 had).

---

### Task 1: Rubric core (`computeGemRubric`)

Pure, no I/O. The five v1 checks read only fields already on a `catalog_gems` row (+ computed stars/installs).

**Files:**
- Create: `packages/aggregator/src/orgRubric.ts`
- Modify: `packages/aggregator/src/index.ts` (add one export line)
- Test: `src/aggregator/__tests__/orgRubric.test.ts`

**Interfaces:**
- Produces:
  - `interface RubricInput { description: string | null; tags: string[] | null; artifactKinds: string[] | null; grade: number | null; publishedBy: string | null; stars: number; installs: number }`
  - `interface RubricCheck { id: string; label: string; pass: boolean; howToFix: string }`
  - `interface RubricResult { score: number; checks: RubricCheck[] }`
  - `function computeGemRubric(input: RubricInput): RubricResult`
  - `const ORG_RUBRIC` (the ordered check definitions)

- [ ] **Step 1: Write the failing test**

Create `src/aggregator/__tests__/orgRubric.test.ts`:

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { computeGemRubric, ORG_RUBRIC, type RubricInput } from "@agentgem/aggregator";

const base: RubricInput = {
  description: "a real gem", tags: ["frontend"], artifactKinds: ["skill"],
  grade: 2, publishedBy: "dev", stars: 1, installs: 0,
};

describe("computeGemRubric", () => {
  it("passes all five checks and scores 1 for a fully-formed gem", () => {
    const r = computeGemRubric(base);
    expect(r.checks).toHaveLength(5);
    expect(r.checks.every((c) => c.pass)).toBe(true);
    expect(r.score).toBe(1);
  });

  it("fails 'documented' with empty description or no tags", () => {
    expect(computeGemRubric({ ...base, description: "  " }).checks.find((c) => c.id === "documented")!.pass).toBe(false);
    expect(computeGemRubric({ ...base, tags: [] }).checks.find((c) => c.id === "documented")!.pass).toBe(false);
    expect(computeGemRubric({ ...base, tags: null }).checks.find((c) => c.id === "documented")!.pass).toBe(false);
  });

  it("fails 'substance' with no artifacts", () => {
    expect(computeGemRubric({ ...base, artifactKinds: [] }).checks.find((c) => c.id === "substance")!.pass).toBe(false);
    expect(computeGemRubric({ ...base, artifactKinds: null }).checks.find((c) => c.id === "substance")!.pass).toBe(false);
  });

  it("fails 'battleTested' below grade 2", () => {
    expect(computeGemRubric({ ...base, grade: 1 }).checks.find((c) => c.id === "battleTested")!.pass).toBe(false);
    expect(computeGemRubric({ ...base, grade: null }).checks.find((c) => c.id === "battleTested")!.pass).toBe(false);
  });

  it("passes 'adopted' on stars OR installs, fails when both zero", () => {
    expect(computeGemRubric({ ...base, stars: 0, installs: 5 }).checks.find((c) => c.id === "adopted")!.pass).toBe(true);
    expect(computeGemRubric({ ...base, stars: 0, installs: 0 }).checks.find((c) => c.id === "adopted")!.pass).toBe(false);
  });

  it("fails 'attributed' with no publisher", () => {
    expect(computeGemRubric({ ...base, publishedBy: null }).checks.find((c) => c.id === "attributed")!.pass).toBe(false);
  });

  it("score is fraction of passing checks", () => {
    // documented fails, other 4 pass → 4/5
    expect(computeGemRubric({ ...base, tags: [] }).score).toBeCloseTo(0.8, 5);
  });

  it("ORG_RUBRIC and every check carry a non-empty howToFix", () => {
    expect(ORG_RUBRIC).toHaveLength(5);
    for (const c of computeGemRubric({ ...base, tags: [], artifactKinds: [], grade: 1, stars: 0, installs: 0, publishedBy: null }).checks) {
      expect(c.howToFix.length).toBeGreaterThan(0);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test orgRubric`
Expected: FAIL (module `@agentgem/aggregator` has no export `computeGemRubric`).

- [ ] **Step 3: Write minimal implementation**

Create `packages/aggregator/src/orgRubric.ts`:

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Per-gem maturity rubric — the Cortex/Backstage-Soundcheck "scorecard" surface. v1 reads ONLY
// fields already on a catalog_gems row plus computed engagement (stars/installs), so it needs no
// new data pipeline. Deeper checks (cross-agent verified, has-evals) are a deferred fast-follow —
// see docs/superpowers/specs/2026-07-03-org-scorecard-catalog-design.md §8 D2.
export interface RubricInput {
  description: string | null;
  tags: string[] | null;
  artifactKinds: string[] | null;
  grade: number | null;
  publishedBy: string | null;
  stars: number;
  installs: number;
}
export interface RubricCheck { id: string; label: string; pass: boolean; howToFix: string }
export interface RubricResult { score: number; checks: RubricCheck[] }

interface RubricDef { id: string; label: string; howToFix: string; test: (i: RubricInput) => boolean }

export const ORG_RUBRIC: RubricDef[] = [
  { id: "documented", label: "Documented", howToFix: "Add a description and at least one tag before publishing.",
    test: (i) => !!i.description?.trim() && (i.tags?.length ?? 0) >= 1 },
  { id: "substance", label: "Has substance", howToFix: "Publish at least one artifact (skill, mcp_server, …).",
    test: (i) => (i.artifactKinds?.length ?? 0) >= 1 },
  { id: "battleTested", label: "Battle-tested", howToFix: "Distill from real, battle-tested sessions to raise the grade.",
    test: (i) => (i.grade ?? 0) >= 2 },
  { id: "adopted", label: "Adopted", howToFix: "Share the gem so others star or install it.",
    test: (i) => i.stars >= 1 || i.installs >= 1 },
  { id: "attributed", label: "Attributed", howToFix: "Publish under a verified account.",
    test: (i) => !!i.publishedBy?.trim() },
];

export function computeGemRubric(input: RubricInput): RubricResult {
  const checks: RubricCheck[] = ORG_RUBRIC.map((d) => ({ id: d.id, label: d.label, howToFix: d.howToFix, pass: d.test(input) }));
  const passing = checks.filter((c) => c.pass).length;
  return { score: checks.length ? passing / checks.length : 0, checks };
}
```

Add to `packages/aggregator/src/index.ts` (after the `export * from "./profile.js";` line):

```ts
export * from "./orgRubric.js";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test orgRubric`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/aggregator/src/orgRubric.ts packages/aggregator/src/index.ts src/aggregator/__tests__/orgRubric.test.ts
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "feat(aggregator): org gem maturity rubric (computeGemRubric)"
git show --stat HEAD
```

---

### Task 2: `buildOrgCatalog` resolver

Mirrors `buildProfile` (`packages/aggregator/src/profile.ts`) but filters `catalog_gems` by scope-from-key and attaches a rubric. Returns an empty catalog (not null) for an unknown scope; returns null ONLY for a malformed scope.

**Files:**
- Create: `packages/aggregator/src/orgCatalog.ts`
- Modify: `packages/aggregator/src/index.ts` (add one export line)
- Test: `src/aggregator/__tests__/orgCatalog.test.ts`

**Interfaces:**
- Consumes: `computeGemRubric`, `RubricResult` (Task 1); `starCounts(db, "gem", keys): Promise<Record<string, number>>` (`stars.js`); `gemAdoption(db, { keys }): Promise<{ gemKey; installs; verifiedInstalls }[]>` (`aggregates.js`); `catalogGems` (`schema.js`).
- Produces:
  - `interface OrgCatalogGem { key: string; version: string; cut: string | null; grade: number | null; owner: string; description: string | null; stars: number; installs: number; verifiedInstalls: number; rubric: RubricResult }`
  - `interface OrgCatalog { scope: string; gemCount: number; ownerCount: number; gems: OrgCatalogGem[] }`
  - `function buildOrgCatalog(db: AppDb, rawScope: string): Promise<OrgCatalog | null>`

- [ ] **Step 1: Write the failing test**

Create `src/aggregator/__tests__/orgCatalog.test.ts`:

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { makeTestDb, buildOrgCatalog, catalogGems, accounts, stars } from "@agentgem/aggregator";

async function star(db: never, gemKey: string, n: number) {
  for (let i = 0; i < n; i++) {
    const accountId = randomUUID();
    await (db as any).insert(accounts).values({ id: accountId, provider: "github", providerAccountId: "s" + randomUUID(), login: "starrer" });
    await (db as any).insert(stars).values({ id: randomUUID(), accountId, targetKind: "gem", targetId: gemKey });
  }
}

describe("buildOrgCatalog", () => {
  it("lists only @scope/* gems, with owner/counts, sorted by grade desc then stars desc", async () => {
    const db = await makeTestDb();
    await db.insert(catalogGems).values({ gemKey: "@acme/a", version: "1.0.0", publishedBy: "dev1", description: "aa", tags: ["x"], artifactKinds: ["skill"], type: "skill", grade: 2, createdAtMs: 10 });
    await db.insert(catalogGems).values({ gemKey: "@acme/b", version: "1.0.0", publishedBy: "dev2", description: "bb", tags: ["y"], artifactKinds: ["skill"], type: "kit", grade: 3, createdAtMs: 20 });
    await db.insert(catalogGems).values({ gemKey: "@other/c", version: "1.0.0", publishedBy: "dev3", description: "cc", tags: ["z"], artifactKinds: ["skill"], type: "skill", grade: 3, createdAtMs: 30 });

    const c = await buildOrgCatalog(db, "acme");
    expect(c).not.toBeNull();
    expect(c!.scope).toBe("acme");
    expect(c!.gemCount).toBe(2);
    expect(c!.ownerCount).toBe(2);
    expect(c!.gems.map((g) => g.key)).toEqual(["@acme/b", "@acme/a"]); // grade desc
    expect(c!.gems[0]).toMatchObject({ key: "@acme/b", cut: "kit", grade: 3, owner: "dev2" });
    expect(c!.gems[0].rubric.checks).toHaveLength(5);
  });

  it("attaches a rubric that reflects the row (fully-formed + starred → all pass)", async () => {
    const db = await makeTestDb();
    await db.insert(catalogGems).values({ gemKey: "@acme/g", version: "1.0.0", publishedBy: "dev", description: "d", tags: ["x"], artifactKinds: ["skill"], type: "skill", grade: 2, createdAtMs: 1 });
    await star(db as never, "@acme/g", 1);
    const c = await buildOrgCatalog(db, "acme");
    expect(c!.gems[0].stars).toBe(1);
    expect(c!.gems[0].rubric.score).toBe(1);
  });

  it("keeps only the latest version per gemKey", async () => {
    const db = await makeTestDb();
    await db.insert(catalogGems).values({ gemKey: "@acme/g", version: "1.0.0", publishedBy: "dev", description: "old", createdAtMs: 1 });
    await db.insert(catalogGems).values({ gemKey: "@acme/g", version: "2.0.0", publishedBy: "dev", description: "new", createdAtMs: 2 });
    const c = await buildOrgCatalog(db, "acme");
    expect(c!.gems).toHaveLength(1);
    expect(c!.gems[0]).toMatchObject({ version: "2.0.0", description: "new" });
  });

  it("is case-insensitive on scope and does not match a different scope prefix", async () => {
    const db = await makeTestDb();
    await db.insert(catalogGems).values({ gemKey: "@Acme/a", version: "1.0.0", publishedBy: "dev", createdAtMs: 1 });
    await db.insert(catalogGems).values({ gemKey: "@acme-corp/b", version: "1.0.0", publishedBy: "dev", createdAtMs: 2 });
    const c = await buildOrgCatalog(db, "acme");
    expect(c!.gems.map((g) => g.key)).toEqual(["@Acme/a"]); // not @acme-corp/b
  });

  it("returns an empty catalog (not null) for an unknown scope", async () => {
    const db = await makeTestDb();
    const c = await buildOrgCatalog(db, "nobody");
    expect(c).toEqual({ scope: "nobody", gemCount: 0, ownerCount: 0, gems: [] });
  });

  it("returns null for a malformed scope", async () => {
    const db = await makeTestDb();
    expect(await buildOrgCatalog(db, "bad/scope")).toBeNull();
    expect(await buildOrgCatalog(db, "a b")).toBeNull();
    expect(await buildOrgCatalog(db, "")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test orgCatalog`
Expected: FAIL (no export `buildOrgCatalog`).

- [ ] **Step 3: Write minimal implementation**

Create `packages/aggregator/src/orgCatalog.ts`:

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Org scorecard catalog: all gems keyed @scope/* with a per-gem maturity rubric. Mirrors buildProfile
// (filters catalog_gems), but keys off the gem's SCOPE rather than published_by, and returns an EMPTY
// catalog (not null) for an unknown scope so the page shows a friendly empty state; null is reserved
// for a malformed scope → the route maps that to 400.
import { sql, desc } from "drizzle-orm";
import type { AppDb } from "./schema.js";
import { catalogGems } from "./schema.js";
import { starCounts } from "./stars.js";
import { gemAdoption } from "./aggregates.js";
import { computeGemRubric, type RubricResult } from "./orgRubric.js";

const SCOPE_RE = /^[A-Za-z0-9-]+$/; // GitHub login/org charset — no %/_ so LIKE-prefix is injection-safe

export interface OrgCatalogGem {
  key: string;
  version: string;
  cut: string | null;
  grade: number | null;
  owner: string;
  description: string | null;
  stars: number;
  installs: number;
  verifiedInstalls: number;
  rubric: RubricResult;
}
export interface OrgCatalog {
  scope: string;
  gemCount: number;
  ownerCount: number;
  gems: OrgCatalogGem[];
}

export async function buildOrgCatalog(db: AppDb, rawScope: string): Promise<OrgCatalog | null> {
  const scope = rawScope.trim();
  if (!SCOPE_RE.test(scope)) return null; // malformed → route returns 400

  const prefix = `@${scope}/%`.toLowerCase();
  const rows = await db
    .select({ gemKey: catalogGems.gemKey, version: catalogGems.version, publishedBy: catalogGems.publishedBy, description: catalogGems.description, tags: catalogGems.tags, artifactKinds: catalogGems.artifactKinds, type: catalogGems.type, grade: catalogGems.grade })
    .from(catalogGems)
    .where(sql`lower(${catalogGems.gemKey}) like ${prefix}`)
    .orderBy(desc(catalogGems.createdAtMs), desc(catalogGems.version));

  // newest-first → dedupe to the latest version per gemKey (version tiebreak keeps it deterministic).
  const latest = new Map<string, typeof rows[number]>();
  for (const r of rows) if (!latest.has(r.gemKey)) latest.set(r.gemKey, r);
  const base = [...latest.values()];

  const keys = base.map((g) => g.gemKey);
  const starMap = await starCounts(db, "gem", keys); // guards keys.length === 0 internally
  const adoptRows = keys.length ? await gemAdoption(db, { keys }) : [];
  const adopt = new Map(adoptRows.map((a) => [a.gemKey, a]));

  const gems: OrgCatalogGem[] = base
    .map((g) => {
      const stars = starMap[g.gemKey] ?? 0;
      const installs = adopt.get(g.gemKey)?.installs ?? 0;
      const verifiedInstalls = adopt.get(g.gemKey)?.verifiedInstalls ?? 0;
      const rubric = computeGemRubric({ description: g.description, tags: g.tags, artifactKinds: g.artifactKinds, grade: g.grade, publishedBy: g.publishedBy, stars, installs });
      return { key: g.gemKey, version: g.version, cut: g.type, grade: g.grade, owner: g.publishedBy, description: g.description, stars, installs, verifiedInstalls, rubric };
    })
    .sort((a, b) => (b.grade ?? 0) - (a.grade ?? 0) || b.stars - a.stars || a.key.localeCompare(b.key));

  const ownerCount = new Set(gems.map((g) => g.owner.toLowerCase())).size;
  return { scope, gemCount: gems.length, ownerCount, gems };
}
```

Add to `packages/aggregator/src/index.ts` (after the `export * from "./orgRubric.js";` line from Task 1):

```ts
export * from "./orgCatalog.js";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test orgCatalog`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/aggregator/src/orgCatalog.ts packages/aggregator/src/index.ts src/aggregator/__tests__/orgCatalog.test.ts
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "feat(aggregator): buildOrgCatalog resolver (scope-scoped gems + rubric)"
git show --stat HEAD
```

---

### Task 3: Aggregator route `GET /api/aggregator/org-catalog`

Add one decorator method to the existing `AggregatorController`, mirroring the `profile` method.

**Files:**
- Modify: `src/aggregator.controller.ts` (import + Zod schemas + method)
- Test: `src/aggregator/__tests__/orgCatalog.controller.test.ts`

**Interfaces:**
- Consumes: `buildOrgCatalog` (Task 2); `AgentError` (`@agentback/openapi`, already imported).
- Produces: `AggregatorController.orgCatalog({ query: { scope } })` returning the `OrgCatalog` JSON, or throwing `AgentError` 400 for a malformed scope.

- [ ] **Step 1: Write the failing test**

Create `src/aggregator/__tests__/orgCatalog.controller.test.ts`:

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { makeTestDb, catalogGems } from "@agentgem/aggregator";
import { AggregatorController } from "../../aggregator.controller.js";

describe("AggregatorController.orgCatalog", () => {
  it("returns the catalog for a valid scope", async () => {
    const db = await makeTestDb();
    await db.insert(catalogGems).values({ gemKey: "@acme/a", version: "1.0.0", publishedBy: "dev", description: "d", tags: ["x"], artifactKinds: ["skill"], type: "skill", grade: 2, createdAtMs: 1 });
    const ctl = new AggregatorController(db as never);
    const r = await ctl.orgCatalog({ query: { scope: "acme" } });
    expect(r.scope).toBe("acme");
    expect(r.gemCount).toBe(1);
    expect(r.gems[0].key).toBe("@acme/a");
  });

  it("returns an empty catalog for an unknown scope", async () => {
    const db = await makeTestDb();
    const ctl = new AggregatorController(db as never);
    const r = await ctl.orgCatalog({ query: { scope: "nobody" } });
    expect(r).toEqual({ scope: "nobody", gemCount: 0, ownerCount: 0, gems: [] });
  });

  it("throws for a malformed scope", async () => {
    const db = await makeTestDb();
    const ctl = new AggregatorController(db as never);
    await expect(ctl.orgCatalog({ query: { scope: "bad/scope" } })).rejects.toThrow(/scope/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test orgCatalog.controller`
Expected: FAIL (`ctl.orgCatalog` is not a function).

- [ ] **Step 3: Write minimal implementation**

In `src/aggregator.controller.ts`:

1. Add `buildOrgCatalog` to the existing aggregator import that already brings in `buildProfile` (the line `import { buildProfile } from "@agentgem/aggregator";`):

```ts
import { buildProfile, buildOrgCatalog } from "@agentgem/aggregator";
```

2. Add these Zod schemas next to `ProfileResult` (after the `ProfileResult` block, before `BindBody`):

```ts
const OrgCatalogQuery = z.object({ scope: z.string() });
const RubricCheckSchema = z.object({ id: z.string(), label: z.string(), pass: z.boolean(), howToFix: z.string() });
const OrgCatalogGemSchema = z.object({
  key: z.string(), version: z.string(), cut: z.string().nullable(), grade: z.number().nullable(),
  owner: z.string(), description: z.string().nullable(),
  stars: z.number(), installs: z.number(), verifiedInstalls: z.number(),
  rubric: z.object({ score: z.number(), checks: z.array(RubricCheckSchema) }),
});
const OrgCatalogResult = z.object({
  scope: z.string(), gemCount: z.number(), ownerCount: z.number(), gems: z.array(OrgCatalogGemSchema),
});
```

3. Add the method inside `AggregatorController`, immediately after the `profile` method (after its closing `}`):

```ts
  // Public org catalog: all gems keyed @scope/* with a per-gem maturity rubric. Unknown scope → empty
  // catalog (200); malformed scope → 400. scope is a query param so it needs no path-decoding.
  @get("/org-catalog", { query: OrgCatalogQuery, response: OrgCatalogResult })
  async orgCatalog(input: { query: z.infer<typeof OrgCatalogQuery> }): Promise<z.infer<typeof OrgCatalogResult>> {
    const c = await buildOrgCatalog(this.db, input.query.scope);
    if (!c) throw new AgentError("invalid scope", { status: 400, code: "invalid_scope", retryable: false });
    return c;
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test orgCatalog.controller`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/aggregator.controller.ts src/aggregator/__tests__/orgCatalog.controller.test.ts
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "feat(aggregator): GET /api/aggregator/org-catalog route"
git show --stat HEAD
```

---

### Task 4: Marketplace types + API client

**Files:**
- Modify: `packages/marketplace/src/types.ts` (add interfaces)
- Modify: `packages/marketplace/src/api.ts` (add `getOrgCatalog`)
- Test: `packages/marketplace/src/api.test.ts` (add a case)

**Interfaces:**
- Produces (types): `RubricCheck`, `OrgCatalogGem`, `OrgCatalog` (client-side mirrors of Task 2/3 shapes); `api.getOrgCatalog(scope: string): Promise<OrgCatalog | null>` (null on 400/404).

- [ ] **Step 1: Write the failing test**

Add to `packages/marketplace/src/api.test.ts` (inside the existing top-level `describe`, or append a new `describe`):

```ts
import { describe, it, expect, afterEach, vi } from "vitest";
import { makeApi } from "./api";

afterEach(() => vi.unstubAllGlobals());

describe("getOrgCatalog", () => {
  it("returns the parsed catalog on 200", async () => {
    const body = { scope: "acme", gemCount: 1, ownerCount: 1, gems: [] };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(body)) }));
    const api = makeApi("http://x");
    expect(await api.getOrgCatalog("acme")).toEqual(body);
  });

  it("returns null on 400 (malformed scope)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 400, text: () => Promise.resolve("") }));
    const api = makeApi("http://x");
    expect(await api.getOrgCatalog("bad/scope")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/marketplace && pnpm test api`
Expected: FAIL (`api.getOrgCatalog` is not a function).

- [ ] **Step 3: Write minimal implementation**

In `packages/marketplace/src/types.ts` append:

```ts
export interface RubricCheck { id: string; label: string; pass: boolean; howToFix: string }
export interface OrgCatalogGem {
  key: string;
  version: string;
  cut: string | null;
  grade: number | null;
  owner: string;
  description: string | null;
  stars: number;
  installs: number;
  verifiedInstalls: number;
  rubric: { score: number; checks: RubricCheck[] };
}
export interface OrgCatalog {
  scope: string;
  gemCount: number;
  ownerCount: number;
  gems: OrgCatalogGem[];
}
```

In `packages/marketplace/src/api.ts`:
- Extend the type import on line 1 to include `OrgCatalog`:

```ts
import type { AggIngredient, AggCoOccurrence, AdoptionPoint, RegistryGem, Profile, OrgCatalog } from "./types";
```

- Add this method inside the object returned by `makeApi`, right after `getProfile` (mirror its null-on-error shape):

```ts
    getOrgCatalog: async (scope: string): Promise<OrgCatalog | null> => {
      const res = await fetch(base + "/api/aggregator/org-catalog?scope=" + encodeURIComponent(scope));
      if (res.status === 400 || res.status === 404) return null;
      if (!res.ok) throw new Error(`/api/aggregator/org-catalog -> ${res.status}`);
      return JSON.parse(await res.text()) as OrgCatalog;
    },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/marketplace && pnpm test api`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/marketplace/src/types.ts packages/marketplace/src/api.ts packages/marketplace/src/api.test.ts
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "feat(marketplace): org-catalog types + getOrgCatalog client"
git show --stat HEAD
```

---

### Task 5: `RubricRing` component

A compact conic-gradient ring showing `pass/total` checks — the at-a-glance maturity indicator on each row.

**Files:**
- Create: `packages/marketplace/src/RubricRing.tsx`
- Test: `packages/marketplace/src/RubricRing.test.tsx`

**Interfaces:**
- Consumes: `RubricCheck` (Task 4).
- Produces: `RubricRing({ checks }: { checks: RubricCheck[] })`.

- [ ] **Step 1: Write the failing test**

Create `packages/marketplace/src/RubricRing.test.tsx`:

```tsx
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { RubricRing } from "./RubricRing";
import type { RubricCheck } from "./types";

afterEach(cleanup);
const mk = (pass: boolean[]): RubricCheck[] => pass.map((p, i) => ({ id: "c" + i, label: "L" + i, pass: p, howToFix: "fix" }));

describe("RubricRing", () => {
  it("shows pass/total and an accessible label", () => {
    render(<RubricRing checks={mk([true, true, false, false, false])} />);
    expect(screen.getByText("2/5")).toBeTruthy();
    expect(screen.getByLabelText(/2 of 5 checks pass/i)).toBeTruthy();
  });

  it("renders 0/0 safely for an empty rubric", () => {
    render(<RubricRing checks={[]} />);
    expect(screen.getByText("0/0")).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/marketplace && pnpm test RubricRing`
Expected: FAIL (cannot find `./RubricRing`).

- [ ] **Step 3: Write minimal implementation**

Create `packages/marketplace/src/RubricRing.tsx`:

```tsx
import type { RubricCheck } from "./types";

/** Compact ring showing how many rubric checks pass (of total). Brand-green fill on a neutral track. */
export function RubricRing({ checks }: { checks: RubricCheck[] }) {
  const total = checks.length;
  const pass = checks.filter((c) => c.pass).length;
  const pct = total ? Math.round((pass / total) * 100) : 0;
  const label = `${pass} of ${total} checks pass`;
  return (
    <span
      className="ex-rubric-ring"
      title={label}
      aria-label={label}
      style={{ background: `conic-gradient(#3a7d44 ${pct}%, #e6e8eb ${pct}%)` }}
    >
      <span className="ex-rubric-ring-num">{pass}/{total}</span>
    </span>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/marketplace && pnpm test RubricRing`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/marketplace/src/RubricRing.tsx packages/marketplace/src/RubricRing.test.tsx
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "feat(marketplace): RubricRing component"
git show --stat HEAD
```

---

### Task 6: `OrgCatalog` page

The list view: header + counts, search/cut-filter/sort controls, rows with `CutBadge` + `StoneRating` + `RubricRing` + an expandable rubric checklist. States: loading / not-found / empty / ok.

**Files:**
- Create: `packages/marketplace/src/pages/OrgCatalog.tsx`
- Modify: `packages/marketplace/src/styles.css` (append component styles)
- Test: `packages/marketplace/src/pages/OrgCatalog.test.tsx`

**Interfaces:**
- Consumes: `makeApi` (`api.getOrgCatalog`), `OrgCatalog` type, `CutBadge`, `StoneRating`, `RubricRing`.
- Produces: `OrgCatalog({ api, scope }: { api: ReturnType<typeof makeApi>; scope: string })`.

- [ ] **Step 1: Write the failing test**

Create `packages/marketplace/src/pages/OrgCatalog.test.tsx`:

```tsx
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, within } from "@testing-library/react";
import { OrgCatalog } from "./OrgCatalog";
import type { OrgCatalog as OrgCatalogT, OrgCatalogGem } from "../types";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const gem = (over: Partial<OrgCatalogGem>): OrgCatalogGem => ({
  key: "@acme/a", version: "1.0.0", cut: "skill", grade: 2, owner: "dev", description: "desc",
  stars: 1, installs: 0, verifiedInstalls: 0,
  rubric: { score: 0.8, checks: [
    { id: "documented", label: "Documented", pass: true, howToFix: "add docs" },
    { id: "battleTested", label: "Battle-tested", pass: false, howToFix: "raise the grade" },
  ] },
  ...over,
});
const cat = (gems: OrgCatalogGem[]): OrgCatalogT => ({ scope: "acme", gemCount: gems.length, ownerCount: new Set(gems.map((g) => g.owner)).size, gems });
const apiWith = (c: OrgCatalogT | null) => ({ getOrgCatalog: () => Promise.resolve(c) }) as never;

describe("OrgCatalog page", () => {
  it("renders header counts and a gem row linking to the gem", async () => {
    render(<OrgCatalog api={apiWith(cat([gem({})]))} scope="acme" />);
    expect(await screen.findByRole("heading", { name: /acme/ })).toBeTruthy();
    expect(screen.getByText(/1 gems · 1 owners/)).toBeTruthy();
    const link = screen.getByText("@acme/a").closest("a");
    expect(link?.getAttribute("href")).toBe("/gems/" + encodeURIComponent("@acme/a"));
  });

  it("shows the empty state for an org with no gems", async () => {
    render(<OrgCatalog api={apiWith(cat([]))} scope="acme" />);
    expect(await screen.findByText(/no gems published under @acme yet/i)).toBeTruthy();
  });

  it("shows not-found when the catalog is null", async () => {
    render(<OrgCatalog api={apiWith(null)} scope="ghost" />);
    expect(await screen.findByText(/no catalog for @ghost/i)).toBeTruthy();
  });

  it("filters by search text", async () => {
    render(<OrgCatalog api={apiWith(cat([gem({ key: "@acme/alpha" }), gem({ key: "@acme/beta", owner: "dev2" })]))} scope="acme" />);
    await screen.findByText("@acme/alpha");
    fireEvent.change(screen.getByLabelText(/search gems/i), { target: { value: "beta" } });
    expect(screen.queryByText("@acme/alpha")).toBeNull();
    expect(screen.getByText("@acme/beta")).toBeTruthy();
  });

  it("expands the rubric checklist on demand, showing how-to-fix for failing checks", async () => {
    render(<OrgCatalog api={apiWith(cat([gem({})]))} scope="acme" />);
    await screen.findByText("@acme/a");
    fireEvent.click(screen.getByRole("button", { name: /rubric/i }));
    expect(screen.getByText("Battle-tested")).toBeTruthy();
    expect(screen.getByText("raise the grade")).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/marketplace && pnpm test OrgCatalog`
Expected: FAIL (cannot find `./OrgCatalog`).

- [ ] **Step 3: Write minimal implementation**

Create `packages/marketplace/src/pages/OrgCatalog.tsx`:

```tsx
import { useEffect, useMemo, useState } from "react";
import type { makeApi } from "../api";
import type { OrgCatalog as OrgCatalogT } from "../types";
import { CutBadge } from "../CutBadge";
import { StoneRating } from "../StoneRating";
import { RubricRing } from "../RubricRing";

type View = { status: "loading" } | { status: "notfound" } | { status: "ok"; catalog: OrgCatalogT };
type Sort = "grade" | "stone";

export function OrgCatalog({ api, scope }: { api: ReturnType<typeof makeApi>; scope: string }) {
  const [view, setView] = useState<View>({ status: "loading" });
  const [q, setQ] = useState("");
  const [cut, setCut] = useState("");
  const [sort, setSort] = useState<Sort>("grade");
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api.getOrgCatalog(scope)
      .then((c) => { if (alive) setView(c ? { status: "ok", catalog: c } : { status: "notfound" }); })
      .catch(() => { if (alive) setView({ status: "notfound" }); });
    return () => { alive = false; };
  }, [api, scope]);

  const gems = view.status === "ok" ? view.catalog.gems : [];
  const cuts = useMemo(() => [...new Set(gems.map((g) => g.cut).filter((c): c is string => !!c))].sort(), [gems]);
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const filtered = gems.filter((g) =>
      (!cut || g.cut === cut) &&
      (!needle || g.key.toLowerCase().includes(needle) || (g.description ?? "").toLowerCase().includes(needle)));
    return [...filtered].sort((a, b) =>
      sort === "stone"
        ? b.stars - a.stars || (b.grade ?? 0) - (a.grade ?? 0) || a.key.localeCompare(b.key)
        : (b.grade ?? 0) - (a.grade ?? 0) || b.stars - a.stars || a.key.localeCompare(b.key));
  }, [gems, q, cut, sort]);

  if (view.status === "loading") return <div className="ex-orgcat"><p className="ex-empty">Loading…</p></div>;
  if (view.status === "notfound") return <div className="ex-orgcat"><p className="ex-empty">No catalog for @{scope}.</p></div>;

  const c = view.catalog;
  return (
    <div className="ex-orgcat">
      <header className="ex-orgcat-head">
        <h2 className="ex-orgcat-title">@{c.scope}</h2>
        <span className="ex-orgcat-counts">{c.gemCount} gems · {c.ownerCount} owners</span>
      </header>
      {c.gemCount === 0 ? (
        <p className="ex-empty">No gems published under @{c.scope} yet.</p>
      ) : (
        <>
          <div className="ex-orgcat-controls">
            <input className="ex-orgcat-search" type="search" placeholder="Search gems…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search gems" />
            <select className="ex-orgcat-cut" value={cut} onChange={(e) => setCut(e.target.value)} aria-label="Filter by cut">
              <option value="">All cuts</option>
              {cuts.map((ct) => <option key={ct} value={ct}>{ct}</option>)}
            </select>
            <select className="ex-orgcat-sort" value={sort} onChange={(e) => setSort(e.target.value as Sort)} aria-label="Sort by">
              <option value="grade">Sort: grade</option>
              <option value="stone">Sort: stone</option>
            </select>
          </div>
          <ul className="ex-gem-list">
            {shown.map((g) => (
              <li key={g.key} className="ex-gem-item">
                <div className="ex-gem-card">
                  <span className="ex-gem-head">
                    <a className="ex-gem-key" href={"/gems/" + encodeURIComponent(g.key)}>{g.key}</a>
                    <CutBadge cut={g.cut ?? undefined} />
                    <StoneRating cut={g.cut ?? undefined} grade={g.grade ?? undefined} stars={g.stars} installs={g.installs} verifiedInstalls={g.verifiedInstalls} />
                    <RubricRing checks={g.rubric.checks} />
                    <button type="button" className="ex-rubric-toggle" aria-expanded={open === g.key} onClick={() => setOpen(open === g.key ? null : g.key)}>
                      {open === g.key ? "Hide rubric" : "Rubric"}
                    </button>
                  </span>
                  {g.description && <span className="ex-gem-desc">{g.description}</span>}
                  {open === g.key && (
                    <ul className="ex-rubric-detail">
                      {g.rubric.checks.map((ch) => (
                        <li key={ch.id} className="ex-rubric-check" data-pass={ch.pass ? "true" : "false"}>
                          <span className="ex-rubric-mark">{ch.pass ? "✓" : "✗"}</span>
                          <span className="ex-rubric-label">{ch.label}</span>
                          {!ch.pass && <span className="ex-rubric-fix">{ch.howToFix}</span>}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
```

Append to `packages/marketplace/src/styles.css`:

```css
/* Org scorecard catalog */
.ex-orgcat { max-width: 880px; margin: 0 auto; padding: 1rem; }
.ex-orgcat-head { display: flex; align-items: baseline; gap: 0.75rem; margin-bottom: 0.75rem; }
.ex-orgcat-title { margin: 0; }
.ex-orgcat-counts { color: #8a8f98; font-size: 0.9rem; }
.ex-orgcat-controls { display: flex; gap: 0.5rem; margin-bottom: 0.75rem; flex-wrap: wrap; }
.ex-orgcat-search { flex: 1 1 12rem; padding: 0.35rem 0.5rem; }
.ex-orgcat-cut, .ex-orgcat-sort { padding: 0.35rem 0.5rem; }
.ex-rubric-ring { display: inline-flex; align-items: center; justify-content: center; width: 2.4rem; height: 2.4rem; border-radius: 50%; }
.ex-rubric-ring-num { background: #fff; border-radius: 50%; width: 1.8rem; height: 1.8rem; display: inline-flex; align-items: center; justify-content: center; font-size: 0.72rem; font-weight: 600; }
.ex-rubric-toggle { background: none; border: 1px solid #d0d3d8; border-radius: 4px; padding: 0.15rem 0.5rem; cursor: pointer; font-size: 0.8rem; }
.ex-rubric-detail { list-style: none; margin: 0.5rem 0 0; padding: 0; display: flex; flex-direction: column; gap: 0.25rem; }
.ex-rubric-check { display: flex; gap: 0.5rem; align-items: baseline; font-size: 0.85rem; }
.ex-rubric-check[data-pass="true"] .ex-rubric-mark { color: #3a7d44; }
.ex-rubric-check[data-pass="false"] .ex-rubric-mark { color: #b04a4a; }
.ex-rubric-fix { color: #8a8f98; }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/marketplace && pnpm test OrgCatalog`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/marketplace/src/pages/OrgCatalog.tsx packages/marketplace/src/pages/OrgCatalog.test.tsx packages/marketplace/src/styles.css
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "feat(marketplace): OrgCatalog scorecard page"
git show --stat HEAD
```

---

### Task 7: Route `/orgs/:scope` in the marketplace Router

**Files:**
- Modify: `packages/marketplace/src/Router.tsx` (import + route match)
- Test: `packages/marketplace/src/Router.test.tsx` (add a case)

**Interfaces:**
- Consumes: `OrgCatalog` page (Task 6).
- Produces: a `/orgs/:scope` path rendering `<OrgCatalog api scope>`.

- [ ] **Step 1: Write the failing test**

Add to `packages/marketplace/src/Router.test.tsx` a case that drives the `/orgs/acme` path. Mirror the file's existing pattern for setting `window.location.pathname` and rendering `<Router …>`; assert the org catalog renders. Use the existing test's helpers/mocks for `api`/`stars`/`me`, overriding `getOrgCatalog`:

```tsx
it("routes /orgs/:scope to the OrgCatalog page", async () => {
  window.history.pushState({}, "", "/orgs/acme");
  const api = { getOrgCatalog: () => Promise.resolve({ scope: "acme", gemCount: 0, ownerCount: 0, gems: [] }) } as never;
  render(<Router api={api} stars={{ signedIn: false, loginUrl: () => "", api: {} as never }} me={null} />);
  expect(await screen.findByText(/no gems published under @acme yet/i)).toBeTruthy();
});
```

(If `Router.test.tsx` lacks `screen`/`render` imports, add `import { render, screen } from "@testing-library/react";` at the top.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/marketplace && pnpm test Router`
Expected: FAIL (renders the Leaderboard fallback, not the org empty-state text).

- [ ] **Step 3: Write minimal implementation**

In `packages/marketplace/src/Router.tsx`:
- Add the import next to the other page imports:

```tsx
import { OrgCatalog } from "./pages/OrgCatalog";
```

- Add the route match immediately before the final `return <Leaderboard … />;` (after the `prof` match):

```tsx
  const org = path.match(/^\/orgs\/([^/]+)$/);
  if (org) return <OrgCatalog api={api} scope={decodeURIComponent(org[1])} />;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/marketplace && pnpm test Router`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/marketplace/src/Router.tsx packages/marketplace/src/Router.test.tsx
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "feat(marketplace): route /orgs/:scope to OrgCatalog"
git show --stat HEAD
```

---

### Task 8: Full-suite verification & handoff notes

**Files:** none (verification only).

- [ ] **Step 1: Backend suite green**

Run: `pnpm test`
Expected: PASS (includes the 3 new backend test files; no regressions).

- [ ] **Step 2: Marketplace typecheck green**

Run: `cd packages/marketplace && pnpm typecheck`
Expected: no errors. (Reminder: `pnpm test` does NOT typecheck — this step is mandatory.)

- [ ] **Step 3: Marketplace suite green**

Run: `cd packages/marketplace && pnpm test`
Expected: PASS (includes RubricRing, api, OrgCatalog, Router).

- [ ] **Step 4: Marketplace builds**

Run: `cd packages/marketplace && pnpm build`
Expected: vite build succeeds.

- [ ] **Step 5: Confirm branch is ahead-only, then note the deploy gate**

Run:
```bash
git fetch origin && git rev-list --left-right --count origin/main...HEAD
```
Expected: left count `0` (ahead-only). If not, `git rebase origin/main`.

Record at handoff: `/orgs/:scope` renders against `GET /api/aggregator/org-catalog`, which only serves after **`api.agentgem.ai` redeploys**. Until then the page shows the not-found state in production. This matches SP2's deploy gate.

---

## Self-Review

**Spec coverage** (`2026-07-03-org-scorecard-catalog-design.md`):
- §3 architecture (hosted `/orgs/:scope` + `GET /api/aggregator/org-catalog`) → Tasks 3, 7 ✓
- §4.1 rubric (5 named checks, howToFix) → Task 1 ✓
- §4.2 `buildOrgCatalog` (scope filter, ownerCount, default sort) → Task 2 ✓
- §4.3 route (400 malformed, 200 empty) → Task 3 ✓
- §4.4 `OrgCatalog.tsx` (header, search, cut filter, sort, CutBadge/StoneRating, rubric ring) → Tasks 5, 6 ✓
- §4.5 rubric detail drawer (pass/fail + how-to-fix) → Task 6 (expandable checklist) ✓
- §6 error handling (400 malformed / 200 empty / non-silent notfound) → Tasks 3, 4, 6 ✓
- §7 testing (pure rubric, buildOrgCatalog with fake/test db, route, page render) → Tasks 1–7 ✓
- §8 D1 scope-from-key → Task 2 (`LIKE @scope/%`) ✓; D2 catalog-row signals only → Task 1 checks ✓; D3 public-first → no auth added ✓
- §9 out-of-scope items → none implemented ✓

Deviation from spec §4.2: the spec sketched an injectable `loadCatalog` dep reading the merged registry∪DB catalog; this plan reads `catalog_gems` directly via drizzle to match the shipped `buildProfile` exactly (same table, same test harness). Consequence: gems that exist only in the GitHub registry index but not in `catalog_gems` won't appear — acceptable for v1 since published gems are recorded in `catalog_gems` (the same source `buildProfile` relies on), and it keeps the code consistent with its template. Noted as an intentional simplification.

**Placeholder scan:** none — every step carries full code or an exact command.

**Type consistency:** `RubricInput`/`RubricCheck`/`RubricResult` (Task 1) are consumed unchanged by `buildOrgCatalog` (Task 2); `OrgCatalogGem`/`OrgCatalog` fields (`cut`, `owner`, `rubric.checks`) match across backend (Task 2/3 Zod), client types (Task 4), and the page/tests (Tasks 5–7). `getOrgCatalog` returns `OrgCatalog | null` everywhere. `computeGemRubric` signature identical in producer and consumers.
