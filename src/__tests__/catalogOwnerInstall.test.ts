// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { makeTestDb, makeAuth, mintSession, upsertCatalogGem, upsertGemArchive } from "@agentgem/aggregator";
import { exportGem } from "@agentgem/distribute";
import type { Gem } from "@agentgem/model";
import { ownerGemArchiveHandler, ownerGemHandler } from "../catalog/install.js";

const webOrigins = ["https://app.agentgem.ai"];
const authOpts = {
  secret: "test-secret", baseURL: "http://localhost:4000",
  githubClientId: "gid", githubClientSecret: "gsecret",
  webOrigins,
};
function mockRes() {
  const r: any = { _status: 200, _headers: {} as Record<string,string>, _body: undefined };
  r.status = (c: number) => { r._status = c; return r; };
  r.set = (k: string, v: string) => { r._headers[k.toLowerCase()] = v; return r; };
  r.setHeader = (k: string, v: string) => { r._headers[k.toLowerCase()] = v; return r; };
  r.json = (b: unknown) => { r._body = b; return r; };
  r.send = (b: unknown) => { r._body = b; return r; };
  return r;
}
const req = (over: any = {}) => ({ method: "GET", path: "/", query: {}, body: {}, headers: {}, get(n: string){ return (this.headers as any)[n.toLowerCase()]; }, ...over });
const deps = (db: any, auth: any) => ({ db, auth, webOrigins });

// Better-auth user + accounts anchor (via the account.create hook) + a minted bearer session,
// replacing the old createSession/generateSessionToken pair (Plan 1b cutover).
async function withSession(db: any, auth: any, login = "u") {
  const ctx = await auth.$context;
  const user = await ctx.internalAdapter.createUser({ name: login, email: `${login}@example.com`, emailVerified: true, login } as never);
  await ctx.internalAdapter.createAccount({ userId: user.id, providerId: "github", accountId: login } as never);
  const { token } = await mintSession(auth, user.id);
  return { a: { id: user.id }, token };
}

function gameGem(name: string, title: string): Gem {
  return {
    name,
    createdFrom: { kind: "blank", title },
    artifacts: [{
      type: "game", name, title, genre: "project-fun",
      html: "<!doctype html><title>t</title><canvas></canvas>",
      createdFrom: { kind: "blank", title }, engineVersion: "1",
    }],
    checks: [], requiredSecrets: [],
  } as unknown as Gem;
}

async function seedGame(db: any, opts: {
  gemKey: string; version: string; name: string; title: string; createdAtMs: number;
  ownerAccountId: string; visibility?: "public" | "unlisted" | "private";
}) {
  const { bytes } = exportGem(gameGem(opts.name, opts.title), { version: opts.version });
  await upsertGemArchive(db, { gemKey: opts.gemKey, version: opts.version, bytes, digest: `d-${opts.version}`, createdAtMs: opts.createdAtMs });
  await upsertCatalogGem(db, {
    gemKey: opts.gemKey, version: opts.version, publishedBy: "owner", author: "owner",
    description: "a private game", tags: ["fun"], artifactKinds: ["game"], type: "game",
    artifacts: [{ name: opts.name, type: "game" }], createdAtMs: opts.createdAtMs,
    ownerAccountId: opts.ownerAccountId, visibility: opts.visibility ?? "private",
  });
}

describe("catalog owner install endpoints", () => {
  it("GET gem-archive 401s without a session", async () => {
    const db = await makeTestDb();
    const auth = makeAuth({ db, ...authOpts });
    const res = mockRes();
    await ownerGemArchiveHandler(deps(db, auth))(req({ query: { key: "@mine/private-game", version: "1.0.0" } }) as any, res as any);
    expect(res._status).toBe(401);
    expect(res._body).toEqual({ error: "sign in required" });
  });

  it("GET gem-archive 404s when the gem is owned by a different account (no existence leak)", async () => {
    const db = await makeTestDb();
    const auth = makeAuth({ db, ...authOpts });
    const { token } = await withSession(db, auth, "mine");
    const { a: other } = await withSession(db, auth, "other");
    await seedGame(db, { gemKey: "@other/private-game", version: "1.0.0", name: "g1", title: "Other's", createdAtMs: 1000, ownerAccountId: other.id, visibility: "private" });

    const res = mockRes();
    await ownerGemArchiveHandler(deps(db, auth))(req({ headers: { authorization: `Bearer ${token}` }, query: { key: "@other/private-game", version: "1.0.0" } }) as any, res as any);
    expect(res._status).toBe(404);
    expect(res._body).toEqual({ error: "gem not found" });
  });

  it("GET gem-archive 200s with archiveBase64 when the caller owns it", async () => {
    const db = await makeTestDb();
    const auth = makeAuth({ db, ...authOpts });
    const { a, token } = await withSession(db, auth, "mine");
    await seedGame(db, { gemKey: "@mine/private-game", version: "1.0.0", name: "g1", title: "Mine", createdAtMs: 1000, ownerAccountId: a.id, visibility: "private" });

    const res = mockRes();
    await ownerGemArchiveHandler(deps(db, auth))(req({ headers: { authorization: `Bearer ${token}` }, query: { key: "@mine/private-game", version: "1.0.0" } }) as any, res as any);
    expect(res._status).toBe(200);
    const body = res._body as any;
    expect(typeof body.archiveBase64).toBe("string");
    expect(body.archiveBase64.length).toBeGreaterThan(0);
  });

  it("GET gem-detail 401s without a session", async () => {
    const db = await makeTestDb();
    const auth = makeAuth({ db, ...authOpts });
    const res = mockRes();
    await ownerGemHandler(deps(db, auth))(req({ query: { key: "@mine/private-game" } }) as any, res as any);
    expect(res._status).toBe(401);
  });

  it("GET gem-detail 404s when the gem is owned by a different account (no existence leak)", async () => {
    const db = await makeTestDb();
    const auth = makeAuth({ db, ...authOpts });
    const { token } = await withSession(db, auth, "mine");
    const { a: other } = await withSession(db, auth, "other");
    await seedGame(db, { gemKey: "@other/private-game", version: "1.0.0", name: "g1", title: "Other's", createdAtMs: 1000, ownerAccountId: other.id, visibility: "private" });

    const res = mockRes();
    await ownerGemHandler(deps(db, auth))(req({ headers: { authorization: `Bearer ${token}` }, query: { key: "@other/private-game" } }) as any, res as any);
    expect(res._status).toBe(404);
    expect(res._body).toEqual({ error: "gem not found" });
  });

  it("GET gem-detail 200s with the metadata shape when the caller owns it", async () => {
    const db = await makeTestDb();
    const auth = makeAuth({ db, ...authOpts });
    const { a, token } = await withSession(db, auth, "mine");
    await seedGame(db, { gemKey: "@mine/private-game", version: "1.0.0", name: "g1", title: "Mine", createdAtMs: 1000, ownerAccountId: a.id, visibility: "private" });

    const res = mockRes();
    await ownerGemHandler(deps(db, auth))(req({ headers: { authorization: `Bearer ${token}` }, query: { key: "@mine/private-game" } }) as any, res as any);
    expect(res._status).toBe(200);
    expect(res._body).toEqual({
      key: "@mine/private-game", version: "1.0.0", publishedBy: "owner",
      description: "a private game", tags: ["fun"], artifactKinds: ["game"],
      artifacts: [{ name: "g1", type: "game" }],
      grade: null, visibility: "private", installable: true,
    });
  });
});
