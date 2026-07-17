// packages/console/src/panels/Observe/index.tsx
import { useEffect, useMemo, useState } from "react";
import { defineConsolePage } from "../../registry.js";
import { inventoryRoute, makeClient, type ObserveRange, type ObserveFilter } from "../../api/routes.js";
import { setPendingContribution } from "../../pendingAnalyze.js";
import { aggregateObserve } from "@agentgem/insight/observeAggregate";
import { Dashboard } from "./Dashboard.js";
import { Loading } from "../../shell/Loading.js";
import { useObserveData } from "./useObserveData.js";

const VIEW_KEY = "agentgem.observe.view";
const VIEW_RANGES: ObserveRange[] = ["today", "7d", "30d", "all"];

/** 4A + 3A: validated sessionStorage rehydration. Garbage, old-build values, or
 *  wrong types fall back to the defaults; a stale `project` passes through (the
 *  card's ✕ chip is the recovery affordance). Exported for tests. */
export function loadObserveView(): { range: ObserveRange; filter: ObserveFilter } {
  const fallback: { range: ObserveRange; filter: ObserveFilter } = { range: "7d", filter: { minMsgs: 100 } };
  try {
    const raw = sessionStorage.getItem(VIEW_KEY);
    if (!raw) return fallback;
    const v = JSON.parse(raw) as { range?: unknown; filter?: Record<string, unknown> };
    const range = VIEW_RANGES.includes(v.range as ObserveRange) ? (v.range as ObserveRange) : fallback.range;
    const f = v.filter ?? {};
    const str = (x: unknown) => (typeof x === "string" && x !== "" ? x : undefined);
    // A stored blob with no minMsgs means the user CLEARED it — keep it cleared.
    const minMsgs = !("minMsgs" in f) ? undefined
      : typeof f.minMsgs === "number" && Number.isFinite(f.minMsgs) ? f.minMsgs
      : fallback.filter.minMsgs;
    return { range, filter: { agent: str(f.agent), project: str(f.project), model: str(f.model), minMsgs } };
  } catch {
    return fallback;
  }
}

// Inspect is the aggregate usage dashboard. The per-session ledger + transcript
// drill-down live in the Sessions screen (panels/Sessions); legacy #/inspect/<a>/<s>
// links are rewritten to #/sessions/<a>/<s> by normalizeHash.
export function Observe({ apiBase }: { apiBase: string }) {
  const { stats, error: fetchError, pending, onRefresh } = useObserveData(apiBase);
  const [range, setRange] = useState<ObserveRange>(() => loadObserveView().range);
  const [filter, setFilter] = useState<ObserveFilter>(() => loadObserveView().filter);
  // Persist the view so the triage loop (Overview → session detail → back) keeps
  // its investigation context (4A). Best-effort: a blocked/full store is harmless.
  useEffect(() => {
    try { sessionStorage.setItem(VIEW_KEY, JSON.stringify({ range, filter })); } catch { /* best-effort */ }
  }, [range, filter]);
  const [actionError, setActionError] = useState<string | null>(null);

  // "Share my setup" (light) and "Publish" (heavy) both need the inventory, but only when
  // the user acts — Inspect doesn't otherwise scan it, so opening Inspect stays cheap.
  const resolveSetupShare = async () => {
    const inv = await inventoryRoute.call(makeClient(apiBase), { query: {} });
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
      const inv = await inventoryRoute.call(makeClient(apiBase), { query: {} });
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
  if (error) return <div className="obs"><p className="obs-error">Couldn't load Overview: {error}</p></div>;
  if (!data) return <div className="obs"><Loading /></div>;
  // First run: the local session log is empty. Orient a brand-new user instead of a hollow
  // zeroed dashboard.
  if (stats && stats.length === 0) return (
    <div className="obs">
      <div className="obs-firstrun">
        <h2 className="obs-firstrun-title">Nothing to inspect yet</h2>
        <p className="obs-firstrun-text">
          Run an agent (Claude Code and friends) in a project, then come back — Overview reads your
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
  id: "overview", title: "Overview", icon: "👁", order: 5, phase: "observe", category: "usage",
  route: "#/overview", component: Observe,
});
