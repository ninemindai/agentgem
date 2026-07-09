// packages/console/src/panels/Play/mcpHostTools.ts
// MCP Apps host tool executors — stateless functions that produce the same host data/streams as
// Runner.serve() (see Runner.tsx), plus the tool descriptors and capability<->tool-name maps a future
// MCP Apps router dispatches through. No per-iframe state lives here (one-live-stream / one-invoke-turn
// guards, consent, staleness-pinning) — the router owns that, same as Runner.serve()'s caller does today.
import type { McpUiTool } from "@agentgem/play";
import { makeClient, playSessionDataRoute, inventoryRoute } from "../../api/routes.js";
import { fetchSessions, openWatchStream } from "../Watch/watchStream.js";
import { openStudioStream } from "./studioStream.js";

export interface StreamHandle { close(): void }

// GameCapability -> MCP tool name, and the inverse. One entry per capability declared in
// @agentgem/model's GameCapability (session-data / live-session-events / local-project-access /
// invoke-agent) — kept as plain string maps here since the router only ever sees tool/capability names.
export const CAP_TOOL: Record<string, string> = {
  "session-data": "agentgem_get_session_data",
  "local-project-access": "agentgem_get_inventory",
  "live-session-events": "agentgem_subscribe_sessions",
  "invoke-agent": "agentgem_invoke_agent",
};
export const TOOL_CAP: Record<string, string> = Object.fromEntries(
  Object.entries(CAP_TOOL).map(([cap, tool]) => [tool, cap]),
);

const DESCRIPTIONS: Record<string, string> = {
  "session-data": "Get the miniapp's source-session transcript (meta + timeline).",
  "local-project-access": "Get the viewer's local inventory (skills, MCP servers, projects).",
  "live-session-events": "Subscribe to the viewer's live coding-session events.",
  "invoke-agent": "Run a local AI agent turn and stream back the transcript.",
};

// session-data/invoke-agent take optional args; the other two take none. McpUiTool's reused
// `inputSchema.properties: Record<string, never>` was shaped for mcpToolFor()'s zero-arg launcher tool
// and is stricter than a real per-tool JSON Schema needs, so the two arg-taking tools' properties are
// widened here via a cast rather than redefining the shared @agentgem/play type.
const ARG_PROPERTIES: Record<string, Record<string, unknown>> = {
  "session-data": { sessionId: { type: "string" }, agent: { type: "string" } },
  "invoke-agent": { message: { type: "string" } },
};

export const HOST_TOOLS: McpUiTool[] = Object.keys(CAP_TOOL).map((cap) => ({
  name: CAP_TOOL[cap],
  description: DESCRIPTIONS[cap],
  inputSchema: { type: "object" as const, properties: ARG_PROPERTIES[cap] ?? {} },
  _meta: { ui: { resourceUri: "", visibility: ["app"] as ("model" | "app")[] } }, // host tools, not a ui resource
}));

// getSessionData: Runner.serve()'s "session-data" cap. When `args` is present (the "Replay yours"
// rebind path / feedSession in Runner.tsx), pin the fetch to that specific session instead of the
// game's own source session.
export async function getSessionData(
  apiBase: string,
  name: string,
  args?: { sessionId?: string; agent?: string },
): Promise<{ meta: Record<string, unknown>; timeline: unknown[] }> {
  return playSessionDataRoute.call(makeClient(apiBase), {
    query: { name, ...(args?.sessionId ? { sessionId: args.sessionId, agent: args.agent } : {}) },
  });
}

// getInventory: Runner.serve()'s "local-project-access" cap.
export async function getInventory(apiBase: string): Promise<unknown> {
  return inventoryRoute.call(makeClient(apiBase), { query: {} });
}

// subscribeSessions: Runner.serve()'s "live-session-events" cap — the most-recent session is "live";
// with no sessions yet, report idle so the caller can retry once one exists.
export async function subscribeSessions(
  apiBase: string,
  onEvent: (e: unknown) => void,
): Promise<{ status: "subscribed"; handle: StreamHandle } | { status: "idle" }> {
  const sessions = await fetchSessions(apiBase);
  const file = sessions[0]?.file;
  if (!file) return { status: "idle" };
  const close = openWatchStream(apiBase, file, onEvent);
  return { status: "subscribed", handle: { close } };
}

// openNeutralChat: Runner.serve()'s chat-open half of "invoke-agent" — a neutral (read-only,
// permission:deny) chat session, deliberately NOT scoped to any miniapp (no `miniapp` field posted).
export async function openNeutralChat(apiBase: string): Promise<string> {
  const agents = await fetch(`${apiBase}/api/agents`).then((r) => r.json());
  const agentId = agents.agents?.find((a: { available?: boolean }) => a.available)?.id ?? agents.agents?.[0]?.id;
  const res = await fetch(`${apiBase}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agentId }), // no `miniapp` field — neutral, never gem-scoped
  }).then((r) => r.json());
  return res.chatId as string;
}

// invokeAgent: Runner.serve()'s stream half of "invoke-agent" — one turn on an already-open chat,
// streamed back through the caller's handlers.
export function invokeAgent(
  apiBase: string,
  chatId: string,
  message: string,
  h: { onDelta: (t: string) => void; onTool: (t: unknown) => void; onDone: () => void; onFailed: (e: string) => void },
): StreamHandle {
  const close = openStudioStream(apiBase, chatId, message, {
    onDelta: h.onDelta,
    onTool: h.onTool,
    onDone: () => h.onDone(),
    onFailed: h.onFailed,
  });
  return { close };
}
