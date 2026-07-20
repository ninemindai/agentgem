// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/__tests__/playMcpCall.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MCP_ERROR_CODES } from "@agentgem/model";
import { __setConnectorReaderForTest, __resetConnectorsForTest } from "@agentgem/play";
import { PlayController } from "@agentgem/app/play.controller";
import { McpErrorCodeEnum } from "@agentgem/app/schemas";

// This test runs from dist/__tests__/playMcpCall.test.js (repo root `tsc -b && vitest run dist/...`);
// climb from there back to the repo root (dist/__tests__ -> dist -> root) and back down into the
// source tree — the same climb-to-root pattern src/play/__tests__/mcpConnectors.test.ts uses to reach
// this same (uncompiled, never-tsc'd) fixture from its own dist location.
const FIXTURE = fileURLToPath(new URL("../../src/play/__tests__/fixtures/fakeStdioServer.mjs", import.meta.url));
console.log("FIXTURE:", FIXTURE);
const stdioGem = (name: string, extra = {}) => ({ type: "mcp_server" as const, name, transport: "stdio" as const, config: { command: process.execPath, args: [FIXTURE], ...extra }, source: "user" });

let home: string;
const meta = { title: "Pulse", genre: "project-fun" as const, createdFrom: { kind: "blank" as const, title: "Pulse" }, engineVersion: "1" };
const mcpHtml = (js: string) => `<!doctype html><body><canvas></canvas><script>if(window.agentgemApp&&window.agentgemApp.mcp){${js}}</script></body>`;

beforeEach(() => { home = mkdtempSync(join(tmpdir(), "agh-")); process.env.AGENTGEM_HOME = home; });
afterEach(async () => { await __resetConnectorsForTest(); rmSync(home, { recursive: true, force: true }); delete process.env.AGENTGEM_HOME; });

describe("wire enum drift", () => {
  it("McpErrorCodeEnum equals MCP_ERROR_CODES", () => {
    expect(McpErrorCodeEnum.options).toEqual([...MCP_ERROR_CODES]);
  });
});

describe("POST /api/play/mcp/call", () => {
  it("brokers a call to a manifest-declared (server, tool) and returns derivePayload output", async () => {
    const ctrl = new PlayController();
    await ctrl.save({ body: { name: "pulse", html: mcpHtml(`window.agentgemApp.mcp.callTool("fake","read_thing")`), meta: { ...meta, mcpNeeds: [{ server: "fake", tools: ["read_thing"] }] } } });
    __setConnectorReaderForTest(() => stdioGem("fake"));
    const res = await ctrl.mcpCall({ body: { name: "pulse", server: "fake", tool: "read_thing", input: { q: 7 } } });
    expect(res.ok).toBe(true);
    expect(res.payload).toEqual({ echo: { q: 7 } });   // derivePayload parsed the text block
  });

  it("REJECTS a (server, tool) outside the saved manifest with not_in_manifest — the security boundary", async () => {
    const ctrl = new PlayController();
    await ctrl.save({ body: { name: "pulse", html: mcpHtml(`window.agentgemApp.mcp.callTool("fake","read_thing")`), meta: { ...meta, mcpNeeds: [{ server: "fake", tools: ["read_thing"] }] } } });
    __setConnectorReaderForTest(() => stdioGem("fake"));
    // write_thing is NOT declared; the route must refuse without ever calling the connector.
    const res = await ctrl.mcpCall({ body: { name: "pulse", server: "fake", tool: "write_thing", input: {} } });
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("not_in_manifest");
  });

  it("rejects an unknown server in the manifest with not_in_manifest even if a gem exists", async () => {
    const ctrl = new PlayController();
    await ctrl.save({ body: { name: "pulse", html: mcpHtml(`window.agentgemApp.mcp.callTool("fake","read_thing")`), meta: { ...meta, mcpNeeds: [{ server: "fake", tools: ["read_thing"] }] } } });
    __setConnectorReaderForTest(() => stdioGem("other"));
    const res = await ctrl.mcpCall({ body: { name: "pulse", server: "other", tool: "read_thing", input: {} } });
    expect(res.error?.code).toBe("not_in_manifest");
  });

  it("surfaces a tool_error from the connector in the body (ok:false)", async () => {
    const ctrl = new PlayController();
    await ctrl.save({ body: { name: "pulse", html: mcpHtml(`window.agentgemApp.mcp.callTool("fake","boom")`), meta: { ...meta, mcpNeeds: [{ server: "fake", tools: ["boom"] }] } } });
    __setConnectorReaderForTest(() => stdioGem("fake"));
    const res = await ctrl.mcpCall({ body: { name: "pulse", server: "fake", tool: "boom", input: {} } });
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("tool_error");
  });

  it("404s for an unknown miniapp name", async () => {
    const ctrl = new PlayController();
    await expect(ctrl.mcpCall({ body: { name: "ghost", server: "fake", tool: "read_thing", input: {} } })).rejects.toThrow();
  });
});

