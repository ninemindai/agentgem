# Installable Shared Setups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user share their local setup to app.agentgem.ai so another user can preview its contents and install it zero-config, with consent for executable artifacts.

**Architecture:** app.agentgem.ai stores the gem `{archive bytes, manifest}` directly in the aggregator Postgres (new `gem_archives` table + `catalog_gems.artifacts`). Publishing signs the manifest (ed25519 identity, same as the existing catalog share) and uploads the archive; the browse endpoint returns the artifact list + a true `installable` flag; a public download returns the archive; the console installs by fetching the archive, verifying its lock (`importGem`), gating on consent, and materializing into the Claude target. No GitHub registry, no `AGENTGEM_REGISTRY_REPO`.

**Tech Stack:** TypeScript, drizzle-orm + Postgres/PGlite (`@agentgem/aggregator`), AgentBack `@post`/`@get` controllers (Zod), React (console + marketplace), vitest.

## Global Constraints

- Node floor **>=24**; ESM; imports use `.js` extensions.
- Tests run against compiled `dist/` (vitest `include: dist/**`): `npx tsc -b` before `npx vitest run dist/...`. Aggregator/gem tests live at `src/aggregator/__tests__/` and `src/gem/__tests__/`.
- `ArtifactType = "skill" | "mcp_server" | "instructions" | "hook" | "channel" | "subagent"` (`packages/model/src/types.ts:4`). Executable kinds for consent = `mcp_server`, `hook`.
- `grade` is always sourced from the archive (`gem.grade`), never a request field.
- New DB columns REQUIRE a paired `alter table … add column if not exists` in `ensureSchema` (a `create table` change alone silently skips existing DBs).
- Commit messages end with: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- Git identity: Raymond Feng <raymond@ninemind.ai>.

---

### Task 1: Schema — `gem_archives` table + `catalog_gems.artifacts` + store helpers

**Files:**
- Modify: `packages/aggregator/src/schema.ts` (table def ~216; ensureSchema 256-318)
- Modify: `packages/aggregator/src/catalog.ts` (CatalogRow ~11; upsertCatalogGem ~17; listCatalogGems ~33)
- Test: `src/aggregator/__tests__/gemArchive.test.ts` (new)

**Interfaces:**
- Produces:
  - `gemArchives` drizzle table `(gem_key, version, bytes bytea, size int, digest text, created_at_ms bigint, pk(gem_key,version))`.
  - `CatalogRow.artifacts?: { name: string; type: string }[]`.
  - `upsertGemArchive(db: AppDb, a: { gemKey: string; version: string; bytes: Uint8Array; digest: string; createdAtMs: number }): Promise<void>`
  - `getGemArchive(db: AppDb, gemKey: string, version: string): Promise<{ bytes: Uint8Array; digest: string } | null>`
  - `listCatalogGems(db)` rows gain `installable: boolean` (true when a `gem_archives` row exists).

- [ ] **Step 1: Write the failing test** — `src/aggregator/__tests__/gemArchive.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { makeTestDb, upsertGemArchive, getGemArchive, upsertCatalogGem, listCatalogGems } from "@agentgem/aggregator";

describe("gem archive store", () => {
  it("round-trips archive bytes and marks the catalog row installable", async () => {
    const db = await makeTestDb();
    await upsertCatalogGem(db, { gemKey: "@me/x", version: "1.0.0", publishedBy: "me", createdAtMs: 1, artifacts: [{ name: "brainstorm", type: "skill" }] });
    // no archive yet → not installable
    expect((await listCatalogGems(db))[0]).toMatchObject({ gemKey: "@me/x", installable: false, artifacts: [{ name: "brainstorm", type: "skill" }] });
    await upsertGemArchive(db, { gemKey: "@me/x", version: "1.0.0", bytes: new Uint8Array([1, 2, 3]), digest: "sha256:abc", createdAtMs: 2 });
    const got = await getGemArchive(db, "@me/x", "1.0.0");
    expect(got && Array.from(got.bytes)).toEqual([1, 2, 3]);
    expect((await listCatalogGems(db))[0].installable).toBe(true);
  });
  it("returns null for a missing archive", async () => {
    const db = await makeTestDb();
    expect(await getGemArchive(db, "@me/none", "1.0.0")).toBeNull();
  });
});
```

