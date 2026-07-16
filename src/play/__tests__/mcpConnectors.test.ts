// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/play/__tests__/mcpConnectors.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { fileURLToPath } from "node:url";
import { listConnectorTools, callConnectorTool, ConnectorError, __resetConnectorsForTest, __setConnectorReaderForTest } from "@agentgem/play";

// The fixture is a real .mjs file, never compiled by tsc, so it lives only under src/. This test
// runs from dist/play/__tests__/mcpConnectors.test.js (see repo root `tsc -b && vitest run dist/...`),
// so climb from there back to the repo root (dist/play/__tests__ -> dist/play -> dist -> root) and
// back down into the source tree — the same pattern src/gem/__tests__/coldBuildWorker.test.ts uses
// to reach the (also uncompiled) scripts/bundle-bins.mjs from its own dist location.
const FIXTURE = fileURLToPath(new URL("../../../src/play/__tests__/fixtures/fakeStdioServer.mjs", import.meta.url));

// A reader that returns a stdio gem pointing at the fixture. Mirrors introspectConfig's
// McpServerArtifact shape: { type, name, transport, config, secretRefs }.
function stdioGem(name: string, extra: Record<string, unknown> = {}) {
  return { type: "mcp_server" as const, name, transport: "stdio" as const, config: { command: process.execPath, args: [FIXTURE], ...extra }, source: "user" };
}

afterEach(() => __resetConnectorsForTest());

describe("connection manager", () => {
  it("lists a gem's tools with annotations", async () => {
    __setConnectorReaderForTest((server) => (server === "fake" ? stdioGem("fake") : undefined));
    const tools = await listConnectorTools("fake");
    expect(tools.map((t) => t.name).sort()).toEqual(["boom", "read_thing", "write_thing"]);
    expect(tools.find((t) => t.name === "read_thing")?.annotations?.readOnlyHint).toBe(true);
  });

  it("calls a tool and returns the raw result content", async () => {
    __setConnectorReaderForTest(() => stdioGem("fake"));
    const r = await callConnectorTool("fake", "read_thing", { q: 1 });
    // derivePayload runs in the ROUTE, not here — the manager returns raw content.
    const text = (r.content[0] as { text: string }).text;
    expect(JSON.parse(text)).toEqual({ echo: { q: 1 } });
  });

  it("single-flights concurrent first calls to a cold gem (one spawn, both resolve)", async () => {
    let spawns = 0;
    __setConnectorReaderForTest(() => { spawns++; return stdioGem("fake", { env: { FAKE_DELAY_MS: "40" } }); });
    const [a, b] = await Promise.all([callConnectorTool("fake", "read_thing", {}), callConnectorTool("fake", "read_thing", {})]);
    expect(JSON.parse((a.content[0] as { text: string }).text)).toEqual({ echo: {} });
    expect(JSON.parse((b.content[0] as { text: string }).text)).toEqual({ echo: {} });
    // The reader is consulted once per connect; a single-flighted connect reads the gem once.
    expect(spawns).toBe(1);
  });

  it("maps an unknown server to a server_not_connected ConnectorError", async () => {
    __setConnectorReaderForTest(() => undefined);
    await expect(callConnectorTool("nope", "read_thing", {})).rejects.toMatchObject({ code: "server_not_connected" });
  });

  it("maps a tool-reported failure to tool_error", async () => {
    __setConnectorReaderForTest(() => stdioGem("fake"));
    await expect(callConnectorTool("fake", "boom", {})).rejects.toMatchObject({ code: "tool_error" });
  });

  it("fast-fails server_not_connected with the missing secret name when a declared secret is absent everywhere", async () => {
    // McpServerArtifact's SecretRef requires `location` (dotted path within config) alongside `name` —
    // the manager only reads `.name`, but the type isn't satisfied without it.
    __setConnectorReaderForTest(() => ({ ...stdioGem("fake"), secretRefs: [{ name: "GITHUB_TOKEN", location: "env.GITHUB_TOKEN" }] }));
    // GITHUB_TOKEN is neither in config.env nor process.env → buildSpawnEnv reports it missing → manager fast-fails.
    const err = await callConnectorTool("fake", "read_thing", {}).catch((e) => e);
    expect(err).toBeInstanceOf(ConnectorError);
    expect(err.code).toBe("server_not_connected");
    expect(err.message).toContain("GITHUB_TOKEN");
  });

  it("times out a hung call as server_unavailable", async () => {
    __setConnectorReaderForTest(() => stdioGem("fake", { env: { FAKE_DELAY_MS: "5000" } }));
    await expect(callConnectorTool("fake", "read_thing", {}, { timeoutMs: 60 })).rejects.toMatchObject({ code: "server_unavailable" });
  }, 10000);

  it("does NOT poison the pool after a failed connect — a retry once the secret is set succeeds", async () => {
    let hasSecret = false;
    __setConnectorReaderForTest(() => hasSecret ? stdioGem("fake") : ({ ...stdioGem("fake"), secretRefs: [{ name: "GITHUB_TOKEN", location: "env.GITHUB_TOKEN" }] }));
    await expect(callConnectorTool("fake", "read_thing", {})).rejects.toMatchObject({ code: "server_not_connected" });
    hasSecret = true;  // secret now available (gem no longer declares it missing)
    const r = await callConnectorTool("fake", "read_thing", { q: 2 });
    expect(JSON.parse((r.content[0] as { text: string }).text)).toEqual({ echo: { q: 2 } });
  });
});
