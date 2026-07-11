import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { Account } from "./Account";
import { makeApi } from "../api";
import type { Me } from "../auth";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.pushState({}, "", "/account");
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
    vi.stubGlobal("location", { ...window.location, assign, href: "https://app.x/account", search: "" } as unknown as Location);

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

  it("surfaces a plain message when link-social's OAuth round trip collides with another account", async () => {
    vi.stubGlobal("fetch", vi.fn(async (u: string) => {
      if (u.includes("/api/account/providers")) return res({ connected: ["github"] });
      throw new Error("unexpected fetch: " + u);
    }));
    window.history.pushState({}, "", "/account?error=account_already_linked_to_different_user");

    render(<Account api={makeApi("https://api.x")} me={me} base="https://api.x" />);

    expect(await screen.findByText(/already linked to another AgentGem account/i)).toBeTruthy();
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
});
