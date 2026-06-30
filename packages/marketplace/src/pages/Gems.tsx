import { useEffect, useState } from "react";
import type { makeApi } from "../api";
import type { Gem } from "../gems/catalog";
import { loadGems, filterGems } from "../gems/catalog";
import { kindLabel } from "../data";
import { StarButton } from "../StarButton";
import type { StarsCtx } from "../Router";
import type { StarState } from "../stars";

export function Gems({ api, stars }: { api: ReturnType<typeof makeApi>; stars: StarsCtx }) {
  const [gems, setGems] = useState<Gem[] | null>(null);
  const [search, setSearch] = useState("");
  const [starState, setStarState] = useState<StarState>({ counts: {}, mine: [] });

  useEffect(() => {
    let alive = true;
    loadGems(api).then((g) => { if (alive) setGems(g); });
    return () => { alive = false; };
  }, [api]);

  useEffect(() => {
    if (!gems || gems.length === 0) return;
    let alive = true;
    const ids = gems.map((g) => g.key);
    stars.api.get("gem", ids).then((s) => { if (alive) setStarState(s); });
    return () => { alive = false; };
  }, [gems, stars.api]);

  if (gems === null) return <p className="ex-empty">Loading gems…</p>;
  const visible = filterGems(gems, search);

  return (
    <div className="ex-gems">
      <input className="ex-search" type="search" aria-label="search gems"
        placeholder="filter gems by name, tag, description…" value={search}
        onChange={(e) => setSearch(e.target.value)} />
      {visible.length === 0 && <p className="ex-empty">No gems match "{search}".</p>}
      <ul className="ex-gem-list">
        {visible.map((g) => (
          <li key={g.key} className="ex-gem-item">
            <a className="ex-gem-card" href={"/gems/" + encodeURIComponent(g.key)}>
              <span className="ex-gem-head">
                <span className="ex-gem-key">{g.key}</span>
                <span className="ex-gem-kinds">{g.artifactKinds.map((k) => <span key={k} className="ex-chip">{kindLabel(k)}</span>)}</span>
              </span>
              <span className="ex-gem-desc">{g.description}</span>
              <span className="ex-gem-tags">{g.tags.map((t) => <span key={t} className="ex-tag">#{t}</span>)}</span>
            </a>
            <StarButton kind="gem" id={g.key} count={starState.counts[g.key] ?? 0} starred={starState.mine.includes(g.key)}
              signedIn={stars.signedIn} loginUrl={stars.loginUrl} api={stars.api} />
          </li>
        ))}
      </ul>
    </div>
  );
}
