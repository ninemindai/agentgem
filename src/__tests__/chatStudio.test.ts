// src/__tests__/chatStudio.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { studioChatArgs } from "../goldmine/chatRoutes.js";
import { seedStudio, miniappDir, studioBrief, miniappsRoot, type SourceReaders } from "@agentgem/play";

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "agh-")); process.env.AGENTGEM_HOME = home; });
afterEach(() => { rmSync(home, { recursive: true, force: true }); delete process.env.AGENTGEM_HOME; });

const readers: SourceReaders = {
  loadSession: async () => null,
  readSkill: async (name) => ({ name, content: "# " + name }),
  readProject: async () => null,
};
const neutralDeps = {
  buildBrief: async () => "neutral brief",
  goldmineMcp: () => [],
  resolveStudio: (miniapp: string) => ({ cwd: miniappDir(miniapp), brief: studioBrief(miniapp) }),
  neutralCwd: "/neutral",
};

describe("studioChatArgs", () => {
  it("with a miniapp → validated cwd + studio brief", async () => {
    const { name } = await seedStudio({ kind: "skill", skillName: "brainstorming" }, readers);
    const args = await studioChatArgs({ agentId: "claude", miniapp: name }, neutralDeps);
    expect(args.cwd).toBe(join(miniappsRoot(), name));
    expect(args.brief).toContain("index.html");
    expect(args.agentId).toBe("claude");
    expect(args.permission).toBe("allow"); // studio agent may edit its (jailed) miniapp
  });
  it("without a miniapp → neutral brief, explicit neutral cwd", async () => {
    const args = await studioChatArgs({ agentId: "claude" }, neutralDeps);
    expect(args.cwd).toBe("/neutral");
    expect(args.brief).toBe("neutral brief");
  });
  it("rejects a missing agentId and an unknown miniapp name", async () => {
    await expect(studioChatArgs({}, neutralDeps)).rejects.toThrow(/agentId/);
    await expect(studioChatArgs({ agentId: "claude", miniapp: "../escape" }, neutralDeps)).rejects.toThrow();
  });
});
