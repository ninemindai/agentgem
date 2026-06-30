import { describe, it, expect, vi } from "vitest";
import { searchSkills } from "@agentgem/insight";

const ok = (body: unknown) =>
  ({ ok: true, status: 200, json: async () => body }) as unknown as Response;

describe("searchSkills", () => {
  it("parses, maps and sorts by installs desc", async () => {
    const fetchImpl = vi.fn<(url: string) => Promise<Response>>(async () =>
      ok({ skills: [
        { id: "a/b/low", skillId: "low", name: "low", source: "a/b", installs: 10 },
        { id: "c/d/high", skillId: "high", name: "high", source: "c/d", installs: 999 },
      ] }));
    const out = await searchSkills("react", { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(out.map((s: any) => s.name)).toEqual(["high", "low"]);
    const url = String(fetchImpl.mock.calls[0]?.[0]);
    expect(url).toContain("https://skills.sh/api/search?");
    expect(url).toContain("q=react");
    expect(url).toContain("limit=10");
  });

  it("passes owner and a custom limit", async () => {
    const fetchImpl = vi.fn<(url: string) => Promise<Response>>(async () => ok({ skills: [] }));
    await searchSkills("x", { owner: "vercel", limit: 3, fetchImpl: fetchImpl as unknown as typeof fetch });
    const url = String(fetchImpl.mock.calls[0]?.[0]);
    expect(url).toContain("owner=vercel");
    expect(url).toContain("limit=3");
  });

  it("returns [] on non-200", async () => {
    const fetchImpl = vi.fn<(url: string) => Promise<Response>>(async () => ({ ok: false, status: 503 }) as unknown as Response);
    expect(await searchSkills("x", { fetchImpl: fetchImpl as unknown as typeof fetch })).toEqual([]);
  });

  it("returns [] on a thrown/network error", async () => {
    const fetchImpl = vi.fn<(url: string) => Promise<Response>>(async () => { throw new Error("offline"); });
    expect(await searchSkills("x", { fetchImpl: fetchImpl as unknown as typeof fetch })).toEqual([]);
  });

  it("returns [] when the body is malformed", async () => {
    const fetchImpl = vi.fn<(url: string) => Promise<Response>>(async () => ok({ nope: true }));
    expect(await searchSkills("x", { fetchImpl: fetchImpl as unknown as typeof fetch })).toEqual([]);
  });

  it("drops rows missing name or source", async () => {
    const fetchImpl = vi.fn<(url: string) => Promise<Response>>(async () =>
      ok({ skills: [
        { id: "a/b/ok", skillId: "ok", name: "ok", source: "a/b", installs: 1 },
        { id: "x", name: "", source: "a/b" },
        { id: "y", skillId: "z", name: "z", source: "" },
      ] }));
    const out = await searchSkills("x", { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(out.map((s: any) => s.name)).toEqual(["ok"]);
  });
});
