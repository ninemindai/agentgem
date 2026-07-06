import { useEffect, useState } from "react";
import type { makeApi } from "../api";
import type { Gem as GemT } from "../gems/catalog";
import { loadGems, findGem } from "../gems/catalog";
import { prettifyId, kindLabel } from "../data";
import { StarButton } from "../StarButton";
import { CutBadge } from "../CutBadge";
import { StoneRating } from "../StoneRating";
import { GemContents } from "./GemContents";
import type { StarsCtx } from "../Router";
import type { StarState } from "../stars";

// The locally-running console (CLI default http://127.0.0.1:4317, see src/cli.ts). A deep link into
// its Get Gems tab, pre-searched, so publishing a gem key here lands the reader ready to install.
// Best-effort: it only reaches a console on this port (the packaged app uses a random port — that's
// what the agentgem:// protocol handler is for), so the manual steps below stay as the fallback.
const LOCAL_CONSOLE = "http://localhost:4317";
function openInConsoleUrl(gemKey: string): string {
  return `${LOCAL_CONSOLE}/#/get-gems?q=${encodeURIComponent(gemKey)}`;
}

export function Gem({ api, keyName, stars }: { api: ReturnType<typeof makeApi>; keyName: string; stars: StarsCtx }) {
  const [gems, setGems] = useState<GemT[] | null>(null);
  const [starState, setStarState] = useState<StarState>({ counts: {}, mine: [] });
  const [adoptions, setAdoptions] = useState<Record<string, { installs: number; verifiedInstalls: number }>>({});

  useEffect(() => {
    let alive = true;
    loadGems(api).then((g) => { if (alive) setGems(g); });
    return () => { alive = false; };
  }, [api]);

  useEffect(() => {
    if (!keyName) return;
    let alive = true;
    stars.api.get("gem", [keyName]).then((s) => { if (alive) setStarState(s); });
    api.gemAdoption([keyName]).then((a) => { if (alive) setAdoptions(a); });
    return () => { alive = false; };
  }, [keyName, stars.api]);

  if (gems === null) return <div className="ex-gem-detail"><p className="ex-empty">Loading…</p></div>;
  const gem = findGem(gems, keyName);
  if (!gem) return <div className="ex-gem-detail"><p className="ex-empty">Gem not found: "{keyName}".</p></div>;

  const copyKey = () => { void navigator.clipboard?.writeText(gem.key); };

  return (
    <div className="ex-gem-detail">
      <h2 className="ex-gem-title">{gem.key} <span className="ex-gem-version">v{gem.version}</span> <CutBadge cut={gem.cut} /> <StoneRating cut={gem.cut} grade={gem.grade} stars={starState.counts[gem.key] ?? 0} installs={adoptions[gem.key]?.installs ?? 0} verifiedInstalls={adoptions[gem.key]?.verifiedInstalls ?? 0} />
        <StarButton kind="gem" id={gem.key} count={starState.counts[gem.key] ?? 0} starred={starState.mine.includes(gem.key)}
          signedIn={stars.signedIn} loginUrl={stars.loginUrl} api={stars.api} />
      </h2>
      <p className="ex-gem-meta">
        {gem.publishedBy
          ? <a className="ex-gem-author" href={"/@" + encodeURIComponent(gem.publishedBy)}>@{gem.publishedBy}</a>
          : (gem.author ? <span>by {gem.author}</span> : null)}
        {gem.artifactKinds.map((k) => <span key={k} className="ex-chip">{kindLabel(k)}</span>)}
      </p>
      <p className="ex-gem-desc">{gem.description}</p>
      <p className="ex-gem-tags">{gem.tags.map((t) => <span key={t} className="ex-tag">#{t}</span>)}</p>

      <GemContents artifacts={gem.artifacts ?? []} />

      <section className="ex-card">
        <h3>Get this gem</h3>
        <p className="ex-getit">
          <a className="ex-open-app" href={openInConsoleUrl(gem.key)} target="_blank" rel="noreferrer">Open in AgentGem →</a>
          Gem key: <code className="ex-key">{gem.key}</code>
          <button type="button" className="ex-copy" onClick={copyKey}>Copy key</button>
        </p>
        <p className="ex-getit-steps">Opens your running local console straight to <strong>Get Gems</strong>, pre-searched. Not running? Start AgentGem, then <strong>Get Gems</strong> → search "{gem.key}" → <strong>Install</strong>.</p>
      </section>

      {gem.ingredients.length > 0 && (
        <section className="ex-card">
          <h3>Contains</h3>
          <ul className="ex-ingredients">
            {gem.ingredients.map((ing) => {
              const p = prettifyId(ing.id, ing.kind);
              return (
                <li key={ing.id}>
                  <a href={"/ingredient/" + encodeURIComponent(ing.id)} title={ing.id}>{p.name}</a>
                  <span className="ex-chip">{kindLabel(ing.kind)}</span>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
}
