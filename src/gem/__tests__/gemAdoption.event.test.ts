// src/gem/__tests__/gemAdoption.event.test.ts
import { describe, it, expect } from "vitest";
import { buildGemAdoption, signGemAdoption } from "@agentgem/insight";
import { canonicalJSON } from "@agentgem/insight";
import { loadOrCreateIdentity, verify } from "@agentgem/model";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("GemAdoption event", () => {
  const identity = loadOrCreateIdentity(mkdtempSync(join(tmpdir(), "ag-adopt-")));
  it("builds the canonical shape (placeholders empty)", () => {
    const a = buildGemAdoption({ gemKey: "@alice/kit", version: "1.0.0", gemDigest: "sha256:abc" });
    expect(a).toMatchObject({ formatVersion: 1, gemKey: "@alice/kit", version: "1.0.0", gemDigest: "sha256:abc", event: "install", producer: { publicKey: "", account: null }, signature: "" });
  });
  it("signs so verify() accepts, and a tampered field breaks the signature", () => {
    const signed = signGemAdoption(buildGemAdoption({ gemKey: "@alice/kit", version: "1.0.0", gemDigest: "sha256:abc" }), identity, 123);
    expect(signed.producer.publicKey).toMatch(/^ed25519:/);
    const { signature, ...rest } = signed;
    expect(verify(signed.producer.publicKey, canonicalJSON(rest), signature)).toBe(true);
    const tampered = { ...rest, gemKey: "@evil/kit" };
    expect(verify(signed.producer.publicKey, canonicalJSON(tampered), signature)).toBe(false);
  });
});
