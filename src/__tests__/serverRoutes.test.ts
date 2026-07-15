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
  const prevAggUrl = process.env.AGENTGEM_AGGREGATOR_URL;

  beforeAll(async () => {
    process.env.SERVE_CONSOLE = "false";
    // The benchmark proxy fetches the hosted aggregator; point it at an unreachable host so it
    // degrades to [] (still 200) without a live network dependency in CI.
    process.env.AGENTGEM_AGGREGATOR_URL = "http://127.0.0.1:1";
    app = await createApp(0);
    // The REST controller dispatch onion is wired up by RestApplication.start(), not merely by
    // awaiting `restServer` — without this, every @api-decorated route 404s even though the
    // controller is bound (confirmed by hand: /api/aggregator/overview 404s pre-start, 200 post-start).
    await app.start();
    server = await app.restServer;
  });

  afterAll(async () => {
    await app.stop();
    if (prevAggUrl === undefined) delete process.env.AGENTGEM_AGGREGATOR_URL;
    else process.env.AGENTGEM_AGGREGATOR_URL = prevAggUrl;
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

  // The console's Benchmark tab calls /api/benchmark (the hosted-network proxy) in every mode.
  // The desktop client entry mounts it; the server entry must too, or the tab 404s under
  // `npx agentgem` / `pnpm dev`. Data comes from the hosted aggregator, not the local pglite.
  it("serves /api/benchmark via the hosted-network proxy (not a 404)", async () => {
    const res = await request(server.expressApp).get("/api/benchmark").set("sec-fetch-site", "same-origin");
    expect(res.status).not.toBe(404);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]); // proxy offline (unreachable AGENTGEM_AGGREGATOR_URL) → degrades to []
  });
});
