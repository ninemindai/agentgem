import { useCallback, useEffect, useRef, useState } from "react";
import { testbedRecentsRoute, testbedProjectsRoute, rubricsRoute, makeClient, type RecentEntry, type ProjectCandidate, type RubricSummary } from "../../api/routes.js";
import { defineConsolePage } from "../../registry.js";
import { openRubricStream, openRubricReportStream, type RubricReportView, type RubricFactorView, type RubricScopeParams } from "./rubricStream.js";
import { HygieneLeaderboard } from "./HygieneLeaderboard.js";
import { SessionPicker, type PickedSession } from "../_shared/SessionPicker.js";
import { consumePendingRubricRun, type PendingRubricRun } from "../../pendingAnalyze.js";
import { Loading } from "../../shell/Loading.js";
import { timeAgo } from "../../util/timeAgo.js";
import { useReportRun, type Handlers } from "../../report/useReportRun.js";

type RubricDone = { report: RubricReportView; cached: boolean; updatedAt: number | null };

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

export function RubricReportCard({ report }: { report: RubricReportView }) {
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
      {report.hygiene && (
        <p className={"hyg-verdict is-" + report.hygiene.verdict}>
          <span className="hyg-word">{report.hygiene.verdict}</span> <span className="hyg-score">{report.hygiene.score}</span>
        </p>
      )}
      {report.degraded && (
        <p className="insights-hint">Some LLM criteria were skipped — the local agent was unavailable. Cheap-factor results are shown.</p>
      )}

      <ul className="rub-factors">
        {report.factors.map((f) => <FactorRow key={f.id} f={f} />)}
      </ul>

      {affected > 0 && (
        report.perSession!.some((s) => s.hygiene)
          ? <HygieneLeaderboard perSession={report.perSession!} sessionsScanned={report.sessionsScanned} truncated={!!report.perSessionTruncated} />
          : <p className="insights-hint">
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
  const [query, setQuery] = useState("");
  // A session target injected by a shortcut deep-link (or a reattached session run).
  // Sessions aren't in the project rows, so the target gets its own synthetic row;
  // its path key is "session:<id>". Root is never held client-side — the stream
  // route derives it from the session's own transcript.
  const [sessionRow, setSessionRow] = useState<{ sessionId: string; label: string } | null>(null);

  // openStream adapter: the hook decides WHEN to open; this maps openRubricStream's
  // events to the normalized Handlers and reconstructs RubricScopeParams from params.
  const openStream = useCallback(
    (fresh: boolean, params: Record<string, string>, h: Handlers<RubricDone>) => {
      const scope: RubricScopeParams = {
        rubric: params.rubric,
        scope: params.scope as RubricScopeParams["scope"],
        root: params.root,
        sessionId: params.sessionId,
      };
      return openRubricStream(makeClient(apiBase), scope, (e) => {
        if (e.type === "start") h.phase("evaluating");
        else if (e.type === "delta") h.delta(e.text);
        else if (e.type === "done") h.done({ report: e.report, cached: e.cached, updatedAt: e.updatedAt });
        else if (e.type === "failed") h.failed(e.message);
      }, fresh);
    },
    [apiBase],
  );
  const { view, start } = useReportRun<RubricDone>(apiBase, "rubric", openStream);

  // Guards the default-first-rubric fallback below against a reattached run or a
  // pending deep-link claiming the selection first — whichever resolves first,
  // in either order (the two effects race on mount). A ref (not a state closure)
  // so the fallback always reads the live claim, not a stale value captured when
  // the effect was set up.
  const claimedRef = useRef(false);

  // Open the stream for one (rubric, scope) — shared by row clicks and the
  // shortcut deep-link, which must not depend on the async rubricId state.
  const startRun = (rubric: string, path: string, scope: { scope: "all" | "project" | "session"; root?: string; sessionId?: string }, fresh = false) => {
    setActivePath(path);
    const key = `${rubric}:${scope.scope}:${scope.root ?? ""}:${scope.sessionId ?? ""}`;
    const params: Record<string, string> = { rubric, scope: scope.scope };
    if (scope.root) params.root = scope.root;
    if (scope.sessionId) params.sessionId = scope.sessionId;
    start(key, params, fresh);
  };

  // A shortcut deep-link (PendingRubricRun with autorun): inject the session row
  // if needed, then start immediately with the pending rubric — rubricId state
  // hasn't committed yet when this fires.
  const autorunPending = (p: PendingRubricRun) => {
    if (p.scope === "session" && p.sessionId) {
      setSessionRow({ sessionId: p.sessionId, label: p.label ?? `session ${p.sessionId}` });
      startRun(p.rubric, "session:" + p.sessionId, { scope: "session", sessionId: p.sessionId });
    } else if (p.scope === "project" && p.root) {
      startRun(p.rubric, p.root, { scope: "project", root: p.root });
    } else if (p.scope === "all") {
      startRun(p.rubric, "*", { scope: "all" });
    }
  };

  useEffect(() => {
    const client = makeClient(apiBase);
    rubricsRoute.call(client).then((r) => {
      setRubrics(r.rubrics);
      const pending = consumePendingRubricRun();
      // Priority: an explicit deep-link (pending) claims the selection; otherwise the
      // default-first fallback applies ONLY if a reattach hasn't already claimed one.
      if (pending && r.rubrics.some((x) => x.id === pending.rubric)) {
        claimedRef.current = true;
        setRubricId(pending.rubric);
        if (pending.autorun) autorunPending(pending);
      } else if (!claimedRef.current) {
        setRubricId(r.rubrics[0]?.id ?? "");
      }
    }).catch(() => setRubrics([]));
    testbedProjectsRoute.call(client).then((r) => setProjects(r.projects)).catch(() => setProjects([]));
    testbedRecentsRoute.call(client).then((r) => setRecents(r.recents)).catch(() => setRecents([]));
  }, [apiBase]);
  // Reattached a run on mount → select its rubric + row (a session run injects
  // its synthetic row so the output has a place to render).
  useEffect(() => {
    const p = view.params;
    if (!p || activePath) return;
    if (p.rubric && !claimedRef.current) { claimedRef.current = true; setRubricId(p.rubric); }
    const sid = p.sessionId;
    if (p.scope === "session" && sid) {
      setSessionRow((s) => s ?? { sessionId: sid, label: `session ${sid}` });
      setActivePath("session:" + sid);
    } else if (p.scope === "all") setActivePath("*");
    else if (p.root) setActivePath(p.root);
  }, [view.params, activePath]);

  // Map a row path to its stream scope params (shared by evaluate + report).
  const scopeFor = (path: string): { scope: "all" | "project" | "session"; root?: string; sessionId?: string } =>
    path.startsWith("session:") ? { scope: "session", sessionId: path.slice("session:".length) }
      : path === "*" ? { scope: "all" }
      : { scope: "project", root: path };

  const run = (path: string, fresh = false) => {
    if (!rubricId) return;
    startRun(rubricId, path, scopeFor(path), fresh);
  };

  // "Generate report": render the (cached) evaluation into a self-contained HTML
  // document via the server's plan-mode agent, then download it. One at a time.
  // Report rendering drives a local coding agent, which can run up to ~3 min (and time out).
  // Track elapsed + streamed chars so "Generating…" shows real progress instead of an opaque wait.
  const [reportGen, setReportGen] = useState<{
    status: "idle" | "running" | "done" | "failed";
    error?: string;
    startedAt?: number;
    chars?: number;
  }>({ status: "idle" });
  // A once-a-second tick that re-renders the elapsed counter while a report is generating.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (reportGen.status !== "running") return;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [reportGen.status]);

  const generateReport = (path: string) => {
    if (!rubricId || reportGen.status === "running") return;
    setReportGen({ status: "running", startedAt: Date.now(), chars: 0 });
    openRubricReportStream(makeClient(apiBase), { rubric: rubricId, ...scopeFor(path) }, (e) => {
      if (e.type === "delta") {
        // The agent streams the HTML as it renders — surface it as a "chars streamed" liveness signal.
        setReportGen((g) => (g.status === "running" ? { ...g, chars: (g.chars ?? 0) + e.text.length } : g));
      } else if (e.type === "done") {
        const a = document.createElement("a");
        a.href = URL.createObjectURL(new Blob([e.html], { type: "text/html" }));
        a.download = `${rubricId}-report.html`;
        a.click();
        setReportGen({ status: "done" });
      } else if (e.type === "failed") {
        setReportGen({ status: "failed", error: e.message });
      }
    });
  };
  const reportElapsed = reportGen.startedAt ? Math.floor((Date.now() - reportGen.startedAt) / 1000) : 0;

  const selected = rubrics?.find((r) => r.id === rubricId);
  // Whether this rubric may run at "session" scope — the hard rule the server
  // enforces via scopeAllowed (session needs a session-granular rubric). Trust the
  // server-computed `granularity`; fall back to the naturalScope hint only for an
  // older server that predates the field.
  const sessionCapable = selected ? (selected.granularity ? selected.granularity === "session" : selected.naturalScope === "session") : false;

  const rows = (() => {
    const seen = new Set<string>();
    const acc: { path: string; flavor: string; label: string }[] = [];
    for (const r of recents ?? []) { if (!seen.has(r.path)) { seen.add(r.path); acc.push({ path: r.path, flavor: r.flavor, label: r.name }); } }
    for (const p of projects ?? []) { if (!seen.has(p.path)) { seen.add(p.path); acc.push({ path: p.path, flavor: p.flavor, label: short(p.path) }); } }
    const q = query.trim().toLowerCase();
    const matched = q ? acc.filter((r) => r.label.toLowerCase().includes(q) || r.path.toLowerCase().includes(q)) : acc;
    return [
      // The picked/deep-linked/reattached session leads the list — it's an actual
      // run target, so it stays pinned across rubric switches (exactly like a
      // project row does; nothing resets the active row on rubricId change). Only
      // the session PICKER above is gated by granularity — the row itself is not,
      // so a legit session deep-link isn't hidden before its rubric is classified.
      ...(sessionRow ? [{ path: "session:" + sessionRow.sessionId, flavor: "session", label: sessionRow.label }] : []),
      { path: "*", flavor: "all", label: "All projects" },
      ...matched.slice(0, 40),
    ];
  })();

  // Picking a session runs it straight away (like the deep-link autorun) and pins
  // its synthetic row so the output has somewhere to render.
  const onPickSession = (s: PickedSession) => {
    setSessionRow(s);
    startRun(rubricId, "session:" + s.sessionId, { scope: "session", sessionId: s.sessionId });
  };

  const running = view.status === "running";
  const report = view.report?.report ?? null;
  const updatedAt = view.report?.updatedAt ?? null;
  const phase = view.phase;
  const error = view.error;
  const out = view.deltas;

  return (
    <section className="analyze">
      <div className="obs-head"><h2 className="obs-title">Rubrics</h2></div>
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

      {/* Session-granular rubrics can run against one session; pick it here. They can
          also aggregate over a project or the corpus, so the row list below stays. */}
      {sessionCapable && (
        <div className="rub-picker">
          <label className="rub-picker-label">Session</label>
          <SessionPicker
            apiBase={apiBase}
            selectedId={sessionRow?.sessionId ?? null}
            selectedLabel={sessionRow?.label ?? null}
            onPick={onPickSession}
          />
          <span className="ledger-muted">— or run a whole project / the corpus below</span>
        </div>
      )}

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
                            <button
                              type="button"
                              className="ledger-view"
                              style={{ marginLeft: 8 }}
                              disabled={reportGen.status === "running"}
                              title="Render this evaluation into a self-contained HTML report (local agent) and download it"
                              onClick={() => generateReport(r.path)}
                            >
                              {reportGen.status === "running" ? `Generating… ${reportElapsed}s` : "Generate report ⤓"}
                            </button>
                          </>
                        )}
                      </div>
                      {reportGen.status === "running" && (
                        <p className="ledger-muted">
                          Rendering with the local coding agent{reportGen.chars ? ` · ${reportGen.chars.toLocaleString()} chars` : ""} — this can take up to ~3 min.
                        </p>
                      )}
                      {reportGen.status === "failed" && (
                        <p className="ledger-error">Report render failed — {reportGen.error}</p>
                      )}
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
  id: "rubrics", title: "Rubrics", icon: "📋", order: 20, phase: "observe", category: "setup",
  route: "#/rubrics", component: Rubrics,
});