- [ ] **Step 2: Run it, verify it fails** — `npx tsc -b && npx vitest run dist/aggregator/__tests__/gemArchive.test.js` → FAIL (exports missing).

- [ ] **Step 3: Add the table + column + migrations** in `schema.ts`.

After the `catalogGems` table def add:
```ts
export const gemArchives = pgTable("gem_archives", {
  gemKey: text("gem_key").notNull(),
  version: text("version").notNull(),
  bytes: customType<{ data: Uint8Array; driverData: Buffer }>({ dataType: () => "bytea", toDriver: (v) => Buffer.from(v), fromDriver: (v) => new Uint8Array(v) })("bytes").notNull(),
  size: integer("size").notNull(),
  digest: text("digest").notNull(),
  createdAtMs: bigint("created_at_ms", { mode: "number" }).notNull(),
}, (t) => [primaryKey({ columns: [t.gemKey, t.version] })]);
```
(Import `customType` from `drizzle-orm/pg-core`; add `gemArchives` to the `schema` registry object ~:250.)
Add to `catalogGems`: `artifacts: jsonb("artifacts").$type<{ name: string; type: string }[]>(),`.
In `ensureSchema` (near catalog_gems create ~:308) add:
```ts
await db.execute(sql`alter table catalog_gems add column if not exists artifacts jsonb`);
await db.execute(sql`create table if not exists gem_archives (gem_key text not null, version text not null, bytes bytea not null, size int not null, digest text not null, created_at_ms bigint not null, primary key (gem_key, version))`);
```

- [ ] **Step 4: Add store helpers + extend catalog reads** in `catalog.ts`.

Extend `CatalogRow` with `artifacts?: { name: string; type: string }[]`. In `upsertCatalogGem` include `artifacts: row.artifacts ?? null` in insert + onConflictDoUpdate set. Add:
```ts
export async function upsertGemArchive(db: AppDb, a: { gemKey: string; version: string; bytes: Uint8Array; digest: string; createdAtMs: number }): Promise<void> {
  await db.insert(gemArchives).values({ gemKey: a.gemKey, version: a.version, bytes: a.bytes, size: a.bytes.length, digest: a.digest, createdAtMs: a.createdAtMs })
    .onConflictDoUpdate({ target: [gemArchives.gemKey, gemArchives.version], set: { bytes: a.bytes, size: a.bytes.length, digest: a.digest, createdAtMs: a.createdAtMs } });
}
export async function getGemArchive(db: AppDb, gemKey: string, version: string): Promise<{ bytes: Uint8Array; digest: string } | null> {
  const r = (await db.select({ bytes: gemArchives.bytes, digest: gemArchives.digest }).from(gemArchives)
    .where(and(eq(gemArchives.gemKey, gemKey), eq(gemArchives.version, version))).limit(1))[0];
  return r ? { bytes: r.bytes, digest: r.digest } : null;
}
```
Change `listCatalogGems` to left-join `gem_archives` and add `installable: <archive row present>` to each `CatalogRow` (add `installable: boolean` to the interface). (Use a `leftJoin` on gemKey+version; `installable = row.archiveKey != null`.)

- [ ] **Step 5: Run tests, verify pass** — `npx tsc -b && npx vitest run dist/aggregator/__tests__/gemArchive.test.js` → PASS.

- [ ] **Step 6: Commit** — `git add packages/aggregator/src/schema.ts packages/aggregator/src/catalog.ts src/aggregator/__tests__/gemArchive.test.ts && git commit` (`feat(aggregator): gem_archives store + catalog_gems.artifacts + installable flag`).

