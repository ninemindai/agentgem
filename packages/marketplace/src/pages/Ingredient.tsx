import { useEffect, useState } from "react";
import type { makeApi } from "../api";
import type { AggCoOccurrence, AdoptionPoint } from "../types";
import { prettifyId } from "../data";
import { Sparkline } from "../Sparkline";

export function Ingredient({ api, id }: { api: ReturnType<typeof makeApi>; id: string }) {
  const [co, setCo] = useState<AggCoOccurrence[]>([]);
  const [series, setSeries] = useState<AdoptionPoint[]>([]);
  const [bucket, setBucket] = useState<"week" | "month">("week");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setError(null);
    Promise.all([api.getCoOccurrence({ id }), api.getAdoption({ id, bucket })])
      .then(([c, a]) => { if (!alive) return; setCo(c); setSeries(a); })
      .catch((e) => { if (alive) setError(String(e?.message ?? e)); });
    return () => { alive = false; };
  }, [api, id, bucket]);

  const head = prettifyId(id, "skill");
  if (error) return <div className="ex-detail"><p className="ex-error">Couldn't load this ingredient: {error}</p></div>;

  return (
    <div className="ex-detail">
      <h2 className="ex-detail-head">{head.name}{head.scope && <span className="ex-scope">{head.scope}</span>}</h2>

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
