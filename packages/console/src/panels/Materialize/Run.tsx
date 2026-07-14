import { useEffect, useRef, useState } from "react";
import { prepareRunRoute, prepareVerifyRoute, makeClient } from "../../api/routes.js";
import type { GemSelection } from "../Curate/selection.js";
import { openRunStream } from "./runStream.js";
import { openVerifyStream, type VerifyStatus } from "./verifyStream.js";

type Status = "idle" | "preparing" | "running" | "done" | "failed";
type AgentBlock = { output: string; tools: string[]; status: "pending" | "running" | VerifyStatus; detail?: string };

const MATRIX_MARK: Record<VerifyStatus, string> = { passed: "✓", failed: "✗", unavailable: "–" };

/** Run the built gem with a local coding agent — or verify it across all of them. */
export function Run({ apiBase, selection, name }: { apiBase: string; selection: GemSelection; name: string }) {
  const [task, setTask] = useState("");
  const [agent, setAgent] = useState<"claude" | "codex" | "all">("claude");
  const [status, setStatus] = useState<Status>("idle");
  const [phase, setPhase] = useState<string>("");
  const [output, setOutput] = useState("");
  const [tools, setTools] = useState<string[]>([]);
  const [blocks, setBlocks] = useState<Record<string, AgentBlock>>({});
  const [agentOrder, setAgentOrder] = useState<string[]>([]);
  const [verdicts, setVerdicts] = useState<{ agent: string; status: VerifyStatus; detail?: string }[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const closeRef = useRef<(() => void) | null>(null);

  useEffect(() => () => closeRef.current?.(), []);

  const patchBlock = (a: string, patch: (b: AgentBlock) => AgentBlock) =>
    setBlocks((bs) => ({ ...bs, [a]: patch(bs[a] ?? { output: "", tools: [], status: "pending" }) }));

  const start = async () => {
    closeRef.current?.();
    setStatus("preparing");
    setPhase(""); setOutput(""); setTools([]);
    setBlocks({}); setAgentOrder([]); setVerdicts(null);
    setError(null);
    try {
      const client = makeClient(apiBase);
      if (agent === "all") {
        // Contract-only: the gem's own claim is the task (no task input in this mode).
        const prep = await prepareVerifyRoute.call(client, { body: { selection, name } });
        setAgentOrder(prep.agents);
        setBlocks(Object.fromEntries(prep.agents.map((a) => [a, { output: "", tools: [], status: "pending" as const }])));
        setStatus("running");
        closeRef.current = openVerifyStream(client, prep.verifyId, (e) => {
          if (e.type === "agent-start") patchBlock(e.agent, (b) => ({ ...b, status: "running" }));
          else if (e.type === "delta") patchBlock(e.agent, (b) => ({ ...b, output: b.output + e.text }));
          else if (e.type === "tool") patchBlock(e.agent, (b) => ({ ...b, tools: [...b.tools, e.label] }));
          else if (e.type === "verdict") patchBlock(e.agent, (b) => ({ ...b, status: e.status, detail: e.detail }));
          else if (e.type === "done") { setVerdicts(e.verdicts); setStatus("done"); }
          else if (e.type === "failed") { setStatus("failed"); setError(e.message); }
        });
      } else {
        const { runId } = await prepareRunRoute.call(client, { body: { selection, name, agent } });
        setStatus("running");
        closeRef.current = openRunStream(client, runId, task, (e) => {
          if (e.type === "phase") setPhase(e.phase);
          else if (e.type === "delta") setOutput((o) => o + e.text);
          else if (e.type === "tool") setTools((t) => [...t, e.label]);
          else if (e.type === "done") setStatus("done");
          else if (e.type === "failed") { setStatus("failed"); setError(e.message); }
        });
      }
    } catch (e) {
      setStatus("failed");
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const busy = status === "preparing" || status === "running";
  const all = agent === "all";

  return (
    <div className="run">
      <div className="run-bar">
        <span className="targets-label">Run with</span>
        <select className="targets-select" aria-label="agent" value={agent} onChange={(e) => setAgent(e.target.value as "claude" | "codex" | "all")}>
          <option value="claude">claude</option>
          <option value="codex">codex</option>
          <option value="all">all agents</option>
        </select>
        {!all && (
          <input
            className="ledger-search run-task"
            type="text"
            aria-label="task"
            placeholder="task for the agent (e.g. “list the skills you have”)"
            value={task}
            onChange={(e) => setTask(e.target.value)}
          />
        )}
        <button type="button" className="ledger-build" disabled={busy || (!all && !task.trim())} onClick={start}>
          {busy ? (all ? "Verifying…" : "Running…") : all ? "Verify" : "Run"}
        </button>
      </div>

      {status !== "idle" && !all && (
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

      {status !== "idle" && all && (
        <div className="run-out">
          {error && <p className="ledger-error">{error}</p>}
          {agentOrder.map((a) => {
            const b = blocks[a];
            if (!b) return null;
            return (
              <div className="run-agent-block" key={a}>
                <div className="run-status">
                  <strong className="run-agent-name">{a}</strong>
                  <span className={"run-badge run-" + (b.status === "passed" ? "done" : b.status === "running" ? "running" : b.status === "pending" ? "idle" : "failed")}>{b.status}</span>
                  {b.tools.map((t, i) => <span className="ws-chip" key={i}>{t}</span>)}
                </div>
                {b.detail && <p className="ledger-error">{b.detail}</p>}
                {b.output && <pre className="run-transcript">{b.output}</pre>}
              </div>
            );
          })}
          {verdicts && (
            <p className="run-matrix">
              {verdicts.map((v) => `${MATRIX_MARK[v.status]} ${v.agent}${v.detail ? ` (${v.detail})` : ""}`).join(" · ")}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
