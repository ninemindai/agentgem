// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/__tests__/serverRoutes.test.ts
//
// Route-registration guard for the src/index.ts -> src/serverAggregator.ts refactor
// (task 4): boots the real server-mode createApp(0) (the in-process pglite aggregator
// boots too) and asserts the aggregator surface is still registered. This has no
// opinion on HOW the routes get registered (controller dispatch vs raw express) — it
// only asserts the observable behavior (a live HTTP response), so it stays green
// whether the block lives inline in createApp or is moved into mountAggregator.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { createApp } from "../index.js";
import type { RestApplication } from "@agentback/rest";

describe("server entry route registration (aggregator surface)", () => {
  let app: RestApplication;
  let server: Awaited<RestApplication["restServer"]>;

  beforeAll(async () => {
    process.env.SERVE_CONSOLE = "false";
    app = await createApp(0);
    // The REST controller dispatch onion is wired up by RestApplication.start(), not merely by
    // awaiting `restServer` — without this, every @api-decorated route 404s even though the
    // controller is bound (confirmed by hand: /api/aggregator/overview 404s pre-start, 200 post-start).
    await app.start();
    server = await app.restServer;
  });

  afterAll(async () => {
    await app.stop();
  });

  it("registers /healthz", async () => {
    const res = await request(server.expressApp).get("/healthz").set("sec-fetch-site", "same-origin");
    expect(res.status).toBe(200);
  });

  it("registers the aggregator controller surface (/api/aggregator/overview is not a 404)", async () => {
    const res = await request(server.expressApp)
      .get("/api/aggregator/overview")
      .set("sec-fetch-site", "same-origin");
    expect(res.status).not.toBe(404);
    expect(res.status).toBe(200);
  });
});
