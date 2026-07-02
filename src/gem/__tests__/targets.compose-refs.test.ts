// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Compose targets (eve/flue/sandbox/agentcore) re-derive their MCP wiring straight from
// gem.artifacts, which never includes ReferenceArtifacts — before this fix, a package ref that
// resolved fine (see resolveArtifactRef) vanished on openai-sandbox/agentcore with NO skipped
// entry at all (materialize()'s outer-loop no-op `mcp` field for those two targets swallowed it).
// This asserts the ref is now accounted for EXACTLY ONCE per target: either rendered (0 skips,
// eve/flue's real `mcp` renderers already handled this correctly) or reported skipped (1 skip,
// the sandbox/agentcore fix) — never silently dropped (0 skips + not rendered) and never
// double-counted (2+ skips for the same artifact).
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

  it("openai-sandbox: compose doesn't wire refs (follow-up); now reported skipped exactly once instead of silently dropped", () => {
    const { skipped } = materialize(gemWithPackageRef, "openai-sandbox");
    expect(refSkips(skipped)).toHaveLength(1);
  });

  it("agentcore: compose doesn't wire refs (follow-up); now reported skipped exactly once instead of silently dropped", () => {
    const { skipped } = materialize(gemWithPackageRef, "agentcore");
    expect(refSkips(skipped)).toHaveLength(1);
  });
});

// a2a is deliberately NOT touched by this fix (it owns its own skip reporting per the ticket).
// Note: a2a's card-only mode has the same silent-drop shape for a resolved package ref (0 skips,
// not rendered) — out of scope here; left for a2a's own follow-up.
