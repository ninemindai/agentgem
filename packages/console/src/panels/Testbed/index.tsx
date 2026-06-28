import { useEffect, useRef, useState } from "react";
import { defineConsolePage } from "../../registry.js";
import {
  testbedRecentsRoute, testbedProjectsRoute, testbedScaffoldRoute,
  makeClient, type RecentEntry, type ProjectCandidate,
} from "../../api/routes.js";
import { openAnalyzeStream, type AnalyzeCandidate } from "./analyzeStream.js";
import { includeToKeys } from "../Curate/selection.js";
import { setRecommendedSelection } from "../../recommendation.js";

function short(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts.length > 3 ? "…/" + parts.slice(-3).join("/") : path;
}

export function Testbed({ apiBase }: { apiBase: string }) {
  const [recents, setRecents] = useState<RecentEntry[] | null>(null);
  const [projects, setProjects] = useState<ProjectCandidate[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [root, setRoot] = useState("");
  const [note, setNote] = useState<string | null>(null);

  const [analyzeRoot, setAnalyzeRoot] = useState("");
  const [phase, setPhase] = useState<string>("");
  const [analyzeOut, setAnalyzeOut] = useState("");
  const [analyzing, setAnalyzing] = useState(false);
  const [analyzeError, setAnalyzeError] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<AnalyzeCandidate[]>([]);
  const closeRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const client = makeClient(apiBase);
    testbedRecentsRoute.call(client).then((r) => setRecents(r.recents)).catch((e) => setError(String(e)));
    testbedProjectsRoute.call(client).then((r) => setProjects(r.projects)).catch(() => setProjects([]));
    return () => closeRef.current?.();
  }, [apiBase]);

  const analyze = (fresh: boolean) => {
    if (!analyzeRoot.trim()) return;
    closeRef.current?.();
    setAnalyzing(true);
    setPhase("");
    setAnalyzeOut("");
    setAnalyzeError(null);
    setCandidates([]);
    closeRef.current = openAnalyzeStream(apiBase, analyzeRoot.trim(), fresh, (e) => {
      if (e.type === "phase") setPhase(e.sessions != null ? `${e.phase} (${e.sessions} sessions)` : e.phase);
      else if (e.type === "delta") setAnalyzeOut((o) => o + e.text);
      else if (e.type === "done") { setPhase("done"); setAnalyzing(false); setCandidates(e.candidates); }
      else if (e.type === "failed") { setAnalyzeError(e.message); setAnalyzing(false); }
    });
  };

  // Hand the chosen candidate's artifacts to the Ledger (pre-selected) and jump there.
  const useCandidate = (c: AnalyzeCandidate) => {
    setRecommendedSelection(includeToKeys(c.include));
    window.location.hash = "#/curate";
  };

  const scaffold = async () => {
    setNote(null);
    setError(null);
    try {
      const r = await testbedScaffoldRoute.call(makeClient(apiBase), { body: { root: root.trim(), name: name.trim() } });
      setNote(`created testbed at ${r.root} (${r.created.length} files)`);
      setName("");
      setRoot("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="testbed">
      <section className="ledger-group">
        <h2 className="ledger-group-label">Create / open a testbed</h2>
        <div className="ledger-bar">
          <input className="ledger-search" aria-label="testbed name" placeholder="name" value={name} onChange={(e) => setName(e.target.value)} />
          <input className="ledger-search" aria-label="testbed root" placeholder="/path/to/dir" value={root} onChange={(e) => setRoot(e.target.value)} />
          <button type="button" className="ledger-build" disabled={!name.trim() || !root.trim()} onClick={scaffold}>Create</button>
        </div>
        {note && <p className="ws-note">{note}</p>}
        {error && <p className="ledger-error">{error}</p>}
      </section>

      <section className="ledger-group">
        <h2 className="ledger-group-label">Analyze sessions → suggest a gem</h2>
        <div className="ledger-bar">
          <input className="ledger-search" aria-label="analyze root" placeholder="/path/to/project (or click one below)" value={analyzeRoot} onChange={(e) => setAnalyzeRoot(e.target.value)} />
          <button type="button" className="ledger-build" disabled={analyzing || !analyzeRoot.trim()} onClick={() => analyze(false)}>{analyzing ? "Analyzing…" : "Analyze"}</button>
          <button type="button" className="ledger-sort" disabled={analyzing || !analyzeRoot.trim()} onClick={() => analyze(true)}>Re-analyze</button>
        </div>
        {(phase || analyzeOut || analyzeError) && (
          <div className="run-out">
            <div className="run-status">
              {phase && <span className={"run-badge " + (phase === "done" ? "run-done" : "run-running")}>{phase}</span>}
            </div>
            {analyzeError && <p className="ledger-error">{analyzeError}</p>}
            {analyzeOut && <pre className="run-transcript">{analyzeOut}</pre>}
          </div>
        )}
        {candidates.length > 0 && (
          <div className="ws-list" style={{ marginTop: 14 }}>
            {candidates.map((c) => (
              <article className="ws-card" key={c.name}>
                <header className="ws-head">
                  <span className="ws-name">{c.name}</span>
                  <span className="ws-chip">{c.confidence}</span>
                </header>
                {c.description && <p className="getgems-desc">{c.description}</p>}
                <div className="ws-actions">
                  <span className="targets-label">{c.include.length} artifacts</span>
                  <button type="button" className="ledger-build" onClick={() => useCandidate(c)}>Use this selection →</button>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      <section className="ledger-group">
        <h2 className="ledger-group-label">Recent testbeds</h2>
        {!recents ? <p className="ledger-loading">Loading…</p>
          : recents.length === 0 ? <p className="ledger-empty">No recent testbeds.</p>
          : (
            <div className="ws-list">
              {recents.map((r) => (
                <article className="ws-card" key={r.path}>
                  <header className="ws-head">
                    <span className="ws-name">{r.name}</span>
                    <span className="ws-gem">{r.flavor}</span>
                  </header>
                  <p className="tb-path">{short(r.path)}{!r.exists && <span className="tb-missing"> (missing)</span>}</p>
                </article>
              ))}
            </div>
          )}
      </section>

      <section className="ledger-group">
        <h2 className="ledger-group-label">Discovered projects {projects ? `(${projects.length})` : ""}</h2>
        {!projects ? <p className="ledger-loading">Loading…</p>
          : projects.length === 0 ? <p className="ledger-empty">No project candidates found.</p>
          : (
            <div className="ws-list">
              {projects.slice(0, 40).map((p) => (
                <article className="ws-card tb-clickable" key={p.path} onClick={() => setAnalyzeRoot(p.path)} title="use as analyze root">
                  <p className="tb-path">{short(p.path)} <span className="ws-chip">{p.flavor}</span></p>
                </article>
              ))}
            </div>
          )}
      </section>
    </div>
  );
}

export const testbedPage = defineConsolePage({
  id: "testbed",
  title: "Testbed",
  icon: "✛",
  order: 5,
  group: "build",
  route: "#/testbed",
  component: ({ apiBase }) => <Testbed apiBase={apiBase} />,
});
