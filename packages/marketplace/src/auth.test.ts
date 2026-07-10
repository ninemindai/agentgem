import { describe, it, expect, vi, afterEach } from "vitest";
import { makeAuth } from "./auth";

const res = (body: unknown, ok = true, status = 200) =>
  ({ ok, status, json: async () => body } as unknown as Response);

afterEach(() => vi.unstubAllGlobals());

describe("getMe", () => {
  it("returns a Me for a login-less (Google) session — id present, login absent", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      res({ user: { id: "uuid-1", name: "Ray Feng", handle: null, login: undefined, image: "http://a/x.png" }, orgs: [] })));
    const me = await makeAuth("https://api.x").getMe();
    expect(me).toEqual({ id: "uuid-1", name: "Ray Feng", handle: null, avatarUrl: "http://a/x.png", orgs: [] });
  });

  it("keeps a GitHub user's handle from their login-backed handle field", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      res({ user: { id: "uuid-2", name: "octocat", handle: "octocat", login: "octocat", image: null }, orgs: [{ scope: "ninemind", role: "admin" }] })));
    const me = await makeAuth("https://api.x").getMe();
    expect(me).toMatchObject({ id: "uuid-2", name: "octocat", handle: "octocat", orgs: [{ scope: "ninemind", role: "admin" }] });
  });

  it("returns null when there is no session (no user id)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => res(null)));
    expect(await makeAuth("https://api.x").getMe()).toBeNull();
  });

  it("returns null on a non-2xx get-session", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => res(null, false, 500)));
    expect(await makeAuth("https://api.x").getMe()).toBeNull();
  });

  it("getMe returns null on a network error (never throws to the UI)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("net"); }));
    expect(await makeAuth("https://api.x").getMe()).toBeNull();
  });
});

describe("makeAuth", () => {
  it("signIn POSTs to sign-in/social with the GitHub provider + callbackURL, then follows the returned url", async () => {
    let url: string | undefined, opts: RequestInit | undefined;
    vi.stubGlobal("fetch", vi.fn(async (u: string, o?: RequestInit) => {
      url = u; opts = o;
      return res({ url: "https://github.com/login/oauth/authorize?state=abc", redirect: true });
    }));
    const assign = vi.fn();
    vi.stubGlobal("location", { assign } as unknown as Location);
    await makeAuth("https://app.x").signIn("github", "https://explore.y/gems");
    expect(url).toBe("https://app.x/api/auth/sign-in/social");
    expect(opts?.method).toBe("POST");
    expect(opts?.credentials).toBe("include");
    expect(JSON.parse(opts!.body as string)).toEqual({ provider: "github", callbackURL: "https://explore.y/gems" });
    expect(assign).toHaveBeenCalledWith("https://github.com/login/oauth/authorize?state=abc");
  });
  it("signIn throws (rather than silently no-opping) on a network error, so a caller can render it", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("net"); }));
    const assign = vi.fn();
    vi.stubGlobal("location", { assign } as unknown as Location);
    await expect(makeAuth("https://app.x").signIn("github", "https://explore.y/gems")).rejects.toThrow("net");
    expect(assign).not.toHaveBeenCalled();
  });
  it("signIn throws and does not navigate on a non-2xx response (misconfigured provider, rate-limit, 5xx)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => res({ error: "provider not configured" }, false, 401)));
    const assign = vi.fn();
    vi.stubGlobal("location", { assign } as unknown as Location);
    await expect(makeAuth("https://app.x").signIn("github", "https://explore.y/gems")).rejects.toThrow(/401/);
    expect(assign).not.toHaveBeenCalled();
  });
  it("signIn throws and does not navigate on a 2xx response with no url (malformed body)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => res({ redirect: true })));
    const assign = vi.fn();
    vi.stubGlobal("location", { assign } as unknown as Location);
    await expect(makeAuth("https://app.x").signIn("github", "https://explore.y/gems")).rejects.toThrow(/no redirect url/);
    expect(assign).not.toHaveBeenCalled();
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

describe("signIn", () => {
  it("POSTs sign-in/social with the given provider and follows the returned url", async () => {
    let body: string | undefined;
    const assign = vi.fn();
    vi.stubGlobal("location", { assign } as unknown as Location);
    vi.stubGlobal("fetch", vi.fn(async (_u: string, o?: RequestInit) => {
      body = o?.body as string;
      return res({ url: "https://accounts.google.com/o/oauth2/v2/auth?state=abc", redirect: true });
    }));
    await makeAuth("https://api.x").signIn("google", "https://app.x/gems");
    expect(JSON.parse(body!)).toEqual({ provider: "google", callbackURL: "https://app.x/gems" });
    expect(assign).toHaveBeenCalledWith("https://accounts.google.com/o/oauth2/v2/auth?state=abc");
  });
});
