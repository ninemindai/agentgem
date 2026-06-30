# Account-Bound Publishing — Attribution (#4a) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stamp a server-verified `publishedBy` (the M2-A session's GitHub login) on the registry discovery block when a publish carries a session; trusted/local + MCP paths unchanged.

**Architecture:** Pure `publishedBy` string threading in `@agentgem/distribute`; a tested `resolvePublishedBy(req, db)` seam (cookie → `resolveSession`); inject the request + AppDb into the existing `GemController` (optional → undefined in tests, so the local path + existing tests are unchanged) and thread `publishedBy` into `publishGem`. `publishedBy` is verified, never caller-supplied.

**Tech Stack:** TypeScript ESM (`.js` relative imports), Zod, `@agentback/{core,rest,drizzle}` DI, `@agentgem/aggregator` (sessions, PGlite test db), vitest. Spec: `docs/superpowers/specs/2026-06-30-publish-attribution-design.md`.

## Global Constraints

- **Base branch:** `feat/publish-attribution`, already cut from `origin/main` (`6ed8514`). Do not re-cut.
- **Git identity:** commits authored `Raymond Feng <raymond@ninemind.ai>`; end every message with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`. Stage explicitly; verify `git show --stat HEAD`.
- **ESM:** relative imports use `.js`; package imports extensionless.
- **Tests run from compiled `dist/`:** `pnpm exec tsc -b` before `pnpm exec vitest run dist/...`. New tests in `src/gem/__tests__/` / `src/registry/__tests__/`.
- **`publishedBy` is SERVER-VERIFIED** — derived from a resolved session, NEVER a request-body field. Do NOT add `publishedBy` to any publish input schema.
- **`distribute` stays pure** — stores the string it's handed.
- **No existing-test churn** — the controller's added injects are `{ optional: true }` with no default value needed (undefined when unbound); `new GemController()` keeps working and the existing `gem.controller.test.js` publish path stays green.
- **Surgical / hot files** (`registry.ts`, `gem.controller.ts`, `publicCatalog.ts`) — additive only.

---

### Task 1: `publishedBy` on the discovery block (`@agentgem/distribute`, pure)

**Files:**
- Modify: `packages/distribute/src/registry.ts` (`RegistryItemDiscovery`, `buildDiscovery`, `publishGem`)
- Test: `src/gem/__tests__/registryPublish.test.ts` (extend)

**Interfaces:**
- Produces: `RegistryItemDiscovery.publishedBy?: string`; `buildDiscovery` opts gains `publishedBy?: string`; `publishGem` args gain `publishedBy?: string` (passed into `buildDiscovery`).

- [ ] **Step 1: Write the failing test**

Append to `src/gem/__tests__/registryPublish.test.ts` (mirror the existing `type`/discovery round-trip test — reuse the file's `publishGem`-args + index-read harness):
```ts
  it("stores publishedBy (verified) on the discovery block when supplied", async () => {
    const res = await publishGem({ /* ...existing harness args... */, publishedBy: "octocat" });
    const disc = /* read the published index entry's discovery, as the sibling test does */;
    expect(disc?.publishedBy).toBe("octocat");
  });
```
*(Match the existing test's exact mechanics — how it builds `publishGem` args + reads the resulting `discovery`. Only add `publishedBy` to the input and assert it on the output. An absent `publishedBy` must add NO key — confirm via the existing no-publishedBy assertion still holding.)*

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm exec tsc -b && pnpm exec vitest run dist/gem/__tests__/registryPublish.test.js`
Expected: FAIL — `publishedBy` not accepted/stored.

- [ ] **Step 3: Implement**

In `packages/distribute/src/registry.ts`:

Add to `RegistryItemDiscovery` (after `type?`, line ~19):
```ts
  publishedBy?: string;   // server-verified GitHub login of the publishing account (distinct from free-form `author`)
```
Extend `buildDiscovery` opts (line ~205) — add `publishedBy?: string` to the inline opts type, and before `return d;`:
```ts
  if (opts.publishedBy) d.publishedBy = opts.publishedBy;
```
Thread through `publishGem` (line ~238): add `publishedBy?: string;` to its args type, and pass `publishedBy: args.publishedBy` into the inner `buildDiscovery(args.gem, args.scope, { ... })` call (alongside `type: args.type`).

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm exec tsc -b && pnpm exec vitest run dist/gem/__tests__/registryPublish.test.js`
Expected: PASS (new + existing).

- [ ] **Step 5: Commit**

```bash
git add packages/distribute/src/registry.ts src/gem/__tests__/registryPublish.test.ts
git commit -m "feat(distribute): store verified publishedBy on the registry discovery block

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: the `resolvePublishedBy` session seam

