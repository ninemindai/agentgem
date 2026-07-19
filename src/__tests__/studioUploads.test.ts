// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/__tests__/studioUploads.test.ts   (ROOT — imports the built package)
import { describe, it, expect, beforeEach, afterEach } from "vitest";
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
