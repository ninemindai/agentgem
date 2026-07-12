// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import {
  makeTestDb, makeAuth, mintSession, upsertCatalogGem, upsertGemArchive,
  createNativeGroup, grantInvite, shareGemWithGroup,
} from "@agentgem/aggregator";
import type { AppDb } from "@agentgem/aggregator";
import { ownerGemArchiveHandler } from "../install.js";

const ORIGINS = ["https://app.agentgem.ai"];
const authOpts = {
  secret: "test-secret", baseURL: "http://localhost:4000",
  githubClientId: "gid", githubClientSecret: "gsecret",
  webOrigins: ORIGINS,
};

function res() {
  const r: any = { code: 200, body: undefined as unknown, headers: {} as Record<string, string> };
  r.status = (c: number) => { r.code = c; return r; };
  r.set = (k: string, v: string) => { r.headers[k] = v; return r; };
  r.json = (b: unknown) => { r.body = b; return r; };
  r.send = (b: unknown) => { r.body = b; return r; };
  return r;
}
const req = (over: Record<string, unknown> = {}) => ({ method: "GET", path: "/", query: {}, body: {}, headers: {}, ...over }) as any;

// Better-auth user + accounts anchor (via the account.create hook) + a minted bearer session.
async function signedIn(db: AppDb, auth: ReturnType<typeof makeAuth>, login: string) {
  const ctx = await auth.$context;
  const user = await ctx.internalAdapter.createUser({ name: login, email: `${login}@example.com`, emailVerified: true, login } as never);
  await ctx.internalAdapter.createAccount({ userId: user.id, providerId: "github", accountId: login } as never);
  const { token } = await mintSession(auth, user.id);
  return { acct: { id: user.id }, headers: { authorization: `Bearer ${token}` } };
}

describe("shared-gem resolve (access-gated, no-leak 404)", () => {
  it("a shared-group member can download a private gem; a stranger gets 404", async () => {
    const db = await makeTestDb();
    const auth = makeAuth({ db, ...authOpts });
    const owner = await signedIn(db, auth, "owner");
    const member = await signedIn(db, auth, "member");
    const stranger = await signedIn(db, auth, "stranger");

    await upsertCatalogGem(db, { gemKey: "o/secret", version: "1.0.0", publishedBy: "owner", ownerAccountId: owner.acct.id, createdAtMs: 1, visibility: "private" });
    await upsertGemArchive(db, { gemKey: "o/secret", version: "1.0.0", bytes: new Uint8Array([1, 2, 3]), digest: "d", createdAtMs: 1, ownerAccountId: owner.acct.id });
    const g = await createNativeGroup(db, owner.acct.id, "Team");
    await grantInvite(db, g.id, member.acct.id, "member");
    await shareGemWithGroup(db, "o/secret", g.id, owner.acct.id);

    const deps = { db, auth, webOrigins: ORIGINS };
    const handler = ownerGemArchiveHandler(deps);

    const m = res();
    await handler(req({ query: { key: "o/secret", version: "1.0.0" }, headers: member.headers }), m);
    expect(m.code).toBe(200);
    expect((m.body as any).archiveBase64).toBe(Buffer.from([1, 2, 3]).toString("base64"));

    const s = res();
    await handler(req({ query: { key: "o/secret", version: "1.0.0" }, headers: stranger.headers }), s);
    expect(s.code).toBe(404);
  });
});
