import { describe, it, expect, vi, afterEach } from "vitest";
import { makeApi } from "./api";

afterEach(() => vi.unstubAllGlobals());
const res = (body: unknown, ok = true) => ({ ok, status: ok ? 200 : 500, text: async () => JSON.stringify(body) }) as unknown as Response;

describe("recordPlay", () => {
  it("POSTs the gem, version and visitor id to the play beacon", async () => {
    let url = "", init: RequestInit | undefined;
    vi.stubGlobal("fetch", vi.fn(async (u: string, o?: RequestInit) => { url = String(u); init = o; return res({ ok: true }); }));
    await makeApi("https://api.x").recordPlay("@octocat/duel", "1.0.0", "v1");
    expect(url).toBe("https://api.x/api/aggregator/game-play");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ gemKey: "@octocat/duel", version: "1.0.0", visitorId: "v1" });
  });

  it("omits an empty visitor id rather than sending a blank one", async () => {
    let init: RequestInit | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_u: string, o?: RequestInit) => { init = o; return res({ ok: true }); }));
    await makeApi("https://api.x").recordPlay("@octocat/duel", "1.0.0", "");
    expect(JSON.parse(String(init?.body))).toEqual({ gemKey: "@octocat/duel", version: "1.0.0" });
  });

  it("swallows a failed beacon — telemetry must never stop the game from opening", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    await expect(makeApi("https://api.x").recordPlay("@octocat/duel", "1.0.0", "v1")).resolves.toBeUndefined();
  });
});

describe("getGamePlays", () => {
  it("fetches counts for the given keys and returns them keyed by gem", async () => {
    let url = "";
    vi.stubGlobal("fetch", vi.fn(async (u: string) => { url = String(u); return res({ items: [{ gemKey: "@octocat/duel", plays: 7 }] }); }));
    expect(await makeApi("https://api.x").getGamePlays(["@octocat/duel", "@octocat/maze"])).toEqual({ "@octocat/duel": 7 });
    expect(url).toBe("https://api.x/api/aggregator/game-plays?keys=" + encodeURIComponent("@octocat/duel,@octocat/maze"));
  });
});
