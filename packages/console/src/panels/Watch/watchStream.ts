// Watch tab data layer: list active coding sessions, then subscribe to one
// session's live HTML-artifact stream via native EventSource (named events
// phase/artifact/failed — same shape as insightsStream.ts). The server has already
// redacted each artifact's html; the panel only ever renders it inside a null-origin
// sandboxed iframe, never in the console's own DOM.
// Transport resilience (stall watchdog → ?poll=1 fallback) comes from
// openResilientStream — see resilientStream.ts for the buffering-proxy rationale.
import { openResilientStream, type PollResult } from "../_shared/resilientStream.js";

export interface WatchSession {
  id: string;
  file: string;
  agent: string;
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

export interface AtifHealthFile { name: string; detail?: string }
export interface AtifHealthGroup { code: string; rejection: boolean; occurrences: number; files: AtifHealthFile[] }
export interface AtifHealth { totalFiles: number; imported: number; groups: AtifHealthGroup[] }

export async function fetchAtifHealth(apiBase: string): Promise<AtifHealth> {
  const r = await fetch(`${apiBase}/api/watch/atif-health`);
  if (!r.ok) throw new Error(`atif-health ${r.status}`);
  const data = (await r.json()) as Partial<AtifHealth>;
  return { totalFiles: data.totalFiles ?? 0, imported: data.imported ?? 0, groups: data.groups ?? [] };
}

export function openWatchStream(
  apiBase: string,
  file: string,
  onEvent: (e: WatchEvent) => void,
): () => void {
  // Cursor carries both strategies' positions: `after` (transcript-driven count)
  // and `since` (file-driven max mtime); the server uses whichever fits its mode.
  type Cursor = { after: number; since: number };
  const close = openResilientStream<Cursor>({
    streamUrl: `${apiBase}/api/watch/stream?${new URLSearchParams({ file }).toString()}`,
    events: ["phase", "artifact", "failed"],
    initialCursor: { after: 0, since: 0 },
    advance: (c, event, data) => {
      if (event !== "artifact") return c;
      const a = data as ArtifactVersion;
      return { after: a.index + 1, since: Math.max(c.since, a.tsMs ?? c.since) };
    },
    poll: async (c) => {
      const params = new URLSearchParams({ file, poll: "1", after: String(c.after), since: String(c.since) });
      const r = await fetch(`${apiBase}/api/watch/stream?${params.toString()}`);
      if (!r.ok) throw new Error(`stream poll ${r.status}`);
      return (await r.json()) as PollResult<Cursor>;
    },
    onMessage: (event, data) => {
      const d = data as Record<string, unknown>;
      if (event === "phase") onEvent({ type: "phase", phase: d.phase as string, mode: d.mode as "transcript" | "file" | undefined });
      else if (event === "artifact") onEvent({ type: "artifact", artifact: data as ArtifactVersion });
      else if (event === "failed") { onEvent({ type: "failed", message: d.message as string }); close(); }
    },
  });
  return close;
}
