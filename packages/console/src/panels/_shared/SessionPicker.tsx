import { useEffect, useState } from "react";
import { observeRoute, makeClient, type SessionRow } from "../../api/routes.js";

export type PickedSession = { sessionId: string; label: string };

function basename(p: string): string { return p.replace(/\/+$/, "").split("/").pop() || p; }

/** The label a picked session carries into the rubric run (mirrors the Sessions
 *  table's rubric-shortcut label: "project · id…", or a truncated id when the
 *  session has no project). */
export function sessionLabel(s: { project: string | null; sessionId: string }): string {
  return s.project ? `${basename(s.project)} · ${s.sessionId.slice(0, 8)}…` : s.sessionId.slice(0, 12) + "…";
}

// A searchable session menu for session-granular rubrics — the peer of ScopePicker
// (global/project), but for the third scope. Loads claude sessions on open (the
// rubric engine reads claude transcripts, so non-claude runs are excluded), most
// recent first, searchable by project / model / id. Picking one hands back
// { sessionId, label }; the caller turns that into a `session:<id>` run.
export function SessionPicker({ apiBase, selectedId, selectedLabel, onPick }: {
  apiBase: string;
  selectedId: string | null;
  selectedLabel: string | null;
  onPick: (s: PickedSession) => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<SessionRow[] | null>(null);

  useEffect(() => {
    if (!open || rows) return;
    let alive = true;
    observeRoute.call(makeClient(apiBase), { query: { range: "30d", agent: "claude" } })
      .then((r) => { if (alive) setRows(r.sessions); })
      .catch(() => { if (alive) setRows([]); });
    return () => { alive = false; };
  }, [open, apiBase, rows]);

  const needle = q.trim().toLowerCase();
  const filtered = (rows ?? []).filter((s) =>
    !needle ||
    (s.project ?? "").toLowerCase().includes(needle) ||
    s.sessionId.toLowerCase().includes(needle) ||
    (s.model ?? "").toLowerCase().includes(needle));

  return (
    <div className="scope-picker">
      <button className={"obs-range-btn" + (selectedId ? " is-active" : "")} onClick={() => setOpen((o) => !o)}>
        {selectedId ? `Session: ${selectedLabel ?? selectedId.slice(0, 8) + "…"}` : "Session"} ▾
      </button>
      {open && (
        <div className="scope-menu">
          <input aria-label="search sessions" placeholder="Search sessions…" value={q} onChange={(e) => setQ(e.target.value)} />
          <ul>
            {rows === null && <li className="obs-muted">Loading…</li>}
            {rows !== null && filtered.length === 0 && <li className="obs-muted">No claude sessions.</li>}
            {filtered.slice(0, 40).map((s) => (
              <li key={s.agent + ":" + s.sessionId}>
                <button onClick={() => { onPick({ sessionId: s.sessionId, label: sessionLabel(s) }); setOpen(false); }}>
                  {s.project ? basename(s.project) : "(no project)"}
                  <span className="obs-muted"> · {s.model ?? "—"} · {s.sessionId.slice(0, 8)}…</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
