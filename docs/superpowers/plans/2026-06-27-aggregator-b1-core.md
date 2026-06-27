# Aggregator B1 — Local Core Slice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the in-repo aggregator core — verify a signed Spec A attestation, project its **public** ingredients into an embedded Postgres (pglite) usage graph, and answer `popularity` / `co-occurrence` aggregates under a k-anonymity floor enforced in SQL.

**Architecture:** A pure `src/aggregator/` package. Verify/trust primitives are reused from `src/gem/` (no duplication). Storage is `@electric-sql/pglite` (embedded real Postgres, in-process) so the aggregate + k-anon SQL is the production SQL. No HTTP/OAuth/UI — `ingestAttestation()` is a plain async function a future hosted route will wrap.

**Tech Stack:** TypeScript (ESM, `type: module`), `@electric-sql/pglite` (already added), `node:crypto` (`randomUUID`), vitest (runs on compiled `dist/`).

**Spec:** `docs/superpowers/specs/2026-06-27-aggregator-b1-core-slice-design.md`.

## Global Constraints

- **ESM only.** Local imports use `.js` extensions. `type: module`.
- **Tests run on compiled `dist/`.** Build before testing; vitest `include` is `dist/**/__tests__/**/*.test.js`. Per-file: `pnpm build && npx vitest run dist/aggregator/__tests__/<name>.test.js`. After file rename/move, `rm -f tsconfig.tsbuildinfo && rm -rf dist` first (stale `.tsbuildinfo` makes `tsc -b` a no-op).
- **Reuse, do not duplicate.** Import `verify` from `src/gem/identity.js`, `canonicalJSON` + `UsageAttestation` from `src/gem/attestation.js`. Never reimplement signature/canonicalization logic.
- **Public-only graph.** `usage_edges`/`ingredients` rows are written ONLY for ingredients with `public === true`. Private (salted, unlinkable) ingredients are counted into `attestations.private_count` and never become rows.
- **k-anon lives in the SQL** (`HAVING count(distinct producer_pubkey) >= $K`), never a post-filter.
- **Determinism in tests.** Each test creates a fresh `await PGlite.create()` (in-memory) and migrates; attestation `id` uses `randomUUID()` so tests assert on projected *content*, not the id.
- **Scope:** signature + internal-consistency + idempotency + projection + two aggregates + seeding. Archive-bytes digest-reconcile, OAuth, quarantine/statistical detection, UI, and the hosted wrapper are OUT (the signature already covers `gem.digest`, so trusting the signed digest is acceptable for this telemetry core).

## Reused interfaces (from Spec A — exact)

```typescript
// src/gem/identity.ts
export function verify(publicKey: string, data: string, signatureB64: string): boolean;
// src/gem/attestation.ts
export function canonicalJSON(value: unknown): string;
export interface UsageAttestation {
  formatVersion: number; canonicalizerVersion: number;
  gem: { name: string; digest: string };
  producer: { publicKey: string; account: { provider: string; login: string } | null };
  source: { harness: { id: string }; models: string[]; scan: { sessions: number; spanDays: number; firstMs: number; lastMs: number } };
  ingredients: {
    skills: { id: string; idKind: string; public: boolean; invocations: number; sessions: number }[];
    mcps:   { id: string; idKind: string; public: boolean; invocations: number; sessions: number }[];
  };
  evidence: { signalDigest: string };
  signedAt: number; signature: string;
}
```

To verify a signature: `verify(att.producer.publicKey, canonicalJSON({ ...att, signature: undefined-removed }), att.signature)` — i.e. canonicalize the attestation **with the `signature` field removed** (destructure it out), exactly as Spec A signs.

---

### Task 1: Embedded Postgres handle + schema

**Files:**
- Create: `src/aggregator/db.ts`
- Test: `src/aggregator/__tests__/db.test.ts`

**Interfaces:**
- Produces:
  - `type DB = PGlite`
  - `SCHEMA: string` (the production DDL)
  - `createDb(): Promise<DB>` (creates in-memory pglite + applies `SCHEMA`)

