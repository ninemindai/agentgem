# Aggregator Sweep Trigger (#45) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the anti-sybil quarantine sweep run in production via a token-guarded, dry-run-by-default endpoint that never quarantines GitHub-verified producers.

**Architecture:** Two backend changes. (1) `sweepQuarantine` gains a `dryRun` mode (computes, no UPDATE) and exempts producers with an `account_bindings` row. (2) A token-guarded `POST /api/aggregator/sweep` controller route invokes it.

**Tech Stack:** TypeScript, Drizzle (`sql`) on Postgres, `@agentback/openapi` decorator controller, Zod, vitest. Node `crypto.timingSafeEqual` for the token compare.

## Global Constraints

- Backend tests run on COMPILED dist: `pnpm build` then `pnpm test [name]` (from the worktree root). Never `vitest` on source.
- No new runtime dependencies (`crypto` is built-in).
- No schema migration — verified-exemption reads the existing `account_bindings` table.
- The destructive path (`apply=true`) requires `AGGREGATOR_ADMIN_TOKEN`; unset ⇒ refuse. Never log the request body (it carries the token).
- Cluster *detection* is unchanged; only the quarantine target set is filtered (dry-run + verified-exempt).
- Git author `Raymond Feng <raymond@ninemind.ai>`; every commit ends with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

---

### Task 1: `sweepQuarantine` — dry-run + verified-producer exemption

**Files:**
- Modify: `src/aggregator/detection.ts` (`SweepOpts`, `SweepReport`, `sweepQuarantine`)
- Test: `src/aggregator/__tests__/detection.test.ts` (add two cases)

**Interfaces:**
- Produces: `sweepQuarantine(db: AppDb, opts?: SweepOpts): Promise<SweepReport>` where `SweepOpts` now includes `dryRun?: boolean` and `SweepReport` now includes `dryRun: boolean`.
- Consumes: existing `makeTestDb`, `projectAttestation`, `att(pk, digest, skills)` helper, and `OPTS` already in `detection.test.ts`. The `account_bindings` table (pk → producers) exists after `makeTestDb`.

- [ ] **Step 1: Write the failing tests** — append to `src/aggregator/__tests__/detection.test.ts` (add `import { sql } from "drizzle-orm";` at the top):

```ts
  it("dry-run reports what WOULD be quarantined but changes nothing", async () => {
    const db = await makeTestDb();
    const shape = ["skill:a", "skill:b"];
    for (const i of [1, 2, 3]) await projectAttestation(db, att(`ed25519:f${i}`, `d${i}`, shape));
    const dry = await sweepQuarantine(db, { ...OPTS, dryRun: true });
    expect(dry).toEqual({ clustersFound: 1, attestationsQuarantined: 3, producersFlagged: 3, dryRun: true });
    // nothing was quarantined — skill:a is still visible in aggregates
    expect((await popularity(db, { kind: "skill", k: 1 })).map((r) => r.id)).toContain("skill:a");
    // a real run still finds + quarantines the same 3 (proving dry-run was a no-op)
    const real = await sweepQuarantine(db, OPTS);
    expect(real).toEqual({ clustersFound: 1, attestationsQuarantined: 3, producersFlagged: 3, dryRun: false });
  });

  it("never quarantines a GitHub-verified (bound) producer, even inside a flagged cluster", async () => {
    const db = await makeTestDb();
    const shape = ["skill:a", "skill:b"];
    for (const i of [1, 2, 3]) await projectAttestation(db, att(`ed25519:f${i}`, `d${i}`, shape));
    // bind producer f1 (the #28 anti-sybil anchor); the producer row already exists from projectAttestation
    await db.execute(sql`insert into account_bindings(pubkey, provider, account_id, account_login)
      values ('ed25519:f1', 'github', '42', 'octocat')`);
    const rep = await sweepQuarantine(db, OPTS); // apply
    expect(rep.attestationsQuarantined).toBe(2); // f2 + f3 quarantined; f1 exempt
    expect(rep.producersFlagged).toBe(2);
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm build && pnpm test detection`
Expected: FAIL — dry-run case errors on the `dryRun` field (not returned / not accepted) and the exemption case quarantines 3 (no exemption yet).

