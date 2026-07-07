export type ToolCategory = "read" | "write" | "bash" | "skill" | "agent" | "ask" | "task" | "other";

const MAP: Record<string, ToolCategory> = {
  Read: "read", Grep: "read", Glob: "read", LS: "read", ToolSearch: "read",
  Write: "write", Edit: "write", NotebookEdit: "write",
  Bash: "bash",
  Skill: "skill",
  Task: "agent", Agent: "agent",
  AskUserQuestion: "ask",
  TaskCreate: "task", TaskUpdate: "task",
};

export function catOf(tool: string): ToolCategory {
  return MAP[tool] ?? "other";
}

export const CATEGORY_COLOR: Record<ToolCategory, string> = {
  read: "var(--blue)", write: "var(--green)", bash: "var(--slate)", skill: "var(--purple)",
  agent: "var(--pink)", ask: "var(--amber)", task: "var(--teal)", other: "var(--muted)",
};
