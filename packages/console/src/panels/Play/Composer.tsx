// packages/console/src/panels/Play/Composer.tsx
import { useEffect, useState } from "react";
import { makeClient, playStudioRoute, playImportRoute, playBlankRoute, testbedProjectsRoute, inventoryRoute } from "../../api/routes.js";
import { fetchSessions, type WatchSession } from "../Watch/watchStream.js";
import { AgentSelector, type PlayAgent } from "./AgentSelector.js";
import { CAP_TOOL, CAP_LABEL, CONSENT_CAPS } from "./consent.js";
import { SourceList } from "./SourceList.js";
import { ConnectorPicker, connectorPreamble } from "./ConnectorPicker.js";
import { useUploads } from "./uploads.js";
import { UploadsField } from "./UploadsField.js";
import type { GameGenre } from "@agentgem/model";

type Kind = "project" | "session" | "skill" | "html" | "blank";
type Proj = { path: string; flavor: string; exists: boolean; lastUsed?: string | null };
type Skill = { name: string; description?: string };
// The source shapes accepted by POST /api/play/studio (mirrors the server's GameSource union).
type Source =
  | { kind: "project"; path: string; flavor: string }
  | { kind: "session"; agent: string; project?: string; sessionId: string; summary: string }
  | { kind: "skill"; skillName: string };

// Which template a source forks into. Exhaustive by construction: keying on GameGenre makes a new
// genre without an entry here a COMPILE error. Kept as a local literal with a type-only import — a
// runtime import of GAME_GENRES would drag node:* into the browser bundle (see parseTags.ts).
// `first: true` marks the default template for a kind, so the picker never starts unselected.
const PLAY_TEMPLATES: Record<GameGenre, { label: string; sourceKind: Kind; first?: boolean }> = {
  replay: { label: "Replay", sourceKind: "session", first: true },
  "session-heatmap": { label: "Heatmap", sourceKind: "session" },
  "skill-run": { label: "Challenge", sourceKind: "skill", first: true },
  "skill-tuner": { label: "Tuner", sourceKind: "skill" },
  "project-fun": { label: "Mini-game", sourceKind: "project", first: true },
  "project-map": { label: "Map", sourceKind: "project" },
};
type TemplateEntry = [GameGenre, (typeof PLAY_TEMPLATES)[GameGenre]];
const templatesFor = (kind: Kind): TemplateEntry[] =>
  (Object.entries(PLAY_TEMPLATES) as TemplateEntry[]).filter(([, t]) => t.sourceKind === kind);
