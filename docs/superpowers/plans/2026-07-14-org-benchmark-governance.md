# Org Benchmark Governance (Settings + Enforcement) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an org admin forbid the org from contributing to the network benchmark (server-enforced at ingest) and show/hide the org Benchmark view — extending the existing `org_settings` surface.

**Architecture:** Two new `org_settings` flags (`contribute_allowed`, `benchmark_view_enabled`); an admin-gated `POST /api/orgs/:scope/benchmark/settings`; ingest rejects a forbidding org's members' attestations (`org-forbidden`); a Governance section on the marketplace Benchmark tab.

**Tech Stack:** TypeScript (ESM), Drizzle + PGlite (aggregator), raw Express (org routes), better-auth session, React (`packages/marketplace`), Vitest.

## Ship plan (backend then UI)
- **PR1 — backend (Tasks 1-3):** settings storage + ingest enforcement + route.
- **PR2 — UI (Task 4):** the Governance section on the Benchmark tab.

## Global Constraints
- **Admin-only writes** (`resolveOrgAccess(...).role === "admin"`; 403 `not-admin` otherwise) — same gate as `GET /api/orgs/:scope/benchmark`.
- **Forbid = most-restrictive-org-wins**: a producer bound to a login in *any* `contribute_allowed=false` org is rejected at ingest. Unbound producers are unaffected.
- **Column-drift rule:** every new `org_settings` column gets BOTH the `create table` column AND a paired `alter table … add column if not exists` in `ensureSchema`.
- `/api/orgs/` is already originGuard-exempt. Aggregator tests use `makeTestDb()` (not in CI; run locally). `grep -a`.

## File Structure
- `packages/aggregator/src/schema.ts` — 2 `org_settings` columns (create + alters).
- `packages/aggregator/src/orgSettings.ts` — extend `OrgSettings`/`getOrgSettings`/`patchOrgSettings`.
- `packages/aggregator/src/ingest.ts` — `producerForbidden` + the `org-forbidden` reject; `packages/aggregator/src/index.ts` export if needed.
- `src/orgs/benchmark.ts` — `POST /benchmark/settings` + GET returns `settings`/`disabled`.
- `packages/marketplace/src/pages/Benchmark.tsx`, `api.ts`, `styles.css` — Governance section (PR2).

---

## Task 1: `org_settings` — two governance flags

**Files:** Modify `packages/aggregator/src/schema.ts`, `packages/aggregator/src/orgSettings.ts`; Test `src/aggregator/__tests__/orgSettings.test.ts` (or wherever `getOrgSettings`/`patchOrgSettings` are tested — `grep -a "putOrgSettings\|patchOrgSettings" src/aggregator/__tests__`).

**Interfaces produced:** `OrgSettings` gains `contributeAllowed: boolean` + `benchmarkViewEnabled: boolean` (default true). `getOrgSettings` returns them; `patchOrgSettings` accepts them as optional patches.

- [ ] **Step 1: Failing test** — round-trip the two new fields, defaults preserved:

```ts
it("org settings default contributeAllowed/benchmarkViewEnabled true and round-trip", async () => {
  const db = await makeTestDb();
  const def = await getOrgSettings(db, "acme");
  expect(def).toMatchObject({ contributeAllowed: true, benchmarkViewEnabled: true });
  await patchOrgSettings(db, "acme", { contributeAllowed: false }, "admin1");
  const after = await getOrgSettings(db, "acme");
  expect(after).toMatchObject({ contributeAllowed: false, benchmarkViewEnabled: true }); // untouched field preserved
});
```

- [ ] **Step 2: Run — FAIL.** `cd packages/aggregator && pnpm build && cd ../.. && pnpm vitest run src/aggregator/__tests__/orgSettings.test.ts`

