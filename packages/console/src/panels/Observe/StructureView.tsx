// packages/console/src/panels/Observe/StructureView.tsx
//
// Map <-> Blast <-> Transcript toggle for the session drill-down. Map renders a
// phase-by-phase flamestrip of tool/skill calls (phases.js); Blast is the
// replayable blast-radius touch map (Claude-only — the tab hides for codex, and
// its fetch only fires when the tab is opened); Transcript is the existing
// verbatim turn tree, sourced from turnTree.js to avoid the import cycle
// (StructureView needs Turn; TranscriptViewer needs StructureView).
import { useEffect, useState } from "react";
import type { TranscriptView } from "../../api/routes.js";
import { phasesOf } from "./phases.js";
import { PhaseFlamestrip } from "./PhaseFlamestrip.js";
import { Turn } from "./turnTree.js";
import { BlastRadius } from "./BlastRadius.js";

export function StructureView({ view, collapsed, onToggle, forceTx, apiBase, agent }: {
  view: TranscriptView; collapsed: Set<string>; onToggle: (id: string) => void; forceTx?: boolean;
  apiBase: string; agent: "claude" | "codex";
}) {
  const [mode, setMode] = useState<"map" | "blast" | "tx">(forceTx ? "tx" : "map");
  const [full, setFull] = useState(false);

  // Full-screen is a CSS overlay (position: fixed), not the native Fullscreen
  // API — predictable in the Electron shell and testable. Escape exits; the
  // page behind stops scrolling while expanded. It wraps the whole panel, so
  // every lens (Map, Blast, Transcript) gets it from the one control.
  useEffect(() => {
    if (!full) return;
    const onEsc = (e: KeyboardEvent) => { if (e.key === "Escape") setFull(false); };
    window.addEventListener("keydown", onEsc);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { window.removeEventListener("keydown", onEsc); document.body.style.overflow = prev; };
  }, [full]);

  const phases = mode === "map" ? phasesOf(view) : [];
  return (
    <div className={"obs sv" + (full ? " is-full" : "")}>
      <div className="sv-head">
        <span className="t">What happened, in order</span>
        <div className="sv-controls">
          <div className="seg">
            <button type="button" className={mode === "map" ? "on" : ""} onClick={() => setMode("map")}>◆ Map</button>
            {agent === "claude" && (
              <button type="button" className={mode === "blast" ? "on" : ""} onClick={() => setMode("blast")}>◎ Blast</button>
            )}
            <button type="button" className={mode === "tx" ? "on" : ""} onClick={() => setMode("tx")}>≣ Transcript</button>
          </div>
          <button
            type="button"
            className="sv-full-btn"
            onClick={() => setFull((f) => !f)}
            aria-label={full ? "exit full screen" : "full screen"}
            title={full ? "Exit full screen (Esc)" : "Full screen"}
          >
            {full ? "🗕" : "⛶"}
          </button>
        </div>
      </div>
      <div className="sv-body">
        {mode === "map"
          ? phases.map((p, i) => <PhaseFlamestrip key={i} phase={p} index={i} />)
          : mode === "blast"
          ? <BlastRadius apiBase={apiBase} agent={agent} sessionId={view.sessionId} />
          : <ol className="tv-turns">{view.turns.map((turn) => (
              <Turn key={turn.id} turn={turn} startMs={view.meta.startMs} open={!collapsed.has(turn.id)} onToggle={() => onToggle(turn.id)} />
            ))}</ol>}
      </div>
    </div>
  );
}
