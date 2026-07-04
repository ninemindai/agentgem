import { useEffect, useMemo, useState } from "react";
import type { makeApi } from "../api";
import type { PopularSkillGroup, PopularSkillItem } from "../types";
import { formatCount } from "../data";
import { StarButton } from "../StarButton";
import type { StarsCtx } from "../Router";
import type { StarState } from "../stars";

// A curated skill card joins the usage graph by name: it stars under the same (kind, id) the
// adoption leaderboard/detail page use for that skill (kind "ingredient", id "skill:<name>"), so a
// star here and a star there share one counter. Identity is by name, so same-named skills across
// repos share a tally — intended for a by-skill usage rollup, not per-repo distinctness.
const skillIngredientId = (name: string) => "skill:" + name;

// repo "owner/name" → "owner"; the source's GitHub owner is the card's author/curator.
const repoOwner = (repo: string) => repo.split("/")[0] ?? repo;

function matches(g: PopularSkillGroup, s: PopularSkillItem, q: string): boolean {
  return [s.name, s.description ?? "", s.division, repoOwner(g.repo), g.source]
    .join(" ").toLowerCase().includes(q);
}

export function PopularSkills({ api, stars }: { api: ReturnType<typeof makeApi>; stars: StarsCtx }) {
  const [groups, setGroups] = useState<PopularSkillGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [starState, setStarState] = useState<StarState>({ counts: {}, mine: [] });
  const [query, setQuery] = useState("");

  useEffect(() => {
    let alive = true;
    setLoading(true); setError(null);
    api.getPopularSkillGroups(12, 6)
      .then((g) => { if (alive) setGroups(g); })
      .catch((e) => { if (alive) setError(String(e?.message ?? e)); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
    // api is a stable module-level singleton (App.tsx) — excluded so re-renders don't refetch.
  }, []);

  useEffect(() => {
    if (groups.length === 0) return;
    let alive = true;
    const ids = [...new Set(groups.flatMap((g) => g.skills.map((s) => skillIngredientId(s.name))))];
    stars.api.get("ingredient", ids).then((s) => { if (alive) setStarState(s); });
    return () => { alive = false; };
  }, [groups, stars.api]);

  const q = query.trim().toLowerCase();
  const visible = useMemo(() => {
    if (!q) return groups;
    return groups
      .map((g) => ({ ...g, skills: g.skills.filter((s) => matches(g, s, q)) }))
      .filter((g) => g.skills.length > 0);
  }, [groups, q]);

  return (
    <section className="ex-popskills">
      <h2 className="ex-section-title">Popular skills</h2>
      <input className="ex-search" type="search" aria-label="search skills"
        placeholder="search skills, authors, tags…" value={query}
        onChange={(e) => setQuery(e.target.value)} />
      {error && <p className="ex-error">Couldn&apos;t load popular skills: {error}</p>}
      {!error && loading && groups.length === 0 && <p className="ex-empty">Loading…</p>}
      {!error && !loading && groups.length === 0 && <p className="ex-empty">No skills indexed yet.</p>}
      {!error && groups.length > 0 && visible.length === 0 && <p className="ex-empty">No skills match &quot;{query}&quot;.</p>}
      {visible.map((g) => {
        const owner = repoOwner(g.repo);
        return (
          <div key={g.sourceId} className="ex-skillgroup">
            <div className="ex-skillgroup-head">
              <a href={g.homepage ?? "/sources"} target="_blank" rel="noreferrer">{g.source}</a>
              <span className="ex-skillgroup-stars">★ {formatCount(g.stars)}</span>
            </div>
            <div className="ex-skillcards">
              {g.skills.map((s) => {
                const iid = skillIngredientId(s.name);
                return (
                  <div key={g.sourceId + "/" + s.path} className="ex-skillcard">
                    <StarButton kind="ingredient" id={iid} count={starState.counts[iid] ?? 0}
                      starred={starState.mine.includes(iid)} signedIn={stars.signedIn}
                      loginUrl={stars.loginUrl} api={stars.api} />
                    <div className="ex-skillcard-name">{s.name}</div>
                    {s.description && <p className="ex-skillcard-desc">{s.description}</p>}
                    <a className="ex-skillcard-author" href={`https://github.com/${owner}`} target="_blank" rel="noreferrer">
                      by {owner}
                    </a>
                    <div className="ex-skillcard-foot">
                      <span className="ex-skillcard-division">{s.division}</span>
                      <a
                        href={`https://github.com/${g.repo}/blob/HEAD/${s.path}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        View on GitHub →
                      </a>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </section>
  );
}
