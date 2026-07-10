// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";
import { makeTestDb, recordGamePlay, gamePlayCounts } from "@agentgem/aggregator";

describe("gamePlays", () => {
  it("counts one play per recorded click", async () => {
    const db = await makeTestDb();
    await recordGamePlay(db, { gemKey: "@octocat/duel", version: "1.0.0", visitorId: "v1" });
    await recordGamePlay(db, { gemKey: "@octocat/duel", version: "1.0.0", visitorId: "v2" });
    expect(await gamePlayCounts(db, {})).toEqual([{ gemKey: "@octocat/duel", plays: 2 }]);
  });

  it("counts the same visitor's repeat plays — a play is a click, not a person", async () => {
    const db = await makeTestDb();
    await recordGamePlay(db, { gemKey: "@octocat/duel", version: "1.0.0", visitorId: "v1" });
    await recordGamePlay(db, { gemKey: "@octocat/duel", version: "1.0.0", visitorId: "v1" });
    expect(await gamePlayCounts(db, {})).toEqual([{ gemKey: "@octocat/duel", plays: 2 }]);
  });

  it("keeps visitor_id on the row so a count can be checked against distinct browsers", async () => {
    const db = await makeTestDb();
    await recordGamePlay(db, { gemKey: "@octocat/duel", version: "1.0.0", visitorId: "v1" });
    await recordGamePlay(db, { gemKey: "@octocat/duel", version: "1.0.0", visitorId: "v1" });
    await recordGamePlay(db, { gemKey: "@octocat/duel", version: "1.0.0", visitorId: "v2" });
    const r = await db.execute<{ n: number }>(sql`select count(distinct visitor_id)::int as n from game_plays`);
    expect(r.rows[0]?.n).toBe(2);
  });

  it("caps an oversized visitor id instead of storing it whole", async () => {
    // The route rejects >64 chars with a 422, so only a direct caller reaches this. The column is
    // unbounded text, and a dedupe key is never worth unbounded storage.
    const db = await makeTestDb();
    await recordGamePlay(db, { gemKey: "@octocat/duel", version: "1.0.0", visitorId: "a".repeat(200) });
    const r = await db.execute<{ n: number }>(sql`select max(length(visitor_id))::int as n from game_plays`);
    expect(r.rows[0]?.n).toBe(64);
  });

  it("records a play from a client that sends no visitor id", async () => {
    const db = await makeTestDb();
    await recordGamePlay(db, { gemKey: "@octocat/duel", version: "1.0.0" });
    expect(await gamePlayCounts(db, {})).toEqual([{ gemKey: "@octocat/duel", plays: 1 }]);
  });

  it("sums a gem's plays across its versions, and omits gems nobody played", async () => {
    const db = await makeTestDb();
    await recordGamePlay(db, { gemKey: "@octocat/duel", version: "1.0.0", visitorId: "v1" });
    await recordGamePlay(db, { gemKey: "@octocat/duel", version: "2.0.0", visitorId: "v1" });
    await recordGamePlay(db, { gemKey: "@octocat/maze", version: "1.0.0", visitorId: "v1" });
    const counts = await gamePlayCounts(db, { keys: ["@octocat/duel", "@octocat/never-played"] });
    expect(counts).toEqual([{ gemKey: "@octocat/duel", plays: 2 }]);
  });
});
