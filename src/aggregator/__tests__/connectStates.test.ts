// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { makeTestDb, makeAuth, stashConnectState, consumeConnectState, CONNECT_STATE_TTL_MS } from "@agentgem/aggregator";
import { createHash } from "node:crypto";

const h = (s: string) => createHash("sha256").update(s).digest("hex");

const opts = {
  secret: "test-secret",
  baseURL: "http://localhost:4000",
  githubClientId: "gid",
  githubClientSecret: "gsecret",
  webOrigins: ["http://localhost:3000"],
};

describe("connect_states", () => {
  it("stashes then consumes exactly once, binds to the current user, and honors expiry", async () => {
    const db = await makeTestDb();
    // currentUserId FKs "user".id (mirrors pendingAccountLinks), so seed real session subjects
    // instead of literal strings — matches accountLinking.test.ts's convention.
    const auth = makeAuth({ db, ...opts });
    const ctx = await auth.$context;
    const u1 = await ctx.internalAdapter.createUser({ email: "u1@x.com", name: "U1", emailVerified: false } as never);
    const u2 = await ctx.internalAdapter.createUser({ email: "u2@x.com", name: "U2", emailVerified: false } as never);

    await stashConnectState(db, { stateHash: h("s1"), codeVerifier: "v1", currentUserId: u1.id, provider: "github" });
    const got = await consumeConnectState(db, h("s1"));
    expect(got).toEqual({ codeVerifier: "v1", currentUserId: u1.id, provider: "github" });
    // one-time: a second consume returns null
    expect(await consumeConnectState(db, h("s1"))).toBeNull();
    // unknown state -> null
    expect(await consumeConnectState(db, h("nope"))).toBeNull();
    // expired -> null (and cleaned)
    await stashConnectState(db, { stateHash: h("s2"), codeVerifier: "v2", currentUserId: u2.id, provider: "google" }, -1);
    expect(await consumeConnectState(db, h("s2"))).toBeNull();
  });
});
