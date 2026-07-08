// packages/marketplace/src/pages/Minigames.tsx
import { useEffect, useState } from "react";
import type { makeApi } from "../api";
import { loadGems, type Gem } from "../gems/catalog";
import { GamePreview } from "../GamePreview";
import { navigate } from "../nav";

type Api = ReturnType<typeof makeApi>;

// One arcade card: an animated thumbnail with a ▶ badge; click launches the sealed game fullscreen (see
// GamePreview). A broker-fed replay (no baked data, no host here) shows its own waiting state — that's
// expected off the machine that owns the session.
function GameCard({ api, gem }: { api: Api; gem: Gem }) {
  return (
    <li className="mg-card">
      <div className="mg-thumb">
        <GamePreview api={api} gemKey={gem.key} version={gem.version} />
      </div>
      <div className="mg-body">
        <div className="mg-title">{gem.key}</div>
        {gem.description && <div className="mg-desc">{gem.description}</div>}
        <div className="mg-row">
          {gem.author && <span className="mg-meta">by {gem.author}</span>}
          <button className="mg-open" onClick={() => navigate(`/gems/${encodeURIComponent(gem.key)}`)}>Open gem →</button>
        </div>
      </div>
    </li>
  );
}

export function Minigames({ api }: { api: Api }) {
  const [gems, setGems] = useState<Gem[] | null>(null);
  useEffect(() => { let alive = true; loadGems(api).then((g) => { if (alive) setGems(g); }).catch(() => setGems([])); return () => { alive = false; }; }, [api]);

  if (!gems) return <p className="mg-intro">Loading mini-games…</p>;
  const games = gems.filter((g) => g.artifactKinds.includes("game"));
  return (
    <div className="mg">
      <h2 className="mg-h">Minigames</h2>
      <p className="mg-intro">AI-authored mini-games — sealed and playable right here. Click any game to play fullscreen.</p>
      {games.length === 0
        ? <div className="mg-empty">No mini-games published yet. Build one in AgentGem → <b>Play</b> → <b>Share to app.agentgem.ai</b>.</div>
        : <ul className="mg-grid">{games.map((g) => <GameCard key={g.key} api={api} gem={g} />)}</ul>}
    </div>
  );
}
