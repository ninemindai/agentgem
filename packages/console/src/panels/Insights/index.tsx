import { useCallback, useEffect, useMemo, useState } from "react";
import { testbedRecentsRoute, testbedProjectsRoute, makeClient, type RecentEntry, type ProjectCandidate } from "../../api/routes.js";
import { defineConsolePage } from "../../registry.js";
import { openInsightsStream, type InsightsReportView } from "./insightsStream.js";
import { OutcomesDonut, ByModelBars } from "./InsightsCharts.js";
import { setPendingAnalyze, setPendingPlaybook } from "../../pendingAnalyze.js";
import { Loading } from "../../shell/Loading.js";
import { useTableSort, type SortColumn } from "../../shell/useTableSort.js";
import { SortTh } from "../../shell/SortTh.js";
import { timeAgo } from "../../util/timeAgo.js";
import { ReportActions } from "../../report/ReportActions.js";
import { insightsToBlocks, blocksToMarkdown, blocksToHtml } from "../../report/serialize.js";
import { useReportRun, type Handlers } from "../../report/useReportRun.js";

// Sortable columns for the "Worth publishing" table (unsorted = report order).
type PublishCandidate = InsightsReportView["publish_candidates"][number];
const CANDIDATE_COLUMNS: SortColumn<PublishCandidate>[] = [
  { id: "goal", value: (c) => c.goal.toLowerCase() },
  { id: "why", value: (c) => c.why.toLowerCase() },
];

