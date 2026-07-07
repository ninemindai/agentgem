// packages/console/src/panels/Play/Arcade.tsx
import { useEffect, useState } from "react";
import { makeClient, playMiniappsRoute } from "../../api/routes.js";

type Item = { name: string; title: string; genre: string; needs?: string[] };

// v1: chips are DISPLAY-ONLY. The consent gate + capability broker (live/local/invoke-agent) are the
// spec's Permissions Model and are deferred — no v1 genre declares `needs`.
const CHIP: Record<string, { label: string; title: string }> = {
  "live-session-events": { label: "🔴 live", title: "reads live sessions (host-brokered, read-only)" },
  "local-project-access": { label: "🟡 local", title: "reads local projects (host-brokered, read-only)" },
  "invoke-agent": { label: "⚙ agent", title: "runs a local agent (local-authored only)" },
};

export function Arcade({ apiBase, onOpen }: { apiBase: string; onOpen: (name: string) => void }) {
  const [items, setItems] = useState<Item[] | null>(null);
  useEffect(() => {
    playMiniappsRoute.call(makeClient(apiBase)).then((r) => setItems(r.miniapps)).catch(() => setItems([]));
  }, [apiBase]);

  if (!items) return <p className="ledger-view">Loading miniapps…</p>;
  if (items.length === 0) return <p className="ledger-empty">No miniapps yet — create one from a session, skill, or project.</p>;
  return (
    <ul className="analyze-list" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(220px,1fr))", gap: 12, listStyle: "none", padding: 0 }}>
      {items.map((m) => (
        <li key={m.name} className="analyze-row" style={{ cursor: "pointer", padding: 12, borderRadius: 8 }}
            onClick={() => onOpen(m.name)}>
          <div style={{ fontWeight: 600 }}>{m.title}</div>
          <div style={{ fontSize: 12, opacity: 0.7 }}>{m.genre}</div>
          <div style={{ marginTop: 6, display: "flex", gap: 6, flexWrap: "wrap" }}>
            {(m.needs && m.needs.length ? m.needs : []).map((n) => (
              <span key={n} className="ws-chip" title={CHIP[n]?.title}>{CHIP[n]?.label ?? n}</span>
            ))}
            {(!m.needs || m.needs.length === 0) && <span className="ws-chip" title="fully offline snapshot">🟢 offline</span>}
          </div>
        </li>
      ))}
    </ul>
  );
}