---

### Task 2: Publish endpoint — signed manifest + archive → store + installable

**Files:**
- Modify: `packages/aggregator/src/catalog.ts` (`CatalogManifest` ~43; `catalogSigningPayload` ~60; add `recordGemPublish`)
- Modify: `src/aggregator.controller.ts` (`CatalogManifestSchema` ~128; add `@post("/publish-gem")`)
- Test: `src/aggregator/__tests__/publishGem.controller.test.ts` (new)

**Interfaces:**
- Consumes: `upsertGemArchive`, `upsertCatalogGem` (Task 1); `importGem(bytes: Buffer)` from `@agentgem/distribute` (verifies lock, returns `{ gem, meta:{ gemDigest } }`).
- Produces:
  - `CatalogManifest` gains `artifacts?: {name,type}[]` and `gemDigest?: string`.
  - `recordGemPublish(db, req: { manifest: CatalogManifest; archiveBase64: string; pubkey; signedAt; signature }, now?): Promise<ShareResult>` — verifies sig (reuses `catalogSigningPayload`, which serializes the full manifest incl. artifacts+gemDigest), derives `publishedBy` from binding, `importGem` the archive, asserts `meta.gemDigest === manifest.gemDigest`, stores archive + catalog row.
  - `AggregatorController.publishGem` at `POST /api/aggregator/publish-gem`.

- [ ] **Step 1: Write the failing controller test** — `src/aggregator/__tests__/publishGem.controller.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { makeTestDb, producers, accountBindings, catalogSigningPayload, getGemArchive, listCatalogGems } from "@agentgem/aggregator";
import { exportGem } from "@agentgem/distribute";
import { AggregatorController } from "../../aggregator.controller.js";
import { signer, sampleGem } from "./helpers/publishFixtures.js"; // signer(): ed25519; sampleGem(): a Gem with 1 skill + 1 hook

describe("AggregatorController.publishGem", () => {
  it("stores the archive and marks the gem installable for a bound producer", async () => {
    const db = await makeTestDb();
    const s = signer();
    await db.insert(producers).values({ pubkey: s.pubkey });
    await db.insert(accountBindings).values({ pubkey: s.pubkey, provider: "github", accountId: "1", accountLogin: "octocat" });
    const { bytes } = exportGem(sampleGem(), { version: "1.0.0" });
    const archiveBase64 = bytes.toString("base64");
    const manifest = { gemKey: "@octocat/setup", version: "1.0.0", artifacts: [{ name: "brainstorm", type: "skill" }, { name: "fmt", type: "hook" }], gemDigest: readDigest(bytes) };
    const signedAt = Date.now();
    const signature = s.sign(catalogSigningPayload(manifest, s.pubkey, signedAt));
    const c = new AggregatorController(db);
    const res = await c.publishGem({ body: { manifest, archiveBase64, pubkey: s.pubkey, signedAt, signature } });
    expect(res).toMatchObject({ shared: true, publishedBy: "octocat" });
    expect(await getGemArchive(db, "@octocat/setup", "1.0.0")).not.toBeNull();
    expect((await listCatalogGems(db))[0]).toMatchObject({ installable: true, artifacts: [{ name: "brainstorm", type: "skill" }, { name: "fmt", type: "hook" }] });
  });
  it("rejects an archive whose digest does not match the signed manifest", async () => { /* tamper manifest.gemDigest → expect shared:false or throw */ });
});
```
(`helpers/publishFixtures.ts` provides `signer()` — copy the ed25519 helper from `catalogController.test.ts` — `sampleGem()`, and `readDigest(bytes)` via `importGem(bytes).meta.gemDigest`.)

- [ ] **Step 2: Run, verify fail** — `npx tsc -b && npx vitest run dist/aggregator/__tests__/publishGem.controller.test.js` → FAIL.

