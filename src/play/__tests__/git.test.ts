// src/play/__tests__/git.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureRepo, commitAll, git } from "@agentgem/play";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "mini-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("git wrapper", () => {
  it("ensureRepo initializes a repo idempotently", async () => {
    await ensureRepo(dir);
    await ensureRepo(dir); // second call is a no-op, must not throw
    const r = await git(dir, ["rev-parse", "--is-inside-work-tree"]);
    expect(r.stdout.trim()).toBe("true");
  });
  it("commitAll stages+commits and returns a sha; a clean tree returns null", async () => {
    await ensureRepo(dir);
    writeFileSync(join(dir, "a.txt"), "hello");
    const sha = await commitAll(dir, "add a");
    expect(sha).toMatch(/^[0-9a-f]{7,40}$/);
    expect(await commitAll(dir, "noop")).toBeNull(); // nothing changed
  });
});
