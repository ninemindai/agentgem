import { useRef } from "react";
import type { Scorecard, ProjectGoldmine } from "../../api/routes.js";
import { drawTrophy, shareTrophy } from "./trophy.js";

// Asset-framed hero. Counts link into the existing Curate>Analyze distill flow
// via onDistill(root); the share button exports the aggregate-only trophy.
export function ScorecardHero({ data, onDistill }: { data: Scorecard; onDistill: (root: string) => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const top: ProjectGoldmine | undefined = data.projects[0];
  const onShare = () => { const c = canvasRef.current; if (!c) return; drawTrophy(c, data); void shareTrophy(c); };
  return (
    <section className="scorecard-hero" aria-label="Goldmine scorecard">
      <h2>Your log holds <strong>{data.breadth} reusable workflows</strong></h2>
      <ul className="scorecard-counts">
        <li><button onClick={() => top && onDistill(top.root)}>{data.battleTested} battle-tested</button></li>
        <li><button onClick={() => top && onDistill(top.root)}>{data.portable} worth sharing</button></li>
      </ul>
      {data.gaps.length > 0 && <p className="scorecard-gaps">Next: {data.gaps.join(" · ")}</p>}
      <button className="scorecard-share" onClick={onShare}>Share your goldmine</button>
      <canvas ref={canvasRef} style={{ display: "none" }} />
      {data.degraded && <span className="scorecard-degraded" title="Some projects could not be fully scanned">partial</span>}
    </section>
  );
}

// Live scanning progress shown between the initial skeleton and the finished hero.
export function ScorecardScanning({ progress }: { progress: { done: number; total: number; label: string; partial: { breadth: number; battleTested: number; portable: number } } | null }) {
  const pct = progress && progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;
  return (
    <section className="scorecard-hero scorecard-scanning" aria-busy="true" aria-label="Scoring your goldmine">
      <h2>Scoring your goldmine…{progress ? ` ${progress.done}/${progress.total}` : ""}{progress?.label ? ` · ${progress.label}` : ""}</h2>
      <div className="scorecard-bar"><div className="scorecard-bar-fill" style={{ width: `${pct}%` }} /></div>
      <ul className="scorecard-counts scorecard-counts-live">
        <li>{progress?.partial.breadth ?? 0} reusable workflows</li>
        <li>{progress?.partial.battleTested ?? 0} battle-tested</li>
        <li>{progress?.partial.portable ?? 0} worth sharing</li>
      </ul>
    </section>
  );
}

// Shimmer placeholder shown while the scorecard is computed (the scan over recent
// projects takes a while). Mirrors the hero's shape so the swap-in is calm.
export function ScorecardHeroSkeleton() {
  return (
    <section className="scorecard-hero scorecard-skel" aria-label="Scoring your goldmine" aria-busy="true">
      <div className="scorecard-skel-line scorecard-skel-title" />
      <div className="scorecard-skel-row">
        <div className="scorecard-skel-pill" />
        <div className="scorecard-skel-pill" />
      </div>
      <p className="scorecard-skel-note">Scoring your goldmine…</p>
    </section>
  );
}
