import { useEffect, useState } from "react";
import type { makeApi } from "../api";
import type { Gem } from "../gems/catalog";
import { loadGems, filterGems } from "../gems/catalog";
import { kindLabel } from "../data";
import { StarButton } from "../StarButton";
import { CutBadge } from "../CutBadge";
import { cutMeta } from "../gems/cuts";
import { StoneRating } from "../StoneRating";
import type { StarsCtx } from "../Router";
import type { StarState } from "../stars";

export function Gems({ api, stars }: { api: ReturnType<typeof makeApi>; stars: StarsCtx }) {
  const [gems, setGems] = useState<Gem[] | null>(null);
  const [search, setSearch] = useState("");
  const [selectedCuts, setSelectedCuts] = useState<string[]>([]);
  const [starState, setStarState] = useState<StarState>({ counts: {}, mine: [] });
  const [adoptions, setAdoptions] = useState<Record<string, number>>({});

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
    api.gemAdoption(ids).then((a) => { if (alive) setAdoptions(a); });
    return () => { alive = false; };
  }, [gems, stars.api]);

  if (gems === null) return <p className="ex-empty">Loading gems…</p>;
  const presentCuts = [...new Set((gems ?? []).map((g) => g.cut).filter((c): c is string => !!c))];
  const visible = filterGems(gems, search, selectedCuts);

  return (
    <div className="ex-gems">
      <input className="ex-search" type="search" aria-label="search gems"
        placeholder="filter gems by name, tag, description…" value={search}
        onChange={(e) => setSearch(e.target.value)} />
      {presentCuts.length > 0 && (
        <div className="ex-cut-facet">
          {presentCuts.map((c) => {
            const on = selectedCuts.includes(c);
            return (
              <button type="button" key={c} className={"ex-cut ex-cut-toggle" + (on ? " is-on" : "")}
                aria-pressed={on} aria-label={(on ? "remove filter " : "filter by ") + (cutMeta(c)?.label ?? c)}
                style={{ background: cutMeta(c)?.bg, color: cutMeta(c)?.fg }}
                onClick={() => setSelectedCuts((s) => on ? s.filter((x) => x !== c) : [...s, c])}>
                {cutMeta(c)?.label ?? c}
              </button>
            );
          })}
        </div>
      )}
      {visible.length === 0 && <p className="ex-empty">No gems match "{search}".</p>}
      <ul className="ex-gem-list">
        {visible.map((g) => (
          <li key={g.key} className="ex-gem-item">
            <a className="ex-gem-card" href={"/gems/" + encodeURIComponent(g.key)}>
              <span className="ex-gem-head">
                <span className="ex-gem-key">{g.key}</span>
                <CutBadge cut={g.cut} />
                <StoneRating cut={g.cut} grade={g.grade} stars={starState.counts[g.key] ?? 0} installs={adoptions[g.key] ?? 0} />
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
