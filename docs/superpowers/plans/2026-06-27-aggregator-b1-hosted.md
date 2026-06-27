# Aggregator B1 — Hosted HTTP Slice (Drizzle) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose the B1 aggregator over HTTP on the repo's `@agentback/rest` server, backed by real Postgres, by reworking the core onto the blessed `@agentback/drizzle` DB layer (dialect-generic: pglite for tests, node-postgres for prod), then adding ingest + read routes with k-anon enforced server-side.

**Architecture:** A Drizzle schema (`src/aggregator/schema.ts`) is the source of truth; the core (`ingest`/`project`/`aggregates`/`seed`) is reworked to take an injected Drizzle client; `aggregator.controller.ts` injects it via `@inject(DrizzleBindings.CLIENT)` and exposes 3 routes; `index.ts` constructs the prod client + `registerDrizzle`. k-anon is server policy, never a caller param.

**Tech Stack:** TypeScript (ESM), `@agentback/drizzle@0.5.2` + `@agentback/context` (DI), `drizzle-orm@0.45.2` (`drizzle-orm/pglite` tests, `drizzle-orm/node-postgres` prod), `drizzle-zod`, `pg`, `@agentback/rest`/`@agentback/openapi` (existing server), vitest on compiled `dist/`.

**Spec:** `docs/superpowers/specs/2026-06-27-aggregator-b1-hosted-drizzle-design.md`.

## Global Constraints

