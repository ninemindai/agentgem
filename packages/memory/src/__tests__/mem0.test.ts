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
    // mem0's real POST /v3/memories/add/ is async: it returns an event_id for the
    // queued extraction job, not an immediate memory id (confirmed against
    // docs.mem0.ai/api-reference/memory/add-memories, 2026-07-13).
    const f = mockFetch({ status: "PENDING", event_id: "new-1" });
    globalThis.fetch = f;
    const r = await mem0Provider.push(cfg, { key: "k", text: "raymond uses pnpm", kind: "preference", source: "distill:x" });
    expect(r.id).toBe("new-1");
    expect(f).toHaveBeenCalledOnce();
  });
});
