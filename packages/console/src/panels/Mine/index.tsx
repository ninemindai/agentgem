import { useEffect, useState } from "react";
import { defineConsolePage } from "../../registry.js";
import type { Scorecard } from "../../api/routes.js";
import { ScorecardHero, ScorecardHeroSkeleton, ScorecardScanning } from "./Scorecard.js";
import { openScorecardStream, type ScorecardStreamEvent } from "./scorecardStream.js";

type Progress = { done: number; total: number; label: string; partial: { breadth: number; battleTested: number; portable: number } };

export function Mine({ apiBase, openStream = openScorecardStream }: { apiBase: string; openStream?: typeof openScorecardStream }) {
  const [scorecard, setScorecard] = useState<Scorecard | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [phase, setPhase] = useState<"loading" | "scanning" | "done" | "failed">("loading");

  useEffect(() => {
    setScorecard(null); setProgress(null); setPhase("loading");
    const close = openStream(apiBase, (e: ScorecardStreamEvent) => {
      if (e.type === "start") setPhase("scanning");
      else if (e.type === "progress") { setPhase("scanning"); setProgress({ done: e.done, total: e.total, label: e.label, partial: e.partial }); }
      else if (e.type === "done") { setScorecard(e.scorecard); setPhase("done"); }
      else if (e.type === "failed") setPhase("failed");
    });
    return close;
  }, [apiBase, openStream]);

  const onDistill = (_root: string) => { window.location.hash = "#/curate"; };

  return (
    <div className="obs mine">
      {phase === "done" && scorecard
        ? <ScorecardHero data={scorecard} onDistill={onDistill} />
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