- [ ] **Step 3: Extend `CatalogManifest` + add `recordGemPublish`** in `catalog.ts`.

Add `artifacts?: { name: string; type: string }[]` and `gemDigest?: string` to `CatalogManifest`. `catalogSigningPayload` already stringifies the whole manifest (verify it uses `JSON.stringify(manifest)` — the new fields are covered automatically; if it enumerates fields, add the two). Add:
```ts
export async function recordGemPublish(db: AppDb, req: { manifest: CatalogManifest; archiveBase64: string; pubkey: string; signedAt: number; signature: string }, now = Date.now()): Promise<ShareResult> {
  const base = await recordCatalogShare(db, { manifest: req.manifest, pubkey: req.pubkey, signedAt: req.signedAt, signature: req.signature }, now);
  if (!base.shared) return base;
  const bytes = Buffer.from(req.archiveBase64, "base64");
  const { meta } = importGem(bytes); // throws on bad lock
  if (req.manifest.gemDigest && req.manifest.gemDigest !== meta.gemDigest) return { shared: false, rejected: "bad-signature" };
  await upsertGemArchive(db, { gemKey: base.gemKey, version: base.version, bytes: new Uint8Array(bytes), digest: meta.gemDigest, createdAtMs: now });
  return base;
}
```
(`recordCatalogShare` already upserts the catalog row incl. `artifacts` once Task 1 threads them through `CatalogManifest` → `CatalogRow`. Ensure `recordCatalogShare` copies `manifest.artifacts` into the `upsertCatalogGem` row.)

- [ ] **Step 4: Add the controller method** in `aggregator.controller.ts`.

Extend `CatalogManifestSchema` with `artifacts: z.array(z.object({ name: z.string(), type: z.string() })).optional()` and `gemDigest: z.string().optional()`. Add:
```ts
const PublishGemBody = z.object({ manifest: CatalogManifestSchema, archiveBase64: z.string(), pubkey: z.string(), signedAt: z.number(), signature: z.string() });
// in class:
@post("/publish-gem", { body: PublishGemBody, response: CatalogResult })
async publishGem(input: { body: z.infer<typeof PublishGemBody> }): Promise<z.infer<typeof CatalogResult>> {
  const r = await recordGemPublish(this.db, input.body);
  return r.shared ? { shared: true, publishedBy: r.publishedBy, gemKey: r.gemKey, version: r.version } : { shared: false, rejected: r.rejected };
}
```

- [ ] **Step 5: Run, verify pass.** `npx tsc -b && npx vitest run dist/aggregator/__tests__/publishGem.controller.test.js` → PASS.

- [ ] **Step 6: Commit** — `feat(aggregator): POST /publish-gem stores signed archive + installable catalog row`.

---

### Task 3: Public archive download endpoint

**Files:**
- Modify: `src/aggregator.controller.ts` (add `@get("/gem-archive")`)
- Modify: `src/originGuard.ts` (`PUBLIC_READ_PATHS` ~36)
- Test: `src/aggregator/__tests__/gemArchive.controller.test.ts` (new); `src/__tests__/originGuard.test.ts` (add case)

**Interfaces:**
- Consumes: `getGemArchive` (Task 1).
- Produces: `GET /api/aggregator/gem-archive?key=&version=` → `{ archiveBase64: string }` (public); 404 (`AgentError`) when absent.

- [ ] **Step 1: Failing test** — `gemArchive.controller.test.ts`: seed a gem via `recordGemPublish`, then `new AggregatorController(db).gemArchive({ query: { key, version } })` returns `{ archiveBase64 }` decoding to the same bytes; unknown key throws a 404 `AgentError`.

- [ ] **Step 2: Run, verify fail.**

