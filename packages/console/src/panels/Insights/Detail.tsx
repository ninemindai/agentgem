import { useEffect, useState } from "react";
import {
  coOccurrenceRoute, adoptionRoute, makeClient,
  type AggCoOccurrence, type AdoptionPoint,
} from "../../api/routes.js";
import { prettifyId } from "./data.js";
import { Sparkline } from "./Sparkline.js";
import { setPendingQuery } from "../GetGems/intent.js";

export function Detail({ id, apiBase }: { id: string; apiBase: string }) {
  const [co, setCo] = useState<AggCoOccurrence[]>([]);
  const [series, setSeries] = useState<AdoptionPoint[]>([]);
  const [bucket, setBucket] = useState<"week" | "month">("week");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true); setError(null);
    const client = makeClient(apiBase);
    Promise.all([
      coOccurrenceRoute.call(client, { query: { id } }),
      adoptionRoute.call(client, { query: { id, bucket } }),
    ]).then(([c, a]) => { if (!alive) return; setCo(c); setSeries(a); })
      .catch((e) => { if (alive) setError(String(e?.message ?? e)); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [id, bucket, apiBase]);

  const head = prettifyId(id, "skill");
  if (error) return <div className="ins-detail"><p className="ins-error">Couldn't load insight: {error}</p></div>;

  return (
    <div className="ins-detail">
      <div className="ins-detail-head">
        <span className="ins-detail-name">{head.name}</span>
        {head.scope && <span className="ins-scope">{head.scope}</span>}
        <button
          type="button"
          className="ins-find-gems"
          onClick={() => { setPendingQuery(head.name); window.location.hash = "#/get-gems"; }}
        >
          Find Gems using this →
        </button>
      </div>

      <section className="ins-card">
        <h4>Used together with</h4>
        {!loading && co.length === 0 && <p className="ins-empty">Not enough data yet.</p>}
        <ul className="ins-co">
          {co.map((c) => {
            const p = prettifyId(c.id, "skill");
            return (
              <li key={c.id}>
                <span className="ins-co-name">{p.name}</span>
                <span className="ins-counts">{c.producers} · {c.verifiedProducers} ✓</span>
              </li>
            );
          })}
        </ul>
      </section>

      <section className="ins-card">
        <div className="ins-card-head">
          <h4>Adoption</h4>
          <div className="ins-bucket">
            {(["week", "month"] as const).map((b) => (
              <button key={b} type="button" className={"ins-bucket-btn" + (b === bucket ? " is-active" : "")} onClick={() => setBucket(b)}>{b}</button>
            ))}
          </div>
        </div>
        <Sparkline values={series.map((s) => s.producers)} verified={series.map((s) => s.verifiedProducers)} />
        <p className="ins-legend"><span className="ins-dot ins-dot-prod" /> producers <span className="ins-dot ins-dot-ver" /> verified</p>
      </section>
    </div>
  );
}
