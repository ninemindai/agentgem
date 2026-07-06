// packages/console/src/panels/Observe/index.tsx
import { useEffect, useMemo, useRef, useState } from "react";
import { defineConsolePage } from "../../registry.js";
import { observeRawRoute, inventoryRoute, makeClient, type ObserveRange, type ObserveFilter } from "../../api/routes.js";
import { setPendingContribution } from "../../pendingAnalyze.js";
import { aggregateObserve, type SessionStat } from "@agentgem/insight/observeAggregate";
import { Dashboard } from "./Dashboard.js";
import { TranscriptViewer } from "./TranscriptViewer.js";
import { TranscriptDiff } from "./TranscriptDiff.js";
import { Loading } from "../../shell/Loading.js";

type Ref = { agent: "claude" | "codex"; sessionId: string };

// Sub-route under #/inspect:
//   #/inspect/<agent>/<sessionId>              → single-session transcript viewer
//   #/inspect/<agent>/<sessionId>?vs=<a>:<id>  → side-by-side diff vs. another run
// Anything else (incl. bare #/inspect) is the aggregate dashboard.
function parseSelection(hash: string): { a: Ref; b: Ref | null } | null {
  const [path, query] = hash.split("?");
  const m = /^#\/inspect\/(claude|codex)\/(.+)$/.exec(path);
  if (!m) return null;
  const a: Ref = { agent: m[1] as Ref["agent"], sessionId: decodeURIComponent(m[2]) };
  const vs = new URLSearchParams(query ?? "").get("vs");
  const vm = vs ? /^(claude|codex):(.+)$/.exec(vs) : null;
  const b: Ref | null = vm ? { agent: vm[1] as Ref["agent"], sessionId: decodeURIComponent(vm[2]) } : null;
  return { a, b };
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

  // Light "Share link" path: fetch inventory once on load to build provenance
  // (counts by kind) and detect an empty setup, up front — unlike Publish below,
  // this can't defer the fetch to click-time because the button itself needs to
  // know whether to disable.
  const [setupShare, setSetupShare] = useState<{ name: string; provenance: string; empty: boolean } | null>(null);
  const inventoryRef = useRef<Awaited<ReturnType<typeof inventoryRoute.call>> | null>(null);

  useEffect(() => {
    let alive = true;
    inventoryRoute.call(makeClient(apiBase)).then((inv) => {
      if (!alive) return;
      inventoryRef.current = inv;
      const parts = [
        [inv.skills.length, "skill"], [inv.mcpServers.length, "MCP"],
        [inv.instructions.length, "instruction"], [inv.hooks.length, "hook"],
      ] as const;
      const total = parts.reduce((n, [c]) => n + c, 0);
      const provenance = parts.filter(([c]) => c > 0)
        .map(([c, w]) => `${c} ${w}${c === 1 ? "" : "s"}`).join(" · ");
      setSetupShare({ name: "my-setup", provenance, empty: total === 0 });
    }).catch(() => setSetupShare({ name: "my-setup", provenance: "", empty: true }));
    return () => { alive = false; };
  }, [apiBase]);

  // "Publish": bundle the whole inventory into a Gem via Curate's Publish
  // flow. Reuses the inventory fetched by the setupShare effect above; only
  // refetches if the click races ahead of that effect resolving.
  const onPublishSetup = async () => {
    try {
      const inv = inventoryRef.current ?? await inventoryRoute.call(makeClient(apiBase));
      const keys = [
        ...inv.skills.map((a) => `skills::${a.name}`),
        ...inv.mcpServers.map((a) => `mcpServers::${a.name}`),
        ...inv.instructions.map((a) => `instructions::${a.name}`),
        ...inv.hooks.map((a) => `hooks::${a.name}`),
      ];
      setPendingContribution({ keys, skillCount: inv.skills.length, lessonCount: 0, name: "my-setup" });
      window.location.hash = "#/curate";
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    }
  };

  // Pure, instant re-derivation on any range/filter change — no network.
  const data = useMemo(
    () => (stats ? aggregateObserve(stats, range, Date.now(), filter) : null),
    [stats, range, filter.agent, filter.project, filter.model, filter.minMsgs],
  );

  if (selection) {
    const back = () => { window.location.hash = "#/inspect"; };
    return (
      <div className="obs">
        {selection.b
          ? <TranscriptDiff apiBase={apiBase} a={selection.a} b={selection.b} onBack={back} />
          : <TranscriptViewer apiBase={apiBase} agent={selection.a.agent} sessionId={selection.a.sessionId} onBack={back} />}
      </div>
    );
  }

  if (error) return <div className="obs"><p className="obs-error">Couldn't load Inspect: {error}</p></div>;
  if (!data) return <div className="obs"><Loading /></div>;
  return (
    <div className="obs">
      <Dashboard
        data={data} range={range} onRange={setRange} filter={filter} onFilter={setFilter}
        pending={pending} onRefresh={onRefresh}
        apiBase={apiBase} setupShare={setupShare} onPublishSetup={onPublishSetup}
      />
    </div>
  );
}

export const observePage = defineConsolePage({
  id: "observe", title: "Inspect", icon: "👁", order: 5, group: "observe",
  route: "#/inspect", component: Observe,
});
