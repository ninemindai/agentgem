# Benchmark Producer Wiring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the hosted benchmark receive real, k-anonymised outcome data via a consent-gated producer contribution over the user's published gems.

**Architecture:** A local-core "contribute" flow (toggle + manual route + warmable) enumerates the producer's published gems (signed `/my-gems` list ∩ local workspaces), runs one global scan + judge, scopes outcomes per gem by session id, and posts anonymous ed25519-signed attestations to the hosted aggregator. The aggregator ingest is extended to fix its base-URL default and to refresh a producer's outcomes on resubmit.

**Tech Stack:** TypeScript (ESM, Node ≥24), Zod, `@agentback/openapi` controllers, Drizzle + PGlite (aggregator), Vitest, `@agentgem/insight` (scan/judge/attestation), React (`packages/console`).

## Global Constraints

- **Attestations are anonymous:** always build with `account: null`. Org attribution comes only from the separate `account_bindings` table, never the payload.
- **Consent is off by default:** `benchmarkContribute` defaults to `false`; never contribute unless it is explicitly `true`.
- **Only published gems** are attested — enumerated as (signed owned-gems list) ∩ (local workspaces that rebuild the `Gem`).
- **No module-scoped mutable state** (repo rule): the toggle helpers read/write disk on every call; no in-memory cache.
- **Every new `ex-*` className in a `.tsx` gets a matching rule in `packages/marketplace/src/styles.css`** in the same change (console/marketplace has no CSS framework). Reuse `--ink`/`--surface`/`--brand` tokens.
- **grep the codebase with `grep -a`** — some source files are binary-classified and silently skipped otherwise.
- Aggregator unit tests live in `src/aggregator/__tests__/` and use `makeTestDb()` from `@agentgem/aggregator`. They are **not** in CI (`test (24)` only gates root `dist/__tests__`); run them locally.

---

## File Structure

**Aggregator (receiver):**
- `packages/aggregator/src/ingest.ts` — resubmit → update-in-place; `IngestResult.updated`.
- `packages/aggregator/src/project.ts` — new `updateAttestation()`.
- `src/aggregator.controller.ts` — new signed `POST /api/aggregator/my-gems`.

**Insight (producer library):**
- `packages/insight/src/ingestClient.ts` — base-URL default resolution.
- `packages/insight/src/workflowScan.ts` — `ArtifactUsage.sessionIds`.
- `packages/insight/src/facetsForGem.ts` (new) — per-gem facet scoping helper.

**Core (producer):**
- `src/benchmark/config.ts` (new) — `benchmarkContribute()` / `setBenchmarkContribute()`.
- `src/gem/myGemsClient.ts` (new) — signed owned-gems list client.
- `src/benchmark/contributeCore.ts` (new) — enumerate → scan → judge → per-gem scope → build/sign/post.
- `src/benchmark.proxy.controller.ts` — `GET/POST /api/benchmark/contribute-setting` + `POST /api/benchmark/contribute`.
- `src/warm/registry.ts` — `contribute` warmable.

**Console (UI):**
- `packages/console/src/panels/Benchmark/*` — toggle + "Contribute now" button.
- `packages/marketplace/src/styles.css` — matching rules.

---

## Task 1: Aggregator — update outcomes on resubmit

**Files:**
- Modify: `packages/aggregator/src/project.ts`
- Modify: `packages/aggregator/src/ingest.ts`
- Test: `src/aggregator/__tests__/ingest.test.ts`

**Interfaces:**
- Produces: `updateAttestation(db, id, att)` re-projects one attestation in place; `IngestResult` accepted variant gains `updated: boolean`.
- Consumes: existing `makeTestDb`, `buildAttestation`, `signAttestation`, `loadOrCreateIdentity`.

- [ ] **Step 1: Write the failing test** — append to `src/aggregator/__tests__/ingest.test.ts`.

The existing `make(digest)` builds an attestation with a fresh identity each call (different producer key). Add a helper that reuses one identity and takes judged facets, then assert resubmit replaces the outcome histogram while producer/attestation counts stay put.

```ts
import type { SessionFacet } from "@agentgem/insight";

// One fixed identity → same producer key across builds (resubmit == same producer).
const fixedId = loadOrCreateIdentity(mkdtempSync(join(tmpdir(), "agg-fixed-")));
function makeWith(digest: string, facets: SessionFacet[]) {
  // signal must expose the artifact's sessionIds so buildAttestation's caller could scope;
  // here we pass facets directly to exercise the histogram.
  return signAttestation(buildAttestation({ gem, signal, gemDigest: digest, salt: "S", facets }), fixedId, 1);
}
const facet = (sessionId: string, outcome: SessionFacet["outcome"]): SessionFacet =>
  ({ sessionId, task: "t", outcome, friction_detail: "", model: "claude-opus-4-8", origin: "llm" });

describe("ingestAttestation resubmit", () => {
  it("replaces a producer's outcomes on resubmit without adding rows or bumping counts", async () => {
    const db = await makeTestDb();
    const first = makeWith("sha256:resub", [facet("s1", "mostly_achieved")]);
    const r1 = await ingestAttestation(db, first);
    expect(r1).toMatchObject({ accepted: true, idempotent: false, updated: false });

    const second = makeWith("sha256:resub", [facet("s1", "mostly_achieved"), facet("s2", "mostly_achieved"), facet("s3", "mostly_achieved")]);
    const r2 = await ingestAttestation(db, second);
    expect(r2).toMatchObject({ accepted: true, idempotent: true, updated: true });

    // exactly one attestation + one producer, attest_count unchanged
    expect((await db.execute<{ c: number }>(sql`select count(*)::int as c from attestations`)).rows[0].c).toBe(1);
    expect((await db.execute<{ c: number }>(sql`select count(*)::int as c from producers`)).rows[0].c).toBe(1);
    expect((await db.execute<{ c: number }>(sql`select attest_count as c from producers`)).rows[0].c).toBe(1);
    // outcomes reflect the LATEST submission (mostly total = 3, not 1)
    const mostly = (await db.execute<{ c: number }>(sql`select coalesce(sum(mostly),0)::int as c from model_outcomes`)).rows[0].c;
    expect(mostly).toBe(3);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/aggregator && pnpm build && cd ../.. && pnpm vitest run src/aggregator/__tests__/ingest.test.ts -t "resubmit"`
