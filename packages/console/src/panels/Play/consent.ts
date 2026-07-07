// packages/console/src/panels/Play/consent.ts
// Per-gem consent for host-brokered capabilities. `session-data` is AUTO (the game's OWN source session,
// declared at seed — implicit consent). The rest reach OTHER data, live sessions, or run code, so they
// require explicit, remembered consent before the Runner will broker them into the sealed iframe.

export const AUTO_CAPS = new Set(["session-data"]);

export const CAP_LABEL: Record<string, string> = {
  "local-project-access": "read your local setup — skills, MCP servers, and projects",
  "live-session-events": "watch your live coding sessions in real time",
  "invoke-agent": "run a local AI agent on your machine",
};

type Decision = "granted" | "denied";
const key = (name: string, cap: string) => `agentgem:play:consent:${name}:${cap}`;

export function getConsent(name: string, cap: string): Decision | null {
  try { const v = localStorage.getItem(key(name, cap)); return v === "granted" || v === "denied" ? v : null; } catch { return null; }
}
export function setConsent(name: string, cap: string, v: Decision): void {
  try { localStorage.setItem(key(name, cap), v); } catch { /* private mode / disabled storage */ }
}
