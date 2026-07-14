// Hardcoded rubric shortcuts: one-click "run this predefined rubric here" buttons
// on the surfaces where the target entity already is (a session row, the Mine
// project scope). Deliberately a static list, not a config system — each entry
// names a BUILT-IN rubric id (packages/insight rubrics.ts builtinRubrics), which
// is guaranteed resolvable, so a button can never point at an uninstalled rubric.
//
// Launching sets the one-shot PendingRubricRun slot and navigates to #/rubrics;
// the Rubrics panel consumes it, selects the rubric, and auto-runs. Results render
// in the one place reports already live (shared cache/stream/report UI) instead of
// each surface embedding its own runner.
import { setPendingRubricRun, type PendingRubricRun } from "./pendingAnalyze.js";

export interface RubricShortcut {
  id: string;
  /** Button label on the host surface. */
  label: string;
  /** Built-in rubric id this shortcut runs. */
  rubric: string;
  /** Tooltip explaining what the click does. */
  title: string;
}

/** Session-row shortcut: context hygiene for one session (claude sessions only —
 *  the rubric engine reads claude transcripts). */
export const SESSION_HYGIENE_SHORTCUT: RubricShortcut = {
  id: "session-context-hygiene",
  label: "hygiene ▶",
  rubric: "context-hygiene",
  title: "Run the context-hygiene rubric on this session",
};

/** Mine-scope shortcut: context hygiene for the selected project (or all). */
export const PROJECT_HYGIENE_SHORTCUT: RubricShortcut = {
  id: "project-context-hygiene",
  label: "Hygiene rubric →",
  rubric: "context-hygiene",
  title: "Run the context-hygiene rubric over this scope",
};

/** Set the pending run and jump to the Rubrics panel (which consumes + auto-runs). */
export function launchRubricRun(run: PendingRubricRun): void {
  setPendingRubricRun({ ...run, autorun: true });
  window.location.hash = "#/rubrics";
}
