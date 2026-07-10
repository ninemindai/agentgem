// packages/marketplace/src/pages/Minigames.tsx
import { useEffect, useState } from "react";
import type { makeApi } from "../api";
import { loadGems, type Gem } from "../gems/catalog";
import { GamePreview } from "../GamePreview";
import { StarButton } from "../StarButton";
import type { StarsCtx } from "../Router";
import type { StarState } from "../stars";
import { navigate } from "../nav";

type Api = ReturnType<typeof makeApi>;

// The locally-running CLI console (default port, see src/cli.ts) — the fallback for readers who run
// the console rather than the packaged desktop app, which owns the agentgem:// scheme.
const LOCAL_CONSOLE = "http://localhost:4317";

// "Make your own" — a deep link into the console's Play → Composer → Blank tab, prefilled with a
// title and a first build prompt derived from this game, so the reader lands one click from a studio
// that starts building their own take. The desktop app routes agentgem://play (desktop/src/deeplink.ts).
function remixAppUrl(gem: Gem): string {
  const short = gem.key.split("/").pop() ?? gem.key;
  const about = gem.description ? `: ${gem.description}` : "";
  const qs = new URLSearchParams({
    new: "1",
    title: `${short}-remix`,
    prompt: `Build my own version of the mini-game "${gem.key}"${about}. Same idea — but make it my own.`,
  });
  return `agentgem://play?${qs.toString()}`;
}

// One arcade card: an animated thumbnail with a ▶ badge; click launches the sealed game fullscreen (see
// GamePreview). A broker-fed replay (no baked data, no host here) shows its own waiting state — that's
// expected off the machine that owns the session.
function GameCard({ api, gem, stars, starState, plays }: { api: Api; gem: Gem; stars: StarsCtx; starState: StarState; plays: number }) {
  // Own the count locally so a play shows up the instant it is clicked (same shape as StarButton).
  // `plays` arrives after the page's bulk fetch resolves, and useState only reads it at mount.
  const [n, setN] = useState(plays);
  useEffect(() => setN(plays), [plays]);
  return (
    <li className="mg-card">
      <div className="mg-thumb">
        <GamePreview api={api} gemKey={gem.key} version={gem.version}
          onPlayCountChange={(d) => setN((c) => c + d)} />
      </div>
      <div className="mg-body">
        <div className="mg-title">{gem.key}</div>
        {gem.description && <div className="mg-desc">{gem.description}</div>}
        <div className="mg-row">
          {gem.author && <span className="mg-meta">by {gem.author}</span>}
          {n > 0 && <span className="mg-meta">{n === 1 ? "1 play" : `${n} plays`}</span>}
          <StarButton kind="gem" id={gem.key} count={starState.counts[gem.key] ?? 0} starred={starState.mine.includes(gem.key)}
            signedIn={stars.signedIn} loginUrl={stars.loginUrl} api={stars.api} />
        </div>
        <div className="mg-row mg-actions">
          <a className="mg-remix" href={remixAppUrl(gem)}
            title={`Opens AgentGem → Play, prefilled to build your own version of ${gem.key}`}>Make your own →</a>
          <button className="mg-open" onClick={() => navigate(`/gems/${encodeURIComponent(gem.key)}`)}>Open gem →</button>
        </div>
      </div>
    </li>
  );
}

export function Minigames({ api, stars }: { api: Api; stars: StarsCtx }) {
  const [gems, setGems] = useState<Gem[] | null>(null);
  const [starState, setStarState] = useState<StarState>({ counts: {}, mine: [] });
  const [plays, setPlays] = useState<Record<string, number>>({});
  useEffect(() => { let alive = true; loadGems(api).then((g) => { if (alive) setGems(g); }).catch(() => setGems([])); return () => { alive = false; }; }, [api]);

  // Games are gems, so they star through the very same ("gem", <key>) identity the Gems pages use —
  // one bulk fetch for every card on the page.
  const games = gems?.filter((g) => g.artifactKinds.includes("game")) ?? [];
  const gameKeys = games.map((g) => g.key).join(","); // stable dep: refetch only when the set changes
  useEffect(() => {
    if (!gameKeys) return;
    let alive = true;
    stars.api.get("gem", gameKeys.split(",")).then((s) => { if (alive) setStarState(s); }).catch(() => {});
    api.getGamePlays(gameKeys.split(",")).then((p) => { if (alive) setPlays(p); }).catch(() => {});
    return () => { alive = false; };
  }, [gameKeys, stars.api, api]);

  if (!gems) return <p className="mg-intro">Loading mini-games…</p>;
  return (
    <div className="mg">
      <h2 className="mg-h">Minigames</h2>
      <p className="mg-intro">AI-authored mini-games — sealed and playable right here. Click any game to play fullscreen.</p>
      {games.length === 0
        ? <div className="mg-empty">No mini-games published yet. Build one in AgentGem → <b>Play</b> → <b>Share to app.agentgem.ai</b>.</div>
        : <>
            <ul className="mg-grid">{games.map((g) => <GameCard key={g.key} api={api} gem={g} stars={stars} starState={starState} plays={plays[g.key] ?? 0} />)}</ul>
            <p className="mg-foot"><b>Make your own</b> opens the AgentGem desktop app straight to <strong>Play</strong>, prefilled to build your own version of that game. Running the CLI console instead? Open <a className="mg-foot-link" href={`${LOCAL_CONSOLE}/#/play`} target="_blank" rel="noreferrer">localhost:4317 → Play</a>.</p>
          </>}
    </div>
  );
}
