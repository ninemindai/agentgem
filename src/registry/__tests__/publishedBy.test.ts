// src/registry/__tests__/publishedBy.test.ts
import { describe, it, expect } from "vitest";
import { makeTestDb, upsertAccount, generateSessionToken, createSession } from "@agentgem/aggregator";
import { resolvePublishedBy } from "../publishedBy.js";

const reqWith = (cookie?: string) => ({ headers: cookie === undefined ? {} : { cookie } });

describe("resolvePublishedBy", () => {
  it("returns the session account's login for a valid ag_session cookie", async () => {
    const db = await makeTestDb();
    const acct = await upsertAccount(db, { provider: "github", accountId: "7", login: "neo" });
    const { token } = generateSessionToken();
    await createSession(db, acct.id, token, 60_000);
    expect(await resolvePublishedBy(reqWith(`ag_session=${token}`), db)).toBe("neo");
  });
  it("returns undefined when req or db is missing (the local/trusted path)", async () => {
    const db = await makeTestDb();
    expect(await resolvePublishedBy(undefined, db)).toBeUndefined();
    expect(await resolvePublishedBy(reqWith("ag_session=x"), undefined)).toBeUndefined();
  });
  it("returns undefined for no cookie / no session cookie / unknown token", async () => {
    const db = await makeTestDb();
    expect(await resolvePublishedBy(reqWith(undefined), db)).toBeUndefined();
    expect(await resolvePublishedBy(reqWith("other=1"), db)).toBeUndefined();
    expect(await resolvePublishedBy(reqWith("ag_session=nope"), db)).toBeUndefined();
  });
});
