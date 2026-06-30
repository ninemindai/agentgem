// packages/console/src/panels/Observe/index.tsx
import { useEffect, useRef, useState } from "react";
import { defineConsolePage } from "../../registry.js";
import { observeRoute, makeClient, type ObservePayload, type ObserveRange, type ObserveFilter } from "../../api/routes.js";
import { Dashboard } from "./Dashboard.js";
import { Loading } from "../../shell/Loading.js";

export function Observe({ apiBase }: { apiBase: string }) {
  const [data, setData] = useState<ObservePayload | null>(null);
  const [range, setRange] = useState<ObserveRange>("7d");
  const [filter, setFilter] = useState<ObserveFilter>({ minMsgs: 100 });
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  // A manual refresh forces ?fresh=1 for that one fetch; the ref keeps it out of
  // the dep array so range/filter changes stay normal (cache-eligible) re-fetches.
  const freshRef = useRef(false);

  useEffect(() => {
    let alive = true;
    setPending(true);
    setError(null);
    const fresh = freshRef.current; freshRef.current = false;
    observeRoute.call(makeClient(apiBase), { query: { range, ...filter, ...(fresh ? { refresh: true } : {}) } })
      .then((p) => { if (alive) setData(p); })
      .catch((e) => { if (alive) setError(String(e?.message ?? e)); })
      .finally(() => { if (alive) setPending(false); });
    return () => { alive = false; };
  }, [apiBase, range, filter.agent, filter.project, filter.model, filter.minMsgs, reloadKey]);

  const onRefresh = () => { freshRef.current = true; setReloadKey((k) => k + 1); };

  if (error) return <div className="obs"><p className="obs-error">Couldn't load Inspect: {error}</p></div>;
  if (!data) return <div className="obs"><Loading /></div>;
  return (
    <div className="obs">
      <Dashboard data={data} range={range} onRange={setRange} filter={filter} onFilter={setFilter} pending={pending} onRefresh={onRefresh} />
    </div>
  );
}

export const observePage = defineConsolePage({
  id: "observe", title: "Inspect", icon: "👁", order: 5, group: "observe",
  route: "#/inspect", component: Observe,
});
