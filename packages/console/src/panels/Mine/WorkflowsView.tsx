import { useEffect, useRef, useState } from "react";
import type { Scorecard, Usage } from "../../api/routes.js";
import { scorecardBuildRoute, inventoryRoute, usageRoute, playMiniappsRoute, makeClient } from "../../api/routes.js";
import { groupInventory, mergeUsage, type LedgerGroup } from "../shared/ledgerModel.js";
import { ScorecardHero, ScorecardHeroSkeleton, ScorecardScanning } from "./Scorecard.js";
import { openScorecardStream, type ScorecardStreamEvent } from "./scorecardStream.js";
import { MineWorkflows } from "./Workflows.js";
import type { DistilledSkillView } from "./BuildResult.js";
import { GemCardSkeleton } from "./GemCardSkeleton.js";
import { PROJECT_HYGIENE_SHORTCUT, launchRubricRun } from "../../rubricShortcuts.js";
import type { Miniapp } from "./unifiedGems.js";
import { useMineRubricRuns } from "./mineJobs.js";
import { useHygieneScores } from "./useHygieneScores.js";
import { JobsStrip } from "./JobsStrip.js";

type Progress = { done: number; total: number; label: string; partial: { breadth: number; battleTested: number; portable: number } };

// The "Group by" perspective switcher's three axes. Kept as a union rather than a
// bare string so an unrecognized/legacy `?group=` value is a type-checked fallback.
type Group = "value" | "type" | "maturity";

// Mirrors Setup/index.tsx's `parseQuery`: the hash query string, not localStorage,
// is the source of truth for the current grouping. An absent or unrecognized
// `group` param normalizes to "value".
function parseGroup(): Group {
  const hash = window.location.hash || "";
  const query = hash.split("?")[1] ?? "";
  const g = new URLSearchParams(query).get("group");
  return g === "type" || g === "maturity" ? g : "value";
}

// Writes `?group=<g>` onto the current `#/mine...` hash, preserving the path and
// any other query params. Generic on purpose so PR-2's Type/Maturity segments can
// call it unchanged.
function setGroupParam(g: Group) {
  const hash = window.location.hash || "#/mine";
  const [path, query] = hash.split("?");
  const params = new URLSearchParams(query ?? "");
  params.set("group", g);
  window.location.hash = `${path}?${params.toString()}`;
}

/** True once nothing has been mined from ANY source yet: no workflows, no inventory
 *  gems (skills/subagents/lessons/rubrics), no miniapps. The workflow half checks
 *  `breadth` first (the authoritative count); only falls back to inspecting each
 *  project's workflows when there ARE projects — an empty `projects` array must
 *  not be read as "empty" on its own, since a nonzero `breadth` can still be true
 *  before the per-project detail has synced. Inventory/miniapps default to `[]`
 *  while their fetch is in flight, so this correctly reads "empty" until they land. */
function isEmptyMine(data: Scorecard, inventory: LedgerGroup[], miniapps: Miniapp[]): boolean {
  const workflowsEmpty = data.breadth === 0 || (data.projects.length > 0 && data.projects.every((p) => p.workflows.length === 0));
  const inventoryEmpty = inventory.every((g) => g.items.length === 0);
  return workflowsEmpty && inventoryEmpty && miniapps.length === 0;
}

// A handful of placeholder cards shown under the scanning header while the scan
// runs — echoes the eventual grouped grid instead of leaving a blank gap below
// the progress bar.
function LoadingGrid() {
  return (
    <ul className="play-grid mine-loading-grid" aria-hidden="true">
      {Array.from({ length: 6 }, (_, i) => <GemCardSkeleton key={i} />)}
    </ul>
  );
}