- [ ] **Step 3: Add controller `@get`.**
```ts
const GemArchiveQuery = z.object({ key: z.string(), version: z.string() });
const GemArchiveResult = z.object({ archiveBase64: z.string() });
@get("/gem-archive", { query: GemArchiveQuery, response: GemArchiveResult })
async gemArchive(input: { query: z.infer<typeof GemArchiveQuery> }): Promise<z.infer<typeof GemArchiveResult>> {
  const a = await getGemArchive(this.db, input.query.key, input.query.version);
  if (!a) throw new AgentError("gem archive not found", { status: 404, code: "gem_archive_not_found", retryable: false });
  return { archiveBase64: Buffer.from(a.bytes).toString("base64") };
}
```

- [ ] **Step 4: Public-read exemption** — add `/api/aggregator/gem-archive` to `PUBLIC_READ_PATHS` in `originGuard.ts`. Add a guard test: cross-site GET to `/api/aggregator/gem-archive` → `nexted`, CORS `*`.

- [ ] **Step 5: Run, verify pass** (both controller + guard tests).

- [ ] **Step 6: Commit** — `feat(aggregator): public GET /gem-archive download`.

---

### Task 4: Browse — surface `artifacts` + true `installable`

**Files:**
- Modify: `src/gem/publicCatalog.ts` (`mapDbToGems` ~42)
- Modify: `src/schemas.ts` (`RegistryGemSchema` ~804)
- Modify: `packages/marketplace/src/types.ts` (`RegistryGem` ~1); `packages/marketplace/src/gems/catalog.ts` (`toGem` ~110; `Gem` interface ~8)
- Test: `src/gem/__tests__/publicCatalog.test.ts` (add/extend); `packages/marketplace/src/gems/catalog.test.ts` (extend)

**Interfaces:**
- Consumes: `listCatalogGems` rows now carry `installable` + `artifacts` (Task 1).
- Produces: `/api/registry/gems` gem objects include `artifacts?: {name,type}[]` and `installable` reflecting the archive; marketplace `Gem.artifacts`.

- [ ] **Step 1: Failing tests.** publicCatalog: `mapDbToGems` maps a row with `installable:true` + artifacts → `{ installable: true, artifacts }`. marketplace: `loadGems` threads `artifacts` through `toGem`.

- [ ] **Step 2: Run, verify fail.**

- [ ] **Step 3: Implement.** `mapDbToGems`: `installable: row.installable`, `artifacts: row.artifacts`. Add `artifacts` to `RegistryGemSchema` (`z.array(z.object({ name: z.string(), type: z.string() })).optional()`). Add `artifacts?` to marketplace `RegistryGem` + marketplace `Gem`; `toGem` sets `artifacts: r.artifacts ?? []`.

- [ ] **Step 4: Run, verify pass.**

- [ ] **Step 5: Commit** — `feat(catalog): thread gem artifacts + installable into /registry/gems`.

---

### Task 5: Marketplace preview tree

**Files:**
- Create: `packages/marketplace/src/pages/GemContents.tsx` (grouped tree component)
- Modify: `packages/marketplace/src/pages/Gem.tsx` (render `<GemContents artifacts={gem.artifacts} />`)
- Modify: `packages/marketplace/src/styles.css`
- Test: `packages/marketplace/src/pages/GemContents.test.tsx` (new)

**Interfaces:**
- Consumes: `gem.artifacts: {name,type}[]` (Task 4).
- Produces: `<GemContents artifacts>` — groups by kind, counts, expand/collapse, ⚠ on `mcp_server`/`hook`.

- [ ] **Step 1: Failing test** (React Testing Library): renders `Skills (2)`, `MCP servers (1)` group headers; the MCP group has a warning marker; clicking a group header reveals the artifact names.

- [ ] **Step 2: Run, verify fail.**

