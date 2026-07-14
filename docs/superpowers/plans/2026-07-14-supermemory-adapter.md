# Supermemory Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make `supermemory` a real memory provider (currently a stub) in `@agentgem/memory`, and — because a second real provider makes the multi-provider push path reachable — fix the deferred re-push guard so it keys on `(providerId, key)` pairs.

**Architecture:** Add `packages/memory/src/providers/supermemory.ts` (real `test`/`pull`/`push` against `api.supermemory.ai`), flip the registry entry from `makeStub("supermemory")` to the real adapter and add it to `IMPLEMENTED`. Separately, re-key the re-push guard in `outbox.ts` from a bare content-hash set to a `providerId:key` set, with backward-compatible auto-migration of the old bare-key file (old bare keys are treated as already-pushed to `mem0`).

**Tech Stack:** TypeScript ESM (NodeNext), global `fetch`, Vitest.

## Global Constraints

- ESM only, `.js` import specifiers, `NodeNext`. Node `>=24`. No new runtime deps.
- Provider ids stay exactly `"mem0" | "supermemory" | "zep" | "letta"`. After this change `IMPLEMENTED = {mem0, supermemory}`; zep/letta stay stubs.
- `MemoryProvider` interface is unchanged: `test(cfg)`, `pull(cfg, since?): AsyncIterable<MemoryRecord>` (an `async *`), `push(cfg, m): Promise<{id}>`.
- `MemoryRecord = { id: string; text: string; updatedAt: number; metadata?: Record<string, unknown> }`.
- The re-push guard file stays at `~/.agentgem/memory-pushed-keys.json` but its contents become an array of `"providerId:key"` strings. **Auto-migrate**: any legacy entry with no `:` (a bare content hash) is read as `mem0:<hash>` (mem0 was the only prior provider).
- Do NOT change the console UI, routes, `collectSignals`, or the pull-into-recall mapping. Do NOT modify `@agentgem/recall`.

## Supermemory API (confirmed against docs.supermemory.ai via context7)

