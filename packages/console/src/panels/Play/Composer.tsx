// packages/console/src/panels/Play/Composer.tsx
import { useEffect, useState } from "react";
import { makeClient, playStudioRoute, testbedProjectsRoute } from "../../api/routes.js";

type Proj = { path: string; flavor: string; exists: boolean };

// v1 seeds from a project source (the backend accepts session/skill too — additive later).
export function Composer({ apiBase, onCreated }: { apiBase: string; onCreated: (name: string) => void }) {
  const [projects, setProjects] = useState<Proj[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    testbedProjectsRoute.call(makeClient(apiBase)).then((r) => setProjects(r.projects)).catch(() => setProjects([]));
  }, [apiBase]);

  async function pick(p: Proj) {
    if (busy) return;
    setBusy(true); setError("");
    try {
      const res = await playStudioRoute.call(makeClient(apiBase), { body: { source: { kind: "project", path: p.path, flavor: p.flavor } } });
      onCreated(res.name);
    } catch (e) { setError((e as Error).message); setBusy(false); }
  }

  return (
    <section className="analyze">
      <p className="analyze-intro">Create a miniapp from a project — the agent seeds it and opens the studio.</p>
      {error && <p className="ledger-error">{error}</p>}
      {!projects ? <p className="ledger-view">Loading projects…</p> :
        <ul className="analyze-list">
          {projects.map((p) => (
            <li key={p.path} className="analyze-row" style={{ cursor: "pointer" }} onClick={() => pick(p)}>
              <span>{p.path}</span> <span style={{ opacity: 0.6, fontSize: 12 }}>{p.flavor}</span>
            </li>
          ))}
        </ul>}
      {busy && <p className="run-status">Seeding studio…</p>}
    </section>
  );
}
