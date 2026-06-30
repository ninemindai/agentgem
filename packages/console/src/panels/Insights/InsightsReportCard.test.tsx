import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { InsightsReportCard } from "./index.js";
import type { InsightsReportView } from "./insightsStream.js";

afterEach(cleanup);

describe("InsightsReportCard", () => {
  it("renders a full report with the by-model breakdown", () => {
    const report: InsightsReportView = {
      totals: { sessions: 2, mostly: 1, partially: 0, not: 1 },
      outcomes_summary: "2 session(s): 1 mostly achieved.",
      narrative: "You ship end-to-end.",
      by_model: [
        { model: "claude-opus-4-8", mostly: 1, partially: 0, not: 0, total: 1 },
        { model: "gpt-5.1", mostly: 0, partially: 0, not: 1, total: 1 },
      ],
      friction: [],
      publish_candidates: [{ sessionId: "a", goal: "ship auth", why: "Succeeded" }],
    };
    render(<InsightsReportCard report={report} />);
    expect(screen.getByText("By model")).toBeTruthy();
    expect(screen.getByText("Worth publishing")).toBeTruthy();
  });

  it("renders a malformed older-shape report (missing by_model) without crashing", () => {
    // Regression: a stale cache entry (pre-by_model) was served and the panel hit
    // report.by_model.length on undefined → whole-console crash.
    const stale = {
      totals: { sessions: 2, mostly: 1, partially: 0, not: 1 },
      outcomes_summary: "2 session(s): 1 mostly achieved.",
      narrative: "You ship end-to-end.",
      friction: [],
      publish_candidates: [],
      // by_model intentionally absent
    } as unknown as InsightsReportView;
    expect(() => render(<InsightsReportCard report={stale} />)).not.toThrow();
    expect(screen.getByText("2 session(s): 1 mostly achieved.")).toBeTruthy();
  });
});
