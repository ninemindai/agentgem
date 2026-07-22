// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect, vi, afterEach } from "vitest";

// Mock the connector layer so the routes don't touch ~/.claude or spawn a real MCP process.
vi.mock("@agentgem/play", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@agentgem/play")>();
  return {
    ...actual,
    listConnectorCandidates: () => [
      { server: "github", transport: "stdio", needsSecret: false },
      { server: "pg", transport: "http", needsSecret: true },
    ],
    resolveConnectorGem: (s: string) => (s === "github" ? ({ name: "github" } as never) : undefined),
    listConnectorTools: async () => { throw new Error("connect refused"); },
  };
});

import { PlayController } from "../play.controller.js";

afterEach(() => vi.restoreAllMocks());

describe("mcp candidate routes", () => {
  it("lists redacted candidates", async () => {
    const c = new PlayController();
    const r = await c.mcpCandidates();
    expect(r.servers.map((s) => s.server)).toEqual(["github", "pg"]);
    expect(r.servers[1]).toEqual({ server: "pg", transport: "http", needsSecret: true });
  });

  it("degrades candidate-tools to empty on connect failure", async () => {
    const c = new PlayController();
    const r = await c.mcpCandidateTools({ query: { server: "github" } });
    expect(r).toEqual({ tools: [] });
  });

  it("returns empty tools for an unknown server without connecting", async () => {
    const c = new PlayController();
    const r = await c.mcpCandidateTools({ query: { server: "nope" } });
    expect(r).toEqual({ tools: [] });
  });
});
