// src/__tests__/browse.test.ts
import { describe, it, expect } from "vitest";
import { homedir } from "node:os";
import { browseDir } from "../browse.js";
import { resolveUnderHome } from "../resolveDir.js";

describe("browseDir / resolveUnderHome (home-scoped)", () => {
  it("lists subdirectories of home and sets parent null at home", () => {
    const r = browseDir(homedir());
    expect(r.path).toBe(homedir());
    expect(r.parent).toBeNull();
    expect(Array.isArray(r.dirs)).toBe(true);
    for (const d of r.dirs) expect(d.path.startsWith(homedir())).toBe(true);
  });

  it("clamps paths outside home back to home", () => {
    expect(resolveUnderHome("/etc")).toBe(homedir());
    expect(resolveUnderHome("/")).toBe(homedir());
    expect(resolveUnderHome(`${homedir()}/../../etc`)).toBe(homedir());
    expect(resolveUnderHome(undefined)).toBe(homedir());
  });

  it("navigates into a real subdir and back up to home", () => {
    const top = browseDir(homedir());
    if (top.dirs.length) {
      const child = browseDir(top.dirs[0].path);
      expect(child.path).toBe(top.dirs[0].path);
      expect(child.parent).toBe(homedir());
    }
  });
});
