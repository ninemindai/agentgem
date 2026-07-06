import { useEffect, useState } from "react";
import { defineConsolePage } from "../../registry.js";
import { benchmarksRoute, effectivenessRoute, makeClient, type BenchmarkRow, type EffectivenessRow } from "../../api/routes.js";
import { Loading } from "../../shell/Loading.js";

// Only surface gems with enough judged-session volume to trust the score (SkillGem's
// `confidence > 0.3` leaderboard gate — here confidence >= 0.3, ~15+ judged sessions).
const MIN_CONFIDENCE = 0.3;

/** Network cross-model benchmark: per-model success rates aggregated across
 *  producers (k-anonymised). Shows "this Gem-kind: 92% on Opus, 71% on GPT"
 *  from real published outcomes, plus a per-gem effectiveness leaderboard. */
export function Benchmark({ apiBase }: { apiBase: string }) {
  const [rows, setRows] = useState<BenchmarkRow[] | null>(null);
  const [eff, setEff] = useState<EffectivenessRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const client = makeClient(apiBase);
    Promise.all([
      benchmarksRoute.call(client, { query: {} }),
      effectivenessRoute.call(client, { query: { sort: "score", minConfidence: MIN_CONFIDENCE } }),
    ])
      .then(([b, e]) => { if (alive) { setRows(b); setEff(e); } })
      .catch((e) => { if (alive) setError(String(e)); });
    return () => { alive = false; };
  }, [apiBase]);

  if (error) return <div className="obs"><p className="ledger-error">{error}</p></div>;
  if (!rows || !eff) return <div className="obs"><Loading /></div>;

  const sorted = [...rows].sort((a, b) => b.producers - a.producers || a.model.localeCompare(b.model));
  return (
    <section className="analyze">
      <p className="analyze-intro">How models perform on real published work — success rate per model, aggregated across producers (k-anonymised; only models with enough independent producers appear).</p>
      {sorted.length === 0 ? (
        <p className="ledger-empty">No network benchmark data yet. Publish Gems with <code>includeOutcomes</code> to contribute — once enough producers do, per-model success rates appear here.</p>
      ) : (
        <ul className="insights-bymodel">
          {sorted.map((r) => {
            const total = r.mostly + r.partially + r.notAchieved;
            return (
              <li key={r.model}>
                <span className="analyze-include-name">{r.model}</span>
                <span className="insights-rate">{total ? Math.round((r.mostly / total) * 100) : 0}% mostly</span>
                <span className="targets-label">{total} sessions · {r.producers} producers{r.verifiedProducers ? ` (${r.verifiedProducers} verified)` : ""}</span>
              </li>
            );
          })}
        </ul>
      )}

      <p className="analyze-intro">Most effective Gems — confidence-weighted success rate over judged sessions, blended toward a neutral prior until enough evidence accrues (only Gems above the confidence floor appear).</p>
      {eff.length === 0 ? (
        <p className="ledger-empty">No Gem has enough judged sessions yet. Effectiveness climbs above the prior as producers publish outcomes.</p>
      ) : (
        <ul className="insights-bymodel">
          {eff.map((r) => (
            <li key={r.gemName}>
              <span className="analyze-include-name">{r.gemName}</span>
              <span className="insights-rate">{Math.round(r.score)}%</span>
              <span className="targets-label">{r.judged} judged · {r.producers} producers{r.verifiedProducers ? ` (${r.verifiedProducers} verified)` : ""}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export const benchmarkPage = defineConsolePage({
  id: "benchmark", title: "Benchmark", icon: "📈", order: 20, phase: "observe", category: "usage",
  route: "#/benchmark", component: Benchmark,
});
