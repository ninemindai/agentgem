// Outward-interop conformance guard for the MCP Apps producer shape.
// Shape verified renderable in @mcp-ui/client v7.1.1 (reference MCP-UI host, @modelcontextprotocol/ext-apps)
// via live dogfood on 2026-07-08 — screenshots showed a self-contained miniapp rendering in the reference
// double-iframe sandbox with no compat tweaks.
import { describe, it, expect } from "vitest";
import { mcpAppFor, mcpResourceFor, mcpToolFor, MCP_APP_MIME } from "@agentgem/play";

describe("mcpApp.conformance", () => {
  it("mcpResourceFor emits MCP Apps 2026-01-26 MVP contract: mimeType, uri scheme, _meta.ui.csp keys, reverse-DNS extension", () => {
    // Build a self-contained miniapp (no needs).
    const html = "<!doctype html><html><body><h1>Conf</h1></body></html>";
    const app = {
      name: "conf",
      html,
      meta: {
        title: "Conf",
        genre: "project-fun" as const,
        createdFrom: { kind: "blank" as const, title: "Conf" } as const,
        engineVersion: "1",
      },
    };

    const resource = mcpResourceFor(app);

    // Contract: mimeType === MCP_APP_MIME
    expect(resource.mimeType).toBe(MCP_APP_MIME);
    expect(resource.mimeType).toBe("text/html;profile=mcp-app");

    // Contract: uri matches ui:// scheme
    expect(resource.uri).toMatch(/^ui:\/\//);
    expect(resource.uri).toBe("ui://agentgem/conf");

    // Contract: text is the html verbatim
    expect(resource.text).toBe(html);

    // Contract: _meta.ui.csp has EXACTLY these four keys (the McpUiResourceCsp shape ext-apps consumes).
    const cspKeys = Object.keys(resource._meta.ui.csp).sort();
    expect(cspKeys).toEqual([
      "baseUriDomains",
      "connectDomains",
      "frameDomains",
      "resourceDomains",
    ]);

    // Contract: each CSP key is an array.
    expect(Array.isArray(resource._meta.ui.csp.connectDomains)).toBe(true);
    expect(Array.isArray(resource._meta.ui.csp.resourceDomains)).toBe(true);
    expect(Array.isArray(resource._meta.ui.csp.frameDomains)).toBe(true);
    expect(Array.isArray(resource._meta.ui.csp.baseUriDomains)).toBe(true);

    // Contract: sealed csp (all empty, no network).
    expect(resource._meta.ui.csp.connectDomains.length).toBe(0);
    expect(resource._meta.ui.csp.resourceDomains.length).toBe(0);
    expect(resource._meta.ui.csp.frameDomains.length).toBe(0);
    expect(resource._meta.ui.csp.baseUriDomains.length).toBe(0);

    // Contract: _meta.ui.permissions is an object.
    expect(typeof resource._meta.ui.permissions).toBe("object");
    expect(Array.isArray(resource._meta.ui.permissions)).toBe(false);

    // Contract: reverse-DNS namespaced extension key exists.
    expect(resource._meta).toHaveProperty("ai.agentgem/game");
    const gameMeta = resource._meta["ai.agentgem/game"];
    expect(gameMeta.genre).toBe("project-fun");
    expect(gameMeta.engineVersion).toBe("1");
    expect(gameMeta.createdFrom.kind).toBe("blank");
    expect(gameMeta.offline).toBe(true); // no needs, so offline

    // Contract hygiene: no reserved io.agentgem/game key (AgentGem namespace is ai., not io.).
    expect(resource._meta).not.toHaveProperty("io.agentgem/game");

    // Contract hygiene: producer extensions do NOT use the reserved 'ui' key for app data.
    expect(resource._meta.ui).not.toHaveProperty("game");
    expect(resource._meta.ui).not.toHaveProperty("genre");
  });

  it("mcpToolFor emits the launcher tool with resourceUri and visibility", () => {
    const app = {
      name: "conf",
      meta: {
        title: "Conf",
        genre: "project-fun" as const,
        createdFrom: { kind: "blank" as const, title: "Conf" } as const,
        engineVersion: "1",
      },
    };

    const tool = mcpToolFor(app);

    // Tool shape.
    expect(tool.name).toBe("play_conf");
    expect(tool.description).toBe('Launch the "Conf" miniapp');
    expect(tool.inputSchema).toEqual({ type: "object", properties: {} });

    // Contract: _meta.ui.resourceUri is present and matches ui:// scheme.
    expect(tool._meta.ui.resourceUri).toBe("ui://agentgem/conf");
    expect(tool._meta.ui.resourceUri).toMatch(/^ui:\/\//);

    // Contract: visibility is a subset of ["model", "app"].
    expect(Array.isArray(tool._meta.ui.visibility)).toBe(true);
    expect(tool._meta.ui.visibility.every((v) => ["model", "app"].includes(v))).toBe(true);
    expect(tool._meta.ui.visibility).toEqual(["app"]);
  });

  it("mcpAppFor returns { resource, tool } pair with matching uri and resourceUri", () => {
    const html = "<!doctype html><html><body>Test</body></html>";
    const app = {
      name: "testapp",
      html,
      meta: {
        title: "Test App",
        genre: "replay" as const,
        createdFrom: { kind: "blank" as const, title: "Test App" } as const,
        engineVersion: "1",
      },
    };

    const mcpApp = mcpAppFor(app);

    // Both resource and tool present.
    expect(mcpApp.resource).toBeDefined();
    expect(mcpApp.tool).toBeDefined();

    // Contract: tool._meta.ui.resourceUri === resource.uri
    expect(mcpApp.tool._meta.ui.resourceUri).toBe(mcpApp.resource.uri);
  });

  it("contract: offline flag reflects presence of needs", () => {
    // With needs: offline = false.
    const appWithNeeds = {
      name: "interactive",
      html: "<!doctype html><html><body>Interactive</body></html>",
      meta: {
        title: "Interactive",
        genre: "project-fun" as const,
        createdFrom: { kind: "blank" as const, title: "Interactive" } as const,
        engineVersion: "1",
        needs: ["session-data"] as const,
      },
    };

    const resourceWithNeeds = mcpResourceFor(appWithNeeds as any);
    expect(resourceWithNeeds._meta["ai.agentgem/game"].offline).toBe(false);
    expect(resourceWithNeeds._meta["ai.agentgem/game"].needs).toEqual(["session-data"]);

    // Without needs: offline = true (and needs is not present in the object).
    const appWithoutNeeds = {
      name: "sealed",
      html: "<!doctype html><html><body>Sealed</body></html>",
      meta: {
        title: "Sealed",
        genre: "replay" as const,
        createdFrom: { kind: "blank" as const, title: "Sealed" } as const,
        engineVersion: "1",
      },
    };

    const resourceWithoutNeeds = mcpResourceFor(appWithoutNeeds);
    expect(resourceWithoutNeeds._meta["ai.agentgem/game"].offline).toBe(true);
    expect(resourceWithoutNeeds._meta["ai.agentgem/game"]).not.toHaveProperty("needs");
  });
});