Expected: FAIL — `updated` is `undefined` and `mostly` is `1` (old idempotent path returned early without updating).

- [ ] **Step 3: Add `updateAttestation` to `project.ts`**

Add `eq` to the drizzle import and export the update path (same id, no `attest_count` bump):

```ts
import { eq, sql } from "drizzle-orm";
// ... existing imports ...

/** Re-project an EXISTING attestation in place (same id) from a resubmission.
 *  Refreshes scalar fields and fully replaces this attestation's usage_edges and
 *  model_outcomes. Does NOT touch producers.attest_count — it is the same producer
 *  re-submitting the same gem version, so k-anon distinct-producer math is unchanged. */
export async function updateAttestation(db: AppDb, id: string, att: UsageAttestation): Promise<{ id: string; publicIngredients: number; privateCount: number }> {
  const { nodes, privateCount } = publicNodes(att);
  await db.transaction(async (tx) => {
    await tx.update(attestations).set({
      gemName: att.gem.name, harnessId: att.source.harness.id, models: att.source.models,
      scanSessions: att.source.scan.sessions, scanSpanDays: att.source.scan.spanDays,
      signalDigest: att.evidence.signalDigest, privateCount, ingestedAt: sql`now()`,
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

- [ ] **Step 4: Switch the resubmit branch in `ingest.ts` to update-in-place**

Extend the result type and replace the early-return branch:

```ts
import { projectAttestation, updateAttestation } from "./project.js";

export type IngestResult =
  | { accepted: true; id: string; publicIngredients: number; privateCount: number; idempotent: boolean; updated: boolean }
  | { accepted: false; rejected: "bad-signature" | "inconsistent" };
```

Replace the `if (prior.rows.length > 0) { ... }` block:

```ts
  if (prior.rows.length > 0) {
    const p = await updateAttestation(db, prior.rows[0].id, att);
    return { accepted: true, ...p, idempotent: true, updated: true };
  }
  const p = await projectAttestation(db, att);
  return { accepted: true, ...p, idempotent: false, updated: false };
```

(The existing "idempotent on gem_digest" and "two producers" tests still pass: `toMatchObject` is partial, the attestation count stays 1 on resubmit, and two distinct producers still each insert.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd packages/aggregator && pnpm build && cd ../.. && pnpm vitest run src/aggregator/__tests__/ingest.test.ts`
Expected: PASS (all cases, including the two pre-existing ones).

- [ ] **Step 6: Commit**

```bash
git add packages/aggregator/src/project.ts packages/aggregator/src/ingest.ts src/aggregator/__tests__/ingest.test.ts
git commit -m "feat(aggregator): refresh a producer's outcomes on attestation resubmit"
```

---

## Task 2: Aggregator — signed `POST /api/aggregator/my-gems`

**Files:**
- Modify: `src/aggregator.controller.ts`
- Test: `src/aggregator/__tests__/controller.test.ts`

**Interfaces:**
- Consumes: `resolveSignedAccount(db, {pubkey,payload,signedAt,signature})` (`packages/aggregator/src/catalog.ts:212`), `listCatalogGemsForOwner(db, accountId)` (`catalog.ts:307`), `myGemsSigningPayload` (new, Task defines it inline).
- Produces: route `POST /api/aggregator/my-gems`, body `{ pubkey, signedAt, signature }`, response `{ gems: { key, version, name }[] }`. Mirrors the existing `/gem-status` route exactly.

- [ ] **Step 1: Add a signing payload for the list request** in `packages/aggregator/src/catalog.ts` (next to `gemStatusSigningPayload`).

```ts
/** Signed payload proving producer-key ownership for the owned-gems list. */
export function myGemsSigningPayload(pubkey: string, signedAt: number): string {
  return canonicalJSON({ action: "my-gems", pubkey, signedAt });
}
```

Export it from `packages/aggregator/src/index.ts` if `catalog.ts` exports are re-exported there (they are — verify with `grep -a "catalog" packages/aggregator/src/index.ts`).

