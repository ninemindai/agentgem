// src/play/__tests__/miniappsMcp.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveMiniapp, readMiniapp } from "@agentgem/play";
import { workspaceDir } from "@agentgem/base";
import { readGemArchive, readArchiveDir } from "@agentgem/archive";

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "agh-")); process.env.AGENTGEM_HOME = home; });
afterEach(() => { rmSync(home, { recursive: true, force: true }); delete process.env.AGENTGEM_HOME; });

const meta = { title: "Pulse", genre: "project-fun" as const, createdFrom: { kind: "blank" as const, title: "Pulse" }, engineVersion: "1" };

// References window.agentgemApp so ensureClientShim injects transport; a <canvas> for the gate.
//
// The connector calls are gated on `window.agentgemApp.mcp` — NOT yet defined by the shipped client
// shim (mcpAppClient.ts only exposes callTool/openLink/etc so far; `agentgemApp.mcp` is a later PR's
// wire-up). Gating the call keeps gameGate's jsdom load-smoke from executing a TypeError on
// `.mcp.callTool(...)` of undefined — the literal/dynamic call text is still physically present in
// the script body for capabilityScan's static regexes to find, which is all these tests exercise.
const mcpHtml = (js: string) =>
  `<!doctype html><html><body><canvas></canvas><script>if (window.agentgemApp && window.agentgemApp.mcp) { ${js} }</script></body></html>`;

describe("saveMiniapp with mcpNeeds", () => {
  it("auto-fills literal connector calls into the stored manifest", async () => {
    const html = mcpHtml(`window.agentgemApp.mcp.callTool("github", "list_pull_requests");`);
    const res = await saveMiniapp({ name: "pulse", html, meta });
    expect(res.mcpWarnings).toEqual([]);
    expect(readMiniapp("pulse").meta.mcpNeeds).toEqual([{ server: "github", tools: ["list_pull_requests"] }]);
  });

  it("NEVER prunes a declaration the scan cannot see (wrapper calls) — warns instead (D10)", async () => {
    // A wrapper function whose body holds a non-literal (server, tool) pair. Never invoked at runtime
    // (`pick` doesn't exist) — only the static shape matters: the dynamic-call warning is a scan-time
    // signal, not proof the call ever fires.
    const html = mcpHtml(`function call(s, t) { window.agentgemApp.mcp.callTool(s, t); }`);
    const declared = [{ server: "github", tools: ["list_pull_requests", "list_commits"] }];
    const res = await saveMiniapp({ name: "wrapped", html, meta: { ...meta, mcpNeeds: declared } });
    expect(res.mcpWarnings).toHaveLength(1);
    expect(res.mcpWarnings[0]).toContain("non-literal");
    // mergeMcpNeeds (Task 3) always emits sorted tool lists — nothing pruned, just normalized order.
    expect(readMiniapp("wrapped").meta.mcpNeeds).toEqual([{ server: "github", tools: ["list_commits", "list_pull_requests"] }]);
  });

  it("unions declared and derived", async () => {
    const html = mcpHtml(`window.agentgemApp.mcp.callTool("github", "list_commits");`);
    const res = await saveMiniapp({
      name: "union", html,
      meta: { ...meta, mcpNeeds: [{ server: "github", tools: ["search_pull_requests"] }] },
    });
    expect(res.mcpWarnings).toEqual([]);
    expect(readMiniapp("union").meta.mcpNeeds).toEqual([{ server: "github", tools: ["list_commits", "search_pull_requests"] }]);
  });

  it("carries mcpNeeds into the dual-written game gem", async () => {
    const html = mcpHtml(`window.agentgemApp.mcp.callTool("github", "list_commits");`);
    await saveMiniapp({ name: "gemmed", html, meta });
    // gem.json's artifact entries carry a stringified `metadata` field, not top-level game props (the
    // same reason miniapps.test.ts's needs-carry assertions go through the archive reader rather than a
    // raw JSON.parse) — so read the archive the way every other gem consumer does.
    const gem = readGemArchive(readArchiveDir(workspaceDir("gemmed")));
    expect((gem.artifacts[0] as { mcpNeeds?: unknown }).mcpNeeds).toEqual([{ server: "github", tools: ["list_commits"] }]);
  });

  it("rejects mcpNeeds on a bundle that never references window.agentgemApp (cannot reach the host)", async () => {
    const html = `<!doctype html><html><body><canvas></canvas><script>const x = 1;</script></body></html>`;
    await expect(saveMiniapp({ name: "mute", html, meta: { ...meta, mcpNeeds: [{ server: "github", tools: ["list_commits"] }] } }))
      .rejects.toThrow(/cannot reach the host/);
  });

  it("CRITICAL regression: a plain miniapp with no mcp usage behaves exactly as before", async () => {
    const html = `<!doctype html><html><body><canvas></canvas><script>window.agentgemApp && window.agentgemApp.callTool("agentgem_get_inventory");</script></body></html>`;
    const res = await saveMiniapp({ name: "plain", html, meta: { ...meta, needs: ["local-project-access"] } });
    expect(res.prunedNeeds).toEqual([]);
    expect(res.mcpWarnings).toEqual([]);
    const read = readMiniapp("plain");
    expect(read.meta.needs).toEqual(["local-project-access"]);
    expect(read.meta.mcpNeeds).toBeUndefined();
  });
});
