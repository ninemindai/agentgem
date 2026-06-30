import { useEffect, useState } from "react";
import { defineConsolePage } from "../../registry.js";
import { benchmarksRoute, makeClient, type BenchmarkRow } from "../../api/routes.js";
import { Loading } from "../../shell/Loading.js";

/** Network cross-model benchmark: per-model success rates aggregated across
 *  producers (k-anonymised). Shows "this Gem-kind: 92% on Opus, 71% on GPT"
 *  from real published outcomes. */
export function Benchmark({ apiBase }: { apiBase: string }) {
  const [rows, setRows] = useState<BenchmarkRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    benchmarksRoute.call(makeClient(apiBase), { query: {} })
      .then((r) => { if (alive) setRows(r); })
      .catch((e) => { if (alive) setError(String(e)); });
    return () => { alive = false; };
  }, [apiBase]);

  if (error) return <div className="obs"><p className="ledger-error">{error}</p></div>;
  if (!rows) return <div className="obs"><Loading /></div>;

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
    </section>
  );
}

export const benchmarkPage = defineConsolePage({
  id: "benchmark", title: "Benchmark", icon: "📈", order: 8, group: "observe",
  route: "#/benchmark", component: Benchmark,
});
