import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { TeamUsage, fmtCompact, fmtFull, fmtDuration, heatCells } from "./TeamUsage";
import type { OrgUsage } from "../types";
import type { OrgUsageResult } from "../api";

afterEach(() => cleanup());

const stars = { signedIn: false, loginUrl: () => "https://api.example/login", api: {} as never };

const member = (login: string, tokens: number, over: Partial<OrgUsage["members"][number]> = {}) => ({
  login, avatarUrl: null, sessions: 10, msgs: 40,
  tokensIn: tokens, tokensOut: 0, tokensCache: 0, tokens,
  activeMs: 35_000_000, activeDays: 3, lastActive: "2026-07-04", ...over,
});

const usage = (over: Partial<OrgUsage> = {}): OrgUsage => ({
  scope: "acme", range: "7d", memberCount: 2,
  totals: { sessions: 20, msgs: 80, tokensIn: 1_500_000_000, tokensOut: 17_300_000, tokensCache: 5_800_000_000, tokens: 7_317_300_000, activeMs: 100_000_000, activeDays: 5 },
  members: [member("zheng", 7_000_000_000), member("changli", 317_300_000)],
  daily: [
    { date: "2026-06-29", sessions: 4, tokens: 100 },
    { date: "2026-07-04", sessions: 16, tokens: 400 },
  ],
  ...over,
});

const apiWith = (result: OrgUsageResult) => ({ getOrgUsage: () => Promise.resolve(result) }) as never;

describe("TeamUsage helpers", () => {
  it("formats tokens compactly and in full", () => {
    expect(fmtCompact(7_317_300_000)).toBe("7.3B");
    expect(fmtCompact(17_300_000)).toBe("17M");
    expect(fmtCompact(1_600_000)).toBe("1.6M");
    expect(fmtCompact(950)).toBe("950");
    expect(fmtFull(7_657_219_219)).toBe("7,657,219,219");
  });
  it("formats durations as h/m", () => {
    expect(fmtDuration(35_008_000)).toBe("9h 43m");
    expect(fmtDuration(46.5 * 60_000)).toBe("47m");
  });
  it("lays heat cells on a Sun-anchored week grid with levels vs the busiest day", () => {
    const cells = heatCells([
      { date: "2026-06-29", sessions: 1, tokens: 100 }, // Monday
      { date: "2026-07-05", sessions: 1, tokens: 400 }, // next Sunday → next column
    ]);
    expect(cells[0]).toMatchObject({ weekday: 1, week: 0, level: 2 }); // 100/400 = 25% → lvl 2
    expect(cells[1]).toMatchObject({ weekday: 0, week: 1, level: 4 });
    expect(heatCells([])).toEqual([]);
  });
});

describe("TeamUsage page", () => {
  it("renders the leaderboard, stat cards, and heatmap", async () => {
    render(<TeamUsage api={apiWith({ status: "ok", usage: usage() })} scope="acme" stars={stars} />);
    expect(await screen.findByText("zheng")).toBeTruthy();
    expect(screen.getByText("7,000,000,000")).toBeTruthy(); // leaderboard tokens in full
    expect(screen.getByText("7.3B")).toBeTruthy();          // total tokens card
    expect(screen.getByText("5.8B")).toBeTruthy();          // cached tokens card
    expect(screen.getByText("🏆")).toBeTruthy();            // rank 1 medal
    expect(screen.getByText(/20 sessions/)).toBeTruthy();
    expect(screen.getByLabelText("activity heatmap")).toBeTruthy();
    // member links to the public profile
    expect((screen.getByText("zheng") as HTMLAnchorElement).getAttribute("href")).toBe("/@zheng");
  });

  it("prompts sign-in when unauthenticated", async () => {
    render(<TeamUsage api={apiWith({ status: "unauthenticated" })} scope="acme" stars={stars} />);
    const link = await screen.findByText("Sign in with GitHub");
    expect((link as HTMLAnchorElement).getAttribute("href")).toBe("https://api.example/login");
  });

  it("explains a 403 for non-members", async () => {
    render(<TeamUsage api={apiWith({ status: "forbidden" })} scope="acme" stars={stars} />);
    expect(await screen.findByText(/not a member/)).toBeTruthy();
  });

  it("shows onboarding when no usage was reported", async () => {
    render(<TeamUsage api={apiWith({ status: "ok", usage: usage({ members: [], memberCount: 0, daily: [] }) })} scope="acme" stars={stars} />);
    expect(await screen.findByText(/No usage reported/)).toBeTruthy();
    expect(screen.getByText("agentgem bind")).toBeTruthy();
  });

  it("refetches when the range tab changes", async () => {
    const calls: string[] = [];
    const api = { getOrgUsage: (_scope: string, range: string) => { calls.push(range); return Promise.resolve({ status: "ok", usage: usage() } as OrgUsageResult); } } as never;
    render(<TeamUsage api={api} scope="acme" stars={stars} />);
    await screen.findByText("zheng");
    fireEvent.click(screen.getByRole("tab", { name: "All Time" }));
    await screen.findByText("zheng");
    expect(calls).toEqual(["7d", "all"]);
  });

  it("surfaces a load error", async () => {
    const api = { getOrgUsage: () => Promise.reject(new Error("boom")) } as never;
    render(<TeamUsage api={api} scope="acme" stars={stars} />);
    expect(await screen.findByText(/Couldn't load team usage/)).toBeTruthy();
  });
});