- [ ] **Step 2: Write the failing controller test** in `src/aggregator/__tests__/controller.test.ts` (follow the file's existing pattern for building a controller + signed request; reuse its `makeTestDb` + identity helpers).

```ts
it("my-gems returns the signed-in producer's owned gems", async () => {
  const db = await makeTestDb();
  // bind pubkey -> account, publish one gem owned by that account (reuse the file's existing
  // publish/bind helpers), then:
  const id = loadOrCreateIdentity(mkdtempSync(join(tmpdir(), "mg-")));
  const signedAt = 1;
  const signature = signDetached(id, myGemsSigningPayload(id.publicKey, signedAt)); // helper the file already uses
  const ctrl = new AggregatorController(db);
  const r = await ctrl.myGems({ body: { pubkey: id.publicKey, signedAt, signature } });
  expect(r.gems.map((g) => g.name)).toContain("demo");
});
```

- [ ] **Step 3: Run it — expect FAIL** (`ctrl.myGems` undefined).

Run: `pnpm vitest run src/aggregator/__tests__/controller.test.ts -t "my-gems"`
Expected: FAIL.

- [ ] **Step 4: Add the route** to `AggregatorController` in `src/aggregator.controller.ts` (place it beside `/gem-status`).

```ts
import { resolveSignedAccount, listCatalogGemsForOwner, myGemsSigningPayload } from "@agentgem/aggregator";

const MyGemsBody = z.object({ pubkey: z.string(), signedAt: z.number(), signature: z.string() });
const MyGemsResult = z.object({ gems: z.array(z.object({ key: z.string(), version: z.string(), name: z.string() })) });

// inside the class:
@post("/my-gems", { body: MyGemsBody, response: MyGemsResult })
async myGems(input: { body: z.infer<typeof MyGemsBody> }): Promise<z.infer<typeof MyGemsResult>> {
  const acct = await resolveSignedAccount(this.db, {
    pubkey: input.body.pubkey,
    payload: myGemsSigningPayload(input.body.pubkey, input.body.signedAt),
    signedAt: input.body.signedAt, signature: input.body.signature,
  });
  if (!acct?.accountId) return { gems: [] };
  const rows = await listCatalogGemsForOwner(this.db, acct.accountId);
  return { gems: rows.map((g) => ({ key: g.key, version: g.version, name: g.key.split("/").slice(1).join("/") || g.key })) };
}
```

Confirm `resolveSignedAccount`'s exact return shape with `grep -a "export .*resolveSignedAccount" packages/aggregator/src/catalog.ts` and adjust the `acct?.accountId` access to match (it maps pubkey → `account_bindings` → accountId).

- [ ] **Step 5: Run tests — expect PASS.** Also confirm `/gem-status` still passes.

Run: `pnpm vitest run src/aggregator/__tests__/controller.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/aggregator/src/catalog.ts packages/aggregator/src/index.ts src/aggregator.controller.ts src/aggregator/__tests__/controller.test.ts
git commit -m "feat(aggregator): signed POST /my-gems lists the producer's owned gems"
```

---

## Task 3: Insight — ingest client base default

**Files:**
- Modify: `packages/insight/src/ingestClient.ts`
- Test: `packages/insight/src/__tests__/ingestClient.test.ts` (create if absent)

**Interfaces:**
- Produces: `postAttestation` resolves its endpoint `explicit → AGENTGEM_INGEST_URL → AGENTGEM_AGGREGATOR_URL + "/api/aggregator/ingest" → DEFAULT + "/api/aggregator/ingest"`; explicit `""` disables (returns `{ skipped: true }`).

- [ ] **Step 1: Write the failing test.**

```ts
import { describe, it, expect, vi } from "vitest";
import { postAttestation } from "../ingestClient.js";
const att = { signature: "x" } as any;

describe("postAttestation endpoint resolution", () => {
  it("falls back to the aggregator default ingest path when no env is set", async () => {
    delete process.env.AGENTGEM_INGEST_URL; delete process.env.AGENTGEM_AGGREGATOR_URL;
    const http = vi.fn(async () => ({ status: 200, json: async () => ({ ingestId: "i1" }) }));
    await postAttestation({ attestation: att, http });
    expect(http.mock.calls[0][0]).toBe("https://api.agentgem.ai/api/aggregator/ingest");
  });
  it("uses AGENTGEM_AGGREGATOR_URL + ingest path", async () => {
    process.env.AGENTGEM_AGGREGATOR_URL = "http://127.0.0.1:9"; delete process.env.AGENTGEM_INGEST_URL;
    const http = vi.fn(async () => ({ status: 200, json: async () => ({ ingestId: "i1" }) }));
    await postAttestation({ attestation: att, http });
    expect(http.mock.calls[0][0]).toBe("http://127.0.0.1:9/api/aggregator/ingest");
  });
  it("explicit empty endpoint disables", async () => {
    const http = vi.fn();
    expect(await postAttestation({ attestation: att, endpoint: "", http })).toEqual({ skipped: true });
    expect(http).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (`http` called with `""` today, or default resolution missing).

Run: `pnpm vitest run packages/insight/src/__tests__/ingestClient.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement resolution.** Replace the endpoint line in `postAttestation`:

```ts
const DEFAULT_AGGREGATOR_URL = "https://api.agentgem.ai";

function resolveIngestEndpoint(explicit?: string): string {
  if (explicit !== undefined) return explicit;                       // incl. "" = disabled
  if (process.env.AGENTGEM_INGEST_URL) return process.env.AGENTGEM_INGEST_URL; // full URL override
  const base = process.env.AGENTGEM_AGGREGATOR_URL || DEFAULT_AGGREGATOR_URL;
  return `${base}/api/aggregator/ingest`;
}
```

In `postAttestation`, replace `const endpoint = args.endpoint ?? process.env.AGENTGEM_INGEST_URL ?? "";` with `const endpoint = resolveIngestEndpoint(args.endpoint);` (the existing `if (!endpoint) return { skipped: true };` still handles the `""` case).

- [ ] **Step 4: Run — expect PASS.**

Run: `cd packages/insight && pnpm build && cd ../.. && pnpm vitest run packages/insight/src/__tests__/ingestClient.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/insight/src/ingestClient.ts packages/insight/src/__tests__/ingestClient.test.ts
git commit -m "fix(insight): ingest client defaults to the hosted aggregator like every sibling client"
```

---

## Task 4: Insight — per-artifact `sessionIds` + `facetsForGem`

**Files:**
- Modify: `packages/insight/src/workflowScan.ts` (`ArtifactUsage` + its construction)
- Create: `packages/insight/src/facetsForGem.ts`
- Modify: `packages/insight/src/index.ts` (export `facetsForGem`)
- Test: `packages/insight/src/__tests__/facetsForGem.test.ts`

**Interfaces:**
- Produces: `ArtifactUsage.sessionIds: string[]`; `facetsForGem(signal: WorkflowSignal, gem: Gem, facets: SessionFacet[]): SessionFacet[]` — returns only facets whose `sessionId` is in the union of the gem's skill/mcp artifacts' `sessionIds`.
- Consumes: `Gem` (`@agentgem/model`), `SessionFacet` (`./facets.js`), `WorkflowSignal`/`ArtifactUsage` (`./workflowScan.js`).

- [ ] **Step 1: Expose `sessionIds` on `ArtifactUsage`.** In `workflowScan.ts` add the field to the `ArtifactUsage` interface (near `invocations`/`sessionsUsedIn`, ~line 18):

```ts
  sessionsUsedIn: number;     // distinct sessions it fired in
  sessionIds: string[];       // the distinct session ids (superset coordinate for per-gem outcome scoping)
```

Where the `artifacts: ArtifactUsage[]` array is built from the accumulator (~line 582-588, `sessionsUsedIn: e?.acc.sessions.size ?? 0`), add:

```ts
      sessionsUsedIn: e?.acc.sessions.size ?? 0,
      sessionIds: e ? [...e.acc.sessions] : [],
```

(The accumulator already holds `sessions: Set<string>` — line ~228/434 — so this only surfaces existing data.)

- [ ] **Step 2: Write the failing test** `packages/insight/src/__tests__/facetsForGem.test.ts`.

```ts
import { describe, it, expect } from "vitest";
import { facetsForGem } from "../facetsForGem.js";
import type { SessionFacet } from "../facets.js";

const gem = { name: "g", createdFrom: "c", artifacts: [{ type: "skill" as const, name: "qa", source: "s", content: "x" }], checks: [], requiredSecrets: [] };
const signal: any = { artifacts: [
  { type: "skill", name: "qa", invocations: 3, sessionsUsedIn: 2, sessionIds: ["s1", "s2"] },
  { type: "skill", name: "other", invocations: 1, sessionsUsedIn: 1, sessionIds: ["s3"] },
] };
const f = (sessionId: string): SessionFacet => ({ sessionId, task: "t", outcome: "mostly_achieved", friction_detail: "", model: "m", origin: "llm" });

describe("facetsForGem", () => {
  it("keeps only facets for sessions where the gem's artifacts were used", () => {
    const kept = facetsForGem(signal, gem as any, [f("s1"), f("s2"), f("s3")]);
    expect(kept.map((x) => x.sessionId).sort()).toEqual(["s1", "s2"]);
  });
});
```

- [ ] **Step 3: Run — expect FAIL** (module missing).

Run: `pnpm vitest run packages/insight/src/__tests__/facetsForGem.test.ts`
Expected: FAIL.

- [ ] **Step 4: Implement `facetsForGem.ts`.**

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Scope judged outcomes to a single gem: keep only the facets whose session used
// one of the gem's skill/mcp artifacts. Enables per-gem outcome histograms from a
// single global scan+judge (no per-gem cwd needed).
import type { Gem } from "@agentgem/model";
import type { SessionFacet } from "./facets.js";
import type { WorkflowSignal } from "./workflowScan.js";

export function facetsForGem(signal: WorkflowSignal, gem: Gem, facets: SessionFacet[]): SessionFacet[] {
  const names = new Set<string>();
  for (const a of gem.artifacts) if (a.type === "skill" || a.type === "mcpServer") names.add(`${a.type}:${a.name}`);
  const sessions = new Set<string>();
  for (const u of signal.artifacts) {
    const key = `${u.type === "mcp" ? "mcpServer" : u.type}:${u.name}`;
    if (names.has(key)) for (const sid of u.sessionIds) sessions.add(sid);
  }
  return facets.filter((f) => sessions.has(f.sessionId));
}
```

Verify the artifact-`type` vocabulary: `grep -a "type:" packages/insight/src/workflowScan.ts | head` and the gem artifact type names (`grep -a "type ===" packages/insight/src/attestation.ts`). Align the `mcp`/`mcpServer` normalization above with what the scan emits and what `buildAttestation` matches (attestation.ts keys by `${a.type}:${a.name}` on gem artifacts).

- [ ] **Step 5: Export + run — expect PASS.** Add `export * from "./facetsForGem.js";` to `packages/insight/src/index.ts`.

Run: `cd packages/insight && pnpm build && cd ../.. && pnpm vitest run packages/insight/src/__tests__/facetsForGem.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/insight/src/workflowScan.ts packages/insight/src/facetsForGem.ts packages/insight/src/index.ts packages/insight/src/__tests__/facetsForGem.test.ts
git commit -m "feat(insight): per-artifact sessionIds + facetsForGem for per-gem outcome scoping"
```

---

## Task 5: Core — `benchmarkContribute` toggle persistence

**Files:**
- Create: `src/benchmark/config.ts`
- Test: `src/benchmark/__tests__/config.test.ts`

**Interfaces:**
- Produces: `benchmarkContribute(base?): boolean` (default false), `setBenchmarkContribute(enabled: boolean, base?): void`. Reads/writes `<base>/.agentgem/benchmark/config.json`; live (fresh disk read each call). Mirrors `src/dream/config.ts`.

- [ ] **Step 1: Write the failing test.**

```ts
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { benchmarkContribute, setBenchmarkContribute } from "../config.js";

describe("benchmarkContribute toggle", () => {
  it("defaults to false and persists across calls", () => {
    const base = mkdtempSync(join(tmpdir(), "bmk-"));
    expect(benchmarkContribute(base)).toBe(false);
    setBenchmarkContribute(true, base);
    expect(benchmarkContribute(base)).toBe(true);
    setBenchmarkContribute(false, base);
    expect(benchmarkContribute(base)).toBe(false);
  });
});
```

- [ ] **Step 2: Run — expect FAIL.**

Run: `pnpm vitest run src/benchmark/__tests__/config.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `config.ts`** (copy the shape of `src/dream/config.ts` verbatim, changing paths/env).

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { agentgemHome } from "@agentgem/model"; // same source dream/config.ts uses; confirm import

function cfgPath(base: string): string { return join(base, ".agentgem", "benchmark", "config.json"); }

export function benchmarkContribute(base: string = agentgemHome()): boolean {
  try {
    const cfg = JSON.parse(readFileSync(cfgPath(base), "utf8")) as { enabled?: boolean };
    if (typeof cfg.enabled === "boolean") return cfg.enabled;
  } catch { /* fall through to env / default */ }
  const env = process.env.AGENTGEM_BENCHMARK_CONTRIBUTE;
  return env === "1" || env === "true";
}

export function setBenchmarkContribute(enabled: boolean, base: string = agentgemHome()): void {
  try {
    mkdirSync(join(base, ".agentgem", "benchmark"), { recursive: true });
    writeFileSync(cfgPath(base), JSON.stringify({ enabled }));
  } catch { /* best-effort, mirrors setDreamEnabled */ }
}
```

Confirm the `agentgemHome` import path used by `src/dream/config.ts` (`grep -a "agentgemHome" src/dream/config.ts`) and match it exactly.

- [ ] **Step 4: Run — expect PASS.**

Run: `pnpm vitest run src/benchmark/__tests__/config.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/benchmark/config.ts src/benchmark/__tests__/config.test.ts
git commit -m "feat(benchmark): benchmarkContribute consent toggle (off by default), dream-config pattern"
```

---

## Task 6: Core — signed owned-gems client

**Files:**
- Create: `src/gem/myGemsClient.ts`
- Test: `src/gem/__tests__/myGemsClient.test.ts`

**Interfaces:**
- Consumes: `myGemsSigningPayload` (Task 2), `signDetached`/identity signing as used by `src/gem/gemStatusClient.ts`, `resolveBase` pattern from `gemStatusClient.ts`.
- Produces: `postMyGems({ identity, endpoint?, http? }): Promise<{ key: string; version: string; name: string }[]>`. Mirrors `postGemStatus` (`src/gem/gemStatusClient.ts:25`).

- [ ] **Step 1: Write the failing test** (inject `http`, assert it signs + posts to `/api/aggregator/my-gems` and parses `gems`).

```ts
import { describe, it, expect, vi } from "vitest";
import { mkdtempSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";
import { loadOrCreateIdentity } from "@agentgem/model";
import { postMyGems } from "../myGemsClient.js";

describe("postMyGems", () => {
  it("posts a signed request and returns owned gems", async () => {
    const identity = loadOrCreateIdentity(mkdtempSync(join(tmpdir(), "mg-c-")));
    const http = vi.fn(async () => ({ status: 200, json: async () => ({ gems: [{ key: "me/demo", version: "1.0.0", name: "demo" }] }) }));
    const gems = await postMyGems({ identity, endpoint: "http://127.0.0.1:9", http });
    expect(http.mock.calls[0][0]).toBe("http://127.0.0.1:9/api/aggregator/my-gems");
    expect(gems).toEqual([{ key: "me/demo", version: "1.0.0", name: "demo" }]);
  });
});
```

- [ ] **Step 2: Run — expect FAIL.**

Run: `pnpm vitest run src/gem/__tests__/myGemsClient.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `myGemsClient.ts`** — open `src/gem/gemStatusClient.ts` and copy its structure (base resolution, `sign`, POST, error→[] degradation). Swap the payload/path/parse:

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import type { Identity } from "@agentgem/model";
import { sign } from "@agentgem/model";                       // same signer gemStatusClient uses; confirm name
import { myGemsSigningPayload } from "@agentgem/aggregator";
import { DEFAULT_AGGREGATOR_URL } from "./shareClient.js";

export type MyGemsHttp = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ status: number; json(): Promise<unknown> }>;
const defaultHttp: MyGemsHttp = async (url, init) => { const r = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) }); return { status: r.status, json: () => r.json() }; };
function resolveBase(endpoint?: string): string { if (endpoint !== undefined) return endpoint; if (process.env.AGENTGEM_AGGREGATOR_URL) return process.env.AGENTGEM_AGGREGATOR_URL; return DEFAULT_AGGREGATOR_URL; }

