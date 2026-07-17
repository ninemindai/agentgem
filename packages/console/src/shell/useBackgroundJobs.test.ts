import { describe, it, expect, afterEach, vi } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { useBackgroundJobs } from "./useBackgroundJobs.js";

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

function stubStatus(warm: unknown, dream: unknown) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const body = url.includes("/warm/status") ? warm : dream;
    return { ok: true, status: 200, json: async () => body } as unknown as Response;
  }));
}

describe("useBackgroundJobs", () => {
  it("off: warm has never run (running:false, last:null) and dream is quiet", async () => {
    stubStatus({ running: false, last: null, progress: null }, { enabled: true, phasesLit: [], promoted: 0, queued: 0, lastPassAtMs: null, progress: null });
    const { result } = renderHook(() => useBackgroundJobs(""));
    await waitFor(() => expect(result.current.mode).toBe("off"));
    expect(result.current.count).toBe(0);
    expect(result.current.jobs).toEqual([]);
  });

  it("idle: warm has completed at least one pass and nothing is currently running", async () => {
    stubStatus(
      { running: false, last: { finishedAt: 1000 }, progress: null },
      { enabled: true, phasesLit: ["LIGHT"], promoted: 1, queued: 0, lastPassAtMs: 1000, progress: null },
    );
    const { result } = renderHook(() => useBackgroundJobs(""));
    await waitFor(() => expect(result.current.mode).toBe("idle"));
    expect(result.current.count).toBe(0);
    expect(result.current.jobs).toEqual([{ id: "warm", label: "Background caches warm", route: "#/optimize" }]);
  });

  it("active: warm is running — contributes a job row and flips the mode", async () => {
    stubStatus(
      { running: true, last: null, progress: { phase: "LIGHT" } },
      { enabled: true, phasesLit: [], promoted: 0, queued: 0, lastPassAtMs: null, progress: null },
    );
    const { result } = renderHook(() => useBackgroundJobs(""));
    await waitFor(() => expect(result.current.mode).toBe("active"));
    expect(result.current.count).toBe(1);
    expect(result.current.jobs).toEqual([{ id: "warm", label: "Precomputing background caches — LIGHT", route: "#/optimize" }]);
  });

  it("active: a running dream pass counts too, even while warm is off", async () => {
    stubStatus(
      { running: false, last: null, progress: null },
      { enabled: true, phasesLit: ["DEEP"], promoted: 0, queued: 2, lastPassAtMs: null, progress: { phase: "DEEP", phasesLit: ["DEEP"], currentRoot: null, rootIndex: 0, rootCount: 1, done: 1, total: 3 } },
    );
    const { result } = renderHook(() => useBackgroundJobs(""));
    await waitFor(() => expect(result.current.mode).toBe("active"));
    expect(result.current.jobs.some((j) => j.id === "dream" && j.label === "Dreaming — DEEP")).toBe(true);
  });

  it("exposes the dream queue count for the Review inbox rail entry", async () => {
    stubStatus(
      { running: false, last: { finishedAt: 1 }, progress: null },
      { enabled: true, phasesLit: [], promoted: 0, queued: 4, lastPassAtMs: null, progress: null },
    );
    const { result } = renderHook(() => useBackgroundJobs(""));
    await waitFor(() => expect(result.current.inboxCount).toBe(4));
    // idle mode still surfaces the queued items as a job row when nothing is running.
    expect(result.current.jobs.some((j) => j.id === "dream" && j.label === "4 items awaiting review")).toBe(true);
  });

  it("clears its poll interval on unmount (no timer leak)", async () => {
    vi.useFakeTimers();
    stubStatus({ running: false, last: null, progress: null }, { enabled: true, phasesLit: [], promoted: 0, queued: 0, lastPassAtMs: null, progress: null });
    const clearSpy = vi.spyOn(globalThis, "clearInterval");
    const { unmount } = renderHook(() => useBackgroundJobs(""));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    unmount();
    expect(clearSpy).toHaveBeenCalled();
  });
});
