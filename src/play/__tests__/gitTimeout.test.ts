// src/play/__tests__/gitTimeout.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, ensureRepo } from "@agentgem/play";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "gittmo-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("git() subprocess timeout", () => {
  it("still resolves a normal command with the default timeout in place", async () => {
    await ensureRepo(dir);
    const r = await git(dir, ["rev-parse", "--is-inside-work-tree"]);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe("true");
  });

  it("kills the subprocess and rejects when it exceeds the timeout", async () => {
    await ensureRepo(dir);
    // `git hash-object --stdin` blocks reading stdin (the wrapper never writes/closes it), so it can
    // NEVER finish on its own — the timeout is the only way this settles. Deterministic, unlike racing a
    // short timeout against a fast-completing command (which finishes first on a quick machine).
    await expect(git(dir, ["hash-object", "--stdin"], 100)).rejects.toThrow(/killed|SIGKILL|SIGTERM|timed out/i);
  });
});
