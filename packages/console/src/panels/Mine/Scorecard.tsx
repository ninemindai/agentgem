import { useRef } from "react";
import type { Scorecard } from "../../api/routes.js";
import { drawTrophy, shareTrophy } from "./trophy.js";

// Asset-framed hero. Count chips are filter toggles — clicking one narrows the
// workflow list below; clicking the active chip resets it to "all".
// The share button exports the aggregate-only trophy (unchanged).
export type WorkflowFilter = "all" | "battleTested" | "portable";

export function ScorecardHero({ data, filter, onFilter }: { data: Scorecard; filter: WorkflowFilter; onFilter: (f: WorkflowFilter) => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const onShare = () => { const c = canvasRef.current; if (!c) return; drawTrophy(c, data); void shareTrophy(c); };
  const toggle = (f: WorkflowFilter) => onFilter(filter === f ? "all" : f);
  return (
    <section className="scorecard-hero" aria-label="Goldmine scorecard">
      <h2>Your log holds <strong>{data.breadth} reusable workflows</strong></h2>
      <ul className="scorecard-counts">
        <li><button className={filter === "battleTested" ? "is-active" : ""} aria-pressed={filter === "battleTested"} onClick={() => toggle("battleTested")}>{data.battleTested} battle-tested</button></li>
        <li><button className={filter === "portable" ? "is-active" : ""} aria-pressed={filter === "portable"} onClick={() => toggle("portable")}>{data.portable} worth sharing</button></li>
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
