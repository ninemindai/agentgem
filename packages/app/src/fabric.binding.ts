// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Fabric router wiring for the app spine: the DI key, the standard in-app kind
// registrations, and the MCP adapter (docs/proposals/message-fabric.md §Parties).
// The adapter owns NO authorization: the manifest/digest security boundary stays
// in PlayController.mcpCall — by the proposal's three-layer split, the fabric
// authorizes the message, the handler owns the business outcome.
import { BindingKey } from "@agentback/core";
import { FabricRouter, FabricRouterError, parseAddress } from "@agentgem/fabric";
import { z } from "zod";

export const FABRIC_ROUTER = BindingKey.create<FabricRouter>("agentgem.fabric.router");

export const MCP_ASK_TIMEOUT_MS = 120_000; //  generous backstop: the SDK's own timeout fires first

export interface McpAdapterDeps {
    callConnectorTool(server: string, tool: string, input: unknown): Promise<{ content: unknown[]; structuredContent?: unknown }>;
    isConnectorError?(e: unknown): e is Error & { code: string };
}

export type McpAskReply =
    | { ok: true; result: { content: unknown[]; structuredContent?: unknown } }
    | { ok: false; code: string; message: string };

export function registerMcpAdapter(router: FabricRouter, deps: McpAdapterDeps): void {
    for (const kind of ["chat.phase", "chat.delta", "chat.tool", "chat.done", "chat.failed"]) {
        router.kinds.register({ kind, owner: "@agentgem/run", version: 1, payload: z.unknown() });
    }
    router.kinds.register({ kind: "mcp.tool.call", owner: "@agentgem/play", version: 1, payload: z.unknown() });
    router.handle("mcp", async (envelope): Promise<McpAskReply> => {
        const server = parseAddress(envelope.to as string).path[1];
        const { tool, input } = envelope.payload as { tool: string; input: unknown };
        if (!server || !tool) return { ok: false, code: "bad_request", message: "mcp ask needs a server sub-path and a tool" };
        try {
            const result = await deps.callConnectorTool(server, tool, input);
            return { ok: true, result };
        } catch (e) {
            //  ConnectorError is an APPLICATION error — it rides the reply payload, never a
            //  fabric error (proposal §Error handling). Anything else rethrows into the
            //  fabric transport error and the caller maps it to upstream_error.
            if (deps.isConnectorError?.(e)) return { ok: false, code: e.code, message: e.message };
            throw e;
        }
    });
}

// The caller-side counterpart to registerMcpAdapter's own error handling: maps a thrown ask()
// failure onto the existing MCP error-code contract. A fabric TIMEOUT matches callConnectorTool's
// own timeout contract (server_unavailable); everything else (transport, or a non-fabric throw) is
// an upstream_error — the connector call itself never reached a usable outcome.
export function mapAskFailure(e: unknown): { code: string; message: string } {
    if (e instanceof FabricRouterError && e.kind === "timeout") return { code: "server_unavailable", message: e.message };
    return { code: "upstream_error", message: (e as Error).message };
}
