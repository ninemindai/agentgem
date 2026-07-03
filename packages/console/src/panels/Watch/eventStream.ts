// Watch tab live-FEED data layer: subscribe to one session's ordered SessionEvents
// (messages, tool_calls, tool_results) via native EventSource — named events
// phase/event/failed, same scaffold as watchStream.ts (which streams HTML artifacts).
// The server has already scrubbed every string; the panel renders these as cards,
// never as markup. tool_call and tool_result arrive as SEPARATE events and are
// re-paired by toolId in the view (see toItems in SessionFeed).

export type FeedSpan =
  | { kind: "message"; role: "user" | "assistant"; text: string }
  | { kind: "tool_call"; toolId: string | null; name: string; input: string }
  | { kind: "tool_result"; toolId: string | null; output: string; error: boolean };

export interface FeedEvent {
  index: number;
  tsMs: number;
  span: FeedSpan;
}

export type FeedMsg =
  | { type: "phase"; phase: string; agent: string }
  | { type: "event"; event: FeedEvent }
  | { type: "failed"; message: string };

export function openEventStream(
  apiBase: string,
  file: string,
  onEvent: (e: FeedMsg) => void,
): () => void {
  const params = new URLSearchParams({ file });
  const es = new EventSource(`${apiBase}/api/watch/events?${params.toString()}`);
  const data = (m: Event) => JSON.parse((m as MessageEvent).data);

  es.addEventListener("phase", (m) => { const d = data(m); onEvent({ type: "phase", phase: d.phase, agent: d.agent }); });
  es.addEventListener("event", (m) => onEvent({ type: "event", event: data(m) as FeedEvent }));
  es.addEventListener("failed", (m) => { onEvent({ type: "failed", message: data(m).message }); es.close(); });
  es.addEventListener("error", () => onEvent({ type: "failed", message: "connection lost" }));

  return () => es.close();
}
