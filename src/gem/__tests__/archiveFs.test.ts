import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeArchiveDir, readArchiveDir } from "../archiveFs.js";

const tmps: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "afs-")); tmps.push(d); return d; };
afterEach(() => { while (tmps.length) rmSync(tmps.pop()!, { recursive: true, force: true }); });

describe("readArchiveDir", () => {
  it("round-trips a written tree", () => {
    const root = tmp();
    const tree = { "gem.json": "{}", "skills/x/SKILL.md": "# x" };
    writeArchiveDir(root, tree);
    expect(readArchiveDir(root)).toEqual(tree);
  });

  it("skips top-level dot-entries (e.g. .targets/)", () => {
    const root = tmp();
    const tree = { "gem.json": "{}", "skills/x/SKILL.md": "# x" };
    writeArchiveDir(root, tree);
    mkdirSync(join(root, ".targets", "eve"), { recursive: true });
    writeFileSync(join(root, ".targets", "eve", "agent.ts"), "derived");
    expect(readArchiveDir(root)).toEqual(tree); // .targets content not present
  });

  it("keeps a dotfile nested under a non-dot directory", () => {
    const root = tmp();
    const tree = { "gem.json": "{}", "skills/x/.keep": "nested" };
    writeArchiveDir(root, tree);
    expect(readArchiveDir(root)).toEqual(tree); // nested .keep survives; only top-level dot-entries are skipped
  });
});
