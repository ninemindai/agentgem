# Console Insights UI (#42) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the console Insights page over the aggregator data-moat — a network-pulse strip, a trusted-adoption leaderboard, and per-ingredient drill-in (co-occurrence + adoption) — plus one small `/overview` endpoint, surfacing `verifiedProducers` (#42).

**Architecture:** One new public-read backend endpoint (`overview()` query + controller route) for network totals. A new console panel `panels/Insights/` (master–detail: pulse strip + leaderboard left, drill-in detail right) consuming four typed routes. Pure formatting + chart-math in `data.ts`; hand-rolled SVG charts (no new dependency).

**Tech Stack:** TypeScript, Drizzle (`sql`) on Postgres (backend); React 19 + `@agentback/client` `defineRoute` (console); vitest + @testing-library/react.

## Global Constraints

- Aggregator reads are public (CORS-open, `originGuard`-exempt) and k-anon-safe: `DEFAULT_K = 5` is enforced server-side; callers can NEVER pass `k` over HTTP.
- No new runtime dependencies (charts are hand-rolled SVG).
- Console package is `@agentgem/console`. Console tests: `pnpm -F @agentgem/console test [file]` (run on source). Root/backend tests run on COMPILED dist: `pnpm build` then `pnpm test [file]`.
- Git author `Raymond Feng <raymond@ninemind.ai>`; every commit ends with the trailer `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- Theme palette: producers `var(--accent)` (terracotta), verified `var(--emerald)`, invocations `var(--gold)`; muted `var(--muted)`. Respect `prefers-reduced-motion`.
- Ingredient ids are human-readable; prettify by stripping the prefix — do NOT add a name-resolution backend.

---

### Task 1: Backend `overview()` query + `GET /api/aggregator/overview`

**Files:**
- Modify: `src/aggregator/aggregates.ts` (add `overview`)
- Modify: `src/aggregator.controller.ts` (add `OverviewResult` + `@get("/overview")`)
- Test: `src/aggregator/__tests__/aggregates.test.ts` (add an overview describe block)

**Interfaces:**
- Produces: `overview(db: AppDb, opts?: { k?: number }): Promise<{ ingredients: number; producers: number; verifiedProducers: number; invocations: number; sessions: number }>`
- Consumes: existing `makeTestDb`, `projectAttestation`, `DEFAULT_K` from the aggregator package; `att(pubkey, digest, skills)` test helper already in `aggregates.test.ts`.

- [ ] **Step 1: Write the failing test** — append to `src/aggregator/__tests__/aggregates.test.ts`:

```ts
import { overview } from "../aggregates.js"; // add to the existing import line

