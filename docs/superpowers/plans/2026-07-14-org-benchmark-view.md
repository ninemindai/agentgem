# Org-Scoped Benchmark Admin View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give org admins an org-internal benchmark view — org-filtered model outcomes, gem effectiveness, and a per-member breakdown — as a new tab on the marketplace `/orgs/:scope` hub.

**Architecture:** Three org-scoped aggregate queries (the org-filtered, no-k-floor analogues of `modelBenchmark`/`effectiveness`) filtered by the App-synced `org_members` roster; a raw-express admin-gated route `GET /api/orgs/:scope/benchmark` mirroring `orgUsageHandler`; and a marketplace `Benchmark` page mirroring `TeamUsage`.

**Tech Stack:** TypeScript (ESM, Node ≥24), Drizzle + PGlite (aggregator), raw Express (org routes), better-auth session, React (`packages/marketplace`), Vitest.

## Ship plan (backend then UI)

- **PR1 — backend (Tasks 1-3):** the three aggregates + the admin route. Independently testable.
- **PR2 — UI (Task 4):** the marketplace Benchmark tab. Depends on PR1's route.
(Small enough to be one PR if preferred; keep the task order.)

## Global Constraints

- **Admin-only:** the route requires `resolveOrgAccess(...).role === "admin"`; non-admins 403 `{ reason: "not-admin" }`.
- **No k-anonymity floor** in the org aggregates — the admin owns this data (drop the `HAVING count(distinct producer) >= k`).
- **Membership authority = the App-synced `org_members` roster** (`org_members.gh_login = account_bindings.account_login`). Only **bound** producers who are org members appear. Non-App orgs (membership via `account_scopes` only) are **out of scope** (documented).
- **`/api/orgs/` is already originGuard-exempt** (`originGuard.ts:93`) and in the credentialed-CORS family — no `PUBLIC_READ_PATHS` entry.
- **Every new marketplace `ex-*` class gets a matching `packages/marketplace/src/styles.css` rule** (no CSS framework) against the `--ink`/`--surface`/`--brand` tokens (PR2).
- Aggregator tests use `makeTestDb()` (pglite); not in CI (`test (24)` gates root `dist/__tests__`) — run locally. `grep -a` (some files are binary-classified).

---

## File Structure

- `packages/aggregator/src/orgBenchmark.ts` (new) — `orgMemberLogins`, `orgModelBenchmark`, `orgEffectiveness`, `orgMemberBreakdown`.
- `packages/aggregator/src/index.ts` — export the above.
- `src/orgs/benchmark.ts` (new) — `installOrgBenchmark(expressApp, deps)` + the handler.
- `src/serverAggregator.ts` — call `installOrgBenchmark(...)` beside `installUsage(...)`.
- `packages/marketplace/src/pages/Benchmark.tsx` (new), `src/api.ts` (`getOrgBenchmark`), `src/Router.tsx` (route), cross-links in `OrgCatalog.tsx`/`TeamUsage.tsx`, `src/styles.css`.

---

## Task 1: Aggregator — `orgMemberLogins` + `orgModelBenchmark`

**Files:** Create `packages/aggregator/src/orgBenchmark.ts`; Modify `packages/aggregator/src/index.ts`; Test `src/aggregator/__tests__/orgBenchmark.test.ts`.

**Interfaces produced:**
- `orgMemberLogins(db, scope): Promise<string[]>` — lowercased `gh_login`s in `org_members` for the scope.
- `orgModelBenchmark(db, scope): Promise<{ model; mostly; partially; notAchieved; producers; successRate }[]>` — per-model outcomes over the org's members' attestations, no k-floor. `successRate = mostly/(mostly+partially+notAchieved)` (0 when denom 0).

