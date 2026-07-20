// src/__tests__/addUploads.test.ts   (ROOT — imports the built package)
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { blankStudio, addUploadsToMiniapp, miniappDir, miniappsRoot, studioBrief } from "@agentgem/play";

const b64 = (s: string) => Buffer.from(s).toString("base64");
const headCount = () => execFileSync("git", ["-C", miniappsRoot(), "rev-list", "--count", "HEAD"], { encoding: "utf8" }).trim();

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "ma-home-")); process.env.AGENTGEM_HOME = home; });
afterEach(() => { rmSync(home, { recursive: true, force: true }); delete process.env.AGENTGEM_HOME; });

describe("addUploadsToMiniapp", () => {
  it("writes files, recomputes meta.uploads, returns stored names, and does NOT commit", async () => {
    const { name } = await blankStudio("My Game", undefined, undefined, [
      { name: "a.png", bytesBase64: b64("A"), type: "image/png", role: "ship" },
    ]);
    const commitsBefore = headCount();

    const res = await addUploadsToMiniapp(name, [
      { name: "My Logo.png", bytesBase64: b64("B"), type: "image/png", role: "ship" },
      { name: "notes.md", bytesBase64: b64("# n"), type: "text/markdown", role: "reference" },
    ]);

    const dir = miniappDir(name);
    expect(existsSync(join(dir, "uploads", "my-logo.png"))).toBe(true);
    expect(existsSync(join(dir, "ref", "notes.md"))).toBe(true);
    expect(res.files).toContainEqual({ requested: "My Logo.png", stored: "my-logo.png", role: "ship" });
    const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8"));
    expect(meta.uploads).toEqual({ ship: 2, ref: 1 }); // cumulative (a.png + my-logo.png ship; notes.md ref)
    expect(studioBrief(name)).toMatch(/uploads\//);
    expect(headCount()).toBe(commitsBefore); // no new commit
  });

  it("throws 'miniapp not found' for an unknown name", async () => {
    await expect(addUploadsToMiniapp("does-not-exist", [
      { name: "a.png", bytesBase64: b64("A"), type: "image/png", role: "ship" },
    ])).rejects.toThrow(/^miniapp not found/);
  });
});
