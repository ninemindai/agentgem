// packages/console/src/panels/Play/ConnectorPicker.tsx
// Intent-only MCP connector picker: selected servers are chips (click to expand the server's tools);
// a "+ add connector" combobox opens a searchable menu of the remaining candidates. Never writes
// meta.json — the save-time scan is the authority over mcpNeeds; this only steers the build prompt.
import { useEffect, useRef, useState } from "react";
import { makeClient, playMcpCandidatesRoute, playMcpCandidateToolsRoute } from "../../api/routes.js";

type Candidate = { server: string; transport: string; needsSecret: boolean };
type ToolState = { name: string }[] | "loading" | "error";

export function connectorPreamble(servers: string[]): string {
  if (!servers.length) return "";
  return [
    "This miniapp should use these MCP connectors — for each, call its tools via",
    '`window.agentgemApp.mcp.callTool(server, tool)` and add the server to `"mcpNeeds"` in meta.json:',
    ...servers.map((s) => `- ${s}`),
  ].join("\n");
}

export function ConnectorPicker({ apiBase, selected, onChange }: { apiBase: string; selected: string[]; onChange: (servers: string[]) => void }) {
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [toolsByServer, setToolsByServer] = useState<Record<string, ToolState>>({});
  const [expanded, setExpanded] = useState<string | null>(null);   // which chip's tools are open
  const [menuOpen, setMenuOpen] = useState(false);
  const [q, setQ] = useState("");
  const comboRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    playMcpCandidatesRoute.call(makeClient(apiBase)).then((r) => setCandidates(r.servers)).catch(() => setCandidates([]));
  }, [apiBase]);

  // Close the menu on an outside click.
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => { if (comboRef.current && !comboRef.current.contains(e.target as Node)) setMenuOpen(false); };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [menuOpen]);

  const byName = (s: string) => candidates?.find((c) => c.server === s);
  function loadTools(c: Candidate, force = false) {
    if ((c.needsSecret && !force) || toolsByServer[c.server]) return;
    setToolsByServer((m) => ({ ...m, [c.server]: "loading" }));
    playMcpCandidateToolsRoute.call(makeClient(apiBase), { query: { server: c.server } })
      .then((r) => setToolsByServer((m) => ({ ...m, [c.server]: r.tools })))
      .catch(() => setToolsByServer((m) => ({ ...m, [c.server]: "error" })));
  }
  function toggleChip(server: string) {
    const c = byName(server);
    const open = expanded === server;
    setExpanded(open ? null : server);
    if (!open && c) loadTools(c);
  }
  function add(server: string) { onChange([...selected, server]); setMenuOpen(false); setQ(""); }
  function remove(server: string) { onChange(selected.filter((s) => s !== server)); }

  const unpicked = (candidates ?? []).filter((c) => !selected.includes(c.server));
  const needle = q.trim().toLowerCase();
  const shown = needle ? unpicked.filter((c) => c.server.toLowerCase().includes(needle)) : unpicked;

  return (
    <div className="play-connectors">
      <span className="play-connectors__label">Connectors</span>
      <div className="play-connectors__chips">
        {selected.map((server) => {
          const c = byName(server);
          const open = expanded === server;
          const tools = toolsByServer[server];
          return (
            <div key={server} className="play-chip-wrap">
              <span className="play-chip">
                <button type="button" className="play-chip__body" aria-label={`${server} tools`}
                  aria-expanded={open} aria-controls={`mcp-tools-${server}`} onClick={() => toggleChip(server)}>
                  {server}{c?.needsSecret ? " ⚠" : ""}
                </button>
                <button type="button" className="play-chip__x" aria-label={`remove ${server}`} onClick={() => remove(server)}>×</button>
              </span>
              {open && (
                <div id={`mcp-tools-${server}`} className="play-chip__tools">
                  {c?.needsSecret && !tools ? (
                    <span>Needs secret — set it in your env, then reload. <button type="button" className="play-linkbtn" onClick={() => c && loadTools(c, true)}>Try anyway</button></span>
                  ) : tools === "loading" ? <span>Connecting…</span>
                    : tools === "error" ? <span>Couldn’t connect to {server}.</span>
                    : tools == null ? null
                    : tools.length === 0 ? <span>This server exposes no tools.</span>
                    : <span>{tools.map((t) => t.name).join(", ")}</span>}
                </div>
              )}
            </div>
          );
        })}
        <div className="play-combo" ref={comboRef}>
          <button type="button" className="play-combo__btn" aria-haspopup="listbox" aria-expanded={menuOpen}
            aria-label="add connector" onClick={() => setMenuOpen((o) => !o)}>+ ▾</button>
          {menuOpen && (
            <div className="play-combo__menu">
              <input className="play-input play-combo__search" autoFocus placeholder="search connectors…" value={q}
                aria-label="search connectors" onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Escape") setMenuOpen(false); }} />
              {candidates == null ? <p className="play-combo__empty">Loading…</p>
                : candidates.length === 0 ? <p className="play-combo__empty">No MCP servers found in your agent setup. Add one to <code>~/.claude/.mcp.json</code>.</p>
                : shown.length === 0 ? <p className="play-combo__empty">{unpicked.length === 0 ? "all connectors added" : "No matches"}</p>
                : (
                  <ul className="play-combo__list" role="listbox">
                    {shown.map((c) => (
                      <li key={c.server} role="option" aria-selected={false} className="play-combo__opt" onClick={() => add(c.server)}>
                        <span>{c.server}</span>
                        <span className="play-connectors__meta">{c.transport}{c.needsSecret ? " · needs secret" : ""}</span>
                      </li>
                    ))}
                  </ul>
                )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
