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

  it("import creates a miniapp from raw HTML (draft, kind:html provenance)", async () => {
    const ctrl = new PlayController();
    const html = "<!doctype html><body><h1>Herding Programmers</h1><script>const x=1;</script></body>";
    const res = await ctrl.import({ body: { title: "Herding Programmers", html } });
    expect(res.name).toBe("herding-programmers");
    const got = await ctrl.miniapp({ query: { name: res.name } });
    expect(got.html).toBe(html);                                  // imported verbatim
    expect(got.meta.createdFrom).toEqual({ kind: "html", title: "Herding Programmers" });
  });

  it("import does NOT gate (a not-yet-sealed draft imports; the seal is enforced on Save)", async () => {
    const ctrl = new PlayController();
    const res = await ctrl.import({ body: { title: "wip", html: `<body><script>fetch("http://x/")</script></body>` } });
    expect(res.name).toBe("wip"); // import succeeds; Save would reject until the fetch is removed
  });

  it("a '.git' title slugs to a safe name, not a dotfile dir", async () => {
    const ctrl = new PlayController();
    const res = await ctrl.import({ body: { title: ".git", html: "<body>x</body>" } });
    expect(res.name).toBe("git"); // leading dots stripped
  });

  it("blank creates a from-scratch miniapp (sealed scaffold, kind:blank provenance)", async () => {
    const ctrl = new PlayController();
    const res = await ctrl.blank({ body: { title: "Space Dodger", prompt: "dodge asteroids" } });
    expect(res.name).toBe("space-dodger");
    const got = await ctrl.miniapp({ query: { name: res.name } });
    expect(got.html).toContain("AGENTGEM:GAME-LOGIC");            // seeded from the blank sealed scaffold
    expect(got.meta.createdFrom).toEqual({ kind: "blank", title: "Space Dodger" });
    expect(got.meta.genre).toBe("project-fun");
  });

  it("session-data 404s for a non-session miniapp (only session-sourced games have it)", async () => {
    const ctrl = new PlayController();
    await ctrl.import({ body: { title: "imported", html: "<body>x</body>" } }); // createdFrom kind=html
    await expect(ctrl.sessionData({ query: { name: "imported" } })).rejects.toThrow(/no session data/);
  });

  it("POST /play/migrate reports the saved miniapp's migration outcome", async () => {
    const ctrl = new PlayController();
    await ctrl.save({ body: { name: "g1", html: "<!doctype html><body><canvas></canvas></body>", meta } });
    const res = await ctrl.migrate();
    expect(res.results.find((r) => r.name === "g1")?.outcome).toBe("unrecognized");
  });
});
