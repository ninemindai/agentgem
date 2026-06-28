import { useEffect, useRef, useState } from "react";
import { testbedRecentsRoute, testbedProjectsRoute, makeClient, type RecentEntry, type ProjectCandidate } from "../../api/routes.js";
import { openAnalyzeStream, type AnalyzeCandidate } from "./analyzeStream.js";
import { includeToKeys } from "./selection.js";

function short(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts.length > 3 ? "…/" + parts.slice(-3).join("/") : path;
}

/** "Suggest a gem from a project": discovered projects, each analyzed in one click;
 *  picking a suggestion hands recommended keys to onPick (Curate flips to Compose). */
export function Analyze({ apiBase, onPick }: { apiBase: string; onPick: (keys: string[]) => void }) {
  const [projects, setProjects] = useState<ProjectCandidate[] | null>(null);
  const [recents, setRecents] = useState<RecentEntry[] | null>(null);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [phase, setPhase] = useState("");
  const [candidates, setCandidates] = useState<AnalyzeCandidate[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [running, setRunning] = useState(false);
  const [out, setOut] = useState("");
  const closeRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const client = makeClient(apiBase);
    testbedProjectsRoute.call(client).then((r) => setProjects(r.projects)).catch(() => setProjects([]));
    testbedRecentsRoute.call(client).then((r) => setRecents(r.recents)).catch(() => setRecents([]));
  }, [apiBase]);
  useEffect(() => () => closeRef.current?.(), []);

  const analyze = (path: string) => {
    closeRef.current?.();
    setActivePath(path); setPhase(""); setCandidates([]); setError(null); setOut(""); setRunning(true);
    closeRef.current = openAnalyzeStream(apiBase, path, false, (e) => {
      if (e.type === "phase") setPhase(e.sessions != null ? `${e.phase} (${e.sessions} sessions)` : e.phase);
      else if (e.type === "delta") setOut((o) => o + e.text);
      else if (e.type === "done") { setPhase("done"); setCandidates(e.candidates); setRunning(false); }
      else if (e.type === "failed") { setError(e.message); setRunning(false); }
    });
  };

  // Merge recents + discovered projects into one de-duped, compact list, then
  // filter by the search query (matches the display label OR the full path).
  const rows = (() => {
    const seen = new Set<string>();
    const out: { path: string; flavor: string; label: string }[] = [];
    for (const r of recents ?? []) { if (!seen.has(r.path)) { seen.add(r.path); out.push({ path: r.path, flavor: r.flavor, label: r.name }); } }
    for (const p of projects ?? []) { if (!seen.has(p.path)) { seen.add(p.path); out.push({ path: p.path, flavor: p.flavor, label: short(p.path) }); } }
    const q = query.trim().toLowerCase();
    const matched = q ? out.filter((r) => r.label.toLowerCase().includes(q) || r.path.toLowerCase().includes(q)) : out;
    return matched.slice(0, 40);
  })();

  return (
    <section className="analyze">
      <p className="analyze-intro">Pick a project — agentgem reads its sessions and suggests the artifacts that did the work.</p>
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
      {!projects && !recents ? <p className="ledger-loading">Loading…</p>
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
                      onClick={() => analyze(r.path)}
                    >{active && running ? "Analyzing…" : "Analyze →"}</button>
                  </div>
                  {active && (
                    <div className="run-out analyze-status">
                      <div className="run-status">
                        <span className={"run-badge " + (error ? "run-failed" : running ? "run-running" : "run-done")}>
                          {error ? "failed" : phase || (running ? "Analyzing…" : "done")}
                        </span>
                      </div>
                      {error && <p className="ledger-error">{error}</p>}
                      {out && <pre className="run-transcript">{out}</pre>}
                      {!running && !error && phase === "done" && candidates.length === 0 && (
                        <p className="ledger-empty">No recurring workflow found in this project's sessions — nothing to suggest yet.</p>
                      )}
                      {candidates.map((c) => (
                        <div className="analyze-candidate" key={c.name}>
                          <strong>{c.name}</strong> <span className="ws-chip">{c.confidence}</span>{" "}
                          <span className="targets-label">{c.include.length} artifacts</span>{" "}
                          <button type="button" className="ledger-build" onClick={() => onPick(includeToKeys(c.include))}>Use this selection →</button>
                        </div>
                      ))}
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
