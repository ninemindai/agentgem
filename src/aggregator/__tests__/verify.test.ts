// src/aggregator/__tests__/verify.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyAttestation } from "@agentgem/aggregator";
import { buildAttestation, signAttestation } from "@agentgem/insight";
import { loadOrCreateIdentity } from "@agentgem/model";

const gem = { name: "demo", createdFrom: "claude", artifacts: [
  { type: "mcp_server" as const, name: "gh", transport: "stdio" as const, config: { command: "npx", args: ["@modelcontextprotocol/server-github"] } },
], checks: [], requiredSecrets: [] };
const signal = { root: "/p", flavor: "claude" as const, sessions: { scanned: 4, firstMs: 0, lastMs: 0, spanDays: 1 },
  artifacts: [{ type: "mcp_server" as const, name: "gh", root: null, invocations: 7, sessionsUsedIn: 2, lastUsedMs: 0, confidence: "high" as const }],
  unresolved: [], coOccurrence: [], shapes: [], notes: [], models: [{ id: "claude-opus-4-8", sessions: 4 }] };

function signed() {
  const id = loadOrCreateIdentity(mkdtempSync(join(tmpdir(), "agg-id-")));
  return signAttestation(buildAttestation({ gem, signal, gemDigest: "sha256:aa", salt: "S" }), id, 1);
}

const facet = (outcome: "mostly_achieved" | "partially_achieved" | "not_achieved") =>
  ({ sessionId: "s", transcript: "", atMs: 0, underlying_goal: "", brief_summary: "", outcome, friction_detail: "", model: "claude-opus-4-8", origin: "llm" as const });
function signedV2(facets: ReturnType<typeof facet>[]) {
  const id = loadOrCreateIdentity(mkdtempSync(join(tmpdir(), "agg-id-")));
  return signAttestation(buildAttestation({ gem, signal, gemDigest: "sha256:aa", salt: "S", facets }), id, 1);
}
function resign<T extends { signature: string }>(a: T): T {
  const id = loadOrCreateIdentity(mkdtempSync(join(tmpdir(), "agg-id-")));
  return signAttestation({ ...a, signature: "" } as never, id, 1) as never;
}

describe("verifyAttestation", () => {
  it("accepts a validly signed attestation", () => {
    expect(verifyAttestation(signed())).toEqual({ ok: true });
  });
  it("rejects a tampered signature", () => {
    const a = { ...signed(), signature: "AAAA" };
    expect(verifyAttestation(a)).toEqual({ ok: false, reason: "bad-signature" });
  });
  it("rejects internal inconsistency (ingredient sessions > scan sessions)", () => {
    const a = signed();
    a.ingredients.mcps[0].sessions = a.source.scan.sessions + 1; // mutating breaks the signature too,
    // so re-sign to isolate the consistency check:
    const id = loadOrCreateIdentity(mkdtempSync(join(tmpdir(), "agg-id-")));
    const resigned = signAttestation({ ...a, signature: "" }, id, 1);
    expect(verifyAttestation(resigned)).toEqual({ ok: false, reason: "inconsistent" });
  });

  it("accepts a v2 attestation whose outcome histogram fits the session count", () => {
    expect(verifyAttestation(signedV2([facet("mostly_achieved"), facet("not_achieved")]))).toEqual({ ok: true }); // 2 ≤ 4
  });

  it("rejects a histogram claiming more outcomes than scanned sessions (anti-inflation)", () => {
    const a = signedV2([facet("mostly_achieved")]);
    a.source.outcomeHistogram![0].mostly = a.source.scan.sessions + 5; // inflate beyond the 4 sessions
    expect(verifyAttestation(resign(a))).toEqual({ ok: false, reason: "inconsistent" });
  });
});
