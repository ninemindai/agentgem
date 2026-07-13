import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useReportRun } from "../useReportRun.js";

// A fake openStream we can drive; records how it was called.
function makeOpen() {
  const calls: { fresh: boolean; params: Record<string, string> }[] = [];
  let hExternal: any = null;
  const open = (fresh: boolean, params: Record<string, string>, h: any) => { calls.push({ fresh, params }); hExternal = h; return () => {}; };
  return { open, calls, fire: (t: string, v?: any) => hExternal[t](v) };
}

beforeEach(() => vi.restoreAllMocks());

describe("useReportRun", () => {
  it("start() with no in-flight run opens a live stream and folds events", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ runs: [] }) }));
    const o = makeOpen();
    const { result } = renderHook(() => useReportRun<{ n: number }>("http://x", "insights", o.open));
    await waitFor(() => expect(fetch).toHaveBeenCalled());   // mount poll (no runs)

    act(() => result.current.start("/p", { root: "/p" }));
    await waitFor(() => expect(o.calls.length).toBe(1));
    expect(o.calls[0]).toEqual({ fresh: false, params: { root: "/p" } });

    act(() => o.fire("phase", "judging"));
    expect(result.current.view.status).toBe("running");
    expect(result.current.view.phase).toBe("judging");
    act(() => o.fire("done", { n: 7 }));
    expect(result.current.view.status).toBe("done");
    expect(result.current.view.report).toEqual({ n: 7 });
  });

  it("start() on an already-running key does NOT open a stream (avoids double-compute)", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ runs: [] }) })   // mount
      .mockResolvedValueOnce({ ok: true, json: async () => ({ runs: [{ id: "insights:/p", kind: "insights", paramsKey: "/p", params: { root: "/p" }, status: "running", phase: "judging", startedAt: 1 }] }) })); // start guard
    const o = makeOpen();
    const { result } = renderHook(() => useReportRun("http://x", "insights", o.open));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));

    act(() => result.current.start("/p", { root: "/p" }));
    await waitFor(() => expect(result.current.view.status).toBe("running"));
    expect(o.calls.length).toBe(0);   // attached via poll, no stream opened
  });

  it("reattaches a DONE run on mount by opening the stream once (cache hit)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ runs: [{ id: "insights:/p", kind: "insights", paramsKey: "/p", params: { root: "/p" }, status: "done", phase: "done", startedAt: 1, finishedAt: 2 }] }) }));
    const o = makeOpen();
    const { result } = renderHook(() => useReportRun<{ n: number }>("http://x", "insights", o.open));
    await waitFor(() => expect(o.calls.length).toBe(1));
    expect(o.calls[0]).toEqual({ fresh: false, params: { root: "/p" } });
    act(() => o.fire("done", { n: 3 }));
    expect(result.current.view.report).toEqual({ n: 3 });
  });

  it("reattaches a FAILED run on mount from the record (no stream)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ runs: [{ id: "rubric:k", kind: "rubric", paramsKey: "k", params: {}, status: "failed", phase: "x", startedAt: 1, finishedAt: 2, error: "boom" }] }) }));
    const o = makeOpen();
    const { result } = renderHook(() => useReportRun("http://x", "rubric", o.open));
    await waitFor(() => expect(result.current.view.status).toBe("failed"));
    expect(result.current.view.error).toBe("boom");
    expect(o.calls.length).toBe(0);
  });
});
