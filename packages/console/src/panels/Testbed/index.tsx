import { useEffect, useState } from "react";
import { defineConsolePage } from "../../registry.js";
import {
  testbedRecentsRoute, testbedProjectsRoute, testbedScaffoldRoute,
  makeClient, type RecentEntry, type ProjectCandidate,
} from "../../api/routes.js";

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

  useEffect(() => {
    const client = makeClient(apiBase);
    testbedRecentsRoute.call(client).then((r) => setRecents(r.recents)).catch((e) => setError(String(e)));
    testbedProjectsRoute.call(client).then((r) => setProjects(r.projects)).catch(() => setProjects([]));
  }, [apiBase]);

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
                <article className="ws-card" key={p.path}>
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
  route: "#/testbed",
  component: ({ apiBase }) => <Testbed apiBase={apiBase} />,
});
