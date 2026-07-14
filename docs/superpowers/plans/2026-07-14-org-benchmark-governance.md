# Org Benchmark Governance (Settings + Enforcement) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.
>
> **Revised after `/plan-eng-review`.** Folded-in fixes: settings **write gated to App-installed orgs** (else non-App governance is a silent no-op); forbid is **forward-only** (documented, not "delete"); producer-side **graceful skip** on `org-forbidden` (Task 3); index-friendly `producerForbidden` query; **GET keeps one response shape** (no breaking `disabled` variant); extend `patchOrgSettings` (not `putOrgSettings`).

**Goal:** Let an org admin forbid the org from contributing to the benchmark (server-enforced at ingest, forward-only) and show/hide the org Benchmark view — extending `org_settings`, gated to App-installed orgs.

**Tech Stack:** TypeScript (ESM), Drizzle + PGlite (aggregator), raw Express, better-auth session, React (`packages/marketplace`), Vitest.

## Ship plan (backend then UI)
- **PR1 — backend (Tasks 1-4):** settings flags + ingest forbid + producer graceful-skip + route.
- **PR2 — UI (Task 5):** Governance section on the Benchmark tab.

## Global Constraints
- **Admin-only writes**, AND **App-installation-gated**: the settings POST requires `resolveOrgAccess(...).role === "admin"` (403 `not-admin`) **and** `access.via === "app"` (else 409 `app-required`). Write surface must equal the enforcement surface — enforcement joins the App-synced `org_members` roster, which non-App orgs lack.
- **Forbid is forward-only:** reject NEW and refreshed ingests from a forbidding org's bound members; do NOT remove already-ingested rows (that's Spec B purge). Say so in the UI.
- **Most-restrictive-org-wins:** a producer bound to a login in *any* `contribute_allowed=false` org is rejected.
- **Column-drift rule:** each new `org_settings` column gets the `create table` column AND a paired `alter table … add column if not exists`.
- Aggregator tests use `makeTestDb()` (not in CI; run locally). `grep -a`.

## File Structure
- `packages/aggregator/src/schema.ts`, `orgSettings.ts` (T1); `ingest.ts` (T2); `packages/insight/src/ingestClient.ts` (T3); `src/orgs/benchmark.ts` (T4); `packages/marketplace/src/{pages/Benchmark.tsx,api.ts,styles.css}` (T5).

---

## Task 1: `org_settings` — two governance flags

**Files:** Modify `packages/aggregator/src/schema.ts`, `orgSettings.ts`; Test `src/aggregator/__tests__/orgSettings.test.ts` (locate via `grep -a "patchOrgSettings\|getOrgSettings" src/aggregator/__tests__`).

**Produces:** `OrgSettings` gains `contributeAllowed: boolean` + `benchmarkViewEnabled: boolean` (default true); `getOrgSettings` returns them; `patchOrgSettings` accepts them as optional partial patches.

- [ ] **Step 1: Failing test:**
```ts
it("contributeAllowed/benchmarkViewEnabled default true and patch partially", async () => {
  const db = await makeTestDb();
  expect(await getOrgSettings(db, "acme")).toMatchObject({ contributeAllowed: true, benchmarkViewEnabled: true });
  await patchOrgSettings(db, "acme", { contributeAllowed: false }, "admin1");
  expect(await getOrgSettings(db, "acme")).toMatchObject({ contributeAllowed: false, benchmarkViewEnabled: true }); // untouched preserved
  await patchOrgSettings(db, "acme", { benchmarkViewEnabled: false }, "admin1");
  expect(await getOrgSettings(db, "acme")).toMatchObject({ contributeAllowed: false, benchmarkViewEnabled: false }); // prior flag NOT clobbered
});
```

- [ ] **Step 2: Run — FAIL.** `cd packages/aggregator && pnpm build && cd ../.. && pnpm vitest run src/aggregator/__tests__/orgSettings.test.ts`