- [ ] **Step 3: Schema.** In `schema.ts`, add to the `orgSettings` pgTable and to the `ensureSchema` DDL:
  - pgTable: `contributeAllowed: boolean("contribute_allowed").notNull().default(true), benchmarkViewEnabled: boolean("benchmark_view_enabled").notNull().default(true),`
  - `create table if not exists org_settings (...)` — add `contribute_allowed boolean not null default true, benchmark_view_enabled boolean not null default true` to the column list.
  - Two alters (beside `alter table org_settings add column if not exists dashboard_enabled …`, schema.ts:673):
    ```ts
    await db.execute(sql`alter table org_settings add column if not exists contribute_allowed boolean not null default true`);
    await db.execute(sql`alter table org_settings add column if not exists benchmark_view_enabled boolean not null default true`);
    ```

- [ ] **Step 4: orgSettings.ts.** Read the file first. Extend:
  - `OrgSettings` interface: add `contributeAllowed: boolean; benchmarkViewEnabled: boolean;`.
  - `getOrgSettings`: select + return the two fields (default `true` when the row is absent, mirroring `dashboardEnabled`).
  - `patchOrgSettings` (line 47): add `contributeAllowed?: boolean; benchmarkViewEnabled?: boolean` to its patch-values type and to the `set`/`onConflictDoUpdate` clause, mirroring exactly how it handles `dashboardEnabled` (partial — only sets provided fields).

- [ ] **Step 5: Run — PASS.**
- [ ] **Step 6: Commit** — `git commit -m "feat(aggregator): org_settings contribute_allowed + benchmark_view_enabled flags"`

---

## Task 2: Ingest enforcement — reject a forbidding org's members

**Files:** Modify `packages/aggregator/src/ingest.ts` (+ `index.ts` export if `producerForbidden` is tested cross-module); Test `src/aggregator/__tests__/ingest.test.ts`.

**Interfaces produced:** `producerForbidden(db, pubkey): Promise<boolean>`; `IngestResult` rejected union gains `"org-forbidden"`.

- [ ] **Step 1: Failing test** — append to `ingest.test.ts` (reuse its `make`/`bind` helpers + `replaceOrgMembers` from `@agentgem/aggregator`, and `patchOrgSettings`):

```ts
it("rejects an attestation from a producer whose org forbids contribution", async () => {
  const db = await makeTestDb();
  const a = make("sha256:fb");                       // producer P
  // bind P's key to login u1, put u1 in org 'acme', set acme contribute_allowed=false
  await db.insert(accountBindings).values({ pubkey: a.producer.publicKey, provider: "github", accountId: "1", accountLogin: "u1" });
  await replaceOrgMembers(db, "acme", [{ login: "u1", role: "member" }]);
  await patchOrgSettings(db, "acme", { contributeAllowed: false }, "admin1");
  const r = await ingestAttestation(db, a);
  expect(r).toEqual({ accepted: false, rejected: "org-forbidden" });
  expect((await db.execute<{ c: number }>(sql`select count(*)::int c from attestations`)).rows[0].c).toBe(0); // not projected
});
it("still accepts a producer whose orgs all allow (or who is unbound)", async () => {
  const db = await makeTestDb();
  const r = await ingestAttestation(db, make("sha256:ok"));   // unbound → no org → allowed
  expect(r).toMatchObject({ accepted: true });
});
```

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement.** Add to `ingest.ts`:

```ts
/** True when the producer's bound account_login belongs to ANY org that has opted out
 *  (org_settings.contribute_allowed = false). Most-restrictive-org-wins; unbound → false. */
export async function producerForbidden(db: AppDb, pubkey: string): Promise<boolean> {
  const r = await db.execute<{ forbidden: boolean }>(sql`
    select exists(
      select 1 from account_bindings ab
      join org_members om on lower(om.gh_login) = lower(ab.account_login)
      join org_settings os on lower(os.scope) = lower(om.org_scope)
      where ab.pubkey = ${pubkey} and os.contribute_allowed = false
    ) as forbidden`);
  return r.rows[0]?.forbidden ?? false;
}
```
Extend the result type: `IngestResult`'s accepted-false variant → `rejected: "bad-signature" | "inconsistent" | "org-forbidden"`. In `ingestAttestation`, right after the `verifyAttestation` guard:
```ts
  if (await producerForbidden(db, att.producer.publicKey)) return { accepted: false, rejected: "org-forbidden" };
```

