# Memory Providers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a two-way sync bridge between AgentGem and external AI memory providers (mem0 first): pull provider memories into the local recall index (searchable) and push consent-gated distilled facts/outcomes out via a curation outbox.

**Architecture:** A new `@agentgem/memory` package holds a provider-agnostic adapter seam (`pull`/`push`/`test`), a registry (mem0 implemented, three stubs), local JSON state (config, cursors, outbox, pushed-keys), a pull→recall mapper, and a pure push-candidate builder. `src/goldmine/memoryRoutes.ts` exposes local-core-only REST routes (duck-typed Express, mirroring `recallRoutes.ts`). The console gets an API client + a Settings "Memory providers" panel and an outbox curation surface.

**Tech Stack:** TypeScript (ESM, NodeNext), Node `node:sqlite` via `@agentgem/recall`, Zod (already in repo), Vitest, duck-typed Express (no `@types/express`), React (console).

## Global Constraints

- ESM only, `.js` import specifiers, `NodeNext` module resolution — match sibling packages.
- Node `>=24` (repo floor).
- All sync runs in the **local core process only** — never the hosted API, never the desktop client.
- Secrets file `~/.agentgem/memory-providers.json` MUST be written with mode `0600`.
- State files live under `join(agentgemHome(), ".agentgem", <file>)` using `agentgemHome()` from `@agentgem/model` (returns the home root; `.agentgem/` is nested — same pattern as `defaultRecallDbPath()`).
- Provider ids are exactly: `"mem0" | "supermemory" | "zep" | "letta"`. Only `mem0` is implemented in v1; the other three are stubs whose methods reject with a `NotImplementedError`.
- Every candidate MUST pass through `@agentgem/insight` scrubbing (`scrubProse`) before being written to the outbox.
- Pulled memories map to recall `chunks` under agent namespace `memory:<provider>` (e.g. `memory:mem0`), one chunk per memory, `turn = 0`.
- Do NOT modify `@agentgem/recall`'s public API — use the existing `RecallIndex.upsertSession(meta, chunks, stamp)`.
- No new runtime dependencies. Use global `fetch` (Node 24) for provider HTTP.

---

## File Structure

**New package `packages/memory/`:**
- `package.json`, `tsconfig.json` — package scaffold (`@agentgem/memory`).
- `src/index.ts` — public exports.
- `src/types.ts` — `MemoryRecord`, `ProviderConfig`, `PushCandidate`, `MemoryProvider`, `NotImplementedError`.
- `src/registry.ts` — `getProvider(id)`, `listProviderIds()`.
- `src/config.ts` — `loadProviderConfigs()`, `saveProviderConfig()`, `configPath()`.
- `src/cursors.ts` — `readCursor(id)`, `writeCursor(id, ms)`.
- `src/providers/mem0.ts` — the mem0 adapter.
- `src/providers/stub.ts` — `makeStub(id)` for the three unimplemented providers.
- `src/pull.ts` — `pullIntoRecall(provider, cfg, index, since)`.
- `src/candidates.ts` — `RawSignal`, `buildPushCandidates(signals, alreadyPushed)`.
- `src/outbox.ts` — `readOutbox()`, `writeOutbox()`, `approveAndPush()`, pushed-keys tracking.
- `src/__tests__/*.test.ts` — one test file per unit.

**Core wiring:**
- `src/goldmine/memoryRoutes.ts` — `registerMemoryRoutes(app, deps, guard?)`.
- Modify `src/goldmine/<server bootstrap>` — mount the routes (exact file located in Task 8).

**Console:**
- `packages/console/src/api/memory.ts` — typed client for the memory routes.
- `packages/console/src/panels/Memory/index.tsx` — providers panel + outbox curation.
- Modify the console panel registry (exact file located in Task 9).

---

## Task 1: Scaffold `@agentgem/memory` package + core types

**Files:**
- Create: `packages/memory/package.json`
- Create: `packages/memory/tsconfig.json`
- Create: `packages/memory/src/types.ts`
- Create: `packages/memory/src/index.ts`
- Test: `packages/memory/src/__tests__/types.test.ts`

**Interfaces:**
- Produces: `MemoryRecord`, `ProviderConfig`, `PushCandidate`, `MemoryProvider`, `NotImplementedError`, `ProviderId`.

- [ ] **Step 1: Copy a sibling package.json as the template**

Read `packages/recall/package.json`, then create `packages/memory/package.json` mirroring its shape:

```json
{
  "name": "@agentgem/memory",
  "version": "0.1.0",
  "description": "Two-way sync bridge to external AI memory providers (mem0 first): pull into recall, push consent-gated candidates out.",
  "license": "MIT",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } },
  "scripts": { "build": "tsc -b", "test": "vitest run" },
  "dependencies": {
    "@agentgem/base": "workspace:*",
    "@agentgem/model": "workspace:*",
    "@agentgem/recall": "workspace:*",
    "@agentgem/insight": "workspace:*"
  }
}
```

- [ ] **Step 2: Create tsconfig.json mirroring the sibling**

Copy `packages/recall/tsconfig.json` verbatim into `packages/memory/tsconfig.json` (same `extends`, `compilerOptions.outDir`, `references`). Add project references for `@agentgem/base`, `@agentgem/model`, `@agentgem/recall`, `@agentgem/insight` matching how `packages/recall/tsconfig.json` references its deps.

- [ ] **Step 3: Write the failing test**

`packages/memory/src/__tests__/types.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { NotImplementedError, type ProviderId } from "../types.js";

describe("memory types", () => {
  it("NotImplementedError carries the provider id", () => {
    const err = new NotImplementedError("zep");
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain("zep");
    expect(err.providerId).toBe("zep");
  });

  it("ProviderId is a closed set (compile-time) — sanity at runtime", () => {
    const ids: ProviderId[] = ["mem0", "supermemory", "zep", "letta"];
    expect(ids).toHaveLength(4);
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `cd packages/memory && npx vitest run src/__tests__/types.test.ts`
Expected: FAIL — cannot find module `../types.js`.

- [ ] **Step 5: Write `src/types.ts`**

```ts
export type ProviderId = "mem0" | "supermemory" | "zep" | "letta";

export interface MemoryRecord {
  id: string;              // provider-native id (stable; drives dedupe + incremental)
  text: string;            // the memory content
  updatedAt: number;       // epoch ms — incremental pull cursor
  metadata?: Record<string, unknown>;
}

export interface ProviderConfig {
  enabled: boolean;
  apiKey: string;
  baseUrl?: string;
  userId?: string;
}

export type CandidateKind = "fact" | "preference" | "outcome";

export interface PushCandidate {
  key: string;             // stable hash of scrubbed text — dedupe + re-push guard
  text: string;            // already scrubbed
  kind: CandidateKind;
  source: string;          // e.g. "distill:project-x" | "scorecard:gem-y"
}

