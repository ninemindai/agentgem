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
    // 1ms is far below git's spawn+exec latency, so the process is killed before it can finish.
    await expect(git(dir, ["rev-parse", "HEAD"], 1)).rejects.toThrow(/killed|SIGKILL|SIGTERM|timed out/i);
  });
});