export async function postMyGems(args: { identity: Identity; endpoint?: string; http?: MyGemsHttp; now?: number }): Promise<{ key: string; version: string; name: string }[]> {
  const base = resolveBase(args.endpoint); if (!base) return [];
  const signedAt = args.now ?? Date.now();
  const payload = myGemsSigningPayload(args.identity.publicKey, signedAt);
  const signature = sign(args.identity, payload);          // match gemStatusClient's signing call exactly
  const http = args.http ?? defaultHttp;
  try {
    const res = await http(`${base}/api/aggregator/my-gems`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pubkey: args.identity.publicKey, signedAt, signature }) });
    if (res.status < 200 || res.status >= 300) return [];
    const body = (await res.json()) as { gems?: { key: string; version: string; name: string }[] };
    return Array.isArray(body.gems) ? body.gems : [];
  } catch { return []; }
}
```

Match `sign`/signing to what `gemStatusClient.ts` actually calls (`grep -a "sign" src/gem/gemStatusClient.ts`) — reuse the identical helper so the aggregator's `verify` accepts it.

- [ ] **Step 4: Run — expect PASS.**

Run: `pnpm vitest run src/gem/__tests__/myGemsClient.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/gem/myGemsClient.ts src/gem/__tests__/myGemsClient.test.ts
git commit -m "feat(gem): postMyGems signed owned-gems list client"
```

---

## Task 7: Core — `contributeCore`

**Files:**
- Create: `src/benchmark/contributeCore.ts`
- Test: `src/benchmark/__tests__/contributeCore.test.ts`

**Interfaces:**
- Consumes: `benchmarkContribute` (Task 5), `postMyGems` (Task 6), `listWorkspaces`/`readWorkspace` (`@agentgem/base`), `scanWorkflow`/`judgeSessions`/`buildAttestation`/`facetsForGem` (`@agentgem/insight`), `signAttestation` + `postAttestation` (`@agentgem/insight`), `loadOrCreateIdentity`/`claudeTranscriptsForCwd`.
- Produces: `contribute(deps?): Promise<{ enabled: boolean; results: { gem: string; status: "ingested" | "updated" | "skipped" | "failed"; reason?: string }[] }>`. All external effects injectable for tests.

- [ ] **Step 1: Write the failing test** with fully injected deps (no real scan/judge/network).

```ts
import { describe, it, expect, vi } from "vitest";
import { contribute } from "../contributeCore.js";

