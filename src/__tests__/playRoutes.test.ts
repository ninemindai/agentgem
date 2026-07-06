// src/__tests__/playRoutes.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PlayController } from "../play.controller.js";

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "agh-")); process.env.AGENTGEM_HOME = home; });
afterEach(() => { rmSync(home, { recursive: true, force: true }); delete process.env.AGENTGEM_HOME; });

const meta = { title: "My Game", genre: "project-fun" as const, createdFrom: { kind: "project" as const, path: "/p", flavor: "node" }, engineVersion: "1" };

describe("PlayController", () => {
  it("save then miniapps lists it", async () => {
    const ctrl = new PlayController();
    const saved = await ctrl.save({ body: { name: "g1", html: "<!doctype html><body><canvas></canvas></body>", meta } });
    expect(saved.name).toBe("g1");
    const list = await ctrl.miniapps();
    expect(list.miniapps.map((m) => m.name)).toContain("g1");
  });
  it("save rejects a non-sealed bundle", async () => {
    const ctrl = new PlayController();
    await expect(ctrl.save({ body: { name: "bad", html: `<script>fetch("http://x/")</script>`, meta } })).rejects.toThrow();
  });
});
