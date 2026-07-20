// src/__tests__/playStudio.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PlayController } from "@agentgem/app/play.controller";
import { miniappsRoot } from "@agentgem/play";

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "agh-")); process.env.AGENTGEM_HOME = home; });
afterEach(() => { rmSync(home, { recursive: true, force: true }); delete process.env.AGENTGEM_HOME; });

describe("PlayController.studio", () => {
  it("seeds a miniapp dir from a project source", async () => {
    // real project dir so defaultReaders.readProject (suggestTestbed) accepts it
    const proj = mkdtempSync(join(tmpdir(), "proj-"));
    writeFileSync(join(proj, "package.json"), JSON.stringify({ name: "demo", dependencies: {} }));
    try {
      const ctrl = new PlayController();
      const res = await ctrl.studio({ body: { source: { kind: "project", path: proj, flavor: "node" } } });
      expect(res.name.length).toBeGreaterThan(0);
      expect(existsSync(join(miniappsRoot(), res.name, "index.html"))).toBe(true);
    } finally { rmSync(proj, { recursive: true, force: true }); }
  });
});
