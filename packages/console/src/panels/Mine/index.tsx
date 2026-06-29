import { useEffect, useState } from "react";
import { defineConsolePage } from "../../registry.js";
import { scorecardRoute, makeClient, type Scorecard } from "../../api/routes.js";
import { ScorecardHero, ScorecardHeroSkeleton } from "./Scorecard.js";

export function Mine({ apiBase }: { apiBase: string }) {
  const [scorecard, setScorecard] = useState<Scorecard | null>(null);
  const [scoring, setScoring] = useState(true);

  useEffect(() => {
    let alive = true;
    setScoring(true);
    scorecardRoute.call(makeClient(apiBase), { query: {} })
      .then((sc) => { if (alive) setScorecard(sc); })
      .catch(() => { /* leave scorecard null; show the empty state below */ })
      .finally(() => { if (alive) setScoring(false); });
    return () => { alive = false; };
  }, [apiBase]);

  const onDistill = (_root: string) => { window.location.hash = "#/curate"; };

  return (
    <div className="obs mine">
      {scorecard
        ? <ScorecardHero data={scorecard} onDistill={onDistill} />
        : scoring
          ? <ScorecardHeroSkeleton />
          : <p className="obs-empty">Couldn't compute your goldmine right now — try again shortly.</p>}
    </div>
  );
}

export const minePage = defineConsolePage({
  id: "mine", title: "Mine", icon: "💎", order: 6, group: "observe",
  route: "#/mine", component: Mine,
});
