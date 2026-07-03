import type { SessionStat, AgentId, TranscriptView, TranscriptTurn } from "@agentgem/insight";
import type { ConfigInventory, ProjectInventory } from "@agentgem/model";

export interface SessionMatch { sessionId: string; project: string | null; agent: string; model: string | null; gitBranch: string | null; startMs: number; msgs: number }
export interface ArtifactDetail { type: string; name: string; root: string | null; description: string; path?: string }

/** A bounded slice of a session transcript. `meta` carries the session's token
 *  counts so the agent can answer "how much did this session cost?". */
export interface TranscriptWindow {
  sessionId: string;
  agent: AgentId;
  meta: SessionStat;
  turns: TranscriptTurn[];
  total: number;    // total turns in the session
  from: number;     // clamped window start actually used
  hasMore: boolean; // are there turns past this window?
}

/** Slice a loaded transcript into a bounded window of turns. Turn content is
 *  already scrubbed by loadSessionTranscript; this only paginates, so a long
 *  session can't blow the chat agent's context (or token budget) in one call. */
export function windowTranscript(view: TranscriptView, from: number, limit: number): TranscriptWindow {
  const start = Math.max(0, Math.min(from, view.turns.length));
  return {
    sessionId: view.sessionId,
    agent: view.agent,
    meta: view.meta,
    turns: view.turns.slice(start, start + limit),
    total: view.turns.length,
    from: start,
    hasMore: start + limit < view.turns.length,
  };
}

export function searchSessions(sessions: SessionStat[], query: string, limit: number): SessionMatch[] {
  const q = query.trim().toLowerCase();
  const matched = q
    ? sessions.filter((s) => ((s.project ?? "") + " " + (s.model ?? "") + " " + (s.gitBranch ?? "")).toLowerCase().includes(q))
    : sessions.slice();
  return matched
    .sort((a, b) => b.startMs - a.startMs)
    .slice(0, limit)
    .map((s) => ({ sessionId: s.sessionId, project: s.project, agent: s.agent, model: s.model, gitBranch: s.gitBranch, startMs: s.startMs, msgs: s.msgs }));
}

type Bucket = { name: string; description?: string; path?: string };
const KEY: Record<string, keyof ProjectInventory & keyof ConfigInventory> = {
  skill: "skills", mcp_server: "mcpServers", hook: "hooks", instructions: "instructions",
} as any;

export function getArtifactDetail(global: ConfigInventory, project: ProjectInventory | null, type: string, name: string): ArtifactDetail | null {
  const key = KEY[type]; if (!key) return null;
  const find = (list: Bucket[] | undefined, root: string | null) => {
    const hit = (list ?? []).find((a) => a.name === name);
    return hit ? { type, name: hit.name, root, description: hit.description ?? "", path: hit.path } : null;
  };
  return find(project?.[key] as Bucket[] | undefined, project?.root ?? null) ?? find(global[key] as Bucket[] | undefined, null);
}
