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
  const closeRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const client = makeClient(apiBase);
    testbedProjectsRoute.call(client).then((r) => setProjects(r.projects)).catch(() => setProjects([]));
    testbedRecentsRoute.call(client).then((r) => setRecents(r.recents)).catch(() => setRecents([]));
  }, [apiBase]);
  useEffect(() => () => closeRef.current?.(), []);

  const analyze = (path: string) => {
    closeRef.current?.();
    setActivePath(path); setPhase(""); setCandidates([]); setError(null);
    closeRef.current = openAnalyzeStream(apiBase, path, false, (e) => {
      if (e.type === "phase") setPhase(e.sessions != null ? `${e.phase} (${e.sessions} sessions)` : e.phase);
      else if (e.type === "done") { setPhase("done"); setCandidates(e.candidates); }
      else if (e.type === "failed") { setError(e.message); }
    });
  };

  // Merge recents + discovered projects into one de-duped, compact list.
  const rows = (() => {
    const seen = new Set<string>();
    const out: { path: string; flavor: string; label: string }[] = [];
    for (const r of recents ?? []) { if (!seen.has(r.path)) { seen.add(r.path); out.push({ path: r.path, flavor: r.flavor, label: r.name }); } }
    for (const p of projects ?? []) { if (!seen.has(p.path)) { seen.add(p.path); out.push({ path: p.path, flavor: p.flavor, label: short(p.path) }); } }
    return out.slice(0, 40);
  })();

  return (
    <section className="analyze">
      <p className="analyze-intro">Pick a project — agentgem reads its sessions and suggests the artifacts that did the work.</p>
      {!projects && !recents ? <p className="ledger-loading">Loading…</p>
        : rows.length === 0 ? <p className="ledger-empty">No projects with session history found.</p>
        : (
          <ul className="analyze-list">
            {rows.map((r) => (
              <li className="analyze-row" key={r.path}>
                <span className="analyze-name">{r.label}</span>
                <span className="ws-chip">{r.flavor}</span>
                <button type="button" className="ledger-view" onClick={() => analyze(r.path)}>Analyze →</button>
              </li>
            ))}
          </ul>
        )}
      {activePath && (
        <div className="run-out">
          <div className="run-status">
            {phase && <span className={"run-badge " + (phase === "done" ? "run-done" : "run-running")}>{phase}</span>}
            <span className="run-phase">{short(activePath)}</span>
          </div>
          {error && <p className="ledger-error">{error}</p>}
          {candidates.map((c) => (
            <div className="analyze-candidate" key={c.name}>
              <strong>{c.name}</strong> <span className="ws-chip">{c.confidence}</span>{" "}
              <span className="targets-label">{c.include.length} artifacts</span>{" "}
              <button type="button" className="ledger-build" onClick={() => onPick(includeToKeys(c.include))}>Use this selection →</button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