- [ ] **Step 1: Write the failing test**

```typescript
// src/aggregator/__tests__/db.test.ts
import { describe, it, expect } from "vitest";
import { createDb } from "../db.js";

describe("createDb", () => {
  it("creates the schema and runs real Postgres SQL", async () => {
    const db = await createDb();
    await db.exec("insert into producers(pubkey) values ('ed25519:p1');");
    const r = await db.query<{ c: number }>("select count(*)::int as c from producers");
    expect(r.rows[0].c).toBe(1);
    // the four tables exist
    const t = await db.query<{ n: string }>(
      "select table_name as n from information_schema.tables where table_schema='public' order by 1");
    expect(t.rows.map((x) => x.n)).toEqual(["attestations", "ingredients", "producers", "usage_edges"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm build && npx vitest run dist/aggregator/__tests__/db.test.js`
Expected: FAIL — module `../db.js` not found.

- [ ] **Step 3: Implement `db.ts`**

```typescript
// src/aggregator/db.ts
import { PGlite } from "@electric-sql/pglite";

export type DB = PGlite;

/** Production Postgres DDL — validated on pglite here, identical on hosted Postgres later. */
export const SCHEMA = `
create table if not exists producers (
  pubkey       text primary key,
  first_seen   timestamptz not null default now(),
  attest_count int not null default 0
);
create table if not exists attestations (
  id              uuid primary key,
  gem_name        text not null,
  gem_digest      text not null unique,
  producer_pubkey text not null references producers(pubkey),
  harness_id      text not null,
  models          text[] not null default '{}',
  scan_sessions   int not null,
  scan_span_days  int not null,
  signal_digest   text not null,
  private_count   int not null default 0,
  trust_score     real not null default 1,
  quarantined     boolean not null default false,
  ingested_at     timestamptz not null default now()
);
create table if not exists ingredients (
  id           text primary key,
  kind         text not null,
  id_kind      text not null,
  display_name text,
  first_seen   timestamptz not null default now(),
  last_seen    timestamptz not null default now()
);
create table if not exists usage_edges (
  attestation_id uuid not null references attestations(id),
  ingredient_id  text not null references ingredients(id),
  invocations    int  not null,
  sessions       int  not null,
  primary key (attestation_id, ingredient_id)
);
`;

export async function createDb(): Promise<DB> {
  const db = await PGlite.create();
  await db.exec(SCHEMA);
  return db;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm build && npx vitest run dist/aggregator/__tests__/db.test.js`
Expected: PASS (real pglite SQL, four tables present).

- [ ] **Step 5: Commit**

```bash
git add src/aggregator/db.ts src/aggregator/__tests__/db.test.ts
git commit -m "feat(aggregator): pglite handle + usage-graph schema"
```

---

### Task 2: Attestation verification (signature + internal consistency)

**Files:**
- Create: `src/aggregator/ingest.ts`
- Test: `src/aggregator/__tests__/verify.test.ts`

**Interfaces:**
- Consumes: `verify` (`../gem/identity.js`), `canonicalJSON` + `UsageAttestation` (`../gem/attestation.js`).
- Produces:
  - `type VerifyResult = { ok: true } | { ok: false; reason: "bad-signature" | "inconsistent" }`
  - `verifyAttestation(att: UsageAttestation): VerifyResult` (pure; no DB)

- [ ] **Step 1: Write the failing test**

