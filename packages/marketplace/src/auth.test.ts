import { describe, it, expect, vi, afterEach } from "vitest";
import { makeAuth } from "./auth";

afterEach(() => vi.unstubAllGlobals());
const res = (body: unknown, ok = true) => ({ ok, status: ok ? 200 : 401, json: async () => body }) as unknown as Response;

describe("makeAuth", () => {
  it("getMe maps better-auth's get-session { user } into the SPA's Me shape (credentials included)", async () => {
    let url: string | undefined, opts: RequestInit | undefined;
    vi.stubGlobal("fetch", vi.fn(async (u: string, o?: RequestInit) => {
      url = u; opts = o;
      return res({ session: { token: "t" }, user: { login: "octocat", image: "a.png" } });
    }));
    const auth = makeAuth("https://app.x");
    expect(await auth.getMe()).toEqual({ login: "octocat", avatarUrl: "a.png", orgs: [] });
    expect(url).toBe("https://app.x/api/auth/get-session");
    expect(opts?.credentials).toBe("include");
  });
  it("getMe returns null when better-auth reports no session (null body)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => res(null)));
    expect(await makeAuth("https://app.x").getMe()).toBeNull();
  });
  it("getMe returns null on a network error (never throws to the UI)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("net"); }));
    expect(await makeAuth("https://app.x").getMe()).toBeNull();
  });
  it("signIn POSTs to sign-in/social with the GitHub provider + callbackURL, then follows the returned url", async () => {
    let url: string | undefined, opts: RequestInit | undefined;
    vi.stubGlobal("fetch", vi.fn(async (u: string, o?: RequestInit) => {
      url = u; opts = o;
      return res({ url: "https://github.com/login/oauth/authorize?state=abc", redirect: true });
    }));
    const assign = vi.fn();
    vi.stubGlobal("location", { assign } as unknown as Location);
    await makeAuth("https://app.x").signIn("https://explore.y/gems");
    expect(url).toBe("https://app.x/api/auth/sign-in/social");
    expect(opts?.method).toBe("POST");
    expect(opts?.credentials).toBe("include");
    expect(JSON.parse(opts!.body as string)).toEqual({ provider: "github", callbackURL: "https://explore.y/gems" });
    expect(assign).toHaveBeenCalledWith("https://github.com/login/oauth/authorize?state=abc");
  });
  it("signIn never throws to the UI on a network error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("net"); }));
    await expect(makeAuth("https://app.x").signIn("https://explore.y/gems")).resolves.toBeUndefined();
  });
  it("logout POSTs sign-out with credentials", async () => {
    let url: string | undefined, method: string | undefined, cred: RequestCredentials | undefined;
    vi.stubGlobal("fetch", vi.fn(async (u: string, o?: RequestInit) => { url = u; method = o?.method; cred = o?.credentials; return res({ ok: true }); }));
    await makeAuth("https://app.x").logout();
    expect(url).toBe("https://app.x/api/auth/sign-out");
    expect(method).toBe("POST");
    expect(cred).toBe("include");
  });
});