const deps = () => ({
  enabled: () => true,
  identity: { publicKey: "PK" } as any,
  listOwned: vi.fn(async () => [{ key: "me/demo", version: "1", name: "demo" }, { key: "me/ghost", version: "1", name: "ghost" }]),
  readWorkspaceGem: vi.fn((name: string) => name === "demo" ? { name: "demo", artifacts: [{ type: "skill", name: "qa" }] } as any : null),
  scan: vi.fn(() => ({ artifacts: [{ type: "skill", name: "qa", invocations: 1, sessionsUsedIn: 1, sessionIds: ["s1"] }] }) as any),
  judge: vi.fn(async () => ({ facets: [{ sessionId: "s1", outcome: "mostly_achieved", model: "m", friction_detail: "", origin: "llm", task: "t" }], degraded: false })),
  build: vi.fn((a: any) => ({ built: a.gem.name, facets: a.facets })),
  sign: vi.fn((a: any) => a),
  post: vi.fn(async () => ({ ingestId: "i1" })),
});

describe("contribute", () => {
  it("no-ops when disabled", async () => {
    const d = { ...deps(), enabled: () => false };
    const r = await contribute(d as any);
    expect(r).toEqual({ enabled: false, results: [] });
    expect(d.post).not.toHaveBeenCalled();
  });
  it("attests owned gems that have a local workspace, skips the rest", async () => {
    const d = deps();
    const r = await contribute(d as any);
    expect(d.post).toHaveBeenCalledTimes(1);                        // only "demo"
    expect(r.results).toEqual([
      { gem: "demo", status: "ingested" },
      { gem: "ghost", status: "skipped", reason: "no local workspace" },
    ]);
  });
  it("marks a gem failed when post throws, batch continues", async () => {
    const d = deps(); d.post = vi.fn(async () => { throw new Error("net"); });
    const r = await contribute(d as any);
    expect(r.results.find((x) => x.gem === "demo")).toMatchObject({ status: "failed" });
  });
});
```

- [ ] **Step 2: Run — expect FAIL.**

Run: `pnpm vitest run src/benchmark/__tests__/contributeCore.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `contributeCore.ts`.** Real deps default to the concrete implementations; tests inject fakes. One global scan+judge, per-gem facet scoping.

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { homedir } from "node:os"; import { join } from "node:path";
import { listWorkspaces, readWorkspace } from "@agentgem/base";
import { scanWorkflow, judgeSessions, buildAttestation, signAttestation, postAttestation, facetsForGem, claudeTranscriptsForCwd } from "@agentgem/insight";
import { loadOrCreateIdentity, type Gem } from "@agentgem/model";
import { benchmarkContribute } from "./config.js";
import { postMyGems } from "../gem/myGemsClient.js";

