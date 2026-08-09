// src/play/__tests__/mcpServer.test.ts
// A8: the agentgem-play MCP endpoint serves the minted shapes verbatim, lists the
// registry dynamically, and exposes nothing beyond launcher tools + ui:// resources.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { saveMiniapp, readMiniapp, mcpAppFor, uiUri, MCP_APP_MIME, INSPECTOR_META } from "@agentgem/play";
import { buildPlayMcpServer } from "../mcpServer.js";

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "agh-")); process.env.AGENTGEM_HOME = home; });
afterEach(() => { rmSync(home, { recursive: true, force: true }); delete process.env.AGENTGEM_HOME; });

const meta = { title: "T", genre: "project-fun" as const, createdFrom: { kind: "project" as const, path: "/p", flavor: "node" }, engineVersion: "1" };

async function connect() {
  const server = buildPlayMcpServer();
  const client = new Client({ name: "test-host", version: "0.0.0" });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  return client;
}

describe("agentgem-play MCP endpoint", () => {
  it("lists a saved miniapp's launcher tool exactly as minted, plus the inspector", async () => {
    await saveMiniapp({ name: "g1", html: "<!doctype html><body><canvas></canvas></body>", meta });
    const client = await connect();

    const { tools } = await client.listTools();
    const minted = mcpAppFor(readMiniapp("g1")).tool;
    expect(tools.find((t) => t.name === "play_g1")).toEqual(minted);
    expect(tools.some((t) => t.name === `play_${INSPECTOR_META.name}`)).toBe(true);
    // A8 narrowness: launcher tools only — no capability or mutation tools.
    expect(tools.every((t) => t.name.startsWith("play_"))).toBe(true);
  });

  it("reflects the registry at list time, not connect time", async () => {
    const client = await connect();
    expect((await client.listTools()).tools.some((t) => t.name === "play_late")).toBe(false);
    await saveMiniapp({ name: "late", html: "<!doctype html><body><canvas></canvas></body>", meta });
    expect((await client.listTools()).tools.some((t) => t.name === "play_late")).toBe(true);
  });

  it("serves resources/read byte-for-byte as mcpAppFor mints it", async () => {
    await saveMiniapp({ name: "g1", html: "<!doctype html><body><canvas></canvas></body>", meta });
    const client = await connect();

    const { contents } = await client.readResource({ uri: uiUri("g1") });
    expect(contents).toEqual([mcpAppFor(readMiniapp("g1")).resource]);
    expect(contents[0].mimeType).toBe(MCP_APP_MIME);
  });

  it("lists resources without the bundle text, keyed by the minted uri", async () => {
    await saveMiniapp({ name: "g1", html: "<!doctype html><body><canvas></canvas></body>", meta });
    const client = await connect();

    const { resources } = await client.listResources();
    const entry = resources.find((r) => r.uri === uiUri("g1"));
    expect(entry).toBeDefined();
    expect(entry?.mimeType).toBe(MCP_APP_MIME);
    expect(JSON.stringify(entry)).not.toContain("<canvas>");
  });

  it("serves the built-in Protocol Inspector", async () => {
    const client = await connect();
    const { contents } = await client.readResource({ uri: uiUri(INSPECTOR_META.name) });
    expect(contents[0].mimeType).toBe(MCP_APP_MIME);
    expect((contents[0] as { text: string }).text).toContain("<!doctype html>");
  });

  it("answers a launcher call without error", async () => {
    await saveMiniapp({ name: "g1", html: "<!doctype html><body><canvas></canvas></body>", meta });
    const client = await connect();
    const result = await client.callTool({ name: "play_g1", arguments: {} });
    expect(result.isError ?? false).toBe(false);
  });

  it("rejects unknown tools and unknown resources", async () => {
    const client = await connect();
    await expect(client.callTool({ name: "play_nope", arguments: {} })).rejects.toThrow();
    await expect(client.readResource({ uri: uiUri("nope") })).rejects.toThrow();
    await expect(client.readResource({ uri: "file:///etc/passwd" })).rejects.toThrow();
  });
});
