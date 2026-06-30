import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readRecents, upsertRecent } from "@agentgem/capture";

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "agem-")); });
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("recents store", () => {
  it("returns [] when the file is missing", () => {
    expect(readRecents(home)).toEqual([]);
  });

  it("returns [] when the file is malformed", () => {
    mkdirSync(join(home, ".agentgem"), { recursive: true });
    writeFileSync(join(home, ".agentgem", "recents.json"), "not json{");
    expect(readRecents(home)).toEqual([]);
  });

  it("upsert writes an entry that read-back returns", () => {
    upsertRecent(home, { path: "/a", flavor: "claude", name: "a" });
    const got = readRecents(home);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ path: "/a", flavor: "claude", name: "a" });
    expect(typeof got[0].lastUsed).toBe("string");
  });

  it("dedups by path, keeping the latest at the front", () => {
    upsertRecent(home, { path: "/a", flavor: "claude", name: "a" });
    upsertRecent(home, { path: "/b", flavor: "codex", name: "b" });
    const list = upsertRecent(home, { path: "/a", flavor: "hermes", name: "a2" });
    expect(list.map((e) => e.path)).toEqual(["/a", "/b"]);
    expect(list[0]).toMatchObject({ flavor: "hermes", name: "a2" });
  });

  it("caps the list at 10 entries", () => {
    for (let i = 0; i < 12; i++) upsertRecent(home, { path: `/p${i}`, flavor: "claude", name: `p${i}` });
    const list = readRecents(home);
    expect(list).toHaveLength(10);
    expect(list[0].path).toBe("/p11"); // newest first
  });
});
