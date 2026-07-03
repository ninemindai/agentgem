import type { SessionStat } from "@agentgem/insight";
import type { ConfigInventory, ProjectInventory } from "@agentgem/model";

export interface SessionMatch { sessionId: string; project: string | null; agent: string; model: string | null; gitBranch: string | null; startMs: number; msgs: number }
export interface ArtifactDetail { type: string; name: string; root: string | null; description: string; path?: string }

export function searchSessions(sessions: SessionStat[], query: string, limit: number): SessionMatch[] {
  const q = query.trim().toLowerCase();
  const matched = q
    ? sessions.filter((s) => `${s.project} ${s.model} ${s.gitBranch}`.toLowerCase().includes(q))
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
