import { useEffect, useRef, useState } from "react";
import { useActiveGem, setName, setKeys, resetGem } from "../activeGem.js";
import { workspacesRoute, makeClient, type WorkspaceSummary } from "../api/routes.js";
import { includeToKeys } from "../panels/Curate/selection.js";

const RECENT = 6;

/** Active-Gem label: a saved gem's name, else "New Gem" — with an artifact count
 *  only once something is selected (a bare "· 0" reads as cryptic). */
export function gemLabel(name: string, count: number): string {
  if (name) return name;
  return count > 0 ? `New Gem · ${count} artifact${count === 1 ? "" : "s"}` : "New Gem";
}

/** The pinned active Gem at the top of the sidebar, doubling as a switcher:
 *  click to drop down your most-recent saved gems and jump between them. */
export function ActiveGemSwitcher({ apiBase }: { apiBase: string }) {
  const { keys, name } = useActiveGem();
  const [open, setOpen] = useState(false);
  const [gems, setGems] = useState<WorkspaceSummary[]>([]);
  const wrap = useRef<HTMLDivElement>(null);

  // Fetch recent gems each time the menu opens, so it reflects newly-saved ones.
  useEffect(() => {
    if (!open) return;
    let alive = true;
    workspacesRoute.call(makeClient(apiBase))
      .then((r) => { if (alive) setGems(r.workspaces); })
      .catch(() => { if (alive) setGems([]); });
    return () => { alive = false; };
  }, [open, apiBase]);

  // Dismiss on outside click or Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open]);

  const go = (hash: string) => { window.location.hash = hash; setOpen(false); };
  const openGem = (g: WorkspaceSummary) => {
    setName(g.name);
    setKeys(new Set(includeToKeys(g.artifacts)));
    go("#/curate");
  };
  const newGem = () => { resetGem(); go("#/curate"); };

  const recent = gems.slice(0, RECENT);

  return (
    <div className="console-switcher" ref={wrap}>
      <button
        type="button"
        className="console-activegem"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="console-activegem-label">{gemLabel(name, keys.size)}</span>
        <svg className="console-activegem-caret" viewBox="0 0 12 12" aria-hidden="true">
          <path d="M3 4.5 6 7.5 9 4.5" stroke="currentColor" strokeWidth="1.3" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div className="console-switcher-menu" role="menu">
          <div className="console-switcher-head">Recent gems</div>
          {recent.length === 0 && <div className="console-switcher-empty">No saved gems yet</div>}
          {recent.map((g) => (
            <button type="button" key={g.name} className="console-switcher-item" role="menuitem" onClick={() => openGem(g)}>
              <span className="console-switcher-name">{g.name}</span>
              <span className="console-switcher-meta">{g.artifacts.length}</span>
            </button>
          ))}
          <div className="console-switcher-sep" />
          <button type="button" className="console-switcher-item is-action" role="menuitem" onClick={newGem}>＋ New Gem</button>
          <button type="button" className="console-switcher-item is-action" role="menuitem" onClick={() => go("#/your-gems")}>Browse all →</button>
        </div>
      )}
    </div>
  );
}
