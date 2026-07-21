// Chat turn stream — named SSE events (delta/tool/done/failed), same shape as
// insightsStream.ts.
//
// POST-then-stream transport (2026-07-20 eng review, issue 10): the message rides a POST body to
// /api/chat/turn (no EventSource query-string/URL-length ceiling — coalesced queues can be big),
// then the SSE stream attaches by the returned turnId and replays-then-follows.

export interface ChatToolChip {
  toolCallId: string;
  title: string;
  status?: string;
}

export interface ChatStreamHandlers {
  onDelta: (text: string) => void;
  onTool: (tool: ChatToolChip) => void;
  onDone: (result: { text: string; toolCalls: unknown[]; stopReason?: string }) => void;
  onFailed: (error: string) => void;
}

export function openChatStream(
  chatId: string,
  message: string,
  h: ChatStreamHandlers,
): () => void {
  let es: EventSource | null = null;
  let closed = false;
  void (async () => {
    let turnId: string;
    try {
      const res = await fetch("/api/chat/turn", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chatId, message }),
      });
      if (!res.ok) { if (!closed) h.onFailed(`turn start failed (${res.status})`); return; }
      turnId = (await res.json()).turnId as string;
    } catch (e) {
      if (!closed) h.onFailed((e as Error).message || "turn start failed");
      return;
    }
    if (closed) return; // caller tore down while the POST was in flight — never open a zombie stream
    const params = new URLSearchParams({ chatId, turnId });
    es = new EventSource(`/api/chat/stream?${params.toString()}`);
    es.addEventListener("delta", (e: Event) => {
      h.onDelta(JSON.parse((e as MessageEvent).data).text);
    });
    es.addEventListener("tool", (e: Event) => {
      h.onTool(JSON.parse((e as MessageEvent).data).tool);
    });
    es.addEventListener("done", (e: Event) => {
      h.onDone(JSON.parse((e as MessageEvent).data).result);
      es?.close();
    });
    es.addEventListener("failed", (e: Event) => {
      h.onFailed(JSON.parse((e as MessageEvent).data).error);
      es?.close();
    });
    es.addEventListener("error", () => {
      h.onFailed("connection lost");
      es?.close();
    });
  })();

  return () => { closed = true; es?.close(); };
}