- [ ] **Step 3: Schema** (`schema.ts`): add to the `orgSettings` pgTable — `contributeAllowed: boolean("contribute_allowed").notNull().default(true), benchmarkViewEnabled: boolean("benchmark_view_enabled").notNull().default(true),`; add the two columns to the `create table if not exists org_settings (...)` list; and two alters beside `dashboard_enabled` (schema.ts:673):
```ts
await db.execute(sql`alter table org_settings add column if not exists contribute_allowed boolean not null default true`);
await db.execute(sql`alter table org_settings add column if not exists benchmark_view_enabled boolean not null default true`);
```

- [ ] **Step 4: orgSettings.ts** — read it first. Extend `OrgSettings` (`+contributeAllowed, +benchmarkViewEnabled`), `getOrgSettings` (select + default-true when row absent, like `dashboardEnabled`), and `patchOrgSettings` in **all THREE spots** (a clobber trap): the `cur` read-merge (`const nextContribute = "contributeAllowed" in patch ? patch.contributeAllowed! : (cur?.contributeAllowed ?? true)`, same for view), the `.values({...})`, AND the `onConflictDoUpdate({ set: {...} })`. Add `contributeAllowed?: boolean; benchmarkViewEnabled?: boolean` to the patch param type.

- [ ] **Step 5: Run — PASS.** **Step 6: Commit** — `git commit -m "feat(aggregator): org_settings contribute_allowed + benchmark_view_enabled flags"`

---

## Task 2: Ingest enforcement — reject a forbidding org's members (forward-only)

**Files:** Modify `packages/aggregator/src/ingest.ts` (+ `index.ts` export); Test `src/aggregator/__tests__/ingest.test.ts`.

**Produces:** `producerForbidden(db, pubkey): Promise<boolean>`; `IngestResult` rejected union gains `"org-forbidden"`.

- [ ] **Step 1: Failing test** (reuse `make`/existing helpers + `replaceOrgMembers`, `patchOrgSettings`, and insert bindings):
```ts
it("rejects ingest from a producer whose org forbids contribution (forward-only)", async () => {
  const db = await makeTestDb();
  const a = make("sha256:fb");
  await db.execute(sql`insert into account_bindings (pubkey, provider, account_id, account_login) values (${a.producer.publicKey}, 'github', '1', 'U1')`); // note: original casing
  await replaceOrgMembers(db, "acme", [{ login: "u1", role: "member" }]);
  await patchOrgSettings(db, "acme", { contributeAllowed: false }, "admin1");
  expect(await ingestAttestation(db, a)).toEqual({ accepted: false, rejected: "org-forbidden" });
  expect((await db.execute<{ c: number }>(sql`select count(*)::int c from attestations`)).rows[0].c).toBe(0);
});
it("accepts an allowed/unbound producer", async () => {
  const db = await makeTestDb();
  expect(await ingestAttestation(db, make("sha256:ok"))).toMatchObject({ accepted: true });
});
```
(The binding uses login `U1` while the org member is `u1` — this test also proves the case-insensitive login join.)

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement** in `ingest.ts`. Query is **index-friendly** — `org_members.gh_login`/`org_scope` and `org_settings.scope` are lowercased at write, so only `account_login` needs `lower()`:
```ts
/** True when the producer's bound account_login belongs to ANY org that opted out
 *  (org_settings.contribute_allowed = false). Most-restrictive-wins; unbound → false. */
export async function producerForbidden(db: AppDb, pubkey: string): Promise<boolean> {
  const r = await db.execute<{ forbidden: boolean }>(sql`
    select exists(
      select 1 from account_bindings ab
      join org_members om on om.gh_login = lower(ab.account_login)
      join org_settings os on os.scope = om.org_scope
      where ab.pubkey = ${pubkey} and os.contribute_allowed = false
    ) as forbidden`);
  return r.rows[0]?.forbidden ?? false;
}
```
Extend `IngestResult` accepted-false variant: `rejected: "bad-signature" | "inconsistent" | "org-forbidden"`. In `ingestAttestation`, immediately after the `verifyAttestation` guard (before `priorId`):
```ts
  if (await producerForbidden(db, att.producer.publicKey)) return { accepted: false, rejected: "org-forbidden" };
```
(Forward-only by construction: a forbidden producer's existing row is neither refreshed nor removed — that's Spec B. Existing ingest tests use unbound producers → unaffected.)

