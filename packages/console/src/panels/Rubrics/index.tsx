import { useEffect, useRef, useState } from "react";
import { testbedRecentsRoute, testbedProjectsRoute, rubricsRoute, makeClient, type RecentEntry, type ProjectCandidate, type RubricSummary } from "../../api/routes.js";
import { defineConsolePage } from "../../registry.js";
import { openRubricStream, type RubricReportView, type RubricFactorView } from "./rubricStream.js";
import { consumePendingRubric } from "../../pendingAnalyze.js";
import { Loading } from "../../shell/Loading.js";
import { timeAgo } from "../../util/timeAgo.js";

function short(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts.length > 3 ? "…/" + parts.slice(-3).join("/") : path;
}

// A rubric with inline criteria uses the (Phase 2) LLM path; otherwise it is cheap.
function isCheap(r: RubricSummary): boolean {
  return !r.criteria || r.criteria.length === 0;
}

function FactorRow({ f }: { f: RubricFactorView }) {
  const fired = f.count > 0;
  const icon = !fired ? "✓" : f.severity === "warn" ? "⚠" : "ℹ";
  const cls = !fired ? "rub-ok" : f.severity === "warn" ? "rub-warn" : "rub-info";
  return (
    <li className={"rub-factor " + cls}>
      <div className="rub-factor-head">
        <span className="rub-icon" aria-hidden="true">{icon}</span>
        <span className="analyze-include-name">{f.title}</span>
        <span className="targets-label" style={{ marginLeft: "auto" }}>
          {fired ? `${f.count} in ${f.sessions} session${f.sessions === 1 ? "" : "s"}` : "no findings"}
        </span>
      </div>
      {fired && <p className="rub-advice">→ {f.advice}</p>}
    </li>
  );
}

function RubricReportCard({ report }: { report: RubricReportView }) {
  const total = report.factors.length;
  const actionable = report.factors.filter((f) => f.count > 0).length;
  const affected = report.perSession?.length ?? 0;
  return (
    <div className="insights-report">
      {/* Verdict line — advice-first: what needs action, not a score. */}
      <p className="rub-verdict">
        <strong>{report.rubricId}</strong> · {report.scope} · {report.sessionsScanned} session{report.sessionsScanned === 1 ? "" : "s"} ·{" "}
        {report.clean
          ? <span className="rub-clean">clean — all {total} check{total === 1 ? "" : "s"} passed</span>
          : <span className="rub-needs">{actionable} of {total} check{total === 1 ? "" : "s"} need action</span>}
      </p>
      {report.degraded && (
        <p className="insights-hint">Some LLM criteria were skipped — the local agent was unavailable. Cheap-factor results are shown.</p>
      )}

      <ul className="rub-factors">
        {report.factors.map((f) => <FactorRow key={f.id} f={f} />)}
      </ul>

      {affected > 0 && (
        <p className="insights-hint">
          {affected} session{affected === 1 ? "" : "s"} tripped a factor{report.perSessionTruncated ? " (showing the first 200)" : ""}.
        </p>
      )}
      {report.skippedFactors.length > 0 && (
        <p className="ledger-muted">
          Skipped: {report.skippedFactors.map((s) => `${s.factor} (${s.reason === "llm-phase2" ? "LLM — Phase 2" : "unknown"})`).join(", ")}
        </p>
      )}
    </div>
  );
}

/** Rubrics report panel: pick a lens + a scope, run its cheap factors over your
 *  sessions, and read the findings advice-first. */