- [ ] **Step 3: Implement `GemContents.tsx`** — group `artifacts` by `type`, map to labels (skill→Skills, mcp_server→MCP servers, instructions→Instructions, hook→Hooks, subagent→Subagents, channel→Channels), `executes = type ∈ {mcp_server,hook}`, collapsible `<details>` per group with a ⚠ badge on executable groups and a count; list names inside. Render in `Gem.tsx` below the meta, above "Get this gem", only when `gem.artifacts.length > 0`. Add CSS.

- [ ] **Step 4: Run, verify pass.**

- [ ] **Step 5: Commit** — `feat(marketplace): expandable gem contents tree with executable flags`.

---

### Task 6: Console publish — upload the archive

**Files:**
- Modify: `packages/console/src/api/routes.ts` (add `publishGemRoute`)
- Modify: `src/gem.controller.ts` (add `@post("/publish-setup")` that builds archive + calls `recordGemPublish` via `postGemPublish` client, OR calls the aggregator in-process)
- Create: `src/gem/gemPublishClient.ts` (`postGemPublish` — signs + POSTs to `/api/aggregator/publish-gem`, mirroring `catalogShareClient.ts`)
- Modify: `packages/console/src/panels/Curate/PublishToExplore.tsx` (call the new route)
- Test: `src/gem/__tests__/gemPublishClient.test.ts` (new); reuse `playbookPublish`-style test

**Interfaces:**
- Consumes: `readWorkspace(name).files` → `readGemArchive` → `Gem`; `exportGem(gem, {version})` → `{ bytes }`; `postCatalogShare` pattern.
- Produces:
  - `postGemPublish({ manifest, archiveBase64, identity, endpoint? })` → `{ shared } | { rejected }`.
  - `GemController.publishSetup` at `POST /api/gem/publish-setup`, body `{ workspace, scope, name?, version, description?, tags?, provenance }`, response `{ exploreRef, version, shareUrl }` (same shape as playbook publish + a share card).
  - console `publishGemRoute`.

- [ ] **Step 1: Failing test** for `gemPublishClient` (mirror `catalogShareClient.test.ts`): builds the signed body with `pubkey/signedAt/signature` + `archiveBase64`, POSTs to `/api/aggregator/publish-gem`, maps `{shared:false}` → error.

- [ ] **Step 2: Run, verify fail.**

- [ ] **Step 3: Implement `gemPublishClient.ts`** — copy `catalogShareClient.ts`, add `archiveBase64` to the body, include `artifacts` + `gemDigest` in the manifest (compute artifacts from `gem.artifacts.map(a => ({ name: a.name, type: a.type }))`, `gemDigest` from `exportGem`/`readGemMeta`).

- [ ] **Step 4: Add `GemController.publishSetup`** — read workspace archive, `exportGem`, build manifest `{ gemKey, version, description, tags, grade: gem.grade, artifacts, gemDigest }`, `postGemPublish`, then `createShareCard`, return `{ exploreRef, version, shareUrl }`.

- [ ] **Step 5: Wire the console** — add `publishGemRoute` in `routes.ts`; in `PublishToExplore.tsx` call `publishGemRoute` instead of `playbookPublishRoute` (keep the same UI/result handling).

- [ ] **Step 6: Run tests + `tsc -b` for gem/console; verify pass.**

- [ ] **Step 7: Commit** — `feat(console): publish setup uploads the gem archive (installable)`.

---

### Task 7: Console hosted install + consent

**Files:**
- Create: `packages/console/src/panels/GetGems/hostedInstall.ts` (fetch archive + derive consent)
- Modify: `src/gem.controller.ts` (add `@post("/install-hosted")` that fetches from `getGemArchive`/aggregator, `importGem`, materialize Claude, write workspace)
- Modify: `packages/console/src/panels/GetGems/index.tsx` (consent dialog + call)
- Modify: `packages/console/src/api/routes.ts` (`installHostedRoute`)
- Test: `src/gem/__tests__/hostedInstall.test.ts` (new); `packages/console/src/panels/GetGems/GetGems.test.tsx` (consent gating)

