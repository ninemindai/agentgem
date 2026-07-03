// Streaming cross-agent verify: named SSE events tagged per agent, consumed via
// native EventSource — the same pattern as runStream.ts, one stream for N agents.

export type VerifyStatus = "passed" | "failed" | "unavailable";
export type VerifyEvent =
  | { type: "agent-start"; agent: string }
  | { type: "tool"; agent: string; label: string }
  | { type: "delta"; agent: string; text: string }
  | { type: "verdict"; agent: string; status: VerifyStatus; detail?: string }
  | { type: "done"; verdicts: { agent: string; status: VerifyStatus; detail?: string }[] }
  | { type: "failed"; message: string };

function toolLabel(tool: unknown): string {
  if (tool && typeof tool === "object") {
    const t = tool as Record<string, unknown>;
    if (typeof t.title === "string") return t.title;
    if (typeof t.name === "string") return t.name;
  }
  return "tool";
}

/** Open the verify SSE stream; returns a close function. */
export function openVerifyStream(
  apiBase: string,
  verifyId: string,
  onEvent: (e: VerifyEvent) => void,
): () => void {
  const es = new EventSource(`${apiBase}/api/gem/verify/stream?${new URLSearchParams({ verifyId })}`);
  const data = (m: Event) => JSON.parse((m as MessageEvent).data);

  es.addEventListener("agent-start", (m) => onEvent({ type: "agent-start", agent: data(m).agent }));
  es.addEventListener("tool", (m) => { const d = data(m); onEvent({ type: "tool", agent: d.agent, label: toolLabel(d) }); });
  es.addEventListener("delta", (m) => { const d = data(m); onEvent({ type: "delta", agent: d.agent, text: d.text }); });
  es.addEventListener("verdict", (m) => { const d = data(m); onEvent({ type: "verdict", agent: d.agent, status: d.status, detail: d.detail }); });
  es.addEventListener("done", (m) => { onEvent({ type: "done", verdicts: data(m).verdicts }); es.close(); });
  es.addEventListener("failed", (m) => { onEvent({ type: "failed", message: data(m).message }); es.close(); });
  es.addEventListener("error", () => { onEvent({ type: "failed", message: "stream connection error" }); es.close(); });

  return () => es.close();
}
