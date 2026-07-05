import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { TeamUsage, membersCsv, fmtCompact, fmtFull, fmtDuration, heatCells } from "./TeamUsage";
import type { OrgUsage, OrgSettingsView } from "../types";
import type { OrgUsageResult, OrgSettingsResult } from "../api";

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
  models: [
    { agent: "claude", model: "claude-fable-5", sessions: 14, tokens: 6_000_000_000 },
    { agent: "codex", model: "gpt-5.2-codex", sessions: 6, tokens: 1_300_000_000 },
  ],
  agents: [
    { agent: "claude", sessions: 14, tokens: 6_000_000_000 },
    { agent: "codex", sessions: 6, tokens: 1_300_000_000 },
  ],
  ...over,
});

const apiWith = (result: OrgUsageResult, settings?: OrgSettingsResult, onPut?: (retentionDays: number | null) => void) => ({
  getOrgUsage: () => Promise.resolve(result),
  getOrgSettings: () => Promise.resolve(settings ?? { status: "denied" }),
  putOrgSettings: (_scope: string, values: { retentionDays: number | null; dashboardEnabled: boolean }) => {
    onPut?.(values.retentionDays);
    return Promise.resolve({ status: "ok", settings: { scope: "acme", ...values, updatedBy: "alice", updatedAt: null, viewerRole: "admin" } satisfies OrgSettingsView });
  },
}) as never;

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
    const api = {
      getOrgUsage: (_scope: string, range: string) => { calls.push(range); return Promise.resolve({ status: "ok", usage: usage() } as OrgUsageResult); },
      getOrgSettings: () => Promise.resolve({ status: "denied" }),
    } as never;
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

describe("TeamUsage stale membership", () => {
  it("offers a one-click membership refresh on a stale 403", async () => {
    render(<TeamUsage api={apiWith({ status: "stale" })} scope="acme" stars={stars} />);
    expect(await screen.findByText(/membership check has expired/)).toBeTruthy();
    const link = screen.getByText("Refresh membership");
    expect((link as HTMLAnchorElement).getAttribute("href")).toBe("https://api.example/login");
  });
});

describe("TeamUsage models + settings", () => {
  it("renders the models breakdown with agent chips", async () => {
    render(<TeamUsage api={apiWith({ status: "ok", usage: usage() })} scope="acme" stars={stars} />);
    expect(await screen.findByText("claude-fable-5")).toBeTruthy();
    expect(screen.getByLabelText("models")).toBeTruthy();
    expect(screen.getByText("6.0B")).toBeTruthy();          // model tokens, compact
    expect(screen.getByText(/14 sessions/)).toBeTruthy();   // agent chip
  });

  it("hides the models section when no model rows were reported", async () => {
    render(<TeamUsage api={apiWith({ status: "ok", usage: usage({ models: [], agents: [] }) })} scope="acme" stars={stars} />);
    await screen.findByText("zheng");
    expect(screen.queryByLabelText("models")).toBeNull();
  });

  it("shows admins an editable retention select and saves changes", async () => {
    const puts: (number | null)[] = [];
    const settings: OrgSettingsResult = { status: "ok", settings: { scope: "acme", retentionDays: null, dashboardEnabled: true, updatedBy: null, updatedAt: null, viewerRole: "admin" } };
    render(<TeamUsage api={apiWith({ status: "ok", usage: usage() }, settings, (d) => puts.push(d))} scope="acme" stars={stars} />);
    const select = await screen.findByLabelText("usage retention");
    fireEvent.change(select, { target: { value: "90" } });
    await waitFor(() => expect(puts).toEqual([90]));
    expect(await screen.findByText(/set by alice/)).toBeTruthy();
  });

  it("shows members the retention policy read-only, and nothing when settings are denied", async () => {
    const settings: OrgSettingsResult = { status: "ok", settings: { scope: "acme", retentionDays: 30, dashboardEnabled: true, updatedBy: "root", updatedAt: null, viewerRole: "member" } };
    const { unmount } = render(<TeamUsage api={apiWith({ status: "ok", usage: usage() }, settings)} scope="acme" stars={stars} />);
    expect(await screen.findByText("30 days")).toBeTruthy();
    expect(screen.queryByLabelText("usage retention")).toBeNull(); // no select for members
    unmount();
    render(<TeamUsage api={apiWith({ status: "ok", usage: usage() })} scope="acme" stars={stars} />);
    await screen.findByText("zheng");
    expect(screen.queryByLabelText("org settings")).toBeNull();
  });
});

