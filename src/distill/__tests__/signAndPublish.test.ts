// src/distill/__tests__/signAndPublish.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { signAndPublishTool, buildAttestationTool } from "../mcpServer.js";

const inventory = { skills: [], mcpServers: [
  { type: "mcp_server" as const, name: "secret", transport: "stdio" as const, config: { command: "node", args: ["/Users/me/private/srv.js"], env: { API_KEY: "sk-deadbeef" } } },
], instructions: [], hooks: [] };
const signal = { root: "/Users/me/work", flavor: "claude" as const, sessions: { scanned: 1, firstMs: 0, lastMs: 0, spanDays: 0 },
  artifacts: [{ type: "mcp_server" as const, name: "secret", root: null, invocations: 1, sessionsUsedIn: 1, lastUsedMs: 0, confidence: "high" as const }],
  unresolved: [], coOccurrence: [], shapes: [], notes: [], models: [] };

describe("signAndPublish + privacy", () => {
  it("signs, returns a verifiable lock digest, and skips ingest when unconfigured", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ag-sp-"));
    const { attestation, gemPreview } = buildAttestationTool({ inventory, signal, selection: { mcpServers: ["secret"] }, salt: "S" });
    const r = await signAndPublishTool({ gem: gemPreview, attestation, identityDir: dir });
    expect(r.signature).toBeTruthy();
    expect(r.ingestId).toBeUndefined(); // no AGENTGEM_INGEST_URL
  });
  it("never leaks secrets, private paths, or home dirs into the attestation (aggregate-only, no tuples/salt)", () => {
    const { attestation } = buildAttestationTool({ inventory, signal, selection: { mcpServers: ["secret"] }, salt: "S" });
    const blob = JSON.stringify(attestation);
    expect(blob).not.toContain("sk-deadbeef");
    expect(blob).not.toContain("/Users/me");
    expect(blob).not.toContain("\"salt\"");
    expect((attestation.evidence as unknown as Record<string, unknown>).tuples).toBeUndefined();
    expect(attestation.ingredients.mcps[0].idKind).toBe("private"); // path-based → salted, not plaintext
    expect(attestation.ingredients.mcps[0].public).toBe(false);
  });
});
