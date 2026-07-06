// packages/console/src/panels/Observe/index.tsx
import { useMemo, useState } from "react";
import { defineConsolePage } from "../../registry.js";
import { inventoryRoute, makeClient, type ObserveRange, type ObserveFilter } from "../../api/routes.js";
import { setPendingContribution } from "../../pendingAnalyze.js";
import { aggregateObserve } from "@agentgem/insight/observeAggregate";
import { Dashboard } from "./Dashboard.js";
import { Loading } from "../../shell/Loading.js";
import { useObserveData } from "./useObserveData.js";

// Inspect is the aggregate usage dashboard. The per-session ledger + transcript
// drill-down live in the Sessions screen (panels/Sessions); legacy #/inspect/<a>/<s>
// links are rewritten to #/sessions/<a>/<s> by normalizeHash.
export function Observe({ apiBase }: { apiBase: string }) {
  const { stats, error: fetchError, pending, onRefresh } = useObserveData(apiBase);
  const [range, setRange] = useState<ObserveRange>("7d");
  const [filter, setFilter] = useState<ObserveFilter>({ minMsgs: 100 });
  const [actionError, setActionError] = useState<string | null>(null);

  // "Share my setup" (light) and "Publish" (heavy) both need the inventory, but only when
  // the user acts — Inspect doesn't otherwise scan it, so opening Inspect stays cheap.
  const resolveSetupShare = async () => {
    const inv = await inventoryRoute.call(makeClient(apiBase));
    const parts = [
      [inv.skills.length, "skill"], [inv.mcpServers.length, "MCP"],
      [inv.instructions.length, "instruction"], [inv.hooks.length, "hook"],
    ] as const;
    const total = parts.reduce((n, [c]) => n + c, 0);
    if (total === 0) throw new Error("Nothing to share yet — add skills first");
    const provenance = parts.filter(([c]) => c > 0)
      .map(([c, w]) => `${c} ${w}${c === 1 ? "" : "s"}`).join(" · ");
    return { name: "my-setup", provenance };
  };

  const onPublishSetup = async () => {
    try {
      const inv = await inventoryRoute.call(makeClient(apiBase));
      const keys = [
        ...inv.skills.map((a) => `skills::${a.name}`),
        ...inv.mcpServers.map((a) => `mcpServers::${a.name}`),
        ...inv.instructions.map((a) => `instructions::${a.name}`),
        ...inv.hooks.map((a) => `hooks::${a.name}`),
      ];
      setPendingContribution({ keys, skillCount: inv.skills.length, lessonCount: 0, name: "my-setup" });
      window.location.hash = "#/curate";
    } catch (e) {
      setActionError(String((e as Error)?.message ?? e));
    }
  };

  // Pure, instant re-derivation on any range/filter change — no network.
  const data = useMemo(
    () => (stats ? aggregateObserve(stats, range, Date.now(), filter) : null),
    [stats, range, filter.agent, filter.project, filter.model, filter.minMsgs],
  );

  const error = fetchError ?? actionError;
  if (error) return <div className="obs"><p className="obs-error">Couldn't load Inspect: {error}</p></div>;
  if (!data) return <div className="obs"><Loading /></div>;
  // First run: the local session log is empty. Orient a brand-new user instead of a hollow
  // zeroed dashboard.
  if (stats && stats.length === 0) return (
    <div className="obs">
      <div className="obs-firstrun">
        <h2 className="obs-firstrun-title">Nothing to inspect yet</h2>
        <p className="obs-firstrun-text">
          Run an agent (Claude Code and friends) in a project, then come back — Inspect reads your
          local session log and shows what your agents actually did, so you can mine the good parts
          into gems.
        </p>
        <button type="button" className="ledger-sort" onClick={() => { window.location.hash = "#/gems/market"; }}>
          Get gems to try →
        </button>
      </div>
    </div>
  );

  return (
    <Dashboard
      data={data} range={range} onRange={setRange} filter={filter} onFilter={setFilter}
      pending={pending} onRefresh={onRefresh}
      apiBase={apiBase} resolveSetupShare={resolveSetupShare} onPublishSetup={onPublishSetup}
    />
  );
}

export const observePage = defineConsolePage({
  id: "observe", title: "Inspect", icon: "👁", order: 5, phase: "observe", category: "usage",
  route: "#/inspect", component: Observe,
});
