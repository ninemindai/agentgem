import { useEffect, useRef, useState } from "react";
import { prepareRunRoute, makeClient } from "../../api/routes.js";
import type { GemSelection } from "../Ledger/selection.js";
import { openRunStream } from "./runStream.js";

type Status = "idle" | "preparing" | "running" | "done" | "failed";

/** Run the built gem with a local coding agent (claude/codex), streaming output. */
export function Run({ apiBase, selection, name }: { apiBase: string; selection: GemSelection; name: string }) {
  const [task, setTask] = useState("");
  const [agent, setAgent] = useState<"claude" | "codex">("claude");
  const [status, setStatus] = useState<Status>("idle");
  const [phase, setPhase] = useState<string>("");
  const [output, setOutput] = useState("");
  const [tools, setTools] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const closeRef = useRef<(() => void) | null>(null);

  useEffect(() => () => closeRef.current?.(), []);

  const start = async () => {
    closeRef.current?.();
    setStatus("preparing");
    setPhase("");
    setOutput("");
    setTools([]);
    setError(null);
    try {
      const client = makeClient(apiBase);
      const { runId } = await prepareRunRoute.call(client, { body: { selection, name, agent } });
      setStatus("running");
      closeRef.current = openRunStream(apiBase, runId, task, (e) => {
        if (e.type === "phase") setPhase(e.phase);
        else if (e.type === "delta") setOutput((o) => o + e.text);
        else if (e.type === "tool") setTools((t) => [...t, e.label]);
        else if (e.type === "done") setStatus("done");
        else if (e.type === "failed") { setStatus("failed"); setError(e.message); }
      });
    } catch (e) {
      setStatus("failed");
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const busy = status === "preparing" || status === "running";

  return (
    <div className="run">
      <div className="run-bar">
        <span className="targets-label">Run with</span>
        <select className="targets-select" aria-label="agent" value={agent} onChange={(e) => setAgent(e.target.value as "claude" | "codex")}>
          <option value="claude">claude</option>
          <option value="codex">codex</option>
        </select>
        <input
          className="ledger-search run-task"
          type="text"
          aria-label="task"
          placeholder="task for the agent (e.g. “list the skills you have”)"
          value={task}
          onChange={(e) => setTask(e.target.value)}
        />
        <button type="button" className="ledger-build" disabled={busy || !task.trim()} onClick={start}>
          {busy ? "Running…" : "Run"}
        </button>
      </div>

      {status !== "idle" && (
        <div className="run-out">
          <div className="run-status">
            <span className={"run-badge run-" + status}>{status}</span>
            {phase && <span className="run-phase">{phase}</span>}
            {tools.map((t, i) => <span className="ws-chip" key={i}>{t}</span>)}
          </div>
          {error && <p className="ledger-error">{error}</p>}
          {output && <pre className="run-transcript">{output}</pre>}
        </div>
      )}
    </div>
  );
}
