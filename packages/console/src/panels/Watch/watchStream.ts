// Watch tab data layer: list active coding sessions, then subscribe to one
// session's live HTML-artifact stream via native EventSource (named events
// phase/artifact/failed — same shape as insightsStream.ts). The server has already
// redacted each artifact's html; the panel only ever renders it inside a null-origin
// sandboxed iframe, never in the console's own DOM.

export interface WatchSession {
  id: string;
  file: string;
  agent: "claude" | "codex";
  project: string | null;
  model: string | null;
  msgs: number;
  startMs: number;
  endMs: number;
  ageMs: number;
}

export interface ArtifactVersion {
  index: number;
  path: string;
  name: string;
  tool: string;
  version: number;
  tsMs: number | null;
  truncated: boolean;
  html: string;
}

export type WatchEvent =
  | { type: "phase"; phase: string; mode?: "transcript" | "file" }
  | { type: "artifact"; artifact: ArtifactVersion }
  | { type: "failed"; message: string };

export async function fetchSessions(apiBase: string): Promise<WatchSession[]> {
  const r = await fetch(`${apiBase}/api/watch/sessions`);
  if (!r.ok) throw new Error(`sessions ${r.status}`);
  const data = (await r.json()) as { sessions: WatchSession[] };
  return data.sessions ?? [];
}

export function openWatchStream(
  apiBase: string,
  file: string,
  onEvent: (e: WatchEvent) => void,
): () => void {
  const params = new URLSearchParams({ file });
  const es = new EventSource(`${apiBase}/api/watch/stream?${params.toString()}`);
  const data = (m: Event) => JSON.parse((m as MessageEvent).data);

  es.addEventListener("phase", (m) => { const d = data(m); onEvent({ type: "phase", phase: d.phase, mode: d.mode }); });
  es.addEventListener("artifact", (m) => onEvent({ type: "artifact", artifact: data(m) as ArtifactVersion }));
  es.addEventListener("failed", (m) => { onEvent({ type: "failed", message: data(m).message }); es.close(); });
  es.addEventListener("error", () => onEvent({ type: "failed", message: "connection lost" }));

  return () => es.close();
}
