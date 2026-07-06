import { useEffect, useRef, useState } from "react";
import { observeRawRoute, makeClient } from "../../api/routes.js";
import { type SessionStat } from "@agentgem/insight/observeAggregate";

/** Shared session-stats fetch for Inspect (charts) and Sessions (the ledger table).
 *  The heavy cost is the disk scan, so fetch the raw stats ONCE (and on Refresh); each
 *  screen derives its own range/filter view locally via aggregateObserve. `freshRef`
 *  forces ?refresh=true for a manual reload without entering the dep array. The server
 *  caches the scan, so mounting both screens does not re-scan. */
export function useObserveData(apiBase: string) {
  const [stats, setStats] = useState<SessionStat[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const freshRef = useRef(false);

  useEffect(() => {
    let alive = true;
    setPending(true);
    setError(null);
    const fresh = freshRef.current; freshRef.current = false;
    observeRawRoute.call(makeClient(apiBase), { query: fresh ? { refresh: true } : {} })
      .then((p) => { if (alive) setStats(p.sessions); })
      .catch((e) => { if (alive) setError(String(e?.message ?? e)); })
      .finally(() => { if (alive) setPending(false); });
    return () => { alive = false; };
  }, [apiBase, reloadKey]);

  const onRefresh = () => { freshRef.current = true; setReloadKey((k) => k + 1); };
  return { stats, error, pending, onRefresh };
}
