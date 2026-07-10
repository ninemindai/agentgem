export interface PlayAgent {
  id: string;
  name: string;
  available: boolean;
  seenInSessions?: number;
  discoveredIds?: string[];
}

export interface DiscoveredPlayAgent {
  id: string;
  sessions: number;
}

const TRANSCRIPT_TO_RUNNABLE: Record<string, string> = {
  claude: "claude-code",
  codex: "codex",
};

const AGENT_LABELS: Record<string, string> = {
  "claude": "Claude Code",
  "claude-code": "Claude Code",
  codex: "Codex",
  cline: "Cline / Roo",
  gemini: "Gemini CLI",
  continue: "Continue",
  cursor: "Cursor",
  atif: "ATIF import",
};

function labelFor(id: string): string {
  return AGENT_LABELS[id] ?? id.replace(/[-_]/g, " ").replace(/\b\w/g, (m) => m.toUpperCase());
}

export function discoveredAgentsFromSessions(sessions: { agent: string }[]): DiscoveredPlayAgent[] {
  const counts = new Map<string, number>();
  for (const s of sessions) {
    const id = String(s.agent ?? "").trim();
    if (!id) continue;
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([id, sessions]) => ({ id, sessions }))
    .sort((a, b) => b.sessions - a.sessions || a.id.localeCompare(b.id));
}

export function mergeRunnableAndDiscoveredAgents(runnable: PlayAgent[], discovered: DiscoveredPlayAgent[]): PlayAgent[] {
  const byId = new Map(runnable.map((a) => [a.id, { ...a }]));
  for (const d of discovered) {
    const runnableId = TRANSCRIPT_TO_RUNNABLE[d.id] ?? d.id;
    const existing = byId.get(runnableId);
    if (existing) {
      existing.seenInSessions = (existing.seenInSessions ?? 0) + d.sessions;
      existing.discoveredIds = [...new Set([...(existing.discoveredIds ?? []), d.id])];
      byId.set(runnableId, existing);
    } else {
      byId.set(runnableId, {
        id: runnableId,
        name: labelFor(d.id),
        available: false,
        seenInSessions: d.sessions,
        discoveredIds: [d.id],
      });
    }
  }
  return [...byId.values()].sort((a, b) => {
    const seen = Number(Boolean(b.seenInSessions)) - Number(Boolean(a.seenInSessions));
    if (seen) return seen;
    const available = Number(b.available) - Number(a.available);
    if (available) return available;
    return a.name.localeCompare(b.name);
  });
}

// Which agent you picked last time you authored a miniapp. That is a better signal of
// intent than either list order or a transcript count, which measures all your other work.
const LAST_AGENT_KEY = "agentgem:play:agent";

export function lastAgentId(): string | null {
  try { return localStorage.getItem(LAST_AGENT_KEY) || null; } catch { return null; }
}
export function rememberAgentId(id: string): void {
  try { localStorage.setItem(LAST_AGENT_KEY, id); } catch { /* private mode / disabled storage */ }
}

/**
 * The agent to select when the user hasn't chosen one.
 *
 * `agents` arrives in display order from mergeRunnableAndDiscoveredAgents, and this walks
 * that same order — so the default is always the option the dropdown shows first. Anything
 * that ranks agents belongs in the sort, not here, or the two drift apart (they did: the
 * list led with Claude Code while this hardcoded Codex, so the selected item was never the
 * first item).
 */
export function preferredAgentId(agents: PlayAgent[], lastUsed?: string | null): string {
  return agents.find((a) => a.available && a.id === lastUsed)?.id
    ?? agents.find((a) => a.available)?.id
    ?? "";
}

export function AgentSelector({
  agents,
  agentId,
  disabled = false,
  onChange,
  note,
}: {
  agents: PlayAgent[] | null;
  agentId: string;
  disabled?: boolean;
  onChange: (agentId: string) => void;
  note?: string;
}) {
  const hasAvailable = (agents ?? []).some((a) => a.available);
  return (
    <label className="play-agent-select">
      <span className="play-agent-select__label">Coding agent</span>
      <select
        className="play-agent-select__control"
        value={agentId}
        disabled={disabled || agents === null || !hasAvailable}
        onChange={(e) => onChange(e.target.value)}
        aria-label="coding agent"
      >
        {agents === null && <option value="">Loading agents…</option>}
        {agents !== null && !agentId && <option value="">No available coding agent selected</option>}
        {(agents ?? []).map((a) => (
          <option key={a.id} value={a.id} disabled={!a.available}>
            {a.name}{a.seenInSessions ? ` · seen in ${a.seenInSessions} session${a.seenInSessions === 1 ? "" : "s"}` : ""}{!a.available ? " (no build adapter)" : ""}
          </option>
        ))}
        {agents !== null && agents.length === 0 && <option value="">No coding agents configured</option>}
      </select>
      {note && <span className="play-agent-select__note">{note}</span>}
    </label>
  );
}
