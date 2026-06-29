import { describe, it, expect, afterEach } from "vitest";
import { makeTestDb } from "../testDb.js";
import { AggregatorController } from "../../aggregator.controller.js";

const orig = { ...process.env };
afterEach(() => { process.env = { ...orig }; });

describe("POST /api/aggregator/keys (issue)", () => {
  it("refuses when AGGREGATOR_ADMIN_TOKEN is unset", async () => {
    delete process.env.AGGREGATOR_ADMIN_TOKEN;
    const db = await makeTestDb();
    expect(await new AggregatorController(db).issueKey({ body: { token: "x", label: "l" } }))
      .toEqual({ ok: false, rejected: "keys-disabled" });
  });
  it("rejects a wrong token", async () => {
    process.env.AGGREGATOR_ADMIN_TOKEN = "s3cret";
    const db = await makeTestDb();
    expect(await new AggregatorController(db).issueKey({ body: { token: "nope", label: "l" } }))
      .toEqual({ ok: false, rejected: "unauthorized" });
  });
  it("issues a key with the right token", async () => {
    process.env.AGGREGATOR_ADMIN_TOKEN = "s3cret";
    const db = await makeTestDb();
    const res = await new AggregatorController(db).issueKey({ body: { token: "s3cret", label: "acme" } });
    expect(res.ok).toBe(true);
    if (res.ok) { expect(res.key.startsWith("ag_")).toBe(true); expect(res.label).toBe("acme"); }
  });
});

describe("revoke + list", () => {
  it("revokes an issued key and lists metadata (no hash)", async () => {
    process.env.AGGREGATOR_ADMIN_TOKEN = "s3cret";
    const db = await makeTestDb();
    const ctl = new AggregatorController(db);
    const issued = await ctl.issueKey({ body: { token: "s3cret", label: "acme" } });
    if (!issued.ok) throw new Error("issue failed");
    const rev = await ctl.revokeKey({ body: { token: "s3cret", id: issued.id } });
    expect(rev).toEqual({ ok: true, revoked: true });
    const list = await ctl.listKeys({ body: { token: "s3cret" } });
    expect(list.ok).toBe(true);
    if (list.ok) {
      expect(list.keys).toHaveLength(1);
      expect(list.keys[0]).toMatchObject({ id: issued.id, label: "acme" });
      expect(typeof list.keys[0].createdAt).toBe("string");
      expect(list.keys[0].revokedAt).not.toBeNull();
      expect("keyHash" in list.keys[0]).toBe(false);
    }
  });
  it("rejects list with a wrong token", async () => {
    process.env.AGGREGATOR_ADMIN_TOKEN = "s3cret";
    const db = await makeTestDb();
    expect(await new AggregatorController(db).listKeys({ body: { token: "nope" } }))
      .toEqual({ ok: false, rejected: "unauthorized" });
  });
});