```typescript
// src/aggregator/__tests__/verify.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyAttestation } from "../ingest.js";
import { buildAttestation, signAttestation } from "../../gem/attestation.js";
import { loadOrCreateIdentity } from "../../gem/identity.js";

const gem = { name: "demo", createdFrom: "claude", artifacts: [
  { type: "mcp_server" as const, name: "gh", transport: "stdio" as const, config: { command: "npx", args: ["@modelcontextprotocol/server-github"] } },
], checks: [], requiredSecrets: [] };
const signal = { root: "/p", flavor: "claude" as const, sessions: { scanned: 4, firstMs: 0, lastMs: 0, spanDays: 1 },
  artifacts: [{ type: "mcp_server" as const, name: "gh", root: null, invocations: 7, sessionsUsedIn: 2, lastUsedMs: 0, confidence: "high" as const }],
  unresolved: [], coOccurrence: [], shapes: [], notes: [], models: [{ id: "claude-opus-4-8", sessions: 4 }] };

function signed() {
  const id = loadOrCreateIdentity(mkdtempSync(join(tmpdir(), "agg-id-")));
  return signAttestation(buildAttestation({ gem, signal, gemDigest: "sha256:aa", salt: "S" }), id, 1);
}

describe("verifyAttestation", () => {
  it("accepts a validly signed attestation", () => {
    expect(verifyAttestation(signed())).toEqual({ ok: true });
  });
  it("rejects a tampered signature", () => {
    const a = { ...signed(), signature: "AAAA" };
    expect(verifyAttestation(a)).toEqual({ ok: false, reason: "bad-signature" });
  });
  it("rejects internal inconsistency (ingredient sessions > scan sessions)", () => {
    const a = signed();
    a.ingredients.mcps[0].sessions = a.source.scan.sessions + 1; // mutating breaks the signature too,
    // so re-sign to isolate the consistency check:
    const id = loadOrCreateIdentity(mkdtempSync(join(tmpdir(), "agg-id-")));
    const resigned = signAttestation({ ...a, signature: "" }, id, 1);
    expect(verifyAttestation(resigned)).toEqual({ ok: false, reason: "inconsistent" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm build && npx vitest run dist/aggregator/__tests__/verify.test.js`
Expected: FAIL — `verifyAttestation` not exported.

- [ ] **Step 3: Implement `verifyAttestation` in `ingest.ts`**

```typescript
// src/aggregator/ingest.ts
import { verify } from "../gem/identity.js";
import { canonicalJSON, type UsageAttestation } from "../gem/attestation.js";

export type VerifyResult = { ok: true } | { ok: false; reason: "bad-signature" | "inconsistent" };

export function verifyAttestation(att: UsageAttestation): VerifyResult {
  const { signature, ...rest } = att;
  if (!verify(att.producer.publicKey, canonicalJSON(rest), signature)) return { ok: false, reason: "bad-signature" };
  const cap = att.source.scan.sessions;
  for (const row of [...att.ingredients.skills, ...att.ingredients.mcps]) {
    if (row.sessions > cap || row.invocations < row.sessions || row.sessions < 0 || row.invocations < 0) {
      return { ok: false, reason: "inconsistent" };
    }
  }
  return { ok: true };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm build && npx vitest run dist/aggregator/__tests__/verify.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/aggregator/ingest.ts src/aggregator/__tests__/verify.test.ts
git commit -m "feat(aggregator): verify attestation signature + internal consistency"
```

---

### Task 3: Projection into the usage graph (public-only)

**Files:**
- Create: `src/aggregator/project.ts`
- Test: `src/aggregator/__tests__/project.test.ts`

**Interfaces:**
- Consumes: `DB` (`../db.js`), `UsageAttestation` (`../gem/attestation.js`).
- Produces: `projectAttestation(db: DB, att: UsageAttestation): Promise<{ id: string; publicIngredients: number; privateCount: number }>` — upserts producer; inserts the attestation; writes `ingredients` + `usage_edges` for every **public** ingredient (harness, each model, public skills, public mcps); counts private skills/mcps into `private_count`. Harness/model edges use `invocations = sessions = scan.sessions`.

- [ ] **Step 1: Write the failing test**

