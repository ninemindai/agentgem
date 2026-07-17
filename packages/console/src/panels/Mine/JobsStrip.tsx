import type { ReactElement } from "react";
import type { MineRubricRun } from "./mineJobs.js";

/** Mine-local jobs strip: surfaces rubric runs in flight, right where they'll land
 *  (per-card hygiene scores, a later task). Collapses to nothing while idle — no
 *  running rubric runs means no strip and no reserved vertical space. */
export function JobsStrip({ runs }: { runs: MineRubricRun[] }): ReactElement | null {
  const running = runs.filter((r) => r.status === "running");
  if (running.length === 0) return null;

  const text = running.length === 1
    ? `Re-scoring — ${running[0].rubric} (${running[0].phase})`
    : `${running.length} rubric runs in progress`;

  return (
    <div className="mine-jobs" role="status" aria-live="polite">
      <span className="warming-pill__spark" aria-hidden="true">✦</span>
      <span className="mine-jobs-text">{text}</span>
      <span className="mine-jobs-dots" aria-hidden="true">
        {running.map((r) => <span key={r.id} className="activity-dot activity-dot-running" />)}
      </span>
      <a className="mine-jobs-link" href="#/rubrics">view queue ↗</a>
    </div>
  );
}
