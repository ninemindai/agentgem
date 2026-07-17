import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, act, screen } from "@testing-library/react";
import * as routes from "../../api/routes.js";
import { useRevealData } from "./useRevealData.js";
import { openScorecardStream, type ScorecardStreamEvent } from "../Mine/scorecardStream.js";

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });

const SUMMARY: routes.HomeSummary = {
  usage: { sessions: 10, spanDays: 5, activeMs: 3_600_000, tokensIn: 100, tokensOut: 50, tokensCache: 0 },
  claudeSessions: 10,
  gate: { usageEmpty: false, claudeBelowGate: false },
  scorecardCached: false,
  projectsScanned: 3,
  projectsCap: 5,
};

function Probe({ active, openStream }: { active: boolean; openStream?: typeof openScorecardStream }) {
  const data = useRevealData("", active, openStream ? { openStream } : undefined);
  return (
    <div>
      <span data-testid="phase">{data.phase}</span>
      <span data-testid="slow">{String(data.slow)}</span>
      <span data-testid="summary">{data.summary ? "yes" : "no"}</span>
      <span data-testid="scorecard">{data.scorecard ? "yes" : "no"}</span>
      <span data-testid="summaryError">{data.summaryError ?? ""}</span>
      <span data-testid="streamError">{data.streamError ?? ""}</span>
      <button onClick={data.retry}>retry</button>
    </div>
  );
}

describe("useRevealData", () => {
  it("makes zero calls while inactive", () => {
    const summarySpy = vi.spyOn(routes.homeSummaryRoute, "call");
    const openStream = vi.fn(() => () => {});
    render(<Probe active={false} openStream={openStream} />);
    expect(summarySpy).not.toHaveBeenCalled();
    expect(openStream).not.toHaveBeenCalled();
  });

  it("fetches the summary and opens the stream exactly once when active flips true", async () => {
    const summarySpy = vi.spyOn(routes.homeSummaryRoute, "call").mockResolvedValue(SUMMARY);
    const openStream = vi.fn(() => () => {});
    const { rerender } = render(<Probe active={false} openStream={openStream} />);
    rerender(<Probe active={true} openStream={openStream} />);
    await act(async () => {});
    expect(summarySpy).toHaveBeenCalledTimes(1);
    expect(openStream).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("yes")).toBeTruthy();
  });

  it("flips slow=true after 8s if the scan hasn't finished", async () => {
    vi.useFakeTimers();
    vi.spyOn(routes.homeSummaryRoute, "call").mockResolvedValue(SUMMARY);
    const openStream = vi.fn(() => () => {}); // never emits — scan hangs
    render(<Probe active={true} openStream={openStream} />);
    expect(screen.getByTestId("slow").textContent).toBe("false");
    await act(async () => { vi.advanceTimersByTime(8001); });
    expect(screen.getByTestId("slow").textContent).toBe("true");
  });

  it("stays not-slow once the scan reaches done before 8s", async () => {
    vi.useFakeTimers();
    vi.spyOn(routes.homeSummaryRoute, "call").mockResolvedValue(SUMMARY);
    let emit: ((e: ScorecardStreamEvent) => void) | null = null;
    const openStream = vi.fn((_client: unknown, onEvent: (e: ScorecardStreamEvent) => void) => {
      emit = onEvent;
      return () => {};
    });
    render(<Probe active={true} openStream={openStream} />);
    await act(async () => {
      emit?.({ type: "done", scorecard: { breadth: 1, battleTested: 1, portable: 0, gaps: [], projects: [], generatedAtMs: 1, degraded: false }, cached: false, updatedAt: 1 });
    });
    expect(screen.getByTestId("scorecard").textContent).toBe("yes");
    await act(async () => { vi.advanceTimersByTime(8001); });
    expect(screen.getByTestId("slow").textContent).toBe("false");
  });

  it("surfaces a summary fetch failure", async () => {
    vi.spyOn(routes.homeSummaryRoute, "call").mockRejectedValue(new Error("boom"));
    const openStream = vi.fn(() => () => {});
    render(<Probe active={true} openStream={openStream} />);
    expect(await screen.findByText("boom")).toBeTruthy();
  });

  it("surfaces a whole-stream failure (no scorecard ever landed)", async () => {
    vi.spyOn(routes.homeSummaryRoute, "call").mockResolvedValue(SUMMARY);
    const openStream = vi.fn((_client: unknown, onEvent: (e: ScorecardStreamEvent) => void) => {
      onEvent({ type: "failed", message: "stream connection error" });
      return () => {};
    });
    render(<Probe active={true} openStream={openStream} />);
    expect(await screen.findByText("stream connection error")).toBeTruthy();
    expect(screen.getByTestId("scorecard").textContent).toBe("no");
  });

  it("retry re-fetches the summary and re-opens the stream", async () => {
    const summarySpy = vi.spyOn(routes.homeSummaryRoute, "call").mockResolvedValue(SUMMARY);
    const openStream = vi.fn(() => () => {});
    render(<Probe active={true} openStream={openStream} />);
    await act(async () => {});
    expect(summarySpy).toHaveBeenCalledTimes(1);
    expect(openStream).toHaveBeenCalledTimes(1);
    act(() => { screen.getByText("retry").click(); });
    await act(async () => {});
    expect(summarySpy).toHaveBeenCalledTimes(2);
    expect(openStream).toHaveBeenCalledTimes(2);
  });
});
