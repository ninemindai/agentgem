// packages/console/src/panels/Optimize/index.tsx
import { useEffect, useRef, useState } from "react";
import { defineConsolePage } from "../../registry.js";
import { optimizeRoute, makeClient, type OptimizePayload, type OptimizeRange } from "../../api/routes.js";
import { Dashboard } from "./Dashboard.js";
import { Loading } from "../../shell/Loading.js";

export function Optimize({ apiBase }: { apiBase: string }) {
  const [data, setData] = useState<OptimizePayload | null>(null);
  const [range, setRange] = useState<OptimizeRange>("30d");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  // A manual refresh forces ?refresh=true for that one fetch; the ref keeps it out
  // of the dep array so range changes stay normal (cache-eligible) re-fetches.
  const freshRef = useRef(false);

  useEffect(() => {
    let alive = true;
    setPending(true);
    setError(null);
    const fresh = freshRef.current; freshRef.current = false;
    optimizeRoute.call(makeClient(apiBase), { query: { range, ...(fresh ? { refresh: true } : {}) } })
      .then((p) => { if (alive) setData(p); })
      .catch((e) => { if (alive) setError(String(e?.message ?? e)); })
      .finally(() => { if (alive) setPending(false); });
    return () => { alive = false; };
  }, [apiBase, range, reloadKey]);

  const onRefresh = () => { freshRef.current = true; setReloadKey((k) => k + 1); };

  if (error) return <div className="opt"><p className="obs-error">Couldn't load Optimize: {error}</p></div>;
  if (!data) return <div className="opt"><Loading /></div>;
  return <Dashboard data={data} range={range} onRange={setRange} pending={pending} onRefresh={onRefresh} />;
}

export const optimizePage = defineConsolePage({
  id: "optimize", title: "Optimize", icon: "⚡", order: 6, group: "observe",
  route: "#/optimize", component: Optimize,
});
