import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { Account } from "./Account";
import { makeApi } from "../api";
import type { Me } from "../auth";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.pushState({}, "", "/account");
  try { sessionStorage.clear(); } catch { /* ignore */ }
});

const me: Me = { id: "u1", name: "octocat", handle: "octocat", avatarUrl: null, orgs: [] };

const res = (body: unknown, ok = true, status = 200) =>
  ({ ok, status, text: async () => JSON.stringify(body), json: async () => body }) as unknown as Response;

describe("Account page", () => {
  it("lists connected providers and offers Connect for the missing one; clicking Connect triggers link-social", async () => {
    let linkBody: string | undefined;
    vi.stubGlobal("fetch", vi.fn(async (u: string, o?: RequestInit) => {
      if (u.includes("/api/account/providers")) return res({ connected: ["github"] });
      if (u.includes("/api/auth/link-social")) { linkBody = o?.body as string; return res({ url: "https://accounts.google.com/o?state=abc", redirect: true }); }
      throw new Error("unexpected fetch: " + u);
    }));
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign, origin: "https://app.x", pathname: "/account", href: "https://app.x/account", search: "" } as unknown as Location);

    render(<Account api={makeApi("https://api.x")} me={me} base="https://api.x" />);

    expect(await screen.findByText("GitHub connected")).toBeTruthy();
    const connectGoogle = await screen.findByRole("button", { name: "Connect Google" });

    fireEvent.click(connectGoogle);

    await waitFor(() => expect(linkBody).toBeDefined());
    // callbackURL AND errorCallbackURL must both point back to /account: better-auth's OAuth
    // callback error path reads errorCallbackURL specifically (not callbackURL) when the
    // provider collides with a different account — omitting it strands the user on better-auth's
    // dead default /error route instead of returning here with ?error=... (see auth.ts).
    expect(JSON.parse(linkBody!)).toMatchObject({
      provider: "google",
      callbackURL: "https://app.x/account",
      errorCallbackURL: "https://app.x/account",
    });
    expect(assign).toHaveBeenCalledWith("https://accounts.google.com/o?state=abc");
  });

  it("prompts sign-in when signed out, instead of fetching providers", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    render(<Account api={makeApi("https://api.x")} me={null} base="https://api.x" />);
    expect(await screen.findByRole("link", { name: /sign in with github/i })).toBeTruthy();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("surfaces a plain message when link-social's OAuth round trip collides with another account, then strips ?error= from the address bar so a refresh doesn't re-show it", async () => {
    vi.stubGlobal("fetch", vi.fn(async (u: string) => {
      if (u.includes("/api/account/providers")) return res({ connected: ["github"] });
      throw new Error("unexpected fetch: " + u);
    }));
    window.history.pushState({}, "", "/account?error=account_already_linked_to_different_user");

    render(<Account api={makeApi("https://api.x")} me={me} base="https://api.x" />);

    expect(await screen.findByText(/already linked to another AgentGem account/i)).toBeTruthy();
    // The banner itself is expected to still be showing (read once at mount) — it's the URL that
    // must be cleaned so a refresh, or a later Connect's returnTo, doesn't pick the param back up.
    expect(window.location.pathname).toBe("/account");
    expect(window.location.search).toBe("");
  });

  it("sends a clean callbackURL/errorCallbackURL (no stale ?error=) when Connect is triggered from a URL that still carries a collision error", async () => {
    let linkBody: string | undefined;
    vi.stubGlobal("fetch", vi.fn(async (u: string, o?: RequestInit) => {
      if (u.includes("/api/account/providers")) return res({ connected: ["github"] });
      if (u.includes("/api/auth/link-social")) { linkBody = o?.body as string; return res({ url: "https://accounts.google.com/o?state=abc", redirect: true }); }
      throw new Error("unexpected fetch: " + u);
    }));
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign, origin: "https://app.x", pathname: "/account", href: "https://app.x/account?error=account_already_linked_to_different_user", search: "?error=account_already_linked_to_different_user" } as unknown as Location);

    render(<Account api={makeApi("https://api.x")} me={me} base="https://api.x" />);

    const connectGoogle = await screen.findByRole("button", { name: "Connect Google" });
    fireEvent.click(connectGoogle);

    await waitFor(() => expect(linkBody).toBeDefined());
    expect(JSON.parse(linkBody!)).toMatchObject({
      provider: "google",
      callbackURL: "https://app.x/account",
      errorCallbackURL: "https://app.x/account",
    });
  });

  it("ignores an unknown connected provider id (e.g. \"credential\") rather than rendering it", async () => {
    vi.stubGlobal("fetch", vi.fn(async (u: string) => {
      if (u.includes("/api/account/providers")) return res({ connected: ["github", "credential"] });
      throw new Error("unexpected fetch: " + u);
    }));
    render(<Account api={makeApi("https://api.x")} me={me} base="https://api.x" />);
    expect(await screen.findByText("GitHub connected")).toBeTruthy();
    expect(screen.queryByText(/credential/i)).toBeNull();
  });

  it("carries which provider a collision was for across the redirect, so Merge targets the right one", async () => {
    vi.stubGlobal("fetch", vi.fn(async (u: string, o?: RequestInit) => {
      if (u.includes("/api/account/providers")) return res({ connected: ["github"] });
      if (u.includes("/api/auth/link-social")) { void o; return res({ url: "https://accounts.google.com/o?state=abc", redirect: true }); }
      throw new Error("unexpected fetch: " + u);
    }));
    const assignBeforeRedirect = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign: assignBeforeRedirect, origin: "https://app.x", pathname: "/account", href: "https://app.x/account", search: "" } as unknown as Location);

    // First mount: clicking Connect Google stashes "google" as the in-flight attempt before the
    // full-page OAuth redirect (which a real browser would now follow — this test doesn't simulate
    // navigating away, just the write side).
    const { unmount } = render(<Account api={makeApi("https://api.x")} me={me} base="https://api.x" />);
    fireEvent.click(await screen.findByRole("button", { name: "Connect Google" }));
    await waitFor(() => expect(assignBeforeRedirect).toHaveBeenCalled());
    unmount();

    // Second mount simulates the page reloading fresh after the OAuth round trip collides: the
    // provider is no longer in memory, only in sessionStorage from the first mount.
    const assignOnMerge = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign: assignOnMerge, origin: "https://app.x", pathname: "/account", href: "https://app.x/account", search: "?error=account_already_linked_to_different_user" } as unknown as Location);
    window.history.pushState({}, "", "/account?error=account_already_linked_to_different_user");

    render(<Account api={makeApi("https://api.x")} me={me} base="https://api.x" />);
    const mergeBtn = await screen.findByRole("button", { name: /merge this account/i });
    fireEvent.click(mergeBtn);
    expect(assignOnMerge).toHaveBeenCalledWith("https://api.x/api/account/connect/google");
  });

  it("withholds the Merge button when the attempted provider wasn't carried (defensive: no guessing)", async () => {
    vi.stubGlobal("fetch", vi.fn(async (u: string) => {
      if (u.includes("/api/account/providers")) return res({ connected: ["github"] });
      throw new Error("unexpected fetch: " + u);
    }));
    window.history.pushState({}, "", "/account?error=account_already_linked_to_different_user");
    render(<Account api={makeApi("https://api.x")} me={me} base="https://api.x" />);
    expect(await screen.findByText(/already linked to another AgentGem account/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /merge this account/i })).toBeNull();
  });

  it("on ?connect=ready, confirming calls POST /api/account/absorb, shows the refreshed provider list, and reloads", async () => {
    let absorbCalled = false;
    vi.stubGlobal("fetch", vi.fn(async (u: string, o?: RequestInit) => {
      if (u.includes("/api/account/providers")) return res({ connected: ["github"] });
      if (u.includes("/api/account/absorb") && o?.method === "POST") { absorbCalled = true; return res({ keep: "u1", connected: ["github", "google"] }); }
      throw new Error("unexpected fetch: " + u);
    }));
    const reload = vi.fn();
    vi.stubGlobal("location", { ...window.location, reload, pathname: "/account", search: "?connect=ready" } as unknown as Location);

    render(<Account api={makeApi("https://api.x")} me={me} base="https://api.x" />);

    expect(await screen.findByText(/merges the just-verified account/i)).toBeTruthy();
    const confirmBtn = screen.getByRole("button", { name: "Connect" });
    fireEvent.click(confirmBtn);

    expect(await screen.findByText("Google connected")).toBeTruthy();
    expect(absorbCalled).toBe(true);
    expect(reload).toHaveBeenCalled();
  });

  it("shows the server's message on absorb 409 (merge not supported) instead of reloading", async () => {
    vi.stubGlobal("fetch", vi.fn(async (u: string, o?: RequestInit) => {
      if (u.includes("/api/account/providers")) return res({ connected: ["github"] });
      if (u.includes("/api/account/absorb") && o?.method === "POST") {
        return res({ error: "Both accounts have activity on AgentGem. Merging accounts with existing gems or a claimed handle isn't supported yet." }, false, 409);
      }
      throw new Error("unexpected fetch: " + u);
    }));
    const reload = vi.fn();
    vi.stubGlobal("location", { ...window.location, reload, pathname: "/account", search: "?connect=ready" } as unknown as Location);

    render(<Account api={makeApi("https://api.x")} me={me} base="https://api.x" />);
    fireEvent.click(await screen.findByRole("button", { name: "Connect" }));

    expect(await screen.findByText(/merging accounts with existing gems/i)).toBeTruthy();
    expect(reload).not.toHaveBeenCalled();
    // the confirm button stays available to retry
    expect(screen.getByRole("button", { name: "Connect" })).toBeTruthy();
  });

  it("shows a brief notice on ?connect=none, without offering a confirm", async () => {
    vi.stubGlobal("fetch", vi.fn(async (u: string) => {
      if (u.includes("/api/account/providers")) return res({ connected: ["github"] });
      throw new Error("unexpected fetch: " + u);
    }));
    vi.stubGlobal("location", { ...window.location, pathname: "/account", search: "?connect=none" } as unknown as Location);
    render(<Account api={makeApi("https://api.x")} me={me} base="https://api.x" />);
    expect(await screen.findByText(/nothing new to connect/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Connect" })).toBeNull();
  });

  it("shows a brief notice on ?connect=error, without offering a confirm", async () => {
    vi.stubGlobal("fetch", vi.fn(async (u: string) => {
      if (u.includes("/api/account/providers")) return res({ connected: ["github"] });
      throw new Error("unexpected fetch: " + u);
    }));
    vi.stubGlobal("location", { ...window.location, pathname: "/account", search: "?connect=error" } as unknown as Location);
    render(<Account api={makeApi("https://api.x")} me={me} base="https://api.x" />);
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toMatch(/went wrong connecting/i);
    expect(screen.queryByRole("button", { name: "Connect" })).toBeNull();
  });

  it("shows the handle-claim nudge banner from ?merge=1&handle=, without naming a provider", async () => {
    vi.stubGlobal("fetch", vi.fn(async (u: string) => {
      if (u.includes("/api/account/providers")) return res({ connected: ["github"] });
      throw new Error("unexpected fetch: " + u);
    }));
    vi.stubGlobal("location", { ...window.location, pathname: "/account", search: "?merge=1&handle=raymond" } as unknown as Location);
    render(<Account api={makeApi("https://api.x")} me={me} base="https://api.x" />);
    const banner = await screen.findByText(/that handle \(@raymond\) isn't available\. if you have another account that might own it, connect it below\./i);
    expect(banner).toBeTruthy();
    expect(banner.textContent).not.toMatch(/github|google/i);
  });
});
