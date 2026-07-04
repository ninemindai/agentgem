import { useEffect, useState } from "react";
import type { makeApi } from "../api";
import type { PopularSkill } from "../types";
import { formatCount } from "../data";

export function PopularSkills({ api }: { api: ReturnType<typeof makeApi> }) {
  const [skills, setSkills] = useState<PopularSkill[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true); setError(null);
    api.getPopularSkills(50)
      .then((s) => { if (alive) setSkills(s); })
      .catch((e) => { if (alive) setError(String(e?.message ?? e)); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
    // api is a stable module-level singleton (App.tsx) — excluded so re-renders don't refetch.
  }, []);

  return (
    <section className="ex-popskills">
      <h2 className="ex-section-title">Popular skills</h2>
      {error && <p className="ex-error">Couldn&apos;t load popular skills: {error}</p>}
      {!error && loading && skills.length === 0 && <p className="ex-empty">Loading…</p>}
      {!error && !loading && skills.length === 0 && <p className="ex-empty">No skills indexed yet.</p>}
      {skills.length > 0 && (
        <ol className="ex-rows">
          {skills.map((s, i) => (
            <li key={s.sourceId + "/" + s.path} className="ex-row-wrap">
              <a className="ex-row" href={s.homepage ?? "/sources"} target={s.homepage ? "_blank" : undefined} rel={s.homepage ? "noreferrer" : undefined}>
                <span className="ex-rank">{i + 1}</span>
                <span className="ex-name">{s.name}</span>
                <span className="ex-scope">{s.source}</span>
                <span className="ex-counts">
                  {s.installs != null ? `${formatCount(s.installs)} installs` : `★ ${formatCount(s.stars)}`}
                </span>
              </a>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
