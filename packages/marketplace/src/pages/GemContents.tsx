// Expandable, grouped-by-kind preview of a gem's bundled artifacts. Executable kinds (MCP servers,
// hooks) are flagged with a ⚠ because they run on install — the marketplace half of "preview before
// install" (the console gates on the same executable set with a consent step).

const KIND_LABEL: Record<string, string> = {
  skill: "Skills", subagent: "Subagents", mcp_server: "MCP servers", mcp: "MCP servers",
  instructions: "Instructions", hook: "Hooks", channel: "Channels",
};
const EXECUTABLE = new Set(["mcp_server", "mcp", "hook"]);
const label = (type: string): string => KIND_LABEL[type] ?? type;

export function GemContents({ artifacts }: { artifacts: { name: string; type: string }[] }) {
  if (artifacts.length === 0) return null;
  // Group by type, preserving first-seen order.
  const groups = new Map<string, string[]>();
  for (const a of artifacts) groups.set(a.type, [...(groups.get(a.type) ?? []), a.name]);
  const anyExec = [...groups.keys()].some((t) => EXECUTABLE.has(t));
  return (
    <section className="ex-card ex-contents">
      <h3>Contents</h3>
      {anyExec && <p className="ex-contents-warn">⚠ This setup includes executable artifacts (MCP servers / hooks) that run on install.</p>}
      <ul className="ex-contents-groups">
        {[...groups.entries()].map(([type, names]) => {
          const exec = EXECUTABLE.has(type);
          return (
            <li key={type}>
              <details className={exec ? "ex-contents-group is-exec" : "ex-contents-group"} open={names.length <= 8}>
                <summary>
                  {exec && <span className="ex-exec-badge" title="Runs on install">⚠</span>}
                  <span className="ex-contents-kind">{label(type)}</span>
                  <span className="ex-contents-count">{names.length}</span>
                </summary>
                <ul className="ex-contents-items">
                  {names.map((n, i) => <li key={n + i} className="ex-contents-item">{n}</li>)}
                </ul>
              </details>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
