// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { makeTestDb } from "@agentgem/aggregator";
import { generateSessionToken, upsertAccount, createSession, resolveSession, deleteSession } from "@agentgem/aggregator";

describe("webAuth store", () => {
  it("generateSessionToken returns a token + its sha256 hash (hash != token)", () => {
    const { token, hash } = generateSessionToken();
    expect(token.length).toBeGreaterThan(20);
    expect(hash).not.toBe(token);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("upsertAccount inserts then is idempotent on (provider, accountId)", async () => {
    const db = await makeTestDb();
    const a = await upsertAccount(db, { provider: "github", accountId: "42", login: "octocat", avatarUrl: "http://x/a.png" });
    expect(a.login).toBe("octocat");
    const b = await upsertAccount(db, { provider: "github", accountId: "42", login: "octocat-renamed" });
    expect(b.id).toBe(a.id);             // same row
    expect(b.login).toBe("octocat-renamed"); // login refreshed
  });

  it("createSession + resolveSession round-trips and stores only the hash", async () => {
    const db = await makeTestDb();
    const acct = await upsertAccount(db, { provider: "github", accountId: "7", login: "neo" });
    const { token } = generateSessionToken();
    await createSession(db, acct.id, token, 60_000);
    const r = await resolveSession(db, token);
    expect(r).toEqual({ login: "neo", avatarUrl: null, accountId: acct.id });
  });

  it("resolveSession returns null for an unknown token and for an expired session", async () => {
    const db = await makeTestDb();
    expect(await resolveSession(db, "nope")).toBeNull();
    const acct = await upsertAccount(db, { provider: "github", accountId: "9", login: "trin" });
    const { token } = generateSessionToken();
    await createSession(db, acct.id, token, -1000); // already expired
    expect(await resolveSession(db, token)).toBeNull();
  });

  it("deleteSession removes it", async () => {
    const db = await makeTestDb();
    const acct = await upsertAccount(db, { provider: "github", accountId: "5", login: "morph" });
    const { token } = generateSessionToken();
    await createSession(db, acct.id, token, 60_000);
    await deleteSession(db, token);
    expect(await resolveSession(db, token)).toBeNull();
  });
});
