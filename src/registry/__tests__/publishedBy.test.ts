// src/registry/__tests__/publishedBy.test.ts
import { describe, it, expect } from "vitest";
import { makeTestDb, makeAuth, mintSession } from "@agentgem/aggregator";
import { resolvePublishedBy } from "../publishedBy.js";

const authOpts = {
  secret: "test-secret",
  baseURL: "http://localhost:4000",
  githubClientId: "gid",
  githubClientSecret: "gsecret",
  webOrigins: ["https://app.agentgem.ai"],
};

const reqWith = (headers: Record<string, string | undefined> = {}) => ({ headers });

describe("resolvePublishedBy", () => {
  it("returns the session account's login for a valid bearer token", async () => {
    const db = await makeTestDb();
    const auth = makeAuth({ db, ...authOpts });
    const ctx = await auth.$context;
    const user = await ctx.internalAdapter.createUser({ name: "neo", email: "neo@example.com", emailVerified: true, login: "neo" } as never);
    const { token } = await mintSession(auth, user.id);
    expect(await resolvePublishedBy(reqWith({ authorization: `Bearer ${token}` }), auth)).toBe("neo");
  });
  it("returns undefined when req or auth is missing (the local/trusted path)", async () => {
    const db = await makeTestDb();
    const auth = makeAuth({ db, ...authOpts });
    expect(await resolvePublishedBy(undefined, auth)).toBeUndefined();
    expect(await resolvePublishedBy(reqWith({ authorization: "Bearer x" }), undefined)).toBeUndefined();
  });
  it("returns undefined for no headers / unknown token", async () => {
    const db = await makeTestDb();
    const auth = makeAuth({ db, ...authOpts });
    expect(await resolvePublishedBy(reqWith(), auth)).toBeUndefined();
    expect(await resolvePublishedBy(reqWith({ authorization: "Bearer nope" }), auth)).toBeUndefined();
  });
  it("degrades to undefined (not a throw) on an internal error — attribution is best-effort", async () => {
    const throwingAuth = { api: { getSession: () => { throw new Error("down"); } } } as never;
    await expect(resolvePublishedBy(reqWith({ authorization: "Bearer x" }), throwingAuth)).resolves.toBeUndefined();
  });
});
