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

  it("pull() maps title+summary, early-stops on the desc-sorted cursor, and posts the expected list request", async () => {
    const f = mockFetch({ memories: [
      { id: "m2", title: "T2", summary: "prefers vitest", updatedAt: "2026-07-12T00:00:00Z" },
      { id: "m1", title: "T1", summary: "likes dark mode", updatedAt: "2026-07-10T00:00:00Z" },
    ] });
    globalThis.fetch = f;
    const out = [];
    for await (const rec of supermemoryProvider.pull(cfg, Date.parse("2026-07-11T00:00:00Z"))) out.push(rec);
    expect(out.map((r) => r.id)).toEqual(["m2"]); // m1 is <= since, desc-sorted → stop
    expect(out[0].text).toContain("prefers vitest");
    expect(f).toHaveBeenCalledWith(
      expect.stringContaining("/v3/documents/list"),
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer sk" }),
        body: JSON.stringify({ limit: 200, sort: "updatedAt", order: "desc", containerTags: ["u1"] }),
      }),
    );
  });

  it("pull() skips a mid-list record with no title and no summary without stopping early", async () => {
    globalThis.fetch = mockFetch({ memories: [
      { id: "m3", title: "T3", summary: "newest", updatedAt: "2026-07-13T00:00:00Z" },
      { id: "m-empty", updatedAt: "2026-07-12T00:00:00Z" }, // no title, no summary → text === "" → continue
      { id: "m2", title: "T2", summary: "prefers vitest", updatedAt: "2026-07-11T00:00:00Z" },
    ] });
    const out = [];
    for await (const rec of supermemoryProvider.pull(cfg, Date.parse("2026-07-10T00:00:00Z"))) out.push(rec);
    expect(out.map((r) => r.id)).toEqual(["m3", "m2"]); // empty record skipped, loop continues past it
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
