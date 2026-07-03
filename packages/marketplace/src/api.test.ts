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

  it("getProfile hits the right URL and returns the parsed profile", async () => {
    const calls: string[] = [];
    const profile = { login: "octocat", avatarUrl: null, verified: true, githubUrl: "https://github.com/octocat", totalStars: 3, gems: [] };
    vi.stubGlobal("fetch", vi.fn(async (url: string) => { calls.push(String(url)); return res(profile); }));
    const out = await makeApi("https://x").getProfile("octocat");
    expect(out).toMatchObject({ login: "octocat", verified: true });
    expect(calls[0]).toBe("https://x/api/aggregator/profile?login=octocat");
  });

  it("getProfile returns null on 404", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 404, text: async () => "" }) as unknown as Response));
    expect(await makeApi("https://x").getProfile("nobody")).toBeNull();
  });

  it("getOrgCatalog returns the parsed catalog on 200", async () => {
    const body = { scope: "acme", gemCount: 1, ownerCount: 1, gems: [] };
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(body)) });
    vi.stubGlobal("fetch", fetchMock);
    const api = makeApi("http://x");
    expect(await api.getOrgCatalog("acme")).toEqual(body);
    expect(String(fetchMock.mock.calls[0][0])).toContain("/api/aggregator/org-catalog?scope=acme");
  });

  it("getOrgCatalog returns null on 400 (malformed scope)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 400, text: () => Promise.resolve("") }));
    const api = makeApi("http://x");
    expect(await api.getOrgCatalog("bad/scope")).toBeNull();
  });
});

describe("makeApi sources", () => {
  it("getSources unwraps {sources}", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => res({ sources: [{ id: "agency-agents", label: "The Agency", description: "d", repo: "o/r", ref: "main", kind: "agency-layout" }] })));
    const out = await makeApi("").getSources();
    expect(out[0].id).toBe("agency-agents");
  });

  it("importSourceSkill GETs the source/path querystring and returns content", async () => {
    const spy = vi.fn(async (_url: string | URL, _init?: RequestInit) => res({ name: "ai-engineer", content: "SKILL_BODY" }));
    vi.stubGlobal("fetch", spy);
    const out = await makeApi("").importSourceSkill("agency-agents", "engineering/ai-engineer.md");
    expect(out.content).toBe("SKILL_BODY");
    expect(String(spy.mock.calls[0][0])).toBe("/api/sources/import?source=agency-agents&path=engineering%2Fai-engineer.md");
    // the `get` helper passes no init — it's a plain fetch(url), not a POST with a JSON body
    expect(spy.mock.calls[0][1]).toBeUndefined();
  });
});
