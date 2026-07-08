import { useEffect, useState } from "react";
import { testbedRecentsRoute, testbedProjectsRoute, makeClient } from "../../api/routes.js";

export type Scope = { kind: "global" } | { kind: "project"; root: string; label: string };

function basename(p: string): string { return p.replace(/\/+$/, "").split("/").pop() || p; }

// Shared Global/Project scope switch for Optimize + Setup. Lists the same
// recents+candidates that Insights/Rubrics use (testbedRecentsRoute /
// testbedProjectsRoute), deduped by path and capped to 40 rows.
export function ScopePicker({ apiBase, scope, onScope }: { apiBase: string; scope: Scope; onScope: (s: Scope) => void }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<{ root: string; label: string }[]>([]);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    const client = makeClient(apiBase);
    Promise.all([
      testbedRecentsRoute.call(client).then((r) => r.recents.map((x) => ({ root: x.path, label: x.name }))).catch(() => []),
      testbedProjectsRoute.call(client).then((r) => r.projects.map((x) => ({ root: x.path, label: basename(x.path) }))).catch(() => []),
    ]).then(([recents, projects]) => {
      if (!alive) return;
      const seen = new Set<string>();
      const merged = [...recents, ...projects].filter((r) => (seen.has(r.root) ? false : (seen.add(r.root), true))).slice(0, 40);
      setRows(merged);
    });
    return () => { alive = false; };
  }, [open, apiBase]);

  const filtered = rows.filter((r) => !q || r.root.toLowerCase().includes(q.toLowerCase()));

  return (
    <div className="scope-picker">
      <button className={"obs-range-btn" + (scope.kind === "global" ? " is-active" : "")} onClick={() => onScope({ kind: "global" })}>Global</button>
      <button className={"obs-range-btn" + (scope.kind === "project" ? " is-active" : "")} onClick={() => setOpen((o) => !o)}>
        {scope.kind === "project" ? `Project: ${scope.label}` : "Project"} ▾
      </button>
      {open && (
        <div className="scope-menu">
          <input aria-label="search projects" placeholder="Search projects…" value={q} onChange={(e) => setQ(e.target.value)} />
          <ul>
            {filtered.map((r) => (
              <li key={r.root}>
                <button onClick={() => { onScope({ kind: "project", root: r.root, label: r.label }); setOpen(false); }}>{r.root}</button>
              </li>
            ))}
            {filtered.length === 0 && <li className="obs-muted">No projects.</li>}
          </ul>
        </div>
      )}
    </div>
  );
}
