// src/play/__tests__/gitLock.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureRepo, commitWithLock } from "@agentgem/play";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "gitlock-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("commitWithLock", () => {
  it("serializes concurrent commits on one repo without an index.lock throw", async () => {
    await ensureRepo(dir);
    writeFileSync(join(dir, "a.txt"), "a");
    writeFileSync(join(dir, "b.txt"), "b");
    // Fire two commits at the same time. Serialized, both settle without throwing;
    // the first commits the tree (hash), the second finds nothing to commit (null).
    const [r1, r2] = await Promise.all([
      commitWithLock(dir, "one"),
      commitWithLock(dir, "two"),
    ]);
    const hashes = [r1, r2].filter((h): h is string => typeof h === "string");
    expect(hashes.length).toBeGreaterThanOrEqual(1);
    hashes.forEach((h) => expect(h).toMatch(/^[0-9a-f]{7,40}$/));
  });

  it("a failing commit does not wedge the chain for later commits on the same dir", async () => {
    // Never ran ensureRepo on a fresh subdir → first call rejects (not a git repo);
    // the lock must still let a subsequent, valid commit proceed.
    const bad = join(dir, "nope");
    await expect(commitWithLock(bad, "x")).rejects.toBeTruthy();
    await ensureRepo(dir);
    writeFileSync(join(dir, "c.txt"), "c");
    await expect(commitWithLock(dir, "y")).resolves.toMatch(/^[0-9a-f]{7,40}$/);
  });
});
