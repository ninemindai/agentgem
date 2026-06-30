// src/transfer/__tests__/mint.test.ts
import { describe, it, expect } from "vitest";
import { createAccount } from "@nats-io/nkeys";
import { decode, parseCreds } from "@nats-io/jwt";
import { mintScopedCreds, scopeSubjects } from "@agentgem/transfer";

// A hermetic account key for signing — no broker involved.
function testAccountSeed(): string {
  return new TextDecoder().decode(createAccount().getSeed());
}

describe("scopeSubjects", () => {
  it("scopes to the bucket subjects and a PER-MINT inbox (not account-wide)", () => {
    const { pub, sub } = scopeSubjects("agentgem-transfer", "receive", "_INBOX.UABC");
    expect(sub).toContain("$O.agentgem-transfer.>");
    expect(sub).toContain("_INBOX.UABC.>");
    expect(sub).not.toContain("_INBOX.>"); // must NOT grant the account-wide inbox
    expect(pub.every((s) => !s.endsWith("$JS.API.>"))).toBe(true);
    expect(pub.some((s) => s.includes("OBJ_agentgem-transfer"))).toBe(true);
  });
});

describe("mintScopedCreds", () => {
  it("mints account-signed creds whose JWT carries the scoped permissions and a ~ttl exp", async () => {
    const accountSeed = testAccountSeed();
    const issuedAt = 1_700_000_000;
    const { creds, expiresAt } = await mintScopedCreds({
      accountSeed, bucket: "agentgem-transfer", scope: "receive", ttlSeconds: 60, issuedAt,
    });

    const parsed = await parseCreds(new TextEncoder().encode(creds));
    expect(parsed).toBeTruthy();

    const jwt = creds.match(/BEGIN NATS USER JWT-+\s*([\s\S]*?)\s*-+END NATS USER JWT/)?.[1]?.trim();
    expect(jwt).toBeTruthy();
    const claims = decode<{ pub?: { allow: string[] }; sub?: { allow: string[] } }>(jwt!);
    expect(claims.exp).toBe(issuedAt + 60);
    expect(expiresAt).toBe(issuedAt + 60);
    expect(claims.nats.sub?.allow).toContain("$O.agentgem-transfer.>");
  });

  it("defaults bucket and ttl, and expiresAt is issuedAt + 60", async () => {
    const issuedAt = 1_700_000_000;
    const { expiresAt } = await mintScopedCreds({ accountSeed: testAccountSeed(), scope: "receive", issuedAt });
    expect(expiresAt).toBe(issuedAt + 60);
  });

  it("scopes the JWT to a per-mint inbox, never the account-wide _INBOX.>", async () => {
    const { creds } = await mintScopedCreds({ accountSeed: testAccountSeed(), scope: "receive" });
    const jwt = creds.match(/BEGIN NATS USER JWT-+\s*([\s\S]*?)\s*-+END NATS USER JWT/)?.[1]?.trim();
    const claims = decode<{ sub?: { allow: string[] } }>(jwt!);
    const subs = claims.nats.sub?.allow ?? [];
    expect(subs).not.toContain("_INBOX.>");
    expect(subs.some((s) => /^_INBOX\.U[A-Z0-9]+\.>$/.test(s))).toBe(true); // per-mint, keyed by user pubkey
  });

  it("rejects a malformed account seed with a clear 400-style error", async () => {
    await expect(mintScopedCreds({ accountSeed: "not-a-seed", scope: "receive" }))
      .rejects.toThrow(/valid account nkey seed/i);
  });
});