- [ ] **Step 4: Run — PASS.** **Step 5: Commit** — `git commit -m "feat(aggregator): reject ingest from producers in a forbidding org"`

---

## Task 3: Producer client — graceful skip on `org-forbidden`

**Files:** Modify `packages/insight/src/ingestClient.ts`; Test `packages/insight/src/__tests__/ingestClient.test.ts`.

Without this, a forbidden org's member running contribution gets `failed: "ingest: response missing ingestId"` (the ingest returns `200 {accepted:false, rejected}`, and `postAttestation` throws on the missing `ingestId`). Fix: treat an accepted-false body as a skip.

- [ ] **Step 1: Failing test:**
```ts
it("skips (not throws) when the aggregator rejects the attestation (accepted:false)", async () => {
  const http = async () => ({ status: 200, json: async () => ({ accepted: false, rejected: "org-forbidden" }) });
  expect(await postAttestation({ attestation: att, endpoint: "https://x/ingest", http })).toEqual({ skipped: true });
});
```

- [ ] **Step 2: Run — FAIL** (currently throws "missing ingestId").

- [ ] **Step 3: Implement** — in `postAttestation`, after the 2xx status check, before the `ingestId` check:
```ts
  const body = (await res.json()) as { ingestId?: string; accepted?: boolean };
  if (body.accepted === false) return { skipped: true };   // policy reject (e.g. org-forbidden) — nothing to do
  if (!body.ingestId) throw new Error("ingest: response missing ingestId");
  return { ingestId: body.ingestId };
```
(`contributeCore` already maps `{skipped}` → `status:"skipped"`; the interactive path tolerates a skip. Confirm the existing 200-with-ingestId + non-2xx tests still pass.)

- [ ] **Step 4: Run — PASS.** **Step 5: Commit** — `git commit -m "fix(insight): postAttestation skips on an accepted:false (policy-rejected) ingest"`

---

## Task 4: Route — admin+App-gated settings POST; GET returns settings

**Files:** Modify `src/orgs/benchmark.ts`; Test `src/aggregator/__tests__/orgBenchmarkRoute.test.ts`.

**Produces:** `POST /api/orgs/:scope/benchmark/settings` (admin + App-installed). `GET` gains `settings` + `governanceAvailable` (whether the org is App-installed), same shape always; empty panels when `benchmarkViewEnabled=false`.

- [ ] **Step 1: Failing test** — extend the route test: admin (App-installed) POST persists (GET reflects); non-admin POST 403 `not-admin`; admin of a NON-App org (grant via account_scopes, no installation) POST → 409 `app-required`; GET includes `settings`+`governanceAvailable:true` (App org); GET returns empty panels + `settings` when `benchmarkViewEnabled=false`.

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement** in `src/orgs/benchmark.ts` (import `getOrgSettings, patchOrgSettings` from `@agentgem/aggregator`; add a `pickSettings(s) = { contributeAllowed: s.contributeAllowed, benchmarkViewEnabled: s.benchmarkViewEnabled }`).
  - `orgBenchmarkHandler` (after the admin gate): 
    ```ts
    const settings = await getOrgSettings(deps.db, scope);
    const governanceAvailable = access.via === "app";
    if (!settings.benchmarkViewEnabled) { res.json({ scope: scope.toLowerCase(), modelBenchmark: [], effectiveness: [], members: [], settings: pickSettings(settings), governanceAvailable }); return; }
    const [modelBenchmark, effectiveness, members] = await Promise.all([...existing...]);
    res.json({ scope: scope.toLowerCase(), modelBenchmark, effectiveness, members, settings: pickSettings(settings), governanceAvailable });
    ```
  - New `benchmarkSettingsHandler(deps)` — cors → OPTIONS → whoami/401 → scope/400 → `resolveOrgAccess` (403 none `not-member` / stale) → `role !== "admin"` → 403 `not-admin` → **`access.via !== "app"` → 409 `{ error: "connect the GitHub App to govern", reason: "app-required" }`** → build a partial patch from `req.body` (`{ contributeAllowed?, benchmarkViewEnabled? }`, only boolean fields) → `patchOrgSettings(deps.db, scope, patch, who.login)` → `res.json(pickSettings(updated))`.
  - Register: `expressApp.post("/api/orgs/:scope/benchmark/settings", benchmarkSettingsHandler(deps)); expressApp.options(same, benchmarkSettingsHandler(deps));` — the settings OPTIONS `preflight` allow-methods must include `POST`.

