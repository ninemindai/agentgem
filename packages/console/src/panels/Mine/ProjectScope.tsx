import { useEffect, useRef, useState } from "react";
import { testbedRecentsRoute, testbedProjectsRoute, makeClient, type RecentEntry, type ProjectCandidate } from "../../api/routes.js";

function short(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts.length > 3 ? "…/" + parts.slice(-3).join("/") : path;
}

/** Shared project selector for the Mine tab — a compact dropdown so it doesn't
 *  dominate the tab the way a full inline list would. "All projects" (root "*")
 *  leads the list; both the Workflows and Outcomes views scope to the chosen
 *  project. Styled with its own `mine-scope-*` classes (distinct from the shared
 *  `.scope-menu` used by Optimize/Setup) so it can be tuned independently. */
export function ProjectScope({ apiBase, scope, onChange }: { apiBase: string; scope: string; onChange: (scope: string) => void }) {
  const [open, setOpen] = useState(false);
  const [projects, setProjects] = useState<ProjectCandidate[] | null>(null);
  const [recents, setRecents] = useState<RecentEntry[] | null>(null);
  const [query, setQuery] = useState("");
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const client = makeClient(apiBase);
    testbedProjectsRoute.call(client).then((r) => setProjects(r.projects)).catch(() => setProjects([]));
    testbedRecentsRoute.call(client).then((r) => setRecents(r.recents)).catch(() => setRecents([]));
  }, [apiBase]);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false); };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  const rows = (() => {
    const seen = new Set<string>();
    const acc: { path: string; flavor: string; label: string }[] = [];
    for (const r of recents ?? []) { if (!seen.has(r.path)) { seen.add(r.path); acc.push({ path: r.path, flavor: r.flavor, label: r.name }); } }
    for (const p of projects ?? []) { if (!seen.has(p.path)) { seen.add(p.path); acc.push({ path: p.path, flavor: p.flavor, label: short(p.path) }); } }
    const q = query.trim().toLowerCase();
    const matched = q ? acc.filter((r) => r.label.toLowerCase().includes(q) || r.path.toLowerCase().includes(q)) : acc;
    return [{ path: "*", flavor: "all", label: "All projects" }, ...matched.slice(0, 40)];
  })();

  const currentLabel = scope === "*" ? "All projects" : short(scope);
  const pick = (path: string) => { onChange(path); setOpen(false); setQuery(""); };

  return (
    <div className="mine-scope" ref={wrap}>
      <button type="button" className="mine-scope-trigger" aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className="mine-scope-current">{currentLabel}</span>
        <span className="mine-scope-caret" aria-hidden="true">▾</span>
      </button>
      {open && (
        <div className="mine-scope-menu">
          <input
            type="text"
            placeholder="search projects…"
            aria-label="search projects"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <ul className="mine-scope-list">
            {rows.map((r) => (
              <li key={r.path}>
                <button
                  type="button"
                  className={"mine-scope-row" + (scope === r.path ? " is-active" : "")}
                  aria-pressed={scope === r.path}
                  onClick={() => pick(r.path)}
                >
                  <span className="mine-scope-name">{r.label}</span>
                  <span className="ws-chip">{r.flavor}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
