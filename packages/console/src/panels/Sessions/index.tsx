import { useEffect, useMemo, useState } from "react";
import { defineConsolePage } from "../../registry.js";
import { type ObserveRange, type ObserveFilter } from "../../api/routes.js";
import { aggregateObserve } from "@agentgem/insight/observeAggregate";
import { useObserveData } from "../Observe/useObserveData.js";
import { RangeTabs, ObserveFilters } from "../Observe/ObserveControls.js";
import { SessionsTable } from "./SessionsTable.js";
import { TranscriptViewer } from "../Observe/TranscriptViewer.js";
import { TranscriptDiff } from "../Observe/TranscriptDiff.js";
import { RefreshButton } from "../../shell/RefreshButton.js";
import { Loading } from "../../shell/Loading.js";

type Ref = { agent: "claude" | "codex"; sessionId: string };

// Sub-route under #/sessions:
//   #/sessions/<agent>/<sessionId>              → single-session transcript viewer
//   #/sessions/<agent>/<sessionId>?vs=<a>:<id>  → side-by-side diff vs. another run
// Anything else (incl. bare #/sessions) is the ledger table.
function parseSelection(hash: string): { a: Ref; b: Ref | null } | null {
  const [path, query] = hash.split("?");
  const m = /^#\/sessions\/(claude|codex)\/(.+)$/.exec(path);
  if (!m) return null;
  const a: Ref = { agent: m[1] as Ref["agent"], sessionId: decodeURIComponent(m[2]) };
  const vs = new URLSearchParams(query ?? "").get("vs");
  const vm = vs ? /^(claude|codex):(.+)$/.exec(vs) : null;
  const b: Ref | null = vm ? { agent: vm[1] as Ref["agent"], sessionId: decodeURIComponent(vm[2]) } : null;
  return { a, b };
}

export function Sessions({ apiBase }: { apiBase: string }) {
  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => {
    const onHash = () => setHash(window.location.hash);
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  const selection = parseSelection(hash);

  const { stats, error, pending, onRefresh } = useObserveData(apiBase);
  const [range, setRange] = useState<ObserveRange>("7d");
  const [filter, setFilter] = useState<ObserveFilter>({ minMsgs: 100 });
  const data = useMemo(
    () => (stats ? aggregateObserve(stats, range, Date.now(), filter) : null),
    [stats, range, filter.agent, filter.project, filter.model, filter.minMsgs],
  );

  if (selection) {
    const back = () => { window.location.hash = "#/sessions"; };
    return (
      <div className="obs">
        {selection.b
          ? <TranscriptDiff apiBase={apiBase} a={selection.a} b={selection.b} onBack={back} />
          : <TranscriptViewer apiBase={apiBase} agent={selection.a.agent} sessionId={selection.a.sessionId} onBack={back} />}
      </div>
    );
  }

  if (error) return <div className="obs"><p className="obs-error">Couldn't load sessions: {error}</p></div>;
  if (!data) return <div className="obs"><Loading /></div>;
  if (stats && stats.length === 0) return (
    <div className="obs">
      <div className="obs-firstrun">
        <h2 className="obs-firstrun-title">No sessions yet</h2>
        <p className="obs-firstrun-text">
          Run an agent in a project, then come back — your session history and transcripts land here.
        </p>
      </div>
    </div>
  );

  return (
    <div className="obs">
      <div className="obs-head">
        <h2 className="obs-title">Sessions</h2>
        {pending && <span className="obs-pending-pill">Updating…</span>}
        <RangeTabs range={range} onRange={setRange} />
        <RefreshButton onClick={onRefresh} busy={pending} />
      </div>
      <ObserveFilters data={data} filter={filter} onFilter={setFilter} />
      <SessionsTable data={data} />
    </div>
  );
}

export const sessionsPage = defineConsolePage({
  id: "sessions",
  title: "History",
  icon: "🗒",
  order: 5,
  phase: "observe",
  category: "sessions",
  route: "#/sessions",
  component: Sessions,
});
