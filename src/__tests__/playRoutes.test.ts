// src/__tests__/playRoutes.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { miniappsRoot } from "@agentgem/play";
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

  it("delete removes the miniapp and drops it from the list", async () => {
    const ctrl = new PlayController();
    await ctrl.save({ body: { name: "g1", html: "<!doctype html><body><canvas></canvas></body>", meta } });
    const res = await ctrl.delete({ body: { name: "g1" } });
    expect(res.name).toBe("g1");
    expect((await ctrl.miniapps()).miniapps.map((m) => m.name)).not.toContain("g1");
  });

  // An absent miniapp is a 404; a malformed name is a CLIENT error (400), like every sibling mutation
  // route. Collapsing both into 404 would report a rejected '../escape' as "not found".
  it("delete 404s for an absent miniapp but 400s for an invalid name", async () => {
    const ctrl = new PlayController();
    await expect(ctrl.delete({ body: { name: "ghost" } })).rejects.toMatchObject({ statusCode: 404 });
    await expect(ctrl.delete({ body: { name: "../escape" } })).rejects.toMatchObject({ statusCode: 400 });
  });

  it("creating twice from the same source yields two miniapps, not one overwrite", async () => {
    const ctrl = new PlayController();
    const a = await ctrl.blank({ body: { title: "Duel" } });
    const b = await ctrl.blank({ body: { title: "Duel" } });
    expect([a.name, b.name]).toEqual(["duel", "duel-2"]);
    expect((await ctrl.miniapps()).miniapps.map((m) => m.name).sort()).toEqual(["duel", "duel-2"]);
  });

  // A typed name is honored exactly; a taken one is a 409 (well-formed request, id not free), never a
  // silent rename. A derived name still suffixes.
  it("an explicit name is claimed exactly and 409s when taken", async () => {
    const ctrl = new PlayController();
    expect((await ctrl.blank({ body: { title: "Anything", name: "My Duel" } })).name).toBe("my-duel");
    await expect(ctrl.blank({ body: { title: "Anything", name: "my-duel" } })).rejects.toMatchObject({ statusCode: 409 });
    expect((await ctrl.miniapps()).miniapps.map((m) => m.name)).toEqual(["my-duel"]);  // no my-duel-2
  });

  it("an explicit name works on import too, and the bundle lands in index.html", async () => {
    const ctrl = new PlayController();
    const res = await ctrl.import({ body: { title: "Whatever", html: "<body>x</body>", name: "chosen" } });
    expect(res.name).toBe("chosen");
    expect(existsSync(join(miniappsRoot(), "chosen", "index.html"))).toBe(true);
    expect((await ctrl.miniapp({ query: { name: "chosen" } })).html).toBe("<body>x</body>");
  });

  it("POST /play/migrate reports the saved miniapp's migration outcome", async () => {
    const ctrl = new PlayController();
    await ctrl.save({ body: { name: "g1", html: "<!doctype html><body><canvas></canvas></body>", meta } });
    const res = await ctrl.migrate();
    expect(res.results.find((r) => r.name === "g1")?.outcome).toBe("unrecognized");
  });
});
