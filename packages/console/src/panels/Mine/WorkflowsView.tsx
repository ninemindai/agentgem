import { useEffect, useRef, useState } from "react";
import type { Scorecard } from "../../api/routes.js";
import { scorecardBuildRoute, makeClient } from "../../api/routes.js";
import { ScorecardHero, ScorecardHeroSkeleton, ScorecardScanning } from "./Scorecard.js";
import { openScorecardStream, type ScorecardStreamEvent } from "./scorecardStream.js";
import { MineWorkflows } from "./Workflows.js";
import { GemCardSkeleton } from "./GemCardSkeleton.js";
import { PROJECT_HYGIENE_SHORTCUT, launchRubricRun } from "../../rubricShortcuts.js";

type Progress = { done: number; total: number; label: string; partial: { breadth: number; battleTested: number; portable: number } };

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
