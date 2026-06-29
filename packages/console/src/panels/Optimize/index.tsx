// packages/console/src/panels/Optimize/index.tsx
import { useEffect, useState } from "react";
import { defineConsolePage } from "../../registry.js";
import { optimizeRoute, makeClient, type OptimizePayload, type OptimizeRange } from "../../api/routes.js";
import { Dashboard } from "./Dashboard.js";

export function Optimize({ apiBase }: { apiBase: string }) {
  const [data, setData] = useState<OptimizePayload | null>(null);
  const [range, setRange] = useState<OptimizeRange>("30d");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    let alive = true;
    setPending(true);
    setError(null);
    optimizeRoute.call(makeClient(apiBase), { query: { range } })
      .then((p) => { if (alive) setData(p); })
      .catch((e) => { if (alive) setError(String(e?.message ?? e)); })
      .finally(() => { if (alive) setPending(false); });
    return () => { alive = false; };
  }, [apiBase, range]);

  if (error) return <div className="opt"><p className="obs-error">Couldn't load Optimize: {error}</p></div>;
  if (!data) return <div className="opt"><p className="obs-loading">Loading…</p></div>;
  return <Dashboard data={data} range={range} onRange={setRange} pending={pending} />;
}

export const optimizePage = defineConsolePage({
  id: "optimize", title: "Optimize", icon: "⚡", order: 6, group: "observe",
  route: "#/optimize", component: Optimize,
});
