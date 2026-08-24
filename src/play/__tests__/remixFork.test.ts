import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importStudio, saveMiniapp, miniappDir } from "@agentgem/play";
import { workspaceDir } from "@agentgem/base";
import { readGemArchive, readArchiveDir } from "@agentgem/archive";

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
