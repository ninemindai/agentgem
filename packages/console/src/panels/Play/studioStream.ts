// packages/console/src/panels/Play/studioStream.ts
// Studio chat stream — Watch convention (threads apiBase, unlike Chat/chatStream.ts which hardcodes it).
//
// POST-then-stream transport (2026-07-20 eng review, issue 10): the message rides a POST body to
// /api/chat/turn (no EventSource query-string/URL-length ceiling — coalesced queues can be big),
// then the SSE stream attaches by the returned turnId and replays-then-follows.
export interface StudioTool { title?: string; kind?: string; status?: string }
export interface StudioStreamHandlers {
  onDelta: (text: string) => void;
  onTool: (tool: StudioTool) => void;
  onDone: (result: { text: string; toolCalls: unknown[]; stopReason?: string }) => void;
  onFailed: (error: string) => void;
}
export function openStudioStream(apiBase: string, chatId: string, message: string, h: StudioStreamHandlers): () => void {
  let es: EventSource | null = null;
  let closed = false;
  void (async () => {
    let turnId: string;
    try {
      const res = await fetch(`${apiBase}/api/chat/turn`, {
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
    es = new EventSource(`${apiBase}/api/chat/stream?${params.toString()}`);
    // A malformed SSE frame must never throw out of a listener: for delta/tool it would silently drop the
    // frame, but for the terminal done/failed events an uncaught throw skips es.close() and the terminal
    // handler, so the stream stays open and the invoke-agent capability is locked forever. Parse safely.
    const parse = (e: Event): any | undefined => {
      try { return JSON.parse((e as MessageEvent).data); } catch { return undefined; }
    };
    es.addEventListener("delta", (e) => { const d = parse(e); if (d) h.onDelta(d.text); });
    es.addEventListener("tool", (e) => { const d = parse(e); if (d) h.onTool(d.tool); });
    es.addEventListener("done", (e) => { const d = parse(e); es?.close(); d ? h.onDone(d.result) : h.onFailed("malformed done frame"); });
    es.addEventListener("failed", (e) => { const d = parse(e); es?.close(); h.onFailed(d?.error ?? "stream failed"); });
    es.addEventListener("error", () => { h.onFailed("connection lost"); es?.close(); });
  })();
  return () => { closed = true; es?.close(); };
}