- [ ] **Step 1: Failing test** `src/aggregator/__tests__/orgBenchmark.test.ts` (mirror `verifiedProducers.test.ts` seeding + `githubAppStore.test.ts`'s `replaceOrgMembers`):

```ts
import { describe, it, expect } from "vitest";
import { makeTestDb, projectAttestation, replaceOrgMembers, orgModelBenchmark } from "@agentgem/aggregator";
import { accountBindings } from "@agentgem/aggregator"; // if exported; else insert via db.execute
// att(pubkey, digest, model, outcome) — build a formatVersion-2 attestation with one model_outcome.
// Reuse the attestation shape from verifiedProducers.test.ts / modelBenchmark.test.ts.

async function bind(db: any, pubkey: string, login: string) {
  await db.insert(accountBindings).values({ pubkey, provider: "github", accountId: pubkey.slice(-3), accountLogin: login });
}

it("orgModelBenchmark counts only the scope's bound members, no k-floor", async () => {
  const db = await makeTestDb();
  await projectAttestation(db, att("ed25519:m1", "d1", "claude-opus-4-8", { mostly: 2 }));  // member u1
  await projectAttestation(db, att("ed25519:x1", "d2", "claude-opus-4-8", { mostly: 5 }));  // NON-member
  await projectAttestation(db, att("ed25519:u2", "d3", "claude-opus-4-8", { not: 1 }));     // bound but no org
  await bind(db, "ed25519:m1", "u1");
  await bind(db, "ed25519:x1", "u9");
  await bind(db, "ed25519:u2", "u2");
  await replaceOrgMembers(db, "acme", [{ login: "u1", role: "admin" }]); // only u1 is in acme

  const rows = await orgModelBenchmark(db, "acme");
  expect(rows.length).toBe(1);                    // single k-anon floor NOT applied (1 producer)
  expect(rows[0]).toMatchObject({ model: "claude-opus-4-8", mostly: 2, producers: 1 });
  expect(rows[0].mostly).toBe(2);                 // u9's 5 and u2's 1 excluded
});
```

- [ ] **Step 2: Run — FAIL.** `cd packages/aggregator && pnpm build && cd ../.. && pnpm vitest run src/aggregator/__tests__/orgBenchmark.test.ts`

- [ ] **Step 3: Implement `orgBenchmark.ts`.** Adapt the real `modelBenchmark` SQL (`aggregates.ts:44-59`): add the membership filter, drop the k-floor, compute `successRate`.

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Org-scoped benchmark aggregates: the org-filtered, no-k-anon analogues of the public
// modelBenchmark/effectiveness. Membership = the App-synced org_members roster joined to a
// producer's bound account_login. Admin-gated at the route; de-anonymized within the org.
import { sql } from "drizzle-orm";
import type { AppDb } from "./schema.js";
import { effectivenessScore, type EffectivenessRow } from "./aggregates.js";

/** Producer-membership predicate: attestations whose producer's bound account_login is a
 *  member of `scope` (App-synced org_members roster). Shared by all three aggregates. */
const memberPubkeys = (scope: string) => sql`
  a.producer_pubkey in (
    select ab.pubkey from account_bindings ab
    join org_members om on lower(om.gh_login) = lower(ab.account_login)
    where lower(om.org_scope) = lower(${scope})
  )`;

export async function orgMemberLogins(db: AppDb, scope: string): Promise<string[]> {
  const r = await db.execute<{ login: string }>(sql`select lower(gh_login) as login from org_members where lower(org_scope) = lower(${scope})`);
  return r.rows.map((x) => x.login);
}

export async function orgModelBenchmark(db: AppDb, scope: string): Promise<{ model: string; mostly: number; partially: number; notAchieved: number; producers: number; successRate: number }[]> {
  const r = await db.execute<{ model: string; mostly: number; partially: number; notAchieved: number; producers: number }>(sql`
    select mo.model,
           sum(mo.mostly)::int as mostly,
           sum(mo.partially)::int as partially,
           sum(mo.not_achieved)::int as "notAchieved",
           count(distinct a.producer_pubkey)::int as producers
    from model_outcomes mo
    join attestations a on a.id = mo.attestation_id and not a.quarantined
    where ${memberPubkeys(scope)}
    group by mo.model
    order by producers desc, mo.model
  `);
  return r.rows.map((x) => { const d = x.mostly + x.partially + x.notAchieved; return { ...x, successRate: d > 0 ? (x.mostly + 0.5 * x.partially) / d : 0 }; });
}
```

Export from `packages/aggregator/src/index.ts` (add `export * from "./orgBenchmark.js";`). Confirm `accountBindings`/`replaceOrgMembers`/`projectAttestation` are exported from the barrel for the test (`grep -a "orgBenchmark\|replaceOrgMembers\|accountBindings" packages/aggregator/src/index.ts`); if `accountBindings` isn't exported, insert the binding in the test via `db.execute(sql\`insert into account_bindings ...\`)`.

- [ ] **Step 4: Run — PASS.** Rebuild + rerun the test.

- [ ] **Step 5: Commit** — `git commit -m "feat(aggregator): orgModelBenchmark + orgMemberLogins (org-scoped, no k-floor)"`

---

## Task 2: Aggregator — `orgEffectiveness` + `orgMemberBreakdown`

**Files:** Modify `packages/aggregator/src/orgBenchmark.ts`; Test `src/aggregator/__tests__/orgBenchmark.test.ts`.

**Interfaces produced:**
- `orgEffectiveness(db, scope): Promise<EffectivenessRow[]>` — per-gem confidence-weighted score over the org's members (reuse `effectivenessScore`), no k-floor, sorted by score.
- `orgMemberBreakdown(db, scope): Promise<{ login; attestations; gems; mostly; partially; notAchieved }[]>` — grouped by member login.

- [ ] **Step 1: Failing tests** — add to `orgBenchmark.test.ts`:

```ts
it("orgEffectiveness scores the scope's gems only, no k-floor", async () => {
  const db = await makeTestDb();
  await projectAttestation(db, att("ed25519:m1", "d1", "m", { mostly: 3 }, "gemA"));
  await projectAttestation(db, att("ed25519:x1", "d2", "m", { mostly: 9 }, "gemZ")); // non-member
  await bind(db, "ed25519:m1", "u1"); await bind(db, "ed25519:x1", "u9");
  await replaceOrgMembers(db, "acme", [{ login: "u1", role: "admin" }]);
  const rows = await orgEffectiveness(db, "acme");
  expect(rows.map((r) => r.gemName)).toEqual(["gemA"]);      // gemZ (non-member) excluded
  expect(rows[0].judged).toBe(3);
});
it("orgMemberBreakdown groups by member login", async () => {
  const db = await makeTestDb();
  await projectAttestation(db, att("ed25519:m1", "d1", "m", { mostly: 1 }, "gemA"));
  await projectAttestation(db, att("ed25519:m2", "d2", "m", { not: 1 }, "gemB"));
  await bind(db, "ed25519:m1", "u1"); await bind(db, "ed25519:m2", "u2");
  await replaceOrgMembers(db, "acme", [{ login: "u1", role: "admin" }, { login: "u2", role: "member" }]);
  const rows = await orgMemberBreakdown(db, "acme");
  expect(rows.map((r) => r.login).sort()).toEqual(["u1", "u2"]);
  expect(rows.find((r) => r.login === "u1")).toMatchObject({ attestations: 1, gems: 1, mostly: 1 });
});
```

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement** — append to `orgBenchmark.ts`:

```ts
export async function orgEffectiveness(db: AppDb, scope: string): Promise<EffectivenessRow[]> {
  const r = await db.execute<{ gemName: string; mostly: number; partially: number; notAchieved: number; producers: number }>(sql`
    select a.gem_name as "gemName",
           sum(mo.mostly)::int as mostly, sum(mo.partially)::int as partially, sum(mo.not_achieved)::int as "notAchieved",
           count(distinct a.producer_pubkey)::int as producers
    from model_outcomes mo
    join attestations a on a.id = mo.attestation_id and not a.quarantined
    where ${memberPubkeys(scope)}
    group by a.gem_name
  `);
  return r.rows.map((row) => ({ ...row, verifiedProducers: row.producers, ...effectivenessScore(row) }))
    .sort((a, b) => b.score - a.score || b.producers - a.producers || a.gemName.localeCompare(b.gemName));
}

export async function orgMemberBreakdown(db: AppDb, scope: string): Promise<{ login: string; attestations: number; gems: number; mostly: number; partially: number; notAchieved: number }[]> {
  const r = await db.execute<{ login: string; attestations: number; gems: number; mostly: number; partially: number; notAchieved: number }>(sql`
    select lower(ab.account_login) as login,
           count(distinct a.id)::int as attestations,
           count(distinct a.gem_name)::int as gems,
           coalesce(sum(mo.mostly),0)::int as mostly,
           coalesce(sum(mo.partially),0)::int as partially,
           coalesce(sum(mo.not_achieved),0)::int as "notAchieved"
    from attestations a
    join account_bindings ab on ab.pubkey = a.producer_pubkey
    join org_members om on lower(om.gh_login) = lower(ab.account_login) and lower(om.org_scope) = lower(${scope})
    left join model_outcomes mo on mo.attestation_id = a.id
    where not a.quarantined
    group by lower(ab.account_login)
    order by attestations desc, login
  `);
  return r.rows;
}
```
(`EffectivenessRow` includes `verifiedProducers`; set it `= producers` internally since all org rows are bound.)

- [ ] **Step 4: Run — PASS.**
- [ ] **Step 5: Commit** — `git commit -m "feat(aggregator): orgEffectiveness + orgMemberBreakdown"`

---

## Task 3: Route — admin-gated `GET /api/orgs/:scope/benchmark`

**Files:** Create `src/orgs/benchmark.ts`; Modify `src/serverAggregator.ts`; Test `src/aggregator/__tests__/orgBenchmarkRoute.test.ts` (or the usage-route test's neighbor).

**Interfaces:**
- Consumes: `resolveSession` (`@agentgem/aggregator`), `resolveOrgAccess` (`@agentgem/aggregator`), the three Task 1/2 aggregates. Mirror `src/usage/install.ts`'s `orgUsageHandler`/`memberGate`.
- Produces: `installOrgBenchmark(expressApp, deps)`; `GET/OPTIONS /api/orgs/:scope/benchmark` → `{ scope, modelBenchmark, effectiveness, members }` for admins.

- [ ] **Step 1: Failing test** — mirror the usage route test: build the express app (or call the handler with fake req/res), seed an admin vs a non-admin vs a non-member, assert 200 vs 403(`not-admin`) vs 403(`not-member`), and 401 when unauthenticated. Reuse `githubAppStore.test.ts`'s `upsertInstallation` + `replaceOrgMembers` to make `resolveOrgAccess` return `admin`.

```ts
it("returns the three cuts to an org admin, 403 to a member, 403 to a non-member", async () => {
  // seed: App installation for "acme" + org_members [{u1:admin},{u2:member}]; attestations+bindings for u1
  // admin (u1) → 200 { modelBenchmark, effectiveness, members }
  // member (u2) → 403 { reason: "not-admin" }
  // stranger    → 403 { reason: "not-member" }
});
```

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement `src/orgs/benchmark.ts`** — copy `orgUsageHandler`'s shape (cors → OPTIONS → whoami/401 → memberGate → admin check → json). Read `src/usage/install.ts:60-160` first and match its `Req`/`Res`/`cors`/`whoami` helpers exactly.

```ts
import { resolveSession, resolveOrgAccess } from "@agentgem/aggregator";
import { orgModelBenchmark, orgEffectiveness, orgMemberBreakdown } from "@agentgem/aggregator";
// ...types/cors/whoami mirrored from usage/install.ts...

export function installOrgBenchmark(expressApp: ExpressApp, deps: OrgBenchmarkDeps): void {
  const handler = orgBenchmarkHandler(deps);
  expressApp.get("/api/orgs/:scope/benchmark", handler);
  expressApp.options("/api/orgs/:scope/benchmark", handler);
}

function orgBenchmarkHandler(deps: OrgBenchmarkDeps) {
  return async (req: Req, res: Res) => {
    cors(deps, req, res); if (req.method === "OPTIONS") { res.status(204).end(); return; }
    const who = await resolveSession(deps.auth, req.headers as never);
    if (!who) { res.status(401).json({ error: "sign in" }); return; }
    const scope = String(req.params.scope || "").trim();
    if (!scope) { res.status(400).json({ error: "scope required" }); return; }
    const access = await resolveOrgAccess(deps.db, who, scope, deps.scopeTtlMs ?? defaultScopeTtlMs());
    if (access.status === "none") { res.status(403).json({ error: "not a member of this org", reason: "not-member" }); return; }
    if (access.status === "stale") { res.status(403).json({ error: "membership check expired — sign in again", reason: "stale" }); return; }
    if (access.role !== "admin") { res.status(403).json({ error: "admins only", reason: "not-admin" }); return; }
    const [modelBenchmark, effectiveness, members] = await Promise.all([
      orgModelBenchmark(deps.db, scope), orgEffectiveness(deps.db, scope), orgMemberBreakdown(deps.db, scope),
    ]);
    res.json({ scope, modelBenchmark, effectiveness, members });
  };
}
```
Match `OrgBenchmarkDeps` to `UsageDeps` (`db`, `auth`, `webOrigins`, optional `scopeTtlMs`); reuse `cors`/`defaultScopeTtlMs`/`Req`/`Res` — either import from `usage/install.ts` (export them) or copy the tiny helpers.

- [ ] **Step 4: Register** in `src/serverAggregator.ts` beside `installUsage` (~:158): `installOrgBenchmark(server.expressApp as never, { db: aggDb, auth, webOrigins });` (add the import).

- [ ] **Step 5: Run — PASS.** `pnpm build && pnpm vitest run src/aggregator/__tests__/orgBenchmarkRoute.test.ts`

- [ ] **Step 6: Commit** — `git commit -m "feat(orgs): admin-gated GET /api/orgs/:scope/benchmark"` **→ Open PR1 (Tasks 1-3).**

---

## Task 4 (PR2): Marketplace — Benchmark tab on the org hub

**Files:** Create `packages/marketplace/src/pages/Benchmark.tsx`; Modify `src/api.ts`, `src/Router.tsx`, `src/pages/OrgCatalog.tsx`, `src/pages/TeamUsage.tsx` (cross-link), `src/styles.css`; Test `packages/marketplace/src/pages/Benchmark.test.tsx`.

- [ ] **Step 1:** Read `packages/marketplace/src/pages/TeamUsage.tsx` (the `View` discriminated union + status branches) and `src/api.ts:169-186` (`getOrgUsage`'s `credentials:"include"` + 401/403-`reason` → typed status). Mirror both.

- [ ] **Step 2: `getOrgBenchmark`** in `src/api.ts` — copy `getOrgUsage`, swap the path to `/api/orgs/${scope}/benchmark` and the response type to `{ scope, modelBenchmark, effectiveness, members }`; map 401 → `signedout`, 403 `reason:"not-admin"` → `forbidden-admin`, `"not-member"` → `forbidden`, `"stale"` → `stale`.

- [ ] **Step 3: Failing jsdom test** `Benchmark.test.tsx` — mock `getOrgBenchmark` returning the three cuts → asserts a model row, a gem row, and a member row render; and a `forbidden-admin` status → renders the "admins only" gate. Mirror `TeamUsage` tests.

- [ ] **Step 4: Run — FAIL.** `pnpm --filter @agentgem/marketplace exec vitest run src/pages/Benchmark.test.tsx`

- [ ] **Step 5: Implement `Benchmark.tsx`** — `View` union (`loading|signedout|forbidden|forbidden-admin|stale|error|ok`), `useEffect` fetch, three sections (model benchmark table, effectiveness table, per-member table). Add a `/orgs/:scope/benchmark` route to `Router.tsx` (mirror the `org-usage` entry at :77-79). Add a cross-link from `OrgCatalog.tsx` (like `.ex-orgcat-usage-link`) and `TeamUsage`'s header. Every new `ex-benchmark-*` class gets a rule in `styles.css` (mirror `.ex-usage-card`/`.ex-usage-row`; reuse tokens); grep-confirm each `> 0`.

- [ ] **Step 6: Run — PASS.**

- [ ] **Step 7: Real-browser check** — run the marketplace against a local aggregator with a seeded admin session; open `/orgs/<scope>/benchmark`; confirm the three panels render styled and the non-admin gate shows. Screenshot for the PR.

- [ ] **Step 8: Commit** — `git commit -m "feat(marketplace): org benchmark tab on the /orgs/:scope hub"` **→ Open PR2.**

---

## Final verification (PR1)

- [ ] `pnpm build` clean; `pnpm vitest run packages/aggregator src/aggregator/__tests__/orgBenchmark*.test.ts`.
- [ ] Manual: seed an App-installed org with members + attestations, hit `/api/orgs/<scope>/benchmark` as admin (200, three cuts), member (403 not-admin), stranger (403 not-member), logged-out (401).

## NOT in scope (deferred)

- **Non-App orgs** (membership via `account_scopes` only, no `org_members` roster) — they get empty panels until a follow-up bridges `account_scopes` (uuid) → a producer login. Flag in the UI empty state.
- **Compare-to-global** (org vs network benchmark).
- **Governance controls** (org-wide enable/retention) — the rejected "control surface" purpose.
- **Console surface** — web-only.

## What already exists (reused)

`modelBenchmark`/`effectiveness` SQL + `effectivenessScore` (`aggregates.ts`), `resolveOrgAccess` + `memberGate` + `orgUsageHandler` pattern (`githubApp.ts`/`usage/install.ts`), `resolveSession` (`webAuth.ts`), `replaceOrgMembers`/`upsertInstallation` (test seeding), `TeamUsage.tsx` + `getOrgUsage` (marketplace mirror). The plan adds only: the org-filter predicate, three thin aggregates, one route, one page.

## Failure modes

| Codepath | Failure | Test? | Handled? | User sees |
|---|---|---|---|---|
| route | non-admin member | ✓ (T3) | ✓ 403 not-admin | "admins only" |
| route | stale membership | ✓ (T3) | ✓ 403 stale | re-auth prompt |
| aggregate | org with no roster / no bound members | ✓ (empty) | ✓ empty arrays | "no contributing members yet" |
| UI | fetch fails | ✓ (T4) | ✓ error state | error message, not blank |

## Parallelization

| Lane | Tasks | Modules | Depends on |
|---|---|---|---|
| A | T1, T2 | `packages/aggregator/` | — (T2 after T1: same file) |
| B | T3 | `src/orgs/`, `src/serverAggregator.ts` | A (imports the aggregates) |
| C | T4 (PR2) | `packages/marketplace/` | B (the route) |

**Order:** T1→T2 (same file, sequential) → T3 → PR1. Then T4 → PR2.
