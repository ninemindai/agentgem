import { useEffect, useState } from "react";
import type { makeApi } from "../api";
import type { PopularSkillGroup } from "../types";
import { formatCount } from "../data";

export function PopularSkills({ api }: { api: ReturnType<typeof makeApi> }) {
  const [groups, setGroups] = useState<PopularSkillGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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

  return (
    <section className="ex-popskills">
      <h2 className="ex-section-title">Popular skills</h2>
      {error && <p className="ex-error">Couldn&apos;t load popular skills: {error}</p>}
      {!error && loading && groups.length === 0 && <p className="ex-empty">Loading…</p>}
      {!error && !loading && groups.length === 0 && <p className="ex-empty">No skills indexed yet.</p>}
      {groups.map((g) => (
        <div key={g.sourceId} className="ex-skillgroup">
          <div className="ex-skillgroup-head">
            <a href={g.homepage ?? "/sources"} target="_blank" rel="noreferrer">{g.source}</a>
            <span className="ex-skillgroup-stars">★ {formatCount(g.stars)}</span>
          </div>
          <div className="ex-skillcards">
            {g.skills.map((s) => (
              <div key={g.sourceId + "/" + s.path} className="ex-skillcard">
                <div className="ex-skillcard-name">{s.name}</div>
                {s.description && <p className="ex-skillcard-desc">{s.description}</p>}
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
            ))}
          </div>
        </div>
      ))}
    </section>
  );
}