export function Rubrics({ apiBase }: { apiBase: string }) {
  const [rubrics, setRubrics] = useState<RubricSummary[] | null>(null);
  const [rubricId, setRubricId] = useState<string>("");
  const [projects, setProjects] = useState<ProjectCandidate[] | null>(null);
  const [recents, setRecents] = useState<RecentEntry[] | null>(null);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [phase, setPhase] = useState("");
  const [out, setOut] = useState("");
  const [report, setReport] = useState<RubricReportView | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [running, setRunning] = useState(false);
  const closeRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const client = makeClient(apiBase);
    rubricsRoute.call(client).then((r) => {
      setRubrics(r.rubrics);
      const pending = consumePendingRubric();
      setRubricId(pending && r.rubrics.some((x) => x.id === pending) ? pending : (r.rubrics[0]?.id ?? ""));
    }).catch(() => setRubrics([]));
    testbedProjectsRoute.call(client).then((r) => setProjects(r.projects)).catch(() => setProjects([]));
    testbedRecentsRoute.call(client).then((r) => setRecents(r.recents)).catch(() => setRecents([]));
  }, [apiBase]);
  useEffect(() => () => closeRef.current?.(), []);

  const run = (path: string, fresh = false) => {
    if (!rubricId) return;
    closeRef.current?.();
    setActivePath(path); setPhase(""); setOut(""); setReport(null); setUpdatedAt(null); setError(null); setRunning(true);
    const scope = path === "*" ? { rubric: rubricId, scope: "all" as const } : { rubric: rubricId, scope: "project" as const, root: path };
    closeRef.current = openRubricStream(apiBase, scope, (e) => {
      if (e.type === "start") setPhase("evaluating");
      else if (e.type === "delta") setOut((o) => o + e.text);
      else if (e.type === "done") { setPhase("done"); setReport(e.report); setUpdatedAt(e.updatedAt); setRunning(false); }
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
    return [{ path: "*", flavor: "all", label: "All projects" }, ...matched.slice(0, 40)];
  })();

  const selected = rubrics?.find((r) => r.id === rubricId);

  return (
    <section className="analyze">
      <p className="analyze-intro">Pick a rubric — a named lens of checks — then a scope. agentgem runs its factors over your sessions and shows what needs action, worst-first.</p>

      <div className="rub-picker">
        <label className="rub-picker-label" htmlFor="rubric-select">Rubric</label>
        <select id="rubric-select" className="ledger-search" value={rubricId} onChange={(e) => setRubricId(e.target.value)} disabled={!rubrics || rubrics.length === 0} style={{ maxWidth: 320 }}>
          {(rubrics ?? []).map((r) => (
            <option key={r.id} value={r.id}>{r.title} — {r.factors.length} factor{r.factors.length === 1 ? "" : "s"} · {isCheap(r) ? "cheap" : "LLM"}</option>
          ))}
        </select>
        {selected?.naturalScope && <span className="ws-chip" title="The scope this rubric is designed for">best at: {selected.naturalScope}</span>}
      </div>

      {(projects || recents) && (
        <input className="ledger-search" type="text" placeholder="search projects…" aria-label="search projects" value={query} onChange={(e) => setQuery(e.target.value)} style={{ margin: "12px 0" }} />
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
                    <button type="button" className="ledger-view" disabled={running || !rubricId} onClick={() => run(r.path)}>
                      {active && running ? "Evaluating…" : "Run rubric →"}
                    </button>
                  </div>
                  {active && (
                    <div className="run-out analyze-status">
                      <div className="run-status">
                        <span className={"run-badge " + (error ? "run-failed" : running ? "run-running" : "run-done")}>
                          {error ? "failed" : phase || (running ? "Evaluating…" : "done")}
                        </span>
                        {report && !running && (
                          <>
                            {updatedAt != null && <span className="ledger-muted" style={{ marginLeft: "auto", marginRight: 8 }}>updated {timeAgo(updatedAt)}</span>}
                            <button type="button" className="ledger-view" style={updatedAt == null ? { marginLeft: "auto" } : undefined} onClick={() => run(r.path, true)}>Re-run ↻</button>
                          </>
                        )}
                      </div>
                      {error && <p className="ledger-error">{error}</p>}
                      {out && !report && <pre className="run-transcript">{out}</pre>}
                      {report && <RubricReportCard report={report} />}
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

export const rubricsPage = defineConsolePage({
  id: "rubrics", title: "Rubrics", icon: "📋", order: 10, group: "observe",
  route: "#/rubrics", component: Rubrics,
});