type InsightsDone = { report: InsightsReportView; degraded: boolean; scanned?: number; updatedAt: number | null };

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
  const [query, setQuery] = useState("");

  // openStream adapter: the hook decides WHEN to open; this maps openInsightsStream's
  // events to the normalized Handlers and closes over the current root.
  const openStream = useCallback(
    (fresh: boolean, params: Record<string, string>, h: Handlers<InsightsDone>) =>
      openInsightsStream(apiBase, params.root, (e) => {
        if (e.type === "phase") h.phase(e.sessions != null ? `${e.phase} (${e.sessions} sessions)` : e.phase);
        else if (e.type === "delta") h.delta(e.text);
        else if (e.type === "done") h.done({ report: e.report, degraded: e.degraded, scanned: e.scanned, updatedAt: e.updatedAt });
        else if (e.type === "failed") h.failed(e.message);
      }, fresh),
    [apiBase],
  );
  const { view, start } = useReportRun<InsightsDone>(apiBase, "insights", openStream);

  useEffect(() => {
    const client = makeClient(apiBase);
    testbedProjectsRoute.call(client).then((r) => setProjects(r.projects)).catch(() => setProjects([]));
    testbedRecentsRoute.call(client).then((r) => setRecents(r.recents)).catch(() => setRecents([]));
  }, [apiBase]);

  // Reattached a run on mount → select its row.
  useEffect(() => { const root = view.params?.root; if (root && !activePath) setActivePath(root); }, [view.params, activePath]);

  const generate = (path: string, fresh = false) => { setActivePath(path); start(path, { root: path }, fresh); };

  const rows = (() => {
    const seen = new Set<string>();
    const acc: { path: string; flavor: string; label: string }[] = [];
    for (const r of recents ?? []) { if (!seen.has(r.path)) { seen.add(r.path); acc.push({ path: r.path, flavor: r.flavor, label: r.name }); } }
    for (const p of projects ?? []) { if (!seen.has(p.path)) { seen.add(p.path); acc.push({ path: p.path, flavor: p.flavor, label: short(p.path) }); } }
    const q = query.trim().toLowerCase();
    const matched = q ? acc.filter((r) => r.label.toLowerCase().includes(q) || r.path.toLowerCase().includes(q)) : acc;
    // "All projects" (root "*") leads the list — a cross-project report over the
    // most-recent sessions everywhere.
    return [{ path: "*", flavor: "all", label: "All projects" }, ...matched.slice(0, 40)];
  })();

  const running = view.status === "running";
  const report = view.report?.report ?? null;
  const updatedAt = view.report?.updatedAt ?? null;
  const scanned = view.report?.scanned ?? null;
  const degraded = view.report?.degraded ?? false;
  const phase = view.phase;
  const error = view.error;
  const out = view.deltas;

  return (
    <section className="analyze">
      <div className="obs-head"><h2 className="obs-title">Insights</h2></div>
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
                          <>
                            {updatedAt != null && (
                              <span className="ledger-muted" style={{ marginLeft: "auto", marginRight: 8 }}>
                                updated {timeAgo(updatedAt)}
                              </span>
                            )}
                            <button type="button" className="ledger-view" style={updatedAt == null ? { marginLeft: "auto" } : undefined} onClick={() => generate(r.path, true)}>Re-run ↻</button>
                          </>
                        )}
                      </div>
                      {error && <p className="ledger-error">{error}</p>}
                      {out && !report && <pre className="run-transcript">{out}</pre>}
                      {report && (
                        <InsightsReportCard
                          report={report}
                          scanned={scanned}
                          onBuild={r.path === "*" ? undefined : () => { setPendingAnalyze(r.path); window.location.hash = "#/curate"; }}
                          onContribute={r.path === "*" ? undefined : () => {
                            // Navigate instantly with just the project root — Curate runs the
                            // (slow) distill itself with visible progress, so the button never hangs.
                            setPendingPlaybook({ root: r.path });
                            window.location.hash = "#/curate";
                          }}
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

export function InsightsReportCard({ report, scanned, onBuild, onContribute }: { report: InsightsReportView; scanned?: number | null; onBuild?: () => void; onContribute?: () => void | Promise<void> }) {
  const [contributing, setContributing] = useState(false);
  const [contributeError, setContributeError] = useState<string | null>(null);
  const candidateSort = useTableSort(CANDIDATE_COLUMNS);

  const handleContribute = async () => {
    if (!onContribute) return;
    setContributing(true);
    setContributeError(null);
    try {
      await onContribute();
    } catch (e) {
      setContributeError(e instanceof Error ? e.message : "Prepare failed.");
    } finally {
      setContributing(false);
    }
  };

  // Be honest about the cap: the report judges the most-recent sessions, which
  // can be fewer than were scanned (50-session batch bound, or unmissioned ones).
  const judged = report.totals.sessions;
  const capped = scanned != null && scanned > judged;
  // Defensive: tolerate a malformed/older-shape report (e.g. a stale cache entry
  // missing a field) — a missing array must not crash the whole console.
  const byModel = report.by_model ?? [];
  const publishCandidates = report.publish_candidates ?? [];
  const friction = report.friction ?? [];
  const blocks = useMemo(() => insightsToBlocks(report, scanned), [report, scanned]);
  const markdown = useMemo(() => blocksToMarkdown(blocks), [blocks]);
  const html = useMemo(() => blocksToHtml(blocks, "AgentGem Insights"), [blocks]);
  const json = useMemo(() => JSON.stringify(report, null, 2), [report]);
  return (
    <div className="insights-report">
      <ReportActions title="AgentGem Insights" filename="agentgem-insights" markdown={markdown} json={json} html={html} />
      {report.narrative && <p className="insights-narrative">{report.narrative}</p>}
      <p className="analyze-candidate-desc">{report.outcomes_summary}</p>
      {capped && <p className="insights-hint">Based on the {judged} most-recent of {scanned} sessions scanned.</p>}

      <OutcomesDonut totals={report.totals} />

      {byModel.length > 1 && (
        <div className="insights-section">
          <h4>By model</h4>
          <ByModelBars byModel={byModel} />
          <ul className="insights-bymodel">
            {byModel.map((m) => (
              <li key={m.model}>
                <span className="analyze-include-name">{m.model}</span>
                <span className="insights-rate">{Math.round((m.mostly / m.total) * 100)}% mostly</span>
                <span className="targets-label">{m.total} session{m.total === 1 ? "" : "s"}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {publishCandidates.length > 0 && (
        <div className="insights-section">
          <div className="analyze-candidate-head">
            <h4 style={{ margin: 0 }}>Worth publishing</h4>
            {onBuild && <button type="button" className="ledger-build" style={{ marginLeft: "auto" }} onClick={onBuild}>Build a Gem from this project →</button>}
            {onContribute && <button type="button" className="ledger-build" disabled={contributing} onClick={handleContribute}>{contributing ? "Preparing…" : "Publish"}</button>}
          </div>
          {contributeError && <p className="ledger-error">{contributeError}</p>}
          <table className="obs-table insights-candidates">
            <thead><tr>
              <SortTh label="goal" dir={candidateSort.dirFor("goal")} onClick={() => candidateSort.onSort("goal")} />
              <SortTh label="why" dir={candidateSort.dirFor("why")} onClick={() => candidateSort.onSort("why")} />
            </tr></thead>
            <tbody>
              {candidateSort.sort(publishCandidates).map((c) => (
                <tr key={c.sessionId}>
                  <td className="analyze-include-name">{c.goal}</td>
                  <td className="targets-label">{c.why}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {friction.length > 0 && (
        <div className="insights-section">
          <h4>Friction</h4>
          <ul className="analyze-include">
            {friction.map((f) => (
              <li key={f.sessionId}><span className="analyze-include-name">{f.detail}</span></li>
            ))}
          </ul>
        </div>
      )}

      {publishCandidates.length === 0 && friction.length === 0 && (
        <p className="ledger-empty">No standout sessions yet — keep working and re-run.</p>
      )}
    </div>
  );
}

export const insightsPage = defineConsolePage({
  id: "insights", title: "Insights", icon: "📊", order: 10, phase: "observe", category: "usage",
  route: "#/insights", component: Insights,
});
