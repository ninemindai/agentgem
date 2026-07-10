// packages/console/src/panels/Play/CapabilityStrip.tsx
// Disclosure, not control. It renders the RECONCILED `needs` — the capabilities the miniapp's code
// actually uses — each labelled with the cost the viewer will see in their consent prompt. There is no
// toggle here on purpose: the code is the single authority over `needs`, and a toggle would reintroduce
// the second authority the save-time reconciliation exists to remove.
import { CAP_LABEL } from "./consent.js";

const AUTO_LABEL = "read this miniapp's own source session";  // session-data: auto-approved, no CAP_LABEL

export function CapabilityStrip({ needs, pruned }: { needs?: string[]; pruned: string[] }) {
  if (!needs?.length && !pruned.length) return null;
  return (
    <div className="play-caps">
      {needs?.map((cap) => (
        <div key={cap} className="play-caps__row">
          <code className="play-caps__cap">{cap}</code>
          <span className="play-caps__cost">{CAP_LABEL[cap] ?? AUTO_LABEL}</span>
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
