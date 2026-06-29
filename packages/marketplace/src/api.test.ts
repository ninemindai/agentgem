import { describe, it, expect, vi, afterEach } from "vitest";
import { makeApi } from "./api";

afterEach(() => vi.unstubAllGlobals());
const res = (body: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) }) as unknown as Response;

describe("makeApi", () => {
  it("getPopularity hits the right URL with kind/limit and returns the array", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => { calls.push(String(url)); return res([{ id: "skill:a/b", kind: "skill", producers: 1, verifiedProducers: 0, invocations: 1, sessions: 1 }]); }));
    const api = makeApi("https://x");
    const out = await api.getPopularity({ kind: "skill", limit: 5 });
    expect(out[0].id).toBe("skill:a/b");
    expect(calls[0]).toBe("https://x/api/aggregator/popularity?kind=skill&limit=5");
  });

  it("getPopularity with no query omits the querystring", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => { calls.push(String(url)); return res([]); }));
    await makeApi("https://x").getPopularity();
    expect(calls[0]).toBe("https://x/api/aggregator/popularity");
  });

  it("getCoOccurrence + getAdoption encode the id and pass params", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => { calls.push(String(url)); return res([]); }));
    const api = makeApi("https://x");
    await api.getCoOccurrence({ id: "skill:a/b" });
    await api.getAdoption({ id: "skill:a/b", bucket: "month" });
    expect(calls[0]).toBe("https://x/api/aggregator/co-occurrence?id=skill%3Aa%2Fb");
    expect(calls[1]).toBe("https://x/api/aggregator/adoption?id=skill%3Aa%2Fb&bucket=month");
  });

  it("rejects on a non-2xx response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500, text: async () => "" }) as unknown as Response));
    await expect(makeApi("https://x").getPopularity()).rejects.toThrow(/500/);
  });
});
