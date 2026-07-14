// One-shot hand-off of a project root from the Insights panel to Curate's
// "Suggest from a project" tab. Insights knows a succeeded session's project but
// not its artifact selection; Curate's Analyze turns a project into one. A
// module-level slot, consumed (read-and-cleared) once so a later navigation to
// Curate doesn't re-trigger the analysis.
let target: string | null = null;

export function setPendingAnalyze(root: string): void { target = root; }

/** Read the pending project root and clear it (consume-once). */
export function consumePendingAnalyze(): string | null {
  const t = target;
  target = null;
  return t;
}

// One-shot hand-off of a playbook from the Insights panel to Curate. Consumed
// (read-and-cleared) once so a later navigation to Curate doesn't re-trigger.
// `skills`/`lessons` are OPTIONAL: the "Publish" button hands off just the
// `root` and navigates instantly, letting Curate run the (slow) distill itself
// with visible progress. When they ARE present, Curate uses them directly.
export interface PendingPlaybook { root: string; skills?: string[]; lessons?: string[] }
let pendingPlaybook: PendingPlaybook | null = null;
export function setPendingPlaybook(d: PendingPlaybook): void { pendingPlaybook = d; }
export function consumePendingPlaybook(): PendingPlaybook | null { const d = pendingPlaybook; pendingPlaybook = null; return d; }

// One-shot hand-off of a ready-made selection into Curate's Publish flow, for
// on-ramps that already know their exact selection keys: "Share my setup"
// (whole inventory) and a single distilled lesson's "Share". Consumed once. The
// counts feed PublishToExplore's provenance line.
export interface PendingContribution { keys: string[]; skillCount: number; lessonCount: number; name?: string }
let pendingContribution: PendingContribution | null = null;
export function setPendingContribution(d: PendingContribution): void { pendingContribution = d; }
export function consumePendingContribution(): PendingContribution | null { const d = pendingContribution; pendingContribution = null; return d; }

// One-shot hand-off of a rubric run into the Rubrics report panel. Two callers:
// the Rubrics catalog's "Run ▶" (preselect only — no scope, no autorun) and the
// hardcoded rubric-shortcut buttons on other surfaces (rubric + scope + target,
// autorun). Session shortcuts carry ONLY the sessionId — the stream route derives
// the project root server-side, so the client never learns the raw path. Consumed
// once so a later navigation doesn't re-trigger the run.
export interface PendingRubricRun {
  rubric: string;
  scope?: "session" | "project" | "all";
  root?: string;       // project root, for scope "project"
  sessionId?: string;  // for scope "session"; root stays server-derived
  label?: string;      // display label for the injected session row
  autorun?: boolean;   // start the evaluation immediately on landing
}
let pendingRubricRun: PendingRubricRun | null = null;
export function setPendingRubricRun(run: PendingRubricRun): void { pendingRubricRun = run; }
export function consumePendingRubricRun(): PendingRubricRun | null { const r = pendingRubricRun; pendingRubricRun = null; return r; }
