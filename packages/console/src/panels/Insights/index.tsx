import { useEffect, useRef, useState } from "react";
import { testbedRecentsRoute, testbedProjectsRoute, makeClient, type RecentEntry, type ProjectCandidate } from "../../api/routes.js";
import { defineConsolePage } from "../../registry.js";
import { openInsightsStream, type InsightsReportView } from "./insightsStream.js";
import { setPendingAnalyze } from "../../pendingAnalyze.js";
import { Loading } from "../../shell/Loading.js";

function short(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts.length > 3 ? "…/" + parts.slice(-3).join("/") : path;
}

/** Personal "/insights"-style report: pick a project, agentgem judges each of its
 *  sessions (goal + outcome + friction) and surfaces the succeeded ones worth
 *  publishing as Gems. */
export function Insights({ apiBase }: { apiBase: string }) {
  const [projects, setProjects] = useState<ProjectCandidate[] | null>(null);
  const [recents, setRecents] = useState<RecentEntry[] | null>(null);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [phase, setPhase] = useState("");
  const [out, setOut] = useState("");
  const [report, setReport] = useState<InsightsReportView | null>(null);
  const [degraded, setDegraded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [running, setRunning] = useState(false);
  const closeRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const client = makeClient(apiBase);
    testbedProjectsRoute.call(client).then((r) => setProjects(r.projects)).catch(() => setProjects([]));
    testbedRecentsRoute.call(client).then((r) => setRecents(r.recents)).catch(() => setRecents([]));
  }, [apiBase]);
  useEffect(() => () => closeRef.current?.(), []);

  const generate = (path: string, fresh = false) => {
    closeRef.current?.();
    setActivePath(path); setPhase(""); setOut(""); setReport(null); setDegraded(false); setError(null); setRunning(true);
    closeRef.current = openInsightsStream(apiBase, path, (e) => {
      if (e.type === "phase") setPhase(e.sessions != null ? `${e.phase} (${e.sessions} sessions)` : e.phase);
      else if (e.type === "delta") setOut((o) => o + e.text);
      else if (e.type === "done") { setPhase("done"); setReport(e.report); setDegraded(e.degraded); setRunning(false); }
      else if (e.type === "failed") { setError(e.message); setRunning(false); }
    }, fresh);
  };

  const rows = (() => {
    const seen = new Set<string>();
    const acc: { path: string; flavor: string; label: string }[] = [];
    for (const r of recents ?? []) { if (!seen.has(r.path)) { seen.add(r.path); acc.push({ path: r.path, flavor: r.flavor, label: r.name }); } }
    for (const p of projects ?? []) { if (!seen.has(p.path)) { seen.add(p.path); acc.push({ path: p.path, flavor: p.flavor, label: short(p.path) }); } }
    const q = query.trim().toLowerCase();
    const matched = q ? acc.filter((r) => r.label.toLowerCase().includes(q) || r.path.toLowerCase().includes(q)) : acc;
    return matched.slice(0, 40);
  })();

  return (
    <section className="analyze">
      <p className="analyze-intro">Pick a project — agentgem reads its sessions and tells you what you were working on, how it went, and which wins are worth publishing.</p>
      {(projects || recents) && (
        <input
          className="ledger-search"
          type="text"
          placeholder="search projects…"
          aria-label="search projects"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          style={{ marginBottom: 12 }}
        />
      )}
      {!projects && !recents ? <Loading />
        : rows.length === 0 ? <p className="ledger-empty">{query ? "No projects match." : "No projects with session history found."}</p>
        : (
          <ul className="analyze-list">
            {rows.map((r) => {
              const active = activePath === r.path;
              return (
                <li className={"analyze-row" + (active ? " is-active" : "")} key={r.path}>
                  <div className="analyze-row-head">
                    <span className="analyze-name">{r.label}</span>
                    <span className="ws-chip">{r.flavor}</span>
                    <button
                      type="button"
                      className="ledger-view"
                      disabled={running}
                      onClick={() => generate(r.path)}
                    >{active && running ? "Reading…" : "Insights →"}</button>
                  </div>
                  {active && (
                    <div className="run-out analyze-status">
                      <div className="run-status">
                        <span className={"run-badge " + (error ? "run-failed" : running ? "run-running" : "run-done")}>
                          {error ? "failed" : phase || (running ? "Reading…" : "done")}
                        </span>
                        {degraded && !error && <span className="ws-chip" title="The local agent was unavailable; showing a basic report.">basic</span>}
                        {report && !running && (
                          <button type="button" className="ledger-view" style={{ marginLeft: "auto" }} onClick={() => generate(r.path, true)}>Re-run ↻</button>
                        )}
                      </div>
                      {error && <p className="ledger-error">{error}</p>}
                      {out && !report && <pre className="run-transcript">{out}</pre>}
                      {report && (
                        <InsightsReportCard
                          report={report}
                          onBuild={() => { setPendingAnalyze(r.path); window.location.hash = "#/curate"; }}
                        />
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
    </section>
  );
}

function InsightsReportCard({ report, onBuild }: { report: InsightsReportView; onBuild: () => void }) {
  return (
    <div className="insights-report">
      {report.narrative && <p className="insights-narrative">{report.narrative}</p>}
      <p className="analyze-candidate-desc">{report.outcomes_summary}</p>

      {report.publish_candidates.length > 0 && (
        <div className="insights-section">
          <div className="analyze-candidate-head">
            <h4 style={{ margin: 0 }}>Worth publishing</h4>
            <button type="button" className="ledger-build" style={{ marginLeft: "auto" }} onClick={onBuild}>Build a Gem from this project →</button>
          </div>
          <ul className="analyze-include">
            {report.publish_candidates.map((c) => (
              <li key={c.sessionId}>
                <span className="analyze-include-name">{c.goal}</span>
                <span className="targets-label">{c.why}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {report.friction.length > 0 && (
        <div className="insights-section">
          <h4>Friction</h4>
          <ul className="analyze-include">
            {report.friction.map((f) => (
              <li key={f.sessionId}><span className="analyze-include-name">{f.detail}</span></li>
            ))}
          </ul>
        </div>
      )}

      {report.publish_candidates.length === 0 && report.friction.length === 0 && (
        <p className="ledger-empty">No standout sessions yet — keep working and re-run.</p>
      )}
    </div>
  );
}

export const insightsPage = defineConsolePage({
  id: "insights", title: "Insights", icon: "📊", order: 7, group: "observe",
  route: "#/insights", component: Insights,
});
