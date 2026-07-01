import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { Router } from "./Router";
import { makeApi } from "./api";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.history.pushState({}, "", "/"); });
const res = (body: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) }) as unknown as Response;
const stars = { signedIn: false, loginUrl: () => "/login", api: { get: async () => ({ counts: {}, mine: [] }), toggle: async () => ({ starred: false, count: 0 }) } as never };

describe("Router", () => {
  it("renders the leaderboard at /", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => res([{ id: "skill:a/b", kind: "skill", producers: 5, verifiedProducers: 2, invocations: 9, sessions: 4 }])));
    window.history.pushState({}, "", "/");
    render(<Router api={makeApi("")} stars={stars} me={null} />);
    expect(await screen.findByText("b")).toBeTruthy();
  });

  it("renders the ingredient page at /ingredient/:id with the decoded id", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.includes("/co-occurrence")) return res([{ id: "skill:c/d", producers: 1, verifiedProducers: 0 }]);
      return res([]);
    }));
    window.history.pushState({}, "", "/ingredient/" + encodeURIComponent("skill:superpowers/brainstorming"));
    render(<Router api={makeApi("")} stars={stars} me={null} />);
    expect(await screen.findByText("brainstorming")).toBeTruthy(); // header from decoded id
  });

  it("renders the gem browse page at /gems", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => res({ gems: [] }))); // empty live list → static fallback
    window.history.pushState({}, "", "/gems");
    render(<Router api={makeApi("")} stars={stars} me={null} />);
    expect(await screen.findByText("brainstorming-kit")).toBeTruthy();
  });

  it("renders the gem detail page at /gems/:key with the decoded key", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => res({ gems: [] }))); // empty live list → static fallback
    window.history.pushState({}, "", "/gems/" + encodeURIComponent("github-flow"));
    render(<Router api={makeApi("")} stars={stars} me={null} />);
    expect(await screen.findByRole("heading", { name: /github-flow/ })).toBeTruthy();
  });
});