export interface MemoryProvider {
  readonly id: ProviderId;
  test(cfg: ProviderConfig): Promise<{ ok: boolean; detail?: string }>;
  pull(cfg: ProviderConfig, since?: number): AsyncIterable<MemoryRecord>;
  push(cfg: ProviderConfig, m: PushCandidate): Promise<{ id: string }>;
}

export class NotImplementedError extends Error {
  constructor(public readonly providerId: ProviderId) {
    super(`memory provider '${providerId}' is not implemented yet`);
    this.name = "NotImplementedError";
  }
}
```

- [ ] **Step 6: Write `src/index.ts`**

```ts
export * from "./types.js";
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `cd packages/memory && npx vitest run src/__tests__/types.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 8: Verify the workspace picks up the package**

Run: `pnpm install` (from repo root) then `pnpm -F @agentgem/memory build`
Expected: install links the workspace package; build emits `packages/memory/dist/index.js`.

- [ ] **Step 9: Commit**

```bash
git add packages/memory/package.json packages/memory/tsconfig.json packages/memory/src/types.ts packages/memory/src/index.ts packages/memory/src/__tests__/types.test.ts pnpm-lock.yaml
git commit -m "feat(memory): scaffold @agentgem/memory package + adapter types"
```

---

## Task 2: Provider config store (secrets, 0600)

**Files:**
- Create: `packages/memory/src/config.ts`
- Modify: `packages/memory/src/index.ts`
- Test: `packages/memory/src/__tests__/config.test.ts`

**Interfaces:**
- Consumes: `ProviderConfig`, `ProviderId` (Task 1); `agentgemHome()` from `@agentgem/model`.
- Produces: `configPath(): string`, `loadProviderConfigs(): Partial<Record<ProviderId, ProviderConfig>>`, `saveProviderConfig(id: ProviderId, cfg: ProviderConfig): void`.

- [ ] **Step 1: Write the failing test**

`packages/memory/src/__tests__/config.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProviderConfigs, saveProviderConfig, configPath } from "../config.js";

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "agm-mem-")); process.env.AGENTGEM_HOME = home; });
afterEach(() => { delete process.env.AGENTGEM_HOME; rmSync(home, { recursive: true, force: true }); });

describe("config store", () => {
  it("returns {} when no file exists", () => {
    expect(loadProviderConfigs()).toEqual({});
  });

  it("round-trips a saved config and writes 0600", () => {
    saveProviderConfig("mem0", { enabled: true, apiKey: "sk-1", userId: "u1" });
    const cfgs = loadProviderConfigs();
    expect(cfgs.mem0).toEqual({ enabled: true, apiKey: "sk-1", userId: "u1" });
    const mode = statSync(configPath()).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("merges without clobbering other providers", () => {
    saveProviderConfig("mem0", { enabled: true, apiKey: "a" });
    saveProviderConfig("zep", { enabled: false, apiKey: "b" });
    const cfgs = loadProviderConfigs();
    expect(cfgs.mem0?.apiKey).toBe("a");
    expect(cfgs.zep?.apiKey).toBe("b");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/memory && npx vitest run src/__tests__/config.test.ts`
Expected: FAIL — cannot find module `../config.js`.

- [ ] **Step 3: Write `src/config.ts`**

```ts
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { agentgemHome } from "@agentgem/model";
import type { ProviderConfig, ProviderId } from "./types.js";

type ConfigMap = Partial<Record<ProviderId, ProviderConfig>>;

export function configPath(): string {
  return join(agentgemHome(), ".agentgem", "memory-providers.json");
}

export function loadProviderConfigs(): ConfigMap {
  const p = configPath();
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, "utf8")) as ConfigMap;
  } catch {
    return {};
  }
}

export function saveProviderConfig(id: ProviderId, cfg: ProviderConfig): void {
  const p = configPath();
  mkdirSync(dirname(p), { recursive: true });
  const all = loadProviderConfigs();
  all[id] = cfg;
  writeFileSync(p, JSON.stringify(all, null, 2), { mode: 0o600 });
}
```

- [ ] **Step 4: Export from index**

Add to `packages/memory/src/index.ts`:

```ts
export * from "./config.js";
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd packages/memory && npx vitest run src/__tests__/config.test.ts`
Expected: PASS (3 tests).

> Note on 0600: `writeFileSync` applies `mode` only when creating the file. The round-trip test creates a fresh temp home each run, so the first write creates the file — the assertion holds. If a pre-existing file needs its mode enforced, that is out of scope for v1.

- [ ] **Step 6: Commit**

```bash
git add packages/memory/src/config.ts packages/memory/src/index.ts packages/memory/src/__tests__/config.test.ts
git commit -m "feat(memory): provider config store with 0600 secrets file"
```

---

## Task 3: Pull cursor store

**Files:**
- Create: `packages/memory/src/cursors.ts`
- Modify: `packages/memory/src/index.ts`
- Test: `packages/memory/src/__tests__/cursors.test.ts`

**Interfaces:**
- Consumes: `ProviderId` (Task 1); `agentgemHome()`.
- Produces: `readCursor(id: ProviderId): number | undefined`, `writeCursor(id: ProviderId, ms: number): void`.

- [ ] **Step 1: Write the failing test**

`packages/memory/src/__tests__/cursors.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCursor, writeCursor } from "../cursors.js";

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "agm-cur-")); process.env.AGENTGEM_HOME = home; });
afterEach(() => { delete process.env.AGENTGEM_HOME; rmSync(home, { recursive: true, force: true }); });

