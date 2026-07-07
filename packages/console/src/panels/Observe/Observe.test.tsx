import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.location.hash = ""; });
import { Dashboard } from "./Dashboard.js";
import { Observe } from "./index.js";
import type { ObservePayload } from "../../api/routes.js";

const res = (body: unknown) =>
  ({ ok: true, status: 200, text: async () => JSON.stringify(body) }) as unknown as Response;

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

describe("Observe first-run", () => {
  it("shows an oriented signpost when the local session log is empty", async () => {
    window.location.hash = "#/inspect";
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL) =>
      String(url).includes("/api/observe/raw") ? res({ sessions: [] }) : res({}),
    ));
    render(<Observe apiBase="" />);
    expect(await screen.findByText(/nothing to inspect yet/i)).toBeTruthy();
  });
});