- [ ] **Step 3: Implement** — in `src/aggregator/detection.ts`:

Add `dryRun?: boolean;` to `SweepOpts` and `dryRun: boolean;` to `SweepReport`. Replace the body of `sweepQuarantine` from the `const r = await db.execute…` line through the `return {…}` with:

```ts
  const dryRun = opts.dryRun ?? false;
  // Quarantine targets: attestations in a flagged shape that are not already quarantined
  // AND whose producer is NOT GitHub-bound (verified producers are the anti-sybil anchor).
  // Real mode UPDATEs them; dry-run just counts them.
  const updCte = dryRun
    ? sql``
    : sql`, upd as (
        update attestations set quarantined = true, trust_score = 0
        where id in (select id from targets) returning id, producer_pubkey
      )`;
  const countFrom = dryRun ? sql`targets` : sql`upd`;
  const pkCol = dryRun ? sql`pk` : sql`producer_pubkey`;

  const r = await db.execute<{ clusters_found: number; attestations_quarantined: number; producers_flagged: number }>(sql`
    with shapes as (
      select e.attestation_id as aid, a.producer_pubkey as pk,
             string_agg(e.ingredient_id, ',' order by e.ingredient_id) as fp,
             count(*) as shape_size
      from usage_edges e
      join attestations a on a.id = e.attestation_id and not a.quarantined
      join ingredients  i on i.id = e.ingredient_id and i.kind in ('skill','mcp')
      group by e.attestation_id, a.producer_pubkey
    ),
    clusters as (
      select s.fp,
             count(distinct s.pk) as producers,
             max(s.shape_size) as shape_size,
             (count(distinct s.pk) filter (where p.attest_count <= ${freshMax}))::float
               / nullif(count(distinct s.pk), 0) as fresh_frac
      from shapes s
      join producers p on p.pubkey = s.pk
      group by s.fp
    ),
    bad as (
      select fp from clusters
      where producers >= ${minProducers} and shape_size >= ${minShape} and fresh_frac >= ${freshFraction}
    ),
    targets as (
      select s.aid as id, a.producer_pubkey as pk
      from shapes s
      join bad b on b.fp = s.fp
      join attestations a on a.id = s.aid
      where not a.quarantined
        and not exists (select 1 from account_bindings ab where ab.pubkey = a.producer_pubkey)
    )${updCte}
    select (select count(*) from bad)::int as clusters_found,
           (select count(*) from ${countFrom})::int as attestations_quarantined,
           (select count(distinct ${pkCol}) from ${countFrom})::int as producers_flagged
  `);
  const row = r.rows[0];
  return {
    clustersFound: Number(row.clusters_found),
    attestationsQuarantined: Number(row.attestations_quarantined),
    producersFlagged: Number(row.producers_flagged),
    dryRun,
  };
```