describe("cursor store", () => {
  it("returns undefined before any write", () => {
    expect(readCursor("mem0")).toBeUndefined();
  });
  it("round-trips per provider", () => {
    writeCursor("mem0", 1000);
    writeCursor("zep", 2000);
    expect(readCursor("mem0")).toBe(1000);
    expect(readCursor("zep")).toBe(2000);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/memory && npx vitest run src/__tests__/cursors.test.ts`
Expected: FAIL — cannot find module `../cursors.js`.

- [ ] **Step 3: Write `src/cursors.ts`**

```ts
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { agentgemHome } from "@agentgem/model";
import type { ProviderId } from "./types.js";

function cursorPath(): string {
  return join(agentgemHome(), ".agentgem", "memory-cursors.json");
}

function load(): Partial<Record<ProviderId, number>> {
  const p = cursorPath();
  if (!existsSync(p)) return {};
  try { return JSON.parse(readFileSync(p, "utf8")); } catch { return {}; }
}

export function readCursor(id: ProviderId): number | undefined {
  return load()[id];
}

export function writeCursor(id: ProviderId, ms: number): void {
  const p = cursorPath();
  mkdirSync(dirname(p), { recursive: true });
  const all = load();
  all[id] = ms;
  writeFileSync(p, JSON.stringify(all, null, 2));
}
```

- [ ] **Step 4: Export + run + commit**

Add `export * from "./cursors.js";` to `src/index.ts`.
Run: `cd packages/memory && npx vitest run src/__tests__/cursors.test.ts` → Expected: PASS (2 tests).

```bash
git add packages/memory/src/cursors.ts packages/memory/src/index.ts packages/memory/src/__tests__/cursors.test.ts
git commit -m "feat(memory): per-provider pull cursor store"
```

---

## Task 4: mem0 adapter + stub factory + registry

**Files:**
- Create: `packages/memory/src/providers/mem0.ts`
- Create: `packages/memory/src/providers/stub.ts`
- Create: `packages/memory/src/registry.ts`
- Modify: `packages/memory/src/index.ts`
- Test: `packages/memory/src/__tests__/mem0.test.ts`
- Test: `packages/memory/src/__tests__/registry.test.ts`

**Interfaces:**
- Consumes: `MemoryProvider`, `MemoryRecord`, `ProviderConfig`, `ProviderId`, `PushCandidate`, `NotImplementedError` (Task 1).
- Produces: `mem0Provider: MemoryProvider`, `makeStub(id: ProviderId): MemoryProvider`, `getProvider(id: ProviderId): MemoryProvider`, `listProviderIds(): ProviderId[]`, `IMPLEMENTED: ReadonlySet<ProviderId>`.

> mem0 REST shape used below (hosted default `https://api.mem0.ai`): `POST /v1/memories/` with `{ messages, user_id }` to add; `GET /v1/memories/?user_id=` to list. **Confirm the exact request/response shape against current mem0 docs during this task** and adjust the request bodies/parsers if the API differs — the test uses a `fetch` mock, so update the mock alongside the implementation to keep them honest.

- [ ] **Step 1: Write the failing mem0 test**

`packages/memory/src/__tests__/mem0.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { mem0Provider } from "../providers/mem0.js";
import type { ProviderConfig } from "../types.js";

const cfg: ProviderConfig = { enabled: true, apiKey: "sk-test", userId: "u1" };

function mockFetch(json: unknown, ok = true, status = 200) {
  return vi.fn(async () => ({ ok, status, json: async () => json, text: async () => JSON.stringify(json) })) as unknown as typeof fetch;
}

afterEach(() => vi.restoreAllMocks());

describe("mem0 adapter", () => {
  it("test() reports ok on a 200", async () => {
    globalThis.fetch = mockFetch({ results: [] });
    const r = await mem0Provider.test(cfg);
    expect(r.ok).toBe(true);
  });

  it("test() reports not-ok on a 401", async () => {
    globalThis.fetch = mockFetch({ detail: "bad key" }, false, 401);
    const r = await mem0Provider.test(cfg);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("401");
  });

  it("pull() maps results to MemoryRecord and filters by since", async () => {
    globalThis.fetch = mockFetch({ results: [
      { id: "m1", memory: "likes dark mode", updated_at: "2026-07-10T00:00:00Z" },
      { id: "m2", memory: "prefers vitest", updated_at: "2026-07-12T00:00:00Z" },
    ] });
    const out = [];
    for await (const rec of mem0Provider.pull(cfg, Date.parse("2026-07-11T00:00:00Z"))) out.push(rec);
    expect(out).toEqual([
      { id: "m2", text: "prefers vitest", updatedAt: Date.parse("2026-07-12T00:00:00Z"), metadata: undefined },
    ]);
  });

  it("push() posts the candidate and returns the new id", async () => {
    const f = mockFetch({ results: [{ id: "new-1" }] });
    globalThis.fetch = f;
    const r = await mem0Provider.push(cfg, { key: "k", text: "raymond uses pnpm", kind: "preference", source: "distill:x" });
    expect(r.id).toBe("new-1");
    expect(f).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/memory && npx vitest run src/__tests__/mem0.test.ts`
Expected: FAIL — cannot find module `../providers/mem0.js`.

- [ ] **Step 3: Write `src/providers/mem0.ts`**

```ts
import type { MemoryProvider, MemoryRecord, ProviderConfig, PushCandidate } from "../types.js";

const DEFAULT_BASE = "https://api.mem0.ai";

function headers(cfg: ProviderConfig): Record<string, string> {
  return { Authorization: `Token ${cfg.apiKey}`, "Content-Type": "application/json" };
}
function base(cfg: ProviderConfig): string {
  return (cfg.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, "");
}

interface Mem0Row { id: string; memory?: string; text?: string; updated_at?: string; metadata?: Record<string, unknown> }

export const mem0Provider: MemoryProvider = {
  id: "mem0",

  async test(cfg) {
    const res = await fetch(`${base(cfg)}/v1/memories/?user_id=${encodeURIComponent(cfg.userId ?? "")}`, { headers: headers(cfg) });
    if (res.ok) return { ok: true };
    return { ok: false, detail: `mem0 returned ${res.status}` };
  },

  async *pull(cfg, since) {
    const res = await fetch(`${base(cfg)}/v1/memories/?user_id=${encodeURIComponent(cfg.userId ?? "")}`, { headers: headers(cfg) });
    if (!res.ok) throw new Error(`mem0 pull failed: ${res.status}`);
    const body = (await res.json()) as { results?: Mem0Row[] };
    for (const row of body.results ?? []) {
      const text = row.memory ?? row.text ?? "";
      const updatedAt = row.updated_at ? Date.parse(row.updated_at) : 0;
      if (!text) continue;
      if (since !== undefined && updatedAt <= since) continue;
      yield { id: row.id, text, updatedAt, metadata: row.metadata } satisfies MemoryRecord;
    }
  },

  async push(cfg, m: PushCandidate) {
    const res = await fetch(`${base(cfg)}/v1/memories/`, {
      method: "POST",
      headers: headers(cfg),
      body: JSON.stringify({ messages: [{ role: "user", content: m.text }], user_id: cfg.userId }),
    });
    if (!res.ok) throw new Error(`mem0 push failed: ${res.status}`);
    const body = (await res.json()) as { results?: { id: string }[] };
    return { id: body.results?.[0]?.id ?? "" };
  },
};
```

- [ ] **Step 4: Run the mem0 test to verify it passes**

Run: `cd packages/memory && npx vitest run src/__tests__/mem0.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Write the failing registry test**

`packages/memory/src/__tests__/registry.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { getProvider, listProviderIds, IMPLEMENTED } from "../registry.js";
import { NotImplementedError } from "../types.js";

describe("provider registry", () => {
  it("lists all four ids", () => {
    expect(listProviderIds().sort()).toEqual(["letta", "mem0", "supermemory", "zep"]);
  });
  it("mem0 is implemented", () => {
    expect(IMPLEMENTED.has("mem0")).toBe(true);
    expect(getProvider("mem0").id).toBe("mem0");
  });
  it("stub providers reject with NotImplementedError", async () => {
    const zep = getProvider("zep");
    await expect(zep.test({ enabled: true, apiKey: "x" })).rejects.toBeInstanceOf(NotImplementedError);
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `cd packages/memory && npx vitest run src/__tests__/registry.test.ts`
Expected: FAIL — cannot find module `../registry.js`.

- [ ] **Step 7: Write `src/providers/stub.ts` and `src/registry.ts`**

`src/providers/stub.ts`:

```ts
import type { MemoryProvider, ProviderId } from "../types.js";
import { NotImplementedError } from "../types.js";

export function makeStub(id: ProviderId): MemoryProvider {
  return {
    id,
    async test() { throw new NotImplementedError(id); },
    async *pull() { throw new NotImplementedError(id); },
    async push() { throw new NotImplementedError(id); },
  };
}
```

`src/registry.ts`:

```ts
import type { MemoryProvider, ProviderId } from "./types.js";
import { mem0Provider } from "./providers/mem0.js";
import { makeStub } from "./providers/stub.js";

export const IMPLEMENTED: ReadonlySet<ProviderId> = new Set(["mem0"]);

const REGISTRY: Record<ProviderId, MemoryProvider> = {
  mem0: mem0Provider,
  supermemory: makeStub("supermemory"),
  zep: makeStub("zep"),
  letta: makeStub("letta"),
};

export function getProvider(id: ProviderId): MemoryProvider {
  return REGISTRY[id];
}

export function listProviderIds(): ProviderId[] {
  return Object.keys(REGISTRY) as ProviderId[];
}
```

- [ ] **Step 8: Export from index, run all package tests**

Add to `src/index.ts`:

```ts
export * from "./registry.js";
export { mem0Provider } from "./providers/mem0.js";
```

Run: `cd packages/memory && npx vitest run`
Expected: PASS (all tests so far).

- [ ] **Step 9: Commit**

```bash
git add packages/memory/src/providers packages/memory/src/registry.ts packages/memory/src/index.ts packages/memory/src/__tests__/mem0.test.ts packages/memory/src/__tests__/registry.test.ts
git commit -m "feat(memory): mem0 adapter, stub factory, and provider registry"
```

---

## Task 5: Pull into the recall index

**Files:**
- Create: `packages/memory/src/pull.ts`
- Modify: `packages/memory/src/index.ts`
- Test: `packages/memory/src/__tests__/pull.test.ts`

**Interfaces:**
- Consumes: `MemoryProvider`, `ProviderConfig` (Task 1); `readCursor`/`writeCursor` (Task 3); `RecallIndex` from `@agentgem/recall` — specifically `upsertSession(meta: { sessionId; agent; project; branch; startMs }, chunks: { turn; text }[], stamp: string)` and `search(query, filters, limit)`.
- Produces: `pullIntoRecall(provider: MemoryProvider, cfg: ProviderConfig, index: RecallIndex): Promise<{ pulled: number }>`.

- [ ] **Step 1: Write the failing test**

`packages/memory/src/__tests__/pull.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RecallIndex } from "@agentgem/recall";
import { pullIntoRecall } from "../pull.js";
import { readCursor } from "../cursors.js";
import type { MemoryProvider, MemoryRecord } from "../types.js";

let home: string;
let index: RecallIndex;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agm-pull-"));
  process.env.AGENTGEM_HOME = home;
  index = new RecallIndex(join(home, "recall.db"));
});
afterEach(() => { index.close(); delete process.env.AGENTGEM_HOME; rmSync(home, { recursive: true, force: true }); });

function fakeProvider(records: MemoryRecord[]): MemoryProvider {
  return {
    id: "mem0",
    async test() { return { ok: true }; },
    async *pull(_cfg, since) { for (const r of records) if (since === undefined || r.updatedAt > since) yield r; },
    async push() { return { id: "x" }; },
  };
}

describe("pullIntoRecall", () => {
  it("maps memories to searchable recall rows under memory:mem0 and advances the cursor", async () => {
    const provider = fakeProvider([
      { id: "m1", text: "raymond prefers pnpm workspaces", updatedAt: 1000 },
      { id: "m2", text: "the recall index uses node sqlite", updatedAt: 2000 },
    ]);
    const res = await pullIntoRecall(provider, { enabled: true, apiKey: "k", userId: "u" }, index);
    expect(res.pulled).toBe(2);

    const hits = index.search("pnpm", { agent: "memory:mem0" }, 10);
    expect(hits.length).toBeGreaterThan(0);
    expect(readCursor("mem0")).toBe(2000);
  });

  it("upserts by provider id (no duplicate rows on re-pull)", async () => {
    const provider = fakeProvider([{ id: "m1", text: "alpha beta gamma", updatedAt: 1000 }]);
    await pullIntoRecall(provider, { enabled: true, apiKey: "k" }, index);
    // second pull ignores cursor for this assertion by resetting records with a newer stamp
    const provider2 = fakeProvider([{ id: "m1", text: "alpha beta gamma delta", updatedAt: 3000 }]);
    await pullIntoRecall(provider2, { enabled: true, apiKey: "k" }, index);
    const hits = index.search("alpha", { agent: "memory:mem0" }, 10);
    expect(hits).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/memory && npx vitest run src/__tests__/pull.test.ts`
Expected: FAIL — cannot find module `../pull.js`.

- [ ] **Step 3: Write `src/pull.ts`**

```ts
import type { RecallIndex } from "@agentgem/recall";
import type { MemoryProvider, ProviderConfig } from "./types.js";
import { readCursor, writeCursor } from "./cursors.js";

/**
 * Pull memories from `provider` (incrementally, from the stored cursor) and
 * upsert each into the recall index as a one-chunk pseudo-session under the
 * `memory:<provider>` agent namespace. Advances the cursor to the newest
 * `updatedAt` seen. Returns how many memories were written.
 */
export async function pullIntoRecall(
  provider: MemoryProvider,
  cfg: ProviderConfig,
  index: RecallIndex,
): Promise<{ pulled: number }> {
  const agent = `memory:${provider.id}`;
  const since = readCursor(provider.id);
  let pulled = 0;
  let maxSeen = since ?? 0;

  for await (const rec of provider.pull(cfg, since)) {
    index.upsertSession(
      { sessionId: rec.id, agent, project: (rec.metadata?.project as string) ?? null, branch: null, startMs: rec.updatedAt },
      [{ turn: 0, text: rec.text }],
      String(rec.updatedAt),
    );
    pulled++;
    if (rec.updatedAt > maxSeen) maxSeen = rec.updatedAt;
  }

  if (pulled > 0) writeCursor(provider.id, maxSeen);
  return { pulled };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/memory && npx vitest run src/__tests__/pull.test.ts`
Expected: PASS (2 tests).

> If this test flakes under the full suite, run it in isolation — the real-FS recall tests are known to flake under full-suite concurrency.

- [ ] **Step 5: Export + commit**

Add `export * from "./pull.js";` to `src/index.ts`.

```bash
git add packages/memory/src/pull.ts packages/memory/src/index.ts packages/memory/src/__tests__/pull.test.ts
git commit -m "feat(memory): pull provider memories into the recall index"
```

---

## Task 6: Push candidate builder (scrub + dedupe)

**Files:**
- Create: `packages/memory/src/candidates.ts`
- Modify: `packages/memory/src/index.ts`
- Test: `packages/memory/src/__tests__/candidates.test.ts`

**Interfaces:**
- Consumes: `PushCandidate`, `CandidateKind` (Task 1); `scrubProse` from `@agentgem/insight`.
- Produces: `RawSignal` (`{ text: string; kind: CandidateKind; source: string }`), `buildPushCandidates(signals: RawSignal[], alreadyPushed: ReadonlySet<string>): PushCandidate[]`, `candidateKey(text: string): string`.

> This task builds the **pure** candidate logic (scrub → hash → dedupe). Collecting `RawSignal[]` from insight distill/lessons/outcomes is a thin adapter wired in Task 8; keeping the transform pure makes it fully testable here.

- [ ] **Step 1: Write the failing test**

`packages/memory/src/__tests__/candidates.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildPushCandidates, candidateKey, type RawSignal } from "../candidates.js";

describe("buildPushCandidates", () => {
  it("scrubs, hashes, and dedupes by key", () => {
    const signals: RawSignal[] = [
      { text: "Raymond prefers pnpm", kind: "preference", source: "distill:a" },
      { text: "Raymond prefers pnpm", kind: "preference", source: "distill:b" }, // dup text
    ];
    const out = buildPushCandidates(signals, new Set());
    expect(out).toHaveLength(1);
    expect(out[0].key).toBe(candidateKey(out[0].text));
    expect(out[0].kind).toBe("preference");
  });

  it("drops candidates whose key is already pushed", () => {
    const signals: RawSignal[] = [{ text: "uses vitest", kind: "fact", source: "distill:x" }];
    const key = candidateKey("uses vitest");
    expect(buildPushCandidates(signals, new Set([key]))).toHaveLength(0);
  });

  it("drops empties after scrub", () => {
    const signals: RawSignal[] = [{ text: "   ", kind: "fact", source: "s" }];
    expect(buildPushCandidates(signals, new Set())).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/memory && npx vitest run src/__tests__/candidates.test.ts`
Expected: FAIL — cannot find module `../candidates.js`.

- [ ] **Step 3: Write `src/candidates.ts`**

```ts
import { createHash } from "node:crypto";
import { scrubProse } from "@agentgem/insight";
import type { CandidateKind, PushCandidate } from "./types.js";

export interface RawSignal {
  text: string;
  kind: CandidateKind;
  source: string;
}

export function candidateKey(text: string): string {
  return createHash("sha256").update(text.trim()).digest("hex").slice(0, 16);
}

export function buildPushCandidates(signals: RawSignal[], alreadyPushed: ReadonlySet<string>): PushCandidate[] {
  const seen = new Set<string>();
  const out: PushCandidate[] = [];
  for (const s of signals) {
    const text = scrubProse(s.text).trim();
    if (!text) continue;
    const key = candidateKey(text);
    if (seen.has(key) || alreadyPushed.has(key)) continue;
    seen.add(key);
    out.push({ key, text, kind: s.kind, source: s.source });
  }
  return out;
}
```

> Verify `scrubProse` is exported from `@agentgem/insight`'s public entry (`packages/insight/src/index.ts`). It is defined in `packages/insight/src/scrub.ts`; if the package index does not re-export it, add `export { scrubProse } from "./scrub.js";` to `packages/insight/src/index.ts` in this task and commit that one-line change with it.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/memory && npx vitest run src/__tests__/candidates.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Export + commit**

Add `export * from "./candidates.js";` to `src/index.ts`.

```bash
git add packages/memory/src/candidates.ts packages/memory/src/index.ts packages/memory/src/__tests__/candidates.test.ts
git commit -m "feat(memory): pure push-candidate builder (scrub + dedupe)"
```

---

## Task 7: Outbox store + push executor

**Files:**
- Create: `packages/memory/src/outbox.ts`
- Modify: `packages/memory/src/index.ts`
- Test: `packages/memory/src/__tests__/outbox.test.ts`

**Interfaces:**
- Consumes: `PushCandidate`, `ProviderId`, `MemoryProvider`, `ProviderConfig` (Tasks 1/4); `getProvider` (Task 4); `loadProviderConfigs` (Task 2).
- Produces: `readOutbox(): PushCandidate[]`, `writeOutbox(cands: PushCandidate[]): void`, `readPushedKeys(): Set<string>`, `approveAndPush(keys: string[]): Promise<{ pushed: number; skipped: number }>`.

- [ ] **Step 1: Write the failing test**

`packages/memory/src/__tests__/outbox.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeOutbox, readOutbox, approveAndPush, readPushedKeys } from "../outbox.js";
import * as registry from "../registry.js";
import * as config from "../config.js";

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "agm-out-")); process.env.AGENTGEM_HOME = home; });
afterEach(() => { delete process.env.AGENTGEM_HOME; rmSync(home, { recursive: true, force: true }); vi.restoreAllMocks(); });

describe("outbox + push", () => {
  it("round-trips the outbox", () => {
    writeOutbox([{ key: "k1", text: "a", kind: "fact", source: "s" }]);
    expect(readOutbox()).toHaveLength(1);
  });

  it("pushes approved keys to enabled providers and records pushed keys", async () => {
    writeOutbox([
      { key: "k1", text: "raymond uses pnpm", kind: "preference", source: "s" },
      { key: "k2", text: "unapproved", kind: "fact", source: "s" },
    ]);
    config.saveProviderConfig("mem0", { enabled: true, apiKey: "sk", userId: "u" });
    const push = vi.fn(async () => ({ id: "remote-1" }));
    vi.spyOn(registry, "getProvider").mockReturnValue({ id: "mem0", test: vi.fn(), pull: vi.fn(), push } as never);

    const res = await approveAndPush(["k1"]);
    expect(res.pushed).toBe(1);
    expect(push).toHaveBeenCalledOnce();
    expect(readPushedKeys().has("k1")).toBe(true);
    // k1 removed from outbox, k2 remains
    expect(readOutbox().map((c) => c.key)).toEqual(["k2"]);
  });

  it("skips providers that are disabled", async () => {
    writeOutbox([{ key: "k1", text: "x", kind: "fact", source: "s" }]);
    config.saveProviderConfig("mem0", { enabled: false, apiKey: "sk" });
    const push = vi.fn(async () => ({ id: "r" }));
    vi.spyOn(registry, "getProvider").mockReturnValue({ id: "mem0", test: vi.fn(), pull: vi.fn(), push } as never);
    const res = await approveAndPush(["k1"]);
    expect(res.pushed).toBe(0);
    expect(push).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/memory && npx vitest run src/__tests__/outbox.test.ts`
Expected: FAIL — cannot find module `../outbox.js`.

- [ ] **Step 3: Write `src/outbox.ts`**

```ts
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { agentgemHome } from "@agentgem/model";
import type { ProviderId, PushCandidate } from "./types.js";
import { getProvider, listProviderIds } from "./registry.js";
import { loadProviderConfigs } from "./config.js";

function statePath(name: string): string {
  return join(agentgemHome(), ".agentgem", name);
}
function readJson<T>(name: string, fallback: T): T {
  const p = statePath(name);
  if (!existsSync(p)) return fallback;
  try { return JSON.parse(readFileSync(p, "utf8")) as T; } catch { return fallback; }
}
function writeJson(name: string, value: unknown): void {
  const p = statePath(name);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(value, null, 2));
}

export function readOutbox(): PushCandidate[] {
  return readJson<PushCandidate[]>("memory-outbox.json", []);
}
export function writeOutbox(cands: PushCandidate[]): void {
  writeJson("memory-outbox.json", cands);
}
export function readPushedKeys(): Set<string> {
  return new Set(readJson<string[]>("memory-pushed-keys.json", []));
}
function writePushedKeys(keys: Set<string>): void {
  writeJson("memory-pushed-keys.json", [...keys]);
}

/** Push the approved candidates to every enabled provider, then remove them from
 *  the outbox and record their keys so they are never re-queued or re-sent. */
export async function approveAndPush(keys: string[]): Promise<{ pushed: number; skipped: number }> {
  const outbox = readOutbox();
  const approved = outbox.filter((c) => keys.includes(c.key));
  const cfgs = loadProviderConfigs();
  const enabled = listProviderIds().filter((id: ProviderId) => cfgs[id]?.enabled);

  let pushed = 0;
  let skipped = 0;
  const pushedKeys = readPushedKeys();

  for (const cand of approved) {
    if (enabled.length === 0) { skipped++; continue; }
    for (const id of enabled) {
      await getProvider(id).push(cfgs[id]!, cand);
      pushed++;
    }
    pushedKeys.add(cand.key);
  }

  writePushedKeys(pushedKeys);
  writeOutbox(outbox.filter((c) => !pushedKeys.has(c.key)));
  return { pushed, skipped };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/memory && npx vitest run src/__tests__/outbox.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Export + full package test + commit**

Add `export * from "./outbox.js";` to `src/index.ts`.
Run: `cd packages/memory && npx vitest run` → Expected: PASS (all).

```bash
git add packages/memory/src/outbox.ts packages/memory/src/index.ts packages/memory/src/__tests__/outbox.test.ts
git commit -m "feat(memory): outbox store + consent-gated push executor"
```

---

## Task 8: Core REST routes + signal collection

**Files:**
- Create: `src/goldmine/memoryRoutes.ts`
- Create: `src/goldmine/__tests__/memoryRoutes.test.ts`
- Modify: the goldmine server bootstrap that registers `registerRecallRoutes` (locate in Step 1)

**Interfaces:**
- Consumes: `@agentgem/memory` exports (`getProvider`, `listProviderIds`, `IMPLEMENTED`, `loadProviderConfigs`, `saveProviderConfig`, `pullIntoRecall`, `readOutbox`, `approveAndPush`, `buildPushCandidates`, `RawSignal`); `RecallIndex` + `defaultRecallDbPath` (`src/goldmine/recall.js`).
- Produces: `registerMemoryRoutes(app, deps?, guard?)` where routes are:
  - `GET  /api/memory/providers` → `{ providers: { id, implemented, enabled, connected }[] }`
  - `POST /api/memory/providers` body `{ id, config }` → save + `test()` → `{ ok, detail? }`
  - `POST /api/memory/pull` body `{ id }` → `{ pulled }`
  - `GET  /api/memory/outbox` → `{ candidates }`
  - `POST /api/memory/outbox/refresh` → regenerate candidates from signals → `{ candidates }`
  - `POST /api/memory/push` body `{ keys }` → `{ pushed, skipped }`

- [ ] **Step 1: Locate the bootstrap and study the route pattern**

Run: `grep -rn "registerRecallRoutes" src/goldmine`
Read the file that calls `registerRecallRoutes(...)` — that is where `registerMemoryRoutes(...)` gets mounted (Step 6). Read `src/goldmine/recallRoutes.ts:20-78` to copy the duck-typed `Req`/`Res`/`App`/`Middleware`/`noopGuard` shapes verbatim.

- [ ] **Step 2: Write the failing route test**

`src/goldmine/__tests__/memoryRoutes.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerMemoryRoutes } from "../memoryRoutes.js";

// Minimal app that records handlers by "METHOD path" so tests can invoke them.
function makeApp() {
  const routes = new Map<string, (req: any, res: any) => unknown>();
  const reg = (m: string) => (p: string, _g: any, h: any) => routes.set(`${m} ${p}`, h);
  return { app: { get: reg("GET"), post: reg("POST"), delete: reg("DELETE") }, routes };
}
function res() {
  const out: any = { code: 200, body: undefined };
  return { status(c: number) { out.code = c; return this; }, json(b: unknown) { out.body = b; }, setHeader() {}, write() {}, end() {}, _out: out };
}

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "agm-routes-")); process.env.AGENTGEM_HOME = home; });
afterEach(() => { delete process.env.AGENTGEM_HOME; rmSync(home, { recursive: true, force: true }); vi.restoreAllMocks(); });

describe("memory routes", () => {
  it("GET /api/memory/providers lists all providers with implemented flags", async () => {
    const { app, routes } = makeApp();
    registerMemoryRoutes(app as any);
    const r = res();
    await routes.get("GET /api/memory/providers")!({ query: {}, params: {} }, r);
    const ids = r._out.body.providers.map((p: any) => p.id).sort();
    expect(ids).toEqual(["letta", "mem0", "supermemory", "zep"]);
    const mem0 = r._out.body.providers.find((p: any) => p.id === "mem0");
    expect(mem0.implemented).toBe(true);
    expect(mem0.enabled).toBe(false); // nothing configured yet
  });

  it("GET /api/memory/outbox returns the current candidates", async () => {
    const { app, routes } = makeApp();
    registerMemoryRoutes(app as any);
    const r = res();
    await routes.get("GET /api/memory/outbox")!({ query: {}, params: {} }, r);
    expect(r._out.body).toEqual({ candidates: [] });
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run src/goldmine/__tests__/memoryRoutes.test.ts`
Expected: FAIL — cannot find module `../memoryRoutes.js`.

- [ ] **Step 4: Write `src/goldmine/memoryRoutes.ts`**

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/goldmine/memoryRoutes.ts
//
// Local-core-only REST routes for the Memory Providers feature. Mirrors
// recallRoutes.ts's duck-typed Express pattern (no @types/express dependency).
import {
  getProvider, listProviderIds, IMPLEMENTED,
  loadProviderConfigs, saveProviderConfig,
  pullIntoRecall, readOutbox, approveAndPush,
  buildPushCandidates, type RawSignal,
} from "@agentgem/memory";
import { RecallIndex } from "@agentgem/recall";
import { defaultRecallDbPath } from "./recall.js";
import { collectSignals } from "./memorySignals.js";
import type { ProviderId, ProviderConfig } from "@agentgem/memory";

interface Req { body?: Record<string, unknown>; query: Record<string, unknown>; params: Record<string, string> }
interface Res { status(code: number): Res; json(body: unknown): void; setHeader(n: string, v: string): void; write(c: string): void; end(): void }
type Middleware = (req: Req, res: Res, next: () => void) => void;
interface App {
  get(path: string, guard: Middleware, handler: (req: Req, res: Res) => void | Promise<void>): void;
  post(path: string, guard: Middleware, handler: (req: Req, res: Res) => Promise<void>): void;
}
const noopGuard: Middleware = (_req, _res, next) => next();

export function registerMemoryRoutes(app: App, guard: Middleware = noopGuard): void {
  app.get("/api/memory/providers", guard, (_req, res) => {
    const cfgs = loadProviderConfigs();
    const providers = listProviderIds().map((id) => ({
      id,
      implemented: IMPLEMENTED.has(id),
      enabled: cfgs[id]?.enabled ?? false,
      connected: Boolean(cfgs[id]?.apiKey),
    }));
    res.json({ providers });
  });

  app.post("/api/memory/providers", guard, async (req, res) => {
    const id = req.body?.id as ProviderId;
    const config = req.body?.config as ProviderConfig;
    if (!id || !config) { res.status(400).json({ error: "id and config required" }); return; }
    saveProviderConfig(id, config);
    try {
      const r = IMPLEMENTED.has(id) ? await getProvider(id).test(config) : { ok: false, detail: "not implemented yet" };
      res.json(r);
    } catch (e) { res.json({ ok: false, detail: String((e as Error).message) }); }
  });

  app.post("/api/memory/pull", guard, async (req, res) => {
    const id = req.body?.id as ProviderId;
    const cfg = loadProviderConfigs()[id];
    if (!cfg?.enabled) { res.status(400).json({ error: "provider not enabled" }); return; }
    const index = new RecallIndex(defaultRecallDbPath());
    try {
      const r = await pullIntoRecall(getProvider(id), cfg, index);
      res.json(r);
    } finally { index.close(); }
  });

  app.get("/api/memory/outbox", guard, (_req, res) => {
    res.json({ candidates: readOutbox() });
  });

  app.post("/api/memory/outbox/refresh", guard, async (_req, res) => {
    const signals: RawSignal[] = await collectSignals();
    const { writeOutbox, readPushedKeys } = await import("@agentgem/memory");
    const candidates = buildPushCandidates(signals, readPushedKeys());
    writeOutbox(candidates);
    res.json({ candidates });
  });

  app.post("/api/memory/push", guard, async (req, res) => {
    const keys = (req.body?.keys as string[]) ?? [];
    res.json(await approveAndPush(keys));
  });
}
```

- [ ] **Step 5: Write `src/goldmine/memorySignals.ts` (thin insight adapter)**

```ts
// Collects RawSignal[] for push candidates from the insight distillation/outcome
// surfaces. v1 keeps this deliberately minimal and side-effect-free; the exact
// insight calls are wired here so the pure builder (candidates.ts) stays testable.
import type { RawSignal } from "@agentgem/memory";

/**
 * Gather durable facts/preferences (distill/session-lessons) and outcome/scorecard
 * signal into RawSignal[]. Returns [] when no signal is available. Kept as a single
 * seam so richer collection can grow here without touching routes or the builder.
 */
export async function collectSignals(): Promise<RawSignal[]> {
  // v1: no automatic collection wired yet — returns empty so the outbox stays
  // empty until a follow-up connects distillSessionLessons / scorecard outcomes.
  // This keeps the consent path shippable and honest (nothing fabricated).
  return [];
}
```

> **Scope note:** `collectSignals` returning `[]` in v1 means the push path is fully built and consent-gated end-to-end, but the outbox only fills once a fast-follow connects the real insight sources (`distillSessionLessons`, outcome/attestation). This is called out in the spec's push section and is intentional — it avoids shipping an unvetted automatic extraction. Log this limitation, do not hide it.

- [ ] **Step 6: Mount the routes in the bootstrap**

In the file found in Step 1, next to the `registerRecallRoutes(app, ...)` call, add:

```ts
import { registerMemoryRoutes } from "./memoryRoutes.js";
// ... alongside the existing route registrations:
registerMemoryRoutes(app, guard); // use the same guard passed to registerRecallRoutes
```

- [ ] **Step 7: Run the route test to verify it passes**

Run: `npx vitest run src/goldmine/__tests__/memoryRoutes.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 8: Typecheck + commit**

Run: `pnpm -F @agentgem/memory build && npx tsc -b` (or the repo's typecheck script) to confirm the core compiles against the new package.

```bash
git add src/goldmine/memoryRoutes.ts src/goldmine/memorySignals.ts src/goldmine/__tests__/memoryRoutes.test.ts src/goldmine/<bootstrap-file>
git commit -m "feat(memory): local-core REST routes + signal-collection seam"
```

---

## Task 9: Console API client + Memory Providers panel

**Files:**
- Create: `packages/console/src/api/memory.ts`
- Create: `packages/console/src/panels/Memory/index.tsx`
- Create: `packages/console/src/panels/Memory/Memory.test.tsx`
- Modify: the console panel/route registry (locate in Step 1)

**Interfaces:**
- Consumes: the routes from Task 8.
- Produces: `MemoryPanel` React component; `memoryApi` client (`listProviders`, `saveProvider`, `pull`, `getOutbox`, `refreshOutbox`, `push`).

> CI skips `packages/console` tests (`ci-skips-console-tests`) — run the console vitest + typecheck locally. Console vitest is capped to 4 workers.

- [ ] **Step 1: Study an existing panel + API client**

Read `packages/console/src/panels/Dreaming/index.tsx` and `packages/console/src/panels/Dreaming/api.ts` for the panel + fetch-client pattern and the approve/skip review-list interaction to mirror. Run `grep -rn "Dreaming" packages/console/src/pages.tsx` (or the panel registry) to find where panels are registered — that is where `MemoryPanel` gets registered in Step 6.

- [ ] **Step 2: Write the API client `packages/console/src/api/memory.ts`**

```ts
export interface ProviderRow { id: string; implemented: boolean; enabled: boolean; connected: boolean }
export interface Candidate { key: string; text: string; kind: string; source: string }
export interface ProviderCfg { enabled: boolean; apiKey: string; baseUrl?: string; userId?: string }

async function j<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json() as Promise<T>;
}

export const memoryApi = {
  listProviders: () => fetch("/api/memory/providers").then(j<{ providers: ProviderRow[] }>),
  saveProvider: (id: string, config: ProviderCfg) =>
    fetch("/api/memory/providers", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, config }) }).then(j<{ ok: boolean; detail?: string }>),
  pull: (id: string) => fetch("/api/memory/pull", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }) }).then(j<{ pulled: number }>),
  getOutbox: () => fetch("/api/memory/outbox").then(j<{ candidates: Candidate[] }>),
  refreshOutbox: () => fetch("/api/memory/outbox/refresh", { method: "POST" }).then(j<{ candidates: Candidate[] }>),
  push: (keys: string[]) => fetch("/api/memory/push", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ keys }) }).then(j<{ pushed: number; skipped: number }>),
};
```

- [ ] **Step 3: Write the failing panel test**

`packages/console/src/panels/Memory/Memory.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryPanel } from "./index.js";

