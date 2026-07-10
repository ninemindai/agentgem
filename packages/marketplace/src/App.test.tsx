import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { App } from "./App";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.history.pushState({}, "", "/");
});

const res = (body: unknown) =>
  ({ ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body }) as unknown as Response;

const popularityRow = [
  { id: "skill:superpowers/brainstorming", kind: "skill", producers: 80, verifiedProducers: 40, invocations: 200, sessions: 90 },
];

function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.includes("/co-occurrence")) return res([]);
      if (url.includes("/adoption")) return res([]);
      if (url.includes("/popular-skills")) return res({ skills: [], groups: [] });
      return res(popularityRow);
    }),
  );
}

describe("App link interceptor", () => {
  it("intercepts an internal link and does pushState without a full reload", async () => {
    stubFetch();
    window.history.pushState({}, "", "/ingredients"); // the leaderboard moved off "/" (Miniapps is home)
    render(<App />);

    // Wait for the leaderboard row link to appear
    const link = (await screen.findByText("brainstorming")).closest("a")!;
    expect(link).toBeTruthy();
    const expectedPath = "/ingredient/" + encodeURIComponent("skill:superpowers/brainstorming");
    expect(link.getAttribute("href")).toBe(expectedPath);

    fireEvent.click(link);

    // pushState happened — pathname changed
    expect(window.location.pathname).toBe(expectedPath);
    // The document wasn't torn down — the app root is still present
    expect(document.querySelector(".ex-app")).toBeTruthy();
  });

  it("leaves external links alone (does not change pathname)", async () => {
    stubFetch();
    window.history.pushState({}, "", "/ingredients"); // the leaderboard moved off "/" (Miniapps is home)
    render(<App />);

    // Wait for the app to render (footer is always present)
    await screen.findByText("brainstorming");

    const externalLink = document.querySelector('a[href="https://agentgem.ai"]')!;
    expect(externalLink).toBeTruthy();

    fireEvent.click(externalLink);

    // Interceptor must NOT have called pushState — pathname unchanged
    expect(window.location.pathname).toBe("/ingredients");
  });

  it("renders Miniapps + Ingredients + Gems nav links, marking the active surface on /gems", () => {
    vi.stubGlobal("fetch", vi.fn(async () => res([])));
    window.history.pushState({}, "", "/gems");
    render(<App />);
    const gemsLink = screen.getByRole("link", { name: "Gems" });
    const ingLink = screen.getByRole("link", { name: "Ingredients" });
    expect(gemsLink.getAttribute("href")).toBe("/gems");
    expect(ingLink.getAttribute("href")).toBe("/ingredients");
    expect(gemsLink.className).toMatch(/is-active/);
    expect(ingLink.className).not.toMatch(/is-active/);
  });

  it("puts Miniapps first in the nav and marks it active on the home path", () => {
    vi.stubGlobal("fetch", vi.fn(async () => res({ gems: [] })));
    window.history.pushState({}, "", "/");
    render(<App />);
    const links = screen.getAllByRole("link").filter((a) => a.className.includes("ex-navlink"));
    expect(links[0].textContent).toBe("Miniapps");
    expect(links[0].getAttribute("href")).toBe("/miniapps");
    expect(links[0].className).toMatch(/is-active/);
  });

  it("keeps Miniapps active on the old /minigames path", () => {
    vi.stubGlobal("fetch", vi.fn(async () => res({ gems: [] })));
    window.history.pushState({}, "", "/minigames");
    render(<App />);
    expect(screen.getByRole("link", { name: "Miniapps" }).className).toMatch(/is-active/);
  });

  it("shows a Sign in link when unauthenticated, which POSTs sign-in/social with the GitHub provider", async () => {
    let signInBody: string | undefined;
    vi.stubGlobal("fetch", vi.fn(async (u: string, o?: RequestInit) => {
      if (u.includes("/api/auth/get-session")) return res(null);
      if (u.includes("/api/auth/sign-in/social")) { signInBody = o?.body as string; return res({ url: "https://github.com/login/oauth/authorize?state=abc", redirect: true }); }
      if (u.includes("/popular-skills")) return res({ skills: [], groups: [] });
      return res([]); // leaderboard / other reads
    }));
    render(<App />);
    const link = await screen.findByRole("link", { name: /sign in with github/i });
    fireEvent.click(link);
    await waitFor(() => expect(signInBody && JSON.parse(signInBody)).toMatchObject({ provider: "github" }));
  });

  it("shows a Sign in with Google link that POSTs sign-in/social with the google provider", async () => {
    let signInBody: string | undefined;
    vi.stubGlobal("fetch", vi.fn(async (u: string, o?: RequestInit) => {
      if (u.includes("/api/auth/get-session")) return res(null);
      if (u.includes("/api/auth/sign-in/social")) { signInBody = o?.body as string; return res({ url: "https://accounts.google.com/o?state=abc", redirect: true }); }
      if (u.includes("/popular-skills")) return res({ skills: [], groups: [] });
      return res([]);
    }));
    render(<App />);
    const link = await screen.findByRole("link", { name: /sign in with google/i });
    fireEvent.click(link);
    await waitFor(() => expect(signInBody && JSON.parse(signInBody)).toMatchObject({ provider: "google" }));
  });

  it("shows the login + Sign out when authenticated", async () => {
    vi.stubGlobal("fetch", vi.fn(async (u: string) => {
      if (u.includes("/api/auth/get-session")) return res({ session: { token: "t" }, user: { id: "u0", login: "octocat", handle: "octocat", image: null } });
      if (u.includes("/popular-skills")) return res({ skills: [], groups: [] });
      return res([]);
    }));
    render(<App />);
    expect(await screen.findByText("octocat")).toBeTruthy();
    expect(screen.getByRole("button", { name: /sign out/i })).toBeTruthy();
    // The identity links to the user's own profile page.
    expect(screen.getByRole("link", { name: "octocat" }).getAttribute("href")).toBe("/@octocat");
  });

  it("chip: a handle-less (Google) user shows their name and NO profile link", async () => {
    vi.stubGlobal("fetch", vi.fn(async (u: string) => {
      if (u.includes("/api/auth/get-session")) return res({ user: { id: "u1", name: "Ray Feng", handle: null, image: null }, orgs: [] });
      if (u.includes("/popular-skills")) return res({ skills: [], groups: [] });
      return res([]);
    }));
    render(<App />);
    expect(await screen.findByText("Ray Feng")).toBeTruthy();
    // no /@ profile link anywhere in the header
    expect(screen.queryByRole("link", { name: "Ray Feng" })).toBeNull();
    expect(screen.getByRole("button", { name: /sign out/i })).toBeTruthy();
  });

  it("chip: a handled user's name links to their /@handle profile", async () => {
    vi.stubGlobal("fetch", vi.fn(async (u: string) => {
      if (u.includes("/api/auth/get-session")) return res({ user: { id: "u2", name: "octocat", handle: "octocat", image: null }, orgs: [] });
      if (u.includes("/popular-skills")) return res({ skills: [], groups: [] });
      return res([]);
    }));
    render(<App />);
    const link = await screen.findByRole("link", { name: "octocat" });
    expect(link.getAttribute("href")).toBe("/@octocat");
  });
});

describe("game route", () => {
  it("routes /games/@scope/name to the Play page", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.includes("/game-meta")) return res({ title: "Tetris", genre: "project-fun", version: "2.0.0" });
      if (url.includes("/game-html")) return res({ html: "<!doctype html><title>t</title>" });
      return res([]);
    }));
    window.history.pushState({}, "", "/games/@acme/tetris");

    render(<App />);

    // Play renders "Loading <title>…" once game-meta lands, then swaps in the sealed iframe.
    expect(await screen.findByText(/Loading/i)).toBeTruthy();
    await waitFor(() => expect(document.querySelector("iframe[sandbox]")).not.toBeNull());
  });
});
