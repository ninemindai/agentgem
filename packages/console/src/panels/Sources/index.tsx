import { useEffect, useState } from "react";
import { defineConsolePage } from "../../registry.js";
import {
  sourcesListRoute,
  sourceDivisionsRoute,
  sourceAgentsRoute,
  sourceAgentRoute,
  sourceInstallRoute,
  makeClient,
  type CuratedSource,
  type SourceDivision,
  type SourceAgentRef,
  type SourceAgentEntry,
} from "../../api/routes.js";
import { Loading } from "../../shell/Loading.js";

// Browse curated external sources (repos of persona/skill markdown that bootstrap the Gem
// registry) → division → agent → preview, then Install the persona as a local skill so it flows
// into Curate → build → publish. All fetches are server-proxied; no GitHub auth needed for public
// sources. Selecting a source loads its divisions; selecting a division loads its agents.
export function Sources({ apiBase }: { apiBase: string }) {
  const [sources, setSources] = useState<CuratedSource[] | null>(null);
  const [sourceId, setSourceId] = useState<string>("");
  const [divisions, setDivisions] = useState<SourceDivision[] | null>(null);
  const [division, setDivision] = useState<string>("");
  const [agents, setAgents] = useState<SourceAgentRef[] | null>(null);
  const [preview, setPreview] = useState<SourceAgentEntry | null>(null);
  const [installed, setInstalled] = useState<Record<string, string>>({}); // path -> skill name
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 1. Load the curated source list once; auto-select the first.
  useEffect(() => {
    let alive = true;
    sourcesListRoute.call(makeClient(apiBase))
      .then((r) => { if (!alive) return; setSources(r.sources); setSourceId((id) => id || r.sources[0]?.id || ""); })
      .catch((e) => { if (alive) setError(e instanceof Error ? e.message : String(e)); });
    return () => { alive = false; };
  }, [apiBase]);

  // 2. When the source changes, load its divisions and reset the deeper selections.
  useEffect(() => {
    if (!sourceId) return;
    let alive = true;
    setDivisions(null); setDivision(""); setAgents(null); setPreview(null); setError(null);
    sourceDivisionsRoute.call(makeClient(apiBase), { query: { source: sourceId } })
      .then((r) => { if (alive) setDivisions(r.divisions); })
      .catch((e) => { if (alive) setError(e instanceof Error ? e.message : String(e)); });
    return () => { alive = false; };
  }, [apiBase, sourceId]);

  // 3. When the division changes, load its agents.
  useEffect(() => {
    if (!sourceId || !division) return;
    let alive = true;
    setAgents(null); setPreview(null);
    sourceAgentsRoute.call(makeClient(apiBase), { query: { source: sourceId, division } })
      .then((r) => { if (alive) setAgents(r.agents); })
      .catch((e) => { if (alive) setError(e instanceof Error ? e.message : String(e)); });
    return () => { alive = false; };
  }, [apiBase, sourceId, division]);

  const showAgent = async (a: SourceAgentRef) => {
    setError(null);
    try {
      setPreview(await sourceAgentRoute.call(makeClient(apiBase), { query: { source: sourceId, path: a.path } }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const install = async (path: string) => {
    setBusy(true); setError(null);
    try {
      const { skill } = await sourceInstallRoute.call(makeClient(apiBase), { body: { source: sourceId, path } });
      setInstalled((m) => ({ ...m, [path]: skill }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (sources === null && !error) return <Loading />;
  const source = sources?.find((s) => s.id === sourceId);

  return (
    <div className="getgems">
      {sources && sources.length > 1 && (
        <div className="ledger-bar">
          <select className="ledger-search" aria-label="source" value={sourceId} onChange={(e) => setSourceId(e.target.value)}>
            {sources.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>
        </div>
      )}

      {source && (
        <p className="getgems-desc">
          {source.description}
          {source.license && <span className="ws-chip" style={{ marginLeft: 8 }}>{source.license}</span>}
          {source.homepage && <> · <a href={source.homepage} target="_blank" rel="noreferrer">{source.repo}</a></>}
        </p>
      )}

      {error && <p className="ledger-error">{error}</p>}

      {/* Divisions as colored chips (color/label from the source's divisions.json). */}
      {divisions && (
        <div className="ws-meta" style={{ marginBottom: 12 }}>
          {divisions.map((d) => (
            <button
              type="button"
              key={d.key}
              className="ws-chip"
              onClick={() => setDivision(d.key)}
              style={division === d.key
                ? { background: d.color ?? undefined, color: "#fff", borderColor: d.color ?? undefined }
                : { borderColor: d.color ?? undefined }}
            >
              {d.label}
            </button>
          ))}
        </div>
      )}

      {division && agents === null && <Loading />}

      {agents && (
        <div className="ws-list">
          {agents.length === 0 && <p className="ledger-empty">No agents in this division.</p>}
          {agents.map((a) => (
            <article className="ws-card" key={a.path}>
              <header className="ws-head">
                <span className="ws-name">{a.name}</span>
                {installed[a.path] ? (
                  <span className="getgems-done">✓ installed</span>
                ) : (
                  <span style={{ display: "inline-flex", gap: 6 }}>
                    <button type="button" className="ledger-sort" onClick={() => void showAgent(a)}>Preview</button>
                    <button type="button" className="ledger-sort" disabled={busy} onClick={() => void install(a.path)}>Install</button>
                  </span>
                )}
              </header>
              {preview?.path === a.path && (
                <div>
                  <p className="getgems-desc">
                    {preview.emoji && <span style={{ marginRight: 6 }}>{preview.emoji}</span>}
                    {preview.description}
                  </p>
                  {preview.vibe && <p className="getgems-desc" style={{ opacity: 0.75, fontStyle: "italic" }}>{preview.vibe}</p>}
                </div>
              )}
            </article>
          ))}
        </div>
      )}
    </div>
  );
}

export const sourcesPage = defineConsolePage({
  id: "sources",
  title: "Sources",
  icon: "🧩",
  order: 28,
  group: "library",
  route: "#/sources",
  component: ({ apiBase }) => <Sources apiBase={apiBase} />,
});
