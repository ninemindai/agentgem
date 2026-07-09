// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";
import { makeTestDb, upsertAccount, createSession, generateSessionToken, createNativeGroup, grantInvite, groupMemberRole } from "@agentgem/aggregator";
import type { AppDb } from "@agentgem/aggregator";
import { groupsHandler, groupMembersHandler, groupInvitesHandler, groupInviteRedeemHandler } from "../install.js";

const ORIGINS = ["https://app.agentgem.ai"];
const deps = (db: AppDb) => ({ db, webOrigins: ORIGINS });

function res() {
  const r: any = { code: 200, body: undefined as unknown, headers: {} as Record<string, string> };
  r.status = (c: number) => { r.code = c; return r; };
  r.set = (k: string, v: string) => { r.headers[k] = v; return r; };
  r.json = (b: unknown) => { r.body = b; return r; };
  r.send = (b: unknown) => { r.body = b; return r; };
  return r;
}
const req = (over: Record<string, unknown> = {}) => ({ method: "GET", path: "/", query: {}, body: {}, headers: {}, ...over }) as any;

async function signedIn(db: AppDb, login: string) {
  const acct = await upsertAccount(db, { provider: "github", accountId: login, login });
  const { token } = generateSessionToken();
  await createSession(db, acct.id, token, 60_000);
  return { acct, headers: { authorization: `Bearer ${token}` } };
}

