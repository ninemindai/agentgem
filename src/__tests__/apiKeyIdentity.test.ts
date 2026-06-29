import { describe, it, expect, vi } from "vitest";
import { makeTestDb } from "../aggregator/testDb.js";
import { issueKey } from "../aggregator/apiKeys.js";
import { makeApiKeyIdentity } from "../apiKeyIdentity.js";

function mockReqRes(headers: Record<string, string> = {}, query: Record<string, unknown> = {}) {
  const req: any = { method: "GET", path: "/api/aggregator/popularity", query, get: (n: string) => headers[n.toLowerCase()] };
  const res: any = { code: 0, body: "", status(c: number) { this.code = c; return this; }, type() { return this; }, send(b: string) { this.body = b; return this; } };
  return { req, res };
}

describe("apiKeyIdentity", () => {
  it("marks requests with no key as anonymous and calls next", async () => {
    const db = await makeTestDb();
    const next = vi.fn();
    const { req, res } = mockReqRes();
    await makeApiKeyIdentity(db)(req, res, next);
    expect(req.gemTier).toBe("anonymous");
    expect(next).toHaveBeenCalledOnce();
  });

  it("marks a valid x-api-key as keyed with its id and calls next", async () => {
    const db = await makeTestDb();
    const { id, plaintext } = await issueKey(db, "t");
    const next = vi.fn();
    const { req, res } = mockReqRes({ "x-api-key": plaintext });
    await makeApiKeyIdentity(db)(req, res, next);
    expect(req.gemTier).toBe("keyed");
    expect(req.gemKeyId).toBe(id);
    expect(next).toHaveBeenCalledOnce();
  });

  it("401s a present-but-invalid key without calling next", async () => {
    const db = await makeTestDb();
    const next = vi.fn();
    const { req, res } = mockReqRes({ "x-api-key": "ag_bogus" });
    await makeApiKeyIdentity(db)(req, res, next);
    expect(res.code).toBe(401);
    expect(JSON.parse(res.body)).toEqual({ error: "invalid api key" });
    expect(next).not.toHaveBeenCalled();
  });

  it("also accepts the apiKey query parameter", async () => {
    const db = await makeTestDb();
    const { plaintext } = await issueKey(db, "t");
    const next = vi.fn();
    const { req, res } = mockReqRes({}, { apiKey: plaintext });
    await makeApiKeyIdentity(db)(req, res, next);
    expect(req.gemTier).toBe("keyed");
    expect(next).toHaveBeenCalledOnce();
  });
});
