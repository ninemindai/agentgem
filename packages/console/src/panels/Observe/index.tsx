// packages/console/src/panels/Observe/index.tsx
import { useEffect, useState } from "react";
import { defineConsolePage } from "../../registry.js";
import { observeRoute, makeClient, type ObservePayload, type ObserveRange } from "../../api/routes.js";
import { Dashboard } from "./Dashboard.js";

export function Observe({ apiBase }: { apiBase: string }) {
  const [data, setData] = useState<ObservePayload | null>(null);
  const [range, setRange] = useState<ObserveRange>("7d");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setError(null);
    observeRoute.call(makeClient(apiBase), { query: { range } })
      .then((p) => { if (alive) setData(p); })
      .catch((e) => { if (alive) setError(String(e?.message ?? e)); });
    return () => { alive = false; };
  }, [apiBase, range]);

  if (error) return <div className="obs"><p className="obs-error">Couldn't load Observe: {error}</p></div>;
  if (!data) return <div className="obs"><p className="obs-loading">Loading…</p></div>;
  return <Dashboard data={data} range={range} onRange={setRange} />;
}

export const observePage = defineConsolePage({
  id: "observe", title: "Observe", icon: "👁", order: 5, group: "observe",
  route: "#/observe", component: Observe,
});