beforeEach(() => {
  globalThis.fetch = vi.fn(async (url: string) => {
    if (String(url).endsWith("/api/memory/providers")) return { ok: true, json: async () => ({ providers: [
      { id: "mem0", implemented: true, enabled: false, connected: false },
      { id: "zep", implemented: false, enabled: false, connected: false },
    ] }) } as Response;
    if (String(url).endsWith("/api/memory/outbox")) return { ok: true, json: async () => ({ candidates: [] }) } as Response;
    return { ok: true, json: async () => ({}) } as Response;
  }) as unknown as typeof fetch;
});

describe("MemoryPanel", () => {
  it("lists providers and marks unimplemented ones coming soon", async () => {
    render(<MemoryPanel />);
    await waitFor(() => expect(screen.getByText(/mem0/i)).toBeInTheDocument());
    expect(screen.getByText(/coming soon/i)).toBeInTheDocument(); // zep
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `cd packages/console && npx vitest run src/panels/Memory/Memory.test.tsx`
Expected: FAIL — cannot find module `./index.js`.

- [ ] **Step 5: Write `packages/console/src/panels/Memory/index.tsx`**

Implement a component that, following the Dreaming panel's structure and the existing console styling classes:
1. On mount, calls `memoryApi.listProviders()` and `memoryApi.getOutbox()`.
2. Renders one row per provider: name, a status badge (`coming soon` when `!implemented`, `connected` when `connected`, else `not connected`), an API-key input + Test/Save button (disabled when `!implemented`), an enable toggle, and a "Pull now" button that calls `memoryApi.pull(id)`.
3. Renders the outbox as an approve/skip list with a "Push approved" button calling `memoryApi.push(selectedKeys)` and a "Refresh candidates" button calling `memoryApi.refreshOutbox()`.

Reuse existing console class names / components from the Dreaming panel rather than inventing new visual language. Keep the file focused; extract a `ProviderRow` subcomponent if it grows past ~150 lines.

Minimal skeleton to satisfy the test (expand per the above):

```tsx
import { useEffect, useState } from "react";
import { memoryApi, type ProviderRow, type Candidate } from "../../api/memory.js";

export function MemoryPanel() {
  const [providers, setProviders] = useState<ProviderRow[]>([]);
  const [outbox, setOutbox] = useState<Candidate[]>([]);
  useEffect(() => { memoryApi.listProviders().then((r) => setProviders(r.providers)); memoryApi.getOutbox().then((r) => setOutbox(r.candidates)); }, []);
  return (
    <div className="panel memory-panel">
      <h2>Memory providers</h2>
      <ul className="provider-list">
        {providers.map((p) => (
          <li key={p.id} className="provider-row">
            <span className="provider-name">{p.id}</span>
            {!p.implemented && <span className="badge">coming soon</span>}
            {p.implemented && (p.connected ? <span className="badge">connected</span> : <span className="badge">not connected</span>)}
          </li>
        ))}
      </ul>
      <section className="outbox">
        <h3>Curation outbox</h3>
        {outbox.length === 0 ? <p>No candidates.</p> : outbox.map((c) => <div key={c.key}>{c.text}</div>)}
      </section>
    </div>
  );
}
```

- [ ] **Step 6: Register the panel + run the test**

Register `MemoryPanel` in the console panel/route registry found in Step 1 (add a nav entry mirroring how Dreaming is registered).
Run: `cd packages/console && npx vitest run src/panels/Memory/Memory.test.tsx`
Expected: PASS.

- [ ] **Step 7: Local typecheck + full console test**

Run: `cd packages/console && npx tsc -b && npx vitest run`
Expected: typecheck clean; tests pass.

- [ ] **Step 8: Commit**

```bash
git add packages/console/src/api/memory.ts packages/console/src/panels/Memory packages/console/src/<panel-registry-file>
git commit -m "feat(memory): console Memory Providers panel + curation outbox"
```

---

## Task 10: Manual verification in the real app

**Files:** none (verification only).

- [ ] **Step 1: Build everything**

Run: `pnpm -r build`
Expected: all packages build, including `@agentgem/memory` and the console.

- [ ] **Step 2: Launch the local console and open the Memory panel**

Use the repo's run skill / `pnpm dev` for the console + local core. Confirm the Memory Providers panel renders with the four providers, mem0 actionable and the other three "coming soon".

- [ ] **Step 3: Connect mem0 (or a self-hosted base URL) and Test**

Enter a mem0 API key + userId, click Test → expect a success badge (or a clear error detail for a bad key). Confirm `~/.agentgem/memory-providers.json` exists with mode `0600` (`ls -l`).

- [ ] **Step 4: Pull and search**

Click "Pull now" → note the pulled count. Open `#/recall`, filter agent `memory:mem0`, search for a term you know is in a memory → confirm it appears with provenance.

- [ ] **Step 5: Confirm the consent gate**

Click "Refresh candidates" → in v1 the outbox stays empty (`collectSignals` returns `[]`) — confirm nothing is pushed automatically and the empty state renders. This verifies the consent path is wired and honest.

- [ ] **Step 6: Final commit (if any verification fixes were needed)**

```bash
git add -A
git commit -m "chore(memory): verification fixes"
```

---

## Self-Review

**Spec coverage:**
- Adapter interface + registry (mem0 impl, 3 stubs) → Tasks 1, 4. ✓
- Pull → recall under `memory:<provider>`, incremental cursor, upsert-by-id → Tasks 3, 5. ✓
- Push candidates from distill/outcomes, scrub-first, dedupe, re-push guard → Tasks 6, 7, 8 (`collectSignals` seam). ✓
- Local outbox + curation + consent-gated send → Tasks 7, 9. ✓
- Config `~/.agentgem/memory-providers.json` @ 0600, local-core-only → Tasks 2, 8. ✓
- Console settings panel + curation surface → Task 9. ✓
- Testing (adapter contract, pull mapping, push safety, isolation) → Tasks 4, 5, 6, 7. ✓
- Deferred adapters as stubs; deletion + cross-provider dedupe out of scope → Tasks 1/4 (stubs), documented. ✓

**Known intentional gap:** automatic `collectSignals` is a `[]` seam in v1 (Task 8) — the push pipeline is built and consent-gated but the outbox only fills once a fast-follow connects real insight sources. Called out in the spec and Task 8 scope note.

**Type consistency:** `MemoryProvider`/`MemoryRecord`/`ProviderConfig`/`PushCandidate`/`RawSignal`/`ProviderId` names are consistent across Tasks 1–9. `pullIntoRecall`, `buildPushCandidates`, `approveAndPush`, `getProvider`, `registerMemoryRoutes`, `collectSignals` signatures match between definition and consumption.