- **ESM only**, `.js` import extensions, `type: module`.
- **Tests run on compiled `dist/`** (vitest `include: dist/**/__tests__/**/*.test.js`). Build first: `pnpm build`. After file rename/move: `rm -f tsconfig.tsbuildinfo && rm -rf dist`.
- **Deps are already installed + spike-validated:** `@agentback/drizzle@0.5.2` (aligned with the repo's `~0.5.2` agentback core/context → single shared DI container), `drizzle-orm`, `drizzle-zod`, `pg`, `@types/pg`.
- **Reuse Spec A:** `verify` (`../gem/identity.js`), `canonicalJSON` + `UsageAttestation` (`../gem/attestation.js`). `verifyAttestation` (pure, in `ingest.ts`) is **unchanged** — it has no DB.
- **This reworks the existing raw-SQL core** (from the B1 core slice on the parent branch). The old `db.ts` (`DB` interface / `createDb` / `SCHEMA`) is replaced by `schema.ts` + `testDb.ts`. Every core fn changes `(db: DB, …)` → `(db: AppDb, …)`.
- **Public-only graph** (private ingredients never become rows — `private_count` only) and **k-anon in the SQL** (`having sql\`count(distinct …) >= k\``, never a JS post-filter) are INVARIANTS — preserve exactly.
- **k-anon is server policy:** the read routes do NOT accept `k`; they always use `DEFAULT_K`.
- `grep`/`rg` is misconfigured in the dev shell (returns empty for present strings) — use the Read tool to confirm file contents.

## Reused / validated patterns

- Drizzle client (validated on pglite): `db.insert(t).values(...).onConflictDoUpdate({target, set})`; `db.select({...}).from(t).innerJoin(...).where(...).groupBy(...).having(sql\`…\`).orderBy(...).limit(n)`; raw via `db.execute(sql\`…\`)`.
- Controller pattern (`src/gem.controller.ts`): `@api({ basePath })` on the class; `@get(path,{query,response})` / `@post(path,{body,response})` on `async method(input: { query|body: z.infer<…> }): Promise<z.infer<…>>`.
- DI (`@agentback/drizzle` README): `registerDrizzle(app, drizzle(client,{schema}), { onStop })`; inject `constructor(@inject(DrizzleBindings.CLIENT) private db: AppDb) {}`.

---

### Task 1: Drizzle schema + test DB

**Files:**
- Create: `src/aggregator/schema.ts`, `src/aggregator/testDb.ts`
- Test: `src/aggregator/__tests__/schema.test.ts`
- **Do NOT delete `db.ts` yet** — `tsc -b` is all-or-nothing and Tasks 2–5 still import `./db.js`; deleting it now breaks the whole build. `db.ts`/`db.test.ts` are removed in Task 6 after every importer has migrated. Add the new files **alongside** the old `db.ts` (which stays green).

**Interfaces produced:**
- `producers`, `attestations`, `ingredients`, `usageEdges` (Drizzle `pgTable`s)
- `type AppDb = PgDatabase<any, typeof schemaObj>` (the portable client type both drivers satisfy)
- `ensureSchema(db: AppDb): Promise<void>` (idempotent `create table if not exists`)
- `makeTestDb(): Promise<AppDb>` (drizzle over a fresh in-memory pglite + `ensureSchema`)

- [ ] **Step 1: Write the failing test**

```typescript
// src/aggregator/__tests__/schema.test.ts
import { describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";
import { makeTestDb } from "../testDb.js";
import { producers } from "../schema.js";

describe("schema/testDb", () => {
  it("creates the schema and runs drizzle queries on pglite", async () => {
    const db = await makeTestDb();
    await db.insert(producers).values({ pubkey: "ed25519:p1" });
    const rows = await db.select().from(producers);
    expect(rows.map((r) => r.pubkey)).toEqual(["ed25519:p1"]);
    const t = await db.execute(sql`select table_name from information_schema.tables where table_schema='public' order by 1`);
    expect((t.rows as { table_name: string }[]).map((x) => x.table_name)).toEqual(["attestations", "ingredients", "producers", "usage_edges"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm build && npx vitest run dist/aggregator/__tests__/schema.test.js`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement `schema.ts` + `testDb.ts`; delete `db.ts` + `db.test.ts`**

```typescript
// src/aggregator/schema.ts
import { pgTable, text, integer, uuid, timestamp, boolean, real, primaryKey } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";

export const producers = pgTable("producers", {
  pubkey: text("pubkey").primaryKey(),
  firstSeen: timestamp("first_seen").notNull().defaultNow(),
  attestCount: integer("attest_count").notNull().default(0),
});
export const attestations = pgTable("attestations", {
  id: uuid("id").primaryKey(),
  gemName: text("gem_name").notNull(),
  gemDigest: text("gem_digest").notNull().unique(),
  producerPubkey: text("producer_pubkey").notNull().references(() => producers.pubkey),
  harnessId: text("harness_id").notNull(),
  models: text("models").array().notNull().default(sql`'{}'::text[]`),
  scanSessions: integer("scan_sessions").notNull(),
  scanSpanDays: integer("scan_span_days").notNull(),
  signalDigest: text("signal_digest").notNull(),
  privateCount: integer("private_count").notNull().default(0),
  trustScore: real("trust_score").notNull().default(1),
  quarantined: boolean("quarantined").notNull().default(false),
  ingestedAt: timestamp("ingested_at").notNull().defaultNow(),
});
export const ingredients = pgTable("ingredients", {
  id: text("id").primaryKey(),
  kind: text("kind").notNull(),
  idKind: text("id_kind").notNull(),
  displayName: text("display_name"),
  firstSeen: timestamp("first_seen").notNull().defaultNow(),
  lastSeen: timestamp("last_seen").notNull().defaultNow(),
});
export const usageEdges = pgTable("usage_edges", {
  attestationId: uuid("attestation_id").notNull().references(() => attestations.id),
  ingredientId: text("ingredient_id").notNull().references(() => ingredients.id),
  invocations: integer("invocations").notNull(),
  sessions: integer("sessions").notNull(),
}, (t) => ({ pk: primaryKey({ columns: [t.attestationId, t.ingredientId] }) }));

export const schema = { producers, attestations, ingredients, usageEdges };
export type AppDb = PgDatabase<any, typeof schema>;

// Idempotent DDL. (Schema-as-tables above is the query source of truth; this DDL
// creates them. A column drift is caught immediately by the typed drizzle inserts.
// drizzle-kit migrations are a deferred follow-up when the schema starts evolving.)
export async function ensureSchema(db: AppDb): Promise<void> {
  await db.execute(sql`
    create table if not exists producers (pubkey text primary key, first_seen timestamptz not null default now(), attest_count int not null default 0);
    create table if not exists attestations (id uuid primary key, gem_name text not null, gem_digest text not null unique, producer_pubkey text not null references producers(pubkey), harness_id text not null, models text[] not null default '{}', scan_sessions int not null, scan_span_days int not null, signal_digest text not null, private_count int not null default 0, trust_score real not null default 1, quarantined boolean not null default false, ingested_at timestamptz not null default now());
    create table if not exists ingredients (id text primary key, kind text not null, id_kind text not null, display_name text, first_seen timestamptz not null default now(), last_seen timestamptz not null default now());
    create table if not exists usage_edges (attestation_id uuid not null references attestations(id), ingredient_id text not null references ingredients(id), invocations int not null, sessions int not null, primary key (attestation_id, ingredient_id));
  `);
}
```

```typescript
// src/aggregator/testDb.ts
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { schema, ensureSchema, type AppDb } from "./schema.js";

export async function makeTestDb(): Promise<AppDb> {
  const db = drizzle(new PGlite(), { schema }) as unknown as AppDb;
  await ensureSchema(db);
  return db;
}
```

Leave `src/aggregator/db.ts` and `src/aggregator/__tests__/db.test.ts` in place (they're deleted in Task 6 once nothing imports them) — adding the new files alongside keeps the build green.

(If `PgDatabase<any, typeof schema>` does not accept the pglite client at the `makeTestDb` cast site or at a core call site, the `as unknown as AppDb` cast in `testDb.ts` localizes it; do NOT loosen the core function signatures beyond `AppDb`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm build && npx vitest run dist/aggregator/__tests__/schema.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/aggregator/schema.ts src/aggregator/testDb.ts src/aggregator/__tests__/schema.test.ts
git rm src/aggregator/db.ts src/aggregator/__tests__/db.test.ts
git commit -m "feat(aggregator): drizzle schema + pglite test db (replaces raw DB interface)"
```

---

### Task 2: Rework `project.ts` onto Drizzle (public-only)

**Files:**
- Modify: `src/aggregator/project.ts`
- Test: `src/aggregator/__tests__/project.test.ts` (rework onto `makeTestDb`)

**Interfaces:**
- Consumes: `AppDb`, tables (`./schema.js`); `UsageAttestation` (`../gem/attestation.js`).
- Produces: `projectAttestation(db: AppDb, att: UsageAttestation): Promise<{ id: string; publicIngredients: number; privateCount: number }>` — unchanged contract; the `publicNodes()` helper (public-only mapping) is preserved.

- [ ] **Step 1: Write the failing test (drizzle-backed)**

```typescript
// src/aggregator/__tests__/project.test.ts
import { describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";
import { makeTestDb } from "../testDb.js";
import { projectAttestation } from "../project.js";
import { ingredients, usageEdges, attestations, producers } from "../schema.js";

function att(pubkey: string, gemDigest: string) {
  return { formatVersion: 1, canonicalizerVersion: 3, gem: { name: "g", digest: gemDigest },
    producer: { publicKey: pubkey, account: null },
    source: { harness: { id: "claude-code" }, models: ["claude-opus-4-8"], scan: { sessions: 4, spanDays: 1, firstMs: 0, lastMs: 0 } },
    ingredients: {
      skills: [
        { id: "skill:superpowers@m/brainstorming", idKind: "plugin", public: true, invocations: 9, sessions: 3 },
        { id: "private:sha256:xyz", idKind: "private", public: false, invocations: 1, sessions: 1 },
      ],
      mcps: [{ id: "mcp:context7@m/context7", idKind: "plugin", public: true, invocations: 15, sessions: 4 }],
    },
    evidence: { signalDigest: "sha256:d" }, signedAt: 1, signature: "x" } as never;
}

describe("projectAttestation (drizzle)", () => {
  it("writes public ingredients (+harness+models) and counts private", async () => {
    const db = await makeTestDb();
    const r = await projectAttestation(db, att("ed25519:p1", "sha256:1"));
    expect(r).toMatchObject({ privateCount: 1, publicIngredients: 4 }); // harness + 1 model + 1 skill + 1 mcp
    const ids = (await db.select({ id: ingredients.id }).from(ingredients)).map((x) => x.id);
    expect(ids).toContain("claude-code");
    expect(ids).toContain("claude-opus-4-8");
    expect(ids).toContain("skill:superpowers@m/brainstorming");
    expect(ids).toContain("mcp:context7@m/context7");
    expect(ids).not.toContain("private:sha256:xyz");
    const edge = (await db.execute(sql`select invocations, sessions from usage_edges where ingredient_id='mcp:context7@m/context7'`)).rows[0];
    expect(edge).toEqual({ invocations: 15, sessions: 4 });
    const harnessEdge = (await db.execute(sql`select invocations, sessions from usage_edges where ingredient_id='claude-code'`)).rows[0];
    expect(harnessEdge).toEqual({ invocations: 4, sessions: 4 }); // scan.sessions proxy
    const a = (await db.select().from(attestations))[0];
    expect(a.privateCount).toBe(1);
    const p = (await db.select().from(producers))[0];
    expect(p.attestCount).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm build && npx vitest run dist/aggregator/__tests__/project.test.js`
Expected: FAIL (the file still imports the old `DB`/`createDb`).

- [ ] **Step 3: Rework `project.ts`**

```typescript
// src/aggregator/project.ts
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { AppDb } from "./schema.js";
import { producers, attestations, ingredients, usageEdges } from "./schema.js";
import type { UsageAttestation } from "../gem/attestation.js";

interface Node { id: string; kind: string; idKind: string; invocations: number; sessions: number }

function publicNodes(att: UsageAttestation): { nodes: Node[]; privateCount: number } {
  const s = att.source.scan.sessions;
  const nodes: Node[] = [
    { id: att.source.harness.id, kind: "harness", idKind: "known", invocations: s, sessions: s },
    ...att.source.models.map((m) => ({ id: m, kind: "model", idKind: "known", invocations: s, sessions: s })),
  ];
  let privateCount = 0;
  for (const r of att.ingredients.skills) r.public ? nodes.push({ id: r.id, kind: "skill", idKind: r.idKind, invocations: r.invocations, sessions: r.sessions }) : privateCount++;
  for (const r of att.ingredients.mcps) r.public ? nodes.push({ id: r.id, kind: "mcp", idKind: r.idKind, invocations: r.invocations, sessions: r.sessions }) : privateCount++;
  return { nodes, privateCount };
}

export async function projectAttestation(db: AppDb, att: UsageAttestation): Promise<{ id: string; publicIngredients: number; privateCount: number }> {
  const { nodes, privateCount } = publicNodes(att);
  const id = randomUUID();
  await db.insert(producers).values({ pubkey: att.producer.publicKey, attestCount: 1 })
    .onConflictDoUpdate({ target: producers.pubkey, set: { attestCount: sql`${producers.attestCount} + 1` } });
  await db.insert(attestations).values({
    id, gemName: att.gem.name, gemDigest: att.gem.digest, producerPubkey: att.producer.publicKey,
    harnessId: att.source.harness.id, models: att.source.models, scanSessions: att.source.scan.sessions,
    scanSpanDays: att.source.scan.spanDays, signalDigest: att.evidence.signalDigest, privateCount,
  });
  for (const n of nodes) {
    await db.insert(ingredients).values({ id: n.id, kind: n.kind, idKind: n.idKind })
      .onConflictDoUpdate({ target: ingredients.id, set: { lastSeen: sql`now()` } });
    await db.insert(usageEdges).values({ attestationId: id, ingredientId: n.id, invocations: n.invocations, sessions: n.sessions })
      .onConflictDoNothing();
  }
  return { id, publicIngredients: nodes.length, privateCount };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm build && npx vitest run dist/aggregator/__tests__/project.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/aggregator/project.ts src/aggregator/__tests__/project.test.ts
git commit -m "refactor(aggregator): project onto drizzle (public-only preserved)"
```

---

### Task 3: Rework `ingest.ts` onto Drizzle (verify + idempotency)

**Files:**
- Modify: `src/aggregator/ingest.ts` (keep `verifyAttestation` unchanged; rework `ingestAttestation`)
- Test: `src/aggregator/__tests__/ingest.test.ts` (rework onto `makeTestDb`); `verify.test.ts` stays as-is (no DB)

**Interfaces:**
- Consumes: `AppDb`, `attestations`, `usageEdges` (`./schema.js`); `projectAttestation` (`./project.js`); `verifyAttestation` (this file).
- Produces: `ingestAttestation(db: AppDb, att: UsageAttestation): Promise<IngestResult>` — same `IngestResult` union as before.

- [ ] **Step 1: Write the failing test**

```typescript
// src/aggregator/__tests__/ingest.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTestDb } from "../testDb.js";
import { ingestAttestation } from "../ingest.js";
import { attestations } from "../schema.js";
import { buildAttestation, signAttestation } from "../../gem/attestation.js";
import { loadOrCreateIdentity } from "../../gem/identity.js";

const gem = { name: "demo", createdFrom: "claude", artifacts: [
  { type: "skill" as const, name: "qa", source: "plugin:superpowers@m", content: "B" } ], checks: [], requiredSecrets: [] };
const signal = { root: "/p", flavor: "claude" as const, sessions: { scanned: 4, firstMs: 0, lastMs: 0, spanDays: 1 },
  artifacts: [{ type: "skill" as const, name: "qa", root: null, invocations: 5, sessionsUsedIn: 2, lastUsedMs: 0, confidence: "high" as const }],
  unresolved: [], coOccurrence: [], shapes: [], notes: [], models: [{ id: "claude-opus-4-8", sessions: 4 }] };
function make(digest: string) {
  const id = loadOrCreateIdentity(mkdtempSync(join(tmpdir(), "agg-id-")));
  return signAttestation(buildAttestation({ gem, signal, gemDigest: digest, salt: "S" }), id, 1);
}

describe("ingestAttestation (drizzle)", () => {
  it("accepts, projects, and is idempotent on gem_digest", async () => {
    const db = await makeTestDb();
    const a = make("sha256:unique1");
    const r1 = await ingestAttestation(db, a);
    expect(r1.accepted).toBe(true);
    const r2 = await ingestAttestation(db, a);
    expect(r2).toMatchObject({ accepted: true, idempotent: true });
    expect((await db.select().from(attestations)).length).toBe(1);
  });
  it("rejects a tampered signature without writing", async () => {
    const db = await makeTestDb();
    const r = await ingestAttestation(db, { ...make("sha256:u2"), signature: "AAAA" });
    expect(r).toEqual({ accepted: false, rejected: "bad-signature" });
    expect((await db.select().from(attestations)).length).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm build && npx vitest run dist/aggregator/__tests__/ingest.test.js`
Expected: FAIL.

- [ ] **Step 3: Rework `ingestAttestation` (leave `verifyAttestation` intact)**

```typescript
// src/aggregator/ingest.ts — replace the DB-touching part; keep verifyAttestation as-is
import { eq } from "drizzle-orm";
import type { AppDb } from "./schema.js";
import { attestations, usageEdges } from "./schema.js";
import { projectAttestation } from "./project.js";

export type IngestResult =
  | { accepted: true; id: string; publicIngredients: number; privateCount: number; idempotent: boolean }
  | { accepted: false; rejected: "bad-signature" | "inconsistent" };

export async function ingestAttestation(db: AppDb, att: UsageAttestation): Promise<IngestResult> {
  const v = verifyAttestation(att);
  if (!v.ok) return { accepted: false, rejected: v.reason };
  const prior = await db.select({ id: attestations.id, privateCount: attestations.privateCount })
    .from(attestations).where(eq(attestations.gemDigest, att.gem.digest));
  if (prior.length > 0) {
    const row = prior[0];
    const edges = await db.select({ aid: usageEdges.attestationId }).from(usageEdges).where(eq(usageEdges.attestationId, row.id));
    return { accepted: true, id: row.id, publicIngredients: edges.length, privateCount: row.privateCount, idempotent: true };
  }
  const p = await projectAttestation(db, att);
  return { accepted: true, ...p, idempotent: false };
}
```

(`verifyAttestation` and its imports — `verify`, `canonicalJSON`, `UsageAttestation` — remain; just add the imports above.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm build && npx vitest run dist/aggregator/__tests__/ingest.test.js dist/aggregator/__tests__/verify.test.js`
Expected: PASS (both — verify.test is unchanged).

- [ ] **Step 5: Commit**

```bash
git add src/aggregator/ingest.ts src/aggregator/__tests__/ingest.test.ts
git commit -m "refactor(aggregator): ingest onto drizzle (verify + idempotent preserved)"
```

---

### Task 4: Rework `aggregates.ts` onto Drizzle (k-anon in SQL)

**Files:**
- Modify: `src/aggregator/aggregates.ts`
- Test: `src/aggregator/__tests__/aggregates.test.ts` (rework onto `makeTestDb`)

**Interfaces:**
- Produces: `DEFAULT_K` (= 5), `popularity(db, {kind?,limit?,k?})`, `coOccurrence(db, {id,limit?,k?})` — same shapes; k-anon via `having sql\`…\``.

- [ ] **Step 1: Write the failing test**

```typescript
// src/aggregator/__tests__/aggregates.test.ts
import { describe, it, expect } from "vitest";
import { makeTestDb } from "../testDb.js";
import { projectAttestation } from "../project.js";
import { popularity, coOccurrence, DEFAULT_K } from "../aggregates.js";

function att(pubkey: string, digest: string, skills: string[]) {
  return { formatVersion: 1, canonicalizerVersion: 3, gem: { name: "g", digest },
    producer: { publicKey: pubkey, account: null },
    source: { harness: { id: "claude-code" }, models: [], scan: { sessions: 2, spanDays: 1, firstMs: 0, lastMs: 0 } },
    ingredients: { skills: skills.map((id) => ({ id, idKind: "plugin", public: true, invocations: 2, sessions: 1 })), mcps: [] },
    evidence: { signalDigest: "d" }, signedAt: 1, signature: "x" } as never;
}

describe("aggregates + k-anon (drizzle)", () => {
  it("popularity counts distinct producers and enforces k-anon in SQL", async () => {
    const db = await makeTestDb();
    await projectAttestation(db, att("ed25519:p1", "d1", ["skill:a", "skill:b"]));
    await projectAttestation(db, att("ed25519:p2", "d2", ["skill:a"]));
    await projectAttestation(db, att("ed25519:p3", "d3", ["skill:a"]));
    const k2 = await popularity(db, { kind: "skill", k: 2 });
    expect(k2.map((r) => r.id)).toEqual(["skill:a"]);
    expect(k2[0].producers).toBe(3);
    expect((await popularity(db, { kind: "skill", k: 1 })).map((r) => r.id).sort()).toEqual(["skill:a", "skill:b"]);
    expect(DEFAULT_K).toBeGreaterThanOrEqual(5);
    expect(await popularity(db, { kind: "skill" })).toEqual([]); // safe default suppresses 3 < DEFAULT_K
  });
  it("coOccurrence finds partners sharing a producer, k-anon enforced", async () => {
    const db = await makeTestDb();
    await projectAttestation(db, att("ed25519:p1", "d1", ["skill:a", "skill:x"]));
    await projectAttestation(db, att("ed25519:p2", "d2", ["skill:a", "skill:x"]));
    await projectAttestation(db, att("ed25519:p3", "d3", ["skill:a", "skill:y"]));
    const co = await coOccurrence(db, { id: "skill:a", k: 2 });
    expect(co.map((r) => r.id)).toContain("skill:x");
    expect(co.map((r) => r.id)).not.toContain("skill:y");
    expect(co.find((r) => r.id === "skill:x")!.producers).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm build && npx vitest run dist/aggregator/__tests__/aggregates.test.js`
Expected: FAIL.

- [ ] **Step 3: Rework `aggregates.ts`**

```typescript
// src/aggregator/aggregates.ts
import { and, eq, sql, desc } from "drizzle-orm";
import type { AppDb } from "./schema.js";
import { attestations, ingredients, usageEdges } from "./schema.js";

/** Safe-by-default k-anonymity floor — a caller that omits k must NOT get single-producer rows. */
export const DEFAULT_K = 5;
const PRODUCERS = sql<number>`count(distinct ${attestations.producerPubkey})`;

export async function popularity(db: AppDb, opts: { kind?: string; limit?: number; k?: number } = {}): Promise<{ id: string; kind: string; producers: number; invocations: number; sessions: number }[]> {
  const k = opts.k ?? DEFAULT_K, limit = opts.limit ?? 100;
  return db.select({
      id: usageEdges.ingredientId, kind: ingredients.kind,
      producers: sql<number>`count(distinct ${attestations.producerPubkey})::int`,
      invocations: sql<number>`sum(${usageEdges.invocations})::int`,
      sessions: sql<number>`sum(${usageEdges.sessions})::int`,
    })
    .from(usageEdges)
    .innerJoin(attestations, and(eq(attestations.id, usageEdges.attestationId), eq(attestations.quarantined, false)))
    .innerJoin(ingredients, eq(ingredients.id, usageEdges.ingredientId))
    .where(opts.kind ? eq(ingredients.kind, opts.kind) : undefined)
    .groupBy(usageEdges.ingredientId, ingredients.kind)
    .having(sql`${PRODUCERS} >= ${k}`)
    .orderBy(desc(PRODUCERS))
    .limit(limit);
}

export async function coOccurrence(db: AppDb, opts: { id: string; limit?: number; k?: number }): Promise<{ id: string; producers: number }[]> {
  const k = opts.k ?? DEFAULT_K, limit = opts.limit ?? 50;
  const e2 = sql.raw("e2");
  // self-join on shared attestation, exclude the pivot, count distinct producers, k-anon floor
  return db.execute(sql`
    select e2.ingredient_id as id, count(distinct a.producer_pubkey)::int as producers
    from usage_edges e1
    join usage_edges e2 on e2.attestation_id = e1.attestation_id and e2.ingredient_id <> e1.ingredient_id
    join attestations a on a.id = e1.attestation_id and a.quarantined = false
    where e1.ingredient_id = ${opts.id}
    group by e2.ingredient_id
    having count(distinct a.producer_pubkey) >= ${k}
    order by producers desc
    limit ${limit}
  `).then((r) => r.rows as { id: string; producers: number }[]);
}
```

(`coOccurrence` uses a raw `sql` self-join — clearer than the builder for a self-join — but the k-anon `having` and `quarantined=false` are still in the SQL, parameterized.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm build && npx vitest run dist/aggregator/__tests__/aggregates.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/aggregator/aggregates.ts src/aggregator/__tests__/aggregates.test.ts
git commit -m "refactor(aggregator): aggregates onto drizzle (k-anon in SQL, safe default)"
```

---

### Task 5: Rework `seed.ts` + real-data integration

**Files:**
- Modify: `src/aggregator/seed.ts`
- Test: `src/aggregator/__tests__/realdata.test.ts` (rework onto `makeTestDb`)

**Interfaces:**
- Produces: `seedSynthetic(db: AppDb, n: number, ids: string[]): Promise<number>` — idempotent (returns producers actually added).

- [ ] **Step 1: Write the failing test**

```typescript
// src/aggregator/__tests__/realdata.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTestDb } from "../testDb.js";
import { ingestAttestation } from "../ingest.js";
import { seedSynthetic } from "../seed.js";
import { popularity } from "../aggregates.js";
import { buildAttestation, signAttestation } from "../../gem/attestation.js";
import { loadOrCreateIdentity } from "../../gem/identity.js";

const gem = { name: "demo", createdFrom: "claude", artifacts: [
  { type: "skill" as const, name: "brainstorming", source: "plugin:superpowers@claude-plugins-official", content: "B" } ], checks: [], requiredSecrets: [] };
const signal = { root: "/p", flavor: "claude" as const, sessions: { scanned: 3, firstMs: 0, lastMs: 0, spanDays: 1 },
  artifacts: [{ type: "skill" as const, name: "brainstorming", root: null, invocations: 9, sessionsUsedIn: 3, lastUsedMs: 0, confidence: "high" as const }],
  unresolved: [], coOccurrence: [], shapes: [], notes: [], models: [{ id: "claude-opus-4-8", sessions: 3 }] };

describe("seeding + real signed attestation (drizzle)", () => {
  it("a real attestation's public skill surfaces once k-anon is met via seeding", async () => {
    const db = await makeTestDb();
    const id = loadOrCreateIdentity(mkdtempSync(join(tmpdir(), "agg-id-")));
    const att = signAttestation(buildAttestation({ gem, signal, gemDigest: "sha256:real", salt: "S" }), id, 1);
    const ing = att.ingredients.skills.find((s) => s.public)!.id;
    expect(ing.startsWith("skill:")).toBe(true);
    expect((await ingestAttestation(db, att)).accepted).toBe(true);
    expect((await popularity(db, { kind: "skill", k: 2 })).map((x) => x.id)).not.toContain(ing); // 1 producer
    await seedSynthetic(db, 2, [ing]);
    expect((await popularity(db, { kind: "skill", k: 2 })).map((x) => x.id)).toContain(ing); // 3 producers
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm build && npx vitest run dist/aggregator/__tests__/realdata.test.js`
Expected: FAIL.

- [ ] **Step 3: Rework `seed.ts`**

```typescript
// src/aggregator/seed.ts
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { AppDb } from "./schema.js";
import { producers, attestations, ingredients, usageEdges } from "./schema.js";

/** Insert n synthetic producers (`synthetic:<i>`) each using every id in `ids`, so aggregates clear a
 *  k-anon floor while real volume is low. Idempotent: a producer already present is skipped. */
export async function seedSynthetic(db: AppDb, n: number, ids: string[]): Promise<number> {
  let added = 0;
  for (let i = 0; i < n; i++) {
    const pubkey = `synthetic:${i}`;
    const ins = await db.insert(producers).values({ pubkey, attestCount: 1 }).onConflictDoNothing().returning({ pubkey: producers.pubkey });
    if (ins.length === 0) continue;
    added++;
    const aid = randomUUID();
    await db.insert(attestations).values({ id: aid, gemName: "synthetic", gemDigest: `synthetic:${i}`, producerPubkey: pubkey,
      harnessId: "claude-code", models: [], scanSessions: 1, scanSpanDays: 1, signalDigest: "synthetic" });
    for (const id of ids) {
      await db.insert(ingredients).values({ id, kind: "skill", idKind: "plugin" }).onConflictDoNothing();
      await db.insert(usageEdges).values({ attestationId: aid, ingredientId: id, invocations: 1, sessions: 1 });
    }
  }
  return added;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm build && npx vitest run dist/aggregator/__tests__/realdata.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/aggregator/seed.ts src/aggregator/__tests__/realdata.test.ts
git commit -m "refactor(aggregator): seed onto drizzle (idempotent)"
```

---

### Task 6: HTTP controller + app wiring

**Files:**
- Create: `src/aggregator.controller.ts`
- Modify: `src/index.ts` (register the controller + Drizzle client when `DATABASE_URL` is set)
- Test: `src/aggregator/__tests__/controller.test.ts`

**Interfaces:**
- Consumes: `ingestAttestation`, `popularity`, `coOccurrence`, `AppDb`, `schema`, `ensureSchema`; `DrizzleBindings`, `registerDrizzle` (`@agentback/drizzle`), `inject` (`@agentback/context`), `@api/@get/@post` (`@agentback/openapi`).
- Produces: `AggregatorController` (routes `POST /api/aggregator/ingest`, `GET /api/aggregator/popularity`, `GET /api/aggregator/co-occurrence`).

- [ ] **Step 1: Write the failing test (controller against an injected pglite drizzle client)**

```typescript
// src/aggregator/__tests__/controller.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTestDb } from "../testDb.js";
import { AggregatorController } from "../../aggregator.controller.js";
import { seedSynthetic } from "../seed.js";
import { buildAttestation, signAttestation } from "../../gem/attestation.js";
import { loadOrCreateIdentity } from "../../gem/identity.js";

const gem = { name: "demo", createdFrom: "claude", artifacts: [
  { type: "skill" as const, name: "brainstorming", source: "plugin:superpowers@m", content: "B" } ], checks: [], requiredSecrets: [] };
const signal = { root: "/p", flavor: "claude" as const, sessions: { scanned: 3, firstMs: 0, lastMs: 0, spanDays: 1 },
  artifacts: [{ type: "skill" as const, name: "brainstorming", root: null, invocations: 9, sessionsUsedIn: 3, lastUsedMs: 0, confidence: "high" as const }],
  unresolved: [], coOccurrence: [], shapes: [], notes: [], models: [{ id: "claude-opus-4-8", sessions: 3 }] };

describe("AggregatorController", () => {
  it("ingests a signed attestation and serves k-anon'd popularity; caller cannot lower k", async () => {
    const db = await makeTestDb();
    const c = new AggregatorController(db);
    const id = loadOrCreateIdentity(mkdtempSync(join(tmpdir(), "agg-id-")));
    const att = signAttestation(buildAttestation({ gem, signal, gemDigest: "sha256:c1", salt: "S" }), id, 1);
    const ing = att.ingredients.skills.find((s) => s.public)!.id;

    expect((await c.ingest({ body: att as never })).accepted).toBe(true);
    await seedSynthetic(db, 2, [ing]); // 3 producers total -> clears DEFAULT_K? only if DEFAULT_K<=3; assert below
    // The route applies DEFAULT_K and ignores any caller k: a malicious ?k=1 must NOT surface a 1-producer ingredient.
    const onlyOneProducer = signAttestation(buildAttestation({ gem: { ...gem, artifacts: [{ type: "skill", name: "solo", source: "plugin:x@m", content: "c" }] },
      signal: { ...signal, artifacts: [{ type: "skill", name: "solo", root: null, invocations: 1, sessionsUsedIn: 1, lastUsedMs: 0, confidence: "high" }] } as never, gemDigest: "sha256:solo", salt: "S" }), id, 1);
    await c.ingest({ body: onlyOneProducer as never });
    const soloId = onlyOneProducer.ingredients.skills.find((s) => s.public)!.id;
    const pop = await c.popularity({ query: { k: 1 } as never }); // caller tries k=1
    expect(pop.map((r) => r.id)).not.toContain(soloId); // still floored by DEFAULT_K — caller k ignored
  });

  it("rejects a tampered attestation", async () => {
    const db = await makeTestDb();
    const c = new AggregatorController(db);
    const id = loadOrCreateIdentity(mkdtempSync(join(tmpdir(), "agg-id-")));
    const att = signAttestation(buildAttestation({ gem, signal, gemDigest: "sha256:c2", salt: "S" }), id, 1);
    const r = await c.ingest({ body: { ...att, signature: "AAAA" } as never });
    expect(r).toEqual({ accepted: false, rejected: "bad-signature" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm build && npx vitest run dist/aggregator/__tests__/controller.test.js`
Expected: FAIL — `aggregator.controller.js` not found.

- [ ] **Step 3: Implement the controller**

```typescript
// src/aggregator.controller.ts
import { z } from "zod";
import { api, get, post } from "@agentback/openapi";
import { inject } from "@agentback/context";
import { DrizzleBindings } from "@agentback/drizzle";
import type { AppDb } from "./aggregator/schema.js";
import { ingestAttestation } from "./aggregator/ingest.js";
import { popularity, coOccurrence } from "./aggregator/aggregates.js";
import type { UsageAttestation } from "./gem/attestation.js";

// Loose body schema — the real gate is the core's verifyAttestation (ed25519 + consistency).
const IngestBody = z.object({ producer: z.object({ publicKey: z.string() }).passthrough(), signature: z.string(), gem: z.object({ digest: z.string() }).passthrough() }).passthrough();
const IngestResult = z.union([
  z.object({ accepted: z.literal(true), id: z.string(), publicIngredients: z.number(), privateCount: z.number(), idempotent: z.boolean() }),
  z.object({ accepted: z.literal(false), rejected: z.string() }),
]);
const PopQuery = z.object({ kind: z.string().optional(), limit: z.coerce.number().optional() }); // NOTE: no `k`
const PopResult = z.array(z.object({ id: z.string(), kind: z.string(), producers: z.number(), invocations: z.number(), sessions: z.number() }));
const CoQuery = z.object({ id: z.string(), limit: z.coerce.number().optional() }); // NOTE: no `k`
const CoResult = z.array(z.object({ id: z.string(), producers: z.number() }));

@api({ basePath: "/api/aggregator" })
export class AggregatorController {
  constructor(@inject(DrizzleBindings.CLIENT) private db: AppDb) {}

  @post("/ingest", { body: IngestBody, response: IngestResult })
  async ingest(input: { body: z.infer<typeof IngestBody> }): Promise<z.infer<typeof IngestResult>> {
    return ingestAttestation(this.db, input.body as unknown as UsageAttestation);
  }

  @get("/popularity", { query: PopQuery, response: PopResult })
  async popularity(input: { query: z.infer<typeof PopQuery> }): Promise<z.infer<typeof PopResult>> {
    // k is NEVER taken from the caller — the floor is server policy (DEFAULT_K).
    return popularity(this.db, { kind: input.query.kind, limit: input.query.limit });
  }

  @get("/co-occurrence", { query: CoQuery, response: CoResult })
  async coOccurrence(input: { query: z.infer<typeof CoQuery> }): Promise<z.infer<typeof CoResult>> {
    return coOccurrence(this.db, { id: input.query.id, limit: input.query.limit });
  }
}
```

- [ ] **Step 4: Wire into `src/index.ts`**

Read `src/index.ts`'s `createApp`. After `app.restController(GemController)`, add (only when configured):

```typescript
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { registerDrizzle } from "@agentback/drizzle";
import { schema, ensureSchema } from "./aggregator/schema.js";
import { AggregatorController } from "./aggregator.controller.js";

// inside createApp(...), after GemController registration:
if (process.env.DATABASE_URL) {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const db = drizzle(pool, { schema });
  await ensureSchema(db as never);
  registerDrizzle(app, db, { onStop: () => pool.end() });
  app.restController(AggregatorController);
}
```

If `DATABASE_URL` is unset, the controller is not registered (routes 404) — the rest of the server runs unchanged. (A dedicated `503 not-configured` body is a follow-up; not registering is acceptable for this slice.)

- [ ] **Step 5: Run tests + full suite**

Run: `pnpm build && npx vitest run dist/aggregator/__tests__/controller.test.js`
Expected: PASS.
Then: `rm -f tsconfig.tsbuildinfo && rm -rf dist && pnpm build && npx vitest run` — full suite, 0 failures.

- [ ] **Step 6: Commit**

```bash
git add src/aggregator.controller.ts src/index.ts src/aggregator/__tests__/controller.test.ts
git commit -m "feat(aggregator): HTTP controller (ingest + k-anon reads) wired into the rest app"
```

---

## Self-Review

**Spec coverage:**
- @agentback/drizzle adoption (registerDrizzle DI, schema-as-tables) → Tasks 1, 6.
- Dual driver (pglite tests / node-postgres prod) → Task 1 (`makeTestDb`), Task 6 (prod client).
- Core reworked onto Drizzle preserving public-only + k-anon-in-SQL + verify → Tasks 2–5 (verify untouched).
- k-anon server policy (no caller `k`) → Task 6 (`PopQuery`/`CoQuery` omit `k`; controller never passes it) + the controller test asserting a `?k=1` cannot surface a sub-floor ingredient.
- Endpoints ingest/popularity/co-occurrence → Task 6.
- `DATABASE_URL` config; unset → routes not registered → Task 6.

**Deferred (correctly out, per spec):** OAuth/account-binding, Blob, statistical detection/quarantine, UI, gated API, adoption-over-time, drizzle-kit migrations (ensureSchema covers slice 1), the actual cloud deploy + provisioning + `DATABASE_URL` secret.

**Placeholder scan:** none — every step has real Drizzle/TS + commands. `ensureSchema` is the explicit slice-1 schema mechanism (drizzle-kit migrations deferred), per the spec's stated property.

**Type consistency:** `AppDb` (Task 1) is the db param type in Tasks 2–6; `projectAttestation` return `{id,publicIngredients,privateCount}` (Task 2) spread into `IngestResult` (Task 3); `popularity`/`coOccurrence` + `DEFAULT_K` (Task 4) used in 5/6; `IngestResult` union matches the controller's `IngestResult` zod (Task 6). `verifyAttestation` is the unchanged Spec-A-symmetric verifier throughout.

**Known integration risks flagged for implementers:**
- `PgDatabase<any, typeof schema>` assignability: if the pglite or node-pg client doesn't structurally satisfy `AppDb` at a call site, localize with `as unknown as AppDb` at the *construction* site only (`makeTestDb`, the prod `drizzle(...)`), never by loosening core signatures.
- `@inject(DrizzleBindings.CLIENT)` requires the controller to be resolved through the app's DI container (it is — `app.restController(...)` constructs via the resolver). The controller test constructs it directly with a db, bypassing DI — which is fine for unit-testing the handlers.
- DI version alignment is already verified (single `@agentback/context@0.5.2`).