// "Group by" perspective switcher: three axes over the unified gem set, each
// writing `?group=<axis>` onto the `#/mine` hash (the source of truth, restored
// via parseGroup on mount and on hashchange).
function GroupBySwitcher({ group, onChange }: { group: Group; onChange: (g: Group) => void }) {
  return (
    <div className="mine-groupby">
      <span className="mine-groupby-label">Group by</span>
      <span className="play-seg">
        <button type="button" aria-pressed={group === "value"} onClick={() => onChange("value")}>Value</button>
        <button type="button" aria-pressed={group === "type"} onClick={() => onChange("type")}>Type</button>
        <button type="button" aria-pressed={group === "maturity"} onClick={() => onChange("maturity")}>Maturity</button>
      </span>
    </div>
  );
}

/** The Workflows view of the Mine tab: the deterministic scorecard scan, scoped to
 *  the shared project selection. Moved verbatim from the pre-shell Mine panel. */
export function WorkflowsView({ apiBase, scope, openStream = openScorecardStream }: { apiBase: string; scope: string; openStream?: typeof openScorecardStream }) {
  const [scorecard, setScorecard] = useState<Scorecard | null>(null);
  const [scorecardUpdatedAt, setScorecardUpdatedAt] = useState<number | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [phase, setPhase] = useState<"loading" | "scanning" | "done" | "failed">("loading");
  // SWR: true while the last-good scorecard is shown but a background rescan is still running.
  const [revalidating, setRevalidating] = useState(false);
  const [failMessage, setFailMessage] = useState<string | null>(null);
  const [building, setBuilding] = useState(false);
  const [buildResult, setBuildResult] = useState<{ name: string; skills: DistilledSkillView[] } | null>(null);
  const [buildError, setBuildError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  // A manual re-scan opens the stream with ?refresh=true to bypass the cached
  // scorecard; the ref keeps it out of the dep array so it's a one-shot.
  const freshRef = useRef(false);
  // #/mine?group= sub-state, threaded into MineWorkflows.
  const [group, setGroup] = useState<Group>(() => parseGroup());
  useEffect(() => {
    const onHash = () => setGroup(parseGroup());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  const onGroupChange = (g: Group) => { setGroupParam(g); setGroup(g); };

  // Inventory (skills/subagents/lessons/rubrics) and miniapps, composed client-side
  // alongside the scorecard's workflows into the unified gem set. Global, not scoped
  // to the project selection — re-fetched only when apiBase changes. Each source
  // degrades independently (starts as `[]`) so a slow/failed fetch never blocks the
  // workflow render; the extra gems just fold in whenever they land.
  const [inventory, setInventory] = useState<LedgerGroup[]>([]);
  const [miniapps, setMiniapps] = useState<Miniapp[]>([]);
  useEffect(() => {
    let alive = true;
    const client = makeClient(apiBase);
    (async () => {
      const [inv, usage, miniappsRes] = await Promise.all([
        inventoryRoute.call(client, { query: { body: "defer" } }).catch(() => null),
        usageRoute.call(client, { query: { scope: "global" } }).catch(() => ({ artifacts: [] }) as Usage),
        playMiniappsRoute.call(client, {}).catch(() => ({ miniapps: [] })),
      ]);
      if (!alive) return;
      if (inv) setInventory(mergeUsage(groupInventory(inv), usage));
      setMiniapps(miniappsRes.miniapps.map((m) => ({ name: m.name, title: m.title, genre: m.genre })));
    })();
    return () => { alive = false; };
  }, [apiBase]);

  useEffect(() => {
    setScorecard(null); setScorecardUpdatedAt(null); setProgress(null); setPhase("loading"); setRevalidating(false); setFailMessage(null);
    const fresh = freshRef.current; freshRef.current = false;
    const projects = scope === "*" ? undefined : [scope];
    const close = openStream(makeClient(apiBase), (e: ScorecardStreamEvent) => {
      // Once a scorecard is shown (via `stale`), keep showing it: don't let `start`/`progress`
      // drop back to the scanning takeover — the "updating…" pill signals the background rescan.
      if (e.type === "start") setPhase((p) => (p === "done" ? p : "scanning"));
      else if (e.type === "stale") { setScorecard(e.scorecard); setScorecardUpdatedAt(e.updatedAt); setPhase("done"); setRevalidating(true); }
      else if (e.type === "progress") { setProgress({ done: e.done, total: e.total, label: e.label, partial: e.partial }); setPhase((p) => (p === "done" ? p : "scanning")); }
      else if (e.type === "done") { setScorecard(e.scorecard); setScorecardUpdatedAt(e.updatedAt); setPhase("done"); setRevalidating(false); }
      else if (e.type === "failed") { setFailMessage(e.message); setPhase("failed"); }
    }, { refresh: fresh || undefined, projects });
    return close;
  }, [apiBase, openStream, reloadKey, scope]);

  const onRescan = () => { freshRef.current = true; setReloadKey((k) => k + 1); };

  // Mine-local jobs strip + per-card hygiene back-fill. Called unconditionally (Rules
  // of Hooks) even while loading/empty/failed — roots is [] until a scorecard lands,
  // which useHygieneScores already treats as "nothing to fetch".
  const runs = useMineRubricRuns();
  const roots = [...new Set((scorecard?.projects ?? []).map((p) => p.root))];
  const hygiene = useHygieneScores(roots, runs, apiBase);

  const onRunHygiene = () => launchRubricRun({
    rubric: PROJECT_HYGIENE_SHORTCUT.rubric,
    scope: scope === "*" ? "all" : "project",
    root: scope === "*" ? undefined : scope,
  });

  const onBuild = async (selections: { root: string; keys: string[] }[], name: string) => {
    setBuilding(true);
    setBuildResult(null);
    setBuildError(null);
    try {
      const gem = await scorecardBuildRoute.call(makeClient(apiBase), { body: { selections, name } });
      // Keep description + content: the gem is never persisted, so the result banner's
      // inline SKILL.md viewer is the only place the distilled draft can be seen.
      const skills = gem.artifacts
        .filter((a) => a.type === "skill")
        .map((a) => ({ name: a.name, description: a.description, content: a.content }));
      setBuildResult({ name: gem.name, skills });
    } catch (err) {
      setBuildError(err instanceof Error ? err.message : "Build failed");
    } finally {
      setBuilding(false);
    }
  };

  return (
    <div className="obs mine">
      {phase === "done" && scorecard
        ? isEmptyMine(scorecard, inventory, miniapps)
          ? (
            <div className="ledger-empty-state">
              <h3 className="ledger-empty-title">No gems mined here yet</h3>
              <p className="ledger-empty-text">
                AgentGem mines reusable workflows from your sessions as you work — run a few sessions, or score
                what you have.
              </p>
              <div className="ledger-empty-cta">
                <button type="button" className="ledger-build" onClick={onRunHygiene}>Run a hygiene rubric</button>
              </div>
            </div>
          )
          : <>
              {revalidating && (
                <span className="warming-pill" title="Rescanning your projects in the background — the scorecard refreshes automatically.">
                  <span className="warming-pill__spark" aria-hidden="true">✦</span>
                  updating…
                </span>
              )}
              <ScorecardHero data={scorecard} updatedAt={scorecardUpdatedAt} onRescan={onRescan} />
              <GroupBySwitcher group={group} onChange={onGroupChange} />
              <JobsStrip runs={runs} />
              <MineWorkflows
                data={scorecard}
                onBuild={onBuild}
                building={building}
                result={buildResult}
                error={buildError}
                apiBase={apiBase}
                group={group}
                inventory={inventory}
                miniapps={miniapps}
                hygiene={hygiene}
              />
            </>
        : phase === "failed"
          ? (
            <div className="mine-retry-state">
              <p className="scorecard-error">Couldn't compute your goldmine right now — {failMessage ?? "try again shortly"}.</p>
              <button type="button" className="ledger-build mine-retry" onClick={onRescan}>Retry</button>
            </div>
          )
          : phase === "scanning"
            ? <><ScorecardScanning progress={progress} /><LoadingGrid /></>
            : <><ScorecardHeroSkeleton /><LoadingGrid /></>}
    </div>
  );
}