- Base `https://api.supermemory.ai`, auth header `Authorization: Bearer <apiKey>`, `Content-Type: application/json`.
- **List (pull):** `POST /v3/documents/list` body `{ containerTags?, limit, sort: "updatedAt", order: "desc" }` → `{ memories: [{ id, title, summary, updatedAt, createdAt, metadata, containerTags, ... }], pagination: { currentPage, totalPages, ... } }`. **List items have NO full `content`** — index `title` + `summary`. Sorted `desc` by `updatedAt`, so pull can early-break once it sees `updatedAt <= since`.
- **Add (push):** `POST /v3/documents` body `{ content, containerTags? }` → `{ id, status }`. Synchronous `id` (unlike mem0's async `event_id`).
- **Container/user scoping:** `containerTags` partitions by user. Use `cfg.userId` directly as the sole container tag (`containerTags: [cfg.userId]`) when set, symmetric across pull/push; omit `containerTags` when `userId` is absent.
- **test:** a `POST /v3/documents/list` with `{ limit: 1, containerTags }` — `ok: true` on a 2xx, else `{ ok: false, detail: "supermemory returned <status>" }`.
- **Confirm during implementation:** the exact list endpoint (`/v3/documents/list` per the documented cURL) and item field names; if the live API differs, update BOTH the adapter and the test's `fetch` mock so they stay consistent, and note it in the report.

---

## File Structure

- Modify: `packages/memory/src/outbox.ts` — re-key guard to `(providerId, key)` + migration.
- Modify: `packages/memory/src/__tests__/outbox.test.ts` — update/extend for the new guard shape + migration.
- Create: `packages/memory/src/providers/supermemory.ts` — the adapter.
- Create: `packages/memory/src/__tests__/supermemory.test.ts` — adapter contract test.
- Modify: `packages/memory/src/registry.ts` — real supermemory + `IMPLEMENTED`.
- Modify: `packages/memory/src/index.ts` — export `supermemoryProvider`.
- Modify: `packages/memory/src/__tests__/registry.test.ts` — assert supermemory now implemented.

---

## Task 1: Re-key the re-push guard to (providerId, key) pairs

**Files:**
- Modify: `packages/memory/src/outbox.ts`
- Test: `packages/memory/src/__tests__/outbox.test.ts`

**Interfaces:**
- Consumes: `getProvider`, `listProviderIds` (registry), `loadProviderConfigs` (config), `PushCandidate`, `ProviderId`.
- Produces: unchanged public signatures (`readOutbox`, `writeOutbox`, `readPushedKeys`, `approveAndPush`) — but `readPushedKeys(): Set<string>` now returns `"providerId:key"` entries, and a new internal helper `pairKey(providerId, key) => \`${providerId}:${key}\``.

**Context:** Read `packages/memory/src/outbox.ts` first. Currently `approveAndPush`:
- computes `approved = outbox.filter(c => keys.includes(c.key) && !pushedKeys.has(c.key))`,
- for each approved candidate, for each enabled provider, `await getProvider(id).push(...)`, `pushed++`,
- after all providers for that candidate: `pushedKeys.add(cand.key)`, persist pushed-keys, remove from outbox, persist outbox.

The bug (deferred from the mem0 PR's review): the guard and the "add to pushedKeys" are per-candidate, not per-(candidate,provider). With two enabled providers, a candidate is only skipped if pushed to ALL, and a mid-candidate failure on provider #2 (after #1 succeeded) records nothing → a retry re-pushes to #1.

- [ ] **Step 1: Write the failing tests**

Add/adjust tests in `outbox.test.ts` (keep existing passing ones; update any that assert the old bare-key shape). Add:

```ts
it("migrates legacy bare-key pushed-keys to mem0:<key> on read", () => {
  // write the OLD format directly
  const dir = join(process.env.AGENTGEM_HOME!, ".agentgem");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "memory-pushed-keys.json"), JSON.stringify(["oldhash1", "mem0:already"]));
  const keys = readPushedKeys();
  expect(keys.has("mem0:oldhash1")).toBe(true); // bare hash → mem0:hash
  expect(keys.has("mem0:already")).toBe(true);  // already-namespaced left as-is
});

it("pushes the same candidate to two enabled providers and records both pairs", async () => {
  writeOutbox([{ key: "k1", text: "raymond uses pnpm", kind: "preference", source: "s" }]);
  config.saveProviderConfig("mem0", { enabled: true, apiKey: "a", userId: "u" });
  config.saveProviderConfig("supermemory", { enabled: true, apiKey: "b", userId: "u" });
  const push = vi.fn(async () => ({ id: "r" }));
  vi.spyOn(registry, "getProvider").mockReturnValue({ id: "x", test: vi.fn(), pull: vi.fn(), push } as never);
  const res = await approveAndPush(["k1"]);
  expect(res.pushed).toBe(2); // one push per provider
  const pk = readPushedKeys();
  expect(pk.has("mem0:k1")).toBe(true);
  expect(pk.has("supermemory:k1")).toBe(true);
  expect(readOutbox()).toHaveLength(0);
});

it("does not re-push to a provider a pair was already sent to, but does push a newly-enabled provider", async () => {
  // pretend k1 was already pushed to mem0
  const dir = join(process.env.AGENTGEM_HOME!, ".agentgem");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "memory-pushed-keys.json"), JSON.stringify(["mem0:k1"]));
  writeOutbox([{ key: "k1", text: "x", kind: "fact", source: "s" }]);
  config.saveProviderConfig("mem0", { enabled: true, apiKey: "a" });
  config.saveProviderConfig("supermemory", { enabled: true, apiKey: "b" });
  const push = vi.fn(async () => ({ id: "r" }));
  vi.spyOn(registry, "getProvider").mockReturnValue({ id: "x", test: vi.fn(), pull: vi.fn(), push } as never);
  const res = await approveAndPush(["k1"]);
  expect(res.pushed).toBe(1);            // only supermemory (mem0 pair already sent)
  expect(readPushedKeys().has("supermemory:k1")).toBe(true);
});
```

Also keep a single-provider partial-failure test (mid-batch failure preserves earlier successes) — update it to assert `pushedKeys.has("mem0:k1")` (pair form) instead of the bare `k1`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/memory && npx vitest run src/__tests__/outbox.test.ts`
Expected: the new/updated tests FAIL (guard is still bare-key).

- [ ] **Step 3: Implement the (providerId, key) guard + migration in `outbox.ts`**

- Add a helper: `function pairKey(providerId: string, key: string): string { return \`${providerId}:${key}\`; }`
- `readPushedKeys()`: after parsing the array, map each entry: `e.includes(":") ? e : \`mem0:${e}\`` (auto-migrate legacy bare hashes to mem0). Return the `Set`.
- `approveAndPush(keys)`:
  - `approved = outbox.filter(c => keys.includes(c.key))` (do NOT pre-exclude by bare key anymore).
  - For each `cand`: for each `enabled` provider `id`, compute `pk = pairKey(id, cand.key)`; **skip if `pushedKeys.has(pk)`**; else `await getProvider(id).push(cfgs[id]!, cand)`, `pushed++`, `pushedKeys.add(pk)`. Persist pushed-keys immediately after each successful provider push (durable per-provider, so a mid-batch throw preserves earlier pairs).
  - After a candidate's providers are all processed, remove it from the outbox ONLY if every enabled provider's pair is now in `pushedKeys` (i.e. fully delivered); persist the outbox. If no provider is enabled, `skipped++` and leave it (unchanged).
- Keep `writePushedKeys` writing the pair-form array.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/memory && npx vitest run src/__tests__/outbox.test.ts`
Expected: PASS (all, including the migration + two-provider + already-sent cases).

- [ ] **Step 5: Commit**

```bash
git add packages/memory/src/outbox.ts packages/memory/src/__tests__/outbox.test.ts
git commit -m "fix(memory): re-key re-push guard on (provider,key) pairs with legacy auto-migration"
```

---

## Task 2: Supermemory adapter + registry flip

**Files:**
- Create: `packages/memory/src/providers/supermemory.ts`
- Test: `packages/memory/src/__tests__/supermemory.test.ts`
- Modify: `packages/memory/src/registry.ts`, `packages/memory/src/index.ts`, `packages/memory/src/__tests__/registry.test.ts`

**Interfaces:**
- Produces: `supermemoryProvider: MemoryProvider`; `IMPLEMENTED` now contains `mem0` and `supermemory`.

- [ ] **Step 1: Write the failing adapter test**

`packages/memory/src/__tests__/supermemory.test.ts` (mirror `mem0.test.ts`, asserting the real request shape):

```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { supermemoryProvider } from "../providers/supermemory.js";
import type { ProviderConfig } from "../types.js";

const cfg: ProviderConfig = { enabled: true, apiKey: "sk", userId: "u1" };
function mockFetch(json: unknown, ok = true, status = 200) {
  return vi.fn(async () => ({ ok, status, json: async () => json, text: async () => JSON.stringify(json) })) as unknown as typeof fetch;
}
afterEach(() => vi.restoreAllMocks());

describe("supermemory adapter", () => {
  it("test() reports ok on 200 and posts to the list endpoint with Bearer auth", async () => {
    const f = mockFetch({ memories: [] }); globalThis.fetch = f;
    expect((await supermemoryProvider.test(cfg)).ok).toBe(true);
    expect(f).toHaveBeenCalledWith(
      expect.stringContaining("/v3/documents/list"),
      expect.objectContaining({ method: "POST", headers: expect.objectContaining({ Authorization: "Bearer sk" }) }),
    );
  });

  it("test() reports not-ok on 401", async () => {
    globalThis.fetch = mockFetch({}, false, 401);
    const r = await supermemoryProvider.test(cfg);
    expect(r.ok).toBe(false); expect(r.detail).toContain("401");
  });

  it("pull() maps title+summary and early-stops on the desc-sorted cursor", async () => {
    globalThis.fetch = mockFetch({ memories: [
      { id: "m2", title: "T2", summary: "prefers vitest", updatedAt: "2026-07-12T00:00:00Z" },
      { id: "m1", title: "T1", summary: "likes dark mode", updatedAt: "2026-07-10T00:00:00Z" },
    ] });
    const out = [];
    for await (const rec of supermemoryProvider.pull(cfg, Date.parse("2026-07-11T00:00:00Z"))) out.push(rec);
    expect(out.map((r) => r.id)).toEqual(["m2"]); // m1 is <= since, desc-sorted → stop
    expect(out[0].text).toContain("prefers vitest");
  });

  it("push() posts content to /v3/documents and returns the id", async () => {
    const f = mockFetch({ id: "new-1", status: "queued" }); globalThis.fetch = f;
    const r = await supermemoryProvider.push(cfg, { key: "k", text: "raymond uses pnpm", kind: "preference", source: "s" });
    expect(r.id).toBe("new-1");
    expect(f).toHaveBeenCalledWith(
      expect.stringContaining("/v3/documents"),
      expect.objectContaining({ method: "POST", body: expect.stringContaining("raymond uses pnpm") }),
    );
  });

  it("push() throws when a 200 has no id", async () => {
    globalThis.fetch = mockFetch({ status: "queued" });
    await expect(supermemoryProvider.push(cfg, { key: "k", text: "x", kind: "fact", source: "s" })).rejects.toThrow(/no id/i);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd packages/memory && npx vitest run src/__tests__/supermemory.test.ts`
Expected: FAIL — cannot find `../providers/supermemory.js`.

- [ ] **Step 3: Write `src/providers/supermemory.ts`**

```ts
import type { MemoryProvider, MemoryRecord, ProviderConfig, PushCandidate } from "../types.js";

const DEFAULT_BASE = "https://api.supermemory.ai";

function headers(cfg: ProviderConfig): Record<string, string> {
  return { Authorization: `Bearer ${cfg.apiKey}`, "Content-Type": "application/json" };
}
function base(cfg: ProviderConfig): string {
  return (cfg.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, "");
}
function containerTags(cfg: ProviderConfig): string[] | undefined {
  return cfg.userId ? [cfg.userId] : undefined;
}

interface SmRow { id: string; title?: string; summary?: string; updatedAt?: string; metadata?: Record<string, unknown> }

export const supermemoryProvider: MemoryProvider = {
  id: "supermemory",

  async test(cfg) {
    const res = await fetch(`${base(cfg)}/v3/documents/list`, {
      method: "POST", headers: headers(cfg),
      body: JSON.stringify({ limit: 1, containerTags: containerTags(cfg) }),
    });
    return res.ok ? { ok: true } : { ok: false, detail: `supermemory returned ${res.status}` };
  },

  async *pull(cfg, since) {
    const res = await fetch(`${base(cfg)}/v3/documents/list`, {
      method: "POST", headers: headers(cfg),
      body: JSON.stringify({ limit: 200, sort: "updatedAt", order: "desc", containerTags: containerTags(cfg) }),
    });
    if (!res.ok) throw new Error(`supermemory pull failed: ${res.status}`);
    const body = (await res.json()) as { memories?: SmRow[] };
    for (const row of body.memories ?? []) {
      const updatedAt = row.updatedAt ? Date.parse(row.updatedAt) : 0;
      // desc-sorted by updatedAt → once we pass the cursor, everything after is older too.
      if (since !== undefined && updatedAt <= since) break;
      const text = [row.title, row.summary].filter(Boolean).join(" — ");
      if (!text) continue;
      yield { id: row.id, text, updatedAt, metadata: row.metadata } satisfies MemoryRecord;
    }
  },

  async push(cfg, m: PushCandidate) {
    const res = await fetch(`${base(cfg)}/v3/documents`, {
      method: "POST", headers: headers(cfg),
      body: JSON.stringify({ content: m.text, containerTags: containerTags(cfg) }),
    });
    if (!res.ok) throw new Error(`supermemory push failed: ${res.status}`);
    const body = (await res.json()) as { id?: string };
    if (!body.id) throw new Error("supermemory push: no id in response");
    return { id: body.id };
  },
};
```

> Confirm `/v3/documents/list` is the correct list endpoint against current supermemory docs; if the live API uses `/v3/memories` or different field names, update BOTH this file and the test mock consistently and note it in the report.

- [ ] **Step 4: Run the adapter test to pass**

Run: `cd packages/memory && npx vitest run src/__tests__/supermemory.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Flip the registry + exports**

In `packages/memory/src/registry.ts`:
- `import { supermemoryProvider } from "./providers/supermemory.js";`
- `export const IMPLEMENTED: ReadonlySet<ProviderId> = new Set(["mem0", "supermemory"]);`
- In `REGISTRY`, replace `supermemory: makeStub("supermemory")` with `supermemory: supermemoryProvider`.

In `packages/memory/src/index.ts`, add `export { supermemoryProvider } from "./providers/supermemory.js";`.

In `packages/memory/src/__tests__/registry.test.ts`, update the "implemented" assertions: `IMPLEMENTED.has("supermemory")` is now `true`; change the stub-rejection test to use `zep` (still a stub) if it referenced supermemory.

- [ ] **Step 6: Run the memory package suite**

Run: `cd packages/memory && npx vitest run`
Expected: PASS (all, including registry + supermemory + outbox).

- [ ] **Step 7: Commit**

```bash
git add packages/memory/src/providers/supermemory.ts packages/memory/src/registry.ts packages/memory/src/index.ts packages/memory/src/__tests__/supermemory.test.ts packages/memory/src/__tests__/registry.test.ts
git commit -m "feat(memory): implement supermemory adapter, register as implemented provider"
```

---

## Task 3: Verify end-to-end

**Files:** none (verification only).

- [ ] **Step 1: Full build + package suite**

Run: `cd packages/memory && npx tsc -b && npx vitest run` — clean + all pass.
Run from repo root: `npx tsc -b` — core still compiles.

- [ ] **Step 2: Live route check (both providers now implemented)**

Boot the local core (isolated temp home) and confirm `GET /api/memory/providers` now reports BOTH mem0 and supermemory as `implemented: true`, and zep/letta as `false`:

```bash
AGENTGEM_HOME="$(mktemp -d)" PORT=4405 node dist/index.js &   # after a build
curl -s http://127.0.0.1:4405/api/memory/providers
# expect mem0 implemented:true, supermemory implemented:true, zep/letta false
```

Also confirm `POST /api/memory/providers` with a fake supermemory key returns a not-ok test result with a status detail (real reach to api.supermemory.ai), then kill the server and clean the temp home.

- [ ] **Step 3: Commit any verification fixes**

Only if needed.

---

## Self-Review

**Spec coverage:**
- Supermemory adapter (test/pull/push, real API) → Task 2. ✓
- Registry flip + IMPLEMENTED + UI un-gate (automatic via `implemented` flag) → Task 2. ✓
- Multi-provider re-push guard on (providerId, key) with legacy auto-migration → Task 1. ✓
- No changes to routes/console/collectSignals/pull-mapping/recall → constraints hold. ✓

**Type consistency:** `supermemoryProvider`, `pairKey`, `IMPLEMENTED`, `readPushedKeys` shapes are consistent across tasks. `MemoryProvider`/`MemoryRecord`/`PushCandidate` reused unmodified.
