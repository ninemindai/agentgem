import { useCallback, useEffect, useState } from "react";
import { defineConsolePage } from "../../registry.js";
import {
  workspacesRoute, deleteWorkspaceRoute, renderWorkspaceRoute,
  makeClient, TARGET_IDS, type WorkspaceSummary,
} from "../../api/routes.js";
import { WorkspaceDeploy } from "./WorkspaceDeploy.js";

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

  const reload = useCallback(async () => {
    try {
      const { workspaces } = await workspacesRoute.call(makeClient(apiBase));
      setItems(workspaces);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [apiBase]);

  useEffect(() => { void reload(); }, [reload]);

  if (error) return <p className="ledger-error">Could not load workspaces: {error}</p>;
  if (!items) return <p className="ledger-loading">Loading…</p>;
  if (items.length === 0) return <p className="ledger-empty">No saved workspaces yet.</p>;

  return (
    <div className="ws-list">
      {items.map((ws) => (
        <WorkspaceCard key={ws.name} apiBase={apiBase} ws={ws} onChange={reload} />
      ))}
    </div>
  );
}

function WorkspaceCard({ apiBase, ws, onChange }: { apiBase: string; ws: WorkspaceSummary; onChange: () => void }) {
  const [target, setTarget] = useState<string>("claude");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const render = async () => {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const r = await renderWorkspaceRoute.call(makeClient(apiBase), { body: { name: ws.name, target } });
      setNote(`rendered ${target} → ${r.path}`);
      onChange();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      await deleteWorkspaceRoute.call(makeClient(apiBase), { body: { name: ws.name } });
      onChange();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <article className="ws-card">
      <header className="ws-head">
        <span className="ws-name">{ws.name}</span>
        <span className="ws-gem">{ws.gemName}@{ws.version}</span>
      </header>
      <div className="ws-meta">
        {countChips(ws).map((c) => <span className="ws-chip" key={c.label}>{c.n} {c.label}</span>)}
      </div>
      {ws.renderedTargets.length > 0 && (
        <div className="ws-targets">
          {ws.renderedTargets.map((t) => <span className="ws-target" key={t}>{t}</span>)}
        </div>
      )}
      <div className="ws-actions">
        <select className="targets-select" aria-label={`render target for ${ws.name}`} value={target} onChange={(e) => setTarget(e.target.value)}>
          {TARGET_IDS.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <button type="button" className="ledger-sort" disabled={busy} onClick={render}>Render</button>
        <button type="button" className="ws-delete" disabled={busy} onClick={remove}>Delete</button>
      </div>
      {note && <p className="ws-note">{note}</p>}
      {error && <p className="ledger-error">{error}</p>}
      <WorkspaceDeploy apiBase={apiBase} name={ws.name} />
    </article>
  );
}

export const workspacesPage = defineConsolePage({
  id: "workspaces",
  title: "Workspaces",
  icon: "▦",
  order: 20,
  group: "library",
  route: "#/workspaces",
  component: ({ apiBase }) => <Workspaces apiBase={apiBase} />,
});
