// src/gem/__tests__/attestation.test.ts
import { describe, it, expect } from "vitest";
import { buildAttestation, signAttestation, canonicalJSON } from "../attestation.js";
import { loadOrCreateIdentity, verify } from "../identity.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const signal = {
  root: "/p", flavor: "claude" as const,
  sessions: { scanned: 3, firstMs: 1000, lastMs: 2000, spanDays: 1 },
  artifacts: [{ type: "mcp_server" as const, name: "gh", root: null, invocations: 7, sessionsUsedIn: 2, lastUsedMs: 2000, confidence: "high" as const }],
  unresolved: [], coOccurrence: [], shapes: [], notes: [],
  models: [{ id: "claude-opus-4-8", sessions: 3 }],
};
const gem = { name: "demo", createdFrom: "claude", artifacts: [
  { type: "mcp_server" as const, name: "gh", transport: "stdio" as const, config: { command: "npx", args: ["@modelcontextprotocol/server-github"] } },
], checks: [], requiredSecrets: [] };

describe("attestation", () => {
  it("builds counted facts deterministically and recomputes from tuples", () => {
    const a1 = buildAttestation({ gem, signal, gemDigest: "sha256:aa", salt: "S" });
    const a2 = buildAttestation({ gem, signal, gemDigest: "sha256:aa", salt: "S" });
    expect(canonicalJSON(a1)).toBe(canonicalJSON(a2)); // deterministic with fixed salt
    const mcp = a1.ingredients.mcps.find((m) => m.id === "npx:@modelcontextprotocol/server-github")!;
    expect(mcp.invocations).toBe(7);
    // recompute: sum of tuple counts for this ingredient equals declared invocations
    const sum = a1.evidence.tuples.filter((t) => t.ingredientId === mcp.id).reduce((n, t) => n + t.count, 0);
    expect(sum).toBe(7);
    expect(a1.source.harness.id).toBe("claude-code");
    expect(a1.source.models).toEqual(["claude-opus-4-8"]);
  });

  it("signs and the signature verifies over the canonical doc", () => {
    const dir = mkdtempSync(join(tmpdir(), "ag-att-"));
    const id = loadOrCreateIdentity(dir);
    const signed = signAttestation(buildAttestation({ gem, signal, gemDigest: "sha256:aa", salt: "S" }), id);
    const { signature, ...rest } = signed;
    expect(verify(signed.producer.publicKey, canonicalJSON(rest), signature)).toBe(true);
  });

  it("never includes raw sequences or prose", () => {
    const a = buildAttestation({ gem, signal, gemDigest: "sha256:aa", salt: "S" });
    expect(JSON.stringify(a)).not.toContain("/p"); // no root path leaked
    expect((a as unknown as Record<string, unknown>).signal).toBeUndefined();
  });
});
