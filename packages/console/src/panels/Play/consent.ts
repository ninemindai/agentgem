// packages/console/src/panels/Play/consent.ts
// Per-gem consent for host-brokered capabilities. `session-data` is AUTO (the game's OWN source session,
// declared at seed — implicit consent). The rest reach OTHER data, live sessions, or run code, so they
// require explicit, remembered consent before the Runner will broker them into the sealed iframe.

export const AUTO_CAPS = new Set(["session-data"]);

export const CAP_LABEL: Record<string, string> = {
  "local-project-access": "read your local setup — skills, MCP servers, and projects",
  "live-session-events": "watch your live coding sessions in real time",
  "context-hygiene": "read your live session's context-health signal",
  "invoke-agent": "run a local AI agent on your machine",
  "open-link": "open an external link in your browser",
  "send-message": "send a message into your conversation as you",
  "update-model-context": "push structured state into the model's context",
};

// The consent-gated capabilities, in display order. `session-data` is deliberately absent: AUTO_CAPS
// marks it auto-approved (declared at seed), so it is never something a user opts into.
export const CONSENT_CAPS = [
  "local-project-access", "live-session-events", "context-hygiene", "invoke-agent",
  "open-link", "send-message", "update-model-context",
] as const;

// GameCapability -> MCP tool name, and the inverse. Browser-safe mirror of @agentgem/model's canonical
// map (packages/model/src/capabilities.ts): the console is bundled for the browser by
// scripts/build-console.mjs, and @agentgem/play's barrel (which re-exports this map) pulls in
// node:os/node:path/node:fs at runtime, so it cannot be value-imported here. A drift-guard test
// (__tests__/capTool.drift.test.ts) pins this copy to the canonical one.
export const CAP_TOOL: Record<string, string> = {
  "session-data": "agentgem_get_session_data",
  "local-project-access": "agentgem_get_inventory",
  "live-session-events": "agentgem_subscribe_sessions",
  "invoke-agent": "agentgem_invoke_agent",
  "context-hygiene": "agentgem_subscribe_hygiene",
};
export const TOOL_CAP: Record<string, string> = Object.fromEntries(
  Object.entries(CAP_TOOL).map(([cap, tool]) => [tool, cap]),
);

type Decision = "granted" | "denied";
const key = (name: string, cap: string) => `agentgem:play:consent:${name}:${cap}`;

export function getConsent(name: string, cap: string): Decision | null {
  try { const v = localStorage.getItem(key(name, cap)); return v === "granted" || v === "denied" ? v : null; } catch { return null; }
}
export function setConsent(name: string, cap: string, v: Decision): void {
  try { localStorage.setItem(key(name, cap), v); } catch { /* private mode / disabled storage */ }
}
