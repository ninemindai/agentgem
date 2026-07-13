import { useEffect, useState } from "react";
import {
  contributeSettingRoute, setContributeSettingRoute, contributeRoute, makeClient,
  type ContributeResult,
} from "../../api/routes.js";
import { Loading } from "../../shell/Loading.js";

const STATUS_LABEL: Record<ContributeResult["status"], string> = {
  ingested: "ingested", updated: "updated", skipped: "skipped", failed: "failed",
};

/** Opt-in bulk contribution to the network benchmark above: a consent toggle plus a
 *  one-shot "Contribute now" that signs and posts anonymous ingredient/usage rollups
 *  for the caller's own PUBLISHED Gems. Never per-session content, never per-model
 *  outcomes (those only come from the interactive publish flow, consented each time).
 *  Requires a bound account — contribution is attributable to the producer key
 *  server-side. Off by default; the toggle round-trips through the server config. */
export function Contribute({ apiBase }: { apiBase: string }) {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [settingError, setSettingError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<ContributeResult[] | null>(null);
  const [contributeError, setContributeError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    contributeSettingRoute.call(makeClient(apiBase))
      .then((r) => { if (alive) setEnabled(r.enabled); })
      .catch((e) => { if (alive) setSettingError(e instanceof Error ? e.message : String(e)); });
    return () => { alive = false; };
  }, [apiBase]);

  const toggle = async (next: boolean) => {
    setSettingError(null);
    try {
      const r = await setContributeSettingRoute.call(makeClient(apiBase), { body: { enabled: next } });
      setEnabled(r.enabled);
    } catch (e) {
      setSettingError(e instanceof Error ? e.message : String(e));
    }
  };

  const contribute = async () => {
    setBusy(true);
    setContributeError(null);
    try {
      const r = await contributeRoute.call(makeClient(apiBase));
      setResults(r.results);
    } catch (e) {
      setContributeError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="benchmark-consent">
      <p className="analyze-intro">
        Contribute to this network benchmark: anonymous ingredient/usage data for your{" "}
        <strong>published</strong> Gems, signed by your producer key. Bulk contribution never
        includes per-session content or per-model outcomes — outcomes only come from the
        interactive publish flow, consented each time. Contributing requires a bound account
        (Setup → Identity) and is attributable to your producer key server-side.
      </p>
      {enabled === null && !settingError ? (
        <Loading />
      ) : (
        <div className="benchmark-consent-row">
          <label className="benchmark-consent-toggle">
            <input
              type="checkbox"
              checked={enabled ?? false}
              onChange={(e) => toggle(e.target.checked)}
            /> Contribute to the network benchmark
          </label>
          <button type="button" className="ledger-build" disabled={!enabled || busy} onClick={contribute}>
            {busy ? "Contributing…" : "Contribute now"}
          </button>
        </div>
      )}
      {settingError && <p className="ledger-error" role="alert">{settingError}</p>}
      {contributeError && <p className="ledger-error" role="alert">{contributeError}</p>}
      {results && (
        results.length === 0 ? (
          <p className="ledger-empty">No published Gems to contribute yet.</p>
        ) : (
          <ul className="insights-bymodel benchmark-results">
            {results.map((r, i) => (
              <li key={`${r.gem}-${i}`}>
                <span className="analyze-include-name">{r.gem}</span>
                <span className="benchmark-result-status" data-status={r.status}>{STATUS_LABEL[r.status]}</span>
                {r.reason && <span className="targets-label">{r.reason}</span>}
              </li>
            ))}
          </ul>
        )
      )}
    </div>
  );
}