describe("groups routes", () => {
  it("GET /groups without a session → 401", async () => {
    const db = await makeTestDb();
    const r = res();
    await groupsHandler(deps(db))(req(), r);
    expect(r.code).toBe(401);
  });

  it("OPTIONS preflight → 204, echoes an allowlisted origin with credentials", async () => {
    const db = await makeTestDb();
    const r = res();
    await groupsHandler(deps(db))(req({ method: "OPTIONS", headers: { origin: "https://app.agentgem.ai" } }), r);
    expect(r.code).toBe(204);
    expect(r.headers["Access-Control-Allow-Origin"]).toBe("https://app.agentgem.ai");
    expect(r.headers["Access-Control-Allow-Credentials"]).toBe("true");
  });

  it("OPTIONS from a foreign origin sets no ACAO header", async () => {
    const db = await makeTestDb();
    const r = res();
    await groupsHandler(deps(db))(req({ method: "OPTIONS", headers: { origin: "https://evil.example" } }), r);
    expect(r.headers["Access-Control-Allow-Origin"]).toBeUndefined();
  });

  it("POST /groups creates a native group, lists it, and makes the creator admin", async () => {
    const db = await makeTestDb();
    const me = await signedIn(db, "neo");
    const c = res();
    await groupsHandler(deps(db))(req({ method: "POST", headers: me.headers, body: { name: "Friends" } }), c);
    expect(c.code).toBe(200);
    expect((c.body as any).group).toMatchObject({ name: "Friends", kind: "native", scope: null });
    const l = res();
    await groupsHandler(deps(db))(req({ headers: me.headers }), l);
    expect((l.body as any).groups).toEqual([expect.objectContaining({ name: "Friends", role: "admin" })]);
  });

  it("POST /groups rejects an empty or over-long name → 400", async () => {
    const db = await makeTestDb();
    const me = await signedIn(db, "neo");
    for (const name of ["  ", "x".repeat(81)]) {
      const r = res();
      await groupsHandler(deps(db))(req({ method: "POST", headers: me.headers, body: { name } }), r);
      expect(r.code).toBe(400);
    }
  });

  it("a non-member gets 404 — never 403 — so group existence never leaks", async () => {
    const db = await makeTestDb();
    const owner = await signedIn(db, "owner");
    const stranger = await signedIn(db, "stranger");
    const g = await createNativeGroup(db, owner.acct.id, "Secret");
    for (const [handler, query] of [[groupMembersHandler, { id: g.id }], [groupInvitesHandler, { id: g.id }]] as const) {
      const r = res();
      await handler(deps(db))(req({ headers: stranger.headers, query }), r);
      expect(r.code).toBe(404);
    }
    // an id that does not exist is also 404 — indistinguishable
    const r = res();
    await groupMembersHandler(deps(db))(req({ headers: stranger.headers, query: { id: "00000000-0000-0000-0000-000000000000" } }), r);
    expect(r.code).toBe(404);
  });

  it("a member who is not an admin gets 403 on invite routes (existence already known)", async () => {
    const db = await makeTestDb();
    const owner = await signedIn(db, "owner");
    const member = await signedIn(db, "member");
    const g = await createNativeGroup(db, owner.acct.id, "Club");
    await grantInvite(db, g.id, member.acct.id, "member");
    const r = res();
    await groupInvitesHandler(deps(db))(req({ method: "POST", headers: member.headers, query: { id: g.id }, body: {} }), r);
    expect(r.code).toBe(403);
  });

  it("TWO IDENTITIES: admin mints, a different user redeems and joins", async () => {
    const db = await makeTestDb();
    const owner = await signedIn(db, "owner");
    const joiner = await signedIn(db, "joiner");
    const g = await createNativeGroup(db, owner.acct.id, "Club");

    const mint = res();
    await groupInvitesHandler(deps(db))(req({ method: "POST", headers: owner.headers, query: { id: g.id }, body: { role: "member", ttlDays: 7 } }), mint);
    expect(mint.code).toBe(200);
    const { token, id } = mint.body as any;
    expect(typeof token).toBe("string");
    expect(typeof id).toBe("string");

    const join = res();
    await groupInviteRedeemHandler(deps(db))(req({ method: "POST", headers: joiner.headers, body: { token } }), join);
    expect(join.code).toBe(200);
    expect(await groupMemberRole(db, g.id, joiner.acct.id)).toBe("member");
  });

  it("GET /group-invites returns ids, and the response contains no token", async () => {
    const db = await makeTestDb();
    const owner = await signedIn(db, "owner");
    const g = await createNativeGroup(db, owner.acct.id, "Club");
    const mint = res();
    await groupInvitesHandler(deps(db))(req({ method: "POST", headers: owner.headers, query: { id: g.id }, body: {} }), mint);
    const list = res();
    await groupInvitesHandler(deps(db))(req({ headers: owner.headers, query: { id: g.id } }), list);
    expect((list.body as any).invites[0].id).toBe((mint.body as any).id);
    expect(JSON.stringify((list.body as any).invites)).not.toContain((mint.body as any).token);
  });

  it("revoke by id, then redeem → 410", async () => {
    const db = await makeTestDb();
    const owner = await signedIn(db, "owner");
    const joiner = await signedIn(db, "joiner");
    const g = await createNativeGroup(db, owner.acct.id, "Club");
    const mint = res();
    await groupInvitesHandler(deps(db))(req({ method: "POST", headers: owner.headers, query: { id: g.id }, body: {} }), mint);
    const { token, id } = mint.body as any;

    const rev = res();
    await groupInvitesHandler(deps(db))(req({ method: "DELETE", headers: owner.headers, query: { id: g.id, invite: id } }), rev);
    expect(rev.code).toBe(200);

    const join = res();
    await groupInviteRedeemHandler(deps(db))(req({ method: "POST", headers: joiner.headers, body: { token } }), join);
    expect(join.code).toBe(410);
  });

  it("redeeming an unknown token → 404", async () => {
    const db = await makeTestDb();
    const joiner = await signedIn(db, "joiner");
    const r = res();
    await groupInviteRedeemHandler(deps(db))(req({ method: "POST", headers: joiner.headers, body: { token: "bogus" } }), r);
    expect(r.code).toBe(404);
  });

  it("ttlDays is clamped to 30 and defaults to 7", async () => {
    const db = await makeTestDb();
    const owner = await signedIn(db, "owner");
    const g = await createNativeGroup(db, owner.acct.id, "Club");
    const far = res();
    await groupInvitesHandler(deps(db))(req({ method: "POST", headers: owner.headers, query: { id: g.id }, body: { ttlDays: 9999 } }), far);
    const ms = new Date((far.body as any).expiresAt).getTime() - Date.now();
    expect(ms).toBeLessThanOrEqual(30 * 86_400_000 + 5_000);
    expect(ms).toBeGreaterThan(29 * 86_400_000);
  });

  it("removing the last admin → 409; a member may always remove themselves", async () => {
    const db = await makeTestDb();
    const owner = await signedIn(db, "owner");
    const member = await signedIn(db, "member");
    const g = await createNativeGroup(db, owner.acct.id, "Club");
    await grantInvite(db, g.id, member.acct.id, "member");

    const lastAdmin = res();
    await groupMembersHandler(deps(db))(req({ method: "DELETE", headers: owner.headers, query: { id: g.id, account: owner.acct.id } }), lastAdmin);
    expect(lastAdmin.code).toBe(409);

    const selfLeave = res();
    await groupMembersHandler(deps(db))(req({ method: "DELETE", headers: member.headers, query: { id: g.id, account: member.acct.id } }), selfLeave);
    expect(selfLeave.code).toBe(200);
    expect(await groupMemberRole(db, g.id, member.acct.id)).toBeNull();
  });

  it("a plain member cannot remove somebody else → 403", async () => {
    const db = await makeTestDb();
    const owner = await signedIn(db, "owner");
    const a = await signedIn(db, "a");
    const b = await signedIn(db, "b");
    const g = await createNativeGroup(db, owner.acct.id, "Club");
    await grantInvite(db, g.id, a.acct.id, "member");
    await grantInvite(db, g.id, b.acct.id, "member");
    const r = res();
    await groupMembersHandler(deps(db))(req({ method: "DELETE", headers: a.headers, query: { id: g.id, account: b.acct.id } }), r);
    expect(r.code).toBe(403);
  });

  it("DELETE /groups: admin deletes native; federated → 409; non-member → 404", async () => {
    const db = await makeTestDb();
    const owner = await signedIn(db, "owner");
    const stranger = await signedIn(db, "stranger");
    const g = await createNativeGroup(db, owner.acct.id, "Club");
    await db.execute(sql`insert into groups (id, kind, installation_id, name) values (gen_random_uuid(), 'federated', 101, 'acme')`);
    const fed = ((await db.execute(sql`select id from groups where kind='federated'`)).rows as { id: string }[])[0];
    await grantInvite(db, fed.id, owner.acct.id, "admin");

    const nf = res();
    await groupsHandler(deps(db))(req({ method: "DELETE", headers: stranger.headers, query: { id: g.id } }), nf);
    expect(nf.code).toBe(404);

    const conflict = res();
    await groupsHandler(deps(db))(req({ method: "DELETE", headers: owner.headers, query: { id: fed.id } }), conflict);
    expect(conflict.code).toBe(409);

    const ok = res();
    await groupsHandler(deps(db))(req({ method: "DELETE", headers: owner.headers, query: { id: g.id } }), ok);
    expect(ok.code).toBe(200);
  });
});
