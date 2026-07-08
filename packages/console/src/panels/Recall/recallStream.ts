// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Recall funnel stream — named SSE events (session_started/session_done/capped/
// synthesis_delta/done/cancelled/failed) from GET /api/recall/stream?jobId=.
// Mirrors panels/Chat/chatStream.ts's shape; the frame-parsing is factored into
// a pure function so it's testable without driving a real EventSource in jsdom.

export type RecallFunnelEvent =
  | { type: "session_started"; sessionId: string }
  | { type: "session_done"; sessionId: string; answered: boolean }
  | { type: "capped"; scanned: number; requested: number; cap: number }
  | { type: "synthesis_delta"; text: string }
  | { type: "done"; answers: { sessionId: string; agent: string; answered: boolean; answer: string }[]; synthesis: string }
  | { type: "cancelled" }
  | { type: "failed"; error: string };

const KNOWN_TYPES = new Set<RecallFunnelEvent["type"]>([
  "session_started", "session_done", "capped", "synthesis_delta", "done", "cancelled", "failed",
]);

// Parse one SSE frame's `data` payload into a typed RecallFunnelEvent, or null
// if it's garbage/unknown. The server's `failed` frame is `{error}` (no `type`
// field) — wrap it. Every other known event name already carries its own
// `type` in the JSON body, so it's returned as-is.
export function parseRecallFrame(eventName: string, data: string): RecallFunnelEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  if (eventName === "failed") {
    const error = (parsed as { error?: unknown })?.error;
    return { type: "failed", error: typeof error === "string" ? error : String(error) };
  }
  if (KNOWN_TYPES.has(eventName as RecallFunnelEvent["type"])) {
    return parsed as RecallFunnelEvent;
  }
  return null;
}

const TERMINAL_TYPES = new Set<RecallFunnelEvent["type"]>(["done", "cancelled", "failed"]);

export function openRecallStream(apiBase: string, jobId: string, onEvent: (e: RecallFunnelEvent) => void): () => void {
  const es = new EventSource(`${apiBase}/api/recall/stream?jobId=${encodeURIComponent(jobId)}`);

  for (const name of KNOWN_TYPES) {
    es.addEventListener(name, (e: Event) => {
      const parsedEvent = parseRecallFrame(name, (e as MessageEvent).data);
      if (parsedEvent) {
        onEvent(parsedEvent);
        if (TERMINAL_TYPES.has(parsedEvent.type)) es.close();
      }
    });
  }

  es.addEventListener("error", () => {
    onEvent({ type: "failed", error: "connection lost" });
    es.close();
  });

  return () => es.close();
}
