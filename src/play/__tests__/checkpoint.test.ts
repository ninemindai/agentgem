// src/play/__tests__/checkpoint.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkpointMiniapp, miniappDir } from "@agentgem/play";
import { workspaceDir } from "@agentgem/base";
import { readGemArchive, readArchiveDir } from "@agentgem/archive";

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "agh-")); process.env.AGENTGEM_HOME = home; });
afterEach(() => { rmSync(home, { recursive: true, force: true }); delete process.env.AGENTGEM_HOME; });

const meta = { title: "My Game", genre: "project-fun" as const, createdFrom: { kind: "project" as const, path: "/p", flavor: "node" }, engineVersion: "1" };
const sealed = "<!doctype html><body><canvas></canvas><script>const x=1;</script></body>";
const broken = `<!doctype html><body><canvas></canvas><script>fetch("http://x/")</script></body>`; // fails the gate (network call)

// Write a miniapp draft directly on disk (like seed/import do, but explicit + gate-agnostic).
function draft(name: string, html: string) {
  const dir = miniappDir(name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.html`), html);
  writeFileSync(join(dir, "meta.json"), JSON.stringify(meta));
}

describe("checkpointMiniapp", () => {
  it("commits an ungated broken draft WITHOUT writing a gem", async () => {
    draft("brk", broken);
    const r = await checkpointMiniapp("brk");
    expect(r.commit).toMatch(/^[0-9a-f]{7,40}$/);              // durability: committed
    expect(existsSync(join(workspaceDir("brk"), "gem.json"))).toBe(false); // no gem for an unsealed draft
  });

  it("commits AND writes the gem for a sealed draft", async () => {
    draft("ok", sealed);
    await checkpointMiniapp("ok");
    expect(existsSync(join(workspaceDir("ok"), "gem.json"))).toBe(true);
  });

  it("leaves a previously-sealed gem intact when a later turn breaks the file (upsert never deletes)", async () => {
    draft("keep", sealed.replace("canvas", "canvas data-v1"));
    await checkpointMiniapp("keep");                            // seals → gem written (v1)
    writeFileSync(join(miniappDir("keep"), "keep.html"), broken); // agent breaks it mid-build
    const r = await checkpointMiniapp("keep");                  // must NOT throw, must still commit
    expect(r.commit).toMatch(/^[0-9a-f]{7,40}$/);
    const art = readGemArchive(readArchiveDir(workspaceDir("keep"))).artifacts[0] as { html: string };
    expect(art.html).toContain("data-v1");                     // gem still holds the last sealed build
  });
});
