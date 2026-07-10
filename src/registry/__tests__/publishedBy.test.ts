// src/registry/__tests__/publishedBy.test.ts
import { describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";
import { makeTestDb, makeAuth, resolveSession, claimHandle } from "@agentgem/aggregator";
import type { AppDb } from "@agentgem/aggregator";
// Test-only helper — not re-exported from the main barrel (see aggregator/src/index.ts), imported
// via the package's "testing" subpath instead. Mirrors src/handles/__tests__/install.test.ts.
import { mintBetterAuthCookieForTest } from "@agentgem/aggregator/testing";
import { resolvePublishedBy } from "../publishedBy.js";

const authOpts = {
  secret: "test-secret",
  baseURL: "http://localhost:4000",
  githubClientId: "gid",
  githubClientSecret: "gsecret",
  webOrigins: ["https://app.agentgem.ai"],
};

const reqWith = (headers: Record<string, string | undefined> = {}) => ({ headers });

// Mints a REAL better-auth session cookie (see webAuthShim.test.ts's cookie-path regression guard)
// for a fresh account, and resolves it back to the accountId the route will see. claimHandle's
// setAccountScopes writes account_scopes, which FKs to accounts.id, so the legacy accounts anchor
// is inserted here directly, same id as "user" (accounts.id === "user".id by construction — see
// handles.ts) — same pattern as src/handles/__tests__/install.test.ts's `signedIn` fixture.
async function makeAuthedFixture(db: AppDb, auth: ReturnType<typeof makeAuth>) {
  const cookie = await mintBetterAuthCookieForTest(db, authOpts);
  const who = await resolveSession(auth, { cookie });
  if (!who) throw new Error("test setup: cookie did not resolve to a session");
  await db.execute(sql`insert into accounts (id, provider, provider_account_id) values (${who.accountId}, 'test', ${who.accountId})`);
  return { headers: { cookie }, accountId: who.accountId };
}

describe("resolvePublishedBy", () => {
  it("returns the caller's handle once claimed, and undefined before they claim one", async () => {
    const db = await makeTestDb();
    const auth = makeAuth({ db, ...authOpts });
    const { headers, accountId } = await makeAuthedFixture(db, auth);
    expect(await resolvePublishedBy(reqWith(headers), auth, db)).toBeUndefined(); // no handle yet
    const claimed = await claimHandle(db, accountId, "raymond");
    expect(claimed).toEqual({ ok: true, handle: "raymond" });
    expect(await resolvePublishedBy(reqWith(headers), auth, db)).toBe("raymond");
  });

  it("returns undefined with no req, no auth, or no db (the local/trusted path)", async () => {
    const db = await makeTestDb();
    const auth = makeAuth({ db, ...authOpts });
    const { headers } = await makeAuthedFixture(db, auth);
    expect(await resolvePublishedBy(undefined, auth, db)).toBeUndefined();
    expect(await resolvePublishedBy(reqWith(headers), undefined, db)).toBeUndefined();
    expect(await resolvePublishedBy(reqWith(headers), auth, undefined)).toBeUndefined();
  });

  it("returns undefined for no headers / unknown session", async () => {
    const db = await makeTestDb();
    const auth = makeAuth({ db, ...authOpts });
    expect(await resolvePublishedBy(reqWith(), auth, db)).toBeUndefined();
    expect(await resolvePublishedBy(reqWith({ cookie: "not-a-real-cookie" }), auth, db)).toBeUndefined();
  });

  it("degrades to undefined (not a throw) when session resolution throws — attribution is best-effort", async () => {
    const db = await makeTestDb();
    const throwingAuth = { api: { getSession: () => { throw new Error("down"); } } } as never;
    await expect(resolvePublishedBy(reqWith({ authorization: "Bearer x" }), throwingAuth, db)).resolves.toBeUndefined();
  });

  it("degrades to undefined (not a throw) when the handle lookup itself throws", async () => {
    const db = await makeTestDb();
    const auth = makeAuth({ db, ...authOpts });
    const { headers } = await makeAuthedFixture(db, auth);
    const throwingDb = { execute: () => { throw new Error("db down"); } } as unknown as AppDb;
    await expect(resolvePublishedBy(reqWith(headers), auth, throwingDb)).resolves.toBeUndefined();
  });
});
