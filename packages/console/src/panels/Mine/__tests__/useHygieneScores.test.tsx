import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, cleanup } from "@testing-library/react";
import * as rubricStreamModule from "../../Rubrics/rubricStream.js";
import { useHygieneScores } from "../useHygieneScores.js";
import type { MineRubricRun } from "../mineJobs.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function mockDoneStream(hygiene: { score: number; verdict: "bounded" | "mixed" | "bloated" } | undefined) {
  const abort = vi.fn();
  const spy = vi.spyOn(rubricStreamModule, "openRubricStream").mockImplementation((_client, _params, onEvent) => {
    onEvent({ type: "done", report: { hygiene } as any, cached: true, updatedAt: 1 });
    return abort;
  });
  return { spy, abort };
}

const run = (overrides: Partial<MineRubricRun> = {}): MineRubricRun => ({
  id: "r1", rubric: "context-hygiene", scope: "project", root: "/work/app", sessionId: "", status: "done", phase: "", startedAt: 1,
  ...overrides,
});

describe("useHygieneScores", () => {
  it("fetches the score for a root with a completed run, cache-hit (fresh=false)", () => {
    const { spy } = mockDoneStream({ score: 84, verdict: "bounded" });
    const { result } = renderHook(() => useHygieneScores(["/work/app"], [run()], "/api"));

    expect(result.current.get("/work/app")).toEqual({ score: 84, tone: "good", running: false });
    expect(spy).toHaveBeenCalledTimes(1);
    const [, params, , fresh] = spy.mock.calls[0];
    expect(params).toEqual({ rubric: "context-hygiene", scope: "project", root: "/work/app" });
    expect(fresh).toBe(false);
  });

  it("does not fetch for a root with only a running run — reports running:true, score null", () => {
    const { spy } = mockDoneStream({ score: 84, verdict: "bounded" });
    const runs = [run({ status: "running", startedAt: 2 })];
    const { result } = renderHook(() => useHygieneScores(["/work/app"], runs, "/api"));

    expect(result.current.get("/work/app")).toEqual({ score: null, tone: null, running: true });
    expect(spy).not.toHaveBeenCalled();
  });

  it("maps a bloated verdict to tone warn", () => {
    mockDoneStream({ score: 30, verdict: "bloated" });
    const { result } = renderHook(() => useHygieneScores(["/work/app"], [run()], "/api"));
    expect(result.current.get("/work/app")?.tone).toBe("warn");
  });

  it("maps a mixed verdict to tone warn", () => {
    mockDoneStream({ score: 55, verdict: "mixed" });
    const { result } = renderHook(() => useHygieneScores(["/work/app"], [run()], "/api"));
    expect(result.current.get("/work/app")?.tone).toBe("warn");
  });

  it("a root with neither a done nor running run is absent from the map, and no stream opens", () => {
    const spy = vi.spyOn(rubricStreamModule, "openRubricStream");
    const { result } = renderHook(() => useHygieneScores(["/work/app"], [], "/api"));
    expect(result.current.get("/work/app")).toBeUndefined();
    expect(spy).not.toHaveBeenCalled();
  });

  it("does not reopen the stream on a re-render with an equivalent (new-array, same-content) runs list", () => {
    const { spy } = mockDoneStream({ score: 84, verdict: "bounded" });
    const { rerender } = renderHook(
      ({ runs }: { runs: MineRubricRun[] }) => useHygieneScores(["/work/app"], runs, "/api"),
      { initialProps: { runs: [run()] } },
    );
    expect(spy).toHaveBeenCalledTimes(1);

    // A brand-new array, same logical run (same root/status/startedAt) — must not reopen.
    rerender({ runs: [run()] });
    expect(spy).toHaveBeenCalledTimes(1);

    // A genuinely NEW completed run (later startedAt) for the same root DOES re-fetch.
    rerender({ runs: [run({ startedAt: 99 })] });
    expect(spy).toHaveBeenCalledTimes(2);
  });
});
