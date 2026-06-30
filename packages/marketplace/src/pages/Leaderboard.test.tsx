import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { Leaderboard } from "./Leaderboard";
import { makeApi } from "../api";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const res = (body: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) }) as unknown as Response;
const rows = [
  { id: "skill:superpowers/brainstorming", kind: "skill", producers: 80, verifiedProducers: 40, invocations: 200, sessions: 90 },
  { id: "npx:@mcp/github", kind: "mcp", producers: 30, verifiedProducers: 9, invocations: 50, sessions: 25 },
];
const stars = { signedIn: false, loginUrl: () => "/login", api: { get: async () => ({ counts: {}, mine: [] }), toggle: async () => ({ starred: false, count: 0 }) } as never };

describe("Leaderboard", () => {
  it("renders ranked rows from the API with producer + verified counts", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => res(rows)));
    render(<Leaderboard api={makeApi("")} stars={stars} />);
    expect(await screen.findByText("brainstorming")).toBeTruthy();
    expect(screen.getByText("@mcp/github")).toBeTruthy();
    expect(screen.getByText(/40 verified/i)).toBeTruthy();
  });

  it("filters via the search box (ranks preserved)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => res(rows)));
    render(<Leaderboard api={makeApi("")} stars={stars} />);
    await screen.findByText("brainstorming");
    fireEvent.change(screen.getByLabelText("search ingredients"), { target: { value: "github" } });
    expect(screen.queryByText("brainstorming")).toBeNull();
    expect(screen.getByText("@mcp/github")).toBeTruthy();
    expect(screen.getByText("2")).toBeTruthy(); // original rank
  });

  it("shows the k-anon empty state when the API returns nothing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => res([])));
    render(<Leaderboard api={makeApi("")} stars={stars} />);
    await waitFor(() => expect(screen.getByText(/no ingredients above the k-anonymity floor/i)).toBeTruthy());
  });

  it("links a row to its ingredient page (encoded id)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => res(rows)));
    render(<Leaderboard api={makeApi("")} stars={stars} />);
    const link = (await screen.findByText("brainstorming")).closest("a");
    expect(link?.getAttribute("href")).toBe("/ingredient/" + encodeURIComponent("skill:superpowers/brainstorming"));
  });

  it("renders a StarButton per row after load", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => res(rows)));
    render(<Leaderboard api={makeApi("")} stars={stars} />);
    await screen.findByText("brainstorming");
    expect((await screen.findAllByRole("button", { name: /star/i })).length).toBeGreaterThan(0);
  });
});
