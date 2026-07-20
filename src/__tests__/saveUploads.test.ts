// src/__tests__/saveUploads.test.ts   (ROOT — imports the built package)
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { blankStudio, saveMiniapp, miniappDir } from "@agentgem/play";

const b64 = (s: string) => Buffer.from(s).toString("base64");
const HTML = "<!doctype html><html><head></head><body>hi</body></html>";

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "ma-home-")); process.env.AGENTGEM_HOME = home; });
afterEach(() => { rmSync(home, { recursive: true, force: true }); delete process.env.AGENTGEM_HOME; });

describe("saveMiniapp preserves the server-owned uploads counter", () => {
  it("keeps meta.uploads across a Save whose client meta omits it", async () => {
    const { name } = await blankStudio("My Game", undefined, undefined, [
      { name: "hero.png", bytesBase64: b64("PNGDATA"), type: "image/png", role: "ship" },
    ]);
    const before = JSON.parse(readFileSync(join(miniappDir(name), "meta.json"), "utf8"));
    expect(before.uploads).toEqual({ ship: 1, ref: 0 });

    // Client Save payload never carries `uploads` (mirrors Studio.tsx:335-341).
    await saveMiniapp({ name, html: HTML, meta: { title: "My Game", genre: "project-fun", engineVersion: "1" } as any });

    const after = JSON.parse(readFileSync(join(miniappDir(name), "meta.json"), "utf8"));
    expect(after.uploads).toEqual({ ship: 1, ref: 0 }); // NOT wiped
  });
});
