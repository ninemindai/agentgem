import { describe, it, expect, vi, afterEach } from "vitest";
import { makeStars, NotSignedIn } from "./stars";

afterEach(() => vi.unstubAllGlobals());
const res = (body: unknown, ok = true, status = 200) => ({ ok, status, json: async () => body }) as unknown as Response;

describe("makeStars", () => {
  it("get requests counts+mine with credentials and the encoded ids", async () => {
    let url = "", cred: RequestCredentials | undefined;
    vi.stubGlobal("fetch", vi.fn(async (u: string, o?: RequestInit) => { url = String(u); cred = o?.credentials; return res({ counts: { x: 2 }, mine: ["x"] }); }));
    const out = await makeStars("https://app.x").get("gem", ["x", "y"]);
    expect(out).toEqual({ counts: { x: 2 }, mine: ["x"] });
    expect(url).toBe("https://app.x/api/stars?kind=gem&ids=" + encodeURIComponent("x,y"));
    expect(cred).toBe("include");
  });
  it("toggle POSTs with credentials and returns {starred,count}", async () => {
    let method: string | undefined, cred: RequestCredentials | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_u: string, o?: RequestInit) => { method = o?.method; cred = o?.credentials; return res({ starred: true, count: 1 }); }));
    expect(await makeStars("https://app.x").toggle("gem", "x")).toEqual({ starred: true, count: 1 });
    expect(method).toBe("POST"); expect(cred).toBe("include");
  });
  it("toggle throws NotSignedIn on 401", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => res({ error: "sign in required" }, false, 401)));
    await expect(makeStars("https://app.x").toggle("gem", "x")).rejects.toBeInstanceOf(NotSignedIn);
  });
});