describe("overview totals", () => {
  it("aggregates distinct ingredients/producers/verified + sums, k-anon safe", async () => {
    const db = await makeTestDb();
    // 5 producers so the network clears DEFAULT_K (>=5); two ingredients
    await projectAttestation(db, att("ed25519:p1", "d1", ["skill:a", "skill:b"]));
    await projectAttestation(db, att("ed25519:p2", "d2", ["skill:a"]));
    await projectAttestation(db, att("ed25519:p3", "d3", ["skill:a"]));
    await projectAttestation(db, att("ed25519:p4", "d4", ["skill:b"]));
    await projectAttestation(db, att("ed25519:p5", "d5", ["skill:b"]));
    const o = await overview(db, {});
    expect(o.ingredients).toBe(2);   // skill:a, skill:b
    expect(o.producers).toBe(5);     // p1..p5 distinct
    expect(o.verifiedProducers).toBe(0); // no account_bindings
    expect(o.invocations).toBeGreaterThan(0);
    expect(o.sessions).toBeGreaterThan(0);
  });

  it("returns all zeros when the whole network is below the k-anon floor", async () => {
    const db = await makeTestDb();
    await projectAttestation(db, att("ed25519:p1", "d1", ["skill:a"]));
    await projectAttestation(db, att("ed25519:p2", "d2", ["skill:a"]));
    const o = await overview(db, {}); // 2 producers < DEFAULT_K
    expect(o).toEqual({ ingredients: 0, producers: 0, verifiedProducers: 0, invocations: 0, sessions: 0 });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm build && pnpm test aggregates`
Expected: FAIL — `overview` is not exported.

- [ ] **Step 3: Implement `overview` in `src/aggregator/aggregates.ts`** (add after `popularity`):

```ts
export async function overview(
  db: AppDb, opts: { k?: number } = {},
): Promise<{ ingredients: number; producers: number; verifiedProducers: number; invocations: number; sessions: number }> {
  const k = opts.k ?? DEFAULT_K;
  const r = await db.execute<{ ingredients: number; producers: number; verifiedProducers: number; invocations: number; sessions: number }>(sql`
    select
      count(distinct e.ingredient_id)::int                   as ingredients,
      count(distinct a.producer_pubkey)::int                 as producers,
      count(distinct b.provider || ':' || b.account_id)::int as "verifiedProducers",
      coalesce(sum(e.invocations), 0)::int                   as invocations,
      coalesce(sum(e.sessions), 0)::int                      as sessions
    from usage_edges e
    join attestations a on a.id = e.attestation_id and not a.quarantined
    left join account_bindings b on b.pubkey = a.producer_pubkey
  `);
  const row = r.rows[0] ?? { ingredients: 0, producers: 0, verifiedProducers: 0, invocations: 0, sessions: 0 };
  // Safe-by-default: a whole network below the floor exposes nothing (mirrors popularity's HAVING).
  if (row.producers < k) return { ingredients: 0, producers: 0, verifiedProducers: 0, invocations: 0, sessions: 0 };
  return row;
}
```

- [ ] **Step 4: Wire the controller** — in `src/aggregator.controller.ts`: add `overview` to the aggregates import (`import { popularity, coOccurrence, adoption, overview } from "./aggregator/aggregates.js";`), add the schema after `AdoptResult` (line ~24):

```ts
const OverviewResult = z.object({ ingredients: z.number(), producers: z.number(), verifiedProducers: z.number(), invocations: z.number(), sessions: z.number() });
```

and add the method inside the class (after `adoption`):

```ts
  @get("/overview", { response: OverviewResult })
  async overview(): Promise<z.infer<typeof OverviewResult>> {
    // No query params; k is server policy (DEFAULT_K), never caller-supplied.
    return overview(this.db, {});
  }
```

- [ ] **Step 5: Run to verify it passes**

Run: `pnpm build && pnpm test aggregates`
Expected: PASS (both new cases).

- [ ] **Step 6: Commit**

```bash
git add src/aggregator/aggregates.ts src/aggregator.controller.ts src/aggregator/__tests__/aggregates.test.ts
git commit -m "feat(aggregator): GET /overview — k-anon-safe network totals"
```

---

### Task 2: Console data layer — routes + pure `data.ts` helpers

**Files:**
- Modify: `packages/console/src/api/routes.ts` (4 routes + exported types)
- Create: `packages/console/src/panels/Insights/data.ts`
- Test: `packages/console/src/panels/Insights/data.test.ts`

**Interfaces:**
- Produces (routes.ts): `popularityRoute`, `coOccurrenceRoute`, `adoptionRoute`, `overviewRoute`; types `AggIngredient`, `AggCoOccurrence`, `AdoptionPoint`, `AggOverview`.
- Produces (data.ts): `prettifyId(id: string, kind: string): { name: string; scope?: string }`; `kindLabel(kind: string): string`; `verifiedShare(producers: number, verified: number): number`; `barWidths(values: number[]): number[]`; `sparkPoints(values: number[], w: number, h: number, max?: number): string`.
- Consumes: `defineRoute`, `z` (already imported at top of routes.ts).

- [ ] **Step 1: Add the routes** to `packages/console/src/api/routes.ts` (after `usageRoute`, before the workspace block):

```ts
// ── Aggregator insights (public-read; k-anon enforced server-side) ──
const AggIngredientSchema = z.object({
  id: z.string(), kind: z.string(), producers: z.number(),
  verifiedProducers: z.number(), invocations: z.number(), sessions: z.number(),
});
const AggCoOccurrenceSchema = z.object({ id: z.string(), producers: z.number(), verifiedProducers: z.number() });
const AdoptionPointSchema = z.object({ bucket: z.string(), producers: z.number(), verifiedProducers: z.number(), invocations: z.number() });
const AggOverviewSchema = z.object({ ingredients: z.number(), producers: z.number(), verifiedProducers: z.number(), invocations: z.number(), sessions: z.number() });

export const popularityRoute = defineRoute("GET", "/api/aggregator/popularity", {
  query: z.object({ kind: z.string().optional(), limit: z.number().optional() }),
  response: z.array(AggIngredientSchema),
});
export const coOccurrenceRoute = defineRoute("GET", "/api/aggregator/co-occurrence", {
  query: z.object({ id: z.string(), limit: z.number().optional() }),
  response: z.array(AggCoOccurrenceSchema),
});
export const adoptionRoute = defineRoute("GET", "/api/aggregator/adoption", {
  query: z.object({ id: z.string(), bucket: z.enum(["week", "month"]).optional() }),
  response: z.array(AdoptionPointSchema),
});
export const overviewRoute = defineRoute("GET", "/api/aggregator/overview", { response: AggOverviewSchema });

export type AggIngredient = z.infer<typeof AggIngredientSchema>;
export type AggCoOccurrence = z.infer<typeof AggCoOccurrenceSchema>;
export type AdoptionPoint = z.infer<typeof AdoptionPointSchema>;
export type AggOverview = z.infer<typeof AggOverviewSchema>;
```

- [ ] **Step 2: Write the failing test** — `packages/console/src/panels/Insights/data.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { prettifyId, kindLabel, verifiedShare, barWidths, sparkPoints } from "./data.js";

describe("prettifyId", () => {
  it("splits plugin skills/mcps into name + scope", () => {
    expect(prettifyId("skill:superpowers/brainstorming", "skill")).toEqual({ name: "brainstorming", scope: "superpowers" });
    expect(prettifyId("mcp:plug/server", "mcp")).toEqual({ name: "server", scope: "plug" });
  });
  it("treats a package runner prefix as the scope", () => {
    expect(prettifyId("npx:@modelcontextprotocol/server-github", "mcp")).toEqual({ name: "@modelcontextprotocol/server-github", scope: "npx" });
  });
  it("labels url mcps", () => {
    expect(prettifyId("url:api.github.com", "mcp")).toEqual({ name: "api.github.com", scope: "url" });
  });
  it("passes through models/harness/registry ids with no prefix", () => {
    expect(prettifyId("claude-opus-4-8", "model")).toEqual({ name: "claude-opus-4-8" });
    expect(prettifyId("claude-code", "harness")).toEqual({ name: "claude-code" });
  });
});

describe("kindLabel", () => {
  it("maps known kinds and falls through", () => {
    expect(kindLabel("skill")).toBe("Skill");
    expect(kindLabel("mcp")).toBe("MCP");
    expect(kindLabel("widget")).toBe("widget");
  });
});

describe("verifiedShare", () => {
  it("is verified/producers clamped to [0,1], 0 when no producers", () => {
    expect(verifiedShare(10, 4)).toBeCloseTo(0.4);
    expect(verifiedShare(0, 0)).toBe(0);
    expect(verifiedShare(3, 5)).toBe(1); // clamp (shouldn't exceed, but be safe)
  });
});

describe("barWidths", () => {
  it("normalizes against the max (max => 1)", () => {
    expect(barWidths([5, 10, 0])).toEqual([0.5, 1, 0]);
    expect(barWidths([])).toEqual([]);
  });
});

describe("sparkPoints", () => {
  it("returns '' for empty and a flat baseline for a single point", () => {
    expect(sparkPoints([], 100, 40)).toBe("");
    expect(sparkPoints([7], 100, 40)).toBe("0,0 100,0"); // single value pins to top (its own max)
  });
  it("maps values to x across width and inverts y (taller = higher value)", () => {
    expect(sparkPoints([0, 10], 100, 40)).toBe("0.0,40.0 100.0,0.0");
  });
  it("honors an explicit shared max (for overlaying verified on producers)", () => {
    expect(sparkPoints([5], 100, 40, 10)).toBe("0,20 100,20");
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm -F @agentgem/console test data.test`
Expected: FAIL — cannot find `./data.js`.

- [ ] **Step 4: Implement `packages/console/src/panels/Insights/data.ts`:**

```ts
/** Pure formatting + chart-math for the Insights panel. */

export interface PrettyId { name: string; scope?: string }

/** Public ingredient ids are self-describing — strip the prefix into name (+ scope). */
export function prettifyId(id: string, _kind: string): PrettyId {
  const colon = id.indexOf(":");
  if (colon <= 0) return { name: id }; // model / harness / registry @scope/... — show as-is
  const prefix = id.slice(0, colon);
  const rest = id.slice(colon + 1);
  if (prefix === "skill" || prefix === "mcp") {
    const slash = rest.indexOf("/");
    return slash > 0 ? { name: rest.slice(slash + 1), scope: rest.slice(0, slash) } : { name: rest };
  }
  if (prefix === "url") return { name: rest, scope: "url" };
  return { name: rest, scope: prefix }; // package runner (npx:, uvx:, …)
}

const KIND_LABELS: Record<string, string> = { skill: "Skill", mcp: "MCP", model: "Model", harness: "Harness" };
export function kindLabel(kind: string): string { return KIND_LABELS[kind] ?? kind; }

export function verifiedShare(producers: number, verified: number): number {
  return producers > 0 ? Math.min(1, verified / producers) : 0;
}

export function barWidths(values: number[]): number[] {
  if (values.length === 0) return [];
  const max = Math.max(1, ...values);
  return values.map((v) => v / max);
}

/** Space-separated "x,y" points for an SVG polyline; y inverted so taller = bigger.
 *  `max` lets a verified series share the producers' scale for overlay. */
export function sparkPoints(values: number[], w: number, h: number, max = Math.max(1, ...values)): string {
  if (values.length === 0) return "";
  if (values.length === 1) { const y = (h - (values[0] / max) * h).toFixed(0); return `0,${y} ${w},${y}`; }
  const step = w / (values.length - 1);
  return values.map((v, i) => `${(i * step).toFixed(1)},${(h - (v / max) * h).toFixed(1)}`).join(" ");
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `pnpm -F @agentgem/console test data.test`
Expected: PASS.

- [ ] **Step 6: Typecheck + commit**

```bash
pnpm -F @agentgem/console typecheck
git add packages/console/src/api/routes.ts packages/console/src/panels/Insights/data.ts packages/console/src/panels/Insights/data.test.ts
git commit -m "feat(console): aggregator insight routes + pure data helpers"
```

---

### Task 3: `Sparkline` SVG chart

**Files:**
- Create: `packages/console/src/panels/Insights/Sparkline.tsx`
- Test: `packages/console/src/panels/Insights/Sparkline.test.tsx`

**Interfaces:**
- Produces: `Sparkline(props: { values: number[]; verified?: number[]; width?: number; height?: number }): ReactNode`
- Consumes: `sparkPoints` from `./data.js`.

- [ ] **Step 1: Write the failing test** — `Sparkline.test.tsx`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { Sparkline } from "./Sparkline.js";

afterEach(cleanup);

describe("Sparkline", () => {
  it("renders an empty hint when there is no data", () => {
    const { container } = render(<Sparkline values={[]} />);
    expect(container.querySelector("svg")).toBeNull();
    expect(container.textContent).toMatch(/no data/i);
  });
  it("draws a producers polyline and, when given verified, a second overlay", () => {
    const { container } = render(<Sparkline values={[1, 3, 7]} verified={[0, 1, 4]} />);
    expect(container.querySelectorAll("polyline").length).toBe(2);
  });
  it("draws a single producers polyline when no verified series", () => {
    const { container } = render(<Sparkline values={[2, 4]} />);
    expect(container.querySelectorAll("polyline").length).toBe(1);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm -F @agentgem/console test Sparkline`
Expected: FAIL — cannot find `./Sparkline.js`.

- [ ] **Step 3: Implement `Sparkline.tsx`:**

```tsx
import { sparkPoints } from "./data.js";

/** Hand-rolled SVG line chart. Producers in terracotta; optional verified overlay in
 *  emerald, drawn on the producers' scale (verified <= producers). No dependencies. */
export function Sparkline({ values, verified, width = 220, height = 48 }: {
  values: number[]; verified?: number[]; width?: number; height?: number;
}) {
  if (values.length === 0) return <div className="ins-spark-empty">no data yet</div>;
  const max = Math.max(1, ...values);
  return (
    <svg className="ins-spark" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label="adoption trend">
      <polyline points={sparkPoints(values, width, height, max)} fill="none" stroke="var(--accent)" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
      {verified && verified.length > 0 && (
        <polyline points={sparkPoints(verified, width, height, max)} fill="none" stroke="var(--emerald)" strokeWidth="1.5" strokeDasharray="3 2" strokeLinejoin="round" strokeLinecap="round" />
      )}
    </svg>
  );
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm -F @agentgem/console test Sparkline`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/console/src/panels/Insights/Sparkline.tsx packages/console/src/panels/Insights/Sparkline.test.tsx
git commit -m "feat(console): Sparkline SVG chart for adoption"
```

---

### Task 4: `Leaderboard` + kind filter (presentational)

**Files:**
- Create: `packages/console/src/panels/Insights/Leaderboard.tsx`
- Test: `packages/console/src/panels/Insights/Leaderboard.test.tsx`

**Interfaces:**
- Produces: `Leaderboard(props: { rows: AggIngredient[]; kind: string; onKind: (k: string) => void; selectedId: string | null; onSelect: (id: string) => void }): ReactNode`. `kind` is `"all"` or a kind value.
- Consumes: `AggIngredient` from `../../api/routes.js`; `prettifyId`, `kindLabel`, `verifiedShare`, `barWidths` from `./data.js`.

- [ ] **Step 1: Write the failing test** — `Leaderboard.test.tsx`:

```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { Leaderboard } from "./Leaderboard.js";

afterEach(cleanup);

const rows = [
  { id: "skill:superpowers/brainstorming", kind: "skill", producers: 80, verifiedProducers: 40, invocations: 200, sessions: 90 },
  { id: "npx:@mcp/github", kind: "mcp", producers: 30, verifiedProducers: 9, invocations: 50, sessions: 25 },
];

describe("Leaderboard", () => {
  it("renders prettified rows with producer + verified counts", () => {
    render(<Leaderboard rows={rows} kind="all" onKind={() => {}} selectedId={null} onSelect={() => {}} />);
    expect(screen.getByText("brainstorming")).toBeTruthy();
    expect(screen.getByText("@mcp/github")).toBeTruthy();
    expect(screen.getByText(/40 verified/i)).toBeTruthy();
  });
  it("calls onSelect with the row id when clicked", () => {
    const onSelect = vi.fn();
    render(<Leaderboard rows={rows} kind="all" onKind={() => {}} selectedId={null} onSelect={onSelect} />);
    fireEvent.click(screen.getByText("brainstorming"));
    expect(onSelect).toHaveBeenCalledWith("skill:superpowers/brainstorming");
  });
  it("calls onKind when a filter tab is clicked", () => {
    const onKind = vi.fn();
    render(<Leaderboard rows={rows} kind="all" onKind={onKind} selectedId={null} onSelect={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Skill" }));
    expect(onKind).toHaveBeenCalledWith("skill");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm -F @agentgem/console test Leaderboard`
Expected: FAIL — cannot find `./Leaderboard.js`.

- [ ] **Step 3: Implement `Leaderboard.tsx`:**

```tsx
import type { AggIngredient } from "../../api/routes.js";
import { prettifyId, kindLabel, verifiedShare, barWidths } from "./data.js";

// Tools-only (product decision): Insights ranks shareable ingredients — skills + MCPs.
// "All" maps to no `kind` param, which the backend popularity() defaults to skill+mcp.
const KINDS: { value: string; label: string }[] = [
  { value: "all", label: "All" }, { value: "skill", label: "Skill" }, { value: "mcp", label: "MCP" },
];

export function Leaderboard({ rows, kind, onKind, selectedId, onSelect }: {
  rows: AggIngredient[]; kind: string; onKind: (k: string) => void;
  selectedId: string | null; onSelect: (id: string) => void;
}) {
  const widths = barWidths(rows.map((r) => r.producers));
  return (
    <div className="ins-board">
      <div className="ins-tabs">
        {KINDS.map((k) => (
          <button key={k.value} type="button"
            className={"ins-tab" + (k.value === kind ? " is-active" : "")}
            onClick={() => onKind(k.value)}>{k.label}</button>
        ))}
      </div>
      {rows.length === 0 && <div className="ins-empty">No ingredients above the k-anonymity floor yet.</div>}
      <ol className="ins-rows">
        {rows.map((r, i) => {
          const p = prettifyId(r.id, r.kind);
          return (
            <li key={r.id}>
              <button type="button"
                className={"ins-row" + (r.id === selectedId ? " is-active" : "")}
                onClick={() => onSelect(r.id)}>
                <span className="ins-rank">{i + 1}</span>
                <span className="ins-name">{p.name}{p.scope && <span className="ins-scope">{p.scope}</span>}</span>
                <span className="ins-kind">{kindLabel(r.kind)}</span>
                <span className="ins-bar"><span className="ins-bar-fill" style={{ width: `${(widths[i] * 100).toFixed(0)}%` }} /></span>
                <span className="ins-counts">
                  {r.producers} producers
                  <span className="ins-verified" title="GitHub-bound, signature-verified producers"> · {r.verifiedProducers} verified ✓</span>
                </span>
                <span className="ins-vshare"><span className="ins-vshare-fill" style={{ width: `${(verifiedShare(r.producers, r.verifiedProducers) * 100).toFixed(0)}%` }} /></span>
              </button>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm -F @agentgem/console test Leaderboard`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/console/src/panels/Insights/Leaderboard.tsx packages/console/src/panels/Insights/Leaderboard.test.tsx
git commit -m "feat(console): Insights leaderboard + kind filter"
```

---

### Task 5: `Detail` drill-in (co-occurrence + adoption)

**Files:**
- Create: `packages/console/src/panels/Insights/Detail.tsx`
- Test: `packages/console/src/panels/Insights/Detail.test.tsx`

**Interfaces:**
- Produces: `Detail(props: { id: string; apiBase: string }): ReactNode`
- Consumes: `coOccurrenceRoute`, `adoptionRoute`, `makeClient`, `AggCoOccurrence`, `AdoptionPoint` from `../../api/routes.js`; `prettifyId` from `./data.js`; `Sparkline` from `./Sparkline.js`. Each artifact's `kind` is unknown here (the routes return only ids); pass `"skill"` to `prettifyId` (kind only affects the unused `_kind` arg).

- [ ] **Step 1: Write the failing test** — `Detail.test.tsx`:

```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { Detail } from "./Detail.js";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const res = (body: unknown) =>
  ({ ok: true, status: 200, text: async () => JSON.stringify(body) }) as unknown as Response;

function stub(co: unknown[], adoption: unknown[]) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.includes("/co-occurrence")) return res(co);
    if (url.includes("/adoption")) return res(adoption);
    throw new Error("unexpected " + url);
  }));
}

describe("Detail", () => {
  it("renders co-occurrence partners and an adoption chart for the id", async () => {
    stub(
      [{ id: "skill:superpowers/writing-plans", producers: 60, verifiedProducers: 30 }],
      [{ bucket: "2026-06-01", producers: 10, verifiedProducers: 4, invocations: 22 },
       { bucket: "2026-06-08", producers: 18, verifiedProducers: 9, invocations: 40 }],
    );
    const { container } = render(<Detail id="skill:superpowers/brainstorming" apiBase="" />);
    await screen.findByText("writing-plans");
    expect(screen.getByText(/used together with/i)).toBeTruthy();
    await waitFor(() => expect(container.querySelector(".ins-spark")).toBeTruthy());
  });

  it("shows an empty hint when there is no co-occurrence data", async () => {
    stub([], []);
    render(<Detail id="skill:x" apiBase="" />);
    await waitFor(() => expect(screen.getByText(/not enough data yet/i)).toBeTruthy());
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm -F @agentgem/console test Detail`
Expected: FAIL — cannot find `./Detail.js`.

- [ ] **Step 3: Implement `Detail.tsx`:**

```tsx
import { useEffect, useState } from "react";
import {
  coOccurrenceRoute, adoptionRoute, makeClient,
  type AggCoOccurrence, type AdoptionPoint,
} from "../../api/routes.js";
import { prettifyId } from "./data.js";
import { Sparkline } from "./Sparkline.js";

export function Detail({ id, apiBase }: { id: string; apiBase: string }) {
  const [co, setCo] = useState<AggCoOccurrence[]>([]);
  const [series, setSeries] = useState<AdoptionPoint[]>([]);
  const [bucket, setBucket] = useState<"week" | "month">("week");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true); setError(null);
    const client = makeClient(apiBase);
    Promise.all([
      coOccurrenceRoute.call(client, { query: { id } }),
      adoptionRoute.call(client, { query: { id, bucket } }),
    ]).then(([c, a]) => { if (!alive) return; setCo(c); setSeries(a); })
      .catch((e) => { if (alive) setError(String(e?.message ?? e)); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [id, bucket, apiBase]);

  const head = prettifyId(id, "skill");
  if (error) return <div className="ins-detail"><p className="ins-error">Couldn’t load insight: {error}</p></div>;

  return (
    <div className="ins-detail">
      <div className="ins-detail-head">
        <span className="ins-detail-name">{head.name}</span>
        {head.scope && <span className="ins-scope">{head.scope}</span>}
      </div>

      <section className="ins-card">
        <h4>Used together with</h4>
        {!loading && co.length === 0 && <p className="ins-empty">Not enough data yet.</p>}
        <ul className="ins-co">
          {co.map((c) => {
            const p = prettifyId(c.id, "skill");
            return (
              <li key={c.id}>
                <span className="ins-co-name">{p.name}</span>
                <span className="ins-counts">{c.producers} · {c.verifiedProducers} ✓</span>
              </li>
            );
          })}
        </ul>
      </section>

      <section className="ins-card">
        <div className="ins-card-head">
          <h4>Adoption</h4>
          <div className="ins-bucket">
            {(["week", "month"] as const).map((b) => (
              <button key={b} type="button" className={"ins-bucket-btn" + (b === bucket ? " is-active" : "")} onClick={() => setBucket(b)}>{b}</button>
            ))}
          </div>
        </div>
        <Sparkline values={series.map((s) => s.producers)} verified={series.map((s) => s.verifiedProducers)} />
        <p className="ins-legend"><span className="ins-dot ins-dot-prod" /> producers <span className="ins-dot ins-dot-ver" /> verified</p>
      </section>
    </div>
  );
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm -F @agentgem/console test Detail`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/console/src/panels/Insights/Detail.tsx packages/console/src/panels/Insights/Detail.test.tsx
git commit -m "feat(console): Insights detail — co-occurrence + adoption drill-in"
```

---

### Task 6: `Pulse` strip (presentational)

**Files:**
- Create: `packages/console/src/panels/Insights/Pulse.tsx`
- Test: `packages/console/src/panels/Insights/Pulse.test.tsx`

**Interfaces:**
- Produces: `Pulse(props: { data: AggOverview | null; loading: boolean }): ReactNode`
- Consumes: `AggOverview` from `../../api/routes.js`; `verifiedShare` from `./data.js`.

- [ ] **Step 1: Write the failing test** — `Pulse.test.tsx`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { Pulse } from "./Pulse.js";

afterEach(cleanup);

describe("Pulse", () => {
  it("renders totals and a verified percentage", () => {
    render(<Pulse data={{ ingredients: 120, producers: 50, verifiedProducers: 20, invocations: 999, sessions: 300 }} loading={false} />);
    expect(screen.getByText(/120/)).toBeTruthy();
    expect(screen.getByText(/50 producers/i)).toBeTruthy();
    expect(screen.getByText(/40%/)).toBeTruthy(); // 20/50 verified
  });
  it("shows a below-floor message when the network has no exposable producers", () => {
    render(<Pulse data={{ ingredients: 0, producers: 0, verifiedProducers: 0, invocations: 0, sessions: 0 }} loading={false} />);
    expect(screen.getByText(/not enough producers yet/i)).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm -F @agentgem/console test Pulse`
Expected: FAIL — cannot find `./Pulse.js`.

- [ ] **Step 3: Implement `Pulse.tsx`:**

```tsx
import type { AggOverview } from "../../api/routes.js";
import { verifiedShare } from "./data.js";

export function Pulse({ data, loading }: { data: AggOverview | null; loading: boolean }) {
  if (loading || !data) return <div className="ins-pulse is-loading">Loading network pulse…</div>;
  if (data.producers === 0) return <div className="ins-pulse is-empty">Not enough producers yet — the network is below the k-anonymity floor.</div>;
  const pct = Math.round(verifiedShare(data.producers, data.verifiedProducers) * 100);
  return (
    <div className="ins-pulse">
      <span className="ins-pulse-label">Network pulse</span>
      <strong className="ins-stat">{data.ingredients.toLocaleString()}</strong><span className="ins-stat-unit">ingredients</span>
      <strong className="ins-stat">{data.producers.toLocaleString()}</strong><span className="ins-stat-unit">producers</span>
      <span className="ins-pulse-verified">{data.verifiedProducers.toLocaleString()} verified ✓ · {pct}%</span>
      <span className="ins-vshare ins-vshare-lg"><span className="ins-vshare-fill" style={{ width: `${pct}%` }} /></span>
      <span className="ins-stat-unit">{data.invocations.toLocaleString()} invocations</span>
    </div>
  );
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm -F @agentgem/console test Pulse`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/console/src/panels/Insights/Pulse.tsx packages/console/src/panels/Insights/Pulse.test.tsx
git commit -m "feat(console): Insights network-pulse strip"
```

---

### Task 7: `InsightsPage` wiring + registration + theme CSS

**Files:**
- Create: `packages/console/src/panels/Insights/index.tsx`
- Test: `packages/console/src/panels/Insights/Insights.test.tsx`
- Modify: `packages/console/src/pages.tsx` (import + array entry)
- Modify: `packages/console/src/shell/theme.css` (append `.ins-*` styles)
- Modify: `packages/console/src/pages.test.ts` (add `insights` to the library bucket assertion)

**Interfaces:**
- Produces: `insightsPage` (a `ConsolePage` via `defineConsolePage`), default-exported component `Insights`.
- Consumes: `defineConsolePage` from `../../registry.js`; `popularityRoute`, `overviewRoute`, `makeClient`, `AggIngredient`, `AggOverview` from `../../api/routes.js`; `Pulse`, `Leaderboard`, `Detail` from siblings.

- [ ] **Step 1: Write the failing test** — `Insights.test.tsx`:

```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { Insights } from "./index.js";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const res = (body: unknown) =>
  ({ ok: true, status: 200, text: async () => JSON.stringify(body) }) as unknown as Response;

const overview = { ingredients: 120, producers: 50, verifiedProducers: 20, invocations: 999, sessions: 300 };
const pop = [{ id: "skill:superpowers/brainstorming", kind: "skill", producers: 80, verifiedProducers: 40, invocations: 200, sessions: 90 }];

function stubAll() {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.includes("/overview")) return res(overview);
    if (url.includes("/popularity")) return res(pop);
    if (url.includes("/co-occurrence")) return res([{ id: "skill:superpowers/writing-plans", producers: 60, verifiedProducers: 30 }]);
    if (url.includes("/adoption")) return res([{ bucket: "2026-06-01", producers: 10, verifiedProducers: 4, invocations: 22 }]);
    throw new Error("unexpected " + url);
  }));
}

describe("Insights page", () => {
  it("renders the pulse + leaderboard, and drills into a row", async () => {
    stubAll();
    render(<Insights apiBase="" />);
    await screen.findByText(/50 producers/i);          // pulse from overview
    await screen.findByText("brainstorming");           // leaderboard from popularity
    fireEvent.click(screen.getByText("brainstorming"));
    await waitFor(() => expect(screen.getByText("writing-plans")).toBeTruthy()); // detail co-occurrence
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm -F @agentgem/console test Insights.test`
Expected: FAIL — cannot find `./index.js`.

- [ ] **Step 3: Implement `index.tsx`:**

```tsx
import { useEffect, useState } from "react";
import { defineConsolePage } from "../../registry.js";
import {
  popularityRoute, overviewRoute, makeClient,
  type AggIngredient, type AggOverview,
} from "../../api/routes.js";
import { Pulse } from "./Pulse.js";
import { Leaderboard } from "./Leaderboard.js";
import { Detail } from "./Detail.js";

export function Insights({ apiBase }: { apiBase: string }) {
  const [overview, setOverview] = useState<AggOverview | null>(null);
  const [rows, setRows] = useState<AggIngredient[]>([]);
  const [kind, setKind] = useState("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const client = makeClient(apiBase);
    overviewRoute.call(client).then((o) => { if (alive) setOverview(o); }).catch(() => { if (alive) setOverview(null); });
    return () => { alive = false; };
  }, [apiBase]);

  useEffect(() => {
    let alive = true;
    setLoading(true); setError(null);
    const client = makeClient(apiBase);
    popularityRoute.call(client, { query: kind === "all" ? {} : { kind } })
      .then((r) => { if (alive) setRows(r); })
      .catch((e) => { if (alive) setError(String(e?.message ?? e)); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [kind, apiBase]);

  return (
    <div className="ins">
      <Pulse data={overview} loading={overview === null} />
      <div className="ins-split">
        <div className="ins-left">
          {error && <p className="ins-error">Couldn’t load insights: {error}</p>}
          {loading && rows.length === 0 ? <div className="ins-empty">Loading…</div>
            : <Leaderboard rows={rows} kind={kind} onKind={setKind} selectedId={selectedId} onSelect={setSelectedId} />}
        </div>
        <div className="ins-right">
          {selectedId ? <Detail id={selectedId} apiBase={apiBase} />
            : <div className="ins-detail ins-detail-empty">Select an ingredient to see how it’s used and growing.</div>}
        </div>
      </div>
    </div>
  );
}

export const insightsPage = defineConsolePage({
  id: "insights", title: "Insights", icon: "📊", order: 25, group: "library",
  route: "#/insights", component: Insights,
});
```

- [ ] **Step 4: Register the page** — in `packages/console/src/pages.tsx` add the import and the array entry:

```ts
import { insightsPage } from "./panels/Insights/index.js";
// …add insightsPage to the pages array (order 25 places it after workspacesPage/your-gems):
export const pages: ConsolePage[] = [curatePage, materializePage, workspacesPage, getGemsPage, settingsPage, receivedPage, deployPage, insightsPage];
```

- [ ] **Step 5: Update `pages.test.ts`** — add `"insights"` to the library-bucket assertion. Read the file first; the library bucket currently expects `["your-gems", "get-gems", "received"]` ordered by `order` — insights is `order: 25`, so it sorts between your-gems (20) and get-gems (30): the expected library ids become `["your-gems", "insights", "get-gems", "received"]`. Also add `"insights"` at its sorted position in any full ordered-id assertion (sorted by order, ties by array order).

- [ ] **Step 6: Append theme CSS** to `packages/console/src/shell/theme.css`:

```css
/* ── Insights ────────────────────────────────────────────────── */
.ins { display: flex; flex-direction: column; gap: 14px; }
.ins-pulse { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 14px;
  padding: 12px 16px; border: 1px solid var(--line); border-radius: var(--radius);
  background: var(--raised); box-shadow: var(--shadow-sm); }
.ins-pulse.is-empty, .ins-pulse.is-loading { color: var(--muted); font: 13px/1.4 var(--font-ui); }
.ins-pulse-label { font: 600 9.5px/1 var(--font-ui); letter-spacing: .09em; text-transform: uppercase; color: var(--muted); }
.ins-stat { font: 600 18px/1 var(--font-display); color: var(--ink); }
.ins-stat-unit { font: 12px/1 var(--font-ui); color: var(--muted); }
.ins-pulse-verified { font: 600 12px/1 var(--font-ui); color: var(--emerald); }
.ins-split { display: grid; grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr); gap: 14px; align-items: start; }
.ins-tabs { display: flex; gap: 4px; margin-bottom: 8px; }
.ins-tab { background: none; border: 1px solid var(--line); border-radius: 999px; padding: 4px 11px;
  color: var(--muted); cursor: pointer; font: 500 12px/1 var(--font-ui); }
.ins-tab.is-active { background: var(--accent); border-color: var(--accent); color: #fff; }
.ins-rows { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 3px; }
.ins-row { display: grid; grid-template-columns: 22px 1fr auto; align-items: center; gap: 8px 10px;
  width: 100%; text-align: left; background: none; border: 1px solid transparent; border-radius: 8px;
  padding: 8px 10px; cursor: pointer; color: var(--ink); transition: background .13s ease, border-color .13s ease; }
.ins-row:hover { background: rgba(154,51,36,.05); }
.ins-row.is-active { background: var(--raised); border-color: var(--line); box-shadow: var(--shadow-sm); }
.ins-rank { color: var(--muted); font: 600 11px/1 var(--font-mono); text-align: center; }
.ins-name { display: flex; align-items: baseline; gap: 7px; font: 600 13.5px/1.2 var(--font-ui); min-width: 0; }
.ins-name > .ins-scope, .ins-scope { color: var(--muted); font: 500 11px/1 var(--font-ui); }
.ins-kind { font: 600 9.5px/1 var(--font-ui); letter-spacing: .05em; text-transform: uppercase; color: var(--muted);
  border: 1px solid var(--line); border-radius: 4px; padding: 2px 5px; }
.ins-bar { grid-column: 2 / 3; height: 4px; border-radius: 999px; background: var(--paper-2); overflow: hidden; }
.ins-bar-fill { display: block; height: 100%; background: var(--accent); opacity: .55; }
.ins-counts { grid-column: 1 / -1; font: 12px/1.3 var(--font-ui); color: var(--muted); }
.ins-verified { color: var(--emerald); }
.ins-vshare { grid-column: 1 / -1; height: 3px; border-radius: 999px; background: var(--paper-2); overflow: hidden; }
.ins-vshare-fill { display: block; height: 100%; background: var(--emerald); }
.ins-vshare-lg { flex: 1; min-width: 80px; max-width: 160px; height: 5px; }
.ins-detail, .ins-detail-empty { border: 1px solid var(--line); border-radius: var(--radius); background: var(--raised);
  padding: 14px 16px; box-shadow: var(--shadow-sm); }
.ins-detail-empty { color: var(--muted); font: 13px/1.5 var(--font-ui); }
.ins-detail-head { display: flex; align-items: baseline; gap: 8px; margin-bottom: 10px; }
.ins-detail-name { font: 600 16px/1.1 var(--font-display); color: var(--ink); }
.ins-card { margin-top: 12px; }
.ins-card h4 { margin: 0 0 7px; font: 600 11px/1 var(--font-ui); letter-spacing: .04em; text-transform: uppercase; color: var(--muted); }
.ins-card-head { display: flex; align-items: center; justify-content: space-between; }
.ins-co { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 3px; }
.ins-co li { display: flex; justify-content: space-between; gap: 10px; font: 13px/1.4 var(--font-ui); }
.ins-co-name { color: var(--ink); }
.ins-bucket, .ins-bucket-btn { font: 500 11px/1 var(--font-ui); }
.ins-bucket { display: flex; gap: 3px; }
.ins-bucket-btn { background: none; border: 1px solid var(--line); border-radius: 6px; padding: 3px 8px; color: var(--muted); cursor: pointer; }
.ins-bucket-btn.is-active { color: var(--accent); border-color: var(--accent); }
.ins-spark { width: 100%; height: 48px; margin-top: 6px; }
.ins-spark-empty { color: var(--muted); font: 12px/1.4 var(--font-ui); padding: 8px 0; }
.ins-legend { display: flex; align-items: center; gap: 6px; margin: 6px 0 0; color: var(--muted); font: 11px/1 var(--font-ui); }
.ins-dot { width: 9px; height: 3px; border-radius: 2px; display: inline-block; }
.ins-dot-prod { background: var(--accent); } .ins-dot-ver { background: var(--emerald); }
.ins-empty, .ins-error { color: var(--muted); font: 13px/1.5 var(--font-ui); padding: 8px 0; }
.ins-error { color: var(--accent); }
@media (max-width: 900px) { .ins-split { grid-template-columns: 1fr; } }
```

- [ ] **Step 7: Run the page test + full console suite + build**

Run: `pnpm -F @agentgem/console test Insights.test && pnpm -F @agentgem/console test && pnpm build`
Expected: PASS (page test, full suite green, SPA builds).

- [ ] **Step 8: Commit**

```bash
git add packages/console/src/panels/Insights/index.tsx packages/console/src/panels/Insights/Insights.test.tsx packages/console/src/pages.tsx packages/console/src/pages.test.ts packages/console/src/shell/theme.css
git commit -m "feat(console): Insights page — pulse + leaderboard + drill-in, registered in the sidebar"
```

---

## Notes for the implementer

- **Live-verify after Task 7**: `PORT=4317 node dist/index.js`, open `http://127.0.0.1:4317/#/insights`. If the local aggregator DB is unconfigured the routes will error — the page should degrade (pulse shows below-floor/loading; leaderboard shows the error line) rather than crash. That graceful degradation is acceptable for local verification; the component tests stub real data.
- **Backend tests run on compiled dist** — always `pnpm build` before `pnpm test <backend file>`. Console tests run on source via `pnpm -F @agentgem/console test`.
- Do not lower or expose `k` anywhere client-side; the server owns the floor.
