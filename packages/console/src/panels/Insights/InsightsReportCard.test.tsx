import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, act, fireEvent } from "@testing-library/react";
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

  it("shows 'Contribute to explore' button when onContribute is provided", () => {
    const report: InsightsReportView = {
      totals: { sessions: 1, mostly: 1, partially: 0, not: 0 },
      outcomes_summary: "1 session(s): 1 mostly achieved.",
      narrative: "You ship.",
      by_model: [],
      friction: [],
      publish_candidates: [{ sessionId: "b", goal: "write tests", why: "Succeeded" }],
    };
    render(<InsightsReportCard report={report} onContribute={() => {}} />);
    expect(screen.getByText("Contribute to explore →")).toBeTruthy();
  });

  const contributeReport: InsightsReportView = {
    totals: { sessions: 1, mostly: 1, partially: 0, not: 0 },
    outcomes_summary: "1 session(s): 1 mostly achieved.",
    narrative: "You ship.",
    by_model: [],
    friction: [],
    publish_candidates: [{ sessionId: "c", goal: "deploy feature", why: "Succeeded" }],
  };

  it("disables the Contribute button and shows Preparing… while the prepare call is in flight", async () => {
    let resolveContribute!: () => void;
    const onContribute = () => new Promise<void>((r) => { resolveContribute = r; });

    render(<InsightsReportCard report={contributeReport} onContribute={onContribute} />);
    const btn = screen.getByText("Contribute to explore →") as HTMLButtonElement;
    expect(btn.disabled).toBe(false);

    fireEvent.click(btn);

    await waitFor(() => {
      const preparing = screen.getByText("Preparing…") as HTMLButtonElement;
      expect(preparing).toBeTruthy();
      expect(preparing.disabled).toBe(true);
    });

    act(() => { resolveContribute(); });

    await waitFor(() => {
      const restored = screen.getByText("Contribute to explore →") as HTMLButtonElement;
      expect(restored.disabled).toBe(false);
    });
  });

  it("shows an error and does not navigate when prepare rejects", async () => {
    const originalHash = window.location.hash;
    const onContribute = () => Promise.reject(new Error("server blew up"));

    render(<InsightsReportCard report={contributeReport} onContribute={onContribute} />);
    const btn = screen.getByText("Contribute to explore →");
    fireEvent.click(btn);

    await waitFor(() => {
      expect(screen.getByText(/server blew up/)).toBeTruthy();
    });

    expect(window.location.hash).toBe(originalHash);
    expect((screen.getByText("Contribute to explore →") as HTMLButtonElement).disabled).toBe(false);
  });
});
