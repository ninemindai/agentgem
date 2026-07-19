// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/__tests__/studioUploads.test.ts   (ROOT — imports the built package)
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { blankStudio, studioBrief, miniappDir, miniappsRoot } from "@agentgem/play";

const b64 = (s: string) => Buffer.from(s).toString("base64");

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "ma-home-")); process.env.AGENTGEM_HOME = home; });
afterEach(() => { rmSync(home, { recursive: true, force: true }); delete process.env.AGENTGEM_HOME; });

describe("blankStudio with uploads", () => {
  it("writes ref/ + uploads/, records meta.uploads, and studioBrief names the dirs", async () => {
    const { name } = await blankStudio("My Game", "make a platformer", undefined, [
      { name: "hero.png", bytesBase64: b64("PNGDATA"), type: "image/png", role: "ship" },
      { name: "notes.md", bytesBase64: b64("# design"), type: "text/markdown", role: "reference" },
    ]);
    const dir = miniappDir(name);
    expect(existsSync(join(dir, "uploads", "hero.png"))).toBe(true);
    expect(existsSync(join(dir, "ref", "notes.md"))).toBe(true);
    const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8"));
    expect(meta.uploads).toEqual({ ship: 1, ref: 1 });
    const brief = studioBrief(name);
    expect(brief).toMatch(/uploads\//);
    expect(brief).toMatch(/ref\//);
  });

  it("omits meta.uploads when no files", async () => {
    const { name } = await blankStudio("Plain", undefined, undefined, []);
    const meta = JSON.parse(readFileSync(join(miniappDir(name), "meta.json"), "utf8"));
    expect(meta.uploads).toBeUndefined();
    expect(studioBrief(name)).not.toMatch(/uploads\//);
  });
});

describe("ref/ never enters git", () => {
  it("git does not track reference files", async () => {
    const { name } = await blankStudio("Secret", undefined, undefined, [
      { name: "private.md", bytesBase64: b64("top secret"), type: "text/markdown", role: "reference" },
      { name: "icon.png", bytesBase64: b64("PNG"), type: "image/png", role: "ship" },
    ]);
    const root = miniappsRoot();
    const tracked = execFileSync("git", ["-C", root, "ls-files"], { encoding: "utf8" });
    expect(tracked).toMatch(new RegExp(`${name}/uploads/icon\\.png`));       // ship IS tracked
    expect(tracked).toMatch(new RegExp(`${name}/uploads/assets\\.json`));    // manifest IS tracked
    expect(tracked).not.toMatch(new RegExp(`${name}/ref/`));                 // reference is NOT
    // and git status shows nothing ignored-but-untracked leaking in as a candidate
    const status = execFileSync("git", ["-C", root, "status", "--porcelain", "--ignored"], { encoding: "utf8" });
    expect(status).toMatch(new RegExp(`!!\\s+${name}/ref/`));                // explicitly ignored
  });
});

describe("writeUploads failure releases the claimed dir", () => {
  it("an oversize ship file throws and leaves no claimed miniapp dir (name reusable)", async () => {
    const bigB64 = Buffer.alloc(600_000, 0x41).toString("base64");  // 600KB > 500KB ship cap
    await expect(blankStudio("Oops", undefined, "reuse-me", [
      { name: "big.png", bytesBase64: bigB64, type: "image/png", role: "ship" },
    ])).rejects.toThrow();
    expect(existsSync(miniappDir("reuse-me"))).toBe(false);         // released on throw, not orphaned
    const { name } = await blankStudio("Retry", undefined, "reuse-me", []);   // the exact name is free again
    expect(name).toBe("reuse-me");
  });
});
