import { useEffect, useState } from "react";
import { saveProvider, pull, type ProviderRow, type ProviderCfg } from "./api.js";

/** One provider connection row: API-key input + enable toggle + Save & test + Pull now.
 *  Everything except the status badge is disabled for a not-yet-implemented provider. */
export function ProviderItem({ apiBase, row, onChanged }: { apiBase: string; row: ProviderRow; onChanged: () => void }) {
  const [apiKey, setApiKey] = useState("");
  const [enabled, setEnabled] = useState(row.enabled);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  // Re-sync the toggle when the parent reloads the provider list (e.g. after Save & test).
  useEffect(() => { setEnabled(row.enabled); }, [row.enabled]);

  const disabled = !row.implemented;

  const save = async () => {
    setBusy(true); setNote(null);
    try {
      const cfg: ProviderCfg = { enabled, apiKey };
      const r = await saveProvider(apiBase, row.id, cfg);
      setNote(r.ok ? "connected" : (r.detail ?? "failed"));
      onChanged();
    } catch {
      setNote("failed — check the key and try again");
    } finally {
      setBusy(false);
    }
  };

  const pullNow = async () => {
    setBusy(true); setNote("pulling…");
    try {
      const r = await pull(apiBase, row.id);
      setNote(`pulled ${r.pulled}`);
    } catch {
      setNote("pull failed");
    } finally {
      setBusy(false);
    }
  };

  const toggleEnabled = async (next: boolean) => {
    setEnabled(next);
    setBusy(true); setNote(next ? "enabling…" : "disabling…");
    try {
      // Toggle ONLY changes `enabled` — send a blank key so the backend preserves the stored one.
      // A key is set/rotated exclusively via the explicit "Save & test" button, so flipping the
      // toggle can never accidentally commit (and clobber the stored key with) an unsaved field value.
      const r = await saveProvider(apiBase, row.id, { enabled: next, apiKey: "" });
      setNote(r.ok ? (next ? "enabled" : "disabled") : (r.detail ?? "failed"));
      onChanged();
    } catch {
      setEnabled(!next); // revert optimistic toggle
      setNote("failed — try again");
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className="ws-card">
      <header className="ws-head">
        <span className="ws-name">{row.id}</span>
        <span className={"deploy-badge " + (row.connected ? "is-ready" : "is-unready")}>
          {disabled ? "coming soon" : row.connected ? "connected" : "not connected"}
        </span>
      </header>
      <div className="ledger-bar">
        <input
          className="ledger-search"
          type="password"
          aria-label={`${row.id} api key`}
          placeholder="API key"
          value={apiKey}
          disabled={disabled}
          onChange={(e) => setApiKey(e.target.value)}
        />
        <label className="ledger-usedonly">
          <input type="checkbox" checked={enabled} disabled={disabled || busy} onChange={(e) => void toggleEnabled(e.target.checked)} /> Enabled
        </label>
        <button type="button" className="ledger-sort" disabled={disabled || busy} onClick={() => void save()}>Save &amp; test</button>
        <button type="button" className="ledger-sort" disabled={disabled || !row.enabled || busy} onClick={() => void pullNow()}>Pull now</button>
        {note && <span className="ws-note">{note}</span>}
      </div>
    </article>
  );
}
