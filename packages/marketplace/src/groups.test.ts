import { describe, it, expect, vi, afterEach } from "vitest";
import { makeGroups } from "./groups";
import { NotSignedIn } from "./stars";

afterEach(() => vi.unstubAllGlobals());

function stub(handler: (url: string, init?: RequestInit) => { status?: number; body?: unknown }) {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const { status = 200, body = {} } = handler(url, init);
    return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
  }));
}

describe("makeGroups", () => {
  it("list returns the groups array and sends credentials", async () => {
    const seen: RequestInit[] = [];
    stub((url, init) => { seen.push(init ?? {}); return { body: { groups: [{ id: "g1", name: "Team", role: "admin", kind: "native", installationId: null, scope: null }] } }; });
    const groups = await makeGroups("http://x").list();
    expect(groups[0]).toMatchObject({ id: "g1", name: "Team", role: "admin" });
    expect(seen[0].credentials).toBe("include");
  });

  it("create posts the name and returns the group", async () => {
    let sentBody: any;
    stub((_url, init) => { sentBody = JSON.parse(String(init?.body)); return { body: { group: { id: "g2", name: "Friends", role: "admin", kind: "native", installationId: null, scope: null } } }; });
    const g = await makeGroups("http://x").create("Friends");
    expect(sentBody).toEqual({ name: "Friends" });
    expect(g.name).toBe("Friends");
  });

  it("throws NotSignedIn on 401", async () => {
    stub(() => ({ status: 401 }));
    await expect(makeGroups("http://x").list()).rejects.toBeInstanceOf(NotSignedIn);
  });

  it("surfaces the server error message on non-401 failure", async () => {
    stub(() => ({ status: 400, body: { error: "name required (1-80 chars)" } }));
    await expect(makeGroups("http://x").create("")).rejects.toThrow(/name required/);
  });

  it("createInvite posts to the id-scoped URL and returns the one-time token", async () => {
    let url = "";
    stub((u) => { url = u; return { body: { id: "i1", token: "SECRET", expiresAt: "2026-07-18T00:00:00.000Z" } }; });
    const inv = await makeGroups("http://x").createInvite("g1", { role: "member" });
    expect(url).toContain("/api/catalog/group-invites?id=g1");
    expect(inv.token).toBe("SECRET");
  });

  it("groupGems returns the shared-apps list", async () => {
    stub(() => ({ body: { gems: [{ gemKey: "o/app", version: "1.0.0", description: "hi", artifactKinds: ["game"], installable: true }] } }));
    const gems = await makeGroups("http://x").groupGems("g1");
    expect(gems[0].gemKey).toBe("o/app");
  });
});
