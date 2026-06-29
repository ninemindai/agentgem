// packages/console/src/panels/Observe/index.tsx
import { useEffect, useState } from "react";
import { defineConsolePage } from "../../registry.js";
import { observeRoute, makeClient, type ObservePayload, type ObserveRange, type ObserveFilter } from "../../api/routes.js";
import { Dashboard } from "./Dashboard.js";

export function Observe({ apiBase }: { apiBase: string }) {
  const [data, setData] = useState<ObservePayload | null>(null);
  const [range, setRange] = useState<ObserveRange>("7d");
  const [filter, setFilter] = useState<ObserveFilter>({});
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    let alive = true;
    setPending(true);
    setError(null);
    observeRoute.call(makeClient(apiBase), { query: { range, ...filter } })
      .then((p) => { if (alive) setData(p); })
      .catch((e) => { if (alive) setError(String(e?.message ?? e)); })
      .finally(() => { if (alive) setPending(false); });
    return () => { alive = false; };
  }, [apiBase, range, filter.agent, filter.project, filter.model, filter.minMsgs]);

  if (error) return <div className="obs"><p className="obs-error">Couldn't load Observe: {error}</p></div>;
  if (!data) return <div className="obs"><p className="obs-loading">Loading…</p></div>;
  return <Dashboard data={data} range={range} onRange={setRange} filter={filter} onFilter={setFilter} pending={pending} />;
}

export const observePage = defineConsolePage({
  id: "observe", title: "Observe", icon: "👁", order: 5, group: "observe",
  route: "#/observe", component: Observe,
});
