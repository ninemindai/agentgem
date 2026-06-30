import { useEffect, useState } from "react";
import type { makeApi } from "../api";
import type { AggCoOccurrence, AdoptionPoint } from "../types";
import { prettifyId } from "../data";
import { Sparkline } from "../Sparkline";
import { StarButton } from "../StarButton";
import type { StarsCtx } from "../Router";
import type { StarState } from "../stars";

export function Ingredient({ api, id, stars }: { api: ReturnType<typeof makeApi>; id: string; stars: StarsCtx }) {
  const [co, setCo] = useState<AggCoOccurrence[]>([]);
  const [series, setSeries] = useState<AdoptionPoint[]>([]);
  const [bucket, setBucket] = useState<"week" | "month">("week");
  const [error, setError] = useState<string | null>(null);
  const [starState, setStarState] = useState<StarState>({ counts: {}, mine: [] });

  useEffect(() => {
    let alive = true;
    setError(null); setCo([]); setSeries([]);
    Promise.all([api.getCoOccurrence({ id }), api.getAdoption({ id, bucket })])
      .then(([c, a]) => { if (!alive) return; setCo(c); setSeries(a); })
      .catch((e) => { if (alive) setError(String(e?.message ?? e)); });
    return () => { alive = false; };
    // api is a stable module-level singleton (App.tsx) — excluded so re-renders don't refetch.
  }, [id, bucket]);

  useEffect(() => {
    if (!id) return;
    let alive = true;
    stars.api.get("ingredient", [id]).then((s) => { if (alive) setStarState(s); });
    return () => { alive = false; };
  }, [id, stars.api]);

  const head = prettifyId(id, "skill");
  if (error) return <div className="ex-detail"><p className="ex-error">Couldn't load this ingredient: {error}</p></div>;

  return (
    <div className="ex-detail">
      <h2 className="ex-detail-head">{head.name}{head.scope && <span className="ex-scope">{head.scope}</span>}
        <StarButton kind="ingredient" id={id} count={starState.counts[id] ?? 0} starred={starState.mine.includes(id)}
          signedIn={stars.signedIn} loginUrl={stars.loginUrl} api={stars.api} />
      </h2>

      <section className="ex-card">
        <h3>Used together with</h3>
        {co.length === 0 && <p className="ex-empty">Not enough data yet.</p>}
        <ul className="ex-co">
          {co.map((c) => {
            const p = prettifyId(c.id, "skill");
            return <li key={c.id}><span>{p.name}</span><span className="ex-counts">{c.producers} · {c.verifiedProducers} ✓</span></li>;
          })}
        </ul>
      </section>

      <section className="ex-card">
        <div className="ex-card-head">
          <h3>Adoption</h3>
          <div className="ex-bucket">
            {(["week", "month"] as const).map((b) => (
              <button key={b} type="button" className={"ex-bucket-btn" + (b === bucket ? " is-active" : "")} onClick={() => setBucket(b)}>{b}</button>
            ))}
          </div>
        </div>
        <Sparkline values={series.map((s) => s.producers)} verified={series.map((s) => s.verifiedProducers)} />
        <p className="ex-legend"><span className="ex-dot ex-dot-prod" /> producers <span className="ex-dot ex-dot-ver" /> verified</p>
      </section>
    </div>
  );
}