export interface ContributeResult { gem: string; status: "ingested" | "updated" | "skipped" | "failed"; reason?: string }

// All boundary effects are injectable so the core is unit-testable without fs/net/LLM.
export interface ContributeDeps {
  enabled: () => boolean;
  identity: ReturnType<typeof loadOrCreateIdentity>;
  listOwned: () => Promise<{ key: string; version: string; name: string }[]>;
  readWorkspaceGem: (name: string) => Gem | null;
  scan: () => ReturnType<typeof scanWorkflow>;
  judge: (signal: ReturnType<typeof scanWorkflow>) => ReturnType<typeof judgeSessions>;
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
    readWorkspaceGem: (name) => { try { return readWorkspace(name).gem; } catch { return null; } },
    scan: () => scanWorkflow(paths, /* ScanInventory */ buildScanInventory(), { retainSequences: true }),
    judge: (signal) => judgeSessions(signal),
    build: buildAttestation,
    sign: (att) => signAttestation(att, identity, Date.now()),
    post: (att) => postAttestation({ attestation: att }),
  };
}
// buildScanInventory: assemble ScanInventory for the current corpus — reuse the same helper the
// distill MCP path uses (grep -a "ScanInventory" src/distill/mcpServer.ts); wire it in during impl.

export async function contribute(deps: ContributeDeps = defaultDeps()): Promise<{ enabled: boolean; results: ContributeResult[] }> {
  if (!deps.enabled()) return { enabled: false, results: [] };
  const owned = await deps.listOwned();
  if (owned.length === 0) return { enabled: true, results: [] };

  const signal = deps.scan();
  const { facets, degraded } = await deps.judge(signal);
  const results: ContributeResult[] = [];
  for (const o of owned) {
    const gem = deps.readWorkspaceGem(o.name);
    if (!gem) { results.push({ gem: o.name, status: "skipped", reason: "no local workspace" }); continue; }
    try {
      const scoped = degraded ? [] : facetsForGem(signal, gem, facets);   // degraded judge → no outcomes
      const digest = gemDigestOf(gem);                                     // same digest fn buildAttestation/publish use
      const att = deps.sign(deps.build({ gem, signal, gemDigest: digest, salt: contributionSalt(), account: null, facets: scoped }));
      const r = await deps.post(att);
      results.push({ gem: o.name, status: "skipped" in r ? "skipped" : "ingested", ...("skipped" in r ? { reason: "ingest disabled" } : {}) });
    } catch (e) { results.push({ gem: o.name, status: "failed", reason: (e as Error).message }); }
  }
  return { enabled: true, results };
}
```

Resolve two helpers during implementation (both already exist in the publish path — `grep -a`): `gemDigestOf(gem)` = the digest function `buildGem`/publish uses for `gemDigest`; `contributionSalt()` = the per-workspace salt used by the distill `buildAttestationTool` (`grep -a "salt" src/distill/mcpServer.ts`). Keep `readWorkspaceGem` returning the workspace's rebuilt `Gem` (`readWorkspace(name).gem` — confirm the field name with `grep -a "readWorkspace" packages/base/src/workspaces.ts`).

> Note on `updated` status: the post client returns only `{ ingestId }` (it can't see the aggregator's `updated` flag through the current response). Report `ingested` for any accepted post. Surfacing `updated` to the producer is a follow-up (would require threading `updated` through the ingest HTTP response + `postAttestation`); out of scope here.

- [ ] **Step 4: Run — expect PASS.**

Run: `pnpm vitest run src/benchmark/__tests__/contributeCore.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/benchmark/contributeCore.ts src/benchmark/__tests__/contributeCore.test.ts
git commit -m "feat(benchmark): contributeCore — enumerate published gems, scan+judge, per-gem attest"
```

---

## Task 8: Core — contribute routes + consent gate

**Files:**
- Modify: `src/benchmark.proxy.controller.ts`
- Test: `src/__tests__/benchmarkContribute.route.test.ts` (or the controller's existing test location)

**Interfaces:**
- Produces: `GET /api/benchmark/contribute-setting` → `{ enabled }`; `POST /api/benchmark/contribute-setting` body `{ enabled }` → `{ enabled }`; `POST /api/benchmark/contribute` → 409 (`AgentError`) when off, else `{ results }`.
- Consumes: `benchmarkContribute`/`setBenchmarkContribute` (Task 5), `contribute` (Task 7).

- [ ] **Step 1: Write the failing test** — assert 409 when off, and that the setting round-trips. Use a temp home so the toggle file is isolated (pass `base` through, or set `AGENTGEM_BENCHMARK_CONTRIBUTE`).

```ts
it("POST /contribute returns 409 when the toggle is off", async () => {
  const ctrl = new BenchmarkProxyController();
  await expect(ctrl.contribute()).rejects.toMatchObject({ status: 409 });
});
```

- [ ] **Step 2: Run — expect FAIL.**

Run: `pnpm vitest run src/__tests__/benchmarkContribute.route.test.ts`
Expected: FAIL.

- [ ] **Step 3: Add the routes** to `BenchmarkProxyController` in `src/benchmark.proxy.controller.ts`.

```ts
import { AgentError } from "@agentgem/model";                    // same error class other 4xx routes throw
import { benchmarkContribute, setBenchmarkContribute } from "./benchmark/config.js";
import { contribute } from "./benchmark/contributeCore.js";

