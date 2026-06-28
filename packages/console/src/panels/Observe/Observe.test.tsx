import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Dashboard } from "./Dashboard.js";
import type { ObservePayload } from "../../api/routes.js";

const payload: ObservePayload = {
  pulse: { sessions: 2, msgs: 12, tokens: 1_200_000, activeMs: 2.1 * 3_600_000 },
  daily: [{ date: "2026-06-28", sessions: 2, msgs: 12, tokensIn: 800_000, tokensOut: 300_000, tokensCache: 100_000 }],
  sessions: [{ agent: "claude", sessionId: "s1", project: "agentgem", model: "claude-opus-4-8", durationMs: 2.1 * 3_600_000, msgs: 8, tokens: 900_000, endMs: 0 }],
  models: [{ model: "claude-opus-4-8", agent: "claude", sessions: 2, tokens: 1_200_000 }],
  range: "7d",
};

describe("Observe Dashboard", () => {
  it("renders the pulse and a session row", () => {
    render(<Dashboard data={payload} range="7d" onRange={() => {}} />);
    expect(screen.getByText("1.2M")).toBeDefined();       // pulse tokens
    expect(screen.getByText("agentgem")).toBeDefined();    // session row project
  });
});
