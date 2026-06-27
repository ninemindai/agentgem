// src/gem/__tests__/attestationArchive.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeAttestedArchive } from "../attestationArchive.js";
import { buildAttestation } from "../attestation.js";
import { loadOrCreateIdentity, verify } from "../identity.js";

const gem = { name: "demo", createdFrom: "claude", artifacts: [
  { type: "skill" as const, name: "qa", source: "@acme/qa", content: "BODY" },
], checks: [], requiredSecrets: [] };
const signal = { root: "/p", flavor: "claude" as const, sessions: { scanned: 1, firstMs: 0, lastMs: 0, spanDays: 0 },
  artifacts: [{ type: "skill" as const, name: "qa", root: null, invocations: 2, sessionsUsedIn: 1, lastUsedMs: 0, confidence: "high" as const }],
  unresolved: [], coOccurrence: [], shapes: [], notes: [], models: [] };

describe("writeAttestedArchive", () => {
  it("embeds attestation.json and signs the lock digest", () => {
    const dir = mkdtempSync(join(tmpdir(), "ag-arch-"));
    const id = loadOrCreateIdentity(dir);
    const att = buildAttestation({ gem, signal, gemDigest: "sha256:placeholder", salt: "S" });
    const { files } = writeAttestedArchive(gem, att, id);
    expect(files["attestation.json"]).toBeDefined();
    const lock = JSON.parse(files["gem.lock"]) as { gemDigest: string; signature: string | null; files: Record<string, string> };
    expect(lock.signature).not.toBeNull();
    expect(verify(id.publicKey, lock.gemDigest, lock.signature!)).toBe(true);
    expect(lock.files["attestation.json"]).toBeDefined();
    expect(lock.files["gem.lock"]).toBeUndefined(); // a lock never hashes itself
  });
});
