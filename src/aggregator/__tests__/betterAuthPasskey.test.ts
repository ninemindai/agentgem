// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";
import { makeTestDb, makeAuth } from "@agentgem/aggregator";

const opts = {
  secret: "test-secret",
  baseURL: "http://localhost:4000",
  githubClientId: "gid",
  githubClientSecret: "gsecret",
  webOrigins: ["http://localhost:3000"],
};

describe("betterAuth passkey plugin", () => {
  it("registers the passkey plugin", async () => {
    const db = await makeTestDb();
    const auth = makeAuth({ db, ...opts, passkeyRpId: "agentgem.ai" });
    const ids = (auth.options.plugins ?? []).map((p: { id: string }) => p.id);
    expect(ids).toContain("passkey");
  });

  it("ensureSchema creates the passkey table keyed to a user", async () => {
    const db = await makeTestDb();
    const auth = makeAuth({ db, ...opts, passkeyRpId: "agentgem.ai" });
    const ctx = await auth.$context;
    const user = await ctx.internalAdapter.createUser(
      { email: "pk@example.com", name: "PK", emailVerified: false } as never,
    );
    // A missing table, missing column, or broken FK throws here.
    await db.execute(sql`insert into "passkey"
      (id, name, public_key, user_id, credential_id, counter, device_type, backed_up, transports, aaguid)
      values ('pk1', 'Primary', 'PUB', ${user.id}, 'CRED1', 0, 'singleDevice', true, 'internal', 'aaguid1')`);
    const rows = await db.execute(sql`select credential_id, user_id from "passkey" where id = 'pk1'`);
    expect((rows.rows[0] as { credential_id: string }).credential_id).toBe("CRED1");
    expect((rows.rows[0] as { user_id: string }).user_id).toBe(user.id);
  });
});
