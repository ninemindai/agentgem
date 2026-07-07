// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { ProcessQualityReport } from "./ProcessQualityReport.js";
import * as routes from "../../api/routes.js";

const sample = {
  sessionId: "sess-1", agent: "claude", project: "repo", model: "claude-opus-4-8", gitBranch: "main",
  startMs: 0, endMs: 1000, durationMs: 1000, msgs: 4, tokensIn: 100, tokensOut: 40, tokensCache: 0,
  process: { score: 70, label: "loose" as const, stages: { exploration: 1, implementation: 2, verification: 1, orchestration: 0, other: 0 } },
  findings: [{ id: "retry-storm", title: "Same command repeated back-to-back", advice: "Read output before re-running.", severity: "warn" as const, count: 1, sessions: 1 }],
  events: null,
};

afterEach(() => vi.restoreAllMocks());

describe("ProcessQualityReport", () => {
  it("renders the score, label, and a finding for a Claude session", async () => {
    vi.spyOn(routes.processRoute, "call").mockResolvedValue(sample as never);
    render(<ProcessQualityReport apiBase="/api" agent="claude" sessionId="sess-1" />);
    expect(await screen.findByText("70")).toBeTruthy();
    expect(await screen.findByText(/loose/i)).toBeTruthy();
    expect(await screen.findByText(/repeated back-to-back/i)).toBeTruthy();
  });

  it("shows a muted note when process is null", async () => {
    vi.spyOn(routes.processRoute, "call").mockResolvedValue({ ...sample, process: null, findings: [] } as never);
    render(<ProcessQualityReport apiBase="/api" agent="claude" sessionId="sess-1" />);
    expect(await screen.findByText(/no process data/i)).toBeTruthy();
  });

  it("renders nothing and does not fetch for a Codex session", () => {
    const spy = vi.spyOn(routes.processRoute, "call");
    const { container } = render(<ProcessQualityReport apiBase="/api" agent="codex" sessionId="sess-1" />);
    expect(container.firstChild).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });
});
