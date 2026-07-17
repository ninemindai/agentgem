import { useEffect, useRef, useState } from "react";
import { homeSummaryRoute, makeClient, type HomeSummary, type Scorecard } from "../../api/routes.js";
import { openScorecardStream, type ScorecardStreamEvent } from "../Mine/scorecardStream.js";

export type RevealStreamPhase = "idle" | "loading" | "scanning" | "done";

const SLOW_MS = 8000;

/** Fetches the two data sources the reveal panel needs — `GET /api/home/summary`
 *  (usage totals + the Claude fire-gate, one-shot) and the scorecard scan (SSE,
 *  same `openScorecardStream` consumer WorkflowsView uses) — but ONLY once
 *  `active` flips true. This is the hard consent gate: the effect below never
 *  runs while `active` is false, so a first-run visitor who hasn't clicked
 *  "Scan my sessions" yet triggers zero network calls. */
export function useRevealData(
  apiBase: string,
  active: boolean,
  opts?: { openStream?: typeof openScorecardStream },
) {
  const [summary, setSummary] = useState<HomeSummary | null>(null);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [scorecard, setScorecard] = useState<Scorecard | null>(null);
  const [scorecardUpdatedAt, setScorecardUpdatedAt] = useState<number | null>(null);
  const [phase, setPhase] = useState<RevealStreamPhase>("idle");
  const [progress, setProgress] = useState<{ done: number; total: number; label: string } | null>(null);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [slow, setSlow] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const openStream = opts?.openStream ?? openScorecardStream;

  useEffect(() => {
    if (!active) return;
    let alive = true;
    let done = false;
    setSummary(null); setSummaryError(null);
    setScorecard(null); setScorecardUpdatedAt(null);
    setPhase("loading"); setProgress(null); setStreamError(null); setSlow(false);

    homeSummaryRoute.call(makeClient(apiBase))
      .then((s) => { if (alive) setSummary(s); })
      .catch((e) => { if (alive) setSummaryError(String((e as Error)?.message ?? e)); });

    const close = openStream(makeClient(apiBase), (e: ScorecardStreamEvent) => {
      if (!alive) return;
      if (e.type === "start") setPhase((p) => (p === "done" ? p : "scanning"));
      else if (e.type === "stale") {
        setScorecard(e.scorecard); setScorecardUpdatedAt(e.updatedAt);
        setPhase((p) => (p === "done" ? p : "scanning"));
      } else if (e.type === "progress") {
        setProgress({ done: e.done, total: e.total, label: e.label });
        setPhase((p) => (p === "done" ? p : "scanning"));
      } else if (e.type === "done") {
        done = true;
        setScorecard(e.scorecard); setScorecardUpdatedAt(e.updatedAt); setPhase("done");
      } else if (e.type === "failed") {
        setStreamError(e.message);
      }
    });

    // "Slow" only describes a scan still in flight past 8s — once it's landed
    // (`done`), the flag is meaningless, so don't flip it just because the timer
    // happened to still be pending.
    const slowTimer = setTimeout(() => { if (alive && !done) setSlow(true); }, SLOW_MS);

    return () => { alive = false; close(); clearTimeout(slowTimer); };
  }, [active, apiBase, reloadKey, openStream]);

  const retry = () => setReloadKey((k) => k + 1);
  return { summary, summaryError, scorecard, scorecardUpdatedAt, phase, progress, streamError, slow, retry };
}
