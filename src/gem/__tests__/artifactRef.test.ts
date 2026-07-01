import { describe, it, expect } from "vitest";
import type { Gem, McpServerArtifact, ReferenceArtifact } from "@agentgem/model";
import { materialize, resolveArtifactRef } from "@agentgem/model";
import { writeGemArchive, readGemArchive } from "@agentgem/archive";

const pkgRef: ReferenceArtifact = { type: "reference", name: "ctx7", refKind: "mcp_server", ref: { kind: "package", id: "npx:@modelcontextprotocol/server-context7" } };
const otherPkgRef: ReferenceArtifact = { type: "reference", name: "fs", refKind: "mcp_server", ref: { kind: "package", id: "npx:@modelcontextprotocol/server-filesystem" } };
const playwright: McpServerArtifact = { type: "mcp_server", name: "playwright", transport: "stdio", config: { command: "npx", args: ["@playwright/mcp"] } };

describe("by-reference artifacts", () => {
  it("round-trips through the archive and is covered by the digest", () => {
    const gem: Gem = { name: "g", createdFrom: "t", artifacts: [pkgRef], checks: [], requiredSecrets: [] };
    const { files } = writeGemArchive(gem);
    const back = readGemArchive(files);
    expect(back.artifacts[0]).toEqual(pkgRef);
  });
  it("digest changes if the pinned ref id changes (tamper-evident)", () => {
    const d = (r: ReferenceArtifact) => JSON.parse(writeGemArchive({ name: "g", createdFrom: "t", artifacts: [r], checks: [], requiredSecrets: [] }).files["gem.lock"]).gemDigest;
    expect(d(pkgRef)).not.toBe(d({ ...pkgRef, ref: { ...pkgRef.ref, id: "npx:@evil/pkg" } }));
  });
  it("resolves a package MCP reference into a runnable McpServerArtifact", () => {
    const r = resolveArtifactRef(pkgRef);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.artifact).toMatchObject({ type: "mcp_server", transport: "stdio" });
  });
  it("reports gem references as unresolved (resolution is a follow-on)", () => {
    const r = resolveArtifactRef({ type: "reference", name: "dep", refKind: "skill", ref: { kind: "gem", id: "sha256:abc" } });
    expect(r).toEqual({ ok: false, reason: "gem reference resolution is not implemented yet" });
  });

  it("materialize: a real mcp_server AND a package reference both land in claude's .mcp.json, neither skipped", () => {
    const gem: Gem = { name: "g", createdFrom: "t", artifacts: [playwright, pkgRef], checks: [], requiredSecrets: [] };
    const r = materialize(gem, "claude");
    const servers = JSON.parse(r.files[".mcp.json"]).mcpServers;
    expect(Object.keys(servers)).toEqual(expect.arrayContaining(["playwright", "ctx7"]));
    expect(r.skipped).toEqual([]);
  });

  it("materialize: two package references alone both land in claude's .mcp.json", () => {
    const gem: Gem = { name: "g", createdFrom: "t", artifacts: [pkgRef, otherPkgRef], checks: [], requiredSecrets: [] };
    const r = materialize(gem, "claude");
    const servers = JSON.parse(r.files[".mcp.json"]).mcpServers;
    expect(Object.keys(servers)).toEqual(expect.arrayContaining(["ctx7", "fs"]));
    expect(r.skipped).toEqual([]);
  });

  it("resolveArtifactRef degrades instead of throwing on malformed input", () => {
    expect(() => resolveArtifactRef(undefined as unknown as ReferenceArtifact)).not.toThrow();
    expect(resolveArtifactRef(undefined as unknown as ReferenceArtifact)).toMatchObject({ ok: false });

    const missingRef = { type: "reference", name: "x", refKind: "skill" } as unknown as ReferenceArtifact;
    expect(() => resolveArtifactRef(missingRef)).not.toThrow();
    expect(resolveArtifactRef(missingRef)).toMatchObject({ ok: false });

    const missingId = { type: "reference", name: "x", refKind: "mcp_server", ref: { kind: "package" } } as unknown as ReferenceArtifact;
    expect(() => resolveArtifactRef(missingId)).not.toThrow();
    expect(resolveArtifactRef(missingId)).toMatchObject({ ok: false });
  });
});
