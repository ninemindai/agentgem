import { useEffect, useState } from "react";
import { defineConsolePage } from "../../registry.js";
import {
  registryReadyRoute,
  registrySearchRoute,
  registryInstallRoute,
  makeClient,
  type RegistryResult,
} from "../../api/routes.js";
import { takePendingQuery } from "./intent.js";

export function GetGems({ apiBase }: { apiBase: string }) {
  const [ready, setReady] = useState<boolean | null>(null);
  const [q, setQ] = useState("");
  const [results, setResults] = useState<RegistryResult[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [installed, setInstalled] = useState<Record<string, string>>({});
  const [pending] = useState<string | null>(() => takePendingQuery()); // one-shot, captured at mount

  useEffect(() => {
    let alive = true;
    const client = makeClient(apiBase);
    registryReadyRoute.call(client)
      .then((r) => { if (alive) setReady(r.ready); })
      .catch(() => { if (alive) setReady(false); });
    return () => { alive = false; };
  }, [apiBase]);

  const search = async (term?: string) => {
    setBusy(true);
    setError(null);
    try {
      const client = makeClient(apiBase);
      const query = (term ?? q).trim();
      const { results: r } = await registrySearchRoute.call(client, { query: { q: query || undefined } });
      setResults(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!pending) return;
    setQ(pending);
    if (ready) void search(pending);
    // run only when `ready` flips; `pending` is captured once at mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  const install = async (key: string) => {
    setError(null);
    try {
      const client = makeClient(apiBase);
      const { applied } = await registryInstallRoute.call(client, { body: { refs: [key], mode: "workspace" } });
      setInstalled((m) => ({ ...m, [key]: applied.workspace ?? "workspace" }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  if (ready === null) return <p className="ledger-loading">Loading…</p>;
  if (!ready) {
    return (
      <p className="ledger-empty">
        Registry not configured. Set the registry source (GitHub repo + token) to search and install shared gems.
      </p>
    );
  }

  return (
    <div className="getgems">
      <div className="ledger-bar">
        <input
          className="ledger-search"
          type="text"
          aria-label="search registry"
          placeholder="search names, tags, descriptions…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") void search(); }}
        />
        <button type="button" className="ledger-sort" disabled={busy} onClick={() => void search()}>
          {busy ? "Searching…" : "Search"}
        </button>
      </div>

      {error && <p className="ledger-error">{error}</p>}

      {results && results.length === 0 && <p className="ledger-empty">No gems matched.</p>}

      {results && results.length > 0 && (
        <div className="ws-list">
          {results.map((r) => (
            <article className="ws-card" key={r.key}>
              <header className="ws-head">
                <span className="ws-name">{r.key}</span>
                <span className="ws-gem">{r.latest}</span>
              </header>
              {r.description && <p className="getgems-desc">{r.description}</p>}
              <div className="ws-meta">
                {r.author && <span className="ws-chip">{r.author}</span>}
                {(r.tags ?? []).map((t) => <span className="ws-chip" key={t}>{t}</span>)}
                {(r.artifactKinds ?? []).map((k) => <span className="ws-chip" key={"k-" + k}>{k}</span>)}
              </div>
              <div className="ws-targets">
                {installed[r.key] ? (
                  <span className="getgems-done">✓ installed → {installed[r.key]}</span>
                ) : (
                  <button type="button" className="ledger-sort" onClick={() => install(r.key)}>Install to workspace</button>
                )}
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}

export const getGemsPage = defineConsolePage({
  id: "get-gems",
  title: "Get Gems",
  icon: "⬇",
  order: 30,
  group: "library",
  route: "#/get-gems",
  component: ({ apiBase }) => <GetGems apiBase={apiBase} />,
});
