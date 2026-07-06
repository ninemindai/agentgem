import { useEffect, useState } from "react";
import { defineConsolePage } from "../../registry.js";
import { inventoryRoute, makeClient, type Inventory, type Artifact } from "../../api/routes.js";
import { Loading } from "../../shell/Loading.js";
import { ContentView } from "../Curate/ContentView.js";

// Read-only browser of the local .claude setup — the artifacts your agents run with.
// Everything (incl. each skill/subagent's SKILL.md `content`) comes from one /api/inventory
// scan, so the viewer just shows what's already loaded; no per-artifact fetch.
const GROUPS: { key: keyof Inventory; label: string }[] = [
  { key: "skills", label: "Skills" },
  { key: "subagents", label: "Subagents" },
  { key: "mcpServers", label: "MCP servers" },
  { key: "hooks", label: "Hooks" },
  { key: "instructions", label: "Instructions" },
];

const initialQuery = () => new URLSearchParams(window.location.hash.split("?")[1] ?? "").get("q") ?? "";

export function Setup({ apiBase }: { apiBase: string }) {
  const [inv, setInv] = useState<Inventory | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState(initialQuery);
  const [selected, setSelected] = useState<{ artifact: Artifact; group: string } | null>(null);
  const [open, setOpen] = useState<Record<string, boolean>>({});

  useEffect(() => {
    let alive = true;
    inventoryRoute.call(makeClient(apiBase))
      .then((i) => { if (alive) setInv(i); })
      .catch((e) => { if (alive) setError(String(e?.message ?? e)); });
    return () => { alive = false; };
  }, [apiBase]);

  if (error) return <div className="obs"><p className="obs-error">Couldn't load setup: {error}</p></div>;
  if (!inv) return <div className="obs"><Loading /></div>;

  const needle = q.trim().toLowerCase();
  const match = (a: Artifact) =>
    !needle || a.name.toLowerCase().includes(needle) ||
    (a.source ?? "").toLowerCase().includes(needle) ||
    (a.description ?? "").toLowerCase().includes(needle);

  const filtering = needle.length > 0;
  const groups = GROUPS.map((g) => ({ ...g, items: ((inv[g.key] as Artifact[]) ?? []).filter(match) }))
    .filter((g) => g.items.length > 0);
  // Groups collapse by default (the Skills group alone is hundreds of items); a filter
  // force-expands every group so matches are always visible.
  const isOpen = (key: string) => filtering || !!open[key];

  return (
    <div className="setup">
      <div className="obs-head">
        <h2 className="obs-title">Setup</h2>
        <div className="setup-search">
          <span aria-hidden="true">🔎</span>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter your setup" aria-label="Filter setup" />
        </div>
      </div>

      {groups.length === 0 ? (
        <p className="obs-muted setup-empty">No artifacts match “{q}”.</p>
      ) : groups.map((g) => (
        <section key={String(g.key)} className="setup-group">
          <button type="button" className="setup-group-head" aria-expanded={isOpen(String(g.key))}
            onClick={() => setOpen((p) => ({ ...p, [String(g.key)]: !p[String(g.key)] }))}>
            <span className="setup-caret">{isOpen(String(g.key)) ? "▾" : "▸"}</span>
            <span className="console-group-label">{g.label}</span>
            <span className="setup-count">{g.items.length}</span>
          </button>
          {isOpen(String(g.key)) && (
            <ul className="setup-list">
              {g.items.map((a) => (
                <li key={a.name}>
                  <button type="button" className="setup-item" onClick={() => setSelected({ artifact: a, group: g.label })}>
                    <span className="setup-item-name">{a.name}</span>
                    {a.source ? <span className="setup-item-source">{a.source}</span> : null}
                    {a.description ? <span className="setup-item-desc">{a.description}</span> : null}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      ))}

      {selected ? <ArtifactViewer sel={selected} onClose={() => setSelected(null)} /> : null}
    </div>
  );
}

function ArtifactViewer({ sel, onClose }: { sel: { artifact: Artifact; group: string }; onClose: () => void }) {
  const a = sel.artifact;
  return (
    <div className="setup-modal" role="dialog" aria-modal="true" aria-label={a.name} onClick={onClose}>
      <div className="setup-modal-panel" onClick={(e) => e.stopPropagation()}>
        <div className="setup-modal-head">
          <div className="setup-modal-title">
            <strong>{a.name}</strong>
            {a.source ? <span className="setup-item-source">{a.source}</span> : null}
            <span className="obs-muted"> · {sel.group}</span>
          </div>
          <button type="button" className="setup-modal-close" onClick={onClose} aria-label="Close">✕</button>
        </div>
        {a.description ? <p className="setup-modal-desc">{a.description}</p> : null}
        <div className="setup-modal-body">
          {/* Skills/subagents/instructions ship markdown content; MCP/hooks show their config. */}
          {a.content
            ? <ContentView text={a.content} />
            : <pre className="setup-config">{a.config ? JSON.stringify(a.config, null, 2) : "(no file body for this artifact)"}</pre>}
        </div>
      </div>
    </div>
  );
}

export const setupPage = defineConsolePage({
  id: "setup", title: "Setup", icon: "🧩", order: 5, phase: "observe", category: "setup",
  route: "#/setup", component: Setup,
});