**Files:**
- Create: `src/registry/publishedBy.ts`
- Test: `src/registry/__tests__/publishedBy.test.ts` (create)

**Interfaces:**
- Consumes: `parseCookies`, `SESSION_COOKIE` (`../auth/cookie.js`); `resolveSession`, `type AppDb` (`@agentgem/aggregator`).
- Produces: `resolvePublishedBy(req: { headers: { cookie?: string } } | undefined, db: AppDb | undefined): Promise<string | undefined>`.

- [ ] **Step 1: Write the failing test**

Create `src/registry/__tests__/publishedBy.test.ts` (mirror `src/aggregator/__tests__/webAuth.test.ts`'s makeTestDb harness):
```ts
// src/registry/__tests__/publishedBy.test.ts
import { describe, it, expect } from "vitest";
import { makeTestDb, upsertAccount, generateSessionToken, createSession } from "@agentgem/aggregator";
import { resolvePublishedBy } from "../publishedBy.js";

const reqWith = (cookie?: string) => ({ headers: cookie === undefined ? {} : { cookie } });

describe("resolvePublishedBy", () => {
  it("returns the session account's login for a valid ag_session cookie", async () => {
    const db = await makeTestDb();
    const acct = await upsertAccount(db, { provider: "github", accountId: "7", login: "neo" });
    const { token } = generateSessionToken();
    await createSession(db, acct.id, token, 60_000);
    expect(await resolvePublishedBy(reqWith(`ag_session=${token}`), db)).toBe("neo");
  });
  it("returns undefined when req or db is missing (the local/trusted path)", async () => {
    const db = await makeTestDb();
    expect(await resolvePublishedBy(undefined, db)).toBeUndefined();
    expect(await resolvePublishedBy(reqWith("ag_session=x"), undefined)).toBeUndefined();
  });
  it("returns undefined for no cookie / no session cookie / unknown token", async () => {
    const db = await makeTestDb();
    expect(await resolvePublishedBy(reqWith(undefined), db)).toBeUndefined();
    expect(await resolvePublishedBy(reqWith("other=1"), db)).toBeUndefined();
    expect(await resolvePublishedBy(reqWith("ag_session=nope"), db)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm exec tsc -b && pnpm exec vitest run dist/registry/__tests__/publishedBy.test.js`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement**

Create `src/registry/publishedBy.ts`:
```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/registry/publishedBy.ts
//
// Resolve the VERIFIED publisher identity for an account-bound publish: the GitHub
// login of the M2-A web session carried on the request, or undefined for the
// local/trusted path (no session — your own machine/server token). The login is
// server-derived (never caller-supplied), so it can't be spoofed like `scope`.
import { parseCookies, SESSION_COOKIE } from "../auth/cookie.js";
import { resolveSession, type AppDb } from "@agentgem/aggregator";

// Structural — the injected Express request only needs to expose its cookie header.
type HasCookies = { headers: { cookie?: string } };

export async function resolvePublishedBy(req: HasCookies | undefined, db: AppDb | undefined): Promise<string | undefined> {
  if (!req || !db) return undefined;                       // local/trusted path — no session
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (!token) return undefined;
  const who = await resolveSession(db, token);
  return who?.login;                                       // verified GitHub login, or undefined
}
```

*Verify before running:* confirm `resolveSession` + `AppDb` are exported from `@agentgem/aggregator` (they are — the barrel re-exports `webAuth.js` + `schema.js`), and `parseCookies`/`SESSION_COOKIE` from `../auth/cookie.js`.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm exec tsc -b && pnpm exec vitest run dist/registry/__tests__/publishedBy.test.js`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add src/registry/publishedBy.ts src/registry/__tests__/publishedBy.test.ts
git commit -m "feat(registry): resolvePublishedBy — verified publisher login from the session

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: wire the request + db into the controller; surface `publishedBy`

**Files:**
- Modify: `src/gem.controller.ts` (constructor injects + `registryPublish` threading)
- Modify: `src/gem/publicCatalog.ts` (`RegistryGem.publishedBy` + `mapIndexToGems`)
- Test: `src/gem/__tests__/registryPublishType.test.ts` (extend — `mapIndexToGems` surfaces `publishedBy`)

**Interfaces:**
- Consumes: `resolvePublishedBy` (Task 2); `publishGem` (now accepts `publishedBy`, Task 1); `inject` (`@agentback/core`), `RestBindings` (`@agentback/rest`), `DrizzleBindings` (`@agentback/drizzle`), `AppDb` (`@agentgem/aggregator`).
- Produces: `GemController` constructor gains optional `req` + `db` injects; `registryPublish` stamps `publishedBy`; `RegistryGem.publishedBy?` + populated by `mapIndexToGems`.

- [ ] **Step 1: Write the failing test**

Append to `src/gem/__tests__/registryPublishType.test.ts` (it already has a `mapIndexToGems` test — mirror it):
```ts
  it("surfaces discovery.publishedBy as RegistryGem.publishedBy", () => {
    const index: RegistryIndex = { formatVersion: 1, items: {
      "@a/x": { latest: "1.0.0", versions: { "1.0.0": { path: "p", gemDigest: "sha256:d", dependencies: [] } },
        discovery: { author: "a", artifactKinds: ["skill"], publishedBy: "octocat" } },
    } };
    expect(mapIndexToGems(index)[0].publishedBy).toBe("octocat");
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm exec tsc -b && pnpm exec vitest run dist/gem/__tests__/registryPublishType.test.js`
Expected: FAIL — `RegistryGem.publishedBy` not present.

- [ ] **Step 3: Implement**

`src/gem/publicCatalog.ts` — add `publishedBy?: string;` to `RegistryGem`, and `publishedBy: item.discovery?.publishedBy,` to the object `mapIndexToGems` builds (after `artifactKinds`/`type`).

`src/gem.controller.ts`:
- Add imports (the controller already imports `service` from `@agentback/core`):
  ```ts
  import { service, inject } from "@agentback/core";
  import { RestBindings } from "@agentback/rest";
  import { DrizzleBindings } from "@agentback/drizzle";
  import type { AppDb } from "@agentgem/aggregator";
  import { resolvePublishedBy } from "./registry/publishedBy.js";
  ```
  (Replace the existing `import { service } from "@agentback/core";` with the combined `service, inject` import. Confirm `RestBindings` is exported by `@agentback/rest` and `DrizzleBindings.CLIENT` by `@agentback/drizzle` — both are; the drizzle dist documents `@inject(DrizzleBindings.CLIENT) private db: AppDb`.)
- Extend the constructor (currently `constructor(@service(GemTypeRegistry, { optional: true }) private gemTypes: GemTypeRegistry = defaultGemTypeRegistry) {}`):
  ```ts
  constructor(
    @service(GemTypeRegistry, { optional: true }) private gemTypes: GemTypeRegistry = defaultGemTypeRegistry,
    @inject(RestBindings.HTTP_REQUEST, { optional: true }) private req?: { headers: { cookie?: string } },
    @inject(DrizzleBindings.CLIENT, { optional: true }) private db?: AppDb,
  ) {}
  ```
- In `registryPublish`, after `const index = await source.getIndex();`:
  ```ts
    const publishedBy = await resolvePublishedBy(this.req, this.db);
  ```
  and add `publishedBy` to the `publishGem({ ... })` call (alongside `type`).

- [ ] **Step 4: Run to verify it passes + no controller regression**

Run: `pnpm exec tsc -b && pnpm exec vitest run dist/gem/__tests__/registryPublishType.test.js dist/__tests__/gem.controller.test.js`
Expected: PASS — the new `publishedBy` test + the existing controller suite (the added optional injects default to undefined under `new GemController()`, so the publish path is unchanged).

- [ ] **Step 5: Commit**

```bash
git add src/gem.controller.ts src/gem/publicCatalog.ts src/gem/__tests__/registryPublishType.test.ts
git commit -m "feat(api): stamp verified publishedBy at publish; surface on RegistryGem

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Final verification (after all tasks)

- `pnpm exec tsc -b` clean.
- Feature tests pass: `pnpm exec vitest run dist/gem/__tests__/registryPublish.test.js dist/registry/__tests__/publishedBy.test.js dist/gem/__tests__/registryPublishType.test.js`.
- Full root suite (`pnpm build` first, then `pnpm test`) — green except the known real-FS scan flakes; confirm `gem.controller.test.js` is unbroken by the added constructor injects.

## The result this delivers

A publish that carries an M2-A session is now stamped with a **server-verified `publishedBy`** (the GitHub login) on the registry, surfaced on `RegistryGem` for a future "published by @x" UI. The local/trusted path and the agent MCP path are unchanged (no session → no stamp). Scope-ownership **enforcement** (the scope model + token strategy) remains deferred to #4b, to land with the publish-from-marketplace UI.
