// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
//  Increment-2 proof: the MCP tool call rides router.ask() — fabric errors map back
//  onto the existing MCP error-code contract, application errors ride the reply.
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FabricRouter, FabricRouterError } from "@agentgem/fabric";
import { mapAskFailure, registerMcpAdapter } from "../fabric.binding.js";
import { PlayController } from "../play.controller.js";

describe("ask-failure → MCP error-code mapping", () => {
    it("fabric timeout → server_unavailable (matches callConnectorTool's own timeout contract)", () => {
        expect(mapAskFailure(new FabricRouterError("timeout", "t"))).toEqual({ code: "server_unavailable", message: "t" });
    });
    it("fabric transport → upstream_error", () => {
        expect(mapAskFailure(new FabricRouterError("transport", "x"))).toEqual({ code: "upstream_error", message: "x" });
    });
    it("non-fabric throw → upstream_error", () => {
        expect(mapAskFailure(new Error("y"))).toEqual({ code: "upstream_error", message: "y" });
    });
});

// Integration case: reusable because PlayController's constructor takes the router as a plain,
// optional positional arg (mirrors InsightsController's own test-construction pattern) — no
// buildCommonApp/DI container needed to exercise the wired route through router.ask().
describe("mcpCall rides the router when one is bound", () => {
    let home: string;
    beforeEach(() => { home = mkdtempSync(join(tmpdir(), "agh-")); process.env.AGENTGEM_HOME = home; });
    afterEach(() => { rmSync(home, { recursive: true, force: true }); delete process.env.AGENTGEM_HOME; });

    const meta = { title: "Pulse", genre: "project-fun" as const, createdFrom: { kind: "blank" as const, title: "Pulse" }, engineVersion: "1" };
    const mcpHtml = (js: string) => `<!doctype html><body><canvas></canvas><script>if(window.agentgemApp&&window.agentgemApp.mcp){${js}}</script></body>`;

    it("a manifest-declared call flows through router.ask() -> registerMcpAdapter -> the reply shape", async () => {
        const router = new FabricRouter();
        const calls: unknown[] = [];
        registerMcpAdapter(router, {
            callConnectorTool: async (server, tool, input) => {
                calls.push([server, tool, input]);
                return { content: [{ type: "text", text: "ok" }], structuredContent: { echoed: input } };
            },
        });
        expect(router.kinds.has("mcp.tool.call")).toBe(true);

        const ctrl = new PlayController(router);
        await ctrl.save({ body: { name: "pulse", html: mcpHtml(`window.agentgemApp.mcp.callTool("fake","read_thing")`), meta: { ...meta, mcpNeeds: [{ server: "fake", tools: ["read_thing"] }] } } });
        const res = await ctrl.mcpCall({ body: { name: "pulse", server: "fake", tool: "read_thing", input: { q: 1 } } });

        expect(calls).toEqual([["fake", "read_thing", { q: 1 }]]);
        expect(res).toEqual({ ok: true, payload: { echoed: { q: 1 } }, content: [{ type: "text", text: "ok" }] });
    });

    // Regression: MCP connector server names come from user config with no slug constraint
    // ("browser_use" is legal there) but fabric addresses forbid underscores — an address built
    // as `agentgem://self/mcp/${server}` would throw `malformed fabric address` on this name. The
    // server now rides the ask() payload instead, so a non-slug name must still flow end to end.
    it("a manifest-declared server with a non-slug name (browser_use) still flows through the fabric ask() path", async () => {
        const router = new FabricRouter();
        const calls: unknown[] = [];
        registerMcpAdapter(router, {
            callConnectorTool: async (server, tool, input) => {
                calls.push([server, tool, input]);
                return { content: [{ type: "text", text: "ok" }], structuredContent: { echoed: input } };
            },
        });
        const ctrl = new PlayController(router);
        await ctrl.save({ body: { name: "pulse", html: mcpHtml(`window.agentgemApp.mcp.callTool("browser_use","read_thing")`), meta: { ...meta, mcpNeeds: [{ server: "browser_use", tools: ["read_thing"] }] } } });
        const res = await ctrl.mcpCall({ body: { name: "pulse", server: "browser_use", tool: "read_thing", input: { q: 1 } } });

        expect(calls).toEqual([["browser_use", "read_thing", { q: 1 }]]);
        expect(res).toEqual({ ok: true, payload: { echoed: { q: 1 } }, content: [{ type: "text", text: "ok" }] });
    });

    it("still refuses a (server, tool) outside the saved manifest WITHOUT ever asking the router", async () => {
        const router = new FabricRouter();
        registerMcpAdapter(router, { callConnectorTool: async () => { throw new Error("must not be called"); } });
        const ctrl = new PlayController(router);
        await ctrl.save({ body: { name: "pulse", html: mcpHtml(`window.agentgemApp.mcp.callTool("fake","read_thing")`), meta: { ...meta, mcpNeeds: [{ server: "fake", tools: ["read_thing"] }] } } });
        const res = await ctrl.mcpCall({ body: { name: "pulse", server: "fake", tool: "write_thing", input: {} } });
        expect(res.ok).toBe(false);
        expect(res.error?.code).toBe("not_in_manifest");
    });

    it("an application-level connector error rides the reply as ok:false, not a thrown fabric error", async () => {
        const router = new FabricRouter();
        class FakeConnectorError extends Error { code = "tool_error"; }
        registerMcpAdapter(router, {
            callConnectorTool: async () => { throw new FakeConnectorError("boom"); },
            isConnectorError: (e): e is Error & { code: string } => e instanceof FakeConnectorError,
        });
        const ctrl = new PlayController(router);
        await ctrl.save({ body: { name: "pulse", html: mcpHtml(`window.agentgemApp.mcp.callTool("fake","boom")`), meta: { ...meta, mcpNeeds: [{ server: "fake", tools: ["boom"] }] } } });
        const res = await ctrl.mcpCall({ body: { name: "pulse", server: "fake", tool: "boom", input: {} } });
        expect(res).toEqual({ ok: false, error: { code: "tool_error", message: "boom" } });
    });
});
