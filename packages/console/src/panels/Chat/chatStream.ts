// Chat turn stream — named SSE events (delta/tool/done/failed), same shape as
// insightsStream.ts.  The URL embeds chatId + message as query params; the
// server opens the agent turn and streams back tokens.

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
  const params = new URLSearchParams({ chatId, message });
  const es = new EventSource(`/api/chat/stream?${params.toString()}`);

  es.addEventListener("delta", (e: Event) => {
    h.onDelta(JSON.parse((e as MessageEvent).data).text);
  });
  es.addEventListener("tool", (e: Event) => {
    h.onTool(JSON.parse((e as MessageEvent).data).tool);
  });
  es.addEventListener("done", (e: Event) => {
    h.onDone(JSON.parse((e as MessageEvent).data).result);
    es.close();
  });
  es.addEventListener("failed", (e: Event) => {
    h.onFailed(JSON.parse((e as MessageEvent).data).error);
    es.close();
  });
  es.addEventListener("error", () => {
    h.onFailed("connection lost");
    es.close();
  });

  return () => es.close();
}