describe("TeamUsage v3: drill-down, CSV, visibility", () => {
  it("membersCsv renders spreadsheet-ready rows with escaping", () => {
    const csv = membersCsv(usage({ members: [member('zheng"the,best', 100, { activeMs: 3_600_000, lastActive: "2026-07-04" })] }));
    const lines = csv.trim().split("\n");
    expect(lines[0]).toBe("rank,login,sessions,messages,active_hours,active_days,tokens_in,tokens_out,tokens_cache,tokens_total,last_active");
    expect(lines[1]).toBe('1,"zheng""the,best",10,40,1.00,3,100,0,0,100,2026-07-04');
  });

  it("leaderboard rows link to the org drill-down, and the member view narrows + offers a way back", async () => {
    const calls: (string | undefined)[] = [];
    const api = {
      getOrgUsage: (_s: string, _r: string, member?: string) => { calls.push(member); return Promise.resolve({ status: "ok", usage: usage() } as OrgUsageResult); },
      getOrgSettings: () => Promise.resolve({ status: "denied" }),
    } as never;
    const { unmount } = render(<TeamUsage api={api} scope="acme" stars={stars} />);
    await screen.findByText("zheng");
    const drill = screen.getAllByText("usage →")[0] as HTMLAnchorElement;
    expect(drill.getAttribute("href")).toBe("/orgs/acme/usage?member=zheng");
    expect(calls).toEqual([undefined]);
    unmount();

    window.history.pushState({}, "", "/orgs/acme/usage?member=zheng");
    try {
      render(<TeamUsage api={api} scope="acme" stars={stars} />);
      await screen.findByText(/· @zheng/);
      expect(calls).toEqual([undefined, "zheng"]);
      expect(screen.getByText("← Full team")).toBeTruthy();
      expect(screen.queryByText("usage →")).toBeNull();          // no drill links inside the drill-down
      expect(screen.queryByLabelText("org settings")).toBeNull(); // settings only on the team view
    } finally {
      window.history.pushState({}, "", "/orgs/acme/usage");
    }
  });

  it("shows the disabled gate (with settings still reachable for the admin flip-back)", async () => {
    const settings: OrgSettingsResult = { status: "ok", settings: { scope: "acme", retentionDays: null, dashboardEnabled: false, updatedBy: "root", updatedAt: null, viewerRole: "admin" } };
    render(<TeamUsage api={apiWith({ status: "disabled" }, settings)} scope="acme" stars={stars} />);
    expect(await screen.findByText(/disabled by an org admin/)).toBeTruthy();
    const toggle = await screen.findByLabelText("dashboard visible to members") as HTMLInputElement;
    expect(toggle.checked).toBe(false);
  });

  it("admins can flip visibility; the toggle PUTs both fields", async () => {
    const bodies: unknown[] = [];
    const settings: OrgSettingsResult = { status: "ok", settings: { scope: "acme", retentionDays: 90, dashboardEnabled: true, updatedBy: null, updatedAt: null, viewerRole: "admin" } };
    const api = {
      getOrgUsage: () => Promise.resolve({ status: "ok", usage: usage() } as OrgUsageResult),
      getOrgSettings: () => Promise.resolve(settings),
      putOrgSettings: (_s: string, values: unknown) => { bodies.push(values); return Promise.resolve(settings); },
    } as never;
    render(<TeamUsage api={api} scope="acme" stars={stars} />);
    const toggle = await screen.findByLabelText("dashboard visible to members");
    fireEvent.click(toggle);
    await waitFor(() => expect(bodies).toEqual([{ retentionDays: 90, dashboardEnabled: false }]));
  });
});
