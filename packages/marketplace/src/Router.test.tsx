import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { Router } from "./Router";
import { makeApi } from "./api";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.history.pushState({}, "", "/"); });
const res = (body: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) }) as unknown as Response;
const stars = { signedIn: false, loginUrl: () => "/login", api: { get: async () => ({ counts: {}, mine: [] }), toggle: async () => ({ starred: false, count: 0 }) } as never };
const reviews = { signedIn: false, loginUrl: () => "/login", api: { getSummaries: async () => ({}), get: async () => ({ summary: { avg: 0, count: 0 }, reviews: [], mine: null }), submit: async () => ({}), remove: async () => ({}) } as never };

describe("Router", () => {
  // Miniapps is the home tab: / lands on the arcade, and Ingredients moved to its own path.
  it("renders Miniapps at / — the home tab", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => res({ gems: [] })));
    window.history.pushState({}, "", "/");
    render(<Router api={makeApi("")} stars={stars} reviews={reviews} me={null} />);
    expect(await screen.findByRole("heading", { name: "Miniapps" })).toBeTruthy();
  });

  it("renders Miniapps at /miniapps", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => res({ gems: [] })));
    window.history.pushState({}, "", "/miniapps");
    render(<Router api={makeApi("")} stars={stars} reviews={reviews} me={null} />);
    expect(await screen.findByRole("heading", { name: "Miniapps" })).toBeTruthy();
  });

  // Old shared links and the desktop deep-link still point at /minigames — never 404 them.
  it("still serves the old /minigames path", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => res({ gems: [] })));
    window.history.pushState({}, "", "/minigames");
    render(<Router api={makeApi("")} stars={stars} reviews={reviews} me={null} />);
    expect(await screen.findByRole("heading", { name: "Miniapps" })).toBeTruthy();
  });

  it("renders the leaderboard at /ingredients", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (String(url).includes("/popular-skills")) return res({ skills: [], groups: [] });
      return res([{ id: "skill:a/b", kind: "skill", producers: 5, verifiedProducers: 2, invocations: 9, sessions: 4 }]);
    }));
    window.history.pushState({}, "", "/ingredients");
    render(<Router api={makeApi("")} stars={stars} reviews={reviews} me={null} />);
    expect(await screen.findByText("b")).toBeTruthy();
  });

  it("renders the ingredient page at /ingredient/:id with the decoded id", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.includes("/co-occurrence")) return res([{ id: "skill:c/d", producers: 1, verifiedProducers: 0 }]);
      return res([]);
    }));
    window.history.pushState({}, "", "/ingredient/" + encodeURIComponent("skill:superpowers/brainstorming"));
    render(<Router api={makeApi("")} stars={stars} reviews={reviews} me={null} />);
    expect(await screen.findByText("brainstorming")).toBeTruthy(); // header from decoded id
  });

  it("renders the gem browse page at /gems", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => res({ gems: [] }))); // empty live list → static fallback
    window.history.pushState({}, "", "/gems");
    render(<Router api={makeApi("")} stars={stars} reviews={reviews} me={null} />);
    expect(await screen.findByText("brainstorming-kit")).toBeTruthy();
  });

  it("renders the gem detail page at /gems/:key with the decoded key", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => res({ gems: [] }))); // empty live list → static fallback
    window.history.pushState({}, "", "/gems/" + encodeURIComponent("github-flow"));
    render(<Router api={makeApi("")} stars={stars} reviews={reviews} me={null} />);
    expect(await screen.findByRole("heading", { name: /github-flow/ })).toBeTruthy();
  });

  it("renders the profile page at /@login", async () => {
    const profile = { login: "octocat", avatarUrl: null, verified: false, githubUrl: "https://github.com/octocat", totalStars: 0, gems: [], reviews: [] };
    vi.stubGlobal("fetch", vi.fn(async () => res(profile)));
    window.history.pushState({}, "", "/@octocat");
    render(<Router api={makeApi("")} stars={stars} reviews={reviews} me={null} />);
    expect(await screen.findByRole("heading", { name: /octocat/ })).toBeTruthy();
  });

  it("routes /orgs/:scope to the OrgCatalog page", async () => {
    window.history.pushState({}, "", "/orgs/acme");
    const api = { getOrgCatalog: () => Promise.resolve({ scope: "acme", gemCount: 0, ownerCount: 0, gems: [] }), getOrgApp: async () => null, getOrgSkills: async () => null } as never;
    render(<Router api={api} stars={{ signedIn: false, loginUrl: () => "", api: {} as never }} reviews={{ signedIn: false, loginUrl: () => "", api: {} as never }} me={null} />);
    expect(await screen.findByText(/no gems published under @acme yet/i)).toBeTruthy();
  });
});