(Leave the threshold consts — `minProducers`, `minShape`, `freshMax`, `freshFraction` — exactly as they are above this block.)

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm build && pnpm test detection`
Expected: PASS — including the pre-existing detection cases (their reports now also carry `dryRun: false`; the existing `toEqual({ clustersFound, attestationsQuarantined, producersFlagged })` assertions will FAIL because the object now has a 4th key). **Update the pre-existing `toEqual(...)` report assertions in this file to include `dryRun: false`** (e.g. the first test's `expect(rep).toEqual({ clustersFound: 1, attestationsQuarantined: 3, producersFlagged: 3, dryRun: false })` and the idempotency assertion `toEqual({ clustersFound: 0, attestationsQuarantined: 0, producersFlagged: 0, dryRun: false })`). Re-run until green.

- [ ] **Step 5: Commit**

```bash
git add src/aggregator/detection.ts src/aggregator/__tests__/detection.test.ts
git commit -m "feat(aggregator): sweepQuarantine dry-run + verified-producer exemption"
```

---

### Task 2: `POST /api/aggregator/sweep` — token-guarded trigger

**Files:**
- Modify: `src/aggregator.controller.ts` (schemas + `@post("/sweep")` + a `tokenEq` helper)
- Test: `src/aggregator/__tests__/sweepController.test.ts` (create)

**Interfaces:**
- Consumes: `sweepQuarantine` + `SweepReport` from `./aggregator/detection.js` (Task 1, with `dryRun`); the existing `AggregatorController` (constructed with an `AppDb`).
- Produces: `POST /api/aggregator/sweep` accepting `{ apply?: boolean; token: string }`, returning `{ ok: true; report } | { ok: false; rejected: string }`.

- [ ] **Step 1: Write the failing test** — create `src/aggregator/__tests__/sweepController.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import { sql } from "drizzle-orm";
import { makeTestDb } from "../testDb.js";
import { projectAttestation } from "../project.js";
import { AggregatorController } from "../../aggregator.controller.js";

function att(pk: string, digest: string, skills: string[]) {
  return { formatVersion: 1, canonicalizerVersion: 3, gem: { name: "g", digest },
    producer: { publicKey: pk, account: null },
    source: { harness: { id: "claude-code" }, models: [], scan: { sessions: 2, spanDays: 1, firstMs: 0, lastMs: 0 } },
    ingredients: { skills: skills.map((id) => ({ id, idKind: "plugin", public: true, invocations: 2, sessions: 1 })), mcps: [] },
    evidence: { signalDigest: "d:" + digest }, signedAt: 1, signature: "x" } as never;
}
const OPTS_ENV = { DETECT_MIN_PRODUCERS: "3", DETECT_MIN_SHAPE: "2", DETECT_FRESH_MAX: "1", DETECT_FRESH_FRACTION: "0.8" };

const orig = { ...process.env };
afterEach(() => { process.env = { ...orig }; });

async function seedCluster(db: Awaited<ReturnType<typeof makeTestDb>>) {
  for (const i of [1, 2, 3]) await projectAttestation(db, att(`ed25519:f${i}`, `d${i}`, ["skill:a", "skill:b"]));
}
async function quarantinedCount(db: Awaited<ReturnType<typeof makeTestDb>>): Promise<number> {
  const r = await db.execute<{ n: number }>(sql`select count(*)::int as n from attestations where quarantined`);
  return Number(r.rows[0].n);
}

describe("POST /api/aggregator/sweep", () => {
  it("refuses when AGGREGATOR_ADMIN_TOKEN is unset", async () => {
    delete process.env.AGGREGATOR_ADMIN_TOKEN;
    const db = await makeTestDb();
    const res = await new AggregatorController(db).sweep({ body: { token: "anything", apply: true } });
    expect(res).toEqual({ ok: false, rejected: "sweep-disabled" });
  });

  it("rejects a wrong token", async () => {
    process.env.AGGREGATOR_ADMIN_TOKEN = "s3cret";
    const db = await makeTestDb();
    const res = await new AggregatorController(db).sweep({ body: { token: "nope", apply: true } });
    expect(res).toEqual({ ok: false, rejected: "unauthorized" });
  });

  it("dry-run (apply omitted) reports but changes nothing", async () => {
    process.env = { ...orig, ...OPTS_ENV, AGGREGATOR_ADMIN_TOKEN: "s3cret" };
    const db = await makeTestDb();
    await seedCluster(db);
    const res = await new AggregatorController(db).sweep({ body: { token: "s3cret" } });
    expect(res).toEqual({ ok: true, report: { clustersFound: 1, attestationsQuarantined: 3, producersFlagged: 3, dryRun: true } });
    expect(await quarantinedCount(db)).toBe(0); // nothing actually quarantined
  });

  it("apply:true quarantines", async () => {
    process.env = { ...orig, ...OPTS_ENV, AGGREGATOR_ADMIN_TOKEN: "s3cret" };
    const db = await makeTestDb();
    await seedCluster(db);
    const res = await new AggregatorController(db).sweep({ body: { token: "s3cret", apply: true } });
    expect(res).toEqual({ ok: true, report: { clustersFound: 1, attestationsQuarantined: 3, producersFlagged: 3, dryRun: false } });
    expect(await quarantinedCount(db)).toBe(3);
  });
});
```

(The endpoint takes no `SweepOpts` from the caller, so the test drives the thresholds via the `DETECT_*` env vars `sweepQuarantine` already reads.)

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm build && pnpm test sweepController`
Expected: FAIL — `AggregatorController` has no `sweep` method.

