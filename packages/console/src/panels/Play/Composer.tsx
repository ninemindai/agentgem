// packages/console/src/panels/Play/Composer.tsx
import { useEffect, useState } from "react";
import { makeClient, playStudioRoute, playImportRoute, playBlankRoute, testbedProjectsRoute, inventoryRoute } from "../../api/routes.js";
import { fetchSessions, type WatchSession } from "../Watch/watchStream.js";
import { AgentSelector, type PlayAgent } from "./AgentSelector.js";
import { CAP_TOOL, CAP_LABEL, CONSENT_CAPS } from "./consent.js";

type Kind = "project" | "session" | "skill" | "html" | "blank";
type Proj = { path: string; flavor: string; exists: boolean };
type Skill = { name: string; description?: string };
type Attachment = { name: string; mime: string; size: number; kind: "text" | "image"; content: string };
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
const MAX_TEXT_CHARS = 12_000;
const MAX_IMAGE_BYTES = 500_000;

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

function dataUrl(f: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result ?? ""));
    r.onerror = () => reject(r.error ?? new Error("could not read file"));
    r.readAsDataURL(f);
  });
}

function isTextDoc(f: File): boolean {
  return f.type.startsWith("text/")
    || /\.(md|markdown|txt|csv|json|ya?ml|html?|css|js|jsx|ts|tsx)$/i.test(f.name);
}

async function readAttachment(f: File): Promise<Attachment> {
  if (f.type.startsWith("image/")) {
    if (f.size > MAX_IMAGE_BYTES) throw new Error(`${f.name} is too large; keep images under 500 KB`);
    return { name: f.name, mime: f.type || "image/*", size: f.size, kind: "image", content: await dataUrl(f) };
  }
  if (!isTextDoc(f)) throw new Error(`${f.name} is not a supported doc/photo type`);
  const text = await f.text();
  return {
    name: f.name,
    mime: f.type || "text/plain",
    size: f.size,
    kind: "text",
    content: text.length > MAX_TEXT_CHARS ? `${text.slice(0, MAX_TEXT_CHARS)}\n\n[truncated]` : text,
  };
}

function attachmentPreamble(attachments: Attachment[]): string {
  if (!attachments.length) return "";
  return [
    "Use these reference docs/photos while building the miniapp. If you use an image asset, inline it as a data: URI so the game remains one self-contained HTML file.",
    ...attachments.map((a) => a.kind === "image"
      ? `\n## Image: ${a.name} (${a.mime}, ${Math.round(a.size / 1024)} KB)\n${a.content}`
      : `\n## Document: ${a.name} (${a.mime})\n${a.content}`),
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
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [attachmentError, setAttachmentError] = useState("");
  // Optional miniapp id, shared by every tab. Left empty the server derives one from the source and
  // suffixes it on collision; typed, the server claims it exactly and 409s if it is taken.
  const [name, setName] = useState("");
  const named = () => (name.trim() ? { name: name.trim() } : {});
  // Session-only: which genre a session source forks into. Defaults to Replay; only threaded to the
  // server when the user picks Heatmap, so the default seed call stays byte-identical to before.
  const [sessionGenre, setSessionGenre] = useState<"replay" | "session-heatmap">("replay");
  const [caps, setCaps] = useState<Cap[]>([]);
  const toggleCap = (c: Cap) => setCaps((cs) => (cs.includes(c) ? cs.filter((x) => x !== c) : [...cs, c]));
  const seedPreamble = () => [capPreamble(caps), attachmentPreamble(attachments)].filter(Boolean).join("\n\n") || undefined;

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
      const genre = source.kind === "session" && sessionGenre === "session-heatmap" ? { genre: sessionGenre } : {};
      const res = await playStudioRoute.call(makeClient(apiBase), { body: { source, ...named(), ...genre } });
      // Only pass a second argument when there's a preamble to carry — preserves the old single-arg
      // call shape when no capability is checked (seedPrompt reads as undefined either way).
      const preamble = seedPreamble();
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
  const onAttachments = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = [...(e.target.files ?? [])];
    if (!files.length) return;
    setAttachmentError("");
    try {
      const next = await Promise.all(files.map(readAttachment));
      setAttachments((a) => [...a, ...next]);
    } catch (err) {
      setAttachmentError((err as Error).message);
    } finally {
      e.target.value = "";
    }
  };

  async function doImport() {
    if (busy || !importHtml.trim()) return;
    setBusy(true); setError("");
    try {
      const res = await playImportRoute.call(makeClient(apiBase), { body: { title: importTitle.trim() || "imported-game", html: importHtml, ...named() } });
      onCreated(res.name);
    } catch (e) { setError((e as Error).message); setBusy(false); }
  }

  async function doBlank() {
    if (busy || !blankTitle.trim()) return;
    setBusy(true); setError("");
    try {
      const res = await playBlankRoute.call(makeClient(apiBase), { body: { title: blankTitle.trim(), ...named() } });
      // The description isn't baked server-side; it's auto-sent as the studio's first build prompt.
      onCreated(res.name, [seedPreamble(), blankPrompt.trim()].filter(Boolean).join("\n\n") || undefined);
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
      <div className="play-caps-pick" style={{ marginBottom: 12 }}>
        <label className="play-caps-pick__row">
          <span>Add reference docs/photos</span>
          <input aria-label="Add reference docs/photos" type="file" multiple
            accept="image/*,.md,.markdown,.txt,.csv,.json,.yaml,.yml,.html,.htm,.css,.js,.jsx,.ts,.tsx,text/*"
            onChange={onAttachments} />
        </label>
        {attachments.length > 0 && (
          <div className="play-intro" style={{ margin: "6px 0 0" }}>
            Attached: {attachments.map((a) => a.name).join(", ")}
          </div>
        )}
        {attachmentError && <div className="play-banner__detail">{attachmentError}</div>}
      </div>
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
      {error && <div className="play-banner"><span className="play-banner__ico">⚠</span><div className="play-banner__body"><div className="play-banner__detail">{error}</div></div></div>}

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