const defaultTemplate = (kind: Kind): GameGenre | null =>
  templatesFor(kind).find(([, t]) => t.first)?.[0] ?? null;

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
  const [blankTemplate, setBlankTemplate] = useState<"canvas" | "doc">("canvas");  // Blank starting point
  // Optional miniapp id, shared by every tab. Left empty the server derives one from the source and
  // suffixes it on collision; typed, the server claims it exactly and 409s if it is taken.
  const [name, setName] = useState("");
  const named = () => (name.trim() ? { name: name.trim() } : {});
  // Which template the chosen source forks into. Reset whenever the source kind changes, because a
  // genre only belongs to its own sourceKind — the server rejects a mismatched pair outright.
  const [template, setTemplate] = useState<GameGenre | null>(defaultTemplate(seeded ? "blank" : "project"));
  function chooseKind(k: Kind) { setKind(k); setTemplate(defaultTemplate(k)); }
  const [caps, setCaps] = useState<Cap[]>([]);
  const toggleCap = (c: Cap) => setCaps((cs) => (cs.includes(c) ? cs.filter((x) => x !== c) : [...cs, c]));
  const [permsOpen, setPermsOpen] = useState(false);
  const [connectors, setConnectors] = useState<string[]>([]);   // picked connectors (intent); ConnectorPicker owns candidates/tools state

  // Optional seed files, shared by the Blank and HTML tabs — `role` decides where the server lands each
  // one (ship → inlined into the miniapp, reference → build context only). See uploads.ts/UploadsField.
  const up = useUploads();

  // Lazy-load each list the first time its tab is shown.
  useEffect(() => {
    if (kind === "project" && !projects) testbedProjectsRoute.call(makeClient(apiBase)).then((r) => setProjects(r.projects)).catch(() => setProjects([]));
    if (kind === "session" && !sessions) fetchSessions(apiBase).then(setSessions).catch(() => setSessions([]));
    if (kind === "skill" && !skills) inventoryRoute.call(makeClient(apiBase), { query: {} }).then((r) => setSkills(r.skills)).catch(() => setSkills([]));
  }, [kind, apiBase, projects, sessions, skills]);

  async function seed(source: Source) {
    if (busy) return;
    setBusy(true); setError("");
    try {
      // Omit the default template so the common seed call stays byte-identical to the pre-picker shape.
      const genre = template && template !== defaultTemplate(source.kind) ? { genre: template } : {};
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
      // Omit the default "canvas" so a plain from-scratch game call is byte-identical to before the toggle.
      const template = blankTemplate === "doc" ? { template: "doc" as const } : {};
      const res = await playBlankRoute.call(makeClient(apiBase), { body: { title: blankTitle.trim(), ...named(), ...up.payload(), ...template } });
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
      <div className="play-options">
        <div className="play-perms">
          <button type="button" className="play-perms__toggle" aria-expanded={permsOpen} onClick={() => setPermsOpen((o) => !o)}>
            Permissions{caps.length ? ` · ${caps.length} enabled` : ""} <span aria-hidden="true">{permsOpen ? "▾" : "▸"}</span>
          </button>
          {permsOpen && (
            <fieldset className="play-caps-pick">
              <legend>This miniapp may:</legend>
              {CONSENT_CAPS.map((c) => (
                <label key={c} className="play-caps-pick__row">
                  <input type="checkbox" checked={caps.includes(c)} onChange={() => toggleCap(c)} />
                  <span>{CAP_LABEL[c]}</span>
                </label>
              ))}
            </fieldset>
          )}
        </div>
        <ConnectorPicker apiBase={apiBase} selected={connectors} onChange={setConnectors} />
      </div>
      <div className="play-tabs">
        {TABS.map((t) => (
          <button key={t.kind} className={`play-tab${kind === t.kind ? " is-active" : ""}`} onClick={() => chooseKind(t.kind)}>{t.label}</button>
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

      {kind === "project" && (
        <SourceList<Proj> items={projects}
          filter={(p, q) => p.path.toLowerCase().includes(q) || p.flavor.toLowerCase().includes(q)}
          rank={(a, b) => (b.lastUsed ?? "").localeCompare(a.lastUsed ?? "")}   /* most-recently-used first */
          onPick={(p) => seed({ kind: "project", path: p.path, flavor: p.flavor })}
          renderRow={(p) => ({ key: p.path, main: p.path, meta: p.flavor })}
          placeholder="search projects…" loadingLabel="Loading projects…" />
      )}

      {/* Template row: one entry per genre whose sourceKind matches the tab. Reuses the play-tabs /
          play-tab styling the session genre fork already used, so every class here is CSS-enforced. */}
      {templatesFor(kind).length > 1 && (
        <div className="play-tabs" style={{ marginBottom: 10, alignItems: "center" }}>
          <span className="play-intro" style={{ margin: 0 }}>Template:</span>
          {templatesFor(kind).map(([id, t]) => (
            <button key={id} type="button" className={`play-tab${template === id ? " is-active" : ""}`}
              onClick={() => setTemplate(id)}>{t.label}</button>
          ))}
        </div>
      )}

      {kind === "session" && (
        <>
          <SourceList<WatchSession> items={sessions}
            filter={(s, q) => sessionSummary(s).toLowerCase().includes(q)}
            rank={(a, b) => b.endMs - a.endMs}   /* most-recent session first */
            onPick={(s) => seed({ kind: "session", agent: s.agent, ...(s.project ? { project: s.project } : {}), sessionId: s.id, summary: sessionSummary(s) })}
            renderRow={(s) => ({ key: s.id, main: s.project ?? "session", meta: `${s.agent} · ${s.msgs} msgs` })}
            placeholder="search sessions…" loadingLabel="Loading sessions…" />
        </>
      )}

      {kind === "skill" && (
        <SourceList<Skill> items={skills}
          filter={(k, q) => k.name.toLowerCase().includes(q) || (k.description ?? "").toLowerCase().includes(q)}
          rank={(a, b) => a.name.localeCompare(b.name)}   /* no usage signal — alphabetical */
          onPick={(k) => seed({ kind: "skill", skillName: k.name })}
          renderRow={(k) => ({ key: k.name, main: k.name, meta: k.description })}
          placeholder="search skills…" loadingLabel="Loading skills…" />
      )}

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
          <div className="play-tabs" style={{ alignItems: "center" }}>
            <span className="play-intro" style={{ margin: 0 }}>Start as:</span>
            <button type="button" className={`play-tab${blankTemplate === "canvas" ? " is-active" : ""}`} onClick={() => setBlankTemplate("canvas")}>Game</button>
            <button type="button" className={`play-tab${blankTemplate === "doc" ? " is-active" : ""}`} onClick={() => setBlankTemplate("doc")}>Document</button>
          </div>
          <input className="play-input" placeholder="title" value={blankTitle} onChange={(e) => setBlankTitle(e.target.value)} />
          <textarea className="play-input" style={{ minHeight: 120 }}
            placeholder={blankTemplate === "doc" ? "describe the document or tool you want — sent as the first build prompt…" : "describe the mini-game you want — sent as the first build prompt…"} value={blankPrompt} onChange={(e) => setBlankPrompt(e.target.value)} />
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
