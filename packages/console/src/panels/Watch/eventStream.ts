// Watch tab live-FEED data layer: subscribe to one session's ordered SessionEvents
// (messages, tool_calls, tool_results) via native EventSource — named events
// phase/event/failed, same scaffold as watchStream.ts (which streams HTML artifacts).
// The server has already scrubbed every string; the panel renders these as cards,
// never as markup. tool_call and tool_result arrive as SEPARATE events and are
// re-paired by toolId in the view (see toItems in SessionFeed).
// Transport resilience (stall watchdog → ?poll=1 fallback) comes from
// openResilientStream; the `after` cursor is the count of events delivered.
import { openResilientStream, type PollResult } from "../_shared/resilientStream.js";

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
  const close = openResilientStream<{ after: number }>({
    streamUrl: `${apiBase}/api/watch/events?${new URLSearchParams({ file }).toString()}`,
    events: ["phase", "event", "failed"],
    initialCursor: { after: 0 },
    advance: (c, event, data) => (event === "event" ? { after: (data as FeedEvent).index + 1 } : c),
    poll: async (c) => {
      const params = new URLSearchParams({ file, poll: "1", after: String(c.after) });
      const r = await fetch(`${apiBase}/api/watch/events?${params.toString()}`);
      if (!r.ok) throw new Error(`events poll ${r.status}`);
      return (await r.json()) as PollResult<{ after: number }>;
    },
    onMessage: (event, data) => {
      const d = data as Record<string, unknown>;
      if (event === "phase") onEvent({ type: "phase", phase: d.phase as string, agent: d.agent as string });
      else if (event === "event") onEvent({ type: "event", event: data as FeedEvent });
      else if (event === "failed") { onEvent({ type: "failed", message: d.message as string }); close(); }
    },
  });
  return close;
}
