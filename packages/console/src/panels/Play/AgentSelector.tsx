export interface PlayAgent {
  id: string;
  name: string;
  available: boolean;
}

export function preferredAgentId(agents: PlayAgent[]): string {
  return agents.find((a) => a.available && a.id === "codex")?.id
    ?? agents.find((a) => a.available)?.id
    ?? agents[0]?.id
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
  return (
    <label className="play-agent-select">
      <span className="play-agent-select__label">Coding agent</span>
      <select
        className="play-agent-select__control"
        value={agentId}
        disabled={disabled || agents === null || (agents?.length ?? 0) === 0}
        onChange={(e) => onChange(e.target.value)}
        aria-label="coding agent"
      >
        {agents === null && <option value="">Loading agents…</option>}
        {(agents ?? []).map((a) => (
          <option key={a.id} value={a.id} disabled={!a.available}>
            {a.name}{!a.available ? " (unavailable)" : ""}
          </option>
        ))}
        {agents !== null && agents.length === 0 && <option value="">No coding agents configured</option>}
      </select>
      {note && <span className="play-agent-select__note">{note}</span>}
    </label>
  );
}
