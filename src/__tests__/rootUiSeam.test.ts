// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/__tests__/rootUiSeam.test.ts
//
// Proves the ROOT_UI_MOUNT seam in finalizeCommonApp: when the console is off
// (SERVE_CONSOLE=false), a downstream deployment can bind ROOT_UI_MOUNT to serve its own SPA at
// `/` instead of the default redirect. Unbound → redirect (the pure-client/hosted-API default).
// Bound while the console is ALSO on → a startup throw (both claim `/`). Boots via
// buildCommonApp + finalizeCommonApp + start(), then supertests server.expressApp, mirroring
// clientEntry.test.ts (RestServer only mounts routes in start(), so assert after it).
import { describe, it, expect, afterEach } from "vitest";
import request from "supertest";
import { buildCommonApp, finalizeCommonApp, ROOT_UI_MOUNT } from "../appCommon.js";
import type { RestApplication } from "@agentback/rest";

describe("ROOT_UI_MOUNT seam", () => {
  let app: RestApplication | undefined;
  const prevConsole = process.env.SERVE_CONSOLE;

  afterEach(async () => {
    if (app) { await app.stop(); app = undefined; }
    if (prevConsole === undefined) delete process.env.SERVE_CONSOLE;
    else process.env.SERVE_CONSOLE = prevConsole;
  });

  it("serves the bound root UI at / when SERVE_CONSOLE=false", async () => {
    process.env.SERVE_CONSOLE = "false";
    const { app: a, server } = await buildCommonApp(0);
    app = a;
    a.bind(ROOT_UI_MOUNT).to((srv) => {
      srv.expressApp.get("/", (_req, res) => res.type("html").send("<div>marketplace</div>"));
    });
    finalizeCommonApp(a, server);
    await a.start();
    const res = await request(server.expressApp).get("/").set("sec-fetch-site", "same-origin");
    expect(res.status).toBe(200);
    expect(res.text).toContain("marketplace");
  });

  it("redirects / to the site when SERVE_CONSOLE=false and nothing is bound", async () => {
    process.env.SERVE_CONSOLE = "false";
    const { app: a, server } = await buildCommonApp(0);
    app = a;
    finalizeCommonApp(a, server);
    await a.start();
    const res = await request(server.expressApp).get("/").set("sec-fetch-site", "same-origin").redirects(0);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("https://agentgem.ai");
  });

  it("throws when a root UI is bound but the console is also on", async () => {
    process.env.SERVE_CONSOLE = "true";
    const { app: a, server } = await buildCommonApp(0);
    app = a;
    a.bind(ROOT_UI_MOUNT).to((srv) => {
      srv.expressApp.get("/", (_req, res) => res.send("x"));
    });
    expect(() => finalizeCommonApp(a, server)).toThrow(/both claim/);
  });
});