const ContributeSetting = z.object({ enabled: z.boolean() });
const ContributeResultRow = z.object({ gem: z.string(), status: z.enum(["ingested", "updated", "skipped", "failed"]), reason: z.string().optional() });
const ContributeResponse = z.object({ results: z.array(ContributeResultRow) });

@get("/contribute-setting", { response: ContributeSetting })
async getContributeSetting(): Promise<z.infer<typeof ContributeSetting>> { return { enabled: benchmarkContribute() }; }

@post("/contribute-setting", { body: ContributeSetting, response: ContributeSetting })
async setContributeSetting(input: { body: z.infer<typeof ContributeSetting> }): Promise<z.infer<typeof ContributeSetting>> {
  setBenchmarkContribute(input.body.enabled); return { enabled: input.body.enabled };
}

@post("/contribute", { response: ContributeResponse })
async contribute(): Promise<z.infer<typeof ContributeResponse>> {
  if (!benchmarkContribute()) throw new AgentError("benchmark contribution is disabled", { status: 409, code: "contribute_disabled", retryable: false });
  const r = await contribute();
  return { results: r.results };
}
```

Confirm `AgentError` import + the empty-`@post` body convention against the sibling routes in the same controller.

- [ ] **Step 4: Run — expect PASS.**

Run: `pnpm vitest run src/__tests__/benchmarkContribute.route.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/benchmark.proxy.controller.ts src/__tests__/benchmarkContribute.route.test.ts
git commit -m "feat(benchmark): contribute + consent-setting routes (409 when off)"
```

---

## Task 9: Core — `contribute` warmable

**Files:**
- Modify: `src/warm/registry.ts`
- Test: `src/warm/__tests__/contributeWarmable.test.ts`

**Interfaces:**
- Produces: a `Warmable` with `id: "contribute", cost: "llm", scope: "global"` that returns `"hit"` when the toggle is off and otherwise runs `contribute()`, returning `"warmed"` when any gem was ingested/updated, else `"hit"`.
- Consumes: `benchmarkContribute` (Task 5), `contribute` (Task 7).

- [ ] **Step 1: Write the failing test** (inject a fake `contribute` via a thin seam, or set the toggle file/env). Assert off → "hit" and no `contribute` call.

```ts
import { WARMABLES } from "../registry.js";
it("contribute warmable no-ops when the toggle is off", async () => {
  delete process.env.AGENTGEM_BENCHMARK_CONTRIBUTE;                 // ensure off
  const w = WARMABLES.find((x) => x.id === "contribute")!;
  expect(await w.warm(null, {})).toBe("hit");
});
```

- [ ] **Step 2: Run — expect FAIL** (`id` union has no `"contribute"`, entry absent).

Run: `pnpm vitest run src/warm/__tests__/contributeWarmable.test.ts`
Expected: FAIL.

- [ ] **Step 3: Add `"contribute"` to the `Warmable.id` union and append the entry** in `src/warm/registry.ts`.

```ts
export interface Warmable {
  id: "observe" | "usage" | "scorecard" | "insights" | "analyze" | "distill" | "dream" | "recall" | "contribute";
  // ...unchanged...
}
```

Append to `WARMABLES` (import at top: `import { benchmarkContribute } from "../benchmark/config.js"; import { contribute } from "../benchmark/contributeCore.js";`):

```ts
  {
    // Global LLM warmable: when the producer has opted in, attest published gems.
    // Naturally dormant in desktop client-mode (which forces AGENTGEM_WARM=off) and
    // whenever the consent toggle is off.
    id: "contribute", cost: "llm", scope: "global",
    async warm(_root, _opts) {
      if (!benchmarkContribute()) return "hit";
      const r = await contribute();
      return r.results.some((x) => x.status === "ingested" || x.status === "updated") ? "warmed" : "hit";
    },
  },
