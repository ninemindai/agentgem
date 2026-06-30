import { describe, it, expect, vi, afterEach } from "vitest";
import { makeAuth } from "./auth";

afterEach(() => vi.unstubAllGlobals());
const res = (body: unknown, ok = true) => ({ ok, status: ok ? 200 : 401, json: async () => body }) as unknown as Response;

describe("makeAuth", () => {
  it("getMe returns the identity when authenticated (credentials included)", async () => {
    let opts: RequestInit | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_u: string, o?: RequestInit) => { opts = o; return res({ login: "octocat", avatarUrl: "a.png" }); }));
    const auth = makeAuth("https://app.x");
    expect(await auth.getMe()).toEqual({ login: "octocat", avatarUrl: "a.png" });
    expect(opts?.credentials).toBe("include");
  });
  it("getMe returns null when unauthenticated", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => res({ authenticated: false })));
    expect(await makeAuth("https://app.x").getMe()).toBeNull();
  });
  it("getMe returns null on a network error (never throws to the UI)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("net"); }));
    expect(await makeAuth("https://app.x").getMe()).toBeNull();
  });
  it("loginUrl points at the API login with an encoded return", () => {
    expect(makeAuth("https://app.x").loginUrl("https://explore.y/gems"))
      .toBe("https://app.x/api/auth/github/login?return=" + encodeURIComponent("https://explore.y/gems"));
  });
  it("logout POSTs with credentials", async () => {
    let method: string | undefined, cred: RequestCredentials | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_u: string, o?: RequestInit) => { method = o?.method; cred = o?.credentials; return res({ ok: true }); }));
    await makeAuth("https://app.x").logout();
    expect(method).toBe("POST");
    expect(cred).toBe("include");
  });
});
