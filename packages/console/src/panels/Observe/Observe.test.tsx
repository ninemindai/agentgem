import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, within } from "@testing-library/react";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.location.hash = ""; });
import { Dashboard } from "./Dashboard.js";
import { Observe } from "./index.js";
import { ObservePayloadSchema, type ObservePayload } from "../../api/routes.js";

const res = (body: unknown) =>
  ({ ok: true, status: 200, text: async () => JSON.stringify(body) }) as unknown as Response;

const sse = (items: unknown[]) =>
  ({
    ok: true, status: 200,
    headers: new Headers({ "content-type": "text/event-stream" }),
    text: async () => items.map((i) => `data: ${JSON.stringify(i)}\n\n`).join(""),
  }) as unknown as Response;

// Home/reveal (this Observe panel's 3-mode switch) stubs the same three
// endpoints every real load hits: home/state (mode selection), scorecard/stream
// (SSE — used by both Reveal and the returning-mode masthead scoreboard), and
// observe/raw (the Overview dashboard beneath). Each test below only cares
// about one or two of them, so the default is the cheapest legal response.
function stubHomeFetch(opts: {
  home?: unknown; scorecard?: unknown[]; observeRaw?: unknown;
} = {}) {
  const homeCalls: string[] = [];
  const fetchMock = vi.fn(async (url: string | URL) => {
    const u = String(url);
    if (u.includes("/api/home/state")) { homeCalls.push(u); return res(opts.home ?? {}); }
    if (u.includes("/api/scorecard/stream")) return sse(opts.scorecard ?? [{ type: "failed", message: "n/a" }]);
    if (u.includes("/api/observe/raw")) return res(opts.observeRaw ?? { sessions: [] });
    if (u.includes("/api/home/summary")) return res(opts.home ?? {});
    return res({});
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, homeCalls };
}

const payload: ObservePayload = {
  pulse: { sessions: 2, msgs: 12, tokens: 1_200_000, activeMs: 2.1 * 3_600_000 },
  daily: [{ date: "2026-06-28", sessions: 2, msgs: 12, tokensIn: 800_000, tokensOut: 300_000, tokensCache: 100_000 }],
  sessions: [{
    agent: "claude", sessionId: "s1", project: "agentgem", model: "claude-opus-4-8",
    startMs: 1_750_000_000_000, endMs: 1_750_010_000_000, durationMs: 10_000_000,
    msgs: 8, tokens: 900_000,
    tokensIn: 700_000, tokensOut: 150_000, tokensCache: 50_000, gitBranch: "main",
  }],
  models: [{ model: "claude-opus-4-8", agent: "claude", sessions: 2, tokens: 1_200_000 }],
  byTool: [{ name: "Read", count: 12 }, { name: "Bash", count: 5 }],
  bySubagent: [{ name: "Explore", count: 2 }],
  bySkill: [],
  usageDaily: [{ date: "2026-06-28", tools: { Read: 8, Bash: 4 }, skills: {}, subagents: { Explore: 2 } }],
  byProject: [
    { project: "agentgem", sessions: 2, tokens: 900_000, tokensIn: 700_000, tokensOut: 150_000, tokensCache: 50_000 },
    { project: null, sessions: 1, tokens: 100_000, tokensIn: 80_000, tokensOut: 10_000, tokensCache: 10_000 },
  ],
  topSessions: [
    { agent: "claude", sessionId: "a3f9c2d1e5b70000", project: "agentgem", model: "claude-opus-4-8",
      tokens: 900_000, tokensIn: 700_000, tokensOut: 150_000, tokensCache: 50_000, endMs: Date.now() - 2 * 3_600_000 },
  ],
  facets: { agents: ["claude"], projects: ["agentgem"], models: ["claude-opus-4-8"] },
  range: "7d",
};

// Inspect is the aggregate usage dashboard (pulse + charts + heatmap). The per-session
// ledger table now lives in the Sessions screen — see SessionsTable.test.tsx.
describe("Observe Dashboard", () => {
  it("renders the pulse and the facet controls", () => {
    render(<Dashboard data={payload} range="7d" onRange={() => {}} filter={{}} onFilter={() => {}} apiBase="" />);
    expect(screen.getByText("1.2M")).toBeDefined();                    // pulse tokens
    expect(screen.getAllByText("agentgem").length).toBeGreaterThan(0); // project facet option
  });

  it("renders filter controls with facet values", () => {
    render(<Dashboard data={payload} range="7d" onRange={() => {}} filter={{}} onFilter={() => {}} apiBase="" />);
    expect(screen.getByLabelText(/agent/i)).toBeDefined();
    expect(screen.getByLabelText(/model/i)).toBeDefined();
    expect(screen.getAllByText("claude-opus-4-8").length).toBeGreaterThan(0);
  });

  it("renders the usage-by-artifact breakdown, omitting empty categories", () => {
    render(<Dashboard data={payload} range="7d" onRange={() => {}} filter={{}} onFilter={() => {}} apiBase="" />);
    expect(screen.getByText("By tool")).toBeDefined();
    expect(screen.getByText("Read")).toBeDefined();
    expect(screen.getByText("By subagent")).toBeDefined();
    expect(screen.getByText("Explore")).toBeDefined();
    expect(screen.queryByText("By skill")).toBeNull(); // bySkill empty → card omitted
  });

  it("deep-links a linkable artifact straight to its Setup viewer", () => {
    render(<Dashboard data={payload} range="7d" onRange={() => {}} filter={{}} onFilter={() => {}} apiBase="" />);
    fireEvent.click(screen.getByRole("button", { name: "Explore" }));
    expect(window.location.hash).toBe("#/setup/subagents?a=Explore");
  });

  it("renders the usage-over-time series with a Tools/Skills/Subagents toggle", () => {
    render(<Dashboard data={payload} range="7d" onRange={() => {}} filter={{}} onFilter={() => {}} apiBase="" />);
    expect(screen.getByText("Usage over time")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Tools" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Skills" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Subagents" })).toBeTruthy();
  });

  it("renders at least one heatmap cell", () => {
    const { container } = render(<Dashboard data={payload} range="7d" onRange={() => {}} filter={{}} onFilter={() => {}} apiBase="" />);
    expect(container.querySelector(".obs-heat-cell")).not.toBeNull();
  });

  it("shows 'Updating…' pill when pending=true, hides it when pending=false", () => {
    const { rerender } = render(<Dashboard data={payload} range="7d" onRange={() => {}} filter={{}} onFilter={() => {}} apiBase="" pending={true} />);
    expect(screen.getByText("Updating…")).toBeDefined();
    rerender(<Dashboard data={payload} range="7d" onRange={() => {}} filter={{}} onFilter={() => {}} apiBase="" pending={false} />);
    expect(screen.queryByText("Updating…")).toBeNull();
  });

  it("renders weekday Y-axis label Mon", () => {
    render(<Dashboard data={payload} range="7d" onRange={() => {}} filter={{}} onFilter={() => {}} apiBase="" />);
    expect(screen.getAllByText("Mon").length).toBeGreaterThan(0);
  });

  it("renders heatmap legend with Less and More", () => {
    render(<Dashboard data={payload} range="7d" onRange={() => {}} filter={{}} onFilter={() => {}} apiBase="" />);
    expect(screen.getByText("Less")).toBeDefined();
    expect(screen.getByText("More")).toBeDefined();
  });

  it("min-msgs filter input shows value 100 when filter.minMsgs is 100", () => {
    render(<Dashboard data={payload} range="7d" onRange={() => {}} filter={{ minMsgs: 100 }} onFilter={() => {}} apiBase="" />);
    const input = screen.getByLabelText(/minimum messages/i) as HTMLInputElement;
    expect(input.value).toBe("100");
  });

  it("renders the Share-link and Publish buttons when a setup share is offered", () => {
    const resolveSetupShare = async () => ({ name: "my-setup", provenance: "3 skills" });
    render(
      <Dashboard data={payload} range="7d" onRange={() => {}} filter={{}} onFilter={() => {}}
        apiBase="" resolveSetupShare={resolveSetupShare} onPublishSetup={() => {}} />,
    );
    expect(screen.getByRole("button", { name: /share link/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Publish ↗" })).toBeTruthy();
  });

  it("omits the share row when no setup share is offered", () => {
    render(<Dashboard data={payload} range="7d" onRange={() => {}} filter={{}} onFilter={() => {}} apiBase="" />);
    expect(screen.queryByRole("button", { name: /share link/i })).toBeNull();
  });
});

// The home/reveal 3-mode switch: loading → (first-run consent | ceremony | returning).
// See Reveal.test.tsx for the fetched-state machine's own branches (cold/Codex-heavy/
// rich/hard-failure) — these tests only cover mode SELECTION at the Observe level.
describe("Observe — mode selection", () => {
  it("renders the masthead skeleton only while home state is loading (before the fetch resolves)", () => {
    window.location.hash = "#/overview";
    // A fetch that never resolves keeps useHomeState in its `loading` state.
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    render(<Observe apiBase="" />);
    expect(screen.getByLabelText("Loading your session reveal")).toBeTruthy();
    expect(screen.queryByText(/Scan my sessions/)).toBeNull();
    expect(screen.queryByText(/goldmine/i)).toBeNull();
  });

  it("first-run visitor (existingUser=false, revealSeen=false): the consent gate, zero summary/scorecard/observe fetches", async () => {
    window.location.hash = "#/overview";
    const { fetchMock } = stubHomeFetch({ home: { existingUser: false, revealSeen: false, unlocked: false } });
    render(<Observe apiBase="" />);
    expect(await screen.findByRole("button", { name: "Scan my sessions" })).toBeTruthy();
    const calledUrls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(calledUrls.some((u) => u.includes("/api/home/state"))).toBe(true);
    expect(calledUrls.some((u) => u.includes("/api/home/summary"))).toBe(false);
    expect(calledUrls.some((u) => u.includes("/api/scorecard/stream"))).toBe(false);
    expect(calledUrls.some((u) => u.includes("/api/observe/raw"))).toBe(false);
  });

  it("existing user (existingUser=true, revealSeen=false): the ceremony, fetching immediately with no consent gate", async () => {
    window.location.hash = "#/overview";
    stubHomeFetch({ home: { existingUser: true, revealSeen: false, unlocked: true } });
    render(<Observe apiBase="" />);
    expect(screen.queryByText(/Scan my sessions/)).toBeNull();
    expect(await screen.findByRole("button", { name: "Take me to my console" })).toBeTruthy();
  });

  it("returning user (revealSeen=true): the condensed masthead scoreboard + the Overview dashboard beneath, with the pre-existing empty-log signpost preserved", async () => {
    window.location.hash = "#/overview";
    stubHomeFetch({
      home: { existingUser: true, revealSeen: true, unlocked: true },
      observeRaw: { sessions: [] },
    });
    render(<Observe apiBase="" />);
    expect(await screen.findByText(/nothing to inspect yet/i)).toBeTruthy();
  });
});

describe("Where tokens went", () => {
  const dash = (over?: Partial<Parameters<typeof Dashboard>[0]>) =>
    render(<Dashboard data={payload} range="7d" onRange={() => {}} filter={{}} onFilter={() => {}} apiBase="" {...over} />);

  it("renders the section with both cards, shares, and session metadata", () => {
    dash();
    expect(screen.getByText("Where tokens went")).toBeDefined();
    expect(screen.getByText("Tokens by project")).toBeDefined();
    expect(screen.getByText("Top sessions")).toBeDefined();
    expect(screen.getByText("900k · 90%")).toBeDefined();          // fmtTokens + share of Σ byProject
    expect(screen.getByText(/a3f9c2d1 …|a3f9c2d1…/)).toBeDefined() // two-line meta: id prefix…
    expect(screen.getByText(/2h ago/)).toBeDefined();              // …and timeAgo(endMs)
  });

  it("renders Unassigned as a plain span (not a button), with the not-filterable tooltip", () => {
    dash();
    const el = screen.getByText("Unassigned");
    expect(el.tagName).toBe("SPAN");
    expect(el.getAttribute("title")).toBe("sessions with no project metadata — not filterable");
  });

  it("project row click applies the filter; clicking the ACTIVE row clears it", () => {
    // "agentgem" also names the Top sessions row button — scope to the project card.
    const projectBtn = () => within(screen.getByText("Tokens by project").closest(".obs-card") as HTMLElement)
      .getByRole("button", { name: "agentgem" });
    const onFilter = vi.fn();
    dash({ onFilter });
    fireEvent.click(projectBtn());
    expect(onFilter).toHaveBeenCalledWith({ project: "agentgem" });
    cleanup();
    dash({ filter: { project: "agentgem" }, onFilter });
    fireEvent.click(projectBtn());
    expect(onFilter).toHaveBeenLastCalledWith({ project: undefined });
  });

  it("active row is marked aria-current and the ✕ chip clears the filter", () => {
    const onFilter = vi.fn();
    const { container } = dash({ filter: { project: "agentgem" }, onFilter });
    const active = container.querySelector('[aria-current="true"]');
    expect(active?.textContent).toContain("agentgem");
    fireEvent.click(screen.getByRole("button", { name: "Clear project filter" }));
    expect(onFilter).toHaveBeenCalledWith({ project: undefined });
  });

  it("session row deep-links to Sessions detail with encoded segments", () => {
    dash();
    // Accessible name is just the project text ("agentgem"), which also appears as a button
    // in the Tokens by project card — scope to the Top sessions card and match by prefix.
    const card = screen.getByText("Top sessions").closest(".obs-card") as HTMLElement;
    const btn = within(card).getAllByRole("button").find((b) => b.textContent?.startsWith("agentgem"))!;
    fireEvent.click(btn);
    expect(window.location.hash).toBe("#/sessions/claude/a3f9c2d1e5b70000");
  });

  it("keeps Top sessions mounted with an empty line while a filter is active", () => {
    dash({ data: { ...payload, topSessions: [] }, filter: { model: "claude-opus-4-8" } });
    expect(screen.getByText("Top sessions")).toBeDefined();
    expect(screen.getByText("No sessions in this range.")).toBeDefined();
  });

  it("hides the project card when the only bucket is Unassigned", () => {
    dash({ data: { ...payload, byProject: [{ project: null, sessions: 1, tokens: 5, tokensIn: 5, tokensOut: 0, tokensCache: 0 }] } });
    expect(screen.queryByText("Tokens by project")).toBeNull();
  });

  it("omits the share segment when total tokens are zero", () => {
    dash({ data: { ...payload, byProject: [
      { project: "z", sessions: 1, tokens: 0, tokensIn: 0, tokensOut: 0, tokensCache: 0 },
      { project: "y", sessions: 1, tokens: 0, tokensIn: 0, tokensOut: 0, tokensCache: 0 },
    ] } });
    expect(screen.queryByText(/NaN|%/)).toBeNull();
  });
});

const rawStat = {
  agent: "claude", sessionId: "s1", project: "agentgem", model: "claude-opus-4-8", gitBranch: null,
  startMs: Date.now() - 10_000, endMs: Date.now() - 5_000, msgs: 200,
  tokensIn: 700_000, tokensOut: 150_000, tokensCache: 50_000,
};

describe("Observe view persistence", () => {
  afterEach(() => { sessionStorage.clear(); });

  const renderObserve = () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(res({ sessions: [rawStat] })));
    return render(<Observe apiBase="" />);
  };

  it("CRITICAL regression: fresh mount with empty storage keeps today's defaults (7d, min 100 msgs)", async () => {
    sessionStorage.clear();
    renderObserve();
    const tab = await screen.findByRole("tab", { name: "7d" });
    expect(tab.getAttribute("aria-selected")).toBe("true");
    expect((screen.getByLabelText("minimum messages per session") as HTMLInputElement).value).toBe("100");
  });

  it("rehydrates persisted range and filter", async () => {
    sessionStorage.setItem("agentgem.observe.view",
      JSON.stringify({ range: "30d", filter: { project: "agentgem", minMsgs: 100 } }));
    renderObserve();
    const tab = await screen.findByRole("tab", { name: "30d" });
    expect(tab.getAttribute("aria-selected")).toBe("true");
    expect((screen.getByLabelText("project") as HTMLSelectElement).value).toBe("agentgem");
  });

  it("garbage in storage falls back to defaults without crashing", async () => {
    sessionStorage.setItem("agentgem.observe.view", "not-json{{{");
    renderObserve();
    const tab = await screen.findByRole("tab", { name: "7d" });
    expect(tab.getAttribute("aria-selected")).toBe("true");
  });

  it("old-build values are whitelisted: unknown range falls back, cleared minMsgs survives", async () => {
    sessionStorage.setItem("agentgem.observe.view",
      JSON.stringify({ range: "14d", filter: {} }));
    renderObserve();
    const tab = await screen.findByRole("tab", { name: "7d" });     // "14d" not in the enum
    expect(tab.getAttribute("aria-selected")).toBe("true");
    expect((screen.getByLabelText("minimum messages per session") as HTMLInputElement).value).toBe(""); // cleared stays cleared
  });

  it("persists range changes for the next mount", async () => {
    renderObserve();
    fireEvent.click(await screen.findByRole("tab", { name: "30d" }));
    const stored = JSON.parse(sessionStorage.getItem("agentgem.observe.view")!);
    expect(stored.range).toBe("30d");
  });
});

describe("ObservePayloadSchema version-skew defaults", () => {
  it("parses an old server payload lacking byProject/topSessions (protects /api/observe consumers like SessionPicker)", () => {
    const { byProject: _bp, topSessions: _ts, ...legacy } = payload;
    const parsed = ObservePayloadSchema.safeParse(legacy);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.byProject).toEqual([]);
      expect(parsed.data.topSessions).toEqual([]);
    }
  });
});
