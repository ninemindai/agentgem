// packages/console/src/panels/Optimize/index.tsx
import { useEffect, useRef, useState } from "react";
import { defineConsolePage } from "../../registry.js";
import { optimizeRoute, makeClient, type OptimizePayload, type OptimizeRange } from "../../api/routes.js";
import { Dashboard } from "./Dashboard.js";
import { Loading } from "../../shell/Loading.js";
import { type Scope } from "../_shared/ScopePicker.js";

export function Optimize({ apiBase }: { apiBase: string }) {
  const [data, setData] = useState<OptimizePayload | null>(null);
  const [range, setRange] = useState<OptimizeRange>("30d");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [scope, setScope] = useState<Scope>({ kind: "global" });
  const root = scope.kind === "project" ? scope.root : undefined;
  // A manual refresh forces ?refresh=true for that one fetch; the ref keeps it out
  // of the dep array so range changes stay normal (cache-eligible) re-fetches.
  const freshRef = useRef(false);
  // Stale-while-revalidate: the first global fetch can return usageStale=true (figures served from a
  // still-building index). We keep re-fetching on a short timer until it clears, so the panel fills
  // in without a blocking spinner. Capped so a persistently-stale index can't poll forever.
  const [pollKey, setPollKey] = useState(0);
  const pollCount = useRef(0);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let alive = true;
    setPending(true);
    setError(null);
    const fresh = freshRef.current; freshRef.current = false;
    optimizeRoute.call(makeClient(apiBase), { query: { range, ...(root ? { root } : {}), ...(fresh ? { refresh: true } : {}) } })
      .then((p) => {
        if (!alive) return;
        setData(p);
        if (p.usageStale && pollCount.current < 40) {
          pollCount.current += 1;
          pollTimer.current = setTimeout(() => { if (alive) setPollKey((k) => k + 1); }, 1500);
        } else {
          pollCount.current = 0;   // fresh (or gave up): stop the poll loop
        }
      })
      .catch((e) => { if (alive) setError(String(e?.message ?? e)); })
      .finally(() => { if (alive) setPending(false); });
    return () => { alive = false; if (pollTimer.current) { clearTimeout(pollTimer.current); pollTimer.current = null; } };
  }, [apiBase, range, reloadKey, root, pollKey]);

  const onRefresh = () => { freshRef.current = true; setReloadKey((k) => k + 1); };
  // Apply a local, network-free transform after a disable/re-enable so the panel
  // updates instantly instead of forcing a full re-scan (onRefresh stays for the
  // explicit Refresh button).
  const onMutate = (fn: (p: OptimizePayload) => OptimizePayload) => setData((prev) => (prev ? fn(prev) : prev));

  if (error) return <div className="opt"><p className="obs-error">Couldn't load Optimize: {error}</p></div>;
  if (!data) return <div className="opt"><Loading /></div>;
  return <Dashboard data={data} range={range} onRange={setRange} pending={pending} onRefresh={onRefresh} onMutate={onMutate} apiBase={apiBase} scope={scope} onScope={setScope} />;
}

export const optimizePage = defineConsolePage({
  id: "optimize", title: "Optimize", icon: "⚡", order: 20, phase: "observe", category: "projects",
  route: "#/optimize", component: Optimize,
});
