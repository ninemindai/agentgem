// packages/console/src/panels/Play/playMeta.ts
// Shared presentation metadata for the Play UI (genres, capability chips) + gate-error parsing.

export const GENRES: Record<string, { label: string; icon: string; tint: string }> = {
  replay: { label: "Session replay", icon: "▶", tint: "var(--gold)" },
  "skill-run": { label: "Skill run", icon: "⚙", tint: "var(--emerald)" },
  "project-fun": { label: "Project fun", icon: "★", tint: "var(--accent)" },
  html: { label: "Imported", icon: "⌘", tint: "var(--ink-soft)" },
};
export const genre = (g: string) => GENRES[g] ?? { label: g, icon: "◆", tint: "var(--muted)" };

// Capability chips are DISPLAY-ONLY in v1 (the consent gate + broker are deferred).
export const CHIP: Record<string, { label: string; title: string }> = {
  "live-session-events": { label: "🔴 live", title: "reads live sessions (host-brokered, read-only)" },
  "local-project-access": { label: "🟡 local", title: "reads local projects (host-brokered, read-only)" },
  "invoke-agent": { label: "⚙ agent", title: "runs a local agent (local-authored only)" },
  "session-data": { label: "📊 data", title: "reads its source session (host-brokered)" },
};

// The server surfaces a failed seal gate as: "miniapp failed the gate: <a>; <b>". Pull the reasons out so
// the studio can show them and offer a one-click fix (chat the agent to seal it).
export function parseGateFailure(message: string): string[] | null {
  const m = /failed the gate:\s*(.+)$/i.exec(message);
  if (!m) return null;
  return m[1].split(";").map((s) => s.trim()).filter(Boolean);
}

// The message we hand the studio agent to self-heal a seal violation.
export function fixSealPrompt(failures: string[]): string {
  return (
    `Saving failed the seal check: ${failures.join("; ")}. ` +
    `Make this a fully self-contained, offline miniapp: inline any external CSS/fonts/scripts, ` +
    `replace remote images with data: URIs (or drop them), and remove any network calls (fetch/XHR/WebSocket). ` +
    `Keep the game working and the look as close as possible.`
  );
}
