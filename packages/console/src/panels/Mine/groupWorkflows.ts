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
