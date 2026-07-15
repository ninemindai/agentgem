// packages/marketplace/src/pages/Minigames.tsx
import { useEffect, useState } from "react";
import type { makeApi } from "../api";
import { loadGems, filterGames, gameGenre, displayTags, genreLabel, type Gem } from "../gems/catalog";
import { GamePreview } from "../GamePreview";
import { OfflineToggle } from "../OfflineToggle";
import { IconSparkle, IconGems } from "../icons";
import { StarButton } from "../StarButton";
import type { StarsCtx } from "../Router";
import type { StarState } from "../stars";
import { navigate } from "../nav";
import { gamePath } from "../entityPath";

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
// expected off the machine that owns the session. Tag chips call onTag to set the page search.
function GameCard({ api, gem, stars, starState, plays, onTag }: { api: Api; gem: Gem; stars: StarsCtx; starState: StarState; plays: number; onTag: (t: string) => void }) {
  // Own the count locally so a play shows up the instant it is clicked (same shape as StarButton).
  // `plays` arrives after the page's bulk fetch resolves, and useState only reads it at mount.
  const [n, setN] = useState(plays);
  useEffect(() => setN(plays), [plays]);
  const tags = displayTags(gem);
  return (
    <li className="mg-card">
      <div className="mg-thumb">
        <GamePreview api={api} gemKey={gem.key} version={gem.version}
          onPlayCountChange={(d) => setN((c) => c + d)} onPlay={() => navigate(gamePath(gem.key))} />
      </div>
      <div className="mg-body">
        <div className="mg-title">{gem.key}</div>
        {gem.description && <div className="mg-desc">{gem.description}</div>}
        {tags.length > 0 && (
          <div className="mg-tags">
            {tags.map((t) => (
              <button type="button" key={t} className="ex-tag mg-tag" aria-label={`filter by tag ${t}`}
                onClick={() => onTag(t)}>#{t}</button>
            ))}
          </div>
        )}
        <div className="mg-row">
          {gem.author && <span className="mg-meta">by {gem.author}</span>}
          {n > 0 && <span className="mg-meta">{n === 1 ? "1 play" : `${n} plays`}</span>}
          <StarButton kind="gem" id={gem.key} count={starState.counts[gem.key] ?? 0} starred={starState.mine.includes(gem.key)}
            signedIn={stars.signedIn} loginUrl={stars.loginUrl} api={stars.api} />
        </div>
        <div className="mg-actions">
          <div className="mg-action-links">
            <a className="mg-remix" href={remixAppUrl(gem)}
              title={`Opens AgentGem → Play, prefilled to build your own version of ${gem.key}`}><IconSparkle />Make your own</a>
            <button className="mg-open" onClick={() => navigate(`/gems/${encodeURIComponent(gem.key)}`)}><IconGems />Open gem</button>
          </div>
          <OfflineToggle gemKey={gem.key} version={gem.version} title={gem.key} label="Download for offline play" />
        </div>
      </div>
    </li>
  );
}

export function Minigames({ api, stars }: { api: Api; stars: StarsCtx }) {
  const [gems, setGems] = useState<Gem[] | null>(null);
  const [search, setSearch] = useState("");
  const [selectedGenres, setSelectedGenres] = useState<string[]>([]);
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

  if (!gems) return <p className="mg-intro">Loading miniapps…</p>;
  // Genre values present in the loaded set — the facet only offers genres that exist.
  const presentGenres = [...new Set(games.map(gameGenre).filter((x): x is NonNullable<typeof x> => !!x))];
  const visible = filterGames(games, search, selectedGenres);
  return (
    <div className="mg">
      <h2 className="mg-h">Miniapps</h2>
      <p className="mg-intro">AI-authored miniapps — sealed and playable right here. Click any one to play fullscreen.</p>
      {games.length === 0
        ? <div className="mg-empty">No miniapps published yet. Build one in AgentGem → <b>Play</b> → <b>Share</b>.</div>
        : <>
            <input className="ex-search" type="search" aria-label="search miniapps"
              placeholder="filter miniapps by name, tag, description…" value={search}
              onChange={(e) => setSearch(e.target.value)} />
            {presentGenres.length > 0 && (
              <div className="ex-cut-facet">
                {presentGenres.map((g) => {
                  const on = selectedGenres.includes(g);
                  return (
                    <button type="button" key={g} className={"ex-cut ex-cut-toggle" + (on ? " is-on" : "")}
                      aria-pressed={on} aria-label={(on ? "remove filter " : "filter by ") + genreLabel(g)}
                      onClick={() => setSelectedGenres((s) => on ? s.filter((x) => x !== g) : [...s, g])}>
                      {genreLabel(g)}
                    </button>
                  );
                })}
              </div>
            )}
            {visible.length === 0
              ? <p className="mg-empty">No miniapps match "{search}".</p>
              : <ul className="mg-grid">{visible.map((g) => <GameCard key={g.key} api={api} gem={g} stars={stars} starState={starState} plays={plays[g.key] ?? 0} onTag={setSearch} />)}</ul>}
            <p className="mg-foot"><b>Make your own</b> opens the AgentGem desktop app straight to <strong>Play</strong>, prefilled to build your own version of that game. Running the CLI console instead? Open <a className="mg-foot-link" href={`${LOCAL_CONSOLE}/#/play`} target="_blank" rel="noreferrer">localhost:4317 → Play</a>.</p>
          </>}
    </div>
  );
}
