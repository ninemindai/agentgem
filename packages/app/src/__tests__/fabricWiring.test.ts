// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";
import { FabricRouter } from "@agentgem/fabric";
import { registerMcpAdapter } from "../fabric.binding.js";

describe("fabric app wiring", () => {
    it("registers the standard kinds and the mcp adapter segment", () => {
        const router = new FabricRouter();
        registerMcpAdapter(router, {
            callConnectorTool: async () => ({ content: [{ type: "text", text: "hi" }] }),
        });
        for (const kind of ["chat.phase", "chat.delta", "chat.tool", "chat.done", "chat.failed", "mcp.tool.call"]) {
            expect(router.kinds.has(kind), kind).toBe(true);
        }
    });

    it("adapter answers ask with the connector result; ConnectorError becomes an error-shaped reply (never a throw)", async () => {
        const router = new FabricRouter();
        const calls: unknown[] = [];
        registerMcpAdapter(router, {
            callConnectorTool: async (server, tool, args) => {
                calls.push([server, tool, args]);
                return { content: [{ type: "text", text: "ok" }], structuredContent: { fine: true } };
            },
        });
        const reply = await router.ask("agentgem://self/mcp", "mcp.tool.call", { server: "github", tool: "listCommits", input: { n: 1 } }, { timeoutMs: 1000 });
        expect(calls).toEqual([["github", "listCommits", { n: 1 }]]);
        expect(reply).toEqual({ ok: true, result: { content: [{ type: "text", text: "ok" }], structuredContent: { fine: true } } });
    });

    it("adapter converts a ConnectorError-like failure into { ok:false, code, message }", async () => {
        const router = new FabricRouter();
        class FakeConnectorError extends Error { code = "tool_error"; }
        registerMcpAdapter(router, {
            callConnectorTool: async () => { throw new FakeConnectorError("boom"); },
            isConnectorError: (e): e is Error & { code: string } => e instanceof FakeConnectorError,
        });
        const reply = await router.ask("agentgem://self/mcp", "mcp.tool.call", { server: "github", tool: "x", input: {} }, { timeoutMs: 1000 });
        expect(reply).toEqual({ ok: false, code: "tool_error", message: "boom" });
    });
});
