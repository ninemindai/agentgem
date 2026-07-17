import { useEffect, useRef, useState } from "react";
import type { Scorecard } from "../../api/routes.js";
import { scorecardBuildRoute, makeClient } from "../../api/routes.js";
import { ScorecardHero, ScorecardHeroSkeleton, ScorecardScanning } from "./Scorecard.js";
import { openScorecardStream, type ScorecardStreamEvent } from "./scorecardStream.js";
import { MineWorkflows } from "./Workflows.js";
import { GemCardSkeleton } from "./GemCardSkeleton.js";
import { PROJECT_HYGIENE_SHORTCUT, launchRubricRun } from "../../rubricShortcuts.js";

type Progress = { done: number; total: number; label: string; partial: { breadth: number; battleTested: number; portable: number } };

// PR-1 of the "Group by" switcher: only "value" exists (Type/Maturity land later).
// Kept as a union rather than a bare string so a later PR's added values are a
// type-checked, additive change here.
type Group = "value";

// Mirrors Setup/index.tsx's `parseQuery`: the hash query string, not localStorage,
// is the source of truth for the current grouping. PR-1 has exactly one valid
// value, so an absent or unrecognized `group` param both normalize to "value";
// PR-2 widens this to actually branch on the parsed param.
function parseGroup(): Group {
  return "value";
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

/** True once the scorecard has actually surfaced anything worth showing. Checks
 *  `breadth` first (the authoritative count); only falls back to inspecting each
 *  project's workflows when there ARE projects — an empty `projects` array must
 *  not be read as "empty" on its own, since a nonzero `breadth` can still be true
 *  before the per-project detail has synced. */
function isEmptyScorecard(data: Scorecard): boolean {
  if (data.breadth === 0) return true;
  return data.projects.length > 0 && data.projects.every((p) => p.workflows.length === 0);
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

// "Group by" perspective switcher: PR-1 renders a single active "Value" segment
// (the only grouping MineWorkflows supports today) so the #/mine?group= hash
// contract is live before PR-2 lifts real grouping state into MineWorkflows and
// adds the Type/Maturity segments alongside it.
function GroupBySwitcher({ group, onChange }: { group: Group; onChange: (g: Group) => void }) {
  return (
    <div className="mine-groupby">
      <span className="mine-groupby-label">Group by</span>
      <span className="play-seg">
        <button type="button" aria-pressed={group === "value"} onClick={() => onChange("value")}>Value</button>
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
  const [buildResult, setBuildResult] = useState<{ name: string; skills: string[] } | null>(null);
  const [buildError, setBuildError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  // A manual re-scan opens the stream with ?refresh=true to bypass the cached
  // scorecard; the ref keeps it out of the dep array so it's a one-shot.
  const freshRef = useRef(false);
  // #/mine?group= sub-state — PR-1 seam only, not yet threaded into MineWorkflows.
  const [group, setGroup] = useState<Group>(() => parseGroup());
  useEffect(() => {
    const onHash = () => setGroup(parseGroup());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  const onGroupChange = (g: Group) => { setGroupParam(g); setGroup(g); };

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
      const skills = gem.artifacts.filter((a) => a.type === "skill").map((a) => a.name);
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
        ? isEmptyScorecard(scorecard)
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
              <MineWorkflows data={scorecard} onBuild={onBuild} building={building} result={buildResult} error={buildError} apiBase={apiBase} />
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
