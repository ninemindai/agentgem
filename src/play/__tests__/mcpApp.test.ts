// src/play/__tests__/mcpApp.test.ts
import { describe, it, expect } from "vitest";
import { mcpAppFor, mcpResourceFor, uiUri, MCP_APP_MIME } from "@agentgem/play";
import type { MiniappMeta } from "@agentgem/play";

const offlineMeta: MiniappMeta = {
  title: "The Great Auth Bug Hunt", genre: "project-fun",
  createdFrom: { kind: "project", path: "/p", flavor: "node" }, engineVersion: "3",
};
const dataMeta: MiniappMeta = {
  title: "Replay Duel", genre: "replay",
  createdFrom: { kind: "session", agent: "claude", sessionId: "s1", summary: "x" },
  engineVersion: "3", needs: ["session-data"],
};

describe("mcpResourceFor", () => {
  it("mints a spec-shaped ui:// resource carrying the html verbatim", () => {
    const r = mcpResourceFor({ name: "auth-hunt", html: "<!doctype html><body>hi</body>", meta: offlineMeta });
    expect(r.uri).toBe(uiUri("auth-hunt"));
    expect(r.uri).toBe("ui://agentgem/auth-hunt");
    expect(r.mimeType).toBe(MCP_APP_MIME);
    expect(r.text).toBe("<!doctype html><body>hi</body>");
    expect(r._meta["io.agentgem/game"]).toMatchObject({ genre: "project-fun", engineVersion: "3", offline: true });
    expect(r._meta["io.agentgem/game"].needs).toBeUndefined();
  });

  it("stays fully sealed (empty CSP) even when the miniapp declares a capability", () => {
    const r = mcpResourceFor({ name: "replay", html: "<body></body>", meta: dataMeta });
    expect(r._meta.ui.csp).toEqual({ connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [] });
    expect(r._meta.ui.permissions).toEqual({});
    expect(r._meta["io.agentgem/game"].offline).toBe(false);
    expect(r._meta["io.agentgem/game"].needs).toEqual(["session-data"]);
  });
});

describe("mcpAppFor", () => {
  it("mints an app-visibility launcher tool bound to the resource uri", () => {
    const { tool, resource } = mcpAppFor({ name: "replay", html: "<body></body>", meta: dataMeta });
    expect(tool.name).toBe("play_replay");
    expect(tool.description).toContain("Replay Duel");
    expect(tool._meta.ui.resourceUri).toBe(resource.uri);
    expect(tool._meta.ui.visibility).toEqual(["app"]);
    expect(tool.inputSchema).toEqual({ type: "object", properties: {} });
  });
});
