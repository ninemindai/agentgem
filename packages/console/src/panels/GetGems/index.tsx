import { useEffect, useState } from "react";
import { defineConsolePage } from "../../registry.js";
import {
  registryReadyRoute,
  registrySearchRoute,
  installHostedRoute,
  makeClient,
  type RegistryResult,
} from "../../api/routes.js";
import { Loading } from "../../shell/Loading.js";

export function GetGems({ apiBase }: { apiBase: string }) {
  const [ready, setReady] = useState<boolean | null>(null);
  const [q, setQ] = useState("");
  const [results, setResults] = useState<RegistryResult[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [installed, setInstalled] = useState<Record<string, string>>({});
  const [consentFor, setConsentFor] = useState<string | null>(null); // gem key awaiting executable-artifact consent
  const [directKey, setDirectKey] = useState<string | null>(null); // deep-link "?install=<key>" direct install
  const [directVersion, setDirectVersion] = useState("");

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

  // Zero-config hosted install. Executable artifacts (MCP servers / hooks) require a consent step:
  // the first attempt (consent=false) is refused with a 409 that flips the card to a confirm; the
  // confirm retries with consent=true.
  const install = async (key: string, version: string, consent = false) => {
    setError(null);
    try {
      const client = makeClient(apiBase);
      const res = await installHostedRoute.call(client, { body: { key, version, consent } });
      setConsentFor(null);
      setInstalled((m) => ({ ...m, [key]: res.workspace }));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!consent && /consent/i.test(msg)) { setConsentFor(key); return; }
      setError(msg);
    }
  };

  // Deep-link entry (the marketplace "Open in AgentGem" link) on mount:
  //  - "?install=<key>&v=<version>" → directly install that shared gem (zero-config hosted install,
  //    consent-gated). Works even when the local registry search isn't configured.
  //  - "?q=<term>" → pre-fill + run the registry search once.
  // Absent both, this is a no-op, so the default "does not auto-search on mount" behaviour holds.
  useEffect(() => {
    const params = new URLSearchParams(window.location.hash.split("?")[1] ?? "");
    const installKey = params.get("install");
    if (installKey) { setDirectKey(installKey); setDirectVersion(params.get("v") ?? ""); void install(installKey, params.get("v") ?? ""); return; }
    const q0 = params.get("q");
    if (q0) { setQ(q0); void search(q0); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The deep-link install banner is independent of registry-search readiness (hosted install is
  // zero-config), so it renders before the not-configured gate.
  const directBanner = directKey ? (
    <div className="getgems-direct ws-card">
      <span className="ws-name">{directKey}</span>
      {installed[directKey] ? (
        <span className="getgems-done">✓ installed → {installed[directKey]}</span>
      ) : consentFor === directKey ? (
        <span className="getgems-consent">
          ⚠ This setup runs executable artifacts (MCP servers / hooks).
          <button type="button" className="ledger-sort" onClick={() => install(directKey, directVersion, true)}>Install anyway</button>
        </span>
      ) : error ? (
        <span className="ledger-error">{error}</span>
      ) : (
        <span>Installing…</span>
      )}
    </div>
  ) : null;

  if (ready === null && !directKey) return <Loading />;
  if (!ready) {
    return (
      <div className="getgems">
        {directBanner}
        {!directKey && (
          <p className="ledger-empty">
            Registry not configured. Set the registry source (GitHub repo + token) to search and install shared gems.
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="getgems">
      {directBanner}
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
                {r.publishedBy
                  ? <a className="ws-chip" href={"https://app.agentgem.ai/@" + encodeURIComponent(r.publishedBy)} target="_blank" rel="noreferrer">@{r.publishedBy}</a>
                  : (r.author && <span className="ws-chip">{r.author}</span>)}
                {(r.tags ?? []).map((t) => <span className="ws-chip" key={t}>{t}</span>)}
                {[...new Set(r.artifactKinds ?? [])].map((k) => <span className="ws-chip" key={"k-" + k}>{k}</span>)}
              </div>
              <div className="ws-targets">
                {installed[r.key] ? (
                  <span className="getgems-done">✓ installed → {installed[r.key]}</span>
                ) : consentFor === r.key ? (
                  <span className="getgems-consent">
                    ⚠ This setup runs executable artifacts (MCP servers / hooks).
                    <button type="button" className="ledger-sort" onClick={() => install(r.key, r.latest, true)}>Install anyway</button>
                    <button type="button" className="ledger-sort" onClick={() => setConsentFor(null)}>Cancel</button>
                  </span>
                ) : (
                  <button type="button" className="ledger-sort" onClick={() => install(r.key, r.latest)}>Install to workspace</button>
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
