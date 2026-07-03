// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { makeTestDb, accounts, catalogGems } from "@agentgem/aggregator";
import { AggregatorController } from "../../aggregator.controller.js";

describe("AggregatorController.profile", () => {
  it("returns the profile for a known login", async () => {
    const db = await makeTestDb();
    await db.insert(accounts).values({ id: randomUUID(), provider: "github", providerAccountId: "1", login: "octocat", avatarUrl: "https://a/x" });
    await db.insert(catalogGems).values({ gemKey: "@octocat/g", version: "1.0.0", publishedBy: "octocat", description: "d", grade: 2, createdAtMs: 1 });
    const c = new AggregatorController(db);
    const res = await c.profile({ query: { login: "octocat" } });
    expect(res).toMatchObject({ login: "octocat", avatarUrl: "https://a/x", verified: false, githubUrl: "https://github.com/octocat" });
    expect(res.gems[0]).toMatchObject({ key: "@octocat/g", grade: 2 });
  });

  it("throws a 404 AgentError for an unknown login", async () => {
    const db = await makeTestDb();
    const c = new AggregatorController(db);
    await expect(c.profile({ query: { login: "nobody" } })).rejects.toMatchObject({ statusCode: 404 });
  });
});
