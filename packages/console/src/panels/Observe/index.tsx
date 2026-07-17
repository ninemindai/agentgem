// packages/console/src/panels/Observe/index.tsx
import { useEffect, useMemo, useRef, useState } from "react";
import { defineConsolePage } from "../../registry.js";
import { inventoryRoute, makeClient, type ObserveRange, type ObserveFilter, type Scorecard } from "../../api/routes.js";
import { setPendingContribution } from "../../pendingAnalyze.js";
import { aggregateObserve } from "@agentgem/insight/observeAggregate";
import { Dashboard } from "./Dashboard.js";
import { Loading } from "../../shell/Loading.js";
import { useObserveData } from "./useObserveData.js";
import { useHomeState } from "../../shell/useHomeState.js";
import { Reveal, RevealLoadingShell } from "./Reveal.js";
import { openScorecardStream, type ScorecardStreamEvent } from "../Mine/scorecardStream.js";
import { ScorecardHero, ScorecardHeroSkeleton, ScorecardScanning } from "../Mine/Scorecard.js";

const VIEW_KEY = "agentgem.observe.view";
const VIEW_RANGES: ObserveRange[] = ["today", "7d", "30d", "all"];

/** 4A + 3A: validated sessionStorage rehydration. Garbage, old-build values, or
 *  wrong types fall back to the defaults; a stale `project` passes through (the
 *  card's ✕ chip is the recovery affordance). */
function loadObserveView(): { range: ObserveRange; filter: ObserveFilter } {
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

// Home/reveal (page id stays "overview", route stays "#/overview" — deep links and the
// rail depend on it): a one-time consent + streaming-reveal ceremony for first-run and
// existing users (see Reveal.tsx), then a condensed masthead scoreboard + this same
// usage dashboard beneath, once `revealSeen`. The per-session ledger + transcript
// drill-down live in the Sessions screen; legacy #/inspect/<a>/<s> links are rewritten
// to #/sessions/<a>/<s> by normalizeHash.
export function Observe({ apiBase }: { apiBase: string }) {
  const home = useHomeState(apiBase);

  // Nothing is known about the visitor yet — render the masthead skeleton only.
  // Critically, this must NOT mount Reveal in first-run mode (which itself makes
  // zero fetches, but would show the consent copy prematurely, before we know
  // whether the visitor is actually first-run, existing, or returning).
  if (home.loading) return <RevealLoadingShell />;

  if (home.revealSeen) return <ReturningOverview apiBase={apiBase} />;

  return (
    <Reveal
      apiBase={apiBase}
      mode={home.existingUser ? "ceremony" : "first-run"}
      onDismiss={() => home.setRevealSeen(true)}
    />
  );
}

// Returning-user mode: a condensed scorecard scoreboard (Mine's own components —
// no second scorecard renderer) sits above the fold, with the existing usage
// dashboard beneath it. No deltas (P0.5) — this is a plain re-scan, same shape
// WorkflowsView uses for the Mine tab.
function ReturningOverview({ apiBase }: { apiBase: string }) {
  const [scorecard, setScorecard] = useState<Scorecard | null>(null);
  const [scorecardUpdatedAt, setScorecardUpdatedAt] = useState<number | null>(null);
  const [scorecardPhase, setScorecardPhase] = useState<"loading" | "scanning" | "done" | "failed">("loading");
  const [progress, setProgress] = useState<{ done: number; total: number; label: string; partial: { breadth: number; battleTested: number; portable: number } } | null>(null);
  const freshRef = useRef(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    setScorecard(null); setScorecardUpdatedAt(null); setScorecardPhase("loading"); setProgress(null);
    const fresh = freshRef.current; freshRef.current = false;
    const close = openScorecardStream(makeClient(apiBase), (e: ScorecardStreamEvent) => {
      if (e.type === "start") setScorecardPhase((p) => (p === "done" ? p : "scanning"));
      else if (e.type === "stale") { setScorecard(e.scorecard); setScorecardUpdatedAt(e.updatedAt); setScorecardPhase("done"); }
      else if (e.type === "progress") { setProgress({ done: e.done, total: e.total, label: e.label, partial: e.partial }); setScorecardPhase((p) => (p === "done" ? p : "scanning")); }
      else if (e.type === "done") { setScorecard(e.scorecard); setScorecardUpdatedAt(e.updatedAt); setScorecardPhase("done"); }
      else if (e.type === "failed") setScorecardPhase("failed");
    }, { refresh: fresh || undefined });
    return close;
  }, [apiBase, reloadKey]);

  return (
    <div className="obs">
      <div className="obs-masthead-scoreboard">
        {scorecardPhase === "done" && scorecard
          ? <ScorecardHero data={scorecard} apiBase={apiBase} updatedAt={scorecardUpdatedAt} onRescan={() => { freshRef.current = true; setReloadKey((k) => k + 1); }} />
          : scorecardPhase === "failed"
            ? <p className="obs-empty">Couldn&rsquo;t compute your goldmine right now &mdash; try again shortly.</p>
            : scorecardPhase === "scanning"
              ? <ScorecardScanning progress={progress} />
              : <ScorecardHeroSkeleton />}
      </div>
      <OverviewDashboard apiBase={apiBase} />
    </div>
  );
}

// The pre-existing Overview content, unchanged: usage pulse + charts + heatmap +
// filters, driven by the shared session-stats fetch.
function OverviewDashboard({ apiBase }: { apiBase: string }) {
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
  // the user acts — Overview doesn't otherwise scan it, so opening Overview stays cheap.
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
  if (error) return <p className="obs-error">Couldn't load Overview: {error}</p>;
  if (!data) return <Loading />;
  // Local session log is empty. Orient a brand-new user instead of a hollow zeroed
  // dashboard (rare once the reveal ceremony has run, but the local log can still be
  // empty for an existing account restored on a new machine).
  if (stats && stats.length === 0) return (
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
