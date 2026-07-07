// packages/console/src/panels/Play/Composer.tsx
import { useEffect, useState } from "react";
import { makeClient, playStudioRoute, playImportRoute, testbedProjectsRoute, inventoryRoute } from "../../api/routes.js";
import { fetchSessions, type WatchSession } from "../Watch/watchStream.js";

type Kind = "project" | "session" | "skill" | "html";
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
  { kind: "html", label: "HTML" },
];

export function Composer({ apiBase, onCreated }: { apiBase: string; onCreated: (name: string) => void }) {
  const [kind, setKind] = useState<Kind>("project");
  const [projects, setProjects] = useState<Proj[] | null>(null);
  const [sessions, setSessions] = useState<WatchSession[] | null>(null);
  const [skills, setSkills] = useState<Skill[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [importTitle, setImportTitle] = useState("");   // HTML-import tab
  const [importHtml, setImportHtml] = useState("");

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

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    setImportHtml(await f.text());
    if (!importTitle) setImportTitle(f.name.replace(/\.html?$/i, ""));
  }

  async function doImport() {
    if (busy || !importHtml.trim()) return;
    setBusy(true); setError("");
    try {
      const res = await playImportRoute.call(makeClient(apiBase), { body: { title: importTitle.trim() || "imported-game", html: importHtml } });
      onCreated(res.name);
    } catch (e) { setError((e as Error).message); setBusy(false); }
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

      {kind === "html" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <p style={{ margin: 0, opacity: 0.7, fontSize: 13 }}>Import an existing self-contained HTML game — pick a file or paste it, then refine it in the studio.</p>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input className="ledger-search" style={{ width: "auto", marginBottom: 0 }} placeholder="title" value={importTitle} onChange={(e) => setImportTitle(e.target.value)} />
            <input type="file" accept=".html,.htm,text/html" onChange={onFile} />
          </div>
          <textarea className="ledger-search" style={{ minHeight: 220, marginBottom: 0, fontFamily: "monospace", fontSize: 12 }}
            placeholder="…or paste HTML here" value={importHtml} onChange={(e) => setImportHtml(e.target.value)} />
          <button className="run-badge run-running" style={{ width: "auto", alignSelf: "flex-start" }} disabled={busy || !importHtml.trim()} onClick={doImport}>
            {busy ? "Importing…" : "Create miniapp"}
          </button>
        </div>
      )}

      {busy && kind !== "html" && <p className="run-status">Seeding studio…</p>}
    </section>
  );
}
