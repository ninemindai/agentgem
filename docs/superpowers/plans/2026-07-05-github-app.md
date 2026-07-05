# AgentGem GitHub App Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Installable GitHub App giving AgentGem authoritative org membership (private members included) and members-only indexing of an org's private SKILL.md repos.

**Architecture:** New `src/githubApp/` module inside the existing API app (webhooks primary, daily reconcile backstop), new `app_installations` + `org_members` tables plus a nullable `org_scope` column on `curated_skills` in `@agentgem/aggregator`, and three member-gated raw-express endpoints (`/api/orgs/*`) cloning the `src/usage/install.ts` pattern. Spec: `docs/superpowers/specs/2026-07-05-github-app-design.md`.

**Tech Stack:** TypeScript ESM, express (via @agentback/rest), drizzle + pglite (tests), node:crypto (RS256 JWT, HMAC), vitest. **No new dependencies.**

## Global Constraints

- Work in worktree `/Users/rfeng/Projects/ninemind/agentgem-github-app`, branch `feat/github-app`. All paths below are relative to that root.
- First task must run `pnpm install --frozen-lockfile` (worktree has no `node_modules` yet).
- Root tests are COMPILED: `pnpm test` = `tsc -b && vitest run`; vitest collects `dist/**/__tests__/**/*.test.js`. Focused run: `pnpm exec tsc -b && pnpm exec vitest run dist/<dir>/__tests__/<file>.test.js`. Package-internal test dirs are NOT collected — all new tests live under root `src/**/__tests__/`.
- If builds go phantom after file moves: `rm -rf dist tsconfig.tsbuildinfo` then rebuild (deleting dist but keeping tsbuildinfo makes tsc skip emit).
- Known full-suite flake: `observeScan`/`scorecard`/`observe.controller` tests can time out under full-suite concurrency (they scan the real `~/.claude`). Not caused by this work — verify in isolation before blaming a change.
- Style: match existing files — 2-space indent, double quotes, `// Copyright (c) 2026 NineMind, Inc.` + `// SPDX-License-Identifier: MIT` header on every new file, `.js` extension on relative ESM imports.
- Commits: author `Raymond Feng <raymond@ninemind.ai>` (pass `-c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai"` if the worktree config differs), message ends with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Tests never touch the network: DB via `makeTestDb()` (pglite), GitHub via fake `fetch`/`Http`.
- Env names (fixed by spec): `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_WEBHOOK_SECRET`. All three unset/partial → subsystem dormant (webhook 503s, no reconcile loop, gates unchanged).
- Logins and org scopes from the App path are **lowercased at write time**; App-path reads compare lowercased. Captured-scope (`account_scopes`) behavior is untouched.

---

### Task 1: Schema — `app_installations`, `org_members`, `curated_skills.org_scope`

**Files:**
- Modify: `packages/aggregator/src/schema.ts`
- Modify: `src/aggregator/__tests__/schema.test.ts`

**Interfaces:**
- Consumes: existing drizzle helpers already imported in schema.ts (`pgTable`, `text`, `boolean`, `bigint`, `timestamp`, `primaryKey`, `sql`).
- Produces: exported drizzle tables `appInstallations`, `orgMembers`; `curatedSkills` gains `orgScope` column. Later tasks import these from `@agentgem/aggregator` (via the `schema` barrel already re-exported).

- [ ] **Step 1: Bootstrap the worktree**

```bash
cd /Users/rfeng/Projects/ninemind/agentgem-github-app
pnpm install --frozen-lockfile
pnpm test 2>&1 | tail -5
```
Expected: install succeeds; baseline suite green (note the passing count; the observeScan flake note in Global Constraints applies).

- [ ] **Step 2: Write the failing test** — in `src/aggregator/__tests__/schema.test.ts`, update the expected table list to include the two new tables (alphabetical position matters):

```ts
    expect((t.rows as { table_name: string }[]).map((x) => x.table_name)).toEqual(["account_bindings", "account_scopes", "accounts", "api_keys", "app_installations", "attestations", "catalog_gems", "curated_skills", "gem_adoptions", "handoff_codes", "ingredients", "model_outcomes", "org_members", "org_settings", "producers", "reviews", "share_cards", "stars", "usage_day_models", "usage_days", "usage_edges", "web_sessions"]);
```

- [ ] **Step 3: Run test to verify it fails**

```bash
pnpm exec tsc -b && pnpm exec vitest run dist/aggregator/__tests__/schema.test.js
```
Expected: FAIL — received list lacks `app_installations` / `org_members`.

- [ ] **Step 4: Add drizzle table defs** — in `packages/aggregator/src/schema.ts`, after the `orgSettings` def:

```ts
// GitHub App installations (one row per installed org) + the member lists they sync. Written by
// the src/githubApp webhook/reconcile path; read by resolveOrgAccess as the authoritative
// membership gate. org_scope and gh_login are lowercased at write time (case-insensitive gate).
export const appInstallations = pgTable("app_installations", {
  installationId: bigint("installation_id", { mode: "number" }).primaryKey(),
  orgScope: text("org_scope").notNull(),
  repoSelection: text("repo_selection").notNull().default("selected"),
  suspended: boolean("suspended").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const orgMembers = pgTable("org_members", {
  orgScope: text("org_scope").notNull(),
  ghLogin: text("gh_login").notNull(),
  role: text("role").notNull().default("member"),
  syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.orgScope, t.ghLogin] })]);
```

Add to the `curatedSkills` def, after the `description` line (line ~225):

```ts
  // Non-null = a private org source row (GitHub App), visible only to that org's members.
  orgScope: text("org_scope"),
```

Add both tables to the `schema` barrel object:

```ts
export const schema = { producers, attestations, ingredients, usageEdges, modelOutcomes, accountBindings, shareCards, apiKeys, accounts, webSessions, handoffCodes, stars, reviews, gemAdoptions, accountScopes, usageDays, usageDayModels, orgSettings, catalogGems, curatedSkills, appInstallations, orgMembers };
```

In `ensureSchema`, after the `curated_skills` statements (line ~275):

```ts
  await db.execute(sql`alter table curated_skills add column if not exists org_scope text`);
  await db.execute(sql`create index if not exists curated_skills_org_idx on curated_skills (org_scope) where org_scope is not null`);
  await db.execute(sql`create table if not exists app_installations (installation_id bigint primary key, org_scope text not null, repo_selection text not null default 'selected', suspended boolean not null default false, created_at timestamptz not null default now(), updated_at timestamptz not null default now())`);
  await db.execute(sql`create index if not exists app_installations_scope_idx on app_installations (org_scope)`);
  await db.execute(sql`create table if not exists org_members (org_scope text not null, gh_login text not null, role text not null default 'member', synced_at timestamptz not null default now(), primary key (org_scope, gh_login))`);
```

- [ ] **Step 5: Run test to verify it passes**

```bash
pnpm exec tsc -b && pnpm exec vitest run dist/aggregator/__tests__/schema.test.js
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/aggregator/src/schema.ts src/aggregator/__tests__/schema.test.ts
git commit -m "feat(aggregator): app_installations + org_members tables, curated_skills.org_scope

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Aggregator store — installations, members, `appOrgRole`, `resolveOrgAccess`

**Files:**
- Create: `packages/aggregator/src/githubApp.ts`
- Modify: `packages/aggregator/src/index.ts` (barrel — add `export * from "./githubApp.js";`)
- Test: `src/aggregator/__tests__/githubAppStore.test.ts`

**Interfaces:**
- Consumes: `appInstallations`, `orgMembers` tables (Task 1); `accountScopeStatus`, `accountScopeRole` from `./webAuth.js`; `deleteOrgSkills` from `./curatedSkills.js` (Task 3 — until Task 3 lands, implement `deleteInstallation` without the skills cascade and leave a `// cascade added in curatedSkills task` seam; Task 3 Step 6 completes it).
- Produces (exact signatures later tasks use):
  ```ts
  export interface AppInstallation { installationId: number; orgScope: string; repoSelection: "all" | "selected"; suspended: boolean }
  export async function upsertInstallation(db: AppDb, inst: AppInstallation): Promise<void>
  export async function setInstallationSuspended(db: AppDb, installationId: number, suspended: boolean): Promise<void>
  export async function deleteInstallation(db: AppDb, installationId: number): Promise<void>
  export async function installationForScope(db: AppDb, orgScope: string): Promise<AppInstallation | null>
  export async function listInstallations(db: AppDb): Promise<AppInstallation[]>
  export async function replaceOrgMembers(db: AppDb, orgScope: string, members: { login: string; role: "admin" | "member" }[]): Promise<void>
  export async function upsertOrgMember(db: AppDb, orgScope: string, login: string, role: "admin" | "member"): Promise<void>
  export async function deleteOrgMember(db: AppDb, orgScope: string, login: string): Promise<void>
  export async function appOrgRole(db: AppDb, login: string, orgScope: string): Promise<"admin" | "member" | null>
  export type OrgAccess = { status: "ok" | "stale" | "none"; role: "self" | "admin" | "member" | null; via: "self" | "app" | "scopes" | null };
  export async function resolveOrgAccess(db: AppDb, who: { accountId: string; login: string }, scope: string, scopeTtlMs: number, now?: number): Promise<OrgAccess>
  ```

- [ ] **Step 1: Write the failing tests** — create `src/aggregator/__tests__/githubAppStore.test.ts`:

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import {
  makeTestDb, upsertAccount, setAccountScopes,
  upsertInstallation, setInstallationSuspended, deleteInstallation, installationForScope, listInstallations,
  replaceOrgMembers, upsertOrgMember, deleteOrgMember, appOrgRole, resolveOrgAccess,
} from "@agentgem/aggregator";

const inst = (over: Partial<{ installationId: number; orgScope: string; repoSelection: "all" | "selected"; suspended: boolean }> = {}) =>
  ({ installationId: 101, orgScope: "acme", repoSelection: "selected" as const, suspended: false, ...over });

describe("app installations store", () => {
  it("upserts, lists, suspends, and re-upserts idempotently", async () => {
    const db = await makeTestDb();
    await upsertInstallation(db, inst());
    await upsertInstallation(db, inst({ repoSelection: "all" })); // update, not duplicate
    expect(await listInstallations(db)).toEqual([inst({ repoSelection: "all" })]);
    await setInstallationSuspended(db, 101, true);
    expect((await installationForScope(db, "acme"))?.suspended).toBe(true);
    expect(await installationForScope(db, "ACME")).not.toBeNull(); // scope compare is case-insensitive
    expect(await installationForScope(db, "other")).toBeNull();
  });

  it("deleteInstallation removes the row and its members", async () => {
    const db = await makeTestDb();
    await upsertInstallation(db, inst());
    await replaceOrgMembers(db, "acme", [{ login: "alice", role: "admin" }]);
    await deleteInstallation(db, 101);
    expect(await listInstallations(db)).toEqual([]);
    expect(await appOrgRole(db, "alice", "acme")).toBeNull();
  });
});

describe("org members store", () => {
  it("replaceOrgMembers replaces atomically; single-row deltas work; lookups lowercase", async () => {
    const db = await makeTestDb();
    await upsertInstallation(db, inst());
    await replaceOrgMembers(db, "acme", [{ login: "Alice", role: "admin" }, { login: "bob", role: "member" }]);
    expect(await appOrgRole(db, "ALICE", "Acme")).toBe("admin");
    await replaceOrgMembers(db, "acme", [{ login: "bob", role: "member" }]); // alice gone
    expect(await appOrgRole(db, "alice", "acme")).toBeNull();
    await upsertOrgMember(db, "acme", "Carol", "member");
    expect(await appOrgRole(db, "carol", "acme")).toBe("member");
    await deleteOrgMember(db, "acme", "CAROL");
    expect(await appOrgRole(db, "carol", "acme")).toBeNull();
  });

  it("appOrgRole requires an active (non-suspended) installation", async () => {
    const db = await makeTestDb();
    await replaceOrgMembers(db, "acme", [{ login: "alice", role: "member" }]); // no installation row at all
    expect(await appOrgRole(db, "alice", "acme")).toBeNull();
    await upsertInstallation(db, inst());
    expect(await appOrgRole(db, "alice", "acme")).toBe("member");
    await setInstallationSuspended(db, 101, true);
    expect(await appOrgRole(db, "alice", "acme")).toBeNull();
  });
});

