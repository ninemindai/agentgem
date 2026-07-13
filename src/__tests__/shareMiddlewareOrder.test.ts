// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/__tests__/shareMiddlewareOrder.test.ts
//
// Regression pin for Task 4 (the mountAggregator extraction): AgentBack orders same-group
// express middlewares by registration order. Before the refactor, the aggregator block
// (middleware.shareOriginSecret + mountGating's rate limiters) registered BEFORE
// middleware.originGuard in src/index.ts. The extraction accidentally moved that whole block
// into mountAggregator, called AFTER originGuard was registered — flipping the order, so a
// cross-site POST /api/aggregator/share with a missing/wrong x-origin-auth got originGuard's
// generic "cross-site request blocked" 403 instead of shareOriginSecret's "origin not verified"
// 403. This test boots the real server (mirrors serverRoutes.test.ts) and asserts the
// shareOriginSecret body wins, proving it still runs first.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { createApp } from "../index.js";
import type { RestApplication } from "@agentback/rest";

describe("share-create middleware order (shareOriginSecret before originGuard)", () => {
  let app: RestApplication;
  let server: Awaited<RestApplication["restServer"]>;
  const prevSecret = process.env.ORIGIN_SHARED_SECRET;
  const prevServeConsole = process.env.SERVE_CONSOLE;

  beforeAll(async () => {
    process.env.SERVE_CONSOLE = "false";
    process.env.ORIGIN_SHARED_SECRET = "test-shared-secret";
    app = await createApp(0);
    await app.start();
    server = await app.restServer;
  });

  afterAll(async () => {
    await app.stop();
    if (prevSecret === undefined) delete process.env.ORIGIN_SHARED_SECRET;
    else process.env.ORIGIN_SHARED_SECRET = prevSecret;
    if (prevServeConsole === undefined) delete process.env.SERVE_CONSOLE;
    else process.env.SERVE_CONSOLE = prevServeConsole;
  });

  it("403s a cross-site share-create with the shareOriginSecret body, not originGuard's", async () => {
    const res = await request(server.expressApp)
      .post("/api/aggregator/share")
      .set("sec-fetch-site", "cross-site")
      .send({ kind: "gem", payload: {} });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "origin not verified" });
    expect(res.body).not.toEqual({ error: "cross-site request blocked" });
  });

  it("403s the same request with a wrong x-origin-auth header, still shareOriginSecret's body", async () => {
    const res = await request(server.expressApp)
      .post("/api/aggregator/share")
      .set("sec-fetch-site", "cross-site")
      .set("x-origin-auth", "wrong-value")
      .send({ kind: "gem", payload: {} });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "origin not verified" });
  });
});
