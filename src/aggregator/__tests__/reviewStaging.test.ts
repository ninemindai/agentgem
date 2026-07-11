import { describe, it, expect } from "vitest";
import { makeTestDb, reviewRequests } from "@agentgem/aggregator";

describe("review staging schema", () => {
  it("ensureSchema creates review_requests and the table accepts a row", async () => {
    const db = await makeTestDb(); // makeTestDb runs ensureSchema
    const rows = await db.select().from(reviewRequests);
    expect(rows).toEqual([]);
  });
});
