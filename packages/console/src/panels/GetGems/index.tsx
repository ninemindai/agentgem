import { useEffect, useState } from "react";
import {
  installHostedRoute,
  gemApplyRoute,
  makeClient,
} from "../../api/routes.js";

export function GetGems({ apiBase }: { apiBase: string }) {
  const [error, setError] = useState<string | null>(null);
  const [installed, setInstalled] = useState<Record<string, string>>({});
  const [consentFor, setConsentFor] = useState<string | null>(null); // gem key awaiting executable-artifact consent
  const [directKey, setDirectKey] = useState<string | null>(null); // deep-link "?install=<key>" direct install
  const [directVersion, setDirectVersion] = useState("");
  const [importDir, setImportDir] = useState(""); // target dir for "Import a .gem file"
  const [importStatus, setImportStatus] = useState<string | null>(null);

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
  //    consent-gated).
  // Absent that, this is a no-op. Hash-reactive, not mount-only: when this tab is already open and
  // the hash gains a `?install=` (a mid-session "Open in AgentGem"), the deep-link must still fire.
  useEffect(() => {
    const applyDeepLink = () => {
      const params = new URLSearchParams(window.location.hash.split("?")[1] ?? "");
      const installKey = params.get("install");
      if (installKey) { setDirectKey(installKey); setDirectVersion(params.get("v") ?? ""); void install(installKey, params.get("v") ?? ""); }
    };
    applyDeepLink();
    window.addEventListener("hashchange", applyDeepLink);
    return () => window.removeEventListener("hashchange", applyDeepLink);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Import a .gem file downloaded from the marketplace: read the file → base64 → apply into the
  // chosen dir (reuses the same /gem/apply path the Received panel uses for redeemed tickets).
  async function importGemFile(file: File) {
    if (!importDir.trim()) { setImportStatus("Choose a target directory first."); return; }
    setImportStatus(`Importing ${file.name}…`);
    try {
      const buf = new Uint8Array(await file.arrayBuffer());
      let bin = ""; for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
      const client = makeClient(apiBase);
      const { dir, name, written, skipped } = await gemApplyRoute.call(client, { body: { bytesBase64: btoa(bin), dir: importDir.trim() } });
      const skip = skipped.length ? ` (${skipped.length} skipped)` : "";
      setImportStatus(`✓ Imported ${name} → ${dir} — ${written.length} file(s)${skip}`);
    } catch (e) {
      setImportStatus("Import failed: " + (e instanceof Error ? e.message : String(e)));
    }
  }

  // "Import a .gem file" — a downloaded file needs no marketplace round-trip, so it always renders,
  // like the deep-link banner.
  const importCard = (
    <div className="getgems-import ws-card">
      <div className="ws-name">Import a .gem file</div>
      <p className="getgems-import-hint">Downloaded a <code>.gem</code> from app.agentgem.ai? Apply it into a project directory.</p>
      <input className="ledger-search" type="text" aria-label="target directory" placeholder="target directory (e.g. ~/my-project)"
        value={importDir} onChange={(e) => setImportDir((e.target as HTMLInputElement).value)} />
      <input type="file" accept=".gem" aria-label="choose a .gem file"
        onChange={(e) => { const f = (e.target as HTMLInputElement).files?.[0]; if (f) void importGemFile(f); (e.target as HTMLInputElement).value = ""; }} />
      {importStatus && <div className="getgems-import-status">{importStatus}</div>}
    </div>
  );

  // The deep-link install banner (hosted install is zero-config).
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

  return (
    <div className="getgems">
      {directBanner}
      {importCard}
      {!directKey && (
        <div className="getgems-empty">
          <h3 className="getgems-empty-title">Browse the marketplace</h3>
          <p className="getgems-empty-text">
            Find shared gems on <a href="https://app.agentgem.ai" target="_blank" rel="noreferrer">app.agentgem.ai</a> —
            “Open in AgentGem” installs them into a workspace here, or download a <code>.gem</code> and import it above.
          </p>
        </div>
      )}
    </div>
  );
}
