// packages/console/src/panels/Play/Composer.tsx
import { useEffect, useState } from "react";
import { makeClient, playStudioRoute, testbedProjectsRoute, inventoryRoute } from "../../api/routes.js";
import { fetchSessions, type WatchSession } from "../Watch/watchStream.js";

type Kind = "project" | "session" | "skill";
type Proj = { path: string; flavor: string; exists: boolean };
type Skill = { name: string; description?: string };
// The source shapes accepted by POST /api/play/studio (mirrors the server's GameSource union).
type Source =
  | { kind: "project"; path: string; flavor: string }
  | { kind: "session"; agent: string; project?: string; sessionId: string; summary: string }
  | { kind: "skill"; skillName: string };

const TABS: { kind: Kind; label: string }[] = [
  { kind: "project", label: "Project" },
  { kind: "session", label: "Session" },
  { kind: "skill", label: "Skill" },
];

export function Composer({ apiBase, onCreated }: { apiBase: string; onCreated: (name: string) => void }) {
  const [kind, setKind] = useState<Kind>("project");
  const [projects, setProjects] = useState<Proj[] | null>(null);
  const [sessions, setSessions] = useState<WatchSession[] | null>(null);
  const [skills, setSkills] = useState<Skill[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // Lazy-load each list the first time its tab is shown.
  useEffect(() => {
    if (kind === "project" && !projects) testbedProjectsRoute.call(makeClient(apiBase)).then((r) => setProjects(r.projects)).catch(() => setProjects([]));
    if (kind === "session" && !sessions) fetchSessions(apiBase).then(setSessions).catch(() => setSessions([]));
    if (kind === "skill" && !skills) inventoryRoute.call(makeClient(apiBase)).then((r) => setSkills(r.skills)).catch(() => setSkills([]));
  }, [kind, apiBase, projects, sessions, skills]);

  async function seed(source: Source) {
    if (busy) return;
    setBusy(true); setError("");
    try {
      const res = await playStudioRoute.call(makeClient(apiBase), { body: { source } });
      onCreated(res.name);
    } catch (e) { setError((e as Error).message); setBusy(false); }
  }

  function sessionSummary(s: WatchSession): string {
    return [s.project ?? "session", s.model, `${s.msgs} msgs`].filter(Boolean).join(" · ");
  }

  return (
    <section className="analyze">
      <p className="analyze-intro">Create a miniapp from a source — the agent seeds it and opens the studio.</p>
      <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
        {TABS.map((t) => (
          <button key={t.kind} className={`ledger-search${kind === t.kind ? " is-active" : ""}`}
            style={{ width: "auto", marginBottom: 0 }} onClick={() => setKind(t.kind)}>{t.label}</button>
        ))}
      </div>
      {error && <p className="ledger-error">{error}</p>}

      {kind === "project" && (!projects ? <p className="ledger-view">Loading projects…</p> :
        <ul className="analyze-list">
          {projects.map((p) => (
            <li key={p.path} className="analyze-row" style={{ cursor: "pointer" }} onClick={() => seed({ kind: "project", path: p.path, flavor: p.flavor })}>
              <span>{p.path}</span> <span style={{ opacity: 0.6, fontSize: 12 }}>{p.flavor}</span>
            </li>
          ))}
        </ul>)}

      {kind === "session" && (!sessions ? <p className="ledger-view">Loading sessions…</p> :
        <ul className="analyze-list">
          {sessions.map((s) => (
            <li key={s.id} className="analyze-row" style={{ cursor: "pointer" }}
              onClick={() => seed({ kind: "session", agent: s.agent, ...(s.project ? { project: s.project } : {}), sessionId: s.id, summary: sessionSummary(s) })}>
              <span>{s.project ?? "session"}</span> <span style={{ opacity: 0.6, fontSize: 12 }}>{s.agent} · {s.msgs} msgs</span>
            </li>
          ))}
        </ul>)}

      {kind === "skill" && (!skills ? <p className="ledger-view">Loading skills…</p> :
        <ul className="analyze-list">
          {skills.map((k) => (
            <li key={k.name} className="analyze-row" style={{ cursor: "pointer" }} onClick={() => seed({ kind: "skill", skillName: k.name })}>
              <span>{k.name}</span> {k.description && <span style={{ opacity: 0.6, fontSize: 12 }}>{k.description}</span>}
            </li>
          ))}
        </ul>)}

      {busy && <p className="run-status">Seeding studio…</p>}
    </section>
  );
}