- [ ] **Step 3: Implement** — in `src/aggregator.controller.ts`:

Add imports at the top (alongside the existing ones):

```ts
import { timingSafeEqual } from "node:crypto";
import { sweepQuarantine } from "./aggregator/detection.js";
```

Add the schemas near the other `const …Result` declarations (after `BindResultSchema`):

```ts
const SweepBody = z.object({ apply: z.boolean().optional(), token: z.string() });
const SweepReportSchema = z.object({
  clustersFound: z.number(), attestationsQuarantined: z.number(), producersFlagged: z.number(), dryRun: z.boolean(),
});
const SweepResult = z.union([
  z.object({ ok: z.literal(true), report: SweepReportSchema }),
  z.object({ ok: z.literal(false), rejected: z.string() }),
]);

// Constant-time token compare (length-guarded so timingSafeEqual never throws on mismatched lengths).
function tokenEq(a: string, b: string): boolean {
  const ab = Buffer.from(a), bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
```

Add the method inside the `AggregatorController` class (after `bind`):

```ts
  // Admin-only: run the anti-sybil quarantine sweep. Dry-run by default; apply=true is
  // destructive and requires AGGREGATOR_ADMIN_TOKEN. Do NOT log input.body (it has the token).
  @post("/sweep", { body: SweepBody, response: SweepResult })
  async sweep(input: { body: z.infer<typeof SweepBody> }): Promise<z.infer<typeof SweepResult>> {
    const expected = process.env.AGGREGATOR_ADMIN_TOKEN;
    if (!expected) return { ok: false, rejected: "sweep-disabled" };
    if (!tokenEq(input.body.token, expected)) return { ok: false, rejected: "unauthorized" };
    const report = await sweepQuarantine(this.db, { dryRun: !input.body.apply });
    return { ok: true, report };
  }
```

- [ ] **Step 4: Run to verify it passes + full suite**

Run: `pnpm build && pnpm test sweepController && pnpm test`
Expected: PASS — the 4 sweep cases plus the whole root suite green.

- [ ] **Step 5: Commit**

```bash
git add src/aggregator.controller.ts src/aggregator/__tests__/sweepController.test.ts
git commit -m "feat(aggregator): POST /sweep — token-guarded, dry-run-default quarantine trigger"
```

---

## Notes for the implementer

- `/api/aggregator/sweep` is a `@post`, so it's automatically outside `originGuard`'s `PUBLIC_READ_PATHS` (those are GET reads) — no change to `src/originGuard.ts` needed.
- The verified-exemption MUST be in the shared `targets` CTE so BOTH dry-run and apply honor it (the apply `upd` selects from `targets`).
- After both tasks: a scheduler triggers it with `curl -XPOST $URL/api/aggregator/sweep -H 'content-type: application/json' -d '{"token":"…","apply":true}'`. Document `AGGREGATOR_ADMIN_TOKEN` as a new deploy env var (rides the #38 deploy).
