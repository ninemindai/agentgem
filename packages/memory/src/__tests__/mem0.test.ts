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
    const f = mockFetch({ results: [] });
    globalThis.fetch = f;
    const r = await mem0Provider.test(cfg);
    expect(r.ok).toBe(true);
    expect(f).toHaveBeenCalledWith(
      expect.stringContaining("/v3/memories/"),
      expect.objectContaining({ method: "POST", body: expect.stringContaining("user_id") }),
    );
  });

  it("test() reports not-ok on a 401", async () => {
    globalThis.fetch = mockFetch({ detail: "bad key" }, false, 401);
    const r = await mem0Provider.test(cfg);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("401");
  });

  it("pull() maps results to MemoryRecord and filters by since", async () => {
    const f = mockFetch({ results: [
      { id: "m1", memory: "likes dark mode", updated_at: "2026-07-10T00:00:00Z" },
      { id: "m2", memory: "prefers vitest", updated_at: "2026-07-12T00:00:00Z" },
    ] });
    globalThis.fetch = f;
    const out = [];
    for await (const rec of mem0Provider.pull(cfg, Date.parse("2026-07-11T00:00:00Z"))) out.push(rec);
    expect(out).toEqual([
      { id: "m2", text: "prefers vitest", updatedAt: Date.parse("2026-07-12T00:00:00Z"), metadata: undefined },
    ]);
    expect(f).toHaveBeenCalledWith(
      expect.stringContaining("/v3/memories/"),
      expect.objectContaining({ method: "POST", body: expect.stringContaining("user_id") }),
    );
  });

  it("pull() follows the next cursor across pages", async () => {
    const page1 = { results: [
      { id: "m1", memory: "likes dark mode", updated_at: "2026-07-10T00:00:00Z" },
    ], next: "https://api.mem0.ai/v3/memories/?page=2" };
    const page2 = { results: [
      { id: "m2", memory: "prefers vitest", updated_at: "2026-07-12T00:00:00Z" },
    ], next: null };
    const f = vi.fn(async (url: string) => {
      const json = url.includes("page=2") ? page2 : page1;
      return { ok: true, status: 200, json: async () => json, text: async () => JSON.stringify(json) };
    }) as unknown as typeof fetch;
    globalThis.fetch = f;
    const out = [];
    for await (const rec of mem0Provider.pull(cfg)) out.push(rec);
    expect(out.map((r) => r.id)).toEqual(["m1", "m2"]);
    expect(f).toHaveBeenCalledTimes(2);
    expect(f).toHaveBeenNthCalledWith(2, "https://api.mem0.ai/v3/memories/?page=2", expect.objectContaining({ headers: expect.anything() }));
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
    expect(f).toHaveBeenCalledWith(
      expect.stringContaining("/v3/memories/add/"),
      expect.objectContaining({ method: "POST", body: expect.stringContaining("messages") }),
    );
  });

  it("push() throws when the 200 body lacks event_id", async () => {
    globalThis.fetch = mockFetch({ status: "PENDING" });
    await expect(
      mem0Provider.push(cfg, { key: "k", text: "raymond uses pnpm", kind: "preference", source: "distill:x" }),
    ).rejects.toThrow(/no event_id/);
  });
});
