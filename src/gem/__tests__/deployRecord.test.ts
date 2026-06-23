import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspace } from "../workspaces.js";
import { writeDeployRecord, readDeployRecord, clearDeployRecord } from "../deployRecord.js";
import type { Gem } from "../types.js";

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "dr-")); process.env.AGENTGEM_HOME = home;
  const gem: Gem = { name: "w", createdFrom: "/d", artifacts: [{ type: "skill", name: "s", source: "standalone", content: "# b\n" }], checks: [], requiredSecrets: [] };
  createWorkspace("w", gem);
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("deploy record", () => {
  it("returns null before any deploy", () => {
    expect(readDeployRecord("w", "eve")).toBeNull();
  });
  it("writes then reads back a record", () => {
    writeDeployRecord("w", { backend: "eve", at: "2026-06-22T00:00:00Z", url: "https://x.vercel.app", project: "w-eve" });
    const r = readDeployRecord("w", "eve");
    expect(r?.project).toBe("w-eve");
    expect(r?.url).toBe("https://x.vercel.app");
  });
  it("keeps backends separate and clears one", () => {
    writeDeployRecord("w", { backend: "eve", at: "t", project: "w-eve" });
    writeDeployRecord("w", { backend: "flue", at: "t", worker: "w" });
    clearDeployRecord("w", "eve");
    expect(readDeployRecord("w", "eve")).toBeNull();
    expect(readDeployRecord("w", "flue")?.worker).toBe("w");
  });
});
