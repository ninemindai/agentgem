// packages/console/src/panels/Play/Composer.tsx
import { useEffect, useState } from "react";
import { makeClient, playStudioRoute, playImportRoute, playBlankRoute, testbedProjectsRoute, inventoryRoute } from "../../api/routes.js";
import { fetchSessions, type WatchSession } from "../Watch/watchStream.js";
import { AgentSelector, type PlayAgent } from "./AgentSelector.js";

type Kind = "project" | "session" | "skill" | "html" | "blank";
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
  { kind: "blank", label: "Blank" },
];

export function Composer({
  apiBase,
  agents,
  agentId,
  onAgentIdChange,
  initialTitle,
  initialPrompt,
  onCreated,
}: {
  apiBase: string;
  agents: PlayAgent[] | null;
  agentId: string;
  onAgentIdChange: (agentId: string) => void;
  // Prefill for the Blank tab, from the marketplace "Make your own" deep link. Either one present
  // means the reader arrived wanting to build from a description, so open on Blank rather than Project.
  initialTitle?: string;
  initialPrompt?: string;
  // seedPrompt (only from the Blank tab's description) is auto-sent as the studio's first build prompt.
  onCreated: (name: string, seedPrompt?: string) => void;
}) {
  const seeded = !!(initialTitle || initialPrompt);
  const [kind, setKind] = useState<Kind>(seeded ? "blank" : "project");
  const [projects, setProjects] = useState<Proj[] | null>(null);
  const [sessions, setSessions] = useState<WatchSession[] | null>(null);
  const [skills, setSkills] = useState<Skill[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [importTitle, setImportTitle] = useState("");   // HTML-import tab
  const [importHtml, setImportHtml] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const [blankTitle, setBlankTitle] = useState(initialTitle ?? "");     // Blank (from-scratch) tab
  const [blankPrompt, setBlankPrompt] = useState(initialPrompt ?? "");

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

  async function loadFile(f: File | undefined) {
    if (!f) return;
    setImportHtml(await f.text());
    if (!importTitle) setImportTitle(f.name.replace(/\.html?$/i, ""));
  }
  const onFile = (e: React.ChangeEvent<HTMLInputElement>) => loadFile(e.target.files?.[0]);
  const onDrop = (e: React.DragEvent) => { e.preventDefault(); setDragOver(false); loadFile(e.dataTransfer.files?.[0]); };

  async function doImport() {
    if (busy || !importHtml.trim()) return;
    setBusy(true); setError("");
    try {
      const res = await playImportRoute.call(makeClient(apiBase), { body: { title: importTitle.trim() || "imported-game", html: importHtml } });
      onCreated(res.name);
    } catch (e) { setError((e as Error).message); setBusy(false); }
  }

  async function doBlank() {
    if (busy || !blankTitle.trim()) return;
    setBusy(true); setError("");
    try {
      const res = await playBlankRoute.call(makeClient(apiBase), { body: { title: blankTitle.trim() } });
      // The description isn't baked server-side; it's auto-sent as the studio's first build prompt.
      onCreated(res.name, blankPrompt.trim() || undefined);
    } catch (e) { setError((e as Error).message); setBusy(false); }
  }

  return (
    <section className="analyze">
      <p className="play-intro">Create a miniapp from a source — or start Blank and build your own — then choose which coding agent will build/edit it in Studio.</p>
      <AgentSelector
        agents={agents}
        agentId={agentId}
        onChange={onAgentIdChange}
        note="Used when you ask the studio to build or edit the game."
      />
      <div className="play-tabs">
        {TABS.map((t) => (
          <button key={t.kind} className={`play-tab${kind === t.kind ? " is-active" : ""}`} onClick={() => setKind(t.kind)}>{t.label}</button>
        ))}
      </div>
      {error && <div className="play-banner"><span className="play-banner__ico">⚠</span><div className="play-banner__body"><div className="play-banner__detail">{error}</div></div></div>}

      {kind === "project" && (!projects ? <p className="play-intro">Loading projects…</p> :
        <ul className="play-src">
          {projects.map((p) => (
            <li key={p.path} className="play-src-row" onClick={() => seed({ kind: "project", path: p.path, flavor: p.flavor })}>
              <span className="play-src-row__main">{p.path}</span><span className="play-src-row__meta">{p.flavor}</span>
            </li>
          ))}
        </ul>)}

      {kind === "session" && (!sessions ? <p className="play-intro">Loading sessions…</p> :
        <ul className="play-src">
          {sessions.map((s) => (
            <li key={s.id} className="play-src-row"
              onClick={() => seed({ kind: "session", agent: s.agent, ...(s.project ? { project: s.project } : {}), sessionId: s.id, summary: sessionSummary(s) })}>
              <span className="play-src-row__main">{s.project ?? "session"}</span><span className="play-src-row__meta">{s.agent} · {s.msgs} msgs</span>
            </li>
          ))}
        </ul>)}

      {kind === "skill" && (!skills ? <p className="play-intro">Loading skills…</p> :
        <ul className="play-src">
          {skills.map((k) => (
            <li key={k.name} className="play-src-row" onClick={() => seed({ kind: "skill", skillName: k.name })}>
              <span className="play-src-row__main">{k.name}</span>{k.description && <span className="play-src-row__meta">{k.description}</span>}
            </li>
          ))}
        </ul>)}

      {kind === "html" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <p className="play-intro" style={{ margin: 0 }}>Import an existing self-contained HTML game — drop a file or paste it, then refine it in the studio.</p>
          <input className="play-input" placeholder="title" value={importTitle} onChange={(e) => setImportTitle(e.target.value)} />
          <label className={`play-drop${dragOver ? " is-over" : ""}`}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }} onDragLeave={() => setDragOver(false)} onDrop={onDrop}>
            <b>Drop an .html file here</b> or click to choose{importHtml ? ` — ${(importHtml.length / 1024).toFixed(0)} KB loaded` : ""}
            <input type="file" accept=".html,.htm,text/html" onChange={onFile} style={{ display: "none" }} />
          </label>
          <textarea className="play-input" style={{ minHeight: 200, fontFamily: "var(--font-mono)", fontSize: 12 }}
            placeholder="…or paste HTML here" value={importHtml} onChange={(e) => setImportHtml(e.target.value)} />
          <button className="play-btn play-btn--primary" style={{ alignSelf: "flex-start" }} disabled={busy || !importHtml.trim()} onClick={doImport}>
            {busy ? "Importing…" : "Create miniapp"}
          </button>
        </div>
      )}

      {kind === "blank" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <p className="play-intro" style={{ margin: 0 }}>Start from scratch — no source context. Name it and describe what you want; the studio agent starts building from your description. Leave the description blank to build by chatting instead.</p>
          <input className="play-input" placeholder="title" value={blankTitle} onChange={(e) => setBlankTitle(e.target.value)} />
          <textarea className="play-input" style={{ minHeight: 120 }}
            placeholder="describe the mini-game you want — sent as the first build prompt…" value={blankPrompt} onChange={(e) => setBlankPrompt(e.target.value)} />
          <button className="play-btn play-btn--primary" style={{ alignSelf: "flex-start" }} disabled={busy || !blankTitle.trim()} onClick={doBlank}>
            {busy ? "Creating…" : "Create miniapp"}
          </button>
        </div>
      )}

      {busy && kind !== "html" && kind !== "blank" && <p className="play-intro" style={{ marginTop: 10 }}>Seeding studio…</p>}
    </section>
  );
}