- [ ] **Step 4: Run — PASS** (new + existing ingest tests). Existing tests use unbound producers → `producerForbidden` false → unaffected.
- [ ] **Step 5: Commit** — `git commit -m "feat(aggregator): reject ingest from producers in a forbidding org (org-forbidden)"`

---

## Task 3: Route — settings POST + GET returns settings/disabled

**Files:** Modify `src/orgs/benchmark.ts`; Test `src/aggregator/__tests__/orgBenchmarkRoute.test.ts`.

**Interfaces produced:** `POST /api/orgs/:scope/benchmark/settings` (admin) → `{ contributeAllowed, benchmarkViewEnabled }`. `GET` response gains `settings`; returns `{ scope, disabled: true, settings }` when `benchmarkViewEnabled === false`.

- [ ] **Step 1: Failing test** — extend the route test: admin POST persists (GET reflects it); non-admin POST 403; GET includes `settings`; GET returns `disabled:true` after the admin sets `benchmarkViewEnabled:false`.

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement in `src/orgs/benchmark.ts`.** Import `getOrgSettings, patchOrgSettings` from `@agentgem/aggregator`.
  - In `orgBenchmarkHandler`, after the admin gate, read settings and branch:
    ```ts
    const settings = await getOrgSettings(deps.db, scope);
    if (!settings.benchmarkViewEnabled) { res.json({ scope: scope.toLowerCase(), disabled: true, settings: pickBenchmarkSettings(settings) }); return; }
    const [modelBenchmark, effectiveness, members] = await Promise.all([...]);
    res.json({ scope: scope.toLowerCase(), modelBenchmark, effectiveness, members, settings: pickBenchmarkSettings(settings) });
    ```
    where `pickBenchmarkSettings(s) = { contributeAllowed: s.contributeAllowed, benchmarkViewEnabled: s.benchmarkViewEnabled }`.
  - Add `benchmarkSettingsHandler(deps)` mirroring the GET's gate (cors → OPTIONS → whoami/401 → scope/400 → resolveOrgAccess → require admin), then:
    ```ts
    const body = (req.body ?? {}) as { contributeAllowed?: boolean; benchmarkViewEnabled?: boolean };
    const patch: Record<string, boolean> = {};
    if (typeof body.contributeAllowed === "boolean") patch.contributeAllowed = body.contributeAllowed;
    if (typeof body.benchmarkViewEnabled === "boolean") patch.benchmarkViewEnabled = body.benchmarkViewEnabled;
    const updated = await patchOrgSettings(deps.db, scope, patch, who.login);
    res.json({ contributeAllowed: updated.contributeAllowed, benchmarkViewEnabled: updated.benchmarkViewEnabled });
    ```
    (Confirm `req.body` is parsed — the express app has a JSON body parser; the usage settings PUT relies on it. If not, mirror how `orgSettingsHandler` reads the body.)
  - Register in `installOrgBenchmark`: `expressApp.post("/api/orgs/:scope/benchmark/settings", benchmarkSettingsHandler(deps)); expressApp.options("/api/orgs/:scope/benchmark/settings", benchmarkSettingsHandler(deps));` and update the GET's OPTIONS `preflight` allow-methods to include POST for the settings path (or give the settings handler its own OPTIONS branch).

- [ ] **Step 4: Run — PASS.**
- [ ] **Step 5: Commit** — `git commit -m "feat(orgs): admin POST /benchmark/settings; GET returns settings/disabled"` **→ Open PR1 (Tasks 1-3).**

---

## Task 4 (PR2): Marketplace — Governance section on the Benchmark tab

**Files:** Modify `packages/marketplace/src/pages/Benchmark.tsx`, `api.ts`, `styles.css`; Test `Benchmark.test.tsx`.

