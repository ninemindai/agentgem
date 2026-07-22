// packages/console/src/panels/Play/Composer.tsx
import { useEffect, useState } from "react";
import { makeClient, playStudioRoute, playImportRoute, playBlankRoute, testbedProjectsRoute, inventoryRoute, playMcpCandidatesRoute, playMcpCandidateToolsRoute } from "../../api/routes.js";
import { fetchSessions, type WatchSession } from "../Watch/watchStream.js";
import { AgentSelector, type PlayAgent } from "./AgentSelector.js";
import { CAP_TOOL, CAP_LABEL, CONSENT_CAPS } from "./consent.js";
import { useUploads } from "./uploads.js";
import { UploadsField } from "./UploadsField.js";

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

// The checkbox universe is exactly CONSENT_CAPS — narrower than the full GameCapability union (it
// excludes the auto-approved session-data) but still a valid CAP_TOOL key, so no cast is needed.
type Cap = (typeof CONSENT_CAPS)[number];

// Checkboxes are INTENT: they only steer the agent's first prompt. They never write meta.json — the
// code is the single authority over `needs`, reconciled at save. An unchecked box that the agent uses
// anyway fails the save; a checked box the agent ignores is pruned back out and reported.
function capPreamble(caps: Cap[]): string {
  if (!caps.length) return "";
  const lines = caps.map((c) => `- ${c} — call \`${CAP_TOOL[c]}\` via window.agentgemApp`);
  return [
    "This miniapp should use these host capabilities. For each one, call the listed MCP tool and add the",
    'capability to `"needs"` in meta.json:',
    ...lines,
  ].join("\n");
}

// Candidate MCP servers the author can steer the build toward. `transport`/`needsSecret` come from the
// redacted /candidates route; tools are fetched lazily per server on expand.
type Candidate = { server: string; transport: string; needsSecret: boolean };
type ToolState = { name: string }[] | "loading" | "error";

