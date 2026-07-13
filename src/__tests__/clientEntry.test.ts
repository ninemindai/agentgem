// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/__tests__/clientEntry.test.ts
//
// Task 6: proves src/client.ts's createClientApp boots a pure client — the benchmark proxy
// controller dispatches (client-only) but the aggregator surface is absent, because client.ts
// never imports serverAggregator.ts (or index.ts at all). Mirrors the boot pattern in
// serverRoutes.test.ts / shareMiddlewareOrder.test.ts (createApp(0) -> app.start() -> supertest
// against server.expressApp — RestServer only mounts @api controller routes in start(), so
// asserting via the raw expressApp before start() would 404 even a correctly-registered
// controller). AGENTGEM_AGGREGATOR_URL points at an unreachable host so the benchmark proxy
// degrades to [] (still 200) without a live network dependency in CI.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { createClientApp } from "../client.js";
import type { RestApplication } from "@agentback/rest";

describe("client entry (desktop mode)", () => {
  let app: RestApplication;
  let server: Awaited<RestApplication["restServer"]>;
  const prevAggUrl = process.env.AGENTGEM_AGGREGATOR_URL;
  const prevDbUrl = process.env.DATABASE_URL;

  beforeAll(async () => {
    delete process.env.DATABASE_URL;
    process.env.SERVE_CONSOLE = "false";
    process.env.AGENTGEM_AGGREGATOR_URL = "http://127.0.0.1:1"; // unreachable: keeps the proxy offline
    app = await createClientApp(0);
    await app.start();
    server = await app.restServer;
  });

  afterAll(async () => {
    await app.stop();
    if (prevAggUrl === undefined) delete process.env.AGENTGEM_AGGREGATOR_URL;
    else process.env.AGENTGEM_AGGREGATOR_URL = prevAggUrl;
    if (prevDbUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = prevDbUrl;
  });

  it("serves /api/benchmark via the client-only proxy controller", async () => {
    const res = await request(server.expressApp).get("/api/benchmark").set("sec-fetch-site", "same-origin");
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("does not mount the aggregator surface (/api/aggregator/overview 404s)", async () => {
    const res = await request(server.expressApp).get("/api/aggregator/overview").set("sec-fetch-site", "same-origin");
    expect(res.status).toBe(404);
  });
});
