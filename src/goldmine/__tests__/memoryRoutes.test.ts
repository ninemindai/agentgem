// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerMemoryRoutes } from "../memoryRoutes.js";

// Minimal app that records handlers by "METHOD path" so tests can invoke them.
function makeApp() {
  const routes = new Map<string, (req: any, res: any) => unknown>();
  const reg = (m: string) => (p: string, _g: any, h: any) => routes.set(`${m} ${p}`, h);
  return { app: { get: reg("GET"), post: reg("POST"), delete: reg("DELETE") }, routes };
}
function res() {
  const out: any = { code: 200, body: undefined };
  return { status(c: number) { out.code = c; return this; }, json(b: unknown) { out.body = b; }, setHeader() {}, write() {}, end() {}, _out: out };
}

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "agm-routes-")); process.env.AGENTGEM_HOME = home; });
afterEach(() => { delete process.env.AGENTGEM_HOME; rmSync(home, { recursive: true, force: true }); vi.restoreAllMocks(); });

describe("memory routes", () => {
  it("GET /api/memory/providers lists all providers with implemented flags", async () => {
    const { app, routes } = makeApp();
    registerMemoryRoutes(app as any);
    const r = res();
    await routes.get("GET /api/memory/providers")!({ query: {}, params: {} }, r);
    const ids = r._out.body.providers.map((p: any) => p.id).sort();
    expect(ids).toEqual(["letta", "mem0", "supermemory", "zep"]);
    const mem0 = r._out.body.providers.find((p: any) => p.id === "mem0");
    expect(mem0.implemented).toBe(true);
    expect(mem0.enabled).toBe(false); // nothing configured yet
  });

  it("GET /api/memory/outbox returns the current candidates", async () => {
    const { app, routes } = makeApp();
    registerMemoryRoutes(app as any);
    const r = res();
    await routes.get("GET /api/memory/outbox")!({ query: {}, params: {} }, r);
    expect(r._out.body).toEqual({ candidates: [] });
  });
});