describe("GET /api/play/mcp/servers", () => {
  it("returns the manifest servers intersected with installed gems, tools populated", async () => {
    const ctrl = new PlayController();
    await ctrl.save({ body: { name: "pulse", html: mcpHtml(`window.agentgemApp.mcp.callTool("fake","read_thing")`), meta: { ...meta, mcpNeeds: [{ server: "fake", tools: ["read_thing"] }] } } });
    __setConnectorReaderForTest(() => stdioGem("fake"));
    const res = await ctrl.mcpServers({ query: { name: "pulse" } });
    expect(res.servers.map((s) => s.server)).toEqual(["fake"]);
    expect(res.servers[0].tools.find((t) => t.name === "read_thing")?.annotations?.readOnlyHint).toBe(true);
  });

  it("lists a declared server with an EMPTY tools array when no matching gem is installed", async () => {
    const ctrl = new PlayController();
    await ctrl.save({ body: { name: "pulse", html: mcpHtml(`window.agentgemApp.mcp.callTool("fake","read_thing")`), meta: { ...meta, mcpNeeds: [{ server: "fake", tools: ["read_thing"] }] } } });
    __setConnectorReaderForTest(() => undefined);  // gem not installed
    const res = await ctrl.mcpServers({ query: { name: "pulse" } });
    expect(res.servers).toEqual([{ server: "fake", tools: [] }]);
  });

  it("returns a configDigest for an installed server", async () => {
    const ctrl = new PlayController();
    await ctrl.save({ body: { name: "pulse", html: mcpHtml(`window.agentgemApp.mcp.callTool("fake","read_thing")`), meta: { ...meta, mcpNeeds: [{ server: "fake", tools: ["read_thing"] }] } } });
    __setConnectorReaderForTest(() => stdioGem("fake"));
    const res = await ctrl.mcpServers({ query: { name: "pulse" } });
    expect(res.servers[0].configDigest).toMatch(/^sha256:/);
  });

  it("rejects a call whose expectedConfigDigest no longer matches the live connector", async () => {
    const ctrl = new PlayController();
    await ctrl.save({ body: { name: "pulse", html: mcpHtml(`window.agentgemApp.mcp.callTool("fake","read_thing")`), meta: { ...meta, mcpNeeds: [{ server: "fake", tools: ["read_thing"] }] } } });
    __setConnectorReaderForTest(() => stdioGem("fake"));
    const res = await ctrl.mcpCall({ body: { name: "pulse", server: "fake", tool: "read_thing", input: {}, expectedConfigDigest: "sha256:deadbeef" } });
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("server_config_changed");
  });

  it("reports server_not_connected (not server_config_changed) when the connector isn't installed", async () => {
    const ctrl = new PlayController();
    await ctrl.save({ body: { name: "pulse", html: mcpHtml(`window.agentgemApp.mcp.callTool("fake","read_thing")`), meta: { ...meta, mcpNeeds: [{ server: "fake", tools: ["read_thing"] }] } } });
    __setConnectorReaderForTest(() => undefined); // gem not installed → resolveConnectorDigest is undefined
    const res = await ctrl.mcpCall({ body: { name: "pulse", server: "fake", tool: "read_thing", input: {}, expectedConfigDigest: "sha256:deadbeef" } });
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("server_not_connected");
  });

  it("allows a call whose expectedConfigDigest matches (or is omitted)", async () => {
    const ctrl = new PlayController();
    await ctrl.save({ body: { name: "pulse", html: mcpHtml(`window.agentgemApp.mcp.callTool("fake","read_thing")`), meta: { ...meta, mcpNeeds: [{ server: "fake", tools: ["read_thing"] }] } } });
    __setConnectorReaderForTest(() => stdioGem("fake"));
    const digest = (await ctrl.mcpServers({ query: { name: "pulse" } })).servers[0].configDigest!;
    const res = await ctrl.mcpCall({ body: { name: "pulse", server: "fake", tool: "read_thing", input: { q: 1 }, expectedConfigDigest: digest } });
    expect(res.ok).toBe(true);
    expect(res.payload).toEqual({ echo: { q: 1 } });
  });
});