- [ ] **Step 4: Run — PASS.** **Step 5: Commit** — `git commit -m "feat(orgs): admin+App-gated POST /benchmark/settings; GET returns settings"` **→ Open PR1 (Tasks 1-4).**

---

## Task 5 (PR2): Marketplace — Governance section

**Files:** Modify `packages/marketplace/src/pages/Benchmark.tsx`, `api.ts`, `styles.css`; Test `Benchmark.test.tsx`.

- [ ] **Step 1:** Read the current `Benchmark.tsx`/`getOrgBenchmark` (#412). The GET now returns `settings` + `governanceAvailable`; thread them into the `ok` view (no new response union — same shape). Read a sibling settings-write for the pattern.

- [ ] **Step 2: `setOrgBenchmarkSettings`** in `api.ts` — `POST /api/orgs/${scope}/benchmark/settings`, `credentials:"include"`, body `{ contributeAllowed?, benchmarkViewEnabled? }`; return the new settings; map 403→forbidden, **409 `app-required`→ a typed `appRequired` result**.

- [ ] **Step 3: Failing jsdom test** — with `governanceAvailable:true`, the two toggles render (from `settings`), and toggling "Contribute" calls `setOrgBenchmarkSettings({contributeAllowed:false})` + reflects it; with `governanceAvailable:false`, a "connect the GitHub App to govern" note renders instead of toggles; with `benchmarkViewEnabled:false`, the panels are replaced by a "view hidden" notice + the re-enable "Show this view" toggle.

- [ ] **Step 4: Run — FAIL.** `pnpm --filter @agentgem/marketplace exec vitest run src/pages/Benchmark.test.tsx`

- [ ] **Step 5: Implement** a **Governance** section at the top of the `ok` render: two toggles bound to `settings` (each POSTs on change + updates local state), a one-line **forward-only** caveat ("Forbidding stops new contributions; it doesn't delete data already sent"), and — when `governanceAvailable` is false — a "connect the GitHub App to govern this org" note in place of the toggles. When `settings.benchmarkViewEnabled` is false, replace the three panels with a "view hidden by an admin" notice + the re-enable toggle. Every new `ex-benchmark-gov*` class gets a `styles.css` rule (reuse `.ex-benchmark-*`/`.ex-usage-*` + tokens); grep-confirm each `> 0`.

- [ ] **Step 6: Run — PASS.** **Step 7: Real-browser check** — serve `vite`, stub `GET /benchmark` (with `settings`+`governanceAvailable`) and the settings POST via injected `window.fetch` override + client-side re-nav (the #412 approach); confirm the toggles + caveat render styled and flipping works; stub `governanceAvailable:false` → note; stub `benchmarkViewEnabled:false` → hidden state. Screenshot.

- [ ] **Step 8: Commit** — `git commit -m "feat(marketplace): org benchmark Governance section (forbid + view toggle)"` **→ Open PR2.**

---

## Final verification (PR1)
- [ ] `pnpm build` clean; `pnpm vitest run packages/aggregator packages/insight src/aggregator/__tests__/{orgSettings,ingest,orgBenchmarkRoute}*.test.ts`.
- [ ] Manual: App-installed org, `contribute_allowed=false` → bound member's ingest = `org-forbidden`, not projected; producer `postAttestation` returns `{skipped}` (not throw). Non-App org admin POST settings → 409 `app-required`.

## NOT in scope (deferred)
- **Purge/export** of existing data = **Spec B** (forbid is forward-only; existing/pre-binding data persists until purge).
- **Non-App-org enforcement** (needs the `account_scopes`→login bridge — same deferral as #411); such orgs get the "connect GitHub App" state.
- **Retention** (dropped), **require-contribution** (not enforceable), non-benchmark governance.

## What already exists (reused)
`org_settings`+`getOrgSettings`/`patchOrgSettings`+`applyRetention` and the admin-gated settings pattern; `ingestAttestation`; `orgBenchmarkHandler`+`resolveOrgAccess`(`.via`) (#411); `postAttestation`/`contributeCore` (`{skipped}` handling); `Benchmark.tsx`/`getOrgBenchmark` (#412); `account_bindings`/`org_members`. New: 2 columns, 1 ingest check, 1 client skip, 1 route+settings, 1 UI section.

## Failure modes
| Codepath | Failure | Test? | Handled? | User sees |
|---|---|---|---|---|
| ingest | producer in forbidding org | ✓ (T2) | ✓ `org-forbidden` | contribution `skipped` (T3) |
| settings POST | non-admin | ✓ (T4) | ✓ 403 not-admin | "admins only" |
| settings POST | non-App org | ✓ (T4) | ✓ 409 app-required | "connect GitHub App" |
| GET | view disabled | ✓ (T4) | ✓ empty panels + settings | admin "view hidden" + re-enable |
| forbid | existing/pre-binding data | — | ⚠ forward-only (Spec B purge) | documented caveat in UI |

## Parallelization
Lane A: T1→T2 (aggregator, sequential). Lane B: T3 (insight, independent). Lane C: T4 (needs A). Lane D: T5/PR2 (needs T4). Order: A+B parallel → T4 → PR1 → T5 → PR2.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | issues → all folded | 1 P0, 2 P1, 1 P2, 2 P3 |

Reviewed by the user's directive (autonomous — recommendations applied without prompting). Own section pass + an opus outside-voice adversarial pass, verified against source.

Findings folded into this revision:
- **P0 — non-App orgs = silent no-op governance** (write gate grants admin via `account_scopes`, but forbid enforces off App-only `org_members`). → **settings write gated to `via==="app"`** (409 `app-required`); GET exposes `governanceAvailable`; UI shows a "connect GitHub App" state. Write surface = enforcement surface.
- **P1 — forbid is forward-only; existing rows freeze** (checked before the update path). → spec/plan language corrected to "no new/updated data; existing persists until Spec B purge"; UI caveat added.
- **P1 — pre-binding timing hole** (data landed before a bind can't be reached by forbid). → documented as forward-only / Spec-B territory.
- **P2 — `org-forbidden` made `postAttestation` throw `missing ingestId`.** → **new Task 3**: `postAttestation` returns `{skipped}` on an `accepted:false` body; `contributeCore` reports "skipped".
- **P3 — `producerForbidden` redundant `lower()` defeats indexes.** → `om.gh_login = lower(ab.account_login)`, `os.scope = om.org_scope` (the other columns are lowercased at write).
- **P3 — breaking `disabled` GET variant + near-cosmetic view toggle.** → GET keeps **one response shape** (empty panels + `settings` when off); UI hides client-side.
- Spec's `putOrgSettings` → `patchOrgSettings` (partial patch, all three merge spots).

**Verified non-issues:** JSON body parsing is mounted app-wide (`req.body` works); the join columns exist; `patchOrgSettings` is a true row-locked partial.

**OUTSIDE VOICE:** opus adversarial pass; verified every finding against source. Its P0 (silent no-op) is the load-bearing catch and drove the App-gate.

**VERDICT:** ENG CLEARED (revised) — every finding folded or explicitly deferred (Spec B purge). Ready to implement PR1.

NO UNRESOLVED DECISIONS
