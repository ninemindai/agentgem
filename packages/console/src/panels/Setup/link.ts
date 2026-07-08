// The URL contract for deep-linking into the Setup browser. Other panels import
// setupLink() to point straight at an artifact's viewer; Setup itself builds its tab
// routes from the same map, so the link scheme and the tabs can't drift. The Shell
// resolves #/setup/<tab> by longest-prefix match, and Setup opens the ?a=<name> viewer.
export type SetupType = "skills" | "subagents" | "mcpServers" | "hooks" | "instructions";

export const SETUP_ROUTE: Record<SetupType, string> = {
  skills: "#/setup/skills",
  subagents: "#/setup/subagents",
  mcpServers: "#/setup/mcp",
  hooks: "#/setup/hooks",
  instructions: "#/setup/instructions",
};

/** Hash that opens `name`'s viewer on its type tab, e.g. #/setup/skills?a=brainstorming. */
export function setupLink(type: SetupType, name: string): string {
  return `${SETUP_ROUTE[type]}?a=${encodeURIComponent(name)}`;
}