```typescript
// src/aggregator/__tests__/project.test.ts
import { describe, it, expect } from "vitest";
import { createDb } from "../db.js";
import { projectAttestation } from "../project.js";

function att(pubkey: string, gemDigest: string) {
  return {
    formatVersion: 1, canonicalizerVersion: 3,
    gem: { name: "g", digest: gemDigest },
    producer: { publicKey: pubkey, account: null },
    source: { harness: { id: "claude-code" }, models: ["claude-opus-4-8"], scan: { sessions: 4, spanDays: 1, firstMs: 0, lastMs: 0 } },
    ingredients: {
      skills: [
        { id: "skill:superpowers@m/brainstorming", idKind: "plugin", public: true, invocations: 9, sessions: 3 },
        { id: "private:sha256:xyz", idKind: "private", public: false, invocations: 1, sessions: 1 },
      ],
      mcps: [{ id: "mcp:context7@m/context7", idKind: "plugin", public: true, invocations: 15, sessions: 4 }],
    },
    evidence: { signalDigest: "sha256:d" }, signedAt: 1, signature: "x",
  };
}

describe("projectAttestation", () => {
  it("writes public ingredients (+ harness + models) as edges and counts private", async () => {
    const db = await createDb();
    const r = await projectAttestation(db, att("ed25519:p1", "sha256:1") as never);
    expect(r.privateCount).toBe(1);
    // public ingredients: harness + 1 model + 1 skill + 1 mcp = 4
    expect(r.publicIngredients).toBe(4);
    const ids = (await db.query<{ id: string }>("select id from ingredients order by id")).rows.map((x) => x.id);
    expect(ids).toContain("claude-code");
    expect(ids).toContain("claude-opus-4-8");
    expect(ids).toContain("skill:superpowers@m/brainstorming");
    expect(ids).toContain("mcp:context7@m/context7");
    expect(ids).not.toContain("private:sha256:xyz"); // private never becomes a row
    const edge = (await db.query<{ invocations: number; sessions: number }>(
      "select invocations, sessions from usage_edges e join ingredients i on i.id=e.ingredient_id where i.id='mcp:context7@m/context7'")).rows[0];
    expect(edge).toEqual({ invocations: 15, sessions: 4 });
    const pc = (await db.query<{ private_count: number }>("select private_count from attestations")).rows[0];
    expect(pc.private_count).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm build && npx vitest run dist/aggregator/__tests__/project.test.js`
Expected: FAIL — `project.js` not found.

- [ ] **Step 3: Implement `project.ts`**

