# Detection v2 core-frequency prefilter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden `sweepQuarantine` against padding evasion by stripping low-frequency ingredients (per-attestation junk) before computing the shape fingerprint, so padded sybil attestations re-collapse to a shared core.

**Architecture:** A new `ing_freq` CTE computes each tool ingredient's global distinct-producer count; the existing `shapes` CTE joins it and keeps only ingredients at/above a `coreMinProducers` threshold. Everything downstream — `clusters`/`bad`/`targets`/`upd`, the #45 dry-run branch, and the verified-producer exemption — is unchanged.

**Tech Stack:** TypeScript (ESM, Node ≥22), drizzle-orm (pglite tests / node-postgres prod), vitest on compiled `dist/`.

## Global Constraints

- **WORK IN THE WORKTREE** `/Users/rfeng/Projects/ninemind/agentgem-detect2` (branch `feat/detection-v2`). All git + file ops target that dir (cwd does NOT persist across bash calls — use absolute paths or re-`cd`). Do NOT touch `/Users/rfeng/Projects/ninemind/agentgem` (the main checkout — another session uses it).
- Node ≥22, `"type": "module"`: relative imports end in `.js`.
- Tests run from COMPILED dist FROM THE WORKTREE: `cd /Users/rfeng/Projects/ninemind/agentgem-detect2 && npm test -- dist/<path>.test.js` (= `tsc -b && vitest run`).
- All SQL interpolation uses drizzle `sql\`...\`` bound `${}` params (no string concatenation).
- The change is confined to the `shapes` CTE region of `sweepQuarantine`. Do NOT alter `clusters`, `bad`, `targets`, the `updCte`/dry-run logic, the verified-exemption (`not exists (select 1 from account_bindings ...)`), or the count projection.
- New tuning knob: `SweepOpts.coreMinProducers?: number`, env `DETECT_CORE_MIN_PRODUCERS`, default **3**, read via the existing `num(process.env.X, default)` helper — same pattern as `minProducers`/`minShape`/etc.
- Tests must pass `coreMinProducers` EXPLICITLY (not rely on the env default) so a CI-set `DETECT_CORE_MIN_PRODUCERS` cannot perturb them.
- Commits: author `Raymond Feng <raymond@ninemind.ai>`; message body ends with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`. Use `git -c user.name=... -c user.email=...`.

---

### Task 1: Core-frequency prefilter in `sweepQuarantine`

**Files:**
- Modify: `src/aggregator/detection.ts`
- Test: `src/aggregator/__tests__/detection.test.ts` (add tests; do NOT change existing ones)

**Interfaces:**
- Consumes: existing `sweepQuarantine(db, opts)`, `SweepOpts`, `SweepReport`, the `num()` helper.
- Produces: `SweepOpts` gains `coreMinProducers?: number`; `sweepQuarantine` strips ingredients with global producer-count `< coreMinProducers` (default 3) before fingerprinting. No signature/return-shape change.

- [ ] **Step 1: Write the failing tests**

Append these tests inside the `describe("sweepQuarantine ...")` block in `src/aggregator/__tests__/detection.test.ts` (the file's `att`, `OPTS`, imports already exist; `OPTS = { minProducers: 3, minShape: 2, freshMaxAttest: 1, freshFraction: 0.8 }`):

```ts
  it("DEFEATS padding evasion: unique junk per attestation no longer splits a coordinated cluster", async () => {
    const db = await makeTestDb();
    const core = ["skill:a", "skill:b"]; // the shared coordinated core (>= minShape)
    // 3 fresh producers, each padding their attestation with a DISTINCT unique junk skill
    for (const i of [1, 2, 3]) {
      await projectAttestation(db, att(`ed25519:p${i}`, `d${i}`, [...core, `skill:junk${i}`]));
    }
    // v1-equivalent (junk retained): every fingerprint differs -> NO cluster -> nothing flagged
    const v1 = await sweepQuarantine(db, { ...OPTS, coreMinProducers: 1, dryRun: true });
    expect(v1.attestationsQuarantined).toBe(0);
    // v2 (default prefilter, junk freq=1 dropped): cores match -> cluster of 3 -> flagged
    const v2 = await sweepQuarantine(db, { ...OPTS, coreMinProducers: 2, dryRun: true });
    expect(v2).toEqual({ clustersFound: 1, attestationsQuarantined: 3, producersFlagged: 3, dryRun: true });
  });

  it("does not merge two distinct cores into one bogus cluster", async () => {
    const db = await makeTestDb();
    for (const i of [1, 2, 3]) await projectAttestation(db, att(`ed25519:a${i}`, `da${i}`, ["skill:a", "skill:b"]));
    for (const i of [1, 2, 3]) await projectAttestation(db, att(`ed25519:c${i}`, `dc${i}`, ["skill:c", "skill:d"]));
    // both cores survive the prefilter (each ingredient used by its 3-producer group), and stay SEPARATE
    const rep = await sweepQuarantine(db, { ...OPTS, coreMinProducers: 2, dryRun: true });
    expect(rep.clustersFound).toBe(2);          // two distinct clusters, not one merged mega-cluster
    expect(rep.attestationsQuarantined).toBe(6);
  });

  it("padded cluster still exempts a GitHub-verified producer (verified-exemption survives the prefilter)", async () => {
    const db = await makeTestDb();
    const core = ["skill:a", "skill:b"];
    for (const i of [1, 2, 3]) await projectAttestation(db, att(`ed25519:p${i}`, `d${i}`, [...core, `skill:junk${i}`]));
    await db.execute(sql`insert into account_bindings(pubkey, provider, account_id, account_login)
      values ('ed25519:p1', 'github', '42', 'octocat')`);
    const rep = await sweepQuarantine(db, { ...OPTS, coreMinProducers: 2 }); // apply (real)
    expect(rep.attestationsQuarantined).toBe(2); // p2 + p3; p1 exempt (bound)
    expect(rep.producersFlagged).toBe(2);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/rfeng/Projects/ninemind/agentgem-detect2 && npm test -- dist/aggregator/__tests__/detection.test.js`
Expected: the THREE new tests FAIL — without the prefilter, `coreMinProducers` is ignored, so the padded cluster is never detected (the first new test's `v2` reports `attestationsQuarantined: 0` instead of 3). (The 7 pre-existing tests still PASS.)

- [ ] **Step 3: Implement the prefilter**

In `src/aggregator/detection.ts`:

(a) Add the option to `SweepOpts` (after `freshFraction`):

```ts
  coreMinProducers?: number; // ingredients used by fewer than this many distinct producers are treated as padding noise and dropped before fingerprinting
```

(b) Read it alongside the other knobs (after the `freshFraction` line):

```ts
  const coreMinProducers = opts.coreMinProducers ?? num(process.env.DETECT_CORE_MIN_PRODUCERS, 3);
```

(c) In the `sql\`...\`` query, replace the `with shapes as (...)` opening — i.e. add an `ing_freq` CTE BEFORE `shapes` and add the `ing_freq` join inside `shapes`. The query currently begins:

```
    with shapes as (
      select e.attestation_id as aid, a.producer_pubkey as pk,
             string_agg(e.ingredient_id, ',' order by e.ingredient_id) as fp,
             count(*) as shape_size
      from usage_edges e
      join attestations a on a.id = e.attestation_id and not a.quarantined
      join ingredients  i on i.id = e.ingredient_id and i.kind in ('skill','mcp')
      group by e.attestation_id, a.producer_pubkey
    ),
```

Replace that block with:

```
    with ing_freq as (
      -- global distinct-producer count per tool ingredient; padding junk is near-unique (count ~1)
      select e.ingredient_id as iid, count(distinct a.producer_pubkey) as prod_count
      from usage_edges e
      join attestations a on a.id = e.attestation_id and not a.quarantined
      join ingredients  i on i.id = e.ingredient_id and i.kind in ('skill','mcp')
      group by e.ingredient_id
    ),
    shapes as (
      select e.attestation_id as aid, a.producer_pubkey as pk,
             string_agg(e.ingredient_id, ',' order by e.ingredient_id) as fp,
             count(*) as shape_size
      from usage_edges e
      join attestations a on a.id = e.attestation_id and not a.quarantined
      join ingredients  i on i.id = e.ingredient_id and i.kind in ('skill','mcp')
      join ing_freq f on f.iid = e.ingredient_id and f.prod_count >= ${coreMinProducers}
      group by e.attestation_id, a.producer_pubkey
    ),
```

Leave `clusters`, `bad`, `targets`, `${updCte}`, and the final `select ... count` projection exactly as they are.

(d) Update the function's doc comment: add one sentence noting that the shape is computed over the **core** (ingredients used by ≥ `coreMinProducers` producers), so per-attestation padding is stripped before clustering.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/rfeng/Projects/ninemind/agentgem-detect2 && npm test -- dist/aggregator/__tests__/detection.test.js`
Expected: PASS — all 10 tests (7 pre-existing unchanged + 3 new). The pre-existing clusters still flag identically (their shared ingredients are used by all 3 cluster producers → freq 3 ≥ default 3 → retained).

- [ ] **Step 5: Commit**

```bash
cd /Users/rfeng/Projects/ninemind/agentgem-detect2
git add src/aggregator/detection.ts src/aggregator/__tests__/detection.test.ts
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "feat(aggregator): detection v2 — core-frequency prefilter (anti-padding-evasion)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

- [ ] **Step 6: Full-suite sanity**

Run: `cd /Users/rfeng/Projects/ninemind/agentgem-detect2 && npm test 2>&1 | tail -3`
Expected: green — the whole root suite from the worktree, detection v2 included, nothing regressed. If a test you did NOT touch fails, report it (name + output); do not fix unrelated files.

---

## Deferred (NOT in this plan)

- Pairwise-overlap / connected-component clustering and frequent-itemset mining (heavier algorithms).
- Detection-tuning telemetry / reporting of which ingredients were treated as padding.
- The `POST /api/aggregator/sweep` endpoint + scheduler are unchanged — they call `sweepQuarantine`, which transparently gets stronger.
