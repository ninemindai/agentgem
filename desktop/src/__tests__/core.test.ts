import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { coreEntryCandidates, resolveCoreEntry } from "../core.js";

describe("coreEntryCandidates", () => {
  it("lists packaged resources first, dev dist second", () => {
    const list = coreEntryCandidates("/app/desktop/dist", "/app/resources");
    expect(list).toEqual([
      join("/app/resources", "core", "index.js"),
      join("/app/desktop/dist", "..", "..", "dist", "index.js"),
    ]);
  });
});

describe("resolveCoreEntry", () => {
  it("returns the first existing candidate", () => {
    const dir = mkdtempSync(join(tmpdir(), "core-"));
    mkdirSync(join(dir, "real"));
    const real = join(dir, "real", "index.js");
    writeFileSync(real, "// core");
    expect(resolveCoreEntry([join(dir, "missing.js"), real])).toBe(real);
  });

  it("throws listing all candidates when none exist", () => {
    expect(() => resolveCoreEntry(["/nope/a.js", "/nope/b.js"])).toThrow(/\/nope\/a\.js/);
  });
});
