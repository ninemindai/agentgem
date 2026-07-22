// packages/console/src/panels/Play/CapabilityStrip.tsx
// Disclosure, not control. It renders the RECONCILED built-in `needs` and the declared MCP connectors,
// each labelled with the cost the viewer sees / the connector's install state. There is no toggle here
// on purpose: the code is the single authority over `needs`/`mcpNeeds`, and a toggle would reintroduce
// the second authority the save-time reconciliation exists to remove.
import { CAP_LABEL } from "./consent.js";

const AUTO_LABEL = "read this miniapp's own source session";  // session-data: auto-approved, no CAP_LABEL

// A declared connector's post-save disclosure state, derived from /play/mcp/servers:
//   ready       — installed, reachable; `tools` lists what it exposes
//   unreachable — installed but the connect failed (digest present, no tools)
//   missing     — no matching installed gem here (portability warning)
export type ConnectorRow = { server: string; tools: string[]; state: "ready" | "unreachable" | "missing" };

export function CapabilityStrip({ needs, pruned, connectors }: { needs?: string[]; pruned: string[]; connectors?: ConnectorRow[] }) {
  if (!needs?.length && !pruned.length && !connectors?.length) return null;
  return (
    <div className="play-caps">
      {needs?.map((cap) => (
        <div key={cap} className="play-caps__row">
          <code className="play-caps__cap">{cap}</code>
          <span className="play-caps__cost">{CAP_LABEL[cap] ?? AUTO_LABEL}</span>
        </div>
      ))}
      {connectors?.map((c) => (
        <div key={`mcp-${c.server}`} className={`play-caps__row play-caps__mcp${c.state === "missing" ? " play-caps__mcp--missing" : ""}`}>
          <code className="play-caps__cap">{c.server}</code>
          <span className="play-caps__cost">
            {c.state === "missing" ? "⚠ connector not installed here"
              : c.state === "unreachable" ? "couldn’t connect"
              : c.tools.join(", ")}
          </span>
        </div>
      ))}
      {pruned.map((cap) => (
        <div key={`pruned-${cap}`} className="play-caps__row play-caps__row--pruned">
          removed {cap} — nothing in the miniapp uses it
        </div>
      ))}
    </div>
  );
}
