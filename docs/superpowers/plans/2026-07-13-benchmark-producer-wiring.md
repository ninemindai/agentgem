# Benchmark Producer Wiring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Revised after `/plan-eng-review` (2026-07-13).** Key changes vs. the first draft: bulk contribution is **ingredients-only** (no LLM judge, no `facetsForGem`, no per-gem outcome scoping — see spec "Design refinements #2"); scope **sliced into two PRs**; and seven verified defects folded in (see the GSTACK REVIEW REPORT at the bottom).

**Goal:** Populate the hosted benchmark with real producer + ingredient/usage data via a consent-gated background contribution over the user's published gems, and fix the ingest base-URL default. (Per-model *outcomes* keep coming from the existing interactive `sign_and_publish` path.)

**Architecture:** A local-core "contribute" flow (toggle + manual route + cheap warmable) enumerates the producer's published gems (signed `/my-gems` list ∩ local workspaces), scans the corpus once, and posts anonymous ed25519-signed attestations (ingredients only) to the aggregator. Aggregator ingest is extended to default its base URL and refresh a producer's data on resubmit without disturbing the adoption time-series.

**Tech Stack:** TypeScript (ESM, Node ≥24), Zod, `@agentback/openapi` controllers, Drizzle + PGlite (aggregator), Vitest, `@agentgem/insight` (scan), `@agentgem/archive` (`computeLock`/`readGemArchive`), React (`packages/console`).

## Ship plan (two PRs)

- **PR1 — pipeline (Tasks 1-8):** aggregator + insight + core + warmable. The toggle is flipped for validation via the config file or `AGENTGEM_BENCHMARK_CONTRIBUTE=1`. Lands and bakes on its own.
- **PR2 — UI (Task 9):** console Benchmark-tab toggle + "Contribute now" button + `styles.css`. Depends on PR1's routes.

## Global Constraints

- **Attestations are anonymous** (`account: null`, ed25519 pubkey only). Org attribution is derived server-side from `account_bindings`, never the payload. Note: contribution is only possible for **bound** producers (the `/my-gems` list is account-scoped), and a bound producer is server-side de-anonymizable — state this in the consent copy.
- **Consent off by default:** `benchmarkContribute` defaults to `false`; never contribute unless explicitly `true`.
- **Bulk contribution carries NO outcome histogram** — `buildAttestation` is called without `facets`.
- **No module-scoped mutable state** (repo rule): toggle helpers read/write disk each call.
- **PR2 only:** every new `ex-*` className gets a matching `packages/marketplace/src/styles.css` rule in the same change.
- **grep with `grep -a`** — some source files are binary-classified and silently skipped otherwise.
- Aggregator unit tests live in `src/aggregator/__tests__/` and use `makeTestDb()`. Not in CI (`test (24)` gates only root `dist/__tests__`); run locally. Rebuild an upstream package's `dist/` (`pnpm --filter <pkg> build`) before running a task whose test imports across the package boundary.

---

## File Structure

**Aggregator:** `packages/aggregator/src/ingest.ts` (resubmit update-in-place, race-safe, `IngestResult.updated`), `project.ts` (`updateAttestation`, preserves `ingested_at`), `src/aggregator.controller.ts` (signed `POST /my-gems`).
**Insight:** `packages/insight/src/ingestClient.ts` (base default). *(No `facetsForGem`, no `sessionIds` change — dropped.)*
**Core:** `src/benchmark/config.ts`, `src/gem/myGemsClient.ts`, `src/benchmark/contributeCore.ts`, `src/benchmark.proxy.controller.ts` (routes), `src/warm/registry.ts` (cheap warmable).
**Console (PR2):** `packages/console/src/panels/Benchmark/*`, `packages/marketplace/src/styles.css`.

---

## Task 1: Aggregator — refresh on resubmit (preserve `ingested_at`, race-safe)

**Files:** Modify `packages/aggregator/src/project.ts`, `packages/aggregator/src/ingest.ts`; Test `src/aggregator/__tests__/ingest.test.ts`.

**Interfaces produced:** `updateAttestation(db, id, att)` re-projects in place; `IngestResult` accepted variant gains `updated: boolean`.

Fixes folded in: **#4** (do NOT stamp `ingested_at` on update — it's the adoption bucket dimension), **#8** (unique-violation race between the manual route and the warm tick).

