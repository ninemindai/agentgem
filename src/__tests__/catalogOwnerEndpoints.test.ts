// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { makeTestDb, makeAuth, mintSession, upsertCatalogGem, upsertGemArchive } from "@agentgem/aggregator";
import { exportGem } from "@agentgem/distribute";
import type { Gem } from "@agentgem/model";
import { myGemsHandler, ownerGameMetaHandler, ownerGameHtmlHandler } from "../catalog/install.js";

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
    tags: [], artifactKinds: ["game"], type: "game",
    artifacts: [{ name: opts.name, type: "game" }], createdAtMs: opts.createdAtMs,
    ownerAccountId: opts.ownerAccountId, visibility: opts.visibility ?? "private",
  });
}

describe("catalog owner endpoints", () => {
  it("GET my-gems 401s without a session", async () => {
    const db = await makeTestDb();
    const auth = makeAuth({ db, ...authOpts });
    const res = mockRes();
    await myGemsHandler(deps(db, auth))(req({ query: {} }) as any, res as any);
    expect(res._status).toBe(401);
    expect(res._body).toEqual({ error: "sign in required" });
  });

  it("GET my-gems returns only the caller's own gems, including private ones", async () => {
    const db = await makeTestDb();
    const auth = makeAuth({ db, ...authOpts });
    const { a, token } = await withSession(db, auth, "mine");
    const { a: other } = await withSession(db, auth, "other");
    await seedGame(db, { gemKey: "@mine/private-game", version: "1.0.0", name: "g1", title: "Mine", createdAtMs: 1000, ownerAccountId: a.id, visibility: "private" });
    await seedGame(db, { gemKey: "@other/public-game", version: "1.0.0", name: "g2", title: "Other", createdAtMs: 2000, ownerAccountId: other.id, visibility: "public" });

    const res = mockRes();
    await myGemsHandler(deps(db, auth))(req({ headers: { authorization: `Bearer ${token}` } }) as any, res as any);

    expect(res._status).toBe(200);
    const gems = (res._body as any).gems;
    expect(gems).toHaveLength(1);
    expect(gems[0]).toMatchObject({ key: "@mine/private-game", version: "1.0.0", visibility: "private" });
  });

  it("GET game-meta 401s without a session", async () => {
    const db = await makeTestDb();
    const auth = makeAuth({ db, ...authOpts });
    const res = mockRes();
    await ownerGameMetaHandler(deps(db, auth))(req({ query: { key: "@mine/private-game" } }) as any, res as any);
    expect(res._status).toBe(401);
  });

  it("GET game-meta 404s when the gem is owned by a different account (no existence leak)", async () => {
    const db = await makeTestDb();
    const auth = makeAuth({ db, ...authOpts });
    const { token } = await withSession(db, auth, "mine");
    const { a: other } = await withSession(db, auth, "other");
    await seedGame(db, { gemKey: "@other/private-game", version: "1.0.0", name: "g1", title: "Other's", createdAtMs: 1000, ownerAccountId: other.id, visibility: "private" });

    const res = mockRes();
    await ownerGameMetaHandler(deps(db, auth))(req({ headers: { authorization: `Bearer ${token}` }, query: { key: "@other/private-game" } }) as any, res as any);
    expect(res._status).toBe(404);
  });

  it("GET game-meta 200s with the game payload when the caller owns it", async () => {
    const db = await makeTestDb();
    const auth = makeAuth({ db, ...authOpts });
    const { a, token } = await withSession(db, auth, "mine");
    await seedGame(db, { gemKey: "@mine/private-game", version: "1.0.0", name: "g1", title: "Mine", createdAtMs: 1000, ownerAccountId: a.id, visibility: "private" });

    const res = mockRes();
    await ownerGameMetaHandler(deps(db, auth))(req({ headers: { authorization: `Bearer ${token}` }, query: { key: "@mine/private-game" } }) as any, res as any);
    expect(res._status).toBe(200);
    expect(res._body).toEqual({ title: "Mine", genre: "project-fun", version: "1.0.0" });
  });

  it("GET game-html 401s without a session", async () => {
    const db = await makeTestDb();
    const auth = makeAuth({ db, ...authOpts });
    const res = mockRes();
    await ownerGameHtmlHandler(deps(db, auth))(req({ query: { key: "@mine/private-game", version: "1.0.0" } }) as any, res as any);
    expect(res._status).toBe(401);
  });

  it("GET game-html 404s when the gem is owned by a different account (no existence leak)", async () => {
    const db = await makeTestDb();
    const auth = makeAuth({ db, ...authOpts });
    const { token } = await withSession(db, auth, "mine");
    const { a: other } = await withSession(db, auth, "other");
    await seedGame(db, { gemKey: "@other/private-game", version: "1.0.0", name: "g1", title: "Other's", createdAtMs: 1000, ownerAccountId: other.id, visibility: "private" });

    const res = mockRes();
    await ownerGameHtmlHandler(deps(db, auth))(req({ headers: { authorization: `Bearer ${token}` }, query: { key: "@other/private-game", version: "1.0.0" } }) as any, res as any);
    expect(res._status).toBe(404);
  });

  it("GET game-html 200s with the html when the caller owns it", async () => {
    const db = await makeTestDb();
    const auth = makeAuth({ db, ...authOpts });
    const { a, token } = await withSession(db, auth, "mine");
    await seedGame(db, { gemKey: "@mine/private-game", version: "1.0.0", name: "g1", title: "Mine", createdAtMs: 1000, ownerAccountId: a.id, visibility: "private" });

    const res = mockRes();
    await ownerGameHtmlHandler(deps(db, auth))(req({ headers: { authorization: `Bearer ${token}` }, query: { key: "@mine/private-game", version: "1.0.0" } }) as any, res as any);
    expect(res._status).toBe(200);
    expect((res._body as any).html).toContain("<canvas></canvas>");
  });
});
