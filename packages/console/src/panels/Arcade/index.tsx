// packages/console/src/panels/Arcade/index.tsx
// The Observe-phase Arcade: browse + PLAY your mini-games (read-only). Authoring lives in Build → Play.
// Reuses the Play Arcade grid; "click" opens a sealed, playable overlay instead of the studio.
import { useEffect, useState } from "react";
import type { McpNeed } from "@agentgem/model";
import { defineConsolePage } from "../../contract.js";
import { Arcade as GameGrid } from "../Play/Arcade.js";
import { Runner } from "../Play/Runner.js";
import { makeClient, playMiniappRoute } from "../../api/routes.js";

function PlayOverlay({ apiBase, name, onClose }: { apiBase: string; name: string; onClose: () => void }) {
  const [html, setHtml] = useState("");
  const [needs, setNeeds] = useState<string[] | undefined>(undefined);
  const [mcpNeeds, setMcpNeeds] = useState<McpNeed[] | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    playMiniappRoute.call(makeClient(apiBase), { query: { name } })
      .then((r) => { if (alive) { setHtml(r.html); setNeeds(r.meta.needs); setMcpNeeds(r.meta.mcpNeeds); } }).catch(() => {});
    return () => { alive = false; };
  }, [apiBase, name]);
  return (
    <div className="arcade-overlay" onClick={onClose}>
      <div className="arcade-overlay__box" onClick={(e) => e.stopPropagation()}>
        <div className="arcade-overlay__bar"><strong>{name}</strong><button className="play-btn play-btn--ghost" onClick={onClose}>✕ Close</button></div>
        {html && <Runner html={html} name={name} apiBase={apiBase} needs={needs} mcpNeeds={mcpNeeds} />}
      </div>
    </div>
  );
}

export function ArcadePage({ apiBase }: { apiBase: string }) {
  const [playing, setPlaying] = useState<string | null>(null);
  return (
    <section className="analyze">
      <p className="play-intro">Your mini-games — click to play. Create or edit them in <a href="#/play"><b>Build → Play</b></a>.</p>
      <GameGrid apiBase={apiBase} onOpen={setPlaying} />
      {playing && <PlayOverlay apiBase={apiBase} name={playing} onClose={() => setPlaying(null)} />}
    </section>
  );
}

export const arcadePage = defineConsolePage({
  id: "arcade", title: "Arcade", icon: "🎮", order: 40,
  phase: "observe", category: "sessions",
  route: "#/arcade",
  component: ({ apiBase }) => <ArcadePage apiBase={apiBase} />,
});