- [ ] **Step 1: Failing test** — append to `ingest.test.ts` (reuses the file's `gem`/`signal`/`make`; add a fixed identity so resubmit == same producer):

```ts
const fixedId = loadOrCreateIdentity(mkdtempSync(join(tmpdir(), "agg-fixed-")));
const makeFixed = (digest: string, invocations: number) => signAttestation(
  buildAttestation({ gem, signal: { ...signal, artifacts: [{ ...signal.artifacts[0], invocations, sessionsUsedIn: 2 }] }, gemDigest: digest, salt: "S" }), fixedId, 1);

it("resubmit refreshes usage in place without new rows, count bumps, or ingested_at churn", async () => {
  const db = await makeTestDb();
  const r1 = await ingestAttestation(db, makeFixed("sha256:re", 5));
  expect(r1).toMatchObject({ accepted: true, idempotent: false, updated: false });
  const before = (await db.execute<{ t: string }>(sql`select ingested_at::text as t from attestations`)).rows[0].t;
  const r2 = await ingestAttestation(db, makeFixed("sha256:re", 9));
  expect(r2).toMatchObject({ accepted: true, idempotent: true, updated: true });
  expect((await db.execute<{ c: number }>(sql`select count(*)::int c from attestations`)).rows[0].c).toBe(1);
  expect((await db.execute<{ c: number }>(sql`select attest_count c from producers`)).rows[0].c).toBe(1);
  const after = (await db.execute<{ t: string }>(sql`select ingested_at::text t from attestations`)).rows[0].t;
  expect(after).toBe(before); // #4: ingested_at preserved
  expect((await db.execute<{ c: number }>(sql`select invocations c from usage_edges where invocations = 9`)).rows.length).toBe(1);
});
```

- [ ] **Step 2: Run — FAIL.** `cd packages/aggregator && pnpm build && cd ../.. && pnpm vitest run src/aggregator/__tests__/ingest.test.ts -t "resubmit"`

- [ ] **Step 3: `updateAttestation` in `project.ts`** (add `eq` import; NO `ingestedAt` in the `set`, NO `attest_count` bump):

```ts
import { eq, sql } from "drizzle-orm";

export async function updateAttestation(db: AppDb, id: string, att: UsageAttestation): Promise<{ id: string; publicIngredients: number; privateCount: number }> {
  const { nodes, privateCount } = publicNodes(att);
  await db.transaction(async (tx) => {
    await tx.update(attestations).set({
      gemName: att.gem.name, harnessId: att.source.harness.id, models: att.source.models,
      scanSessions: att.source.scan.sessions, scanSpanDays: att.source.scan.spanDays,
      signalDigest: att.evidence.signalDigest, privateCount, // NOTE: ingested_at intentionally NOT touched (#4)
    }).where(eq(attestations.id, id));
    await tx.delete(usageEdges).where(eq(usageEdges.attestationId, id));
    await tx.delete(modelOutcomes).where(eq(modelOutcomes.attestationId, id));
    for (const n of nodes) {
      await tx.insert(ingredients).values({ id: n.id, kind: n.kind, idKind: n.idKind })
        .onConflictDoUpdate({ target: ingredients.id, set: { lastSeen: sql`now()` } });
      await tx.insert(usageEdges).values({ attestationId: id, ingredientId: n.id, invocations: n.invocations, sessions: n.sessions });
    }
    for (const h of att.source.outcomeHistogram ?? []) {
      await tx.insert(modelOutcomes).values({ attestationId: id, model: h.model, mostly: h.mostly, partially: h.partially, notAchieved: h.not });
    }
  });
  return { id, publicIngredients: nodes.length, privateCount };
}
```

- [ ] **Step 4: Race-safe resubmit branch in `ingest.ts`.** Extend the result type and handle the concurrent-first-insert unique violation on `attestations_gem_digest_producer_key`:

```ts
import { projectAttestation, updateAttestation } from "./project.js";

export type IngestResult =
  | { accepted: true; id: string; publicIngredients: number; privateCount: number; idempotent: boolean; updated: boolean }
  | { accepted: false; rejected: "bad-signature" | "inconsistent" };

async function priorId(db: AppDb, att: UsageAttestation): Promise<string | null> {
  const r = await db.execute<{ id: string }>(sql`select id from attestations where gem_digest = ${att.gem.digest} and producer_pubkey = ${att.producer.publicKey}`);
  return r.rows[0]?.id ?? null;
}
```

Replace the `if (prior.rows.length > 0) { ... }` block through the final `projectAttestation` return with:

```ts
  const existing = await priorId(db, att);
  if (existing) {
    const p = await updateAttestation(db, existing, att);
    return { accepted: true, ...p, idempotent: true, updated: true };
  }
  try {
    const p = await projectAttestation(db, att);
    return { accepted: true, ...p, idempotent: false, updated: false };
  } catch (e) {
    // #8: a concurrent first-insert (manual route vs warm tick) lost the unique race → treat as resubmit.
    if (String((e as { code?: string }).code) === "23505" || /unique|duplicate/i.test(String((e as Error).message))) {
      const id = await priorId(db, att);
      if (id) { const p = await updateAttestation(db, id, att); return { accepted: true, ...p, idempotent: true, updated: true }; }
    }
    throw e;
  }
```

- [ ] **Step 5: Run — PASS** (new + existing ingest tests). `pnpm vitest run src/aggregator/__tests__/ingest.test.ts`

- [ ] **Step 6: Commit** — `git commit -m "feat(aggregator): refresh producer data on resubmit; preserve ingested_at; race-safe insert"`

---

## Task 2: Aggregator — signed `POST /api/aggregator/my-gems`

**Files:** Modify `packages/aggregator/src/catalog.ts` (payload), `packages/aggregator/src/index.ts` (export), `src/aggregator.controller.ts`; Test `src/aggregator/__tests__/controller.test.ts`.

Fixes folded in: **#7** (`CatalogRow.gemKey` not `.key`; `resolveSignedAccount` returns a discriminated union — narrow on `.ok`; test must use `Date.now()` or it fails the 300 s freshness window).

- [ ] **Step 1:** Add to `catalog.ts` next to `gemStatusSigningPayload`:

```ts
export function myGemsSigningPayload(pubkey: string, signedAt: number): string {
  return canonicalJSON({ action: "my-gems", pubkey, signedAt });
}
```
Confirm it's re-exported: `grep -a "catalog" packages/aggregator/src/index.ts`.

- [ ] **Step 2: Failing test** in `controller.test.ts` (reuse the file's bind + publish helpers; **`signedAt: Date.now()`**):

```ts
it("my-gems returns the signed-in producer's owned gems", async () => {
  const db = await makeTestDb();
  // bind pubkey->account and publish a gem "demo" owned by that account (file's existing helpers)…
  const id = loadOrCreateIdentity(mkdtempSync(join(tmpdir(), "mg-")));
  const signedAt = Date.now();                                   // #7: within FRESHNESS_MS
  const signature = /* file's signer */ signDetached(id, myGemsSigningPayload(id.publicKey, signedAt));
  const r = await new AggregatorController(db).myGems({ body: { pubkey: id.publicKey, signedAt, signature } });
  expect(r.gems.map((g) => g.name)).toContain("demo");
});
it("my-gems returns [] for an unbound / bad-signature key", async () => {
  const db = await makeTestDb();
  const id = loadOrCreateIdentity(mkdtempSync(join(tmpdir(), "mg2-")));
  const signedAt = Date.now();
  const r = await new AggregatorController(db).myGems({ body: { pubkey: id.publicKey, signedAt, signature: signDetached(id, myGemsSigningPayload(id.publicKey, signedAt)) } });
  expect(r.gems).toEqual([]);                                    // no account_bindings row → resolveSignedAccount not ok
});
```

- [ ] **Step 3: Run — FAIL.** `pnpm vitest run src/aggregator/__tests__/controller.test.ts -t "my-gems"`

- [ ] **Step 4: Route** in `AggregatorController` (narrow on `.ok`; map `gemKey`):

```ts
import { resolveSignedAccount, listCatalogGemsForOwner, myGemsSigningPayload } from "@agentgem/aggregator";

const MyGemsBody = z.object({ pubkey: z.string(), signedAt: z.number(), signature: z.string() });
const MyGemsResult = z.object({ gems: z.array(z.object({ key: z.string(), version: z.string(), name: z.string() })) });

@post("/my-gems", { body: MyGemsBody, response: MyGemsResult })
async myGems(input: { body: z.infer<typeof MyGemsBody> }): Promise<z.infer<typeof MyGemsResult>> {
  const acct = await resolveSignedAccount(this.db, {
    pubkey: input.body.pubkey,
    payload: myGemsSigningPayload(input.body.pubkey, input.body.signedAt),
    signedAt: input.body.signedAt, signature: input.body.signature,
  });
  if (!acct.ok) return { gems: [] };                              // #7: union — narrow on .ok
  const rows = await listCatalogGemsForOwner(this.db, acct.accountId);
  return { gems: rows.map((g) => ({ key: g.gemKey, version: g.version, name: g.gemKey.split("/").slice(1).join("/") || g.gemKey })) };
}
```
Verify `resolveSignedAccount`'s exact success shape: `grep -a "resolveSignedAccount" packages/aggregator/src/catalog.ts` (it returns `{ ok: true, accountId, login } | { ok: false, rejected }`).

- [ ] **Step 5: Run — PASS.** `pnpm vitest run src/aggregator/__tests__/controller.test.ts`

- [ ] **Step 6: Commit** — `git commit -m "feat(aggregator): signed POST /my-gems lists the producer's owned gems"`

---

## Task 3: Insight — ingest client base default

**Files:** Modify `packages/insight/src/ingestClient.ts`; Test `packages/insight/src/__tests__/ingestClient.test.ts`.

- [ ] **Step 1: Failing test** — default → `https://api.agentgem.ai/api/aggregator/ingest`; `AGENTGEM_AGGREGATOR_URL` → `<base>/api/aggregator/ingest`; `AGENTGEM_INGEST_URL` full-URL override wins; explicit `""` → `{ skipped: true }` and `http` not called. (Delete both env vars in the default case.)

- [ ] **Step 2: Run — FAIL.** `pnpm vitest run packages/insight/src/__tests__/ingestClient.test.ts`

- [ ] **Step 3: Implement** — replace the endpoint line in `postAttestation`:

```ts
const DEFAULT_AGGREGATOR_URL = "https://api.agentgem.ai";
function resolveIngestEndpoint(explicit?: string): string {
  if (explicit !== undefined) return explicit;                    // incl. "" = disabled
  if (process.env.AGENTGEM_INGEST_URL) return process.env.AGENTGEM_INGEST_URL; // full-URL override
  return `${process.env.AGENTGEM_AGGREGATOR_URL || DEFAULT_AGGREGATOR_URL}/api/aggregator/ingest`;
}
```
Use `const endpoint = resolveIngestEndpoint(args.endpoint);` (the existing `if (!endpoint) return { skipped: true };` still covers `""`).

- [ ] **Step 4: Run — PASS.** `cd packages/insight && pnpm build && cd ../.. && pnpm vitest run packages/insight/src/__tests__/ingestClient.test.ts`

- [ ] **Step 5: Commit** — `git commit -m "fix(insight): ingest client defaults to the hosted aggregator"`

---

## Task 4: Core — `benchmarkContribute` toggle

**Files:** Create `src/benchmark/config.ts`; Test `src/benchmark/__tests__/config.test.ts`. Copy `src/dream/config.ts` verbatim, swapping the path to `<base>/.agentgem/benchmark/config.json` and env to `AGENTGEM_BENCHMARK_CONTRIBUTE`.

- [ ] **Step 1: Failing test** — default `false`; `setBenchmarkContribute(true)` persists; corrupt JSON → falls back to `false`. Run against a temp `base`.
- [ ] **Step 2: Run — FAIL.** `pnpm vitest run src/benchmark/__tests__/config.test.ts`
- [ ] **Step 3: Implement** `benchmarkContribute(base?)` / `setBenchmarkContribute(enabled, base?)` reading `cfgPath(base)` fresh each call (mirror `dreamEnabled`/`setDreamEnabled`). Confirm the `agentgemHome` import: `grep -a "agentgemHome" src/dream/config.ts`.
- [ ] **Step 4: Run — PASS.**
- [ ] **Step 5: Commit** — `git commit -m "feat(benchmark): benchmarkContribute consent toggle (off by default)"`

---

## Task 5: Core — signed owned-gems client

**Files:** Create `src/gem/myGemsClient.ts`; Test `src/gem/__tests__/myGemsClient.test.ts`. Mirror `src/gem/gemStatusClient.ts` (same base resolution + `sign` helper).

**Interfaces produced:** `postMyGems({ identity, endpoint?, http?, now? }): Promise<{ key: string; version: string; name: string }[]>`. Degrades to `[]` on non-2xx / throw / malformed body.

- [ ] **Step 1: Failing test** — signed POST to `/api/aggregator/my-gems` returns owned gems; non-2xx → `[]`; thrown http → `[]`.
- [ ] **Step 2: Run — FAIL.** `pnpm vitest run src/gem/__tests__/myGemsClient.test.ts`
- [ ] **Step 3: Implement** — copy `gemStatusClient.ts` structure; swap payload to `myGemsSigningPayload(identity.publicKey, signedAt)`, path to `/api/aggregator/my-gems`, parse `body.gems`. Match the exact `sign` call `gemStatusClient` uses (`grep -a "sign" src/gem/gemStatusClient.ts`) so the aggregator's `verify` accepts it. `signedAt = args.now ?? Date.now()`.
- [ ] **Step 4: Run — PASS.**
- [ ] **Step 5: Commit** — `git commit -m "feat(gem): postMyGems signed owned-gems client"`

---

## Task 6: Core — `contributeCore` (ingredients-only)

**Files:** Create `src/benchmark/contributeCore.ts`; Test `src/benchmark/__tests__/contributeCore.test.ts`.

Fixes folded in: **#3** (`readGemArchive(readWorkspace(name).files)` — `readWorkspace` has **no** `.gem`), **#5** (`computeLock(files).gemDigest` — there is no `gemDigestOf`), **#9** (match owned gem → workspace and confirm identity, don't attest an unrelated same-named workspace). **No judge, no facets** — ingredients-only.

**Interfaces produced:** `contribute(deps?): Promise<{ enabled: boolean; results: { gem: string; status: "ingested" | "updated" | "skipped" | "failed"; reason?: string }[] }>`. All effects injectable.

- [ ] **Step 1: Failing test** (injected deps; no fs/net):

```ts
const deps = () => ({
  enabled: () => true,
  identity: { publicKey: "PK" } as any,
  listOwned: vi.fn(async () => [{ key: "me/demo", version: "1", name: "demo" }, { key: "me/ghost", version: "1", name: "ghost" }]),
  readGem: vi.fn((name: string) => name === "demo" ? { name: "demo", artifacts: [{ type: "skill", name: "qa" }] } as any : null),
  scan: vi.fn(() => ({ artifacts: [{ type: "skill", name: "qa", invocations: 1, sessionsUsedIn: 1 }], sessions: { scanned: 1, firstMs: 0, lastMs: 0, spanDays: 1 }, models: [] }) as any),
  digestOf: vi.fn(() => "sha256:d"),
  build: vi.fn((a: any) => { expect(a.facets).toBeUndefined(); return { gem: { name: a.gem.name } }; }), // ingredients-only: no facets
  sign: vi.fn((a: any) => a),
  post: vi.fn(async () => ({ ingestId: "i1" })),
});
it("no-ops when disabled", async () => { const d = { ...deps(), enabled: () => false }; expect(await contribute(d as any)).toEqual({ enabled: false, results: [] }); expect(d.post).not.toHaveBeenCalled(); });
it("attests owned gems with a matching workspace, skips the rest, never judges", async () => {
  const d = deps(); const r = await contribute(d as any);
  expect(d.post).toHaveBeenCalledTimes(1);
  expect(r.results).toEqual([{ gem: "demo", status: "ingested" }, { gem: "ghost", status: "skipped", reason: "no local workspace" }]);
});
it("isolates a per-gem post failure", async () => { const d = deps(); d.post = vi.fn(async () => { throw new Error("net"); }); expect((await contribute(d as any)).results[0]).toMatchObject({ status: "failed" }); });
```

- [ ] **Step 2: Run — FAIL.** `pnpm vitest run src/benchmark/__tests__/contributeCore.test.ts`

- [ ] **Step 3: Implement.** Real deps wire the concrete impls; scan is done **once** and reused across gems.

```ts
import { homedir } from "node:os"; import { join } from "node:path";
import { readWorkspace } from "@agentgem/base";
import { readGemArchive, computeLock } from "@agentgem/archive";
import { scanWorkflow, buildAttestation, signAttestation, postAttestation, claudeTranscriptsForCwd } from "@agentgem/insight";
import { loadOrCreateIdentity, type Gem } from "@agentgem/model";
import { benchmarkContribute } from "./config.js";
import { postMyGems } from "../gem/myGemsClient.js";

export interface ContributeResult { gem: string; status: "ingested" | "updated" | "skipped" | "failed"; reason?: string }
export interface ContributeDeps {
  enabled: () => boolean;
  identity: ReturnType<typeof loadOrCreateIdentity>;
  listOwned: () => Promise<{ key: string; version: string; name: string }[]>;
  readGem: (name: string) => Gem | null;                 // #3: readGemArchive(readWorkspace(name).files)
  scan: () => ReturnType<typeof scanWorkflow>;
  digestOf: (gem: Gem, files: Record<string, string>) => string; // #5: computeLock(files).gemDigest
  build: typeof buildAttestation;
  sign: (att: ReturnType<typeof buildAttestation>) => ReturnType<typeof buildAttestation>;
  post: (att: ReturnType<typeof buildAttestation>) => Promise<{ ingestId: string } | { skipped: true }>;
}

function defaultDeps(): ContributeDeps {
  const identity = loadOrCreateIdentity();
  const paths = claudeTranscriptsForCwd(join(homedir(), ".claude"), process.cwd());
  return {
    enabled: () => benchmarkContribute(),
    identity,
    listOwned: () => postMyGems({ identity }),
    readGem: (name) => { try { return readGemArchive(readWorkspace(name).files); } catch { return null; } }, // #3
    scan: () => scanWorkflow(paths, buildScanInventory(), { retainSequences: false }),
    digestOf: (_gem, files) => computeLock(files).gemDigest,     // #5
    build: buildAttestation,
    sign: (att) => signAttestation(att, identity, Date.now()),
    post: (att) => postAttestation({ attestation: att }),
  };
}
// buildScanInventory: assemble ScanInventory for the current corpus (reuse the distill helper —
// grep -a "ScanInventory" src/distill/mcpServer.ts). retainSequences:false — we need artifact counts, not judged outcomes.

export async function contribute(deps: ContributeDeps = defaultDeps()): Promise<{ enabled: boolean; results: ContributeResult[] }> {
  if (!deps.enabled()) return { enabled: false, results: [] };
  const owned = await deps.listOwned();
  if (owned.length === 0) return { enabled: true, results: [] };
  const signal = deps.scan();                                    // ONCE, reused
  const results: ContributeResult[] = [];
  for (const o of owned) {
    const detail = readWorkspaceFiles(o.name);                   // { gem, files } | null — see below
    if (!detail || detail.gem.name !== o.name) {                 // #9: confirm identity, not just a same-name workspace
      results.push({ gem: o.name, status: "skipped", reason: "no local workspace" }); continue;
    }
    try {
      const att = deps.sign(deps.build({ gem: detail.gem, signal, gemDigest: deps.digestOf(detail.gem, detail.files), salt: contributionSalt(), account: null })); // NO facets
      const r = await deps.post(att);
      results.push({ gem: o.name, status: "skipped" in r ? "skipped" : "ingested", ...("skipped" in r ? { reason: "ingest disabled" } : {}) });
    } catch (e) { results.push({ gem: o.name, status: "failed", reason: (e as Error).message }); }
  }
  return { enabled: true, results };
}
```

Resolve during impl (each has a `grep -a`): `readWorkspaceFiles(name)` returns `{ gem: readGemArchive(files), files }` from `readWorkspace(name).files` (the test's `readGem` seam stands in for it — adjust the seam to also return `files` for `digestOf`, or fold `digestOf` to take only the gem if a name-based digest is acceptable); `contributionSalt()` — the per-workspace salt the distill `buildAttestationTool` uses (`grep -a "salt" src/distill/mcpServer.ts`). The `#9` identity check compares the rebuilt gem's name to the owned gem's name-part; tighten to digest if the catalog row later carries one.

> `updated` status: `postAttestation` returns only `{ ingestId }`, so the producer can't see the aggregator's `updated` flag — report `ingested` for any accepted post. (Threading `updated` back through the HTTP response is a P3 follow-up.)

- [ ] **Step 4: Run — PASS.** `pnpm vitest run src/benchmark/__tests__/contributeCore.test.ts`
- [ ] **Step 5: Commit** — `git commit -m "feat(benchmark): contributeCore — ingredients-only attestations over published gems"`

---

## Task 7: Core — contribute + setting routes

**Files:** Modify `src/benchmark.proxy.controller.ts`; Test `src/__tests__/benchmarkContribute.route.test.ts`.

**Produces:** `GET/POST /api/benchmark/contribute-setting` (`{ enabled }`), `POST /api/benchmark/contribute` (409 `AgentError` when off, else `{ results }`).

- [ ] **Step 1: Failing test** — `POST /contribute` rejects with `status: 409` when off; setting round-trips (isolate with a temp home / `AGENTGEM_BENCHMARK_CONTRIBUTE`).
- [ ] **Step 2: Run — FAIL.** `pnpm vitest run src/__tests__/benchmarkContribute.route.test.ts`
- [ ] **Step 3: Add routes** (verified `AgentError` shape from `share.proxy.controller.ts:38`: `new AgentError(msg, { status, code, retryable })`):

```ts
import { AgentError } from "@agentgem/model";
import { benchmarkContribute, setBenchmarkContribute } from "./benchmark/config.js";
import { contribute } from "./benchmark/contributeCore.js";

const ContributeSetting = z.object({ enabled: z.boolean() });
const ContributeResponse = z.object({ results: z.array(z.object({ gem: z.string(), status: z.enum(["ingested","updated","skipped","failed"]), reason: z.string().optional() })) });

@get("/contribute-setting", { response: ContributeSetting })
async getContributeSetting() { return { enabled: benchmarkContribute() }; }
@post("/contribute-setting", { body: ContributeSetting, response: ContributeSetting })
async setContributeSetting(input: { body: z.infer<typeof ContributeSetting> }) { setBenchmarkContribute(input.body.enabled); return { enabled: input.body.enabled }; }
@post("/contribute", { response: ContributeResponse })
async contribute() {
  if (!benchmarkContribute()) throw new AgentError("benchmark contribution is disabled", { status: 409, code: "contribute_disabled", retryable: false });
  return { results: (await contribute()).results };
}
```

- [ ] **Step 4: Run — PASS.**
- [ ] **Step 5: Commit** — `git commit -m "feat(benchmark): contribute + consent-setting routes (409 when off)"`

---

## Task 8: Core — `contribute` warmable (cheap, cache-aware)

**Files:** Modify `src/warm/registry.ts`; Test `src/warm/__tests__/contributeWarmable.test.ts`.

Now **cheap** (no LLM judge). Cache-aware via the corpus token so it doesn't re-post unchanged data every tick (mirrors the `usage` warmable's `transcriptToken` short-circuit).

- [ ] **Step 1: Failing test** — the `contribute` warmable returns `"hit"` when the toggle is off (no contribute call).
- [ ] **Step 2: Run — FAIL.** `pnpm vitest run src/warm/__tests__/contributeWarmable.test.ts`
- [ ] **Step 3: Add `"contribute"` to `Warmable.id`** and append the entry (import `benchmarkContribute` + `contribute`; import `allClaudeTranscripts`/`transcriptToken` already in the file):

```ts
  {
    id: "contribute", cost: "cheap", scope: "global",           // ingredients-only ⇒ cheap; naturally off in desktop (AGENTGEM_WARM=off)
    async warm(_root, { dir, force }) {
      if (!benchmarkContribute()) return "hit";
      const token = transcriptToken(allClaudeTranscripts(resolveDirs(dir).claudeDir));
      if (!force && lastContributeToken === token) return "hit"; // ← cache-aware; store token in a warm-local file, NOT module state
      const r = await contribute();
      if (r.results.some((x) => x.status === "ingested" || x.status === "updated")) { writeContributeToken(token); return "warmed"; }
      return "hit";
    },
  },
```

The token store must **not** be module-scoped mutable state (repo rule). Persist it like the dream/benchmark config: a tiny `<home>/.agentgem/benchmark/last-token` file (`readContributeToken`/`writeContributeToken`), read fresh each call. Add `"contribute"` to the `Warmable.id` union in the same file.

- [ ] **Step 4: Run — PASS**, and `pnpm vitest run src/warm/__tests__` (no orchestrator regression from the union change).
- [ ] **Step 5: Commit** — `git commit -m "feat(warm): cheap cache-aware contribute warmable, gated on the toggle"`

**→ Open PR1 here (Tasks 1-8). Validate against a local aggregator before starting PR2.**

---

## Task 9 (PR2): Console — Benchmark tab toggle + "Contribute now"

**Files:** `packages/console/src/panels/Benchmark/*`, `packages/marketplace/src/styles.css`; Test `packages/console/src/panels/Benchmark/*.test.tsx`.

- [ ] **Step 1:** Locate the Benchmark panel (`grep -a "Benchmark" packages/console/src -rl`); read a sibling (Deploy/Publish) for the fetch/button/state + route-helper pattern.
- [ ] **Step 2: Failing jsdom test** — toggle reflects `contribute-setting`; clicking "Contribute now" (enabled only when on) POSTs `/contribute` and renders per-gem `{gem, status}` rows.
- [ ] **Step 3: Run — FAIL.** `pnpm --filter @agentgem/console vitest run src/panels/Benchmark`
- [ ] **Step 4: Implement** the toggle + button + results list. Consent copy states: anonymous ingredient/usage for your published gems, signed by your producer key, **no per-session content, no outcomes**; and that contribution requires a bound account and is server-side attributable. Add matching `styles.css` rules for every `ex-*` class (reuse `--ink`/`--surface`/`--brand`, `--grad-gem`); verify each: `for c in <classes>; do grep -c "$c" packages/marketplace/src/styles.css; done` (>0).
- [ ] **Step 5: Run — PASS.**
- [ ] **Step 6: Real-browser check** — open the Benchmark tab, confirm styled (not raw defaults), toggle on, click Contribute, see rows. Screenshot for the PR.
- [ ] **Step 7: Commit** — `git commit -m "feat(console): Benchmark tab consent toggle + Contribute now"` **→ Open PR2.**

---

## Final verification (PR1)

- [ ] `pnpm build` at root; `pnpm vitest run packages/insight src/aggregator src/benchmark src/gem src/warm`.
- [ ] Manual e2e vs a local aggregator: `AGENTGEM_AGGREGATOR_URL=http://127.0.0.1:<port>`, publish a gem, `AGENTGEM_BENCHMARK_CONTRIBUTE=1`, hit `POST /api/benchmark/contribute`, confirm a row in `attestations` + `usage_edges` (no `model_outcomes` — ingredients-only), and the benchmark read path shows `producers ≥ k` (seed producers or lower `k`).
- [ ] Confirm resubmit does NOT move `ingested_at` (adoption series intact).

## NOT in scope (deferred)

- **Bulk per-model outcomes** — dropped; attribution from a background sweep is unsound and per-workspace provenance isn't stored. Outcomes come from the interactive `sign_and_publish` path. (Revisit only with a forward-only workspace-provenance capture.)
- **Retroactive contribution for already-published gems** built before any provenance exists — n/a for ingredients (works today), out of scope for outcomes.
- **Threading the aggregator `updated` flag back to the producer** (P3).
- **De-dupe of shared-artifact ingredient counts across a producer's gems** in the aggregate `sum()`s (pre-existing modeling property, not introduced here) — flag as a separate aggregator TODO.
- **Org-scoped admin view** — Spec 2.

## What already exists (reused, not rebuilt)

`buildAttestation`/`signAttestation`/`verifyAttestation`, k-anon rollups, `makeTestDb`, `listWorkspaces`/`readWorkspace`+`readGemArchive`, `computeLock`, `resolveSignedAccount`+`listCatalogGemsForOwner`, `gemStatusClient` (template for `myGemsClient`), `dream/config.ts` (template for the toggle), `transcriptToken`/`allClaudeTranscripts` (cache-awareness). The plan leans on all of these.

## Failure modes (new codepaths)

| Codepath | Realistic failure | Test? | Handled? | User sees |
|---|---|---|---|---|
| `contributeCore` per-gem | `postAttestation` network error | ✓ (T6) | ✓ isolated → `failed` | that gem `failed`, batch continues |
| `contributeCore` enumerate | owned gem, no/mismatched local workspace | ✓ (T6) | ✓ `skipped` | `skipped: no local workspace` |
| ingest resubmit | concurrent first-insert race | ⚠ add a concurrency test | ✓ (#8 catch→update) | success (idempotent) |
| `my-gems` | unbound producer key | ✓ (T2) | ✓ `{ gems: [] }` | contributes nothing (see consent copy) |
| warmable | corpus unchanged | ✓ (T8) | ✓ token short-circuit | no wasted re-post |

No silent-failure critical gaps: every path is either tested + handled or surfaced as a per-gem `failed`/`skipped`.

## Parallelization

| Lane | Tasks | Modules | Depends on |
|---|---|---|---|
| A | T1, T2 | `packages/aggregator/`, `src/aggregator.controller.ts` | — |
| B | T3 | `packages/insight/` | — |
| C | T4, T5 | `src/benchmark/config.ts`, `src/gem/` | — |
| D | T6, T7, T8 | `src/benchmark/`, `src/warm/` | A (my-gems client shape), B (ingest client), C |

**Order:** launch A + B + C in parallel worktrees → merge → D sequential → PR1. Then T9 (PR2) after PR1 lands. No two parallel lanes share a module directory.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Codex Review | `/codex review` | Independent 2nd opinion | 0 | — | — |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | issues_found → all folded | 1 arch, 1 correctness, 12 test gaps, +9 outside-voice defects |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | — |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

Scope: **SLICED** into PR1 (pipeline, T1-8) + PR2 (console UI, T9).

Findings folded into this revision:
- **Architecture (1):** contribute warmable ran an unbounded LLM judge every pass, unguarded under load → **mooted** by the ingredients-only decision (warmable is now cheap + cache-aware).
- **Correctness (1):** `facetsForGem` `mcp_server`/`mcpServer` key mismatch → **removed** (facetsForGem dropped).
- **Foundational (outside voice #2):** per-gem outcome attribution unsound (session outcome ≠ gem effectiveness; shared-artifact double-count; anti-inflation cap defeated) → **bulk contribution is now ingredients-only**; outcomes stay on the interactive path.
- **Compile/run-breakers (outside voice #3, #7):** `readWorkspace().gem` (no such field) → `readGemArchive(...files)`; `CatalogRow.gemKey` not `.key`; `resolveSignedAccount` union narrowing; test `signedAt = Date.now()`.
- **Data regression (#4):** `updateAttestation` preserves `ingested_at` (was collapsing the adoption series).
- **Unspecified work (#5):** `gemDigestOf` → `computeLock(files).gemDigest`.
- **Concurrency (#8):** manual + warm first-insert race → catch unique violation, fall back to update.
- **Enumeration/privacy (#6, #9):** match owned gem→workspace by identity, not bare name; consent copy states contribution requires a bound account and is server-side attributable.

**OUTSIDE VOICE:** Claude subagent (Codex not installed). Verified 3 load-bearing claims against source; all confirmed. Its two disqualifying findings (unsound attribution, `readWorkspace().gem`) drove the ingredients-only pivot and the compile fixes.

**CROSS-MODEL:** the section review under-weighted attribution soundness; the outside voice caught it. Resolved in the user's favor via D5/D6 (ingredients-only).

**VERDICT:** ENG CLEARED (revised) — every finding is folded into the plan or explicitly deferred in "NOT in scope". Ready to implement PR1.

NO UNRESOLVED DECISIONS
