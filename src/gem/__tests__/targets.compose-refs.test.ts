// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Compose targets (eve/flue/sandbox/agentcore) re-derive their MCP wiring straight from
// gem.artifacts, which never includes ReferenceArtifacts — before this fix, a package ref that
// resolved fine (see resolveArtifactRef) vanished on openai-sandbox/agentcore with NO skipped
// entry at all (materialize()'s outer-loop no-op `mcp` field for those two targets swallowed it).
// This asserts the ref is now accounted for EXACTLY ONCE per target: either rendered into files
// (0 skips — eve/flue's real `mcp` renderers already handled this correctly, and sandbox now wires
// resolved refs the same way) or reported skipped (1 skip — eve and agentcore, both HTTP/SSE-only
// integrations that cannot express the stdio shape a package ref resolves to) — never silently
// dropped (0 skips + not rendered) and never double-counted (2+ skips for the same artifact).
import { describe, it, expect } from "vitest";
import { materialize } from "@agentgem/model";
import type { Gem } from "@agentgem/model";

// A "package" ref always resolves to a stdio mcp_server: { command: "npx", args: [pkg] }.
const gemWithPackageRef: Gem = { name: "p", createdFrom: "t", checks: [], requiredSecrets: [], artifacts: [
  { type: "reference", name: "context7", refKind: "mcp_server", ref: { kind: "package", id: "npx:@modelcontextprotocol/server-context7" } },
] };

const refSkips = (skipped: { artifact: string }[]) => skipped.filter((s) => s.artifact === "context7");

describe("compose targets: resolved package ReferenceArtifact is never silently dropped, never double-counted", () => {
  it("eve: stdio-only ref is unsupported (eve connections are HTTP/SSE-only) -> mcpEveConnections already skips it exactly once", () => {
    const { skipped } = materialize(gemWithPackageRef, "eve");
    expect(refSkips(skipped)).toHaveLength(1);
  });

  it("flue: stdio ref IS renderable via the proxy bridge -> rendered, not skipped", () => {
    const { files, skipped } = materialize(gemWithPackageRef, "flue");
    expect(refSkips(skipped)).toHaveLength(0);
    expect(Object.keys(files).some((p) => p.startsWith("src/connections/"))).toBe(true);
    expect(Object.keys(files).some((p) => p.startsWith("src/proxies/"))).toBe(true);
  });

  it("openai-sandbox: resolved ref is wired into the agent file via native MCPServerStdio, not skipped", () => {
    const { files, skipped } = materialize(gemWithPackageRef, "openai-sandbox");
    expect(refSkips(skipped)).toHaveLength(0);
    const agentFile = files["p.agent.ts"];
    expect(agentFile).toContain("MCPServerStdio");
    expect(agentFile).toContain("@modelcontextprotocol/server-context7");
  });

  it("agentcore: resolved ref is fed through the same agentcoreMcpTools path as a value server; a stdio " +
      "resolution still can't be expressed by AgentCore's HTTP/SSE-only remote_mcp tool, so it is reported " +
      "skipped exactly once (via the ordinary MCP-shape-unsupported reason, not a blanket reference skip)", () => {
    const { skipped } = materialize(gemWithPackageRef, "agentcore");
    expect(refSkips(skipped)).toHaveLength(1);
  });
});

// a2a is deliberately NOT touched by this fix (it owns its own skip reporting per the ticket).
// Note: a2a's card-only mode has the same silent-drop shape for a resolved package ref (0 skips,
// not rendered) — out of scope here; left for a2a's own follow-up.