- [ ] **Step 1:** Read the current `Benchmark.tsx` (from #412) + `getOrgBenchmark` in `api.ts`. The GET now returns `settings` (and possibly `disabled`) — thread them through the `ok` view. Read a sibling settings-write for the toggle pattern (`grep -a "usage/settings\|putOrgSettings\|setOrg" packages/marketplace/src/api.ts`).

- [ ] **Step 2: `setOrgBenchmarkSettings`** in `api.ts` — `POST /api/orgs/${scope}/benchmark/settings` with `credentials:"include"`, body `{ contributeAllowed?, benchmarkViewEnabled? }`, returns the new settings (map 403 → forbidden like the GET).

- [ ] **Step 3: Failing jsdom test** — governance toggles render (admin ok state) with current `settings`; toggling "Contribute" calls `setOrgBenchmarkSettings({ contributeAllowed:false })` and reflects it; the `disabled` GET response renders the "view disabled" state with a re-enable toggle.

- [ ] **Step 4: Run — FAIL.** `pnpm --filter @agentgem/marketplace exec vitest run src/pages/Benchmark.test.tsx`

- [ ] **Step 5: Implement.** Add a **Governance** section at the top of the `ok` render: two labelled toggles bound to `settings.contributeAllowed` / `settings.benchmarkViewEnabled`, each POSTing on change and updating local state. Handle the `disabled` response (panels replaced by an admin notice + the re-enable "Show this view" toggle). Every new `ex-benchmark-gov*` class gets a `styles.css` rule (reuse the `.ex-benchmark-*`/`.ex-usage-*` families + tokens); grep-confirm each `> 0`.

- [ ] **Step 6: Run — PASS.**
- [ ] **Step 7: Real-browser check** — serve `vite`, stub `GET /benchmark` (with `settings`) and the settings POST via an injected `window.fetch` override + client-side re-nav (the #412 approach); confirm the toggles render styled and flipping them works; and stub a `disabled:true` response to confirm the disabled state. Screenshot for the PR.

- [ ] **Step 8: Commit** — `git commit -m "feat(marketplace): org benchmark Governance section (forbid + view toggle)"` **→ Open PR2.**

---

## Final verification (PR1)

- [ ] `pnpm build` clean; `pnpm vitest run packages/aggregator src/aggregator/__tests__/{orgSettings,ingest,orgBenchmarkRoute}*.test.ts`.
- [ ] Manual: set `contribute_allowed=false` for an org; ingest an attestation from a bound member → `org-forbidden`, not projected; set it back true → accepted. Set `benchmark_view_enabled=false` → GET returns `disabled`.

## NOT in scope (deferred)

- **Purge / export** of the org's benchmark data = **Spec B** (data-actions).
- **Retention** (dropped — shared per-producer data). **Require-contribution** (not server-enforceable). **Governance for non-benchmark data.**

## What already exists (reused)

`org_settings` + `getOrgSettings`/`patchOrgSettings` + the admin-gated `/api/usage/settings` pattern (`orgSettings.ts`, `usage/install.ts`); `ingestAttestation` (`ingest.ts`); the admin gate + `orgBenchmarkHandler` (`src/orgs/benchmark.ts`, #411); `resolveOrgAccess`; `account_bindings`/`org_members` (the forbid join); `Benchmark.tsx` + `getOrgBenchmark` (#412). The plan adds two columns, one ingest check, one route + settings, and one UI section.

## Failure modes

| Codepath | Failure | Test? | Handled? | User sees |
|---|---|---|---|---|
| ingest | producer in a forbidding org | ✓ (T2) | ✓ `org-forbidden` | contribution silently skipped (producer side) |
| settings POST | non-admin | ✓ (T3) | ✓ 403 not-admin | "admins only" |
| GET | view disabled | ✓ (T3) | ✓ `disabled:true` | admin-disabled notice + re-enable toggle |
| ingest | producer in 2 orgs, one forbids | ✓ (T2 variant) | ✓ most-restrictive wins | rejected |

## Parallelization

| Lane | Tasks | Modules | Depends on |
|---|---|---|---|
| A | T1 → T2 | `packages/aggregator/` | T2 needs T1's `contribute_allowed` |
| B | T3 | `src/orgs/` | A (getOrgSettings/patchOrgSettings) |
| C | T4 (PR2) | `packages/marketplace/` | B (route shape) |

**Order:** T1 → T2 → T3 → PR1; then T4 → PR2.
