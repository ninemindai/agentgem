import type { Scorecard } from "../../api/routes.js";

type WorkflowEntry = Scorecard["projects"][number]["workflows"][number];

export type WorkflowCardModel = {
  root: string;          // ProjectGoldmine.root — needed for detail fetch + hygiene run
  projectLabel: string;  // ProjectGoldmine.label — provenance ("· react-app")
  key: string;
  name: string;
  confidence: "high" | "medium" | "low";
  portable: boolean;
  sessions: number;
  lastSeenMs: number;
};

export type GemGroup =
  | { key: "battle-tested" | "worth-sharing" | "reusable"; label: string; hint: string; items: WorkflowCardModel[] }
  | { key: "gaps"; label: string; hint: string; gaps: string[] };

const toCard = (root: string, projectLabel: string, w: WorkflowEntry): WorkflowCardModel => ({
  root, projectLabel,
  key: w.key, name: w.name, confidence: w.confidence, portable: w.portable,
  sessions: w.sessions, lastSeenMs: w.lastSeenMs,
});

export function groupWorkflowsByValue(scorecard: Scorecard): GemGroup[] {
  const battleTested: WorkflowCardModel[] = [];
  const worthSharing: WorkflowCardModel[] = [];
  const reusable: WorkflowCardModel[] = [];

  for (const project of scorecard.projects) {
    for (const workflow of project.workflows) {
      const card = toCard(project.root, project.label, workflow);
      if (card.portable) worthSharing.push(card);
      else if (card.confidence === "high") battleTested.push(card);
      else reusable.push(card);
    }
  }

  const groups: GemGroup[] = [];
  if (battleTested.length) groups.push({ key: "battle-tested", label: "Battle-tested", hint: "proven across many sessions", items: battleTested });
  if (worthSharing.length) groups.push({ key: "worth-sharing", label: "Worth sharing", hint: "portable, no local coupling", items: worthSharing });
  if (reusable.length) groups.push({ key: "reusable", label: "Reusable", hint: "detected, not yet battle-tested", items: reusable });
  if (scorecard.gaps.length) groups.push({ key: "gaps", label: "Gaps", hint: "recurring pain, not yet distilled", gaps: scorecard.gaps });
  return groups;
}
