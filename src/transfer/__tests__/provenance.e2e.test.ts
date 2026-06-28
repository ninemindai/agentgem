// src/transfer/__tests__/provenance.e2e.test.ts
import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportGem } from "../../gem/share.js";
import { loadOrCreateIdentity, type Identity } from "../../gem/identity.js";
import { InMemoryObjectStore } from "../objectStore.js";
import { sendGemBytes, receiveGem } from "../index.js";
import type { Gem } from "../../gem/types.js";

const demoGem: Gem = {
  name: "github-search", createdFrom: "/tmp/.claude", checks: [], requiredSecrets: [],
  artifacts: [{ type: "skill", name: "search", source: "standalone", content: "# Search\n" }],
};
let id: Identity;
beforeAll(() => { id = loadOrCreateIdentity(mkdtempSync(join(tmpdir(), "agem-id-"))); });

describe("transfer provenance", () => {
  it("signed send -> receive verifies and surfaces the producer key", async () => {
    const store = new InMemoryObjectStore();
    const { bytes } = exportGem(demoGem, { version: "1.0.0" });
    const { ticket } = await sendGemBytes(bytes, store, "b", { identity: id });
    const r = await receiveGem(ticket, store);
    expect(r.gem).toEqual(demoGem);
    expect(r.provenance).toEqual({ signed: true, verified: true, publicKey: id.publicKey });
  });

  it("a tampered signature verifies false (still signed)", async () => {
    const store = new InMemoryObjectStore();
    const { bytes } = exportGem(demoGem);
    const { ticket } = await sendGemBytes(bytes, store, "b", { identity: id });
    const [head] = ticket.split("~");
    const tampered = head + "~" + Buffer.from(
      JSON.stringify({ publicKey: id.publicKey, signature: "AAAA" }),
    ).toString("base64url");
    const r = await receiveGem(tampered, store);
    expect(r.provenance.signed).toBe(true);
    expect(r.provenance.verified).toBe(false);
  });

  it("identity:null sends unsigned", async () => {
    const store = new InMemoryObjectStore();
    const { bytes } = exportGem(demoGem);
    const { ticket } = await sendGemBytes(bytes, store, "b", { identity: null });
    expect(ticket).not.toContain("~");
    const r = await receiveGem(ticket, store);
    expect(r.provenance).toEqual({ signed: false, verified: false });
  });
});