describe("resolveOrgAccess", () => {
  it("self scope is always ok", async () => {
    const db = await makeTestDb();
    const a = await upsertAccount(db, { provider: "github", accountId: "1", login: "alice" });
    expect(await resolveOrgAccess(db, { accountId: a.id, login: "alice" }, "Alice", 1000)).toEqual({ status: "ok", role: "self", via: "self" });
  });

  it("app membership passes without any captured scope (and beats stale scopes)", async () => {
    const db = await makeTestDb();
    const a = await upsertAccount(db, { provider: "github", accountId: "1", login: "alice" });
    await upsertInstallation(db, inst());
    await replaceOrgMembers(db, "acme", [{ login: "alice", role: "admin" }]);
    expect(await resolveOrgAccess(db, { accountId: a.id, login: "alice" }, "acme", 1000)).toEqual({ status: "ok", role: "admin", via: "app" });
  });

  it("falls back to captured scopes with freshness; none when neither source matches", async () => {
    const db = await makeTestDb();
    const a = await upsertAccount(db, { provider: "github", accountId: "1", login: "alice" });
    await setAccountScopes(db, a.id, ["alice", { scope: "acme", role: "member" }]);
    expect(await resolveOrgAccess(db, { accountId: a.id, login: "alice" }, "acme", 60_000)).toEqual({ status: "ok", role: "member", via: "scopes" });
    expect((await resolveOrgAccess(db, { accountId: a.id, login: "alice" }, "acme", 60_000, Date.now() + 120_000)).status).toBe("stale");
    expect((await resolveOrgAccess(db, { accountId: a.id, login: "alice" }, "globex", 60_000)).status).toBe("none");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
pnpm exec tsc -b 2>&1 | head -5
```
Expected: FAIL — compile errors, `upsertInstallation` etc. not exported from `@agentgem/aggregator`.

- [ ] **Step 3: Implement** — create `packages/aggregator/src/githubApp.ts`:

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/githubApp.ts
//
// Store + gate for the GitHub App integration: installations (one row per installed org), the
// member lists the webhook/reconcile path syncs from GitHub, and resolveOrgAccess — the combined
// org-access check (self → App membership → captured account_scopes). org_scope/gh_login are
// lowercased at write time so the gate is case-insensitive without lower() on every read.
import { and, eq, sql } from "drizzle-orm";
import { appInstallations, orgMembers, type AppDb } from "./schema.js";
import { accountScopeStatus, accountScopeRole } from "./webAuth.js";
import { deleteOrgSkills } from "./curatedSkills.js";

export interface AppInstallation { installationId: number; orgScope: string; repoSelection: "all" | "selected"; suspended: boolean }

export async function upsertInstallation(db: AppDb, inst: AppInstallation): Promise<void> {
  const orgScope = inst.orgScope.toLowerCase();
  await db.insert(appInstallations)
    .values({ installationId: inst.installationId, orgScope, repoSelection: inst.repoSelection, suspended: inst.suspended })
    .onConflictDoUpdate({
      target: appInstallations.installationId,
      set: { orgScope, repoSelection: inst.repoSelection, suspended: inst.suspended, updatedAt: sql`now()` },
    });
}

export async function setInstallationSuspended(db: AppDb, installationId: number, suspended: boolean): Promise<void> {
  await db.update(appInstallations).set({ suspended, updatedAt: sql`now()` }).where(eq(appInstallations.installationId, installationId));
}

/** Uninstall = forget: the installation row, its synced members, and its private skill rows. */
export async function deleteInstallation(db: AppDb, installationId: number): Promise<void> {
  const rows = await db.select({ orgScope: appInstallations.orgScope }).from(appInstallations)
    .where(eq(appInstallations.installationId, installationId)).limit(1);
  const orgScope = rows[0]?.orgScope;
  await db.delete(appInstallations).where(eq(appInstallations.installationId, installationId));
  if (orgScope) {
    await db.delete(orgMembers).where(eq(orgMembers.orgScope, orgScope));
    await deleteOrgSkills(db, orgScope);
  }
}

export async function installationForScope(db: AppDb, orgScope: string): Promise<AppInstallation | null> {
  const rows = await db.select().from(appInstallations).where(eq(appInstallations.orgScope, orgScope.toLowerCase())).limit(1);
  const r = rows[0];
  return r ? { installationId: r.installationId, orgScope: r.orgScope, repoSelection: r.repoSelection as "all" | "selected", suspended: r.suspended } : null;
}

export async function listInstallations(db: AppDb): Promise<AppInstallation[]> {
  const rows = await db.select().from(appInstallations);
  return rows.map((r) => ({ installationId: r.installationId, orgScope: r.orgScope, repoSelection: r.repoSelection as "all" | "selected", suspended: r.suspended }));
}

export async function replaceOrgMembers(db: AppDb, orgScope: string, members: { login: string; role: "admin" | "member" }[]): Promise<void> {
  const scope = orgScope.toLowerCase();
  await db.delete(orgMembers).where(eq(orgMembers.orgScope, scope));
  if (members.length > 0) {
    await db.insert(orgMembers).values(members.map((m) => ({ orgScope: scope, ghLogin: m.login.toLowerCase(), role: m.role })));
  }
}

export async function upsertOrgMember(db: AppDb, orgScope: string, login: string, role: "admin" | "member"): Promise<void> {
  await db.insert(orgMembers)
    .values({ orgScope: orgScope.toLowerCase(), ghLogin: login.toLowerCase(), role })
    .onConflictDoUpdate({ target: [orgMembers.orgScope, orgMembers.ghLogin], set: { role, syncedAt: sql`now()` } });
}

export async function deleteOrgMember(db: AppDb, orgScope: string, login: string): Promise<void> {
  await db.delete(orgMembers).where(and(eq(orgMembers.orgScope, orgScope.toLowerCase()), eq(orgMembers.ghLogin, login.toLowerCase())));
}

/** App-synced role for login in orgScope — null unless a NON-suspended installation exists. */
export async function appOrgRole(db: AppDb, login: string, orgScope: string): Promise<"admin" | "member" | null> {
  const scope = orgScope.toLowerCase();
  const inst = await installationForScope(db, scope);
  if (!inst || inst.suspended) return null;
  const rows = await db.select({ role: orgMembers.role }).from(orgMembers)
    .where(and(eq(orgMembers.orgScope, scope), eq(orgMembers.ghLogin, login.toLowerCase()))).limit(1);
  return rows.length > 0 ? (rows[0].role === "admin" ? "admin" : "member") : null;
}

export type OrgAccess = { status: "ok" | "stale" | "none"; role: "self" | "admin" | "member" | null; via: "self" | "app" | "scopes" | null };

/**
 * Combined org-access check, in precedence order:
 *   1. self — scope IS the caller's login (their identity; never stale).
 *   2. App membership — webhook-synced, so always fresh; includes private members.
 *   3. Captured account_scopes — today's sign-in capture, with the freshness TTL.
 * Orgs without the App get exactly today's behavior (path 3).
 */
export async function resolveOrgAccess(
  db: AppDb, who: { accountId: string; login: string }, scope: string, scopeTtlMs: number, now: number = Date.now(),
): Promise<OrgAccess> {
  if (who.login.toLowerCase() === scope.toLowerCase()) return { status: "ok", role: "self", via: "self" };
  const appRole = await appOrgRole(db, who.login, scope);
  if (appRole) return { status: "ok", role: appRole, via: "app" };
  const status = await accountScopeStatus(db, who.accountId, scope, scopeTtlMs, now);
  if (status === "none") return { status: "none", role: null, via: null };
  const role = ((await accountScopeRole(db, who.accountId, scope)) ?? "member") as "self" | "admin" | "member";
  return { status, role, via: "scopes" };
}
```

**Note:** the `deleteOrgSkills` import lands in Task 3. To keep this task compiling standalone, add a temporary local stub at the top of `githubApp.ts` — `async function deleteOrgSkills(_db: AppDb, _scope: string): Promise<void> {}` — instead of the import, and swap it for the real import in Task 3 Step 6.

Add to `packages/aggregator/src/index.ts` barrel: `export * from "./githubApp.js";`

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm exec tsc -b && pnpm exec vitest run dist/aggregator/__tests__/githubAppStore.test.js
```
Expected: PASS (all describe blocks).

- [ ] **Step 5: Commit**

```bash
git add packages/aggregator/src/githubApp.ts packages/aggregator/src/index.ts src/aggregator/__tests__/githubAppStore.test.ts
git commit -m "feat(aggregator): GitHub App installations/members store + resolveOrgAccess gate

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Org-scoped curated skills + public-query isolation

**Files:**
- Modify: `packages/aggregator/src/curatedSkills.ts`
- Modify: `packages/aggregator/src/githubApp.ts` (swap the Task 2 stub for the real `deleteOrgSkills` import)
- Test: `src/aggregator/__tests__/orgSkills.test.ts`

**Interfaces:**
- Consumes: `curated_skills.org_scope` column (Task 1).
- Produces:
  ```ts
  export interface OrgSkillRow { sourceId: string; path: string; division: string; name: string; repo: string; description: string | null }
  export async function replaceOrgRepoSkills(db: AppDb, orgScope: string, repo: string, rows: OrgSkillRow[]): Promise<number>
  export async function deleteOrgRepoSkills(db: AppDb, orgScope: string, repo: string): Promise<void>
  export async function deleteOrgSkills(db: AppDb, orgScope: string): Promise<void>
  export async function listOrgSkills(db: AppDb, orgScope: string): Promise<OrgSkillRow[]>
  export async function orgSkillExists(db: AppDb, orgScope: string, sourceId: string, path: string): Promise<boolean>
  ```
- Modifies behavior: `popularSkills`, `popularSkillGroups`, `skillNamesByTargetId` all gain `org_scope is null` filters — private rows must never leak into public reads.

- [ ] **Step 1: Write the failing tests** — create `src/aggregator/__tests__/orgSkills.test.ts`:

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import {
  makeTestDb, upsertCuratedSkills, popularSkills, popularSkillGroups, skillNamesByTargetId,
  replaceOrgRepoSkills, deleteOrgRepoSkills, deleteOrgSkills, listOrgSkills, orgSkillExists,
  type CuratedSkillRow, type OrgSkillRow,
} from "@agentgem/aggregator";

const pub = (name: string): CuratedSkillRow => ({
  sourceId: "public-src", source: "Public", division: "eng", name, path: `eng/${name}/SKILL.md`,
  repo: "octo/public", homepage: null, stars: 5, installs: null, description: "public skill",
});
const priv = (name: string, repo = "acme/skills"): OrgSkillRow => ({
  sourceId: `org:${repo}`, path: `eng/${name}/SKILL.md`, division: "eng", name, repo, description: "internal",
});

describe("org-scoped curated skills", () => {
  it("replace/list/delete round-trips and scopes by (org, repo)", async () => {
    const db = await makeTestDb();
    await replaceOrgRepoSkills(db, "acme", "acme/skills", [priv("deploy"), priv("oncall")]);
    await replaceOrgRepoSkills(db, "acme", "acme/more", [priv("audit", "acme/more")]);
    expect((await listOrgSkills(db, "acme")).map((s) => s.name).sort()).toEqual(["audit", "deploy", "oncall"]);
    // replace drops rows missing from the new list (skill deleted upstream)
    await replaceOrgRepoSkills(db, "acme", "acme/skills", [priv("deploy")]);
    expect((await listOrgSkills(db, "acme")).map((s) => s.name).sort()).toEqual(["audit", "deploy"]);
    await deleteOrgRepoSkills(db, "acme", "acme/more");
    expect((await listOrgSkills(db, "acme")).map((s) => s.name)).toEqual(["deploy"]);
    await deleteOrgSkills(db, "acme");
    expect(await listOrgSkills(db, "acme")).toEqual([]);
  });

  it("orgSkillExists enforces the source∈scope boundary", async () => {
    const db = await makeTestDb();
    await replaceOrgRepoSkills(db, "acme", "acme/skills", [priv("deploy")]);
    expect(await orgSkillExists(db, "acme", "org:acme/skills", "eng/deploy/SKILL.md")).toBe(true);
    expect(await orgSkillExists(db, "globex", "org:acme/skills", "eng/deploy/SKILL.md")).toBe(false);
    expect(await orgSkillExists(db, "acme", "org:acme/skills", "eng/other/SKILL.md")).toBe(false);
  });

  it("private rows NEVER surface in public reads", async () => {
    const db = await makeTestDb();
    await upsertCuratedSkills(db, [pub("brainstorm")]);
    await replaceOrgRepoSkills(db, "acme", "acme/skills", [priv("deploy")]);
    expect((await popularSkills(db)).map((s) => s.name)).toEqual(["brainstorm"]);
    expect((await popularSkillGroups(db)).map((g) => g.sourceId)).toEqual(["public-src"]);
    const names = await skillNamesByTargetId(db, ["public-src/eng/brainstorm/SKILL.md", "org:acme/skills/eng/deploy/SKILL.md"]);
    expect(Object.keys(names)).toEqual(["public-src/eng/brainstorm/SKILL.md"]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
pnpm exec tsc -b 2>&1 | head -5
```
Expected: FAIL — `replaceOrgRepoSkills` etc. not exported.

- [ ] **Step 3: Implement** — append to `packages/aggregator/src/curatedSkills.ts`:

```ts
// ── org-scoped (private) skills — GitHub App sources ────────────────────────────────────────
// Same table, org_scope NOT NULL, source_id "org:<owner>/<repo>". Public reads above filter
// org_scope IS NULL; these rows are served only through the member-gated /api/orgs endpoints.

export interface OrgSkillRow { sourceId: string; path: string; division: string; name: string; repo: string; description: string | null }

/** Replace the indexed skill set for one (org, repo): delete-then-insert so upstream deletions
 *  disappear. Metadata only — bodies are never stored. Returns the new row count. */
export async function replaceOrgRepoSkills(db: AppDb, orgScope: string, repo: string, rows: OrgSkillRow[]): Promise<number> {
  const scope = orgScope.toLowerCase();
  await db.execute(sql`delete from curated_skills where org_scope = ${scope} and repo = ${repo}`);
  for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
    const chunk = rows.slice(i, i + UPSERT_CHUNK);
    if (chunk.length === 0) continue;
    const values = sql.join(
      chunk.map((r) => sql`(${r.sourceId}, ${r.path}, ${r.division}, ${r.name}, ${r.repo}, ${r.repo}, ${null}, ${0}, ${null}, ${r.description}, ${scope})`),
      sql`, `,
    );
    await db.execute(sql`
      insert into curated_skills (source_id, path, division, name, repo, source_label, homepage, stars, installs, description, org_scope)
      values ${values}
      on conflict (source_id, path) do update set
        division = excluded.division, name = excluded.name, repo = excluded.repo,
        source_label = excluded.source_label, description = excluded.description,
        org_scope = excluded.org_scope, indexed_at = now()
    `);
  }
  return rows.length;
}

export async function deleteOrgRepoSkills(db: AppDb, orgScope: string, repo: string): Promise<void> {
  await db.execute(sql`delete from curated_skills where org_scope = ${orgScope.toLowerCase()} and repo = ${repo}`);
}

export async function deleteOrgSkills(db: AppDb, orgScope: string): Promise<void> {
  await db.execute(sql`delete from curated_skills where org_scope = ${orgScope.toLowerCase()}`);
}

export async function listOrgSkills(db: AppDb, orgScope: string): Promise<OrgSkillRow[]> {
  const r = await db.execute<{ sourceId: string; path: string; division: string; name: string; repo: string; description: string | null }>(sql`
    select source_id as "sourceId", path, division, name, repo, description
    from curated_skills where org_scope = ${orgScope.toLowerCase()}
    order by repo, division, name
  `);
  return r.rows as OrgSkillRow[];
}

/** True iff (sourceId, path) is an indexed private skill of THIS org — the body-proxy boundary. */
export async function orgSkillExists(db: AppDb, orgScope: string, sourceId: string, path: string): Promise<boolean> {
  const r = await db.execute<{ one: number }>(sql`
    select 1 as one from curated_skills
    where org_scope = ${orgScope.toLowerCase()} and source_id = ${sourceId} and path = ${path} limit 1
  `);
  return r.rows.length > 0;
}
```

Then add the public-read filters (three edits in the same file):
- `skillNamesByTargetId`: `where (source_id || '/' || path) in (${list})` → `where org_scope is null and (source_id || '/' || path) in (${list})`
- `popularSkills`: add `where org_scope is null` before `order by`.
- `popularSkillGroups`: add `where org_scope is null` before `order by`.

Finally, in `packages/aggregator/src/githubApp.ts`, replace the Task 2 stub with the real import: `import { deleteOrgSkills } from "./curatedSkills.js";`

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm exec tsc -b && pnpm exec vitest run dist/aggregator/__tests__/orgSkills.test.js dist/aggregator/__tests__/githubAppStore.test.js
```
Expected: PASS — including the Task 2 `deleteInstallation` cascade test now exercising the real `deleteOrgSkills`.

- [ ] **Step 5: Commit**

```bash
git add packages/aggregator/src/curatedSkills.ts packages/aggregator/src/githubApp.ts src/aggregator/__tests__/orgSkills.test.ts
git commit -m "feat(aggregator): org-scoped curated skills, public reads filter org_scope

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Rewire the usage/settings/publish gates onto App membership

**Files:**
- Modify: `src/usage/install.ts` (orgUsageHandler ~lines 113–148, orgSettingsHandler ~lines 73–111)
- Modify: `src/registry/uploadPublish.ts` (~line 50, the `accountOwnsScope` check)
- Test: `src/__tests__/usageInstall.test.ts` (extend)
- Test: `src/registry/__tests__/uploadPublish.test.ts` (extend)

**Interfaces:**
- Consumes: `resolveOrgAccess`, `appOrgRole` (Task 2); existing `upsertInstallation`, `upsertOrgMember` for test setup.
- Produces: no new exports — behavior change only. Contract: an App-synced member passes the usage/settings/publish gates with **no** `account_scopes` row and regardless of capture freshness; App-synced `admin` passes the settings PUT gate; orgs without the App behave exactly as before.

- [ ] **Step 1: Write the failing tests** — append to `src/__tests__/usageInstall.test.ts` (reuse the file's existing `mockRes`/`req`/`deps`/`member` helpers; import `upsertInstallation`, `replaceOrgMembers` from `@agentgem/aggregator`, and add `createSession`/`generateSessionToken`-based session setup for an account with NO scopes):

```ts
async function appMember(db: any, login: string, org: string, role: "admin" | "member") {
  const a = await upsertAccount(db, { provider: "github", accountId: login, login });
  // NO setAccountScopes — this member exists only via the App sync.
  const { token } = generateSessionToken();
  await createSession(db, a.id, token, 60_000);
  await upsertInstallation(db, { installationId: 7, orgScope: org, repoSelection: "selected", suspended: false });
  await upsertOrgMember(db, org, login, role);
  return { a, token };
}

describe("orgUsageHandler with GitHub App membership", () => {
  it("App-synced member passes with no captured scopes", async () => {
    const db = await makeTestDb();
    const { token } = await appMember(db, "carol", "acme", "member");
    const res = mockRes();
    await orgUsageHandler(deps(db))(req({ query: { scope: "acme" }, headers: { authorization: `Bearer ${token}` } }) as any, res);
    expect(res._status).toBe(200);
  });
  it("suspended installation does NOT grant access", async () => {
    const db = await makeTestDb();
    const { token } = await appMember(db, "carol", "acme", "member");
    await setInstallationSuspended(db, 7, true);
    const res = mockRes();
    await orgUsageHandler(deps(db))(req({ query: { scope: "acme" }, headers: { authorization: `Bearer ${token}` } }) as any, res);
    expect(res._status).toBe(403);
  });
});

describe("orgSettingsHandler with GitHub App membership", () => {
  it("App-synced admin can PUT settings; App-synced member cannot", async () => {
    const db = await makeTestDb();
    const admin = await appMember(db, "dana", "acme", "admin");
    let res = mockRes();
    await orgSettingsHandler(deps(db))(req({ method: "PUT", query: { scope: "acme" }, body: { retentionDays: 30 }, headers: { authorization: `Bearer ${admin.token}` } }) as any, res);
    expect(res._status).toBe(200);
    const m = await appMember(db, "erin", "acme", "member");
    res = mockRes();
    await orgSettingsHandler(deps(db))(req({ method: "PUT", query: { scope: "acme" }, body: { retentionDays: 30 }, headers: { authorization: `Bearer ${m.token}` } }) as any, res);
    expect(res._status).toBe(403);
  });
});
```
(Adjust imports at the top of the test file: add `upsertInstallation, upsertOrgMember, setInstallationSuspended` to the existing `@agentgem/aggregator` import.)

Also append to `src/registry/__tests__/uploadPublish.test.ts` (reuse its existing `mkReq`/`deps`/session helpers — read the file first):

```ts
  it("App-synced org member may publish to the org scope with no captured scopes", async () => {
    const db = await makeTestDb();
    const a = await upsertAccount(db, { provider: "github", accountId: "carol", login: "carol" });
    const { token } = generateSessionToken();
    await createSession(db, a.id, token, 60_000);
    // NO setAccountScopes — membership arrives only via the App sync.
    await upsertInstallation(db, { installationId: 7, orgScope: "acme", repoSelection: "selected", suspended: false });
    await upsertOrgMember(db, "acme", "carol", "member");
    const res = mockRes();
    await uploadPublishHandler(deps(db, publisher))(mkReq({ headers: { cookie: `${SESSION_COOKIE}=${token}`, origin: "https://app.agentgem.ai" }, body: { scope: "acme", version: "1.0.0", bytesBase64: gemBase64() } }) as any, res as any);
    expect(res._status).toBe(200);
  });
```
(Match the file's actual helper names/shapes — e.g. how it builds `publisher` and `mockRes` — when transcribing.)

- [ ] **Step 2: Run to verify failure**

```bash
pnpm exec tsc -b && pnpm exec vitest run dist/__tests__/usageInstall.test.js dist/registry/__tests__/uploadPublish.test.js
```
Expected: the new tests FAIL (403 where 200 expected) — App membership isn't consulted yet. All pre-existing tests still PASS.

- [ ] **Step 3: Rewire the handlers** — in `src/usage/install.ts`:

Replace the import line's `accountScopeStatus, … accountScopeRole,` usage with `resolveOrgAccess` (keep other imports):

```ts
import {
  resolveSession, resolveOrgAccess, normalizeUsageReport, normalizeUsageModels, recordUsageDays, recordUsageModels,
  buildOrgUsage, getOrgSettings, putOrgSettings, normalizeRetentionDays, applyRetentionForScopes,
  RANGE_DAYS, type OrgUsageRange,
} from "@agentgem/aggregator";
```

In `orgSettingsHandler`, replace the status/role block (the `accountScopeStatus` call through the `const role =` line) with:

```ts
    const access = await resolveOrgAccess(deps.db, who, scope, deps.scopeTtlMs ?? defaultScopeTtlMs());
    if (access.status === "none") { res.status(403).json({ error: "not a member of this org" }); return; }
    if (access.status === "stale") { res.status(403).json({ error: "membership check expired — sign in again to refresh", reason: "stale" }); return; }
    const role = access.role ?? "member";
```

In `orgUsageHandler`, replace the body of the `if (scope !== who.login) { … }` block with:

```ts
      const access = await resolveOrgAccess(deps.db, who, scope, deps.scopeTtlMs ?? defaultScopeTtlMs());
      if (access.status === "none") { res.status(403).json({ error: "not a member of this org" }); return; }
      if (access.status === "stale") { res.status(403).json({ error: "membership check expired — sign in again to refresh", reason: "stale" }); return; }
      const settings = await getOrgSettings(deps.db, scope);
      if (!settings.dashboardEnabled && access.role !== "admin") { res.status(403).json({ error: "dashboard disabled by an org admin", reason: "disabled" }); return; }
```

Update the file-top comment block to mention the App path (one line: `//   Gates consult resolveOrgAccess: GitHub-App-synced membership (fresh by construction) OR captured account_scopes (TTL'd).`).

Then in `src/registry/uploadPublish.ts`: add `appOrgRole` to the `@agentgem/aggregator` import and widen the ownership check (~line 50) — publish keeps its no-TTL semantics, so this is an OR, not a resolveOrgAccess swap:

```ts
    // #4b: enforce account-scope ownership — a captured scope (login + GitHub orgs at sign-in)
    // OR live GitHub-App-synced membership (private members, no re-sign-in needed).
    if (!(await accountOwnsScope(deps.db, who.accountId, scope)) && !(await appOrgRole(deps.db, who.login, scope))) {
      res.status(403).json({ error: `you don't own the scope @${scope}` }); return;
    }
```
(`who.login` must be in scope at that point — the handler already resolves the session; if it only kept `accountId`, extend the destructuring to include `login`.)

- [ ] **Step 4: Run the full usage + publish test files**

```bash
pnpm exec tsc -b && pnpm exec vitest run dist/__tests__/usageInstall.test.js dist/registry/__tests__/uploadPublish.test.js
```
Expected: PASS — new App tests AND every pre-existing captured-scope test (that's the no-regression proof).

- [ ] **Step 5: Commit**

```bash
git add src/usage/install.ts src/__tests__/usageInstall.test.ts src/registry/uploadPublish.ts src/registry/__tests__/uploadPublish.test.ts
git commit -m "feat(gates): usage, settings, and publish gates accept GitHub-App-synced membership

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: GitHub App client — JWT, installation tokens, list APIs

**Files:**
- Create: `src/githubApp/client.ts`
- Test: `src/githubApp/__tests__/client.test.ts`

**Interfaces:**
- Consumes: `node:crypto` only.
- Produces:
  ```ts
  export interface AppConfig { appId: string; privateKey: string; webhookSecret: string }
  export function appConfigFromEnv(env?: NodeJS.ProcessEnv): AppConfig | null
  export function appJwt(cfg: { appId: string; privateKey: string }, nowSec?: number): string
  export class InstallationTokens { constructor(cfg: { appId: string; privateKey: string }, fetchImpl?: typeof fetch); tokenFor(installationId: number, now?: number): Promise<string> }
  export async function listAppInstallations(cfg: { appId: string; privateKey: string }, fetchImpl?: typeof fetch): Promise<{ installationId: number; orgScope: string; repoSelection: "all" | "selected"; suspended: boolean }[]>
  export async function listOrgMembers(token: string, org: string, fetchImpl?: typeof fetch): Promise<{ login: string; role: "admin" | "member" }[]>
  export async function listInstallationRepos(token: string, fetchImpl?: typeof fetch): Promise<{ repo: string; defaultBranch: string }[]>
  ```

- [ ] **Step 1: Write the failing tests** — create `src/githubApp/__tests__/client.test.ts`:

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { generateKeyPairSync, createVerify } from "node:crypto";
import { appConfigFromEnv, appJwt, InstallationTokens, listAppInstallations, listOrgMembers, listInstallationRepos } from "../client.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
const cfg = { appId: "12345", privateKey: pem };

function fakeFetch(routes: Record<string, (init?: RequestInit) => { status?: number; body: unknown }>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const f = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, init });
    const hit = Object.entries(routes).find(([k]) => u.includes(k));
    if (!hit) return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
    const r = hit[1](init);
    return { ok: (r.status ?? 200) < 300, status: r.status ?? 200, json: async () => r.body } as unknown as Response;
  }) as typeof fetch;
  return { f, calls };
}

describe("appConfigFromEnv", () => {
  it("null unless all three are set", () => {
    expect(appConfigFromEnv({} as NodeJS.ProcessEnv)).toBeNull();
    expect(appConfigFromEnv({ GITHUB_APP_ID: "1", GITHUB_APP_PRIVATE_KEY: pem } as NodeJS.ProcessEnv)).toBeNull();
    expect(appConfigFromEnv({ GITHUB_APP_ID: "1", GITHUB_APP_PRIVATE_KEY: pem, GITHUB_APP_WEBHOOK_SECRET: "s" } as NodeJS.ProcessEnv))
      .toEqual({ appId: "1", privateKey: pem, webhookSecret: "s" });
  });
});

describe("appJwt", () => {
  it("mints a valid RS256 JWT with iss/iat/exp", () => {
    const jwt = appJwt(cfg, 1_000_000);
    const [h, p, s] = jwt.split(".");
    expect(JSON.parse(Buffer.from(h, "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });
    expect(JSON.parse(Buffer.from(p, "base64url").toString())).toEqual({ iat: 999_940, exp: 1_000_540, iss: "12345" });
    const ok = createVerify("RSA-SHA256").update(`${h}.${p}`).verify(publicKey, Buffer.from(s, "base64url"));
    expect(ok).toBe(true);
  });
});

describe("InstallationTokens", () => {
  it("mints via POST with a JWT bearer, caches until near expiry, refreshes after", async () => {
    let n = 0;
    const { f, calls } = fakeFetch({
      "/app/installations/7/access_tokens": () => ({ body: { token: `tok-${++n}`, expires_at: new Date(2_000_000_000).toISOString() } }),
    });
    const tokens = new InstallationTokens(cfg, f);
    expect(await tokens.tokenFor(7, 1_000_000_000)).toBe("tok-1");
    expect(await tokens.tokenFor(7, 1_100_000_000)).toBe("tok-1"); // cached (expiry - 5min still ahead)
    expect(await tokens.tokenFor(7, 1_999_800_000)).toBe("tok-2"); // within 5min of expiry → refresh
    expect(calls[0].init?.method).toBe("POST");
    expect(String((calls[0].init?.headers as Record<string, string>).Authorization)).toMatch(/^Bearer eyJ/);
  });
});

describe("list APIs", () => {
  it("listAppInstallations keeps only Organization installs, normalizes fields", async () => {
    const { f } = fakeFetch({
      "/app/installations?": () => ({ body: [
        { id: 7, account: { login: "Acme", type: "Organization" }, repository_selection: "selected", suspended_at: null },
        { id: 8, account: { login: "someuser", type: "User" }, repository_selection: "all", suspended_at: null },
        { id: 9, account: { login: "Globex", type: "Organization" }, repository_selection: "all", suspended_at: "2026-01-01T00:00:00Z" },
      ] }),
    });
    expect(await listAppInstallations(cfg, f)).toEqual([
      { installationId: 7, orgScope: "acme", repoSelection: "selected", suspended: false },
      { installationId: 9, orgScope: "globex", repoSelection: "all", suspended: true },
    ]);
  });

  it("listOrgMembers merges the admin and member role pages, lowercased", async () => {
    const { f } = fakeFetch({
      "role=admin": () => ({ body: [{ login: "Alice" }] }),
      "role=member": () => ({ body: [{ login: "bob" }] }),
    });
    expect((await listOrgMembers("t", "acme", f)).sort((a, b) => a.login.localeCompare(b.login)))
      .toEqual([{ login: "alice", role: "admin" }, { login: "bob", role: "member" }]);
  });

  it("listInstallationRepos returns full_name + default_branch", async () => {
    const { f } = fakeFetch({
      "/installation/repositories": () => ({ body: { repositories: [{ full_name: "acme/skills", default_branch: "trunk" }] } }),
    });
    expect(await listInstallationRepos("t", f)).toEqual([{ repo: "acme/skills", defaultBranch: "trunk" }]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
pnpm exec tsc -b 2>&1 | head -5
```
Expected: FAIL — `../client.js` doesn't exist.

- [ ] **Step 3: Implement** — create `src/githubApp/client.ts`:

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/githubApp/client.ts
// Server-to-server GitHub App client: RS256 app JWT (node:crypto — no JWT dependency), cached
// installation tokens, and the three list APIs sync needs. Hand-rolled fetch, matching the
// registryGithub/accountVerifier style. Installation tokens live ~1h; the cache refreshes 5min
// early and NEVER persists tokens.
import { createSign } from "node:crypto";

export interface AppConfig { appId: string; privateKey: string; webhookSecret: string }

/** All three secrets or nothing — a partial config is treated as unconfigured (dormant). */
export function appConfigFromEnv(env: NodeJS.ProcessEnv = process.env): AppConfig | null {
  const appId = env.GITHUB_APP_ID;
  const privateKey = env.GITHUB_APP_PRIVATE_KEY;
  const webhookSecret = env.GITHUB_APP_WEBHOOK_SECRET;
  return appId && privateKey && webhookSecret ? { appId, privateKey, webhookSecret } : null;
}

const b64url = (buf: Buffer): string => buf.toString("base64url");

/** 9-minute app JWT (GitHub max is 10; iat backdated 60s for clock skew). */
export function appJwt(cfg: { appId: string; privateKey: string }, nowSec: number = Math.floor(Date.now() / 1000)): string {
  const header = b64url(Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const payload = b64url(Buffer.from(JSON.stringify({ iat: nowSec - 60, exp: nowSec + 540, iss: cfg.appId })));
  const sig = createSign("RSA-SHA256").update(`${header}.${payload}`).sign(cfg.privateKey);
  return `${header}.${payload}.${b64url(sig)}`;
}

const ghHeaders = (bearer: string): Record<string, string> =>
  ({ Authorization: `Bearer ${bearer}`, Accept: "application/vnd.github+json", "User-Agent": "agentgem" });

export class InstallationTokens {
  private cache = new Map<number, { token: string; expiresAtMs: number }>();
  constructor(private cfg: { appId: string; privateKey: string }, private fetchImpl: typeof fetch = fetch) {}

  async tokenFor(installationId: number, now: number = Date.now()): Promise<string> {
    const hit = this.cache.get(installationId);
    if (hit && hit.expiresAtMs - 5 * 60_000 > now) return hit.token;
    const res = await this.fetchImpl(`https://api.github.com/app/installations/${installationId}/access_tokens`, {
      method: "POST", headers: ghHeaders(appJwt(this.cfg, Math.floor(now / 1000))),
    });
    if (!res.ok) throw new Error(`installation token ${installationId}: ${res.status}`);
    const j = (await res.json()) as { token?: unknown; expires_at?: unknown };
    if (typeof j.token !== "string") throw new Error("installation token: unexpected shape");
    const expiresAtMs = typeof j.expires_at === "string" ? new Date(j.expires_at).getTime() : now + 3_600_000;
    this.cache.set(installationId, { token: j.token, expiresAtMs });
    return j.token;
  }
}

/** Org installations of this App (User installs are out of scope). Paginated; login lowercased. */
export async function listAppInstallations(
  cfg: { appId: string; privateKey: string }, fetchImpl: typeof fetch = fetch,
): Promise<{ installationId: number; orgScope: string; repoSelection: "all" | "selected"; suspended: boolean }[]> {
  const out: { installationId: number; orgScope: string; repoSelection: "all" | "selected"; suspended: boolean }[] = [];
  for (let page = 1; page <= 10; page++) {
    const res = await fetchImpl(`https://api.github.com/app/installations?per_page=100&page=${page}`, { headers: ghHeaders(appJwt(cfg)) });
    if (!res.ok) throw new Error(`app/installations: ${res.status}`);
    const batch = (await res.json()) as { id?: unknown; account?: { login?: unknown; type?: unknown }; repository_selection?: unknown; suspended_at?: unknown }[];
    if (!Array.isArray(batch) || batch.length === 0) break;
    for (const i of batch) {
      if (typeof i.id !== "number" || i.account?.type !== "Organization" || typeof i.account.login !== "string") continue;
      out.push({
        installationId: i.id, orgScope: i.account.login.toLowerCase(),
        repoSelection: i.repository_selection === "all" ? "all" : "selected",
        suspended: i.suspended_at != null,
      });
    }
    if (batch.length < 100) break;
  }
  return out;
}

/** Full member list with roles: the admin page then the (non-admin) member page, both paginated.
 *  Includes PRIVATE members — that's the entire point of the App. Logins lowercased. */
export async function listOrgMembers(token: string, org: string, fetchImpl: typeof fetch = fetch): Promise<{ login: string; role: "admin" | "member" }[]> {
  const byLogin = new Map<string, "admin" | "member">();
  for (const role of ["admin", "member"] as const) {
    for (let page = 1; page <= 20; page++) {
      const res = await fetchImpl(`https://api.github.com/orgs/${encodeURIComponent(org)}/members?role=${role}&per_page=100&page=${page}`, { headers: ghHeaders(token) });
      if (!res.ok) throw new Error(`orgs/${org}/members: ${res.status}`);
      const batch = (await res.json()) as { login?: unknown }[];
      if (!Array.isArray(batch) || batch.length === 0) break;
      for (const m of batch) if (typeof m.login === "string" && !byLogin.has(m.login.toLowerCase())) byLogin.set(m.login.toLowerCase(), role);
      if (batch.length < 100) break;
    }
  }
  return [...byLogin].map(([login, role]) => ({ login, role }));
}

/** Repos this installation can see, with default branches (the only ref we ever index). */
export async function listInstallationRepos(token: string, fetchImpl: typeof fetch = fetch): Promise<{ repo: string; defaultBranch: string }[]> {
  const out: { repo: string; defaultBranch: string }[] = [];
  for (let page = 1; page <= 20; page++) {
    const res = await fetchImpl(`https://api.github.com/installation/repositories?per_page=100&page=${page}`, { headers: ghHeaders(token) });
    if (!res.ok) throw new Error(`installation/repositories: ${res.status}`);
    const j = (await res.json()) as { repositories?: { full_name?: unknown; default_branch?: unknown }[] };
    const repos = Array.isArray(j.repositories) ? j.repositories : [];
    for (const r of repos) {
      if (typeof r.full_name === "string") out.push({ repo: r.full_name, defaultBranch: typeof r.default_branch === "string" ? r.default_branch : "main" });
    }
    if (repos.length < 100) break;
  }
  return out;
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm exec tsc -b && pnpm exec vitest run dist/githubApp/__tests__/client.test.js
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/githubApp/client.ts src/githubApp/__tests__/client.test.ts
git commit -m "feat(github-app): app JWT, cached installation tokens, list APIs (no new deps)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Org repo indexer

**Files:**
- Create: `src/githubApp/orgIndexer.ts`
- Test: `src/githubApp/__tests__/orgIndexer.test.ts`

**Interfaces:**
- Consumes: `listSkillMd`, `fetchSkillsEntry`, `skillRefFromPath` and types `Http`, `GithubCfg` from `@agentgem/distribute`; `replaceOrgRepoSkills`, `OrgSkillRow` from `@agentgem/aggregator` (Task 3).
- Produces:
  ```ts
  export async function indexOrgRepo(db: AppDb, http: Http, token: string, orgScope: string, repo: string, ref: string): Promise<number>
  ```
  Source id convention (used by Tasks 7–9 and the UI): `org:<owner>/<repo>`.

- [ ] **Step 1: Write the failing tests** — create `src/githubApp/__tests__/orgIndexer.test.ts`:

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { makeTestDb, listOrgSkills } from "@agentgem/aggregator";
import type { Http } from "@agentgem/distribute";
import { indexOrgRepo } from "../orgIndexer.js";

const b64 = (s: string) => Buffer.from(s).toString("base64");
const skillMd = (name: string, desc: string) => `---\nname: ${name}\ndescription: ${desc}\n---\nbody`;

// Fake GitHub: one tree listing + per-file contents. Asserts the installation token is sent.
function fakeRepoHttp(files: Record<string, string>, seenAuth: string[] = []): Http {
  return async (url, init) => {
    seenAuth.push(String((init?.headers as Record<string, string>)?.Authorization ?? ""));
    if (url.includes("/git/trees/")) {
      const tree = Object.keys(files).map((path) => ({ path, type: "blob" }));
      return { status: 200, text: async () => JSON.stringify({ tree }) };
    }
    const path = decodeURIComponent(url.split("/contents/")[1]?.split("?")[0] ?? "");
    if (files[path]) return { status: 200, text: async () => JSON.stringify({ content: b64(files[path]), encoding: "base64" }) };
    return { status: 404, text: async () => "{}" };
  };
}

describe("indexOrgRepo", () => {
  it("indexes SKILL.md metadata (frontmatter name+description), token on every call", async () => {
    const db = await makeTestDb();
    const seen: string[] = [];
    const http = fakeRepoHttp({
      "eng/deploy/SKILL.md": skillMd("deploy-runbook", "How we deploy"),
      "eng/oncall/SKILL.md": skillMd("oncall", "Oncall playbook"),
      "README.md": "not a skill",
    }, seen);
    const n = await indexOrgRepo(db, http, "tok-1", "Acme", "acme/skills", "main");
    expect(n).toBe(2);
    const rows = await listOrgSkills(db, "acme");
    expect(rows.map((r) => ({ name: r.name, sourceId: r.sourceId, description: r.description }))).toEqual([
      { name: "deploy-runbook", sourceId: "org:acme/skills", description: "How we deploy" },
      { name: "oncall", sourceId: "org:acme/skills", description: "Oncall playbook" },
    ]);
    expect(seen.every((a) => a === "Bearer tok-1")).toBe(true);
  });

  it("a failing entry fetch indexes with null description; re-index drops removed skills", async () => {
    const db = await makeTestDb();
    // First index: two skills, one body 404s (metadata still indexed via path-derived name).
    let http = fakeRepoHttp({ "eng/deploy/SKILL.md": skillMd("deploy", "d") });
    const treeOnly: Http = async (url, init) => {
      if (url.includes("/git/trees/")) return { status: 200, text: async () => JSON.stringify({ tree: [{ path: "eng/deploy/SKILL.md", type: "blob" }, { path: "eng/gone/SKILL.md", type: "blob" }] }) };
      return http(url, init);
    };
    expect(await indexOrgRepo(db, treeOnly, "t", "acme", "acme/skills", "main")).toBe(2);
    expect((await listOrgSkills(db, "acme")).find((r) => r.name === "gone")?.description).toBeNull();
    // Second index: repo now has only deploy → gone disappears.
    expect(await indexOrgRepo(db, http, "t", "acme", "acme/skills", "main")).toBe(1);
    expect((await listOrgSkills(db, "acme")).map((r) => r.name)).toEqual(["deploy"]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
pnpm exec tsc -b 2>&1 | head -5
```
Expected: FAIL — `../orgIndexer.js` doesn't exist.

- [ ] **Step 3: Implement** — create `src/githubApp/orgIndexer.ts`:

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/githubApp/orgIndexer.ts
// Walks one installation repo for SKILL.md files (the same skills-layout machinery the public
// curated sources use, authenticated with an installation token) and replaces that (org, repo)
// slice of curated_skills. METADATA ONLY — bodies are never stored (the data-custody boundary);
// reads go through the member-gated /api/orgs/skill-body proxy instead.
import { replaceOrgRepoSkills, type AppDb, type OrgSkillRow } from "@agentgem/aggregator";
import { listSkillMd, fetchSkillsEntry, skillRefFromPath, type Http, type GithubCfg } from "@agentgem/distribute";

export async function indexOrgRepo(db: AppDb, http: Http, token: string, orgScope: string, repo: string, ref: string): Promise<number> {
  const cfg: GithubCfg = { repo, ref, token };
  const paths = await listSkillMd(cfg, http);
  const rows: OrgSkillRow[] = [];
  for (const path of paths) {
    const r = skillRefFromPath(path);
    // One entry fetch per skill for the frontmatter name/description; a single skill failing
    // (404 mid-push, malformed frontmatter) must not sink the repo — index it path-derived.
    let name = r.name;
    let description: string | null = null;
    try {
      const entry = await fetchSkillsEntry(path, cfg, http);
      name = entry.name ?? r.name;
      description = entry.description ?? null;
    } catch { /* keep path-derived name, null description */ }
    rows.push({ sourceId: `org:${repo}`, path, division: r.division, name, repo, description });
  }
  await replaceOrgRepoSkills(db, orgScope, repo, rows);
  return rows.length;
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm exec tsc -b && pnpm exec vitest run dist/githubApp/__tests__/orgIndexer.test.js
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/githubApp/orgIndexer.ts src/githubApp/__tests__/orgIndexer.test.ts
git commit -m "feat(github-app): metadata-only indexer for installation skill repos

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Event sync + reconcile

**Files:**
- Create: `src/githubApp/sync.ts`
- Test: `src/githubApp/__tests__/sync.test.ts`

**Interfaces:**
- Consumes: store fns (Task 2), `deleteOrgRepoSkills` (Task 3), client (Task 5), `indexOrgRepo` (Task 6).
- Produces:
  ```ts
  export interface GithubAppDeps { db: AppDb; cfg: AppConfig | null; tokens: InstallationTokens | null; http: Http; fetchImpl: typeof fetch }
  export async function handleWebhookEvent(deps: GithubAppDeps, event: string, payload: unknown): Promise<void>
  export async function reconcileAll(deps: GithubAppDeps): Promise<{ installations: number }>
  ```
  Task 8's express layer calls `handleWebhookEvent` after acking; Task 10's scheduler calls `reconcileAll`.

- [ ] **Step 1: Write the failing tests** — create `src/githubApp/__tests__/sync.test.ts`:

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import {
  makeTestDb, listInstallations, appOrgRole, listOrgSkills, upsertInstallation, replaceOrgMembers,
} from "@agentgem/aggregator";
import type { Http } from "@agentgem/distribute";
import { InstallationTokens } from "../client.js";
import { handleWebhookEvent, reconcileAll, type GithubAppDeps } from "../sync.js";
import { generateKeyPairSync } from "node:crypto";

const pem = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }) as string;
const cfg = { appId: "1", privateKey: pem, webhookSecret: "s" };
const b64 = (s: string) => Buffer.from(s).toString("base64");

// One fake GitHub covering REST (fetch) + Contents (Http): acme has alice(admin)+bob, one repo
// with one skill. Mutate `state` between calls to simulate change.
function fakeGithub(state: { members: { login: string; role: "admin" | "member" }[]; repos: { repo: string; defaultBranch: string }[]; files: Record<string, string> }) {
  const fetchImpl = (async (url: string | URL) => {
    const u = String(url);
    const j = (body: unknown) => ({ ok: true, status: 200, json: async () => body } as unknown as Response);
    if (u.includes("/access_tokens")) return j({ token: "itok", expires_at: new Date(Date.now() + 3_600_000).toISOString() });
    if (u.includes("role=admin")) return j(state.members.filter((m) => m.role === "admin").map((m) => ({ login: m.login })));
    if (u.includes("role=member")) return j(state.members.filter((m) => m.role === "member").map((m) => ({ login: m.login })));
    if (u.includes("/installation/repositories")) return j({ repositories: state.repos.map((r) => ({ full_name: r.repo, default_branch: r.defaultBranch })) });
    if (u.includes("/app/installations")) return j([{ id: 7, account: { login: "acme", type: "Organization" }, repository_selection: "selected", suspended_at: null }]);
    return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
  }) as typeof fetch;
  const http: Http = async (u) => {
    if (u.includes("/git/trees/")) return { status: 200, text: async () => JSON.stringify({ tree: Object.keys(state.files).map((path) => ({ path, type: "blob" })) }) };
    const path = decodeURIComponent(u.split("/contents/")[1]?.split("?")[0] ?? "");
    if (state.files[path]) return { status: 200, text: async () => JSON.stringify({ content: b64(state.files[path]), encoding: "base64" }) };
    return { status: 404, text: async () => "{}" };
  };
  return { fetchImpl, http };
}

async function makeDeps(state: Parameters<typeof fakeGithub>[0]): Promise<GithubAppDeps> {
  const db = await makeTestDb();
  const { fetchImpl, http } = fakeGithub(state);
  return { db, cfg, tokens: new InstallationTokens(cfg, fetchImpl), http, fetchImpl };
}

const baseState = () => ({
  members: [{ login: "alice", role: "admin" as const }, { login: "bob", role: "member" as const }],
  repos: [{ repo: "acme/skills", defaultBranch: "main" }],
  files: { "eng/deploy/SKILL.md": "---\nname: deploy\ndescription: d\n---\n" },
});
const installPayload = { action: "created", installation: { id: 7, account: { login: "Acme", type: "Organization" }, repository_selection: "selected" } };

describe("handleWebhookEvent", () => {
  it("installation.created syncs members and indexes repos", async () => {
    const deps = await makeDeps(baseState());
    await handleWebhookEvent(deps, "installation", installPayload);
    expect(await listInstallations(deps.db)).toEqual([{ installationId: 7, orgScope: "acme", repoSelection: "selected", suspended: false }]);
    expect(await appOrgRole(deps.db, "alice", "acme")).toBe("admin");
    expect((await listOrgSkills(deps.db, "acme")).map((s) => s.name)).toEqual(["deploy"]);
  });

  it("installation.deleted forgets everything; suspend flips the flag", async () => {
    const deps = await makeDeps(baseState());
    await handleWebhookEvent(deps, "installation", installPayload);
    await handleWebhookEvent(deps, "installation", { action: "suspend", installation: installPayload.installation });
    expect((await listInstallations(deps.db))[0].suspended).toBe(true);
    expect(await appOrgRole(deps.db, "alice", "acme")).toBeNull(); // suspended blocks the gate
    await handleWebhookEvent(deps, "installation", { action: "deleted", installation: installPayload.installation });
    expect(await listInstallations(deps.db)).toEqual([]);
    expect(await listOrgSkills(deps.db, "acme")).toEqual([]);
  });

  it("organization member events apply single-row deltas", async () => {
    const deps = await makeDeps(baseState());
    await handleWebhookEvent(deps, "installation", installPayload);
    await handleWebhookEvent(deps, "organization", { action: "member_removed", organization: { login: "acme" }, membership: { user: { login: "Bob" } } });
    expect(await appOrgRole(deps.db, "bob", "acme")).toBeNull();
    await handleWebhookEvent(deps, "organization", { action: "member_added", organization: { login: "acme" }, membership: { user: { login: "Carol" }, role: "member" } });
    expect(await appOrgRole(deps.db, "carol", "acme")).toBe("member");
  });

  it("push on the default branch reindexes; other refs are ignored", async () => {
    const state = baseState();
    const deps = await makeDeps(state);
    await handleWebhookEvent(deps, "installation", installPayload);
    state.files["eng/newskill/SKILL.md"] = "---\nname: newskill\ndescription: n\n---\n";
    await handleWebhookEvent(deps, "push", { ref: "refs/heads/side", repository: { full_name: "acme/skills", default_branch: "main", owner: { login: "acme" } } });
    expect((await listOrgSkills(deps.db, "acme")).length).toBe(1); // non-default ref ignored
    await handleWebhookEvent(deps, "push", { ref: "refs/heads/main", repository: { full_name: "acme/skills", default_branch: "main", owner: { login: "acme" } } });
    expect((await listOrgSkills(deps.db, "acme")).map((s) => s.name).sort()).toEqual(["deploy", "newskill"]);
  });

  it("installation_repositories removes deselected repos' skills", async () => {
    const deps = await makeDeps(baseState());
    await handleWebhookEvent(deps, "installation", installPayload);
    await handleWebhookEvent(deps, "installation_repositories", {
      action: "removed_repositories", installation: installPayload.installation,
      repositories_added: [], repositories_removed: [{ full_name: "acme/skills" }],
    });
    expect(await listOrgSkills(deps.db, "acme")).toEqual([]);
  });
});

describe("reconcileAll", () => {
  it("adopts remote installations, syncs them, and drops local ones GitHub no longer has", async () => {
    const deps = await makeDeps(baseState());
    // Local drift: a stale installation GitHub doesn't know about + stale member state.
    await upsertInstallation(deps.db, { installationId: 99, orgScope: "gone", repoSelection: "all", suspended: false });
    await replaceOrgMembers(deps.db, "gone", [{ login: "zed", role: "member" }]);
    const out = await reconcileAll(deps);
    expect(out.installations).toBe(1);
    expect((await listInstallations(deps.db)).map((i) => i.installationId)).toEqual([7]);
    expect(await appOrgRole(deps.db, "alice", "acme")).toBe("admin");
    expect(await appOrgRole(deps.db, "zed", "gone")).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
pnpm exec tsc -b 2>&1 | head -5
```
Expected: FAIL — `../sync.js` doesn't exist.

- [ ] **Step 3: Implement** — create `src/githubApp/sync.ts`:

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/githubApp/sync.ts
// Webhook-event handlers + the daily reconcile. Webhooks are the primary sync path (seconds-level
// offboarding); reconcileAll heals missed deliveries (GitHub does NOT auto-retry webhooks). Every
// handler is an idempotent upsert/delete keyed by natural ids, so redeliveries and reconcile
// overlap are harmless. Per-repo/per-installation failures log and continue (accountVerifier style).
import {
  upsertInstallation, setInstallationSuspended, deleteInstallation, installationForScope, listInstallations,
  replaceOrgMembers, upsertOrgMember, deleteOrgMember, deleteOrgRepoSkills,
  type AppDb, type AppInstallation,
} from "@agentgem/aggregator";
import type { Http } from "@agentgem/distribute";
import { listAppInstallations, listOrgMembers, listInstallationRepos, InstallationTokens, type AppConfig } from "./client.js";
import { indexOrgRepo } from "./orgIndexer.js";

export interface GithubAppDeps { db: AppDb; cfg: AppConfig | null; tokens: InstallationTokens | null; http: Http; fetchImpl: typeof fetch }

// Installation shape from webhook payloads (installation.account is the org it's installed on).
function instFromPayload(p: unknown): AppInstallation | null {
  const i = (p as { installation?: { id?: unknown; account?: { login?: unknown; type?: unknown }; repository_selection?: unknown } })?.installation;
  if (!i || typeof i.id !== "number" || typeof i.account?.login !== "string") return null;
  if (i.account.type !== "Organization") return null; // user installs are out of scope
  return { installationId: i.id, orgScope: i.account.login.toLowerCase(), repoSelection: i.repository_selection === "all" ? "all" : "selected", suspended: false };
}

async function syncInstallation(deps: GithubAppDeps, inst: AppInstallation): Promise<void> {
  if (!deps.tokens) return;
  const token = await deps.tokens.tokenFor(inst.installationId);
  await replaceOrgMembers(deps.db, inst.orgScope, await listOrgMembers(token, inst.orgScope, deps.fetchImpl));
  await indexInstallationRepos(deps, inst);
}

async function indexInstallationRepos(deps: GithubAppDeps, inst: AppInstallation): Promise<void> {
  if (!deps.tokens) return;
  const token = await deps.tokens.tokenFor(inst.installationId);
  for (const r of await listInstallationRepos(token, deps.fetchImpl)) {
    try {
      await indexOrgRepo(deps.db, deps.http, token, inst.orgScope, r.repo, r.defaultBranch);
    } catch (e) {
      console.error(`githubApp: index ${r.repo} failed: ${(e as Error).message}`);
    }
  }
}

export async function handleWebhookEvent(deps: GithubAppDeps, event: string, payload: unknown): Promise<void> {
  const p = (payload ?? {}) as Record<string, unknown>;
  const action = typeof p.action === "string" ? p.action : "";

  if (event === "installation") {
    const inst = instFromPayload(p);
    if (!inst) return;
    if (action === "created" || action === "unsuspend" || action === "new_permissions_accepted") {
      await upsertInstallation(deps.db, inst);
      await syncInstallation(deps, inst);
    } else if (action === "suspend") {
      await setInstallationSuspended(deps.db, inst.installationId, true);
    } else if (action === "deleted") {
      await deleteInstallation(deps.db, inst.installationId);
    }
    return;
  }

  if (event === "installation_repositories") {
    const inst = instFromPayload(p);
    if (!inst) return;
    await upsertInstallation(deps.db, inst); // repo_selection may have changed with the event
    const removed = Array.isArray(p.repositories_removed) ? p.repositories_removed as { full_name?: unknown }[] : [];
    for (const r of removed) {
      if (typeof r.full_name === "string") await deleteOrgRepoSkills(deps.db, inst.orgScope, r.full_name);
    }
    const added = Array.isArray(p.repositories_added) ? p.repositories_added : [];
    // Added repos: re-list via the API (the payload lacks default branches) and index everything.
    if (added.length > 0) await indexInstallationRepos(deps, inst);
    return;
  }

  if (event === "organization") {
    const org = String((p.organization as { login?: unknown })?.login ?? "").toLowerCase();
    const membership = p.membership as { user?: { login?: unknown }; role?: unknown } | undefined;
    const login = String(membership?.user?.login ?? "").toLowerCase();
    if (!org || !login) return;
    if (action === "member_added") await upsertOrgMember(deps.db, org, login, membership?.role === "admin" ? "admin" : "member");
    else if (action === "member_removed") await deleteOrgMember(deps.db, org, login);
    return;
  }

  if (event === "push") {
    const repoInfo = p.repository as { full_name?: unknown; default_branch?: unknown; owner?: { login?: unknown } } | undefined;
    const repo = String(repoInfo?.full_name ?? "");
    const org = String(repoInfo?.owner?.login ?? "").toLowerCase();
    const defaultBranch = String(repoInfo?.default_branch ?? "main");
    if (!repo || !org || p.ref !== `refs/heads/${defaultBranch}`) return; // only the default branch is indexed
    const inst = await installationForScope(deps.db, org);
    if (!inst || inst.suspended || !deps.tokens) return;
    const token = await deps.tokens.tokenFor(inst.installationId);
    await indexOrgRepo(deps.db, deps.http, token, org, repo, defaultBranch);
  }
}

/** Daily backstop: adopt GitHub's installation list as truth, resync each active install, and
 *  forget local installations GitHub no longer reports. */
export async function reconcileAll(deps: GithubAppDeps): Promise<{ installations: number }> {
  if (!deps.cfg) return { installations: 0 };
  const remote = await listAppInstallations(deps.cfg, deps.fetchImpl);
  for (const local of await listInstallations(deps.db)) {
    if (!remote.some((r) => r.installationId === local.installationId)) await deleteInstallation(deps.db, local.installationId);
  }
  for (const r of remote) {
    await upsertInstallation(deps.db, r);
    if (r.suspended) continue;
    try {
      await syncInstallation(deps, r);
    } catch (e) {
      console.error(`githubApp: reconcile ${r.orgScope} (#${r.installationId}) failed: ${(e as Error).message}`);
    }
  }
  return { installations: remote.length };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm exec tsc -b && pnpm exec vitest run dist/githubApp/__tests__/sync.test.js
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/githubApp/sync.ts src/githubApp/__tests__/sync.test.ts
git commit -m "feat(github-app): webhook event sync + daily reconcile backstop

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: Webhook endpoint (HMAC verify, fast ack)

**Files:**
- Create: `src/githubApp/webhook.ts`
- Test: `src/githubApp/__tests__/webhook.test.ts`

**Interfaces:**
- Consumes: `GithubAppDeps`, `handleWebhookEvent` (Task 7). Reads `(req as { rawBody?: Buffer }).rawBody` — captured by the bodyParser `verify` hook wired in Task 10.
- Produces:
  ```ts
  export function verifyWebhookSignature(raw: Buffer, secret: string, sigHeader: string | undefined): boolean
  export function webhookHandler(deps: GithubAppDeps): (req: WebhookReq, res: WebhookRes) => void
  export function installGithubWebhook(expressApp: { post(p: string, h: unknown): unknown }, deps: GithubAppDeps): void   // POST /api/github/webhook
  ```
  Response contract: 503 unconfigured, 401 bad/missing signature, 200 `{ok:true}` on verified events (processing continues async).

- [ ] **Step 1: Write the failing tests** — create `src/githubApp/__tests__/webhook.test.ts`:

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect, vi } from "vitest";
import { createHmac, generateKeyPairSync } from "node:crypto";
import { makeTestDb, listInstallations, upsertInstallation } from "@agentgem/aggregator";
import { verifyWebhookSignature, webhookHandler } from "../webhook.js";
import type { GithubAppDeps } from "../sync.js";

const pem = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }) as string;
const secret = "hush";
const cfg = { appId: "1", privateKey: pem, webhookSecret: secret };
const sig = (raw: Buffer) => `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;

function mockRes() {
  const r: any = { _status: 200, _body: undefined };
  r.status = (c: number) => { r._status = c; return r; };
  r.json = (b: unknown) => { r._body = b; return r; };
  return r;
}
const mkReq = (raw: Buffer | undefined, headers: Record<string, string>) =>
  ({ rawBody: raw, body: raw ? JSON.parse(raw.toString()) : {}, headers }) as any;

async function makeDeps(): Promise<GithubAppDeps> {
  return { db: await makeTestDb(), cfg, tokens: null, http: async () => ({ status: 404, text: async () => "{}" }), fetchImpl: fetch };
}

describe("verifyWebhookSignature", () => {
  const raw = Buffer.from('{"a":1}');
  it("accepts the right sig, rejects wrong/missing/garbage", () => {
    expect(verifyWebhookSignature(raw, secret, sig(raw))).toBe(true);
    expect(verifyWebhookSignature(raw, secret, sig(Buffer.from("{}")))).toBe(false);
    expect(verifyWebhookSignature(raw, secret, undefined)).toBe(false);
    expect(verifyWebhookSignature(raw, secret, "sha256=nothex")).toBe(false);
    expect(verifyWebhookSignature(raw, secret, "sha1=abcd")).toBe(false);
  });
});

describe("webhookHandler", () => {
  it("503 when unconfigured", async () => {
    const deps = await makeDeps();
    const res = mockRes();
    webhookHandler({ ...deps, cfg: null })(mkReq(Buffer.from("{}"), {}), res);
    expect(res._status).toBe(503);
  });

  it("401 on bad signature or missing raw body; nothing processed", async () => {
    const deps = await makeDeps();
    const raw = Buffer.from(JSON.stringify({ action: "created", installation: { id: 7, account: { login: "acme", type: "Organization" }, repository_selection: "all" } }));
    let res = mockRes();
    webhookHandler(deps)(mkReq(raw, { "x-hub-signature-256": "sha256=deadbeef", "x-github-event": "installation" }), res);
    expect(res._status).toBe(401);
    res = mockRes();
    webhookHandler(deps)(mkReq(undefined, { "x-hub-signature-256": sig(raw), "x-github-event": "installation" }), res);
    expect(res._status).toBe(401);
    expect(await listInstallations(deps.db)).toEqual([]);
  });

  it("200 + async processing on a verified event", async () => {
    const deps = await makeDeps();
    await upsertInstallation(deps.db, { installationId: 7, orgScope: "acme", repoSelection: "all", suspended: false });
    const raw = Buffer.from(JSON.stringify({ action: "suspend", installation: { id: 7, account: { login: "acme", type: "Organization" }, repository_selection: "all" } }));
    const res = mockRes();
    webhookHandler(deps)(mkReq(raw, { "x-hub-signature-256": sig(raw), "x-github-event": "installation" }), res);
    expect(res._status).toBe(200); // acked BEFORE processing
    expect(res._body).toEqual({ ok: true });
    await vi.waitFor(async () => {
      expect((await listInstallations(deps.db))[0]?.suspended).toBe(true); // async handler landed
    });
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
pnpm exec tsc -b 2>&1 | head -5
```
Expected: FAIL — `../webhook.js` doesn't exist.

- [ ] **Step 3: Implement** — create `src/githubApp/webhook.ts`:

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/githubApp/webhook.ts
// POST /api/github/webhook. HMAC-SHA256 over the RAW body (captured by the bodyParser `verify`
// hook in src/index.ts — re-serializing req.body is NOT byte-faithful) compared with
// timingSafeEqual. Verified events ack 200 immediately and process async: GitHub times out at
// 10s and does not auto-retry, so indexing must never block the ack. Handlers are idempotent;
// a processing failure logs and waits for the daily reconcile.
import { createHmac, timingSafeEqual } from "node:crypto";
import { handleWebhookEvent, type GithubAppDeps } from "./sync.js";

export function verifyWebhookSignature(raw: Buffer, secret: string, sigHeader: string | undefined): boolean {
  if (!sigHeader || !sigHeader.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", secret).update(raw).digest();
  const got = Buffer.from(sigHeader.slice("sha256=".length), "hex");
  return got.length === expected.length && timingSafeEqual(got, expected);
}

interface WebhookReq { rawBody?: Buffer; body: unknown; headers: Record<string, string | string[] | undefined> }
interface WebhookRes { status(c: number): WebhookRes; json(b: unknown): WebhookRes }

export function webhookHandler(deps: GithubAppDeps) {
  return (req: WebhookReq, res: WebhookRes): void => {
    if (!deps.cfg) { res.status(503).json({ error: "github app not configured" }); return; }
    const raw = req.rawBody;
    const sig = req.headers["x-hub-signature-256"];
    if (!raw || !verifyWebhookSignature(raw, deps.cfg.webhookSecret, typeof sig === "string" ? sig : undefined)) {
      res.status(401).json({ error: "bad signature" });
      return;
    }
    const event = String(req.headers["x-github-event"] ?? "");
    res.status(200).json({ ok: true }); // ack before processing — see file comment
    void handleWebhookEvent(deps, event, req.body).catch((e) => {
      console.error(`githubApp: ${event} handler failed: ${(e as Error).message}`);
    });
  };
}

export function installGithubWebhook(expressApp: { post(p: string, h: unknown): unknown }, deps: GithubAppDeps): void {
  expressApp.post("/api/github/webhook", webhookHandler(deps));
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm exec tsc -b && pnpm exec vitest run dist/githubApp/__tests__/webhook.test.js
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/githubApp/webhook.ts src/githubApp/__tests__/webhook.test.ts
git commit -m "feat(github-app): HMAC-verified webhook endpoint with fast ack

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: Member-gated `/api/orgs/*` endpoints

**Files:**
- Create: `src/githubApp/orgsApi.ts`
- Test: `src/githubApp/__tests__/orgsApi.test.ts`

**Interfaces:**
- Consumes: `resolveOrgAccess`, `installationForScope`, `listOrgSkills`, `orgSkillExists` (Tasks 2–3); `InstallationTokens` (Task 5); `ghContents`, `decodeFile`, `assertSkillsPath`, `Http` from `@agentgem/distribute`; `SESSION_COOKIE`, `parseCookies` from `../auth/cookie.js`; `resolveSession`, `defaultScopeTtlMs` patterns from `src/usage/install.ts`.
- Produces:
  ```ts
  export interface OrgsApiDeps { db: AppDb; webOrigins: string[]; tokens: InstallationTokens | null; http: Http; scopeTtlMs?: number }
  export function installOrgsApi(expressApp: ExpressApp, deps: OrgsApiDeps): void
  ```
  Routes (all `GET`+`OPTIONS`, credentialed CORS like usage):
  - `/api/orgs/app?scope=` → 200 `{ installed: boolean, isMember: boolean, role: "self"|"admin"|"member"|null }` (works signed-out: `isMember:false, role:null`)
  - `/api/orgs/skills?scope=` → 401 unsigned / 403 non-member (stale → `reason:"stale"`) / 200 `{ scope, skills: OrgSkillRow[] }`
  - `/api/orgs/skill-body?scope=&source=&path=` → same auth; 404 unknown skill or no active installation; 503 tokens unconfigured; 502 upstream failure; 200 `text/markdown` body

- [ ] **Step 1: Write the failing tests** — create `src/githubApp/__tests__/orgsApi.test.ts`:

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import {
  makeTestDb, upsertAccount, createSession, generateSessionToken,
  upsertInstallation, upsertOrgMember, replaceOrgRepoSkills,
} from "@agentgem/aggregator";
import type { Http } from "@agentgem/distribute";
import { InstallationTokens } from "../client.js";
import { orgAppHandler, orgSkillsHandler, orgSkillBodyHandler, type OrgsApiDeps } from "../orgsApi.js";

const pem = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }) as string;
const webOrigins = ["https://app.agentgem.ai"];

function mockRes() {
  const r: any = { _status: 200, _headers: {} as Record<string, string>, _body: undefined };
  r.status = (c: number) => { r._status = c; return r; };
  r.set = (k: string, v: string) => { r._headers[k.toLowerCase()] = v; return r; };
  r.setHeader = r.set;
  r.type = (t: string) => { r._headers["content-type"] = t; return r; };
  r.json = (b: unknown) => { r._body = b; return r; };
  r.send = (b: unknown) => { r._body = b; return r; };
  return r;
}
const req = (over: any = {}) => ({ method: "GET", path: "/", query: {}, body: {}, headers: {}, get(n: string) { return (this.headers as any)[n.toLowerCase()]; }, ...over });

const bodyHttp: Http = async (url) => {
  if (url.includes("/contents/eng/deploy/SKILL.md")) {
    return { status: 200, text: async () => JSON.stringify({ content: Buffer.from("# deploy body").toString("base64"), encoding: "base64" }) };
  }
  return { status: 404, text: async () => "{}" };
};
const tokenFetch = (async () => ({ ok: true, status: 200, json: async () => ({ token: "itok", expires_at: new Date(Date.now() + 3_600_000).toISOString() }) })) as unknown as typeof fetch;

async function setup(): Promise<{ deps: OrgsApiDeps; memberToken: string; strangerToken: string }> {
  const db = await makeTestDb();
  await upsertInstallation(db, { installationId: 7, orgScope: "acme", repoSelection: "selected", suspended: false });
  await upsertOrgMember(db, "acme", "alice", "member");
  await replaceOrgRepoSkills(db, "acme", "acme/skills", [
    { sourceId: "org:acme/skills", path: "eng/deploy/SKILL.md", division: "eng", name: "deploy", repo: "acme/skills", description: "d" },
  ]);
  const mk = async (login: string) => {
    const a = await upsertAccount(db, { provider: "github", accountId: login, login });
    const { token } = generateSessionToken();
    await createSession(db, a.id, token, 60_000);
    return token;
  };
  return {
    deps: { db, webOrigins, tokens: new InstallationTokens({ appId: "1", privateKey: pem }, tokenFetch), http: bodyHttp },
    memberToken: await mk("alice"),
    strangerToken: await mk("mallory"),
  };
}
const authed = (token: string, query: any) => req({ query, headers: { authorization: `Bearer ${token}` } });

describe("GET /api/orgs/app", () => {
  it("reports install + membership; signed-out callers get isMember:false", async () => {
    const { deps, memberToken } = await setup();
    let res = mockRes();
    await orgAppHandler(deps)(authed(memberToken, { scope: "acme" }) as any, res);
    expect(res._body).toEqual({ installed: true, isMember: true, role: "member" });
    res = mockRes();
    await orgAppHandler(deps)(req({ query: { scope: "acme" } }) as any, res);
    expect(res._body).toEqual({ installed: true, isMember: false, role: null });
    res = mockRes();
    await orgAppHandler(deps)(req({ query: { scope: "globex" } }) as any, res);
    expect(res._body).toEqual({ installed: false, isMember: false, role: null });
  });
});

describe("GET /api/orgs/skills", () => {
  it("401 unsigned, 403 non-member, 200 member with the list", async () => {
    const { deps, memberToken, strangerToken } = await setup();
    let res = mockRes();
    await orgSkillsHandler(deps)(req({ query: { scope: "acme" } }) as any, res);
    expect(res._status).toBe(401);
    res = mockRes();
    await orgSkillsHandler(deps)(authed(strangerToken, { scope: "acme" }) as any, res);
    expect(res._status).toBe(403);
    res = mockRes();
    await orgSkillsHandler(deps)(authed(memberToken, { scope: "acme" }) as any, res);
    expect(res._status).toBe(200);
    expect((res._body as { skills: { name: string }[] }).skills.map((s) => s.name)).toEqual(["deploy"]);
  });
});

describe("GET /api/orgs/skill-body", () => {
  it("member gets the markdown; boundary violations 404; non-member 403", async () => {
    const { deps, memberToken, strangerToken } = await setup();
    const q = { scope: "acme", source: "org:acme/skills", path: "eng/deploy/SKILL.md" };
    let res = mockRes();
    await orgSkillBodyHandler(deps)(authed(memberToken, q) as any, res);
    expect(res._status).toBe(200);
    expect(res._body).toBe("# deploy body");
    res = mockRes();
    await orgSkillBodyHandler(deps)(authed(strangerToken, q) as any, res);
    expect(res._status).toBe(403);
    res = mockRes(); // unknown (source,path) for this org → 404, no GitHub fetch
    await orgSkillBodyHandler(deps)(authed(memberToken, { ...q, path: "eng/other/SKILL.md" }) as any, res);
    expect(res._status).toBe(404);
    res = mockRes(); // traversal-shaped path → 400
    await orgSkillBodyHandler(deps)(authed(memberToken, { ...q, path: "../../etc/passwd" }) as any, res);
    expect(res._status).toBe(400);
  });

  it("503 when the App tokens are unconfigured", async () => {
    const { deps, memberToken } = await setup();
    const res = mockRes();
    await orgSkillBodyHandler({ ...deps, tokens: null })(authed(memberToken, { scope: "acme", source: "org:acme/skills", path: "eng/deploy/SKILL.md" }) as any, res);
    expect(res._status).toBe(503);
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
pnpm exec tsc -b 2>&1 | head -5
```
Expected: FAIL — `../orgsApi.js` doesn't exist.

- [ ] **Step 3: Implement** — create `src/githubApp/orgsApi.ts`:

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/githubApp/orgsApi.ts
// Member-gated org endpoints (raw express, the src/usage/install.ts pattern: Bearer ≡ session
// cookie, credentialed CORS for AGENTGEM_WEB_ORIGINS, originGuard-exempt via the /api/orgs prefix):
//   GET /api/orgs/app        — install + viewer-membership status (drives the marketplace UI).
//   GET /api/orgs/skills     — the org's private skill metadata (403 non-member).
//   GET /api/orgs/skill-body — on-demand body proxy via installation token. Bodies are never
//                              stored server-side (metadata-only custody); orgSkillExists pins
//                              (source,path) to THIS org before anything is fetched.
import type { AppDb } from "@agentgem/aggregator";
import { resolveSession, resolveOrgAccess, installationForScope, listOrgSkills, orgSkillExists } from "@agentgem/aggregator";
import { ghContents, decodeFile, assertSkillsPath, type Http, type GithubCfg } from "@agentgem/distribute";
import { SESSION_COOKIE, parseCookies } from "../auth/cookie.js";
import { defaultScopeTtlMs } from "../usage/install.js";
import type { InstallationTokens } from "./client.js";

export interface OrgsApiDeps { db: AppDb; webOrigins: string[]; tokens: InstallationTokens | null; http: Http; scopeTtlMs?: number }

interface Req { method: string; path: string; query: Record<string, unknown>; body: Record<string, unknown>; headers: Record<string, string | undefined>; get(n: string): string | undefined }
interface Res { status(c: number): Res; set(k: string, v: string): Res; setHeader(k: string, v: string): Res; type(t: string): Res; json(b: unknown): Res; send(b: unknown): Res }
type ExpressApp = { get(p: string, h: (req: Req, res: Res) => unknown): unknown; options(p: string, h: (req: Req, res: Res) => unknown): unknown };

function cors(req: Req, res: Res, origins: string[]): void {
  const origin = req.headers["origin"];
  if (origin && origins.includes(origin)) {
    res.set("Access-Control-Allow-Origin", origin);
    res.set("Access-Control-Allow-Credentials", "true");
    res.set("Vary", "Origin");
  }
}
function preflight(res: Res): void {
  res.set("Access-Control-Allow-Methods", "GET, OPTIONS").set("Access-Control-Allow-Headers", "content-type, authorization").status(204).send("");
}
async function whoami(deps: OrgsApiDeps, req: Req): Promise<{ accountId: string; login: string } | null> {
  const auth = req.headers["authorization"];
  const bearer = auth && /^Bearer\s+/i.test(auth) ? auth.replace(/^Bearer\s+/i, "").trim() : "";
  const token = bearer || parseCookies(req.headers["cookie"])[SESSION_COOKIE];
  const who = token ? await resolveSession(deps.db, token) : null;
  return who ? { accountId: who.accountId, login: who.login } : null;
}
function scopeParam(req: Req): string | null {
  const scope = String((req.query.scope as string | undefined) ?? "").trim();
  return scope.length > 0 && scope.length <= 100 ? scope : null;
}

export function orgAppHandler(deps: OrgsApiDeps) {
  return async (req: Req, res: Res): Promise<void> => {
    cors(req, res, deps.webOrigins);
    if (req.method === "OPTIONS") { preflight(res); return; }
    const scope = scopeParam(req);
    if (!scope) { res.status(400).json({ error: "invalid scope" }); return; }
    const inst = await installationForScope(deps.db, scope);
    const installed = !!inst && !inst.suspended;
    const who = await whoami(deps, req);
    const access = who ? await resolveOrgAccess(deps.db, who, scope, deps.scopeTtlMs ?? defaultScopeTtlMs()) : null;
    const isMember = access?.status === "ok";
    res.json({ installed, isMember, role: isMember ? access.role : null }); // no member-list leakage to outsiders
  };
}

/** Shared 401/403 gate for the two private reads. Returns the caller on success, null after responding. */
async function requireMember(deps: OrgsApiDeps, req: Req, res: Res, scope: string): Promise<{ accountId: string; login: string } | null> {
  const who = await whoami(deps, req);
  if (!who) { res.status(401).json({ error: "sign in required" }); return null; }
  const access = await resolveOrgAccess(deps.db, who, scope, deps.scopeTtlMs ?? defaultScopeTtlMs());
  if (access.status === "stale") { res.status(403).json({ error: "membership check expired — sign in again to refresh", reason: "stale" }); return null; }
  if (access.status !== "ok") { res.status(403).json({ error: "not a member of this org" }); return null; }
  return who;
}

export function orgSkillsHandler(deps: OrgsApiDeps) {
  return async (req: Req, res: Res): Promise<void> => {
    cors(req, res, deps.webOrigins);
    if (req.method === "OPTIONS") { preflight(res); return; }
    const scope = scopeParam(req);
    if (!scope) { res.status(400).json({ error: "invalid scope" }); return; }
    if (!(await requireMember(deps, req, res, scope))) return;
    res.json({ scope: scope.toLowerCase(), skills: await listOrgSkills(deps.db, scope) });
  };
}

export function orgSkillBodyHandler(deps: OrgsApiDeps) {
  return async (req: Req, res: Res): Promise<void> => {
    cors(req, res, deps.webOrigins);
    if (req.method === "OPTIONS") { preflight(res); return; }
    const scope = scopeParam(req);
    const source = String((req.query.source as string | undefined) ?? "");
    const path = String((req.query.path as string | undefined) ?? "");
    if (!scope || !source.startsWith("org:")) { res.status(400).json({ error: "invalid scope or source" }); return; }
    try { assertSkillsPath(path); } catch { res.status(400).json({ error: "invalid path" }); return; }
    if (!(await requireMember(deps, req, res, scope))) return;
    // The (source, path) row must belong to THIS org — the cross-org read boundary.
    if (!(await orgSkillExists(deps.db, scope, source, path))) { res.status(404).json({ error: "unknown skill" }); return; }
    const inst = await installationForScope(deps.db, scope);
    if (!inst || inst.suspended) { res.status(404).json({ error: "no active installation" }); return; }
    if (!deps.tokens) { res.status(503).json({ error: "github app not configured" }); return; }
    try {
      const token = await deps.tokens.tokenFor(inst.installationId);
      const cfg: GithubCfg = { repo: source.slice("org:".length), ref: "HEAD", token }; // HEAD = default branch
      const node = await ghContents(deps.http, cfg, path);
      if (Array.isArray(node)) { res.status(404).json({ error: "unknown skill" }); return; }
      res.type("text/markdown; charset=utf-8").send(decodeFile(node));
    } catch (e) {
      res.status(502).json({ error: `upstream fetch failed: ${(e as Error).message}` });
    }
  };
}

export function installOrgsApi(expressApp: ExpressApp, deps: OrgsApiDeps): void {
  expressApp.get("/api/orgs/app", orgAppHandler(deps));
  expressApp.get("/api/orgs/skills", orgSkillsHandler(deps));
  expressApp.get("/api/orgs/skill-body", orgSkillBodyHandler(deps));
  expressApp.options("/api/orgs/app", orgAppHandler(deps));
  expressApp.options("/api/orgs/skills", orgSkillsHandler(deps));
  expressApp.options("/api/orgs/skill-body", orgSkillBodyHandler(deps));
}
```

Note: `defaultScopeTtlMs` is already exported from `src/usage/install.ts`.

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm exec tsc -b && pnpm exec vitest run dist/githubApp/__tests__/orgsApi.test.js
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/githubApp/orgsApi.ts src/githubApp/__tests__/orgsApi.test.ts
git commit -m "feat(github-app): member-gated /api/orgs endpoints + skill-body proxy

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 10: Server wiring — raw-body capture, routes, reconcile scheduler, originGuard

**Files:**
- Modify: `src/index.ts` (bodyParser config ~line 94; route installs after the `installUsage` block ~line 176; graceful-shutdown closure ~line 347)
- Modify: `src/originGuard.ts` (~line 59)
- Test: `src/__tests__/originGuard.test.ts` (extend)

**Interfaces:**
- Consumes: `appConfigFromEnv`, `InstallationTokens` (Task 5), `installGithubWebhook` (Task 8), `installOrgsApi` (Task 9), `reconcileAll` + `GithubAppDeps` (Task 7), `defaultHttp` from `@agentgem/distribute`.
- Produces: running-server behavior — no new exports.

- [ ] **Step 1: Write the failing test** — in `src/__tests__/originGuard.test.ts`, add (following the file's existing test style — read it first and copy its req/res helpers):

```ts
  it("exempts the orgs endpoints and the github webhook (cross-site SPA reads + server-to-server POST)", () => {
    for (const path of ["/api/orgs/app", "/api/orgs/skills", "/api/orgs/skill-body"]) {
      const { req, res, next } = mk({ method: "GET", path, headers: { origin: "https://app.agentgem.ai", "sec-fetch-site": "cross-site" } });
      originGuard(req, res, next);
      expect(next.called).toBe(true);
    }
    const { req, res, next } = mk({ method: "POST", path: "/api/github/webhook", headers: { "sec-fetch-site": "cross-site" } });
    originGuard(req, res, next);
    expect(next.called).toBe(true);
  });
```
(`mk` here stands for the file's existing request/response builder — reuse whatever helper the existing tests use; do not invent a parallel one.)

- [ ] **Step 2: Run to verify failure**

```bash
pnpm exec tsc -b && pnpm exec vitest run dist/__tests__/originGuard.test.js
```
Expected: the new test FAILS (guard blocks cross-site `/api/orgs/*`).

- [ ] **Step 3: Implement the guard exemption** — in `src/originGuard.ts` line ~59, extend the prefix list and its comment:

```ts
  // … existing comment … The GitHub App surfaces are covered too: /api/orgs/* is the SPA's
  // member-gated reads (own credentialed CORS + 401/403), and /api/github/webhook is a
  // server-to-server HMAC-verified POST (no browser context at all).
  if (req.path.startsWith("/api/auth/") || req.path.startsWith("/api/stars") || req.path.startsWith("/api/reviews") || req.path.startsWith("/api/usage") || req.path.startsWith("/api/orgs/") || req.path === "/api/github/webhook" || req.path.startsWith("/api/registry/upload-publish")) { next(); return; }
```

- [ ] **Step 4: Wire the server** — in `src/index.ts`:

(a) Imports (top of file, near the other feature imports):

```ts
import { appConfigFromEnv, InstallationTokens } from "./githubApp/client.js";
import { installGithubWebhook } from "./githubApp/webhook.js";
import { installOrgsApi } from "./githubApp/orgsApi.js";
import { reconcileAll, type GithubAppDeps } from "./githubApp/sync.js";
import { defaultHttp } from "@agentgem/distribute";
```

(b) Raw-body capture — replace the bodyParser line (~94):

```ts
  app.configure("servers.RestServer").to({
    port, host: serverHost(),
    bodyParser: { json: { limit: "25mb", verify: (req: { url?: string; rawBody?: Buffer }, _res: unknown, buf: Buffer) => {
      // HMAC needs the exact bytes GitHub signed; only the webhook route pays the buffer copy.
      if (req.url?.startsWith("/api/github/webhook")) req.rawBody = buf;
    } } },
  });
```
(If agentback's `bodyParser.json` option type doesn't declare `verify`, cast the json options object — e.g. `{ limit: "25mb", verify } as Parameters<typeof import("express").json>[0]` or the repo's usual `as never` — the options pass straight through to `express.json`, which supports `verify` natively.)

(c) Routes + scheduler — after the `installUsage` block (~line 176):

```ts
  // GitHub App (enterprise orgs): webhook always mounts when the DB exists (503s until the three
  // GITHUB_APP_* secrets are set — the dormant contract); the /api/orgs reads mount with the same
  // preconditions as usage. Daily reconcile heals missed webhooks; 30s boot kick heals downtime.
  const ghAppCfg = appConfigFromEnv();
  const ghAppTokens = ghAppCfg ? new InstallationTokens(ghAppCfg) : null;
  let ghAppTimers: { interval?: NodeJS.Timeout; kick?: NodeJS.Timeout } = {};
  if (aggDb) {
    const ghAppDeps: GithubAppDeps = { db: aggDb, cfg: ghAppCfg, tokens: ghAppTokens, http: defaultHttp, fetchImpl: fetch };
    installGithubWebhook(server.expressApp as never, ghAppDeps);
    if (webOrigins.length > 0) installOrgsApi(server.expressApp as never, { db: aggDb, webOrigins, tokens: ghAppTokens, http: defaultHttp });
    if (ghAppCfg) {
      const run = () => void reconcileAll(ghAppDeps).catch((e) => console.error(`githubApp: reconcile failed: ${(e as Error).message}`));
      ghAppTimers.kick = setTimeout(run, 30_000);
      ghAppTimers.interval = setInterval(run, 24 * 60 * 60 * 1000);
      ghAppTimers.kick.unref?.(); ghAppTimers.interval.unref?.();
    }
  }
```

(d) Graceful shutdown — in the `installGracefulShutdown` closure (~line 347), clear the timers alongside `sched?.stop()`:

```ts
  installGracefulShutdown({ stop: async () => { sched?.stop(); if (ghAppTimers.kick) clearTimeout(ghAppTimers.kick); if (ghAppTimers.interval) clearInterval(ghAppTimers.interval); await app.stop(); } });
```
(If `ghAppTimers` is scoped inside `createApp` and the shutdown closure lives elsewhere, hoist the timers to whatever scope the closure can reach — follow how `sched` is threaded.)

- [ ] **Step 5: Verify — guard test passes, full suite green, dormant boot**

```bash
pnpm exec tsc -b && pnpm exec vitest run dist/__tests__/originGuard.test.js
pnpm test 2>&1 | tail -5
```
Expected: originGuard PASS; full suite green (same count as the Task 1 baseline + all new tests; observeScan flake caveat applies). Then a dormant-boot smoke check (no GITHUB_APP_* set):

```bash
(node dist/cli.js serve --port 34567 &) && sleep 3 && curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:34567/api/github/webhook -d '{}' -H 'content-type: application/json'; kill %1 2>/dev/null
```
Expected: `503` (dormant contract). If the serve entrypoint differs, use however `src/index.ts` is normally started (check `package.json` scripts / `src/cli.ts` serve command) — the assertion is just: unconfigured server → webhook 503.

- [ ] **Step 6: Commit**

```bash
git add src/index.ts src/originGuard.ts src/__tests__/originGuard.test.ts
git commit -m "feat(github-app): wire webhook + orgs routes, raw-body capture, daily reconcile

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 11: Marketplace — Internal-skills section + install CTA on OrgCatalog

**Files:**
- Modify: `packages/marketplace/src/types.ts`
- Modify: `packages/marketplace/src/api.ts`
- Modify: `packages/marketplace/src/pages/OrgCatalog.tsx`
- Modify: `packages/marketplace/src/styles.css`
- Test: `packages/marketplace/src/pages/OrgCatalog.test.tsx` (extend)

**Interfaces:**
- Consumes: `GET /api/orgs/app` and `GET /api/orgs/skills` (Task 9 response shapes).
- Produces:
  ```ts
  // types.ts
  export interface OrgAppStatus { installed: boolean; isMember: boolean; role: "self" | "admin" | "member" | null }
  export interface OrgSkill { sourceId: string; path: string; division: string; name: string; repo: string; description: string | null }
  // api.ts (inside makeApi's returned object)
  getOrgApp(scope: string): Promise<OrgAppStatus | null>          // null on any !ok
  getOrgSkills(scope: string): Promise<OrgSkill[] | null>         // null on 401/403/error
  ```
- **Gotcha (from Team Pulse):** every existing OrgCatalog page test stubs the `api` object — the new `getOrgApp`/`getOrgSkills` calls mean ALL existing stubs in `OrgCatalog.test.tsx` need the two new methods (default: `getOrgApp: async () => null, getOrgSkills: async () => null`), or the page test crashes.

- [ ] **Step 1: Write the failing tests** — read `packages/marketplace/src/pages/OrgCatalog.test.tsx` first to copy its render/stub helpers exactly, then add:

```tsx
it("shows the install CTA when the App is not installed", async () => {
  // clone the existing stub api, with: getOrgApp: async () => ({ installed: false, isMember: false, role: null }), getOrgSkills: async () => null
  // render <OrgCatalog api={api} scope="acme" /> with the file's helper
  expect(await screen.findByText(/Install the AgentGem GitHub App/)).toBeInTheDocument();
});

it("shows Internal skills to a member; hides them from non-members", async () => {
  // member: getOrgApp → { installed: true, isMember: true, role: "member" },
  //         getOrgSkills → [{ sourceId: "org:acme/skills", path: "eng/deploy/SKILL.md", division: "eng", name: "deploy", repo: "acme/skills", description: "How we deploy" }]
  expect(await screen.findByText("Internal skills")).toBeInTheDocument();
  expect(await screen.findByText("deploy")).toBeInTheDocument();
  // non-member: getOrgApp → { installed: true, isMember: false, role: null }, getOrgSkills → null
  // → queryByText("Internal skills") is null
});
```
(Sketch above — flesh out against the file's actual helpers; that's why reading it first is Step 1's first action. Also add the two default stubs to every pre-existing test in the file.)

- [ ] **Step 2: Run to verify failure**

```bash
pnpm --filter @agentgem/marketplace test 2>&1 | tail -10
```
Expected: new tests FAIL (`getOrgApp is not a function` / missing UI).

- [ ] **Step 3: Implement** —

`types.ts` — append:

```ts
export interface OrgAppStatus { installed: boolean; isMember: boolean; role: "self" | "admin" | "member" | null }
export interface OrgSkill { sourceId: string; path: string; division: string; name: string; repo: string; description: string | null }
```

`api.ts` — inside `makeApi(base)`'s returned object (matching the `getOrgSettings` style with `credentials: "include"`):

```ts
    getOrgApp: async (scope: string): Promise<OrgAppStatus | null> => {
      try {
        const res = await fetch(base + "/api/orgs/app?scope=" + encodeURIComponent(scope), { credentials: "include" });
        return res.ok ? ((await res.json()) as OrgAppStatus) : null;
      } catch { return null; }
    },
    getOrgSkills: async (scope: string): Promise<OrgSkill[] | null> => {
      try {
        const res = await fetch(base + "/api/orgs/skills?scope=" + encodeURIComponent(scope), { credentials: "include" });
        if (!res.ok) return null;
        return ((await res.json()) as { skills: OrgSkill[] }).skills;
      } catch { return null; }
    },
```
(Import the two types from `./types` at the top; follow the file's existing import list.)

`OrgCatalog.tsx` — add state + effect after the existing catalog effect:

```tsx
  const [appStatus, setAppStatus] = useState<OrgAppStatus | null>(null);
  const [internal, setInternal] = useState<OrgSkill[] | null>(null);

  useEffect(() => {
    let alive = true;
    api.getOrgApp(scope).then((s) => {
      if (!alive) return;
      setAppStatus(s);
      if (s?.isMember) api.getOrgSkills(scope).then((sk) => { if (alive) setInternal(sk); });
    });
    return () => { alive = false; };
  }, [api, scope]);
```

And render, between the `</header>` and the gem list (adjusting to the file's exact JSX structure):

```tsx
      {appStatus && !appStatus.installed && (
        <p className="ex-orgcat-appcta">
          <a href="https://github.com/apps/agentgem/installations/new" target="_blank" rel="noreferrer">
            Install the AgentGem GitHub App
          </a>
          {" "}to sync private membership and index internal skills.
        </p>
      )}
      {appStatus?.isMember && internal && internal.length > 0 && (
        <section className="ex-orgcat-internal">
          <h3>Internal skills</h3>
          <ul className="ex-internal-list">
            {internal.map((s) => (
              <li key={s.sourceId + "/" + s.path} className="ex-internal-item">
                <span className="ex-internal-name">{s.name}</span>
                <span className="ex-internal-repo">{s.repo}</span>
                {s.description && <span className="ex-internal-desc">{s.description}</span>}
              </li>
            ))}
          </ul>
        </section>
      )}
```
(Import `OrgAppStatus`, `OrgSkill` from `../types`.)

`styles.css` — append, matching the file's existing `ex-` conventions (copy color/spacing variables from the `ex-orgcat` block):

```css
.ex-orgcat-appcta { margin: 8px 0 0; font-size: 13px; opacity: 0.85; }
.ex-orgcat-internal { margin-top: 16px; }
.ex-internal-list { list-style: none; margin: 8px 0 0; padding: 0; display: grid; gap: 6px; }
.ex-internal-item { display: flex; gap: 10px; align-items: baseline; flex-wrap: wrap; }
.ex-internal-name { font-weight: 600; }
.ex-internal-repo { font-size: 12px; opacity: 0.6; }
.ex-internal-desc { font-size: 13px; opacity: 0.8; flex-basis: 100%; }
```

- [ ] **Step 4: Run marketplace tests AND typecheck** (they're separate here — known gotcha):

```bash
pnpm --filter @agentgem/marketplace test 2>&1 | tail -5
pnpm --filter @agentgem/marketplace exec tsc --noEmit 2>&1 | tail -5
```
Expected: both clean. (CI does not run these — local green is the gate.)

- [ ] **Step 5: Commit**

```bash
git add packages/marketplace/src/types.ts packages/marketplace/src/api.ts packages/marketplace/src/pages/OrgCatalog.tsx packages/marketplace/src/pages/OrgCatalog.test.tsx packages/marketplace/src/styles.css
git commit -m "feat(marketplace): Internal-skills section + GitHub App install CTA on OrgCatalog

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 12: Docs, full verification, final review

**Files:**
- Create: `docs/deploy/github-app.md`
- Modify: `README.md` (one line in the deploy/feature docs list, if such a list exists — match surrounding style)

- [ ] **Step 1: Write the runbook** — create `docs/deploy/github-app.md`:

```markdown
# GitHub App — registration & deploy runbook

The AgentGem GitHub App is the enterprise org integration: authoritative membership sync
(private members included) and members-only indexing of internal SKILL.md repos.
Design: `docs/superpowers/specs/2026-07-05-github-app-design.md`.

## Register the App (once, under the ninemindai org)

github.com → ninemindai org → Settings → Developer settings → GitHub Apps → New GitHub App:

- **Name**: AgentGem (slug `agentgem`; if taken, adjust the install CTA URL in
  `packages/marketplace/src/pages/OrgCatalog.tsx`)
- **Homepage URL**: https://agentgem.ai
- **Webhook URL**: https://api.agentgem.ai/api/github/webhook
- **Webhook secret**: generate (`openssl rand -hex 32`) — this becomes `GITHUB_APP_WEBHOOK_SECRET`
- **Permissions** (nothing else — additions force per-org re-approval):
  - Organization permissions → Members: **Read-only**
  - Repository permissions → Contents: **Read-only** (Metadata: Read-only is automatic)
- **Subscribe to events**: check **Organization** and **Push**. (`Installation` and
  `Installation repositories` events are always delivered to GitHub Apps — no checkbox.)
- **Where can this App be installed?** Any account.
- **Setup URL** (post-install redirect): https://app.agentgem.ai/orgs/:org?installed=1 —
  GitHub doesn't substitute :org; leave Setup URL as https://app.agentgem.ai and rely on the
  marketplace org page. (Optional improvement later: a /api/github/setup redirect handler.)
- After creation: note the **App ID** (`GITHUB_APP_ID`) and generate a **private key** (.pem
  download — its full contents are `GITHUB_APP_PRIVATE_KEY`).

## Deploy secrets (Fly)

```bash
fly secrets set -a agentgem-api \
  GITHUB_APP_ID=<app id> \
  GITHUB_APP_WEBHOOK_SECRET=<webhook secret> \
  GITHUB_APP_PRIVATE_KEY="$(cat agentgem.private-key.pem)"
```

All three unset/partial → the subsystem is dormant: `POST /api/github/webhook` answers 503,
no reconcile loop runs, org gates fall back to captured account_scopes exactly as before.

## How it works (operator view)

- Webhooks are the primary sync (member add/remove lands in seconds). GitHub does NOT
  auto-retry failed deliveries; a daily `reconcileAll` (plus a 30s post-boot kick) re-lists
  installations/members/repos and heals drift.
- Installation tokens are minted on demand (RS256 app JWT → `POST /app/installations/{id}/access_tokens`),
  cached in memory ~55 min, never persisted or logged.
- Uninstall deletes the installation row, synced members, and indexed private skill metadata.
- Private skill BODIES are never stored: `GET /api/orgs/skill-body` proxies from GitHub per
  request, member-gated, `(source, path)` pinned to the org via `orgSkillExists`.

## Local development

- Unit tests are fully offline (fake fetch/Http + pglite).
- To exercise real webhooks locally: `smee.io` channel → set the App's webhook URL to the
  smee proxy → `GITHUB_APP_*` in your shell → smee client forwarding to
  http://localhost:<port>/api/github/webhook. Or skip webhooks and rely on the reconcile path.
```

- [ ] **Step 2: Full verification**

```bash
rm -rf dist tsconfig.tsbuildinfo && pnpm test 2>&1 | tail -5
pnpm --filter @agentgem/marketplace test 2>&1 | tail -3
pnpm --filter @agentgem/marketplace exec tsc --noEmit 2>&1 | tail -3
```
Expected: root suite green (baseline + ~25 new tests), marketplace tests + typecheck green. Re-run any observeScan-family timeout in isolation before investigating.

- [ ] **Step 3: Spec acceptance sweep** — walk `docs/superpowers/specs/2026-07-05-github-app-design.md` acceptance criteria 1–5 against the test evidence: (1) sync.test installation.created + orgsApi member/403 matrix; (2) sync.test member_removed; (3) sync.test installation.deleted cascade; (4) Task 10 dormant boot + untouched pre-existing usage tests; (5) orgSkills.test public-read isolation. Fix anything that doesn't hold before proceeding.

- [ ] **Step 4: Commit**

```bash
git add docs/deploy/github-app.md README.md
git commit -m "docs(github-app): registration + deploy runbook

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

- [ ] **Step 5: Request review** — use superpowers:requesting-code-review before merging; then integration follows the repo's local-merge convention (CLAUDE.md) or a PR given main's current churn (rebase-only repo — never `gh pr update-branch`).

---

## Deferred (explicitly NOT in this plan)

- P3 bot-identity registry publish (follow-up spec).
- `agentgem sources install` CLI extension for private org sources (the endpoints already accept the CLI's session Bearer; the CLI wiring is a fast-follow).
- GitHub Marketplace listing / billing; per-repo settings UI; user-account installs.
- A `/api/github/setup` post-install redirect handler (Setup URL limitation noted in the runbook).
```
