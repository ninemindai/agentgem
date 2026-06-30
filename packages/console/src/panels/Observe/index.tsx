// packages/console/src/panels/Observe/index.tsx
import { useEffect, useMemo, useRef, useState } from "react";
import { defineConsolePage } from "../../registry.js";
import { observeRawRoute, makeClient, type ObserveRange, type ObserveFilter } from "../../api/routes.js";
import { aggregateObserve, type SessionStat } from "@agentgem/insight/observeAggregate";
import { Dashboard } from "./Dashboard.js";
import { TranscriptViewer } from "./TranscriptViewer.js";
import { Loading } from "../../shell/Loading.js";

// Sub-route under #/inspect: #/inspect/<agent>/<sessionId> opens the transcript
// drill-down for one session. Anything else (incl. bare #/inspect) is the aggregate.
function parseSelection(hash: string): { agent: "claude" | "codex"; sessionId: string } | null {
  const m = /^#\/inspect\/(claude|codex)\/(.+)$/.exec(hash.split("?")[0]);
  return m ? { agent: m[1] as "claude" | "codex", sessionId: decodeURIComponent(m[2]) } : null;
}

export function Observe({ apiBase }: { apiBase: string }) {
  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => {
    const onHash = () => setHash(window.location.hash);
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  const selection = parseSelection(hash);
  const [stats, setStats] = useState<SessionStat[] | null>(null);
  const [range, setRange] = useState<ObserveRange>("7d");
  const [filter, setFilter] = useState<ObserveFilter>({ minMsgs: 100 });
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  // The heavy cost is the disk scan, so fetch the raw stats ONCE (and on Refresh)
  // and derive every range/filter view locally via the shared aggregateObserve —
  // range tabs and filters then cost zero API calls. freshRef forces ?refresh=true
  // for a manual reload while staying out of the dep array.
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

  // Pure, instant re-derivation on any range/filter change — no network.
  const data = useMemo(
    () => (stats ? aggregateObserve(stats, range, Date.now(), filter) : null),
    [stats, range, filter.agent, filter.project, filter.model, filter.minMsgs],
  );

  if (selection) {
    return (
      <div className="obs">
        <TranscriptViewer apiBase={apiBase} agent={selection.agent} sessionId={selection.sessionId}
          onBack={() => { window.location.hash = "#/inspect"; }} />
      </div>
    );
  }

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
