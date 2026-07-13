// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import type { ReactElement } from "react";
import type { DreamProgressData } from "./api.js";

const PHASES = ["LIGHT", "DEEP", "REM"] as const;

/** Live step tracker for a running warm pass: the three sleep phases
 *  (done / running / pending) plus the current project. Renders nothing when
 *  idle. Phases may not flip strictly top-to-bottom (the registry runs REM
 *  before DEEP); the "now" line is the source of truth for what's executing. */
export function DreamProgress({ progress }: { progress: DreamProgressData | null }): ReactElement | null {
  if (!progress) return null;
  const stateOf = (p: (typeof PHASES)[number]): "running" | "done" | "pending" =>
    progress.phase === p ? "running" : progress.phasesLit.includes(p) ? "done" : "pending";
  return (
    <div className="dream-progress" role="status" aria-live="polite">
      <ul className="dream-progress-phases">
        {PHASES.map((p) => (
          <li key={p} className="dream-progress-phase" data-state={stateOf(p)}>
            <span className="dream-progress-dot" aria-hidden="true" />
            {p}
          </li>
        ))}
      </ul>
      {progress.currentRoot && (
        <p className="dream-progress-now">
          now: <strong>{progress.currentRoot}</strong>
          {progress.rootCount > 1 && progress.rootIndex > 0 ? ` (${progress.rootIndex} of ${progress.rootCount})` : ""}
        </p>
      )}
    </div>
  );
}
