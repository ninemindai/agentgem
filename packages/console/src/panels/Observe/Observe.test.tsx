import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

afterEach(cleanup);
import { Dashboard } from "./Dashboard.js";
import type { ObservePayload } from "../../api/routes.js";

const payload: ObservePayload = {
  pulse: { sessions: 2, msgs: 12, tokens: 1_200_000, activeMs: 2.1 * 3_600_000 },
  daily: [{ date: "2026-06-28", sessions: 2, msgs: 12, tokensIn: 800_000, tokensOut: 300_000, tokensCache: 100_000 }],
  sessions: [{
    agent: "claude", sessionId: "s1", project: "agentgem", model: "claude-opus-4-8",
    startMs: 0, endMs: 0, durationMs: 2.1 * 3_600_000, msgs: 8, tokens: 900_000,
    tokensIn: 700_000, tokensOut: 200_000, tokensCache: 0, gitBranch: "main",
  }],
  models: [{ model: "claude-opus-4-8", agent: "claude", sessions: 2, tokens: 1_200_000 }],
  facets: { agents: ["claude"], projects: ["agentgem"], models: ["claude-opus-4-8"] },
  range: "7d",
};

describe("Observe Dashboard", () => {
  it("renders the pulse and a session row", () => {
    render(<Dashboard data={payload} range="7d" onRange={() => {}} filter={{}} onFilter={() => {}} />);
    expect(screen.getByText("1.2M")).toBeDefined();                    // pulse tokens
    expect(screen.getAllByText("agentgem").length).toBeGreaterThan(0); // session row project (also in dropdown)
  });

  it("renders filter controls with facet values", () => {
    render(<Dashboard data={payload} range="7d" onRange={() => {}} filter={{}} onFilter={() => {}} />);
    expect(screen.getByLabelText(/agent/i)).toBeDefined();              // agent dropdown
    expect(screen.getByLabelText(/model/i)).toBeDefined();             // model dropdown
    expect(screen.getAllByText("claude-opus-4-8").length).toBeGreaterThan(0); // model option present
  });
});
