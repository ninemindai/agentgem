// packages/console/src/panels/Play/studioStream.ts
// Studio chat stream — Watch convention (threads apiBase, unlike Chat/chatStream.ts which hardcodes it).
export interface StudioStreamHandlers {
  onDelta: (text: string) => void;
  onDone: (result: { text: string; toolCalls: unknown[] }) => void;
  onFailed: (error: string) => void;
}
export function openStudioStream(apiBase: string, chatId: string, message: string, h: StudioStreamHandlers): () => void {
  const params = new URLSearchParams({ chatId, message });
  const es = new EventSource(`${apiBase}/api/chat/stream?${params.toString()}`);
  es.addEventListener("delta", (e) => h.onDelta(JSON.parse((e as MessageEvent).data).text));
  es.addEventListener("done", (e) => { h.onDone(JSON.parse((e as MessageEvent).data).result); es.close(); });
  es.addEventListener("failed", (e) => { h.onFailed(JSON.parse((e as MessageEvent).data).error); es.close(); });
  es.addEventListener("error", () => { h.onFailed("connection lost"); es.close(); });
  return () => es.close();
}
