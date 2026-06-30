import { describe, it, expect, afterEach } from "vitest";
import { resolveAggregatorDb } from "@agentgem/aggregator";
import { issueKey, verifyKey } from "@agentgem/aggregator";

const orig = { ...process.env };
afterEach(() => { process.env = { ...orig }; });

describe("resolveAggregatorDb", () => {
  it("falls back to embedded pglite when DATABASE_URL is unset, with a usable schema", async () => {
    delete process.env.DATABASE_URL;
    const { db, onStop, mode } = await resolveAggregatorDb();
    expect(mode).toBe("pglite");
    const { plaintext } = await issueKey(db, "local"); // schema exists + writable
    expect(await verifyKey(db, plaintext)).not.toBeNull();
    await onStop();
  });
});
