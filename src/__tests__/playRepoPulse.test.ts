// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/__tests__/playRepoPulse.test.ts — the built-in Repo Pulse demo is served (list + read) and its
// connector manifest is honored by mcp/call + mcp/servers even though readMiniapp() cannot find it
// (built-ins have no registry entry). Harness mirrors playMcpCall.test.ts.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { __setConnectorReaderForTest, __resetConnectorsForTest } from "@agentgem/play";
import { PlayController } from "@agentgem/app/play.controller";

// Same climb-to-root pattern as playMcpCall.test.ts: this test runs from dist/__tests__/, the fixture
// stays uncompiled in the source tree.
const FIXTURE = fileURLToPath(new URL("../../src/play/__tests__/fixtures/fakeStdioServer.mjs", import.meta.url));
const stdioGem = (name: string, extra = {}) => ({ type: "mcp_server" as const, name, transport: "stdio" as const, config: { command: process.execPath, args: [FIXTURE], ...extra }, source: "user" });

const DECLARED = [{ server: "github", tools: ["list_commits", "list_pull_requests", "search_pull_requests"] }];

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "agh-")); process.env.AGENTGEM_HOME = home; });
afterEach(async () => { await __resetConnectorsForTest(); rmSync(home, { recursive: true, force: true }); delete process.env.AGENTGEM_HOME; });

describe("built-in repo pulse", () => {
  it("is listed with the built-ins even when the registry is empty", async () => {
    const ctrl = new PlayController();
    const r = await ctrl.miniapps();
    const names = r.miniapps.map((m: { name: string }) => m.name);
    expect(names).toContain("__repo-pulse");
  });

  it("read serves the constant with its connector manifest", async () => {
    const ctrl = new PlayController();
    const r = await ctrl.miniapp({ query: { name: "__repo-pulse" } });
    expect(r.html).toContain("REPO PULSE");
    expect(r.meta.mcpNeeds).toEqual(DECLARED);
  });

  it("mcp/call honors the built-in manifest (declared tool brokered)", async () => {
    const ctrl = new PlayController();
    __setConnectorReaderForTest(() => stdioGem("github"));
    const res = await ctrl.mcpCall({
      body: { name: "__repo-pulse", server: "github", tool: "list_commits", input: { owner: "o", repo: "r" } },
    });
    expect(res.ok).toBe(true);
    expect(res.payload).toEqual({ echo: { owner: "o", repo: "r" } });   // fakeStdioServer echoes arguments
  });

  it("mcp/call REJECTS an undeclared tool on the built-in — the security boundary holds", async () => {
    const ctrl = new PlayController();
    __setConnectorReaderForTest(() => stdioGem("github"));
    const res = await ctrl.mcpCall({
      body: { name: "__repo-pulse", server: "github", tool: "create_pull_request", input: {} },
    });
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("not_in_manifest");
  });

  it("mcp/servers resolves the built-in manifest", async () => {
    const ctrl = new PlayController();
    __setConnectorReaderForTest(() => stdioGem("github"));
    const r = await ctrl.mcpServers({ query: { name: "__repo-pulse" } });
    expect(r.servers.map((s: { server: string }) => s.server)).toEqual(["github"]);
    expect(r.servers[0].tools.length).toBeGreaterThan(0);
  });

  it("still 404s for a genuinely unknown name (built-in fallthrough is narrow)", async () => {
    const ctrl = new PlayController();
    await expect(ctrl.mcpCall({ body: { name: "__ghost", server: "github", tool: "list_commits", input: {} } })).rejects.toThrow();
  });
});