**Interfaces:**
- Consumes: aggregator `getGemArchive` (in-process, the API server shares the aggregator DB) or `GET /api/aggregator/gem-archive`; `importGem(bytes)`; `materialize(gem, "claude")`; `createWorkspace`.
- Produces:
  - `executableArtifacts(gem): { mcp: string[]; hooks: string[] }` (for the consent copy).
  - `GemController.installHosted` at `POST /api/gem/install-hosted`, body `{ key, version, consent: true }`, response `{ workspace: string, materialized: string[] }`. Rejects unless `consent === true` when the gem has executable artifacts.

- [ ] **Step 1: Failing test** — `hostedInstall.test.ts`: given a gem with 1 mcp + 1 hook, `executableArtifacts(gem)` returns `{ mcp:["..."], hooks:["..."] }`; `installHosted` without `consent` on such a gem throws `consent_required`; with `consent:true` it creates a workspace and materializes the four kinds.

- [ ] **Step 2: Run, verify fail.**

- [ ] **Step 3: Implement `executableArtifacts` + `installHosted`.** Fetch the archive by key/version (in-process `getGemArchive(this.aggDb, key, version)`), `importGem`, compute `executableArtifacts`; if any and `!consent` → `AgentError("consent required", { status: 409, code: "consent_required" })`; else `createWorkspace(name, gem)` + `materialize(gem, "claude")` written under the workspace.

- [ ] **Step 4: Console consent dialog** — in `GetGems`, an Install action that first fetches the gem's artifacts (from the browse row / a lightweight call), shows "This runs N MCP servers + M hooks. Continue?", and on confirm calls `installHostedRoute` with `consent:true`. Add `installHostedRoute` to `routes.ts`. A test asserts the confirm gate appears for executable gems and the install call carries `consent:true`.

- [ ] **Step 5: Run tests + typecheck; verify pass.**

- [ ] **Step 6: Commit** — `feat(console): zero-config hosted install with executable-artifact consent`.

---

### Task 8: End-to-end integration test

**Files:**
- Test: `src/gem/__tests__/shareReuse.e2e.test.ts` (new)

**Interfaces:** Consumes everything above; no new production code.

- [ ] **Step 1: Write the e2e test** — build a small Gem (1 skill + 1 instructions + 1 mcp + 1 hook), `exportGem`; drive `recordGemPublish(db, signedBody)`; assert `listCatalogGems` shows `installable:true` + artifacts; assert `getGemArchive` returns bytes; `importGem` them; `executableArtifacts` = the mcp+hook; `materialize(gem, "claude")` produces `.claude/`-shaped files for all four kinds; assert a bad-consent install is refused. All with **no registry configured** (pure `makeTestDb`).

- [ ] **Step 2: Run, verify pass** — `npx tsc -b && npx vitest run dist/gem/__tests__/shareReuse.e2e.test.js`.

- [ ] **Step 3: Full aggregator + gem suites** — `npx vitest run dist/aggregator dist/gem` green.

- [ ] **Step 4: Commit** — `test(gem): e2e share → preview → zero-config install with consent`.

---

## Self-review notes

- **Spec coverage:** Publish→Task 1/2/6; catalog artifacts→Task 1/4; preview UI→Task 5; public download→Task 3; config-free install+consent→Task 7; Claude target→Task 7; tests→each + Task 8. All spec components covered.
- **Deferred/flagged:** archive size cap (add a `413` guard in Task 2 if time — noted as spec open question); raw-stream download (v1 uses base64 JSON); non-Claude targets (out of scope).
- **Type consistency:** `{name,type}` artifact shape identical across catalog row, manifest, RegistryGem, marketplace Gem, GemContents. `recordGemPublish` reuses `recordCatalogShare` + `catalogSigningPayload` (no divergent signing). `installable` is a computed column from the `gem_archives` join, single source of truth.
