// packages/console/src/panels/Observe/PhaseFlamestrip.tsx
//
// One phase row of the Map view: a header (index, label, turn/token/skill/agent
// counts) plus a run-length-collapsed strip of tool-call cells colored by
// category (Task 3's catOf/CATEGORY_COLOR).
import { catOf, CATEGORY_COLOR } from "./toolCategory.js";
import type { Phase } from "./phases.js";
import { fmtTokens } from "./data.js";

export function PhaseFlamestrip({ phase, index }: { phase: Phase; index: number }) {
  const cells: { t: string; n: number }[] = [];
  for (const t of phase.tools) { const last = cells[cells.length - 1]; if (last && last.t === t) last.n++; else cells.push({ t, n: 1 }); }
  return (
    <div className="phase">
      <div className="ph">
        <div className="idx">{index + 1}</div>
        <div className="lbl" title={phase.label}>{phase.label}</div>
        <div className="st">{phase.turns}t · {fmtTokens(phase.out)} out{phase.skills ? ` · ◆${phase.skills}` : ""}{phase.agents ? ` · ▲${phase.agents}` : ""}</div>
      </div>
      {cells.length > 0 && (
        <div className="strip">
          {cells.map((c, i) => (
            <span key={i} className="cell" style={{ background: CATEGORY_COLOR[catOf(c.t)] }} title={`${c.t} ×${c.n}`}>{c.t}{c.n > 1 ? ` ·${c.n}` : ""}</span>
          ))}
        </div>
      )}
    </div>
  );
}
