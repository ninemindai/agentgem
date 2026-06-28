// The run stream uses named SSE events (phase/tool/delta/done/failed) with
// different payloads per event, which maps naturally to the browser's native
// EventSource (addEventListener per name) — not @agentback/client's single-schema
// SSE. (The POST /prepare step does go through the typed client.)

export type RunEvent =
  | { type: "phase"; phase: string; agent?: string }
  | { type: "tool"; label: string }
  | { type: "delta"; text: string }
  | { type: "done" }
  | { type: "failed"; message: string };

function toolLabel(tool: unknown): string {
  if (tool && typeof tool === "object") {
    const t = tool as Record<string, unknown>;
    if (typeof t.name === "string") return t.name;
    if (typeof t.title === "string") return t.title;
  }
  return "tool";
}

/** Open the run SSE stream; returns a close function. */
export function openRunStream(
  apiBase: string,
  runId: string,
  task: string,
  onEvent: (e: RunEvent) => void,
): () => void {
  const qs = new URLSearchParams({ runId, task }).toString();
  const es = new EventSource(`${apiBase}/api/gem/run/stream?${qs}`);
  const data = (m: Event) => JSON.parse((m as MessageEvent).data);

  es.addEventListener("phase", (m) => { const d = data(m); onEvent({ type: "phase", phase: d.phase, agent: d.agent }); });
  es.addEventListener("tool", (m) => onEvent({ type: "tool", label: toolLabel(data(m)) }));
  es.addEventListener("delta", (m) => onEvent({ type: "delta", text: data(m).text }));
  es.addEventListener("done", () => { onEvent({ type: "done" }); es.close(); });
  es.addEventListener("failed", (m) => { onEvent({ type: "failed", message: data(m).message }); es.close(); });
  es.addEventListener("error", () => onEvent({ type: "failed", message: "stream connection error" }));

  return () => es.close();
}
