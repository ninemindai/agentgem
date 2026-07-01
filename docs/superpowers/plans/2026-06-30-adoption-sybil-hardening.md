# Adoption Sybil / Quarantine Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Harden #D adoption telemetry against sybil inflation via defense-in-depth: quarantine columns + adoption sweep + aggregate exclusion, a real `account_bindings` verified-install count, and 💎 Diamond gated on VERIFIED installers.

**Architecture:** Extend the existing attestation trust/quarantine machinery to `gem_adoptions` (not a parallel system). Marketplace Diamond keys on verified installs; the headline count stays raw+swept.

**Tech Stack:** `@agentgem/aggregator` + server (`src/`) + `@agentgem/marketplace`. ALL tests in the ROOT suite (`src/**/__tests__/`) via root `pnpm test` (`tsc -b && vitest run` over `dist/`); aggregator tests use PGlite `makeTestDb()`. Marketplace: `pnpm --filter @agentgem/marketplace test|typecheck|build`.

## Global Constraints

- MIT header on new/edited package source files (copy an adjacent file's 3-line header). Marketplace files carry NO header.
- **Soft exclusion, not hard rejection:** adoptions are still ingested from unbound producers; they're excluded only when `quarantined`, and only Diamond gates on verified.
- **Bound + aged producers are exempt** from the adoption sweep (mirrors the attestation sweep's `not exists account_bindings` + `attest_count <= freshMax`).
- **The sweep is dry-run by default + admin-gated** — never auto-quarantines.
- `isDiamond` keys the adoption axis on VERIFIED installs; `stoneRating` stays on raw (swept) installs — do NOT change the headline count to verified.
- k-anon `having count(distinct producer_pubkey) >= k` stays, now over NON-quarantined rows.
- Additive/surgical; match existing style; no reformatting.
- Commit identity: `git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit`; messages end with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`. Stage explicitly; verify `git show HEAD --stat`.

---

### Task 1: quarantine columns + aggregate exclusion + real verified count

**Files:**
- Modify: `packages/aggregator/src/schema.ts` (columns + ensureSchema DDL), `packages/aggregator/src/aggregates.ts` (`gemAdoption`), `src/aggregator.controller.ts` (`GemAdoptionResult` field rename)
- Test: `src/aggregator/__tests__/gemAdoption.test.ts` (extend)

**Interfaces — Produces:** `gemAdoption(db, {keys?,k?}) → { gemKey; installs; verifiedInstalls }[]` (installs = non-quarantined distinct producers; verifiedInstalls = distinct bound accounts).

- [ ] **Step 1: Write the failing test** — extend `src/aggregator/__tests__/gemAdoption.test.ts`:
```ts
// import { makeTestDb, projectGemAdoption, gemAdoption } from "@agentgem/aggregator";
// (+ a way to mark a row quarantined + to bind an account — see Step 3 notes)
it("excludes quarantined adoptions from installs and the k-anon count", async () => {
  const db = await makeTestDb();
  // seed 5 distinct installers of @a/g, then quarantine one via raw UPDATE
  // ... project 5 events (distinct identities) ...
  await db.execute(sql`update gem_adoptions set quarantined = true where gem_key = '@a/g' and producer_pubkey = ${firstPubkey}`);
  const rows = await gemAdoption(db, {});
  expect(rows.find((r) => r.gemKey === "@a/g")).toBeUndefined(); // 4 non-quarantined < k(5) → gone
});
it("verifiedInstalls counts distinct BOUND accounts, not the self-reported login", async () => {
  const db = await makeTestDb();
  // project 5 events; bind 2 of the producers via account_bindings (recordBinding or raw insert)
  const rows = await gemAdoption(db, {});
  const g = rows.find((r) => r.gemKey === "@a/g")!;
  expect(g.installs).toBe(5);
  expect(g.verifiedInstalls).toBe(2); // only the bound producers
});
```
(For binding in the test: use `recordBinding` if its signature is easy, else a raw `insert into account_bindings (pubkey, provider, account_id, account_login) values (...)`. Read `binding.ts` / `schema.ts` for the exact columns.)

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm exec tsc -b && pnpm exec vitest run dist/aggregator/__tests__/gemAdoption.test.js`
Expected: FAIL — no quarantine column / `verifiedInstalls` absent.

- [ ] **Step 3: Implement**

`packages/aggregator/src/schema.ts` — in `gemAdoptions` (after `adoptedAt`, `real`/`boolean` already imported):
```ts
  trustScore: real("trust_score").notNull().default(1),
  quarantined: boolean("quarantined").notNull().default(false),
```
and in `ensureSchema`'s `create table if not exists gem_adoptions (...)` line, append before `primary key`: `, trust_score real not null default 1, quarantined boolean not null default false`.

`packages/aggregator/src/aggregates.ts` `gemAdoption` — alias the table `g`, add `not quarantined`, and the real verified join (replace `selfReportedAccounts`):
```ts
): Promise<{ gemKey: string; installs: number; verifiedInstalls: number }[]> {
  // ...
  const r = await db.execute<{ gemKey: string; installs: number; verifiedInstalls: number }>(sql`
    select g.gem_key as "gemKey",
           count(distinct g.producer_pubkey)::int as installs,
           count(distinct b.provider || ':' || b.account_id)::int as "verifiedInstalls"
    from gem_adoptions g
    left join account_bindings b on b.pubkey = g.producer_pubkey
    where not g.quarantined and (${keysFilter})
    group by g.gem_key
    having count(distinct g.producer_pubkey) >= ${k}
    order by installs desc
  `);
  return r.rows as { gemKey: string; installs: number; verifiedInstalls: number }[];
}
```
(NOTE: `keysFilter` references `gem_key` — it still resolves under the `g` alias since the column name is unambiguous; if PGlite complains, qualify it as `g.gem_key` in the filter builder.)

`src/aggregator.controller.ts` — `GemAdoptionResult` items: rename `selfReportedAccounts` → `verifiedInstalls` (`z.number()`).

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm exec tsc -b && pnpm exec vitest run dist/aggregator/__tests__/gemAdoption.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add packages/aggregator/src/schema.ts packages/aggregator/src/aggregates.ts src/aggregator.controller.ts src/aggregator/__tests__/gemAdoption.test.ts
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "feat(aggregator): quarantine + real verified-install count for gem adoption

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: adoption sybil detection + sweep extension

**Files:**
- Modify: `packages/aggregator/src/detection.ts` (`sweepAdoptionQuarantine` + export), `packages/aggregator/src/index.ts` (export if not barrel-covered), `src/aggregator.controller.ts` (`POST /sweep` runs it + `SweepReport.adoptionsQuarantined`)
- Test: `src/aggregator/__tests__/adoptionSweep.test.ts` (new)

**Interfaces — Produces:** `sweepAdoptionQuarantine(db, opts): Promise<{ gemsFlagged; adoptionsQuarantined; producersFlagged; dryRun }>`.

- [ ] **Step 1: Write the failing test** — `src/aggregator/__tests__/adoptionSweep.test.ts` (mirror the attestation detection test setup; use `projectGemAdoption` with distinct identities + `producers.attest_count` control via raw update, + `account_bindings` insert for the bound-exempt case):
```ts
// - seed @a/g adopted by >=10 FRESH (attest_count 0) UNBOUND producers
//   → sweepAdoptionQuarantine(db, { dryRun: false }) sets quarantined=true on them;
//     gemAdoption(db,{}) then omits @a/g (dropped below k / all swept).
// - a BOUND producer in that cluster is NOT quarantined (verify its row.quarantined stays false).
// - an AGED producer (attest_count > freshMax) is NOT quarantined.
// - a small gem (<10 adopters) is untouched.
// - dry-run counts (report.adoptionsQuarantined > 0) but writes nothing.
// - second real run → adoptionsQuarantined === 0 (idempotent).
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm exec tsc -b && pnpm exec vitest run dist/aggregator/__tests__/adoptionSweep.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement**

`packages/aggregator/src/detection.ts` — add (reuse the `num`/env-default helper + `freshMax`/`freshFraction` constants; the cluster is per gem_key):
```ts
export async function sweepAdoptionQuarantine(db: AppDb, opts: SweepOpts = {}): Promise<{ gemsFlagged: number; adoptionsQuarantined: number; producersFlagged: number; dryRun: boolean }> {
  const minProducers = opts.minProducers ?? num(process.env.DETECT_ADOPT_MIN_PRODUCERS, 10);
  const freshMax = opts.freshMaxAttest ?? num(process.env.DETECT_FRESH_MAX, 2);
  const freshFraction = opts.freshFraction ?? num(process.env.DETECT_FRESH_FRACTION, 0.8);
  const dryRun = opts.dryRun ?? false;
  const updCte = dryRun ? sql`` : sql`, upd as (
    update gem_adoptions set quarantined = true, trust_score = 0
    where (gem_key, producer_pubkey) in (select gem_key, pk from targets) returning gem_key, producer_pubkey
  )`;
  const countFrom = dryRun ? sql`targets` : sql`upd`;
  const pkCol = dryRun ? sql`pk` : sql`producer_pubkey`;
  const r = await db.execute<{ gems_flagged: number; adoptions_quarantined: number; producers_flagged: number }>(sql`
    with adopters as (
      select g.gem_key as gk, g.producer_pubkey as pk, p.attest_count as ac,
             not exists (select 1 from account_bindings ab where ab.pubkey = g.producer_pubkey) as unbound
      from gem_adoptions g
      join producers p on p.pubkey = g.producer_pubkey
      where not g.quarantined
    ),
    clusters as (
      select gk, count(distinct pk) as producers,
             (count(distinct pk) filter (where ac <= ${freshMax} and unbound))::float
               / nullif(count(distinct pk), 0) as fresh_frac
      from adopters group by gk
    ),
    bad as (select gk from clusters where producers >= ${minProducers} and fresh_frac >= ${freshFraction}),
    targets as (
      select a.gk as gem_key, a.pk as pk
      from adopters a join bad b on b.gk = a.gk
      where a.ac <= ${freshMax} and a.unbound
    )${updCte}
    select (select count(*) from bad)::int as gems_flagged,
           (select count(*) from ${countFrom})::int as adoptions_quarantined,
           (select count(distinct ${pkCol}) from ${countFrom})::int as producers_flagged
  `);
  const row = r.rows[0];
  return { gemsFlagged: Number(row.gems_flagged), adoptionsQuarantined: Number(row.adoptions_quarantined), producersFlagged: Number(row.producers_flagged), dryRun };
}
```
Export it (barrel covers `detection.js` already via `export * from "./detection.js"` — confirm).

`src/aggregator.controller.ts` `POST /sweep` — after `sweepQuarantine(this.db, { dryRun })`, run `const ad = await sweepAdoptionQuarantine(this.db, { dryRun });` and merge `adoptionsQuarantined: ad.adoptionsQuarantined` (and optionally `gemsFlagged`) into the returned report. Extend the `SweepReport` type + the response Zod schema with `adoptionsQuarantined: number`.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm exec tsc -b && pnpm exec vitest run dist/aggregator/__tests__/adoptionSweep.test.js`
Expected: PASS. Also run the existing attestation `detection`/`sweep` tests (unchanged behavior).

- [ ] **Step 5: Commit**
```bash
git add packages/aggregator/src/detection.ts packages/aggregator/src/index.ts src/aggregator.controller.ts src/aggregator/__tests__/adoptionSweep.test.ts
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "feat(aggregator): adoption sybil sweep — quarantine fresh-unbound install clusters

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: marketplace — verified-gated Diamond

**Files:**
- Modify: `packages/marketplace/src/api.ts`, `packages/marketplace/src/gems/rating.ts`, `packages/marketplace/src/StoneRating.tsx`, `packages/marketplace/src/pages/Gems.tsx`, `packages/marketplace/src/pages/Gem.tsx`
- Test: `packages/marketplace/src/gems/rating.test.ts` + `StoneRating.test.tsx` (extend)

**Interfaces:** `api.gemAdoption(keys) → Record<string, { installs; verifiedInstalls }>`; `isDiamond(grade, stars, verifiedInstalls?)`.

- [ ] **Step 1: Write the failing tests** — `rating.test.ts`:
```ts
// isDiamond keys the adoption axis on VERIFIED installs now:
expect(isDiamond(3, 21, 50)).toBe(true);    // 50 VERIFIED installs
expect(isDiamond(3, 21, 49)).toBe(false);   // <50 verified
// a gem with lots of RAW installs but few verified is NOT diamond — covered by passing the verified arg
// stoneRating unchanged (raw installs):
expect(stoneRating(1, 0, 50)).toBe(5);
```
`StoneRating.test.tsx`:
```tsx
// diamond requires verifiedInstalls, not raw installs:
render(<StoneRating cut="skill" grade={3} stars={21} installs={50} verifiedInstalls={0} />); // 5 of 5 but NOT diamond
// → no [data-diamond]
render(<StoneRating cut="skill" grade={3} stars={21} installs={50} verifiedInstalls={50} />); // diamond
// → [data-diamond="true"]
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @agentgem/marketplace test -- rating StoneRating`
Expected: FAIL.

- [ ] **Step 3: Implement**

`gems/rating.ts` — `isDiamond` now takes the VERIFIED count as its adoption arg (rename param for clarity):
```ts
export function isDiamond(grade: number | undefined, stars: number, verifiedInstalls = 0): boolean {
  return grade === 3 && starCurve(stars) === 5 && adoptionCurve(verifiedInstalls) === 5;
}
```
(`stoneRating` and `adoptionCurve` unchanged.)

`api.ts` `gemAdoption`:
```ts
gemAdoption: (keys: string[]): Promise<Record<string, { installs: number; verifiedInstalls: number }>> =>
  keys.length === 0 ? Promise.resolve({}) :
  get<{ items: { gemKey: string; installs: number; verifiedInstalls: number }[] }>(base, "/api/aggregator/gem-adoption", { keys: keys.join(",") })
    .then((r) => Object.fromEntries(r.items.map((i) => [i.gemKey, { installs: i.installs, verifiedInstalls: i.verifiedInstalls }])))
    .catch(() => ({})),
```

`StoneRating.tsx` — add `verifiedInstalls?: number`; `const n = stoneRating(grade, stars, installs ?? 0);` (raw); `const diamond = isDiamond(grade, stars, verifiedInstalls ?? 0);` (verified).

`Gems.tsx` / `Gem.tsx` — the adoption state is now `Record<string, { installs; verifiedInstalls }>`; pass `installs={a?.installs ?? 0} verifiedInstalls={a?.verifiedInstalls ?? 0}` (where `a = adoptions[g.key]`).

- [ ] **Step 4: Run to verify + gates**

Run: `pnpm --filter @agentgem/marketplace test && pnpm --filter @agentgem/marketplace typecheck && pnpm --filter @agentgem/marketplace build`
Expected: all green (update any existing test stub that mocked `gemAdoption` to return the new `{installs,verifiedInstalls}` shape).

- [ ] **Step 5: Commit**
```bash
git add packages/marketplace/src/api.ts packages/marketplace/src/gems/rating.ts packages/marketplace/src/gems/rating.test.ts packages/marketplace/src/StoneRating.tsx packages/marketplace/src/StoneRating.test.tsx packages/marketplace/src/pages/Gems.tsx packages/marketplace/src/pages/Gem.tsx
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "feat(marketplace): gate Diamond on verified installs; thread raw vs verified adoption

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Final verification

- Server `pnpm exec tsc -b` + full `pnpm test` green (build console first); the aggregate, sweep, and marketplace tests pass.
- Marketplace `test|typecheck|build` clean.
- Whole-branch review (opus — a trust/quarantine + rating-integrity change): the sweep exempts bound+aged producers, is dry-run-default + admin-gated, idempotent; the aggregate excludes quarantined + counts REAL bound accounts (not self-reported); Diamond keys on verified while the headline count stays raw+swept; k-anon still holds over non-quarantined.

## Out of scope (deferred)

Auto/cron sweep; trustScore-graded weighting; hard bind-at-ingest; a bind-on-install UX (the follow-up that makes verified adoption actually accrue); rating (non-Diamond) on verified.

## The result this delivers

Fake installers are excluded (quarantine sweep) and can never fake the apex (Diamond needs real OAuth-bound installers). The headline install count stays inclusive and honest; the ceiling is now costly to reach. The Cut × Stone rating rests on a signal that resists inflation.