```typescript
// src/aggregator/project.ts
import { randomUUID } from "node:crypto";
import type { DB } from "./db.js";
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

export async function projectAttestation(db: DB, att: UsageAttestation): Promise<{ id: string; publicIngredients: number; privateCount: number }> {
  const { nodes, privateCount } = publicNodes(att);
  const id = randomUUID();
  await db.query("insert into producers(pubkey) values ($1) on conflict (pubkey) do update set attest_count = producers.attest_count + 1", [att.producer.publicKey]);
  await db.query(
    `insert into attestations(id, gem_name, gem_digest, producer_pubkey, harness_id, models, scan_sessions, scan_span_days, signal_digest, private_count)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [id, att.gem.name, att.gem.digest, att.producer.publicKey, att.source.harness.id, att.source.models,
     att.source.scan.sessions, att.source.scan.spanDays, att.evidence.signalDigest, privateCount]);
  for (const n of nodes) {
    await db.query(
      "insert into ingredients(id, kind, id_kind) values ($1,$2,$3) on conflict (id) do update set last_seen = now()",
      [n.id, n.kind, n.idKind]);
    await db.query(
      "insert into usage_edges(attestation_id, ingredient_id, invocations, sessions) values ($1,$2,$3,$4) on conflict do nothing",
      [id, n.id, n.invocations, n.sessions]);
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
git commit -m "feat(aggregator): project public ingredients into the usage graph"
```

---

### Task 4: `ingestAttestation` orchestration (verify + idempotency + project)

**Files:**
- Modify: `src/aggregator/ingest.ts`
- Test: `src/aggregator/__tests__/ingest.test.ts`

**Interfaces:**
- Consumes: `verifyAttestation` (this file), `projectAttestation` (`./project.js`), `DB` (`./db.js`).
- Produces:
  - `type IngestResult = { accepted: true; id: string; publicIngredients: number; privateCount: number; idempotent: boolean } | { accepted: false; rejected: "bad-signature" | "inconsistent" }`
  - `ingestAttestation(db: DB, att: UsageAttestation): Promise<IngestResult>` — verifies; if a row with the same `gem_digest` exists, returns the prior id with `idempotent: true` (no dup); else projects.

- [ ] **Step 1: Write the failing test**

```typescript
// src/aggregator/__tests__/ingest.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb } from "../db.js";
import { ingestAttestation } from "../ingest.js";
import { buildAttestation, signAttestation } from "../../gem/attestation.js";
import { loadOrCreateIdentity } from "../../gem/identity.js";

const gem = { name: "demo", createdFrom: "claude", artifacts: [
  { type: "skill" as const, name: "qa", source: "plugin:superpowers@m", content: "B" },
], checks: [], requiredSecrets: [] };
const signal = { root: "/p", flavor: "claude" as const, sessions: { scanned: 4, firstMs: 0, lastMs: 0, spanDays: 1 },
  artifacts: [{ type: "skill" as const, name: "qa", root: null, invocations: 5, sessionsUsedIn: 2, lastUsedMs: 0, confidence: "high" as const }],
  unresolved: [], coOccurrence: [], shapes: [], notes: [], models: [{ id: "claude-opus-4-8", sessions: 4 }] };
function make(digest: string) {
  const id = loadOrCreateIdentity(mkdtempSync(join(tmpdir(), "agg-id-")));
  return signAttestation(buildAttestation({ gem, signal, gemDigest: digest, salt: "S" }), id, 1);
}

describe("ingestAttestation", () => {
  it("accepts, projects, and is idempotent on gem_digest", async () => {
    const db = await createDb();
    const a = make("sha256:unique1");
    const r1 = await ingestAttestation(db, a);
    expect(r1.accepted).toBe(true);
    const r2 = await ingestAttestation(db, a); // re-POST same record
    expect(r2).toMatchObject({ accepted: true, idempotent: true });
    const n = (await db.query<{ c: number }>("select count(*)::int as c from attestations")).rows[0].c;
    expect(n).toBe(1); // no duplicate
  });
  it("rejects a tampered signature without writing", async () => {
    const db = await createDb();
    const r = await ingestAttestation(db, { ...make("sha256:u2"), signature: "AAAA" });
    expect(r).toEqual({ accepted: false, rejected: "bad-signature" });
    expect((await db.query<{ c: number }>("select count(*)::int as c from attestations")).rows[0].c).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm build && npx vitest run dist/aggregator/__tests__/ingest.test.js`
Expected: FAIL — `ingestAttestation` not exported.

- [ ] **Step 3: Add `ingestAttestation` to `ingest.ts`**

```typescript
// src/aggregator/ingest.ts — append
import type { DB } from "./db.js";
import { projectAttestation } from "./project.js";

export type IngestResult =
  | { accepted: true; id: string; publicIngredients: number; privateCount: number; idempotent: boolean }
  | { accepted: false; rejected: "bad-signature" | "inconsistent" };

export async function ingestAttestation(db: DB, att: UsageAttestation): Promise<IngestResult> {
  const v = verifyAttestation(att);
  if (!v.ok) return { accepted: false, rejected: v.reason };
  const prior = await db.query<{ id: string; private_count: number }>(
    "select id, private_count from attestations where gem_digest = $1", [att.gem.digest]);
  if (prior.rows.length > 0) {
    const row = prior.rows[0];
    const pub = await db.query<{ c: number }>("select count(*)::int as c from usage_edges where attestation_id = $1", [row.id]);
    return { accepted: true, id: row.id, publicIngredients: pub.rows[0].c, privateCount: row.private_count, idempotent: true };
  }
  const p = await projectAttestation(db, att);
  return { accepted: true, ...p, idempotent: false };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm build && npx vitest run dist/aggregator/__tests__/ingest.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/aggregator/ingest.ts src/aggregator/__tests__/ingest.test.ts
git commit -m "feat(aggregator): ingestAttestation — verify + idempotent + project"
```

---

### Task 5: Aggregates with k-anonymity in SQL

**Files:**
- Create: `src/aggregator/aggregates.ts`
- Test: `src/aggregator/__tests__/aggregates.test.ts`

**Interfaces:**
- Consumes: `DB` (`./db.js`).
- Produces:
  - `popularity(db: DB, opts: { kind?: string; limit?: number; k?: number }): Promise<{ id: string; kind: string; producers: number; invocations: number; sessions: number }[]>`
  - `coOccurrence(db: DB, opts: { id: string; limit?: number; k?: number }): Promise<{ id: string; producers: number }[]>`
  - k-anon floor `k` defaults to 1; enforced via SQL `HAVING`.

- [ ] **Step 1: Write the failing test**

```typescript
// src/aggregator/__tests__/aggregates.test.ts
import { describe, it, expect } from "vitest";
import { createDb } from "../db.js";
import { projectAttestation } from "../project.js";
import { popularity, coOccurrence } from "../aggregates.js";

function att(pubkey: string, digest: string, skills: string[]) {
  return { formatVersion: 1, canonicalizerVersion: 3, gem: { name: "g", digest },
    producer: { publicKey: pubkey, account: null },
    source: { harness: { id: "claude-code" }, models: [], scan: { sessions: 2, spanDays: 1, firstMs: 0, lastMs: 0 } },
    ingredients: { skills: skills.map((id) => ({ id, idKind: "plugin", public: true, invocations: 2, sessions: 1 })), mcps: [] },
    evidence: { signalDigest: "d" }, signedAt: 1, signature: "x" } as never;
}

describe("aggregates + k-anon", () => {
  it("popularity counts distinct producers and enforces k-anon in SQL", async () => {
    const db = await createDb();
    await projectAttestation(db, att("ed25519:p1", "d1", ["skill:a", "skill:b"]));
    await projectAttestation(db, att("ed25519:p2", "d2", ["skill:a"]));
    await projectAttestation(db, att("ed25519:p3", "d3", ["skill:a"]));
    // skill:a used by 3 producers; skill:b by 1
    const k2 = await popularity(db, { kind: "skill", k: 2 });
    expect(k2.map((r) => r.id)).toEqual(["skill:a"]);          // skill:b suppressed at K=2
    expect(k2[0].producers).toBe(3);
    const k1 = await popularity(db, { kind: "skill", k: 1 });
    expect(k1.map((r) => r.id).sort()).toEqual(["skill:a", "skill:b"]);
  });
  it("coOccurrence finds partners sharing a producer, k-anon enforced", async () => {
    const db = await createDb();
    await projectAttestation(db, att("ed25519:p1", "d1", ["skill:a", "skill:x"]));
    await projectAttestation(db, att("ed25519:p2", "d2", ["skill:a", "skill:x"]));
    const co = await coOccurrence(db, { id: "skill:a", k: 2 });
    expect(co.map((r) => r.id)).toContain("skill:x");
    expect(co.find((r) => r.id === "skill:x")!.producers).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm build && npx vitest run dist/aggregator/__tests__/aggregates.test.js`
Expected: FAIL — `aggregates.js` not found.

- [ ] **Step 3: Implement `aggregates.ts`**

```typescript
// src/aggregator/aggregates.ts
import type { DB } from "./db.js";

export async function popularity(
  db: DB, opts: { kind?: string; limit?: number; k?: number } = {},
): Promise<{ id: string; kind: string; producers: number; invocations: number; sessions: number }[]> {
  const k = opts.k ?? 1, limit = opts.limit ?? 100;
  const r = await db.query<{ id: string; kind: string; producers: number; invocations: number; sessions: number }>(
    `select e.ingredient_id as id, i.kind,
            count(distinct a.producer_pubkey)::int as producers,
            sum(e.invocations)::int as invocations, sum(e.sessions)::int as sessions
     from usage_edges e
     join attestations a on a.id = e.attestation_id and not a.quarantined
     join ingredients  i on i.id = e.ingredient_id
     where ($1::text is null or i.kind = $1)
     group by e.ingredient_id, i.kind
     having count(distinct a.producer_pubkey) >= $2
     order by producers desc, invocations desc
     limit $3`,
    [opts.kind ?? null, k, limit]);
  return r.rows;
}

export async function coOccurrence(
  db: DB, opts: { id: string; limit?: number; k?: number },
): Promise<{ id: string; producers: number }[]> {
  const k = opts.k ?? 1, limit = opts.limit ?? 50;
  const r = await db.query<{ id: string; producers: number }>(
    `select e2.ingredient_id as id, count(distinct a.producer_pubkey)::int as producers
     from usage_edges e1
     join usage_edges e2 on e2.attestation_id = e1.attestation_id and e2.ingredient_id <> e1.ingredient_id
     join attestations a on a.id = e1.attestation_id and not a.quarantined
     where e1.ingredient_id = $1
     group by e2.ingredient_id
     having count(distinct a.producer_pubkey) >= $2
     order by producers desc
     limit $3`,
    [opts.id, k, limit]);
  return r.rows;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm build && npx vitest run dist/aggregator/__tests__/aggregates.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/aggregator/aggregates.ts src/aggregator/__tests__/aggregates.test.ts
git commit -m "feat(aggregator): popularity + co-occurrence aggregates with k-anon in SQL"
```

---

### Task 6: Synthetic seeding + real-data integration

**Files:**
- Create: `src/aggregator/seed.ts`
- Test: `src/aggregator/__tests__/realdata.test.ts`

**Interfaces:**
- Consumes: `DB`, `projectAttestation`, `popularity`.
- Produces: `seedSynthetic(db: DB, n: number, ingredientIds: string[]): Promise<number>` — inserts `n` synthetic producers (pubkeys `synthetic:<i>`) each using all `ingredientIds`, so aggregates clear k-anon. Returns producers added.

- [ ] **Step 1: Write the failing test (seeding demonstrates the moat + a real signed attestation lands)**

```typescript
// src/aggregator/__tests__/realdata.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb } from "../db.js";
import { ingestAttestation } from "../ingest.js";
import { seedSynthetic } from "../seed.js";
import { popularity } from "../aggregates.js";
import { buildAttestation, signAttestation } from "../../gem/attestation.js";
import { loadOrCreateIdentity } from "../../gem/identity.js";

const gem = { name: "demo", createdFrom: "claude", artifacts: [
  { type: "skill" as const, name: "brainstorming", source: "plugin:superpowers@claude-plugins-official", content: "B" },
], checks: [], requiredSecrets: [] };
const signal = { root: "/p", flavor: "claude" as const, sessions: { scanned: 3, firstMs: 0, lastMs: 0, spanDays: 1 },
  artifacts: [{ type: "skill" as const, name: "brainstorming", root: null, invocations: 9, sessionsUsedIn: 3, lastUsedMs: 0, confidence: "high" as const }],
  unresolved: [], coOccurrence: [], shapes: [], notes: [], models: [{ id: "claude-opus-4-8", sessions: 3 }] };

describe("seeding + real signed attestation", () => {
  it("a real attestation's public ingredient surfaces in popularity once k-anon is met via seeding", async () => {
    const db = await createDb();
    const id = loadOrCreateIdentity(mkdtempSync(join(tmpdir(), "agg-id-")));
    const att = signAttestation(buildAttestation({ gem, signal, gemDigest: "sha256:real", salt: "S" }), id, 1);
    const ing = att.ingredients.skills.find((s) => s.public)!.id; // e.g. skill:superpowers@.../brainstorming
    expect(ing.startsWith("skill:")).toBe(true);

    const r = await ingestAttestation(db, att);
    expect(r.accepted).toBe(true);
    // with only 1 real producer, k=2 hides it:
    expect((await popularity(db, { kind: "skill", k: 2 })).map((x) => x.id)).not.toContain(ing);
    // seed 2 synthetic producers also using it -> now 3 producers -> visible at k=2:
    await seedSynthetic(db, 2, [ing]);
    expect((await popularity(db, { kind: "skill", k: 2 })).map((x) => x.id)).toContain(ing);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm build && npx vitest run dist/aggregator/__tests__/realdata.test.js`
Expected: FAIL — `seed.js` not found.

- [ ] **Step 3: Implement `seed.ts`**

```typescript
// src/aggregator/seed.ts
import { randomUUID } from "node:crypto";
import type { DB } from "./db.js";

/** Insert n synthetic producers (pubkey `synthetic:<i>`) each using every ingredient in `ids`,
 *  so aggregates can clear a k-anon floor while real producer volume is still low. */
export async function seedSynthetic(db: DB, n: number, ids: string[]): Promise<number> {
  for (let i = 0; i < n; i++) {
    const pubkey = `synthetic:${i}`;
    await db.query("insert into producers(pubkey) values ($1) on conflict (pubkey) do nothing", [pubkey]);
    const aid = randomUUID();
    await db.query(
      `insert into attestations(id, gem_name, gem_digest, producer_pubkey, harness_id, models, scan_sessions, scan_span_days, signal_digest)
       values ($1,'synthetic',$2,$3,'claude-code','{}',1,1,'synthetic')`,
      [aid, `synthetic:${i}:${randomUUID()}`, pubkey]);
    for (const id of ids) {
      await db.query("insert into ingredients(id, kind, id_kind) values ($1,'skill','plugin') on conflict (id) do nothing", [id]);
      await db.query("insert into usage_edges(attestation_id, ingredient_id, invocations, sessions) values ($1,$2,1,1) on conflict do nothing", [aid, id]);
    }
  }
  return n;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm build && npx vitest run dist/aggregator/__tests__/realdata.test.js`
Expected: PASS.

- [ ] **Step 5: Run the full suite + commit**

```bash
rm -f tsconfig.tsbuildinfo && rm -rf dist && pnpm build && npx vitest run
git add src/aggregator/seed.ts src/aggregator/__tests__/realdata.test.ts
git commit -m "feat(aggregator): synthetic seeding + real-attestation integration test"
```

---

## Self-Review

**Spec coverage:**
- Local core, same repo, reuse Spec A verify → Tasks 2/4 (import `verify`/`canonicalJSON`).
- pglite storage, production SQL → Task 1 (`SCHEMA`), Task 5 (real aggregate SQL).
- Public-only graph; private → opaque count → Task 3 (`publicNodes`, `private_count`).
- gem.digest = signed value; ed25519 = producer → Tasks 2/3/4.
- popularity + co-occurrence; k-anon in SQL → Task 5.
- synthetic seeding to demo with ~1 producer → Task 6.
- ingest verify cases / projection / aggregate correctness / k-anon property / real-data → Tasks 2,3,4,5,6 tests.

**Deferred (correctly out, per spec):** archive-bytes digest-reconcile, OAuth, quarantine/statistical detection, adoption-over-time, hosted Next.js wrapper, UI, gated API. `trust_score`/`quarantined` columns exist (aggregates already filter `not quarantined`) so the statistical layer drops in without a migration.

**Placeholder scan:** none — every step has real SQL/TS + exact run commands. `schema.sql` from the spec is realized as the exported `SCHEMA` constant in `db.ts` (dist-safe; trivially extractable to a `.sql` file for the hosted slice).

**Type consistency:** `DB` (Task 1) consumed in 3/4/5/6; `VerifyResult`/`verifyAttestation` (Task 2) consumed in 4; `projectAttestation` return `{ id, publicIngredients, privateCount }` (Task 3) spread into `IngestResult` (Task 4); `popularity`/`coOccurrence` (Task 5) used in 6. `UsageAttestation` is the Spec A type throughout.

**Note for implementers:** pglite is async and wasm-backed; the first `PGlite.create()` per test takes ~0.5–1s — well within vitest's 15s timeout. Use a fresh in-memory db per test (no shared state).
