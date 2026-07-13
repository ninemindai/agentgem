import { useEffect, useMemo, useRef, useState } from "react";
import { makeClient } from "../../api/routes.js";
import { openInsightsStream, type InsightsReportView, type InsightsEvent } from "./insightsStream.js";
import { InsightsReportCard } from "./OutcomesReport.js";
import { setPendingAnalyze, setPendingPlaybook } from "../../pendingAnalyze.js";
import { timeAgo } from "../../util/timeAgo.js";

/** The Outcomes view of the Mine tab: an LLM-judged per-session report for the
 *  scoped project. Peeks the cache (cacheOnly) on scope change and paints a cached
 *  report instantly; the expensive judge runs only on an explicit Generate/Refresh. */
export function OutcomesView({ apiBase, scope, openStream = openInsightsStream }: { apiBase: string; scope: string; openStream?: typeof openInsightsStream }) {
  const client = useMemo(() => makeClient(apiBase), [apiBase]);
  const [phase, setPhase] = useState("");
  const [out, setOut] = useState("");
  const [report, setReport] = useState<InsightsReportView | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [scanned, setScanned] = useState<number | null>(null);
  const [degraded, setDegraded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const closeRef = useRef<(() => void) | null>(null);

  const reset = () => { setPhase(""); setOut(""); setReport(null); setUpdatedAt(null); setScanned(null); setDegraded(false); setError(null); };

  const paint = (e: Extract<InsightsEvent, { type: "done" }>) => {
    setPhase("done"); setReport(e.report); setUpdatedAt(e.updatedAt); setScanned(e.scanned ?? null); setDegraded(e.degraded);
  };

  const run = (opts: { fresh?: boolean; cacheOnly?: boolean }) => {
    closeRef.current?.();
    reset();
    setRunning(!opts.cacheOnly); // a peek doesn't show the running/Reading state
    closeRef.current = openStream(client, scope, (e: InsightsEvent) => {
      if (opts.cacheOnly) {
        // Silent peek: ignore progress (the compute emits a "scanning" phase even
        // for a cache read); only paint on a genuine cache HIT, else leave the
        // Generate prompt up.
        if (e.type === "done") { setRunning(false); if (e.cached) paint(e); }
        else if (e.type === "failed") setRunning(false);
        return;
      }
      if (e.type === "phase") setPhase(e.sessions != null ? `${e.phase} (${e.sessions} sessions)` : e.phase);
      else if (e.type === "delta") setOut((o) => o + e.text);
      else if (e.type === "done") { setRunning(false); paint(e); }
      else if (e.type === "failed") { setError(e.message); setRunning(false); }
    }, opts);
  };

  // Peek the cache whenever the scoped project changes. Never spends the LLM.
  useEffect(() => { run({ cacheOnly: true }); return () => closeRef.current?.(); }, [client, scope]); // eslint-disable-line react-hooks/exhaustive-deps

  const canBuild = scope !== "*";
  return (
    <section className="analyze">
      <p className="analyze-intro">agentgem reads this project's sessions and tells you what you were working on, how it went, and which wins are worth publishing.</p>
      <div className="run-out analyze-status">
        <div className="run-status">
          <span className={"run-badge " + (error ? "run-failed" : running ? "run-running" : "run-done")}>
            {error ? "failed" : phase || (running ? "Reading…" : report ? "done" : "not run")}
          </span>
          {degraded && !error && <span className="ws-chip" title="The local agent was unavailable; showing a basic report.">basic</span>}
          {report && !running && updatedAt != null && (
            <span className="ledger-muted" style={{ marginLeft: "auto", marginRight: 8 }}>updated {timeAgo(updatedAt)}</span>
          )}
          {!running && (
            <button
              type="button"
              className="ledger-view"
              style={report && updatedAt != null ? undefined : { marginLeft: "auto" }}
              onClick={() => run({ fresh: !!report })}
            >{report ? "Refresh ↻" : "Generate report →"}</button>
          )}
        </div>
        {error && <p className="ledger-error">{error}</p>}
        {out && !report && <pre className="run-transcript">{out}</pre>}
        {report && (
          <InsightsReportCard
            report={report}
            scanned={scanned}
            onBuild={canBuild ? () => { setPendingAnalyze(scope); window.location.hash = "#/curate"; } : undefined}
            onContribute={canBuild ? () => { setPendingPlaybook({ root: scope }); window.location.hash = "#/curate"; } : undefined}
          />
        )}
      </div>
    </section>
  );
}
