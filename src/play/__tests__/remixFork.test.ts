import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importStudio, saveMiniapp, miniappDir } from "@agentgem/play";
import { workspaceDir } from "@agentgem/base";
import { readGemArchive, readArchiveDir } from "@agentgem/archive";
import { PlaySaveRequestSchema, PlayMiniappSchema, PlayImportRequestSchema } from "@agentgem/app/schemas";

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "agh-")); process.env.AGENTGEM_HOME = home; });
afterEach(() => { rmSync(home, { recursive: true, force: true }); delete process.env.AGENTGEM_HOME; });

const REMIX = { gemKey: "@bob/snake", version: "1.2.0" };
const sealed = "<!doctype html><body><canvas></canvas><script>const x=1;</script></body>";
const metaFor = (name: string) => ({
  title: name, genre: "project-fun" as const,
  createdFrom: { kind: "html" as const, title: name }, engineVersion: "1",
});

describe("remix fork lineage", () => {
  it("importStudio bakes remixOf + the original genre into meta.json", async () => {
    const { name } = await importStudio("snake-remix", sealed, undefined, undefined, { remixOf: REMIX, genre: "skill-run" });
    const meta = JSON.parse(readFileSync(join(miniappDir(name), "meta.json"), "utf8"));
    expect(meta.remixOf).toEqual(REMIX);
    expect(meta.genre).toBe("skill-run");
  });

  it("without opts, importStudio behaves exactly as before (no remixOf, project-fun)", async () => {
    const { name } = await importStudio("plain", sealed);
    const meta = JSON.parse(readFileSync(join(miniappDir(name), "meta.json"), "utf8"));
    expect(meta.remixOf).toBeUndefined();
    expect(meta.genre).toBe("project-fun");
  });

  it("saveMiniapp round-trips remixOf into the dual-written gem artifact", async () => {
    const { name } = await importStudio("snake-remix", sealed, undefined, undefined, { remixOf: REMIX });
    await saveMiniapp({ name, html: sealed, meta: { ...metaFor("snake-remix"), remixOf: REMIX } });
    const gem = readGemArchive(readArchiveDir(workspaceDir(name)));
    expect((gem.artifacts[0] as { remixOf?: unknown }).remixOf).toEqual(REMIX);
  });

  it("a save that omits remixOf carries it forward from disk (uploads-style)", async () => {
    const { name } = await importStudio("snake-remix", sealed, undefined, undefined, { remixOf: REMIX });
    await saveMiniapp({ name, html: sealed, meta: metaFor("snake-remix") });
    const meta = JSON.parse(readFileSync(join(miniappDir(name), "meta.json"), "utf8"));
    expect(meta.remixOf).toEqual(REMIX);
  });
});

describe("remixOf wire schemas (zod must not strip lineage)", () => {
  const meta = { title: "t", genre: "project-fun", createdFrom: { kind: "html", title: "t" }, engineVersion: "1", remixOf: REMIX };
  it("PlaySaveRequestSchema keeps meta.remixOf", () => {
    expect(PlaySaveRequestSchema.parse({ name: "g", html: "<x>", meta }).meta.remixOf).toEqual(REMIX);
  });
  it("PlayMiniappSchema keeps meta.remixOf on the way out", () => {
    expect(PlayMiniappSchema.parse({ name: "g", html: "<x>", meta }).meta.remixOf).toEqual(REMIX);
  });
  it("PlayImportRequestSchema accepts remixOf + genre", () => {
    const p = PlayImportRequestSchema.parse({ title: "t", html: "<x>", remixOf: REMIX, genre: "skill-run" });
    expect(p.remixOf).toEqual(REMIX);
    expect(p.genre).toBe("skill-run");
  });
  it("RemixRef rejects empty members", () => {
    expect(() => PlayImportRequestSchema.parse({ title: "t", html: "<x>", remixOf: { gemKey: "", version: "1" } })).toThrow();
  });
});