// Like capPreamble: INTENT only. Checking a connector appends a hint to the agent's first build prompt;
// it never writes meta.json. The save-time scan stays the single authority over mcpNeeds.
function connectorPreamble(servers: string[]): string {
  if (!servers.length) return "";
  return [
    "This miniapp should use these MCP connectors — for each, call its tools via",
    '`window.agentgemApp.mcp.callTool(server, tool)` and add the server to `"mcpNeeds"` in meta.json:',
    ...servers.map((s) => `- ${s}`),
  ].join("\n");
}

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
  // Optional miniapp id, shared by every tab. Left empty the server derives one from the source and
  // suffixes it on collision; typed, the server claims it exactly and 409s if it is taken.
  const [name, setName] = useState("");
  const named = () => (name.trim() ? { name: name.trim() } : {});
  // Session-only: which genre a session source forks into. Defaults to Replay; only threaded to the
  // server when the user picks Heatmap, so the default seed call stays byte-identical to before.
  const [sessionGenre, setSessionGenre] = useState<"replay" | "session-heatmap">("replay");
  const [caps, setCaps] = useState<Cap[]>([]);
  const toggleCap = (c: Cap) => setCaps((cs) => (cs.includes(c) ? cs.filter((x) => x !== c) : [...cs, c]));
  // Connector picker (intent): installed MCP servers, the servers the author checked, and lazily-fetched
  // tools per server (keyed by name; "loading"/"error" while a connect is in flight or failed).
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [connectors, setConnectors] = useState<string[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [toolsByServer, setToolsByServer] = useState<Record<string, ToolState>>({});
  const toggleConnector = (s: string) => setConnectors((cs) => (cs.includes(s) ? cs.filter((x) => x !== s) : [...cs, s]));
  // Fetch a server's tools once. `force` overrides the needs-secret guard (the "Try anyway" affordance) —
  // otherwise a secret-gated server never spawns a doomed connect just to populate the row.
  function loadTools(c: Candidate, force = false) {
    if ((c.needsSecret && !force) || toolsByServer[c.server]) return;
    setToolsByServer((m) => ({ ...m, [c.server]: "loading" }));
    playMcpCandidateToolsRoute.call(makeClient(apiBase), { query: { server: c.server } })
      .then((r) => setToolsByServer((m) => ({ ...m, [c.server]: r.tools })))
      .catch(() => setToolsByServer((m) => ({ ...m, [c.server]: "error" })));
  }
  function toggleExpand(c: Candidate) {
    const open = expanded === c.server;
    setExpanded(open ? null : c.server);
    if (!open) loadTools(c);
  }

  // Optional seed files, shared by the Blank and HTML tabs — `role` decides where the server lands each
  // one (ship → inlined into the miniapp, reference → build context only). See uploads.ts/UploadsField.
  const up = useUploads();

  // Lazy-load each list the first time its tab is shown.
  useEffect(() => {
    if (kind === "project" && !projects) testbedProjectsRoute.call(makeClient(apiBase)).then((r) => setProjects(r.projects)).catch(() => setProjects([]));
    if (kind === "session" && !sessions) fetchSessions(apiBase).then(setSessions).catch(() => setSessions([]));
    if (kind === "skill" && !skills) inventoryRoute.call(makeClient(apiBase), { query: {} }).then((r) => setSkills(r.skills)).catch(() => setSkills([]));
  }, [kind, apiBase, projects, sessions, skills]);

  // Connectors are global intent (like the capability checkboxes), not tab-scoped — load once on mount.
  useEffect(() => {
    playMcpCandidatesRoute.call(makeClient(apiBase)).then((r) => setCandidates(r.servers)).catch(() => setCandidates([]));
  }, [apiBase]);

  async function seed(source: Source) {
    if (busy) return;
    setBusy(true); setError("");
    try {
      const genre = source.kind === "session" && sessionGenre === "session-heatmap" ? { genre: sessionGenre } : {};
      const res = await playStudioRoute.call(makeClient(apiBase), { body: { source, ...named(), ...genre } });
      // Only pass a second argument when there's a preamble to carry — preserves the old single-arg
      // call shape when no capability is checked (seedPrompt reads as undefined either way).
      const preamble = [capPreamble(caps), connectorPreamble(connectors)].filter(Boolean).join("\n\n");
      if (preamble) onCreated(res.name, preamble); else onCreated(res.name);
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
    const ue = up.limitError(); if (ue) { setError(ue); return; }
    setBusy(true); setError(""); up.setError("");
    try {
      const res = await playImportRoute.call(makeClient(apiBase), { body: { title: importTitle.trim() || "imported-game", html: importHtml, ...named(), ...up.payload() } });
      // Only pass a second argument when there's an uploads preamble to carry — preserves the old
      // single-arg call shape when nothing was uploaded.
      const preamble = up.preamble();
      if (preamble) onCreated(res.name, preamble); else onCreated(res.name);
    } catch (e) { setError((e as Error).message); setBusy(false); }
  }

  async function doBlank() {
    if (busy || !blankTitle.trim()) return;
    const ue = up.limitError(); if (ue) { setError(ue); return; }
    setBusy(true); setError(""); up.setError("");
    try {
      const res = await playBlankRoute.call(makeClient(apiBase), { body: { title: blankTitle.trim(), ...named(), ...up.payload() } });
      // The description isn't baked server-side; it's auto-sent as the studio's first build prompt.
      onCreated(res.name, [capPreamble(caps), connectorPreamble(connectors), up.preamble(), blankPrompt.trim()].filter(Boolean).join("\n\n") || undefined);
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
      <fieldset className="play-caps-pick">
        <legend>This miniapp may:</legend>
        {CONSENT_CAPS.map((c) => (
          <label key={c} className="play-caps-pick__row">
            <input type="checkbox" checked={caps.includes(c)} onChange={() => toggleCap(c)} />
            <span>{CAP_LABEL[c]}</span>
          </label>
        ))}
      </fieldset>
      <fieldset className="play-connectors-pick">
        <legend>MCP connectors (from your agent setup):</legend>
        {candidates == null ? null : candidates.length === 0 ? (
          <div className="play-connectors-pick__empty">
            No MCP servers found in your agent setup. Add one to <code>~/.claude/.mcp.json</code> and it’ll appear here.
          </div>
        ) : candidates.map((c) => {
          const open = expanded === c.server;
          const tools = toolsByServer[c.server];
          return (
            <div key={c.server} className="play-connectors-pick__item">
              <div className="play-connectors-pick__row">
                <label className="play-connectors-pick__pick">
                  <input type="checkbox" checked={connectors.includes(c.server)} onChange={() => toggleConnector(c.server)} />
                  <span>{c.server}</span>
                </label>
                <button type="button" className="play-connectors-pick__toggle" aria-label={`${c.server} tools`}
                  aria-expanded={open} aria-controls={`mcp-tools-${c.server}`} onClick={() => toggleExpand(c)}>
                  <span className="play-connectors-pick__meta">{c.transport}{c.needsSecret ? " · needs secret" : ""}</span>
                  <span aria-hidden="true">{open ? "▾" : "▸"}</span>
                </button>
              </div>
              {open && (
                <div id={`mcp-tools-${c.server}`} className="play-connectors-pick__tools">
                  {c.needsSecret && !tools ? (
                    <span>Needs secret — set it in your env, then reload. <button type="button" className="play-linkbtn" onClick={() => loadTools(c, true)}>Try anyway</button></span>
                  ) : tools === "loading" ? <span>Connecting…</span>
                    : tools === "error" ? <span>Couldn’t connect to {c.server}.</span>
                    : tools == null ? null
                    : tools.length === 0 ? <span>This server exposes no tools.</span>
                    : <span>{tools.map((t) => t.name).join(", ")}</span>}
                </div>
              )}
            </div>
          );
        })}
      </fieldset>
      <div className="play-tabs">
        {TABS.map((t) => (
          <button key={t.kind} className={`play-tab${kind === t.kind ? " is-active" : ""}`} onClick={() => setKind(t.kind)}>{t.label}</button>
        ))}
      </div>
      {/* One id field for every tab. Blank/import default it from the title; project/session/skill default
          it from the folder, session id, or skill name — none of which is meaningful to a human. */}
      <input
        className="play-input" style={{ marginBottom: 10 }}
        aria-label="Miniapp name"
        placeholder="name (optional — defaults to the title; must be unique)"
        value={name} onChange={(e) => setName(e.target.value)}
      />
      {(error || up.error) && <div className="play-banner"><span className="play-banner__ico">⚠</span><div className="play-banner__body"><div className="play-banner__detail">{error || up.error}</div></div></div>}

      {kind === "project" && (!projects ? <p className="play-intro">Loading projects…</p> :
        <ul className="play-src">
          {projects.map((p) => (
            <li key={p.path} className="play-src-row" onClick={() => seed({ kind: "project", path: p.path, flavor: p.flavor })}>
              <span className="play-src-row__main">{p.path}</span><span className="play-src-row__meta">{p.flavor}</span>
            </li>
          ))}
        </ul>)}

      {kind === "session" && (
        <>
          <div className="play-tabs" style={{ marginBottom: 10, alignItems: "center" }}>
            <span className="play-intro" style={{ margin: 0 }}>Genre:</span>
            <button type="button" className={`play-tab${sessionGenre === "replay" ? " is-active" : ""}`} onClick={() => setSessionGenre("replay")}>Replay</button>
            <button type="button" className={`play-tab${sessionGenre === "session-heatmap" ? " is-active" : ""}`} onClick={() => setSessionGenre("session-heatmap")}>Heatmap</button>
          </div>
          {!sessions ? <p className="play-intro">Loading sessions…</p> :
            <ul className="play-src">
              {sessions.map((s) => (
                <li key={s.id} className="play-src-row"
                  onClick={() => seed({ kind: "session", agent: s.agent, ...(s.project ? { project: s.project } : {}), sessionId: s.id, summary: sessionSummary(s) })}>
                  <span className="play-src-row__main">{s.project ?? "session"}</span><span className="play-src-row__meta">{s.agent} · {s.msgs} msgs</span>
                </li>
              ))}
            </ul>}
        </>
      )}

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
          <UploadsField u={up} />
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
          <UploadsField u={up} />
          <button className="play-btn play-btn--primary" style={{ alignSelf: "flex-start" }} disabled={busy || !blankTitle.trim()} onClick={doBlank}>
            {busy ? "Creating…" : "Create miniapp"}
          </button>
        </div>
      )}

      {busy && kind !== "html" && kind !== "blank" && <p className="play-intro" style={{ marginTop: 10 }}>Seeding studio…</p>}
    </section>
  );
}
