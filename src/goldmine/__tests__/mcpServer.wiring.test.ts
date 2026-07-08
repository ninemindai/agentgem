// mcpServer.wiring.test.ts
// Verifies that GoldmineTools registers exactly the expected tools.
// No stdio is started — the test configures transports:{stdio:false} to keep
// the process clean. getMcpTools is not a public @agentback/mcp export; we use
// the canonical pattern from the library's own tests: construct an Application,
// mount MCPComponent, start, and call server.listTools().
import { describe, it, expect, afterEach } from "vitest";
import { Application } from "@agentback/core";
import { MCPComponent } from "@agentback/mcp";
import type { MCPServer } from "@agentback/mcp";
import { GoldmineTools } from "../mcpServer.js";

describe("GoldmineTools wiring", () => {
  let app: Application;

  afterEach(async () => {
    try { await app.stop(); } catch { /* already stopped or never started */ }
  });

  it("registers search_sessions, summarize_session, ask_session, get_artifact_detail, get_behavior_findings, and search_session_content", async () => {
    app = new Application();
    app.component(MCPComponent);
    app.configure("servers.MCPServer").to({
      name: "agentgem-goldmine-test",
      version: "0.0.0",
      transports: { stdio: false },
    });
    app.service(GoldmineTools);
    await app.start();

    const server = await app.get<MCPServer>("servers.MCPServer");
    const names = server.listTools().map((t) => t.meta.name).sort();
    expect(names).toEqual(["ask_session", "get_artifact_detail", "get_behavior_findings", "search_session_content", "search_sessions", "summarize_session"]);
  });
});
