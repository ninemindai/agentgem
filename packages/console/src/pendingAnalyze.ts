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

// One-shot hand-off of a distilled playbook draft from the Insights panel to
// Curate. Consumed (read-and-cleared) once so a later navigation to Curate
// doesn't re-trigger.
export interface PendingPlaybook { root: string; skills: string[]; lessons: string[] }
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
