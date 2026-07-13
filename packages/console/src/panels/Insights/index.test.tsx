import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { Insights } from "./index.js";

// Fake EventSource so openInsightsStream can drive the panel.
class FakeES {
  static last: FakeES | null = null;
  listeners = new Map<string, (e: MessageEvent) => void>();
  constructor(public url: string) { FakeES.last = this; }
  addEventListener(t: string, cb: (e: MessageEvent) => void) { this.listeners.set(t, cb); }
  close() {}
  fire(t: string, data: unknown) { this.listeners.get(t)?.({ data: JSON.stringify(data) } as MessageEvent); }
}

beforeEach(() => {
  (globalThis as any).EventSource = FakeES as unknown;
  FakeES.last = null;
  // /api/report/runs (mount reattach: none) + the two testbed routes.
  vi.stubGlobal("fetch", vi.fn(async (u: string) => {
    if (String(u).includes("/api/report/runs")) return { ok: true, json: async () => ({ runs: [] }) } as any;
    return { ok: true, json: async () => ({ projects: [{ path: "/proj", flavor: "claude", name: "proj" }], recents: [] }) } as any;
  }));
});

describe("Insights panel (retrofit smoke test)", () => {
  it("renders the report when a run reports done", async () => {
    render(<Insights apiBase="http://x" />);
    const btn = await screen.findAllByText("Insights →");
    fireEvent.click(btn[0]);
    await waitFor(() => expect(FakeES.last).not.toBeNull());
    FakeES.last!.fire("done", {
      report: { totals: { sessions: 2, mostly: 1, partially: 1, not: 0 }, outcomes_summary: "went well", narrative: "N", by_model: [], friction: [], publish_candidates: [] },
      signalSummary: { sessionsScanned: 2 }, degraded: false, updatedAt: 123,
    });
    await waitFor(() => expect(screen.getByText("went well")).toBeTruthy());   // InsightsReportCard rendered
  });
});
