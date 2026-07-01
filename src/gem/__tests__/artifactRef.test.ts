import { describe, it, expect } from "vitest";
import type { Gem, ReferenceArtifact } from "@agentgem/model";
import { resolveArtifactRef } from "@agentgem/model";
import { writeGemArchive, readGemArchive } from "@agentgem/archive";

const pkgRef: ReferenceArtifact = { type: "reference", name: "ctx7", refKind: "mcp_server", ref: { kind: "package", id: "npx:@modelcontextprotocol/server-context7" } };

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
});
