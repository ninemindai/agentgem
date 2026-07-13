// Adds background/reattach/notify awareness to a report panel WITHOUT changing how
// it streams. The panel passes its existing stream opener (openInsightsStream etc.,
// normalized to Handlers<T>); the hook decides WHEN to open it: live on a fresh
// start, once-on-done for a reattach (a cache hit), never for a key already running
// (it polls /api/report/runs instead, so we don't kick off a duplicate compute).
import { useCallback, useEffect, useRef, useState } from "react";

export type RunPhase = "idle" | "running" | "done" | "failed";
export interface Handlers<T> { phase: (p: string) => void; delta: (t: string) => void; done: (payload: T) => void; failed: (msg: string) => void }
export interface OpenStream<T> { (fresh: boolean, params: Record<string, string>, h: Handlers<T>): () => void }
export interface ReportRunView<T> { status: RunPhase; phase: string; deltas: string; report: T | null; error: string | null; params: Record<string, string> | null }

interface RunSummary { id: string; kind: string; paramsKey: string; params: Record<string, string>; status: "running" | "done" | "failed"; phase: string; startedAt: number; error?: string }

const IDLE = { status: "idle" as RunPhase, phase: "", deltas: "", report: null, error: null, params: null };
const POLL_MS = 1500;
// Stop polling a reattached run after ~10 min (it keeps running server-side; the
// activity poll + a later remount still reflect it). Mirrors Studio's pollWhileRunning.
const POLL_MAX = Math.round((10 * 60_000) / POLL_MS);

export function useReportRun<T>(apiBase: string, kind: string, openStream: OpenStream<T>) {
  const [view, setView] = useState<ReportRunView<T>>(IDLE);
  const closeRef = useRef<(() => void) | null>(null);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const aliveRef = useRef(true);

  const handlers = useCallback((): Handlers<T> => ({
    phase: (p) => setView((s) => ({ ...s, status: "running", phase: p })),
    delta: (t) => setView((s) => ({ ...s, deltas: s.deltas + t })),
    done: (payload) => setView((s) => ({ ...s, status: "done", phase: "done", report: payload })),
    failed: (msg) => setView((s) => ({ ...s, status: "failed", error: msg })),
  }), []);

  const openLive = useCallback((fresh: boolean, params: Record<string, string>) => {
    closeRef.current?.();
    // Empty initial phase so each panel's own `running ? "…"` badge placeholder shows
    // until the first real phase event (attach/reattach uses "resuming…" below instead).
    setView({ ...IDLE, status: "running", phase: "", params });
    closeRef.current = openStream(fresh, params, handlers());
  }, [openStream, handlers]);

  const fetchRuns = useCallback(async (): Promise<RunSummary[]> => {
    try { const r = await fetch(`${apiBase}/api/report/runs`); return r.ok ? ((await r.json()).runs as RunSummary[]) : []; } catch { return []; }
  }, [apiBase]);

  // Poll /runs for one key until it leaves "running", then open the stream once (cache hit) to load the report.
  const attachAndPoll = useCallback((paramsKey: string, params: Record<string, string>) => {
    if (pollRef.current) { clearTimeout(pollRef.current); pollRef.current = null; }
    setView({ ...IDLE, status: "running", phase: "resuming…", params });
    let ticks = 0;
    const tick = async () => {
      const runs = await fetchRuns();
      if (!aliveRef.current) return;
      const rec = runs.find((x) => x.kind === kind && x.paramsKey === paramsKey);
      if (!rec || rec.status === "running") {
        if (rec?.phase) setView((s) => ({ ...s, phase: rec.phase }));
        if (++ticks >= POLL_MAX) return;   // give up after ~10 min; the run continues server-side
        pollRef.current = setTimeout(tick, POLL_MS);
        return;
      }
      if (rec.status === "failed") { setView((s) => ({ ...s, status: "failed", error: rec.error ?? "failed" })); return; }
      openLive(false, params);   // done → cache hit loads the report
    };
    pollRef.current = setTimeout(tick, POLL_MS);
  }, [fetchRuns, kind, openLive]);

  const start = useCallback((paramsKey: string, params: Record<string, string>, fresh = false) => {
    if (pollRef.current) { clearTimeout(pollRef.current); pollRef.current = null; }
    if (fresh) { openLive(true, params); return; }
    // Guard: if this key is already running, attach instead of opening a 2nd stream.
    void fetchRuns().then((runs) => {
      if (!aliveRef.current) return;
      const rec = runs.find((x) => x.kind === kind && x.paramsKey === paramsKey);
      if (rec && rec.status === "running") attachAndPoll(paramsKey, params);
      else openLive(false, params);
    });
  }, [fetchRuns, kind, openLive, attachAndPoll]);

  // Mount: reattach the latest run of this kind.
  useEffect(() => {
    aliveRef.current = true;
    void fetchRuns().then((runs) => {
      if (!aliveRef.current) return;
      const rec = runs.filter((x) => x.kind === kind).sort((a, b) => b.startedAt - a.startedAt)[0];
      if (!rec) return;
      if (rec.status === "running") attachAndPoll(rec.paramsKey, rec.params);
      else if (rec.status === "failed") setView({ ...IDLE, status: "failed", phase: rec.phase, error: rec.error ?? "failed", params: rec.params });
      else openLive(false, rec.params);   // done → cache hit
    });
    return () => { aliveRef.current = false; closeRef.current?.(); if (pollRef.current) clearTimeout(pollRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiBase, kind]);

  return { view, start };
}
