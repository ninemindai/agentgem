import { useEffect, useState } from "react";
import { defineConsolePage } from "../../registry.js";
import { workspacesRoute, makeClient, type WorkspaceSummary } from "../../api/routes.js";

/** Count chips shown per workspace, in display order. */
export function countChips(ws: WorkspaceSummary): { label: string; n: number }[] {
  const c = ws.artifactCounts;
  return [
    { label: "skills", n: c.skill },
    { label: "MCP", n: c.mcp_server },
    { label: "instructions", n: c.instructions },
    { label: "hooks", n: c.hook },
    { label: "checks", n: ws.checks },
  ];
}

export function Workspaces({ apiBase }: { apiBase: string }) {
  const [items, setItems] = useState<WorkspaceSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const client = makeClient(apiBase);
    (async () => {
      try {
        const { workspaces } = await workspacesRoute.call(client);
        if (alive) setItems(workspaces);
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => { alive = false; };
  }, [apiBase]);

  if (error) return <p className="ledger-error">Could not load workspaces: {error}</p>;
  if (!items) return <p className="ledger-loading">Loading…</p>;
  if (items.length === 0) return <p className="ledger-empty">No saved workspaces yet.</p>;

  return (
    <div className="ws-list">
      {items.map((ws) => (
        <article className="ws-card" key={ws.name}>
          <header className="ws-head">
            <span className="ws-name">{ws.name}</span>
            <span className="ws-gem">{ws.gemName}@{ws.version}</span>
          </header>
          <div className="ws-meta">
            {countChips(ws).map((c) => (
              <span className="ws-chip" key={c.label}>{c.n} {c.label}</span>
            ))}
          </div>
          {ws.renderedTargets.length > 0 && (
            <div className="ws-targets">
              {ws.renderedTargets.map((t) => (
                <span className="ws-target" key={t}>{t}</span>
              ))}
            </div>
          )}
        </article>
      ))}
    </div>
  );
}

export const workspacesPage = defineConsolePage({
  id: "workspaces",
  title: "Workspaces",
  icon: "▦",
  order: 20,
  route: "#/workspaces",
  component: ({ apiBase }) => <Workspaces apiBase={apiBase} />,
});
