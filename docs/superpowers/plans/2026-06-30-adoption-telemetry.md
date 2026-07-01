# Adoption Telemetry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An opt-in, k-anonymized "someone installed this registry gem" signal that raises the Stone rating above the star curve: `stones = min(5, max(floor, starCurve(stars), adoptionCurve(installs)))`.

**Architecture:** A new signed `GemAdoption` event (reusing the ed25519 identity + canonical-JSON signing), a new `gem_adoptions` table keyed `(gem_key, producer_pubkey)` (many installers → one gem, idempotent), a gem-level k-anon aggregate, an opt-in fire-and-forget emit from `registryInstall`, and a marketplace blend.

**Tech Stack:** TS ESM monorepo — `@agentgem/{insight,aggregator,model}` + server (`src/`) + `@agentgem/marketplace`. Server/package tests ALL live in the ROOT suite under `src/**/__tests__/` and run via root `pnpm test` (`tsc -b && vitest run` over `dist/`). Aggregator tests use PGlite via `makeTestDb()`. Marketplace: `pnpm --filter @agentgem/marketplace test|typecheck|build`.

## Global Constraints

- Every source file carries the three-line MIT header used by its neighbors (copy an adjacent file's).
- **The emit is fire-and-forget and default-OFF:** never awaited into the `registryInstall` response; gated on BOTH an explicit `shareAdoption` opt-in AND a configured aggregator URL; every error (and opt-out) silently skips. A telemetry failure must NEVER fail an install.
- **Idempotent per installer:** `gem_adoptions` PK `(gem_key, producer_pubkey)` — re-installing (any version) never inflates a gem's installer count.
- **k-anon ≥5:** the gem-adoption aggregate applies `having count(distinct producer_pubkey) >= ${k}` with `k = DEFAULT_K` (5), exactly like `popularity`. A gem with <5 distinct installers returns NO row.
- **Signed + verified:** every event is ed25519-signed with the local identity and verified server-side before projection. Never trust a request body's pubkey without a valid signature over `canonicalJSON(rest)`.
- **Tests live in the ROOT suite** (`src/**/__tests__/`), import from the `@agentgem/*` packages, run via root `pnpm test`. `packages/{insight,aggregator}` have NO test runner.
- Additive/surgical diffs; match existing style; no reformatting.
- Commit identity: `git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit`; every message ends with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`. Stage explicitly; verify `git show HEAD --stat`.

---

### Task 1: `GemAdoption` event — build, sign, post (insight)

**Files:**
- Create: `packages/insight/src/adoption.ts`
- Modify: `packages/insight/src/index.ts` (barrel export)
- Test: `src/gem/__tests__/gemAdoption.event.test.ts`

**Interfaces — Produces:**
- `interface GemAdoption { formatVersion: 1; gemKey: string; version: string; gemDigest: string; event: "install"; producer: { publicKey: string; account: { provider: string; login: string } | null }; signedAt: number; signature: string }`
- `buildGemAdoption(args: { gemKey: string; version: string; gemDigest: string; account?: { provider: string; login: string } | null }): GemAdoption`
- `signGemAdoption(a: GemAdoption, identity: Identity, signedAt?: number): GemAdoption`
- `postGemAdoption(args: { adoption: GemAdoption; endpoint?: string; token?: string; http?: IngestHttp }): Promise<{ ingestId: string } | { skipped: true }>`

- [ ] **Step 1: Write the failing test** — `src/gem/__tests__/gemAdoption.event.test.ts`:
```ts
// src/gem/__tests__/gemAdoption.event.test.ts
import { describe, it, expect } from "vitest";
import { buildGemAdoption, signGemAdoption } from "@agentgem/insight";
import { canonicalJSON } from "@agentgem/insight";
import { loadOrCreateIdentity, verify } from "@agentgem/model";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("GemAdoption event", () => {
  const identity = loadOrCreateIdentity(mkdtempSync(join(tmpdir(), "ag-adopt-")));
  it("builds the canonical shape (placeholders empty)", () => {
    const a = buildGemAdoption({ gemKey: "@alice/kit", version: "1.0.0", gemDigest: "sha256:abc" });
    expect(a).toMatchObject({ formatVersion: 1, gemKey: "@alice/kit", version: "1.0.0", gemDigest: "sha256:abc", event: "install", producer: { publicKey: "", account: null }, signature: "" });
  });
  it("signs so verify() accepts, and a tampered field breaks the signature", () => {
    const signed = signGemAdoption(buildGemAdoption({ gemKey: "@alice/kit", version: "1.0.0", gemDigest: "sha256:abc" }), identity, 123);
    expect(signed.producer.publicKey).toMatch(/^ed25519:/);
    const { signature, ...rest } = signed;
    expect(verify(signed.producer.publicKey, canonicalJSON(rest), signature)).toBe(true);
    const tampered = { ...rest, gemKey: "@evil/kit" };
    expect(verify(signed.producer.publicKey, canonicalJSON(tampered), signature)).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run (repo root): `pnpm exec tsc -b && pnpm exec vitest run dist/gem/__tests__/gemAdoption.event.test.js`
Expected: FAIL — `buildGemAdoption` not exported.

- [ ] **Step 3: Implement** — `packages/insight/src/adoption.ts` (mirror `attestation.ts`'s build/sign + `ingestClient.ts`'s post; `Identity`/`IngestHttp` types are imported):
```ts
// <MIT header, third line = packages/insight/src/adoption.ts>
import { canonicalJSON } from "./attestation.js";
import type { Identity } from "@agentgem/model";
import type { IngestHttp } from "./ingestClient.js";

export interface GemAdoption {
  formatVersion: 1;
  gemKey: string;          // registry key "@scope/name"
  version: string;         // installed version
  gemDigest: string;       // the installed gem's digest
  event: "install";        // v1 always "install" (apply/run deferred)
  producer: { publicKey: string; account: { provider: string; login: string } | null };
  signedAt: number;
  signature: string;
}

export function buildGemAdoption(args: {
  gemKey: string; version: string; gemDigest: string;
  account?: { provider: string; login: string } | null;
}): GemAdoption {
  return {
    formatVersion: 1, gemKey: args.gemKey, version: args.version, gemDigest: args.gemDigest,
    event: "install", producer: { publicKey: "", account: args.account ?? null }, signedAt: 0, signature: "",
  };
}

export function signGemAdoption(a: GemAdoption, identity: Identity, signedAt = 0): GemAdoption {
  const filled = { ...a, producer: { ...a.producer, publicKey: identity.publicKey }, signedAt };
  const { signature, ...rest } = filled;
  return { ...filled, signature: identity.sign(canonicalJSON(rest)) };
}

export async function postGemAdoption(args: {
  adoption: GemAdoption; endpoint?: string; token?: string; http?: IngestHttp;
}): Promise<{ ingestId: string } | { skipped: true }> {
  const endpoint = args.endpoint ?? process.env.AGENTGEM_ADOPT_URL ?? "";
  if (!endpoint) return { skipped: true };
  const http = args.http ?? (async (url, init) => {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
    return { status: res.status, json: () => res.json() };
  });
  const res = await http(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${args.token ?? ""}` },
    body: canonicalJSON(args.adoption),
  });
  if (res.status < 200 || res.status >= 300) throw new Error(`adopt ${res.status}`);
  const body = (await res.json()) as { ingestId?: string };
  if (!body.ingestId) throw new Error("adopt: response missing ingestId");
  return { ingestId: body.ingestId };
}
```
Confirm `IngestHttp` is exported from `ingestClient.ts` (it is — `export type IngestHttp`). Export `./adoption.js` from `packages/insight/src/index.ts` (match its export style).

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm exec tsc -b && pnpm exec vitest run dist/gem/__tests__/gemAdoption.event.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**
```bash
git add packages/insight/src/adoption.ts packages/insight/src/index.ts src/gem/__tests__/gemAdoption.event.test.ts
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "feat(insight): signed GemAdoption event (build/sign/post)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: `gem_adoptions` table + `projectGemAdoption` (idempotent)

**Files:**
- Modify: `packages/aggregator/src/schema.ts` (new table), `packages/aggregator/src/index.ts` (export if the barrel re-exports schema symbols)
- Create: `packages/aggregator/src/projectAdoption.ts`
- Test: `src/gem/__tests__/projectAdoption.test.ts`

**Interfaces:**
- Consumes: `GemAdoption` (Task 1).
- Produces: `gemAdoptions` table; `projectGemAdoption(db: AppDb, a: GemAdoption): Promise<{ idempotent: boolean }>`.

- [ ] **Step 1: Write the failing test** — `src/gem/__tests__/projectAdoption.test.ts` (use `makeTestDb()` from `@agentgem/aggregator`, and Task 1's build/sign to make events with distinct identities):
```ts
// src/gem/__tests__/projectAdoption.test.ts
import { describe, it, expect } from "vitest";
import { makeTestDb, projectGemAdoption, gemAdoptionCount } from "@agentgem/aggregator";
import { buildGemAdoption, signGemAdoption } from "@agentgem/insight";
import { loadOrCreateIdentity } from "@agentgem/model";
import { mkdtempSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";

const idOf = (n: string) => loadOrCreateIdentity(mkdtempSync(join(tmpdir(), `ag-${n}-`)));
const ev = (id: ReturnType<typeof idOf>, key = "@alice/kit") =>
  signGemAdoption(buildGemAdoption({ gemKey: key, version: "1.0.0", gemDigest: "sha256:x" }), id, 1);

describe("projectGemAdoption", () => {
  it("counts DISTINCT installers, idempotent per installer", async () => {
    const db = await makeTestDb();
    await projectGemAdoption(db, ev(idOf("a")));
    const second = await projectGemAdoption(db, ev(idOf("b")));
    expect(second.idempotent).toBe(false);
    const alice = idOf("a2");
    await projectGemAdoption(db, ev(alice));
    const again = await projectGemAdoption(db, ev(alice)); // same installer twice
    expect(again.idempotent).toBe(true);
    expect(await gemAdoptionCount(db, "@alice/kit")).toBe(3); // a, b, a2 — the two `alice` rows dedupe
  });
});
```
(Add a tiny test-only helper `gemAdoptionCount(db, key): Promise<number>` = `select count(distinct producer_pubkey) from gem_adoptions where gem_key = key` in the aggregator barrel, OR assert via a raw `db.execute`. If you prefer not to add a helper, replace the last assertion with a raw count query in the test.)

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm exec tsc -b && pnpm exec vitest run dist/gem/__tests__/projectAdoption.test.js`
Expected: FAIL — `projectGemAdoption`/table missing.

- [ ] **Step 3: Implement**

`packages/aggregator/src/schema.ts` — add (after the existing tables; import `primaryKey` is already imported):
```ts
export const gemAdoptions = pgTable("gem_adoptions", {
  gemKey: text("gem_key").notNull(),
  gemDigest: text("gem_digest").notNull(),
  producerPubkey: text("producer_pubkey").notNull().references(() => producers.pubkey),
  accountLogin: text("account_login"),
  event: text("event").notNull().default("install"),
  adoptedAt: timestamp("adopted_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.gemKey, t.producerPubkey] })]);
```
`packages/aggregator/src/projectAdoption.ts`:
```ts
// <MIT header>
import { sql } from "drizzle-orm";
import type { AppDb } from "./schema.js";
import { producers, gemAdoptions } from "./schema.js";
import type { GemAdoption } from "@agentgem/insight";

export async function projectGemAdoption(db: AppDb, a: GemAdoption): Promise<{ idempotent: boolean }> {
  await db.insert(producers).values({ pubkey: a.producer.publicKey, attestCount: 0 })
    .onConflictDoNothing({ target: producers.pubkey });                    // adoption doesn't bump attestCount
  const r = await db.insert(gemAdoptions).values({
    gemKey: a.gemKey, gemDigest: a.gemDigest, producerPubkey: a.producer.publicKey,
    accountLogin: a.producer.account?.login ?? null, event: a.event,
  }).onConflictDoUpdate({
    target: [gemAdoptions.gemKey, gemAdoptions.producerPubkey],
    set: { gemDigest: a.gemDigest, adoptedAt: sql`now()`, accountLogin: a.producer.account?.login ?? null },
  }).returning({ inserted: sql<boolean>`(xmax = 0)` });                    // xmax=0 → this was an INSERT, not an UPDATE
  return { idempotent: !(r[0]?.inserted ?? true) };
}

export async function gemAdoptionCount(db: AppDb, gemKey: string): Promise<number> {
  const r = await db.execute<{ c: number }>(sql`select count(distinct producer_pubkey)::int as c from gem_adoptions where gem_key = ${gemKey}`);
  return r.rows[0]?.c ?? 0;
}
```
(If the `xmax = 0` insert/update detection is unavailable under PGlite, fall back to: pre-check `select 1 from gem_adoptions where gem_key=… and producer_pubkey=…`, then insert-or-update, and derive `idempotent` from the pre-check.)
Export `gemAdoptions`, `projectGemAdoption`, `gemAdoptionCount` from `packages/aggregator/src/index.ts`.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm exec tsc -b && pnpm exec vitest run dist/gem/__tests__/projectAdoption.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add packages/aggregator/src/schema.ts packages/aggregator/src/projectAdoption.ts packages/aggregator/src/index.ts src/gem/__tests__/projectAdoption.test.ts
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "feat(aggregator): gem_adoptions table + projectGemAdoption (idempotent per installer)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: `verifyGemAdoption` + `ingestGemAdoption` + `POST /api/aggregator/adopt`

**Files:**
- Create: `packages/aggregator/src/ingestAdoption.ts` (verify + ingest)
- Modify: `packages/aggregator/src/index.ts` (export), `src/aggregator.controller.ts` (endpoint), `src/gating.ts` (route /adopt to the ingest bucket)
- Test: `src/gem/__tests__/adoptEndpoint.test.ts`

**Interfaces:**
- Produces: `verifyGemAdoption(a): { ok: true } | { ok: false; reason: "bad-signature" }`; `ingestGemAdoption(db, a): Promise<{ accepted: true; idempotent: boolean } | { accepted: false; rejected: "bad-signature" }>`.

- [ ] **Step 1: Write the failing test** — `src/gem/__tests__/adoptEndpoint.test.ts` (mirror the existing ingest controller test — construct the controller with a test db; find the existing `ingest` controller test for the setup, e.g. `grep -rl "aggregator.controller\|ingest" src/**/__tests__`):
```ts
// exercises AggregatorController.adopt with makeTestDb
// - a validly signed event → { accepted: true, idempotent: false }, then repeat → idempotent: true
// - a tampered event (bad signature) → { accepted: false, rejected: "bad-signature" }
```
(Read the existing aggregator-controller test for how `this.db` is injected/constructed; mirror it.)

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm exec tsc -b && pnpm exec vitest run dist/gem/__tests__/adoptEndpoint.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement**

`packages/aggregator/src/ingestAdoption.ts` (mirror `ingest.ts`'s verify + idempotency shape):
```ts
// <MIT header>
import { verify } from "@agentgem/model";
import { canonicalJSON, type GemAdoption } from "@agentgem/insight";
import type { AppDb } from "./schema.js";
import { projectGemAdoption } from "./projectAdoption.js";

export function verifyGemAdoption(a: GemAdoption): { ok: true } | { ok: false; reason: "bad-signature" } {
  const { signature, ...rest } = a;
  return verify(a.producer.publicKey, canonicalJSON(rest), signature) ? { ok: true } : { ok: false, reason: "bad-signature" };
}

export type AdoptResult =
  | { accepted: true; idempotent: boolean }
  | { accepted: false; rejected: "bad-signature" };

export async function ingestGemAdoption(db: AppDb, a: GemAdoption): Promise<AdoptResult> {
  const v = verifyGemAdoption(a);
  if (!v.ok) return { accepted: false, rejected: v.reason };
  const { idempotent } = await projectGemAdoption(db, a);
  return { accepted: true, idempotent };
}
```
Export both from the aggregator barrel.

`src/aggregator.controller.ts` — add a Zod `AdoptBody` (matching `GemAdoption`) + `AdoptResult` schema and:
```ts
@post("/adopt", { body: AdoptBody, response: AdoptResultSchema })
async adopt(input: { body: z.infer<typeof AdoptBody> }): Promise<z.infer<typeof AdoptResultSchema>> {
  return ingestGemAdoption(this.db, input.body as unknown as GemAdoption);
}
```
(Import `ingestGemAdoption` + `GemAdoption`. Model `AdoptBody` loosely like the existing `IngestBody` — a permissive object; verification is the real gate, so it need not re-validate every field, but DO require `gemKey`/`version`/`gemDigest`/`producer.publicKey`/`signature` as strings.)

`src/gating.ts` — widen `isIngestPath` (line 52) so `/adopt` shares the ingest bucket:
```ts
return full === `${AGG_PATH}/ingest` || full === `${AGG_PATH}/adopt`;
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm exec tsc -b && pnpm exec vitest run dist/gem/__tests__/adoptEndpoint.test.js`
Expected: PASS. Also run any existing gating test.

- [ ] **Step 5: Commit**
```bash
git add packages/aggregator/src/ingestAdoption.ts packages/aggregator/src/index.ts src/aggregator.controller.ts src/gating.ts src/gem/__tests__/adoptEndpoint.test.ts
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "feat(aggregator): POST /api/aggregator/adopt — verify + ingest a GemAdoption

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: `gemAdoption` k-anon aggregate + `GET /api/aggregator/gem-adoption`

**Files:**
- Modify: `packages/aggregator/src/aggregates.ts`, `packages/aggregator/src/index.ts`, `src/aggregator.controller.ts`
- Test: `src/gem/__tests__/gemAdoptionAggregate.test.ts`

**Interfaces:**
- Produces: `gemAdoption(db, { keys?: string[]; k?: number }): Promise<{ gemKey: string; installs: number; verifiedInstalls: number }[]>`.

- [ ] **Step 1: Write the failing test** — k-anon: seed 4 distinct installers of `@a/g` → NO row; a 5th → a row `{ installs: 5 }`; a `keys` filter narrows; `verifiedInstalls` counts distinct account_login. Use `projectGemAdoption` with 5 distinct identities.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm exec tsc -b && pnpm exec vitest run dist/gem/__tests__/gemAdoptionAggregate.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement**

`packages/aggregator/src/aggregates.ts` — add (mirror `popularity`'s k-anon + verified join; note `account_login` lives ON `gem_adoptions`, so no `account_bindings` join is needed for verified counts here):
```ts
export async function gemAdoption(
  db: AppDb, opts: { keys?: string[]; k?: number } = {},
): Promise<{ gemKey: string; installs: number; verifiedInstalls: number }[]> {
  const k = opts.k ?? DEFAULT_K;
  const keys = opts.keys && opts.keys.length ? opts.keys : null;
  const r = await db.execute<{ gemKey: string; installs: number; verifiedInstalls: number }>(sql`
    select gem_key as "gemKey",
           count(distinct producer_pubkey)::int as installs,
           count(distinct account_login)::int as "verifiedInstalls"
    from gem_adoptions
    where (${keys}::text[] is null or gem_key = any(${keys}::text[]))
    group by gem_key
    having count(distinct producer_pubkey) >= ${k}
    order by installs desc
  `);
  return r.rows as { gemKey: string; installs: number; verifiedInstalls: number }[];
}
```
Export from the barrel.

`src/aggregator.controller.ts` — add `@get("/gem-adoption", { query: GemAdoptionQuery, response: GemAdoptionResult })` → parse `keys` (comma-separated) → `gemAdoption(this.db, { keys })`. `GemAdoptionQuery = z.object({ keys: z.string().optional() })`; `GemAdoptionResult = z.object({ items: z.array(z.object({ gemKey: z.string(), installs: z.number(), verifiedInstalls: z.number() })) })`; return `{ items }`.

- [ ] **Step 4: Run to verify it passes** — `pnpm exec tsc -b && pnpm exec vitest run dist/gem/__tests__/gemAdoptionAggregate.test.js` → PASS.

- [ ] **Step 5: Commit**
```bash
git add packages/aggregator/src/aggregates.ts packages/aggregator/src/index.ts src/aggregator.controller.ts src/gem/__tests__/gemAdoptionAggregate.test.ts
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "feat(aggregator): gem-level k-anon adoption aggregate + GET /api/aggregator/gem-adoption

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: opt-in setting + fire-and-forget emit from `registryInstall`

**Files:**
- Create: `src/agentgemConfig.ts` (local config read/write), `src/registry/emitAdoption.ts`
- Modify: `src/gem.controller.ts` (settings endpoints + the emit call in `registryInstall`)
- Test: `src/gem/__tests__/emitAdoption.test.ts`

**Interfaces:**
- Produces: `readShareAdoption(): boolean` / `setShareAdoption(v: boolean): void` (persist `~/.agentgem/config.json` `{ shareAdoption }`, default false); `emitAdoption(installed: { gemKey: string; version: string; gemDigest: string }[], deps?): Promise<void>` (fire-and-forget-safe: swallows all errors).

- [ ] **Step 1: Write the failing test** — `src/gem/__tests__/emitAdoption.test.ts`:
```ts
// - shareAdoption=false → emitAdoption posts NOTHING (stub postGemAdoption, assert 0 calls)
// - shareAdoption=true + AGENTGEM_ADOPT_URL set → posts one signed event per installed ref
// - a throwing postGemAdoption → emitAdoption still resolves (never throws)
```
Inject `postGemAdoption` + the identity + the config reader via a `deps` param so the test needs no real network/home. Assert the posted event's `gemKey`/`version` match the installed ref and `producer.publicKey` is set (signed).

- [ ] **Step 2: Run to verify it fails** — `pnpm exec tsc -b && pnpm exec vitest run dist/gem/__tests__/emitAdoption.test.js` → FAIL.

- [ ] **Step 3: Implement**

`src/agentgemConfig.ts` — read/write `~/.agentgem/config.json` (`{ shareAdoption?: boolean }`); `readShareAdoption()` returns `false` when the file/key is absent or unreadable; `setShareAdoption(v)` merges + writes (mode 0600). Pure Node fs; tolerate missing file.

`src/registry/emitAdoption.ts`:
```ts
// <MIT header>
import { buildGemAdoption, signGemAdoption, postGemAdoption } from "@agentgem/insight";
import { loadOrCreateIdentity } from "@agentgem/model";
import { readShareAdoption } from "../agentgemConfig.js";

export interface EmitAdoptionDeps {
  enabled?: () => boolean;
  adoptUrl?: string | undefined;
  identity?: { publicKey: string; sign(d: string): string };
  post?: typeof postGemAdoption;
  now?: number;
}

// Fire-and-forget: gated on opt-in + a configured URL; swallows EVERY error so a telemetry
// failure can never fail the install that called it. Never await this into a response.
export async function emitAdoption(
  installed: { gemKey: string; version: string; gemDigest: string }[],
  deps: EmitAdoptionDeps = {},
): Promise<void> {
  try {
    const enabled = (deps.enabled ?? readShareAdoption)();
    const endpoint = deps.adoptUrl ?? process.env.AGENTGEM_ADOPT_URL ?? "";
    if (!enabled || !endpoint || installed.length === 0) return;
    const identity = deps.identity ?? loadOrCreateIdentity();
    const post = deps.post ?? postGemAdoption;
    for (const g of installed) {
      try {
        const signed = signGemAdoption(buildGemAdoption(g), identity, deps.now ?? 0);
        await post({ adoption: signed, endpoint });
      } catch { /* per-ref: swallow */ }
    }
  } catch { /* opt-in read / identity load: swallow */ }
}
```
`src/gem.controller.ts`:
- Add `@get("/settings/adoption", …)` → `{ enabled: readShareAdoption() }` and `@post("/settings/adoption", { body: { enabled: boolean } })` → `setShareAdoption(input.body.enabled); return { enabled: input.body.enabled }`. (These are LOCAL console endpoints; they sit behind originGuard like the other console routes.)
- In `registryInstall`, after a successful install (both branches), compute the installed refs from the resolved `plan` (the resolved `@scope/name` + version + digest for each ref — read the `ResolvePlan` shape to extract them; if only the requested `refs` + `gem` are readily available, emit for the primary installed gem: `{ gemKey: <resolved key>, version: <resolved version>, gemDigest: <gem digest> }`) and fire-and-forget:
  ```ts
  void emitAdoption(installedRefs);   // NOT awaited — never blocks/breaks the response
  ```
  Place it just before `return { plan, applied: … }` in each branch (or once, computed from `plan`, before the mode branch's returns).

- [ ] **Step 4: Run to verify it passes** — `pnpm exec tsc -b && pnpm exec vitest run dist/gem/__tests__/emitAdoption.test.js` → PASS. Confirm the existing `registryInstall`/registry tests still pass (the `void emitAdoption(...)` is non-blocking and env-gated → no-op in tests).

- [ ] **Step 5: Commit**
```bash
git add src/agentgemConfig.ts src/registry/emitAdoption.ts src/gem.controller.ts src/gem/__tests__/emitAdoption.test.ts
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "feat(registry): opt-in fire-and-forget adoption emit from registryInstall

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: Marketplace — fetch adoption + blend into the Stone rating

**Files:**
- Modify: `packages/marketplace/src/gems/rating.ts` (adoptionCurve + 3-arg stoneRating), `packages/marketplace/src/api.ts` (gemAdoption client), `packages/marketplace/src/StoneRating.tsx` (installs prop), `packages/marketplace/src/pages/Gems.tsx` + `Gem.tsx` (fetch + thread)
- Test: `packages/marketplace/src/gems/rating.test.ts` (extend), `packages/marketplace/src/StoneRating.test.tsx` (extend)

**Interfaces:**
- Produces: `adoptionCurve(installs: number): number`; `stoneRating(floor: number | undefined, stars: number, installs?: number): number`; `api.gemAdoption(keys: string[]): Promise<Record<string, number>>`.

- [ ] **Step 1: Write the failing tests** — extend `rating.test.ts`:
```ts
// adoptionCurve: [0,4,5,9,10,49,50,999] -> [1,1,3,3,4,4,5,5]
// stoneRating 3-arg: stoneRating(1, 0, 50) === 5; stoneRating(3, 0, 0) === 3; stoneRating(1,0,0) === 1; still works 2-arg (installs defaults 0)
```
extend `StoneRating.test.tsx`: `<StoneRating cut="skill" grade={1} stars={0} installs={50} />` → 5 filled.

- [ ] **Step 2: Run to verify they fail** — `pnpm --filter @agentgem/marketplace test -- rating StoneRating` → FAIL.

- [ ] **Step 3: Implement**

`packages/marketplace/src/gems/rating.ts`:
```ts
// installs are k-anon (0 or >=5); <5 contributes nothing (returns 1 → ignored by max).
export function adoptionCurve(installs: number): number {
  if (installs >= 50) return 5;
  if (installs >= 10) return 4;
  if (installs >= 5) return 3;
  return 1;
}
export function stoneRating(floor: number | undefined, stars: number, installs = 0): number {
  return Math.min(5, Math.max(floor ?? 1, starCurve(stars), adoptionCurve(installs)));
}
```
`packages/marketplace/src/api.ts` — add to `makeApi`:
```ts
    gemAdoption: (keys: string[]): Promise<Record<string, number>> =>
      keys.length === 0 ? Promise.resolve({}) :
      get<{ items: { gemKey: string; installs: number }[] }>(base, "/api/aggregator/gem-adoption", { keys: keys.join(",") })
        .then((r) => Object.fromEntries(r.items.map((i) => [i.gemKey, i.installs])))
        .catch(() => ({})),                       // adoption is best-effort; never breaks the page
```
`packages/marketplace/src/StoneRating.tsx` — add `installs?: number` to the props and pass it: `const n = stoneRating(grade, stars, installs ?? 0);`.
`packages/marketplace/src/pages/Gems.tsx` — in the existing load effect, after gems load, fetch `api.gemAdoption(gems.map(g => g.key))` into an `adoptions` state (ONE call); pass `installs={adoptions[g.key] ?? 0}` into `<StoneRating … />` (line ~65). `Gem.tsx` — same for the single gem (`api.gemAdoption([keyName])`).

- [ ] **Step 4: Run to verify + gates** — `pnpm --filter @agentgem/marketplace test && pnpm --filter @agentgem/marketplace typecheck && pnpm --filter @agentgem/marketplace build` → all green.

- [ ] **Step 5: Commit**
```bash
git add packages/marketplace/src/gems/rating.ts packages/marketplace/src/gems/rating.test.ts packages/marketplace/src/api.ts packages/marketplace/src/StoneRating.tsx packages/marketplace/src/StoneRating.test.tsx packages/marketplace/src/pages/Gems.tsx packages/marketplace/src/pages/Gem.tsx
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "feat(marketplace): blend k-anon adoption into the Stone rating

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Final verification (after all tasks)

- Server: `pnpm exec tsc -b` clean; full `pnpm test` green (build console first; known real-FS flakes aside) incl. the new event/project/adopt/aggregate/emit tests.
- Marketplace: `pnpm --filter @agentgem/marketplace test|typecheck|build` clean.
- Whole-branch review (opus — a telemetry/privacy + signed-ingest change): verify the emit is default-OFF + fire-and-forget + never blocks the install; the event is signature-verified before projection; the aggregate is k-anon ≥5; idempotency per (gem_key, producer_pubkey); `/adopt` shares the ingest rate-limit bucket. Confirm v1 makes NO sybil-resistance claim.

## Out of scope (deferred — stated, not silently dropped)

- 💎 Diamond apex (floor 3 + broad adoption); apply/run emit sites; adoption trust/quarantine (sybil); time-series gem adoption; un-gating the emit by default. The hosted `gem_adoptions` table must be provisioned on Neon the same way existing aggregator tables are (drizzle push / migration) — a deploy step, not a code task here.

## The result this delivers

Real, opt-in, k-anonymized installs raise a gem's Stone rating above what stars alone show — the honest-adoption backbone the whole Cut × Stone rating leaned on, laid ahead of the volume. Diamond becomes reachable next.
