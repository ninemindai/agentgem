import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { Insights } from "./index.js";

const DONE = {
  type: "done",
  report: { totals: { sessions: 2, mostly: 1, partially: 1, not: 0 }, outcomes_summary: "went well", narrative: "N", by_model: [], friction: [], publish_candidates: [] },
  degraded: false,
  scanned: 2,
  updatedAt: 123,
};

// The insights stream is now a `streamOf:` route consumed by @agentback/client's
// route.stream(): a text/event-stream of `data:` frames over fetch. The report
// routes + testbed routes stay plain JSON. One fetch stub serves all three.
beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async (u: string) => {
    const url = String(u);
    if (url.includes("/api/insights/stream")) {
      return new Response(`data: ${JSON.stringify(DONE)}\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    if (url.includes("/api/report/runs")) return { ok: true, json: async () => ({ runs: [] }) } as unknown as Response;
    return { ok: true, json: async () => ({ projects: [{ path: "/proj", flavor: "claude", name: "proj" }], recents: [] }) } as unknown as Response;
  }));
});

describe("Insights panel (retrofit smoke test)", () => {
  it("renders the report when a run reports done", async () => {
    render(<Insights apiBase="http://x" />);
    const btn = await screen.findAllByText("Insights →");
    fireEvent.click(btn[0]);
    await waitFor(() => expect(screen.getByText("went well")).toBeTruthy());   // InsightsReportCard rendered
  });
});