```

- [ ] **Step 4: Run — expect PASS.** Also run the warm orchestrator tests to confirm no regression from the union change: `pnpm vitest run src/warm/__tests__`.

Run: `pnpm vitest run src/warm/__tests__/contributeWarmable.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/warm/registry.ts src/warm/__tests__/contributeWarmable.test.ts
git commit -m "feat(warm): contribute warmable, gated on the consent toggle"
```

---

## Task 10: Console — Benchmark tab toggle + "Contribute now"

**Files:**
- Modify/Create: `packages/console/src/panels/Benchmark/` (the Benchmark tab component + its API route helpers)
- Modify: `packages/marketplace/src/styles.css`
- Test: `packages/console/src/panels/Benchmark/*.test.tsx`

**Interfaces:**
- Consumes: `GET/POST /api/benchmark/contribute-setting`, `POST /api/benchmark/contribute` (Task 8), via the console's route-helper pattern (`grep -a "defineRoute" packages/console/src/api/routes.ts`).

- [ ] **Step 1: Locate the Benchmark panel** (`grep -a "Benchmark" packages/console/src -rl`) and read a sibling panel (e.g. Deploy/Publish) for the fetch + button + state pattern.

- [ ] **Step 2: Write the failing test** (jsdom): toggle reflects `contribute-setting`, and clicking "Contribute now" (when on) posts and renders per-gem result rows. Mock fetch like the existing panel tests do.

```tsx
it("shows contribution results after clicking Contribute now", async () => {
  // mock GET contribute-setting -> {enabled:true}, POST contribute -> {results:[{gem:"demo",status:"ingested"}]}
  render(<BenchmarkPanel apiBase="" />);
  fireEvent.click(await screen.findByRole("button", { name: /contribute now/i }));
  expect(await screen.findByText(/demo/)).toBeTruthy();
  expect(await screen.findByText(/ingested/)).toBeTruthy();
});
```

- [ ] **Step 3: Run — expect FAIL.**

Run: `pnpm --filter @agentgem/console vitest run src/panels/Benchmark`
Expected: FAIL.

- [ ] **Step 4: Implement the UI.** Add a consent toggle bound to `contribute-setting` and a "Contribute now" button (disabled when off) that POSTs `/contribute` and lists `results` (`gem` + `status`). Every `ex-*` class used gets a rule in `styles.css`:

```css
/* Benchmark contribution surface — mirror .ex-account-provider / .ex-signin tokens */
.ex-contribute { display: flex; flex-direction: column; gap: .5rem; padding: .75rem; border: 1px solid var(--surface-2); border-radius: 8px; }
.ex-contribute-toggle { display: flex; align-items: center; gap: .5rem; color: var(--ink); }
.ex-contribute-run { background: var(--grad-gem); color: #fff; border: 0; border-radius: 6px; padding: .4rem .8rem; }
.ex-contribute-run:disabled { opacity: .5; }
.ex-contribute-row { display: flex; justify-content: space-between; font-size: .85rem; color: var(--ink-2); }
```

After writing, verify each class is enforced: `for c in ex-contribute ex-contribute-toggle ex-contribute-run ex-contribute-row; do grep -c "$c" packages/marketplace/src/styles.css; done` (each > 0). Match token names to the file's actual tokens (`grep -a -- "--grad-gem\|--surface-2\|--ink-2" packages/marketplace/src/styles.css`); adjust to real ones.

- [ ] **Step 5: Run — expect PASS.**

Run: `pnpm --filter @agentgem/console vitest run src/panels/Benchmark`
Expected: PASS.

- [ ] **Step 6: Verify styled UI in a real browser** (jsdom never asserts appearance). Start the console, open the Benchmark tab, confirm the toggle + button render styled (not raw defaults), toggle on, click "Contribute now", see result rows. Screenshot for the PR.

- [ ] **Step 7: Commit**

```bash
git add packages/console/src/panels/Benchmark packages/marketplace/src/styles.css
git commit -m "feat(console): Benchmark tab consent toggle + Contribute now button"
```

---

## Final verification

- [ ] `pnpm build` at the repo root (all packages compile; the `Warmable.id` union + insight/aggregator exports propagate).
- [ ] `pnpm vitest run packages/insight src/aggregator src/benchmark src/gem src/warm` — new + existing unit tests green.
- [ ] `pnpm --filter @agentgem/console vitest run` — console tests green (not in CI; run locally).
- [ ] Manual end-to-end against a local aggregator: set `AGENTGEM_AGGREGATOR_URL=http://127.0.0.1:<port>`, publish a gem, enable the toggle, click Contribute, confirm a row lands in `attestations` + `model_outcomes` and the Benchmark read path shows `producers ≥ k` (seed extra producers or lower `k` for the check).
- [ ] Open the PR off `feat/benchmark-producer-wiring`; CI gate is `test (24)`.

## Self-review notes (author)

- **Spec coverage:** ingest default (T3), no-attestation-on-publish → separate contribute (T5–T9), published-gems unit (T6/T7), anonymous attestation (T7 `account: null`), update-on-resubmit (T1), per-gem outcomes (T4 + T7), consent gate (T5/T8), warmable (T9), UI (T10). All spec sections map to a task.
- **Known follow-ups (out of scope, noted at their task):** surfacing the aggregator `updated` flag back to the producer (T7 note); a `signalDigest` no-op short-circuit for identical resubmits (deliberately omitted for test simplicity — resubmit always re-projects).
- **Verify-during-impl seams** (each has a `grep -a` next to it): `resolveSignedAccount` return shape (T2), `agentgemHome` import (T5), `sign` helper name (T6), `readWorkspace().gem` field + `gemDigestOf`/`contributionSalt`/`buildScanInventory` (T7), `AgentError` + empty-`@post` convention (T8), console route-helper + real token names (T10).
