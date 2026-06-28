// src/transfer/__tests__/service.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportGem } from "../../gem/share.js";
import { InMemoryObjectStore } from "../objectStore.js";
import { sendBytes, receiveTicket, natsStoreFromEnv } from "../service.js";
import type { Gem } from "../../gem/types.js";

// sendBytes signs via loadOrCreateIdentity() (REST/MCP send edge), which writes
// ~/.agentgem. Redirect HOME to a temp dir so the suite never touches the real home.
let prevHome: string | undefined;
let prevUserProfile: string | undefined;
beforeAll(() => {
  prevHome = process.env.HOME;
  prevUserProfile = process.env.USERPROFILE;
  const tmp = mkdtempSync(join(tmpdir(), "agem-home-"));
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
});
afterAll(() => {
  if (prevHome !== undefined) process.env.HOME = prevHome; else delete process.env.HOME;
  if (prevUserProfile !== undefined) process.env.USERPROFILE = prevUserProfile; else delete process.env.USERPROFILE;
});

const demoGem: Gem = {
  name: "github-search",
  createdFrom: "/tmp/.claude",
  checks: [],
  requiredSecrets: [],
  artifacts: [{ type: "skill", name: "search", source: "standalone", content: "# Search\nFind things.\n" }],
};

describe("transfer service", () => {
  it("sendBytes -> receiveTicket round-trips via an injected store factory", async () => {
    const store = new InMemoryObjectStore();
    const make = async () => store;
    const { bytes } = exportGem(demoGem, { version: "1.0.0" });
    const { ticket } = await sendBytes(bytes, make);
    const { gem, meta, provenance } = await receiveTicket(ticket, make);
    expect(gem).toEqual(demoGem);
    expect(meta).toMatchObject({ name: "github-search", version: "1.0.0" });
    // sendBytes signs with the server identity, so the REST/MCP path carries verified provenance.
    expect(provenance).toMatchObject({ signed: true, verified: true });
    expect(provenance.publicKey).toMatch(/^ed25519:/);
  });

  it("closes a managed store after both send and receive", async () => {
    let closes = 0;
    const inner = new InMemoryObjectStore();
    const managed = {
      put: (b: Buffer) => inner.put(b),
      get: (n: string) => inner.get(n),
      del: (n: string) => inner.del(n),
      bucket: "b",
      close: async () => void closes++,
    };
    const make = async () => managed;
    const { bytes } = exportGem(demoGem);
    const { ticket } = await sendBytes(bytes, make);
    expect(closes).toBe(1);
    expect(ticket.startsWith("agentgem://gem/b/")).toBe(true); // store.bucket flows into the ticket
    await receiveTicket(ticket, make);
    expect(closes).toBe(2);
  });

  it("natsStoreFromEnv() throws when NATS_URL is unset (no connection attempted)", async () => {
    const prev = process.env.NATS_URL;
    delete process.env.NATS_URL;
    try {
      await expect(natsStoreFromEnv()()).rejects.toThrow(/NATS_URL|not configured/i);
    } finally {
      if (prev !== undefined) process.env.NATS_URL = prev;
    }
  });

  it("natsStoreFromEnv() fails fast on a non-numeric NATS_TTL_HOURS (before connecting)", async () => {
    const prevUrl = process.env.NATS_URL;
    const prevTtl = process.env.NATS_TTL_HOURS;
    process.env.NATS_URL = "nats://127.0.0.1:4222"; // passes the configured check
    process.env.NATS_TTL_HOURS = "abc"; // typo: must throw, NOT silently disable TTL
    try {
      await expect(natsStoreFromEnv()()).rejects.toThrow(/invalid NATS_TTL_HOURS/i);
    } finally {
      if (prevUrl !== undefined) process.env.NATS_URL = prevUrl; else delete process.env.NATS_URL;
      if (prevTtl !== undefined) process.env.NATS_TTL_HOURS = prevTtl; else delete process.env.NATS_TTL_HOURS;
    }
  });
});
