import { useEffect, useRef, useState } from "react";
import { defineConsolePage } from "../../registry.js";
import type { Scorecard } from "../../api/routes.js";
import { scorecardBuildRoute, makeClient } from "../../api/routes.js";
import { ScorecardHero, ScorecardHeroSkeleton, ScorecardScanning } from "./Scorecard.js";
import type { WorkflowFilter } from "./Scorecard.js";
import { openScorecardStream, type ScorecardStreamEvent } from "./scorecardStream.js";
import { MineWorkflows } from "./Workflows.js";

type Progress = { done: number; total: number; label: string; partial: { breadth: number; battleTested: number; portable: number } };

export function Mine({ apiBase, openStream = openScorecardStream }: { apiBase: string; openStream?: typeof openScorecardStream }) {
  const [scorecard, setScorecard] = useState<Scorecard | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [phase, setPhase] = useState<"loading" | "scanning" | "done" | "failed">("loading");
  const [filter, setFilter] = useState<WorkflowFilter>("all");
  const [building, setBuilding] = useState(false);
  const [buildResult, setBuildResult] = useState<{ name: string; skills: string[] } | null>(null);
  const [buildError, setBuildError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  // A manual re-scan opens the stream with ?refresh=true to bypass the cached
  // scorecard; the ref keeps it out of the dep array so it's a one-shot.
  const freshRef = useRef(false);

  useEffect(() => {
    setScorecard(null); setProgress(null); setPhase("loading"); setFilter("all");
    const fresh = freshRef.current; freshRef.current = false;
    const close = openStream(apiBase, (e: ScorecardStreamEvent) => {
      if (e.type === "start") setPhase("scanning");
      else if (e.type === "progress") { setPhase("scanning"); setProgress({ done: e.done, total: e.total, label: e.label, partial: e.partial }); }
      else if (e.type === "done") { setScorecard(e.scorecard); setPhase("done"); }
      else if (e.type === "failed") setPhase("failed");
    }, fresh ? { refresh: true } : undefined);
    return close;
  }, [apiBase, openStream, reloadKey]);

  const onRescan = () => { freshRef.current = true; setReloadKey((k) => k + 1); };

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
        ? <>
            <ScorecardHero data={scorecard} onRescan={onRescan} />
            <MineWorkflows data={scorecard} filter={filter} onFilter={setFilter} onBuild={onBuild} building={building} result={buildResult} error={buildError} apiBase={apiBase} />
          </>
        : phase === "failed"
          ? <p className="obs-empty">Couldn't compute your goldmine right now — try again shortly.</p>
          : phase === "scanning"
            ? <ScorecardScanning progress={progress} />
            : <ScorecardHeroSkeleton />}
    </div>
  );
}

export const minePage = defineConsolePage({
  id: "mine", title: "Mine", icon: "💎", order: 6, group: "observe",
  route: "#/mine", component: Mine,
});
