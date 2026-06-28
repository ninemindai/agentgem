# Co-occurrence matrix export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an all-pairs co-occurrence JSON edge-list read — `coOccurrenceMatrix(db,{limit?,k?})` + `GET /api/aggregator/co-occurrence-matrix` — generalizing the pivot-based `coOccurrence(id)` to the whole tool graph.

**Architecture:** A self-join of `usage_edges` over the same attestation with an unordered-pair predicate (`a < b`) produces every co-used skill/mcp ingredient pair with its distinct-producer count, k-anon gated, with the `verifiedProducers` overlay. A thin controller route exposes it; originGuard marks it a public read.

**Tech Stack:** TypeScript (ESM, Node ≥22), drizzle-orm (pglite tests / node-postgres prod), `@agentback/openapi` decorators, zod 4, vitest on compiled `dist/`.

## Global Constraints

- Node ≥22, `"type": "module"`: relative imports end in `.js`.
- Tests run from COMPILED dist at the repo root: `npm test -- dist/<path>.test.js` (= `tsc -b && vitest run`).
- The k-anon gate is `having count(distinct <producer_pubkey>) >= ${k}`, `k = DEFAULT_K` (defined/exported in `src/aggregator/aggregates.js`). `k` is server policy — never a caller query param.
- Tools-only: both sides of every pair must be `kind in ('skill','mcp')` (matches the shipped `coOccurrence`/`overview`/`popularity`). `not quarantined` on the attestation.
- `verifiedProducers` per edge = `count(distinct b.provider || ':' || b.account_id)` via `left join account_bindings b on b.pubkey = <producer_pubkey>` (PK join, no fan-out).
- camelCase result columns from raw SQL need a quoted alias: `... as "verifiedProducers"`.
- All SQL interpolation uses drizzle `sql\`...\`` bound `${}` params (no string concatenation).
- `GET /api/aggregator/co-occurrence-matrix` is a public, side-effect-free, k-anon read → it MUST be added to `originGuard`'s `PUBLIC_READ_PATHS` (exact string `/api/aggregator/co-occurrence-matrix`). It is a GET, never a write.
- `limit` default is **500**, applied as the SQL `limit`.
- Commits: author `Raymond Feng <raymond@ninemind.ai>`; message body ends with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`. Use `git -c user.name=... -c user.email=...`.
- Branch is `feat/cooccurrence-matrix` (already created off `origin/main`). Do not create a new branch.

---

### Task 1: `coOccurrenceMatrix` aggregate + `GET /co-occurrence-matrix` route + public-read exemption

**Files:**
- Modify: `src/aggregator/aggregates.ts`
- Modify: `src/aggregator.controller.ts`
- Modify: `src/originGuard.ts`
- Test: `src/aggregator/__tests__/cooccurrenceMatrix.test.ts` (create)
- Test: `src/__tests__/originGuard.test.ts` (modify)

**Interfaces:**
- Consumes: `sql` (drizzle), `AppDb`, `DEFAULT_K` — already imported/defined in `aggregates.ts`. `projectAttestation` + `makeTestDb` + `accountBindings` (in the test).
- Produces: `coOccurrenceMatrix(db, opts: { limit?: number; k?: number }): Promise<{ a: string; b: string; producers: number; verifiedProducers: number }[]>`; `GET /api/aggregator/co-occurrence-matrix` returning that array; `/api/aggregator/co-occurrence-matrix` in `PUBLIC_READ_PATHS`.

- [ ] **Step 1: Write the failing aggregate test**

Create `src/aggregator/__tests__/cooccurrenceMatrix.test.ts`:

```ts
// src/aggregator/__tests__/cooccurrenceMatrix.test.ts
import { describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";
import { makeTestDb } from "../testDb.js";
import { projectAttestation } from "../project.js";
import { accountBindings } from "../schema.js";
import { coOccurrenceMatrix } from "../aggregates.js";
import type { AppDb } from "../schema.js";

// Helper: an attestation for `pubkey` carrying the given skill + mcp ids (all public, tools).
function att(pubkey: string, digest: string, skills: string[], mcps: string[] = []) {
  return { formatVersion: 1, canonicalizerVersion: 3, gem: { name: "g", digest },
    producer: { publicKey: pubkey, account: null },
    source: { harness: { id: "claude-code" }, models: ["model:opus-4-8"], scan: { sessions: 2, spanDays: 1, firstMs: 0, lastMs: 0 } },
    ingredients: {
      skills: skills.map((id) => ({ id, idKind: "plugin", public: true, invocations: 2, sessions: 1 })),
      mcps: mcps.map((id) => ({ id, idKind: "plugin", public: true, invocations: 2, sessions: 1 })),
    },
    evidence: { signalDigest: "d" }, signedAt: 1, signature: "x" } as never;
}
async function bind(db: AppDb, pubkey: string, accountId: string) {
  await db.insert(accountBindings).values({ pubkey, provider: "github", accountId, accountLogin: "u" + accountId });
}

describe("coOccurrenceMatrix", () => {
  it("emits each unordered pair once with distinct-producer counts (no dup, no self-pair)", async () => {
    const db = await makeTestDb();
    await projectAttestation(db, att("ed25519:p1", "d1", ["skill:a", "skill:x"]));
    await projectAttestation(db, att("ed25519:p2", "d2", ["skill:a", "skill:x"]));
    const m = await coOccurrenceMatrix(db, { k: 2 });
    // exactly one edge for the pair, lexicographic a<b, no (x,a) duplicate, no (a,a)/(x,x) self-pair
    expect(m).toEqual([{ a: "skill:a", b: "skill:x", producers: 2, verifiedProducers: 0 }]);
  });
  it("suppresses a pair below the k floor and shows it at k=1", async () => {
    const db = await makeTestDb();
    await projectAttestation(db, att("ed25519:p1", "d1", ["skill:a", "skill:x"]));
    await projectAttestation(db, att("ed25519:p2", "d2", ["skill:a", "skill:x"]));
    await projectAttestation(db, att("ed25519:p3", "d3", ["skill:a", "skill:y"])); // (a,y): 1 producer
    expect((await coOccurrenceMatrix(db, { k: 2 })).map((e) => [e.a, e.b])).toEqual([["skill:a", "skill:x"]]);
    const k1 = (await coOccurrenceMatrix(db, { k: 1 })).map((e) => `${e.a}|${e.b}`);
    expect(k1).toContain("skill:a|skill:y"); // visible at k=1
  });
  it("excludes quarantined attestations and counts verified producers separately", async () => {
    const db = await makeTestDb();
    await projectAttestation(db, att("ed25519:p1", "d1", ["skill:a", "skill:x"]));
    await projectAttestation(db, att("ed25519:p2", "d2", ["skill:a", "skill:x"]));
    await bind(db, "ed25519:p1", "100");
    const [edge] = await coOccurrenceMatrix(db, { k: 2 });
    expect(edge).toMatchObject({ a: "skill:a", b: "skill:x", producers: 2, verifiedProducers: 1 });
    await db.execute(sql`update attestations set quarantined = true where producer_pubkey = 'ed25519:p2'`);
    // now only p1 uses the pair -> below k=2 -> suppressed
    expect(await coOccurrenceMatrix(db, { k: 2 })).toEqual([]);
  });
  it("never pairs non-tool kinds (harness/model excluded)", async () => {
    const db = await makeTestDb();
    await projectAttestation(db, att("ed25519:p1", "d1", ["skill:a"], ["mcp:m"]));
    await projectAttestation(db, att("ed25519:p2", "d2", ["skill:a"], ["mcp:m"]));
    const ids = (await coOccurrenceMatrix(db, { k: 2 })).flatMap((e) => [e.a, e.b]);
    // skill:a×mcp:m is a valid tool pair; harness/model ids must never appear
    expect(ids).toContain("skill:a");
    expect(ids).toContain("mcp:m");
    expect(ids.some((i) => i.startsWith("harness") || i.startsWith("model"))).toBe(false);
  });
  it("caps rows by limit, keeping the highest-producer pairs", async () => {
    const db = await makeTestDb();
    // pair (a,x): 3 producers; pair (a,y): 2 producers
    await projectAttestation(db, att("ed25519:p1", "d1", ["skill:a", "skill:x"]));
    await projectAttestation(db, att("ed25519:p2", "d2", ["skill:a", "skill:x"]));
    await projectAttestation(db, att("ed25519:p3", "d3", ["skill:a", "skill:x"]));
    await projectAttestation(db, att("ed25519:p4", "d4", ["skill:a", "skill:y"]));
    await projectAttestation(db, att("ed25519:p5", "d5", ["skill:a", "skill:y"]));
    const top = await coOccurrenceMatrix(db, { k: 2, limit: 1 });
    expect(top).toHaveLength(1);
    expect([top[0].a, top[0].b]).toEqual(["skill:a", "skill:x"]); // 3 producers beats 2
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- dist/aggregator/__tests__/cooccurrenceMatrix.test.js`
Expected: FAIL — `coOccurrenceMatrix` is not exported from `../aggregates.js`.

- [ ] **Step 3: Implement the aggregate**

Append to `src/aggregator/aggregates.ts` (uses the `sql`, `AppDb`, `DEFAULT_K` already in the file):

```ts
export async function coOccurrenceMatrix(
  db: AppDb, opts: { limit?: number; k?: number } = {},
): Promise<{ a: string; b: string; producers: number; verifiedProducers: number }[]> {
  const k = opts.k ?? DEFAULT_K, limit = opts.limit ?? 500;
  const r = await db.execute<{ a: string; b: string; producers: number; verifiedProducers: number }>(sql`
    select e1.ingredient_id as a, e2.ingredient_id as b,
           count(distinct at.producer_pubkey)::int as producers,
           count(distinct bnd.provider || ':' || bnd.account_id)::int as "verifiedProducers"
    from usage_edges e1
    join usage_edges e2 on e2.attestation_id = e1.attestation_id and e1.ingredient_id < e2.ingredient_id
    join ingredients i1 on i1.id = e1.ingredient_id and i1.kind in ('skill','mcp')
    join ingredients i2 on i2.id = e2.ingredient_id and i2.kind in ('skill','mcp')
    join attestations at on at.id = e1.attestation_id and not at.quarantined
    left join account_bindings bnd on bnd.pubkey = at.producer_pubkey
    group by e1.ingredient_id, e2.ingredient_id
    having count(distinct at.producer_pubkey) >= ${k}
    order by producers desc, a, b
    limit ${limit}
  `);
  return r.rows as { a: string; b: string; producers: number; verifiedProducers: number }[];
}
```

- [ ] **Step 4: Run the aggregate test**

Run: `npm test -- dist/aggregator/__tests__/cooccurrenceMatrix.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Add the controller route**

In `src/aggregator.controller.ts`: add `coOccurrenceMatrix` to the existing import from `./aggregator/aggregates.js` (the line currently importing `popularity, coOccurrence, adoption`, plus whatever else is already there — append `, coOccurrenceMatrix`). Add a query + result schema next to the other `Co*` consts:

```ts
const CoMatrixQuery = z.object({ limit: z.coerce.number().optional() }); // NOTE: no `k`
const CoMatrixResult = z.array(z.object({ a: z.string(), b: z.string(), producers: z.number(), verifiedProducers: z.number() }));
```

Add the route method to `AggregatorController` (after the `coOccurrence` method):

```ts
  @get("/co-occurrence-matrix", { query: CoMatrixQuery, response: CoMatrixResult })
  async coOccurrenceMatrix(input: { query: z.infer<typeof CoMatrixQuery> }): Promise<z.infer<typeof CoMatrixResult>> {
    // k is server policy (DEFAULT_K), never caller-supplied.
    return coOccurrenceMatrix(this.db, { limit: input.query.limit });
  }
```

- [ ] **Step 6: Exempt the read in originGuard + pin it with a test**

In `src/originGuard.ts`, add the path to `PUBLIC_READ_PATHS`:

```ts
const PUBLIC_READ_PATHS = new Set(["/api/aggregator/popularity", "/api/aggregator/co-occurrence", "/api/aggregator/adoption", "/api/aggregator/co-occurrence-matrix"]);
```

> If `PUBLIC_READ_PATHS` on this branch already contains other entries (e.g. `/summary`, `/overview` added by parallel work), keep them — only ADD `/api/aggregator/co-occurrence-matrix`; do not remove existing members.

In `src/__tests__/originGuard.test.ts`, add inside the `describe("originGuard — public aggregator reads ...")` block:

```ts
  it("allows a cross-site GET to co-occurrence-matrix and sets permissive CORS", () => {
    const r = run({ "sec-fetch-site": "cross-site" }, "agg.example", "GET", "/api/aggregator/co-occurrence-matrix");
    expect(r.nexted).toBe(true);
    expect(r.set["access-control-allow-origin"]).toBe("*");
  });
```

- [ ] **Step 7: Run the matrix + originGuard tests + build**

Run: `npm test -- dist/aggregator/__tests__/cooccurrenceMatrix.test.js dist/__tests__/originGuard.test.js`
Expected: PASS — matrix (5) + all originGuard tests incl. the new one; `tsc -b` clean (confirms the result schema types align with the aggregate return type).

- [ ] **Step 8: Commit**

```bash
git add src/aggregator/aggregates.ts src/aggregator.controller.ts src/originGuard.ts src/aggregator/__tests__/cooccurrenceMatrix.test.ts src/__tests__/originGuard.test.ts
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "feat(aggregator): GET /api/aggregator/co-occurrence-matrix (all-pairs edge list)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

- [ ] **Step 9: Full-suite sanity**

Run: `npm test 2>&1 | tail -3`
Expected: green — the whole root suite, with the new matrix + originGuard tests included and nothing regressed.

---

## Deferred (NOT in this plan)

- A CSV download variant of the same query.
- Any UI/heatmap consumer of the matrix.
- Pagination beyond a flat `limit` (cursor/offset); edge weighting by `trust_score`.
