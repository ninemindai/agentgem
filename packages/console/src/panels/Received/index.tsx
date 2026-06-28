import { useState } from "react";
import { defineConsolePage } from "../../registry.js";
import {
  makeClient,
  transferReceiveRoute,
  transferCiphertextRoute,
} from "../../api/routes.js";
import { decryptGem } from "./decrypt.js";

const b64urlToBytes = (s: string): Uint8Array => {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
};

export function Received({ apiBase }: { apiBase: string }) {
  const [recv, setRecv] = useState("");
  const [recvStatus, setRecvStatus] = useState("");

  async function redeem() {
    if (!recv.trim()) {
      setRecvStatus("Paste a ticket.");
      return;
    }
    setRecvStatus("Redeeming…");
    try {
      const client = makeClient(apiBase);
      const { meta, bytesBase64 } = await transferReceiveRoute.call(client, {
        body: { ticket: recv.trim() },
      });
      const bytes = Uint8Array.from(atob(bytesBase64), (c) => c.charCodeAt(0));
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([bytes], { type: "application/gzip" }));
      a.download = `${meta.name}.gem`;
      a.click();
      setRecvStatus(`✓ Received ${meta.name}@${meta.version} — downloaded ${meta.name}.gem`);
    } catch (e) {
      setRecvStatus("Failed: " + (e instanceof Error ? e.message : String(e)));
    }
  }

  async function redeemPrivately() {
    const raw = recv.trim();
    if (!raw) {
      setRecvStatus("Paste a ticket.");
      return;
    }
    let object = "";
    let key = "";
    try {
      const u = new URL(raw);
      if (u.protocol !== "agentgem:" || u.host !== "gem")
        throw new Error("not an agentgem ticket");
      const parts = decodeURIComponent(u.pathname.replace(/^\//, "")).split("/");
      object = parts[1] ?? "";
      key = u.hash.replace(/^#/, "").split("~")[0]; // the key is before "~"; a "~<producer>" provenance segment (if present) is not needed here
      if (!object || !key) throw new Error("malformed ticket");
    } catch (e) {
      setRecvStatus("Bad ticket: " + (e instanceof Error ? e.message : String(e)));
      return;
    }
    setRecvStatus("Fetching ciphertext…");
    try {
      const client = makeClient(apiBase);
      const { ciphertextBase64 } = await transferCiphertextRoute.call(client, {
        body: { object }, // only `object` is sent to the server; bucket and key are intentionally withheld (zero-knowledge)
      });
      const ct = Uint8Array.from(atob(ciphertextBase64), (c) => c.charCodeAt(0));
      const gem = await decryptGem(ct, b64urlToBytes(key));
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([gem as unknown as Uint8Array<ArrayBuffer>], { type: "application/gzip" }));
      a.download = "received.gem";
      a.click();
      setRecvStatus("✓ Decrypted locally — downloaded received.gem.");
    } catch (e) {
      setRecvStatus("Failed: " + (e instanceof Error ? e.message : String(e)));
    }
  }

  return (
    <div className="transfer">
      <section className="transfer-section">
        <h3 className="transfer-heading">Receive</h3>
        <div className="ledger-bar">
          <input
            className="ledger-search"
            type="text"
            placeholder="agentgem://gem/…#…"
            value={recv}
            onChange={(e) => setRecv(e.target.value)}
            aria-label="ticket input"
          />
        </div>
        <div className="transfer-actions">
          <div>
            <button type="button" className="ledger-sort" onClick={() => void redeem()}>
              Redeem (server-side decrypt → download)
            </button>
            <p className="transfer-note">The server briefly handles the decrypted gem.</p>
          </div>
          <button type="button" className="ledger-sort" onClick={() => void redeemPrivately()}>
            Redeem privately (in-browser decrypt → download)
          </button>
        </div>
        {recvStatus && <p className="transfer-status">{recvStatus}</p>}
      </section>
    </div>
  );
}

export const receivedPage = defineConsolePage({
  id: "received",
  title: "Received",
  icon: "↓",
  order: 46,
  group: "library",
  route: "#/received",
  component: ({ apiBase }) => <Received apiBase={apiBase} />,
});
