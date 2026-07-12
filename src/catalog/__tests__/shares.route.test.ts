// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import {
  makeTestDb, makeAuth, mintSession, upsertCatalogGem,
  createNativeGroup, listGroupsForGem,
} from "@agentgem/aggregator";
import type { AppDb } from "@agentgem/aggregator";
import { shareGemHandler } from "../shares.js";

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

describe("gem-shares route (owner-gated)", () => {
  it("owner who is a group member can POST a share; non-owner 404; non-member owner 403", async () => {
    const db = await makeTestDb();
    const auth = makeAuth({ db, ...authOpts });
    const owner = await signedIn(db, auth, "owner");
    const other = await signedIn(db, auth, "other");
    await upsertCatalogGem(db, { gemKey: "o/secret", version: "1.0.0", publishedBy: "owner", ownerAccountId: owner.acct.id, createdAtMs: 1, visibility: "private" });
    const g = await createNativeGroup(db, owner.acct.id, "Team");         // owner is admin/member
    const foreign = await createNativeGroup(db, other.acct.id, "Foreign"); // owner is NOT a member
    const deps = { db, auth, webOrigins: ORIGINS };
    const handler = shareGemHandler(deps);

    // owner shares with own group -> 200
    const ok = res();
    await handler(req({ method: "POST", headers: owner.headers, body: { key: "o/secret", groupId: g.id } }), ok);
    expect(ok.code).toBe(200);
    expect(await listGroupsForGem(db, "o/secret")).toEqual([{ groupId: g.id, name: "Team" }]);

    // non-owner tries to share owner's gem -> 404 (no leak)
    const nf = res();
    await handler(req({ method: "POST", headers: other.headers, body: { key: "o/secret", groupId: foreign.id } }), nf);
    expect(nf.code).toBe(404);

    // owner shares with a group they don't belong to -> 403
    const forbidden = res();
    await handler(req({ method: "POST", headers: owner.headers, body: { key: "o/secret", groupId: foreign.id } }), forbidden);
    expect(forbidden.code).toBe(403);
  });
});
