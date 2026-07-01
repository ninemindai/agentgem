import { useState } from "react";
import { defineConsolePage } from "../../registry.js";
import { buildGemRoute, archiveRoute, makeClient, transferSendRoute, type Gem } from "../../api/routes.js";
import { buildSelection } from "../Curate/selection.js";
import { useActiveGem } from "../../activeGem.js";
import { base64ToBytes, downloadBlob, copyText } from "./exporters.js";
import { Preview } from "./Preview.js";
import { Targets } from "./Targets.js";
import { Run } from "./Run.js";
export function Materialize({ apiBase }: { apiBase: string }) {
  const { keys, name } = useActiveGem();
  const [gem, setGem] = useState<Gem | null>(null);
  const [building, setBuilding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ticket, setTicket] = useState("");
  const [sendStatus, setSendStatus] = useState("");
  const [copied, setCopied] = useState(false);

  const sel = buildSelection(keys);

  if (keys.size === 0) {
    return (
      <p className="ledger-empty">
        Curate some artifacts first — <a href="#/curate">go to Curate →</a>
      </p>
    );
  }

  const build = async () => {
    setBuilding(true);
    setError(null);
    try {
      const g = await buildGemRoute.call(makeClient(apiBase), { body: { selection: sel, name: name.trim() || "gem" } });
      setGem(g);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBuilding(false);
    }
  };

  const copyJson = () => { if (gem) void copyText(JSON.stringify(gem, null, 2)); };
  const downloadJson = () => { if (gem) downloadBlob(`${gem.name}.json`, "application/json", JSON.stringify(gem, null, 2)); };
  const downloadGem = async () => {
    if (!gem) return;
    const { tarGz } = await archiveRoute.call(makeClient(apiBase), { body: { selection: sel, name: gem.name, tar: true } });
    if (tarGz) downloadBlob(`${gem.name}.gem`, "application/gzip", base64ToBytes(tarGz));
  };

  const shareViaTransfer = async () => {
    setSendStatus("Encrypting & stashing…");
    setTicket("");
    try {
      const { ticket: t } = await transferSendRoute.call(makeClient(apiBase), {
        body: { selection: sel, name: name.trim() || "gem" },
      });
      setTicket(t);
      setSendStatus("Ready — share this one-time ticket:");
    } catch (e) {
      setSendStatus("Failed: " + (e instanceof Error ? e.message : String(e)));
    }
  };

  return (
    <div className="materialize">
      <div className="ledger-selbar">
        <strong className="ledger-selcount">{keys.size} selected</strong>
        <button type="button" className="ledger-build" disabled={building} onClick={build}>
          {building ? "Building…" : "Build Gem"}
        </button>
        {error && <span className="ledger-error">{error}</span>}
      </div>
      {gem && <Preview gem={gem} onDownloadGem={downloadGem} onDownloadJson={downloadJson} onCopyJson={copyJson} />}
      <Targets apiBase={apiBase} selection={sel} name={name.trim() || "gem"} />
      <Run apiBase={apiBase} selection={sel} name={name.trim() || "gem"} />
      <section className="transfer-section">
        <h3 className="transfer-heading">Share via transfer</h3>
        <div className="ledger-bar">
          <button type="button" className="ledger-sort" onClick={() => void shareViaTransfer()}>
            Send via ticket
          </button>
        </div>
        {sendStatus && <p className="transfer-status">{sendStatus}</p>}
        {ticket && (
          <div className="transfer-ticket-row">
            <input
              className="transfer-ticket"
              readOnly
              value={ticket}
              aria-label="transfer ticket"
              onClick={(e) => (e.target as HTMLInputElement).select()}
            />
            <button
              type="button"
              className="transfer-copy"
              aria-label="copy ticket"
              title="Copy ticket"
              onClick={() => {
                void copyText(ticket);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
            >
              {copied ? "✓ Copied" : "⧉ Copy"}
            </button>
          </div>
        )}
      </section>
    </div>
  );
}

export const materializePage = defineConsolePage({
  id: "materialize",
  title: "Materialize",
  icon: "▸",
  order: 20,
  group: "build",
  requiresGem: true,
  route: "#/materialize",
  component: ({ apiBase }) => <Materialize apiBase={apiBase} />,
});
