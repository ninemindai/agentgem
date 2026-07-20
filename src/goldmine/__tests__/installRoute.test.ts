// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/goldmine/__tests__/installRoute.test.ts
import { describe, it, expect, vi } from "vitest";
import { registerChatRoutes } from "@agentgem/app/goldmine/chatRoutes";

// Minimal fake Express app that records handlers and lets us invoke them.
function fakeApp() {
  const routes: Record<string, (req: any, res: any) => any> = {};
  const app = {
    get: (p: string, _g: any, h: any) => { routes["GET " + p] = h; },
    post: (p: string, _g: any, h: any) => { routes["POST " + p] = h; },
    delete: (p: string, _g: any, h: any) => { routes["DELETE " + p] = h; },
  };
  return { app, routes };
}
function fakeRes() {
  const r: any = { code: 200, body: undefined, status(c: number) { r.code = c; return r; }, json(b: unknown) { r.body = b; }, setHeader() {}, write() {}, end() {} };
  return r;
}
const baseDeps = () => ({
  manager: {} as any,
  listAgents: () => [],
  buildBrief: async () => "",
  goldmineMcp: () => [],
});

describe("POST /api/agents/:id/install", () => {
  it("409 consent_required when consent is missing", async () => {
    const { app, routes } = fakeApp();
    const installAgent = vi.fn(async () => { throw Object.assign(new Error("install requires consent"), { code: "consent_required" }); });
    registerChatRoutes(app as never, { ...baseDeps(), installAgent } as never);
    const res = fakeRes();
    await routes["POST /api/agents/:id/install"]({ params: { id: "codex" }, body: {}, query: {} }, res);
    expect(res.code).toBe(409);
    expect(res.body).toMatchObject({ code: "consent_required" });
  });

  it("500 returns a generic message, not the raw exception (no internal disclosure)", async () => {
    const { app, routes } = fakeApp();
    const installAgent = vi.fn(async () => { throw new Error("spawn /usr/local/bin/npm ENOENT reading /secret/path"); });
    registerChatRoutes(app as never, { ...baseDeps(), installAgent } as never);
    const res = fakeRes();
    await routes["POST /api/agents/:id/install"]({ params: { id: "codex" }, body: { consent: true }, query: {} }, res);
    expect(res.code).toBe(500);
    expect(res.body).toEqual({ error: "install failed" });
    expect(JSON.stringify(res.body)).not.toContain("/secret/path");
  });

  it("200 with the ensure result when consent is given", async () => {
    const { app, routes } = fakeApp();
    const installAgent = vi.fn(async () => ({ available: true, source: "managed", needsLogin: true }));
    registerChatRoutes(app as never, { ...baseDeps(), installAgent } as never);
    const res = fakeRes();
    await routes["POST /api/agents/:id/install"]({ params: { id: "codex" }, body: { consent: true }, query: {} }, res);
    expect(res.code).toBe(200);
    expect(res.body).toEqual({ available: true, source: "managed", needsLogin: true });
    expect(installAgent).toHaveBeenCalledWith("codex", true);
  });
});
