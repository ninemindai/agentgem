// packages/console/src/panels/Observe/StructureView.tsx
//
// Map <-> Transcript toggle for the session drill-down (Task 7). Map renders a
// phase-by-phase flamestrip of tool/skill calls (phases.js); Transcript is the
// existing verbatim turn tree, now sourced from turnTree.js to avoid the import
// cycle (StructureView needs Turn; TranscriptViewer needs StructureView).
import { useState } from "react";
import type { TranscriptView } from "../../api/routes.js";
import { phasesOf } from "./phases.js";
import { PhaseFlamestrip } from "./PhaseFlamestrip.js";
import { Turn } from "./turnTree.js";

export function StructureView({ view, collapsed, onToggle }: {
  view: TranscriptView; collapsed: Set<string>; onToggle: (id: string) => void;
}) {
  const [mode, setMode] = useState<"map" | "tx">("map");
  const phases = mode === "map" ? phasesOf(view) : [];
  return (
    <div className="obs sv">
      <div className="sv-head">
        <span className="t">What happened, in order</span>
        <div className="seg">
          <button type="button" className={mode === "map" ? "on" : ""} onClick={() => setMode("map")}>◆ Map</button>
          <button type="button" className={mode === "tx" ? "on" : ""} onClick={() => setMode("tx")}>≣ Transcript</button>
        </div>
      </div>
      <div className="sv-body">
        {mode === "map"
          ? phases.map((p, i) => <PhaseFlamestrip key={i} phase={p} index={i} />)
          : <ol className="tv-turns">{view.turns.map((turn) => (
              <Turn key={turn.id} turn={turn} startMs={view.meta.startMs} open={!collapsed.has(turn.id)} onToggle={() => onToggle(turn.id)} />
            ))}</ol>}
      </div>
    </div>
  );
}
